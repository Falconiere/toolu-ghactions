// batchRead.ts — batched blob reads for diff classification: ONE `git cat-file
// --batch-check` invocation for sizes and (at most) ONE protocol-aware `git
// cat-file --batch` invocation for bounded content, replacing the per-file
// `git show <ref>:<path>` / `git cat-file -s <ref>:<path>` spawns that
// classifyFiles (`src/git/diff.ts`) used to run once per changed file.
import { execFileSync } from "node:child_process";

/** A blob to read, addressed the way `git cat-file` accepts on stdin: `<ref>:<path>`. */
export interface BlobSpec {
  readonly ref: string;
  readonly path: string;
}

/** Per-blob result. `size` is null when the object doesn't exist at that ref
 *  (matches `git cat-file -s` failing). `content` is null when the object is
 *  missing OR when its size exceeded `sizeCutoff` and was never fetched. */
export interface BlobResult {
  size: number | null;
  content: string | null;
}

/** Content bytes kept per blob — a blob larger than this still has its full
 *  record consumed off the batch stream (to stay in protocol sync for the
 *  next record); only the first MAX_BLOB_READ_BYTES bytes are retained. */
export const MAX_BLOB_READ_BYTES = 65536;

const BATCH_MAX_BUFFER = 1024 * 1024 * 1024;

function specKey(spec: BlobSpec): string {
  return `${spec.ref}:${spec.path}`;
}

/**
 * Read sizes for every spec (one `--batch-check` spawn) and, for specs whose
 * size is within `opts.sizeCutoff`, their content bounded to
 * `opts.maxContentBytes` (default MAX_BLOB_READ_BYTES; one `--batch` spawn —
 * skipped entirely when nothing qualifies). Keyed by `path`: within one
 * fetchDiff pass each changed path is read at a single ref, so path alone is
 * a safe key for the classifier's readBlob/blobSize lookups.
 *
 * Never throws for an individual missing object (batch-check/--batch report
 * `<spec> missing` per record); a real git failure (non-zero exit, e.g. not a
 * git repo) throws, same as any other execFileSync call in this codebase.
 */
export function batchRead(
  specs: readonly BlobSpec[],
  cwd: string,
  opts: { sizeCutoff: number; maxContentBytes?: number },
): Map<string, BlobResult> {
  const results = new Map<string, BlobResult>();
  if (specs.length === 0) return results;

  const sizes = batchCheckSizes(specs, cwd);
  for (const spec of specs) {
    results.set(spec.path, { size: sizes.get(specKey(spec)) ?? null, content: null });
  }

  const maxContentBytes = opts.maxContentBytes ?? MAX_BLOB_READ_BYTES;
  const withinCutoff = specs.filter((spec) => {
    const size = sizes.get(specKey(spec));
    return size !== null && size !== undefined && size <= opts.sizeCutoff;
  });
  if (withinCutoff.length === 0) return results;

  const contents = batchReadContents(withinCutoff, cwd, maxContentBytes);
  for (const spec of withinCutoff) {
    const prior = results.get(spec.path);
    const content = contents.get(specKey(spec)) ?? null;
    results.set(spec.path, { size: prior?.size ?? null, content });
  }
  return results;
}

/** One `git cat-file --batch-check` call: one output line per input spec, in order. */
function batchCheckSizes(specs: readonly BlobSpec[], cwd: string): Map<string, number | null> {
  const sizes = new Map<string, number | null>();
  const stdin = specs.map(specKey).join("\n") + "\n";
  const out = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd,
    input: stdin,
    encoding: "utf8",
    maxBuffer: BATCH_MAX_BUFFER,
  });
  const lines = out.split("\n");
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec === undefined) continue;
    sizes.set(specKey(spec), parseHeaderSize(lines[i] ?? ""));
  }
  return sizes;
}

/** Header line is either `<sha> <type> <size>` (found) or `<spec> missing`. */
function parseHeaderSize(line: string): number | null {
  if (line === "" || line.endsWith(" missing")) return null;
  const size = Number.parseInt(line.split(" ")[2] ?? "", 10);
  return Number.isNaN(size) ? null : size;
}

/**
 * One `git cat-file --batch` call, walked byte-by-byte against the batch
 * protocol: a header line, then (when found) exactly `size` content bytes and
 * a trailing LF. A record whose size exceeds `maxBytes` still has its full
 * `size + 1` bytes skipped off the stream — only the first `maxBytes` are
 * decoded and kept — so record boundaries never drift out of sync.
 */
function batchReadContents(
  specs: readonly BlobSpec[],
  cwd: string,
  maxBytes: number,
): Map<string, string | null> {
  const contents = new Map<string, string | null>();
  const stdin = specs.map(specKey).join("\n") + "\n";
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: stdin,
    maxBuffer: BATCH_MAX_BUFFER,
  }); // no `encoding` — a Buffer, so record byte-lengths (declared per header) are exact

  let offset = 0;
  for (const spec of specs) {
    const key = specKey(spec);
    if (offset >= out.length) {
      contents.set(key, null); // protocol under-produced; treat as missing rather than throw
      continue;
    }
    const nl = out.indexOf(0x0a, offset);
    if (nl === -1) throw new Error(`git cat-file --batch: truncated record for ${key}`);
    const header = out.toString("utf8", offset, nl);
    offset = nl + 1;
    if (header.endsWith(" missing")) {
      contents.set(key, null);
      continue;
    }
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    if (Number.isNaN(size)) throw new Error(`git cat-file --batch: unparseable header "${header}"`);
    const readLen = Math.min(size, maxBytes);
    contents.set(key, out.toString("utf8", offset, offset + readLen));
    offset += size + 1; // full record, not just what we kept — stays in sync past 64 KiB
  }
  return contents;
}
