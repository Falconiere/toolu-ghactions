// Bounded, read-only evidence from the reviewed tree. Inventory completeness is
// explicit: absence from a chunk or from this context is never proof of absence.
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { batchRead } from "@/git/batchRead.js";
import type { ContextFile } from "@/git/diff.js";
import { containsFullFile, splitDiffByFile } from "@/git/chunk.js";

export interface RepositoryContext {
  inventory: string;
  files: ContextFile[];
  omitted: string[];
}

type Manifest = { path: string; dir: string; name: string; exports: unknown };
const FILE_BYTES = 16384;
const CONTEXT_BYTES = 32768;
const INVENTORY_BYTES = 16384;
const MAX_CANDIDATES = 96;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Only concrete paths under the repository; never follow symlinks or read disk. */
function candidates(path: string, paths: ReadonlySet<string>): string[] {
  const normalized = posix.normalize(path);
  if (normalized.startsWith("../") || posix.isAbsolute(normalized)) return [];
  const stem = normalized.replace(/\.[cm]?jsx?$/, "");
  return [
    ...new Set([
      normalized,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map(
        (ext) => stem + ext,
      ),
    ]),
  ].filter((p) => paths.has(p));
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  return Object.values(record(value)).flatMap(exportTargets);
}

function importedFiles(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  manifests: Manifest[],
): string[] {
  const found: string[] = [];
  const owner = manifests
    .filter((m) => m.dir === "." || from.startsWith(m.dir + "/"))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  for (const match of source.matchAll(
    /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const spec = match[1] ?? "";
    if (spec.startsWith("."))
      found.push(...candidates(posix.join(posix.dirname(from), spec), paths));
    // Conventional alias candidates are evidence files, not a claim that a
    // particular tsconfig resolves the import. Its config is attached as well.
    if (spec.startsWith("@/") && owner)
      found.push(...candidates(posix.join(owner.dir, "src", spec.slice(2)), paths));
    for (const pkg of manifests) {
      if (!pkg.name || (spec !== pkg.name && !spec.startsWith(pkg.name + "/"))) continue;
      found.push(pkg.path);
      const subpath = spec === pkg.name ? "." : "." + spec.slice(pkg.name.length);
      const exports = record(pkg.exports);
      const entries = Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.entries(exports)
        : [[".", pkg.exports] as const];
      for (const [key, target] of entries) {
        const star = key.indexOf("*");
        const matches =
          star < 0
            ? subpath === key
            : subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1));
        if (!matches) continue;
        const capture =
          star < 0 ? "" : subpath.slice(star, subpath.length - (key.length - star - 1));
        for (const value of exportTargets(target)) {
          if (value.startsWith("./"))
            found.push(...candidates(posix.join(pkg.dir, value.replaceAll("*", capture)), paths));
        }
      }
    }
    if (found.length >= MAX_CANDIDATES) break;
  }
  return [...new Set(found)].slice(0, MAX_CANDIDATES);
}

/** Build once per review, reusing the tree inventory and bounded blob cache. */
export function createRepositoryContext(
  ref: string,
  cwd: string,
): (changed: readonly string[], visibleDiff?: string) => RepositoryContext {
  let paths: Set<string>;
  try {
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", ref], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    paths = new Set(
      tree.split("\0").flatMap((entry) => {
        const tab = entry.indexOf("\t");
        return /^100(?:644|755) blob /.test(entry) && tab >= 0 ? [entry.slice(tab + 1)] : [];
      }),
    );
  } catch {
    return () => ({
      inventory: "Repository inventory unavailable; do not infer missing files.",
      files: [],
      omitted: [],
    });
  }
  const cache = new Map<string, string | null>();
  const read = (requested: readonly string[]): void => {
    const missing = [...new Set(requested)].filter(
      (p) => paths.has(p) && !cache.has(p) && !/[\r\n]/.test(p),
    );
    try {
      const blobs = batchRead(
        missing.map((path) => ({ ref, path })),
        cwd,
        { sizeCutoff: FILE_BYTES, maxContentBytes: FILE_BYTES },
      );
      for (const p of missing) cache.set(p, blobs.get(p)?.content ?? null);
    } catch {
      for (const p of missing) cache.set(p, null);
    }
  };
  const packagePaths = [...paths].filter((p) => posix.basename(p) === "package.json").slice(0, 256);
  read(packagePaths);
  const manifests: Manifest[] = packagePaths.map((path) => {
    let value: Record<string, unknown> = {};
    try {
      value = record(JSON.parse(cache.get(path) ?? "{}"));
    } catch {
      /* invalid manifest remains context */
    }
    return {
      path,
      dir: posix.dirname(path),
      name: typeof value.name === "string" ? value.name : "",
      exports: value.exports,
    };
  });

  return (changed, visibleDiff = "") => {
    const visible = new Map(splitDiffByFile(visibleDiff).map((s) => [s.path, s.diff]));
    const selected = changed.slice(0, MAX_CANDIDATES);
    read(selected);
    const supporting: string[] = [];
    for (const path of selected) {
      const dir = posix.dirname(path);
      const stem = posix.basename(path).replace(/\.[^.]+$/, "");
      supporting.push(
        ...[...paths].filter(
          (p) =>
            p.startsWith(`${dir}/__tests__/${stem}.`) ||
            p.startsWith(`${dir}/${stem}.test.`) ||
            p.startsWith(`${dir}/${stem}.spec.`),
        ),
      );
      for (const m of manifests) {
        if (m.dir === "." || path.startsWith(m.dir + "/")) {
          supporting.push(
            m.path,
            ...["tsconfig.json", "jsconfig.json"]
              .map((name) => posix.join(m.dir, name))
              .filter((p) => paths.has(p)),
          );
        }
      }
      supporting.push(...importedFiles(cache.get(path) ?? "", path, paths, manifests));
    }
    // Two supporting hops cover schema -> defaults and service -> helper.
    let queue = [...new Set(supporting)].slice(0, MAX_CANDIDATES);
    for (let depth = 0; depth < 2; depth++) {
      read(queue);
      queue = [
        ...new Set([
          ...queue,
          ...queue.flatMap((p) => importedFiles(cache.get(p) ?? "", p, paths, manifests)),
        ]),
      ].slice(0, MAX_CANDIDATES);
    }
    read(queue);
    const ordered = [...new Set([...queue, ...selected])];
    const files: ContextFile[] = [];
    const omitted: string[] = [];
    let bytes = 0;
    for (const path of ordered) {
      const content = cache.get(path);
      if (content != null && containsFullFile(visible.get(path) ?? "", content)) continue;
      if (
        content == null ||
        content.includes("\0") ||
        bytes + Buffer.byteLength(content) > CONTEXT_BYTES
      ) {
        omitted.push(path);
        continue;
      }
      files.push({ path, content });
      bytes += Buffer.byteLength(content);
    }
    const inventory: string[] = [];
    let size = 0;
    for (const path of new Set([...ordered, ...changed, ...paths])) {
      if (!paths.has(path)) continue;
      const line = JSON.stringify(path);
      if (size + Buffer.byteLength(line) + 1 > INVENTORY_BYTES) break;
      inventory.push(line);
      size += Buffer.byteLength(line) + 1;
    }
    return {
      inventory: `Repository files shown: ${inventory.length}/${paths.size}. Bounded inventory; omissions do not prove absence.\n${inventory.join("\n")}`,
      files,
      omitted,
    };
  };
}
