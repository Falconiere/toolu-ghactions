// batchRead.ts — batched blob reads for diff classification: ONE `git cat-file
// --batch-check` invocation for sizes and one protocol-aware `git cat-file
// --batch` invocation PER BYTE-BUDGET GROUP for bounded content, replacing the
// per-file `git show <ref>:<path>` / `git cat-file -s <ref>:<path>` spawns that
// classifyFiles (`src/git/diff.ts`) used to run once per changed file.
import { execFileSync } from "node:child_process";

/** A blob to read, addressed the way `git cat-file` accepts on stdin: `<ref>:<path>`. */
export interface BlobSpec {
  readonly ref: string;
  readonly path: string;
}

/** Per-blob result. `size` is null when the object doesn't exist at that ref
 *  (matches `git cat-file -s` failing) OR when the path holds a newline and so
 *  could not be put on the batch stdin at all (see {@link batchRead}).
 *  `content` is null when the object is missing OR when its size exceeded
 *  `sizeCutoff` and was never fetched. */
export interface BlobResult {
  size: number | null;
  content: string | null;
}

/** Content bytes kept per blob — a blob larger than this still has its full
 *  record consumed off the batch stream (to stay in protocol sync for the
 *  next record); only the first MAX_BLOB_READ_BYTES bytes are retained. */
export const MAX_BLOB_READ_BYTES = 65536;

/**
 * Total blob bytes one `git cat-file --batch` invocation may emit. `maxBuffer`
 * is 1 GiB, but that bounds ONE call — before grouping, a PR adding ~1500 files
 * of ~700 KB each (CSV/JSON fixtures, a docs import: no noise rule matches and
 * every blob is under LARGE_FILE_BYTES) produced ~1 GB of stdout in a single
 * call and `execFileSync` threw `spawnSync git ENOBUFS` straight out of
 * `fetchDiff`, before the MAX_FILES gate ever ran. 256 MiB leaves ~4× headroom
 * under maxBuffer for the per-record framing overhead (~90 bytes per blob).
 */
export const MAX_BATCH_GROUP_BYTES = 256 * 1024 * 1024;

const BATCH_MAX_BUFFER = 1024 * 1024 * 1024;

function specKey(spec: BlobSpec): string {
  return `${spec.ref}:${spec.path}`;
}

/**
 * Split `items` into consecutive groups whose `bytesOf` sums stay at or under
 * `maxBytes`, preserving order (so a group is always a contiguous slice and the
 * positional batch-protocol walk stays valid). An item whose own size exceeds
 * `maxBytes` gets a group to itself — dropping it would silently lose its
 * content, and a single within-cutoff blob is far below the caller's maxBuffer.
 */
export function groupByByteBudget<T>(
  items: readonly T[],
  bytesOf: (item: T) => number,
  maxBytes: number,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = bytesOf(item);
    if (current.length > 0 && used + size > maxBytes) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Read sizes for every spec (one `--batch-check` spawn) and, for specs whose
 * size is within `opts.sizeCutoff`, their content bounded to
 * `opts.maxContentBytes` (default MAX_BLOB_READ_BYTES; one `--batch` spawn per
 * {@link MAX_BATCH_GROUP_BYTES} group — skipped entirely when nothing
 * qualifies). Keyed by `path`: within one fetchDiff pass each changed path is
 * read at a single ref, so path alone is a safe key for the classifier's
 * readBlob/blobSize lookups.
 *
 * A spec whose path contains a REAL newline is never put on the batch stdin and
 * comes back `{size: null, content: null}` — see the note in {@link batchRead}.
 *
 * Never throws for an individual missing object (batch-check/--batch report
 * `<spec> missing` per record); a real git failure (non-zero exit, e.g. not a
 * git repo) throws, same as any other execFileSync call in this codebase.
 */
export function batchRead(
  specs: readonly BlobSpec[],
  cwd: string,
  opts: { sizeCutoff: number; maxContentBytes?: number; maxGroupBytes?: number },
): Map<string, BlobResult> {
  const results = new Map<string, BlobResult>();
  if (specs.length === 0) return results;

  // The batch protocol's stdin is LINE-delimited, so one spec whose path holds a
  // real newline arrives as two lines and git answers with TWO records — every
  // later spec is then matched positionally to its neighbour's size and content
  // (verified on git 2.54: 3 specs → 4 records). A real source file inheriting
  // another's >1 MB size is dropped as large-file; inheriting another's
  // `@generated` header is dropped as generated.
  //
  // `-z` is NOT the fix, though `git cat-file --batch-check/-batch -z` does
  // exist: it NUL-delimits the INPUT only. The OUTPUT stays line-framed, and a
  // MISSING object still echoes its spec verbatim — newline included — so a
  // newline-named path that is absent at the ref desyncs the output exactly as
  // before. Skipping the spec is the only exact fix, and it fails SAFE: with no
  // size and no content, `noiseReason` still applies every PATH rule and the
  // file is reviewed rather than silently dropped.
  const batchable = specs.filter((spec) => !spec.path.includes("\n"));

  // Seed EVERY spec (skipped ones included) so each has an entry to read.
  for (const spec of specs) results.set(spec.path, { size: null, content: null });
  if (batchable.length === 0) return results;

  const sizes = batchCheckSizes(batchable, cwd);
  for (const spec of batchable) {
    results.set(spec.path, { size: sizes.get(specKey(spec)) ?? null, content: null });
  }

  const maxContentBytes = opts.maxContentBytes ?? MAX_BLOB_READ_BYTES;
  const withinCutoff = batchable.filter((spec) => {
    const size = sizes.get(specKey(spec));
    return size !== null && size !== undefined && size <= opts.sizeCutoff;
  });
  if (withinCutoff.length === 0) return results;

  const groups = groupByByteBudget(
    withinCutoff,
    (spec) => sizes.get(specKey(spec)) ?? 0,
    opts.maxGroupBytes ?? MAX_BATCH_GROUP_BYTES,
  );
  for (const group of groups) {
    const contents = batchReadContents(group, cwd, maxContentBytes);
    for (const spec of group) {
      const prior = results.get(spec.path);
      results.set(spec.path, {
        size: prior?.size ?? null,
        content: contents.get(specKey(spec)) ?? null,
      });
    }
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
