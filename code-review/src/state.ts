// state.ts — cross-push review memory carried in a hidden marker in the sticky
// PR comment. Byte-compatible port of the bash `review-state.sh`: the marker
// format, the gzip+base64 payload, and the finding fingerprint all match, so a
// TS run reads markers written by the old bash action and recap survives the
// migration (fingerprints must agree or every prior finding looks resolved+new).
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";

const MARKER_PREFIX = "<!-- toolu-review-state:v1 ";
const MARKER_SUFFIX = " -->";

// Fingerprint separator: EMPTY. review-state.sh writes a NUL string literal
// that jq collapses to "", so the deployed canon is path+category+normtext
// with no separator. Matched here for marker/fingerprint byte-compat.
const FP_SEP = "";

// Decompression output cap (bytes). A PR-comment marker is attacker-influenceable,
// so a crafted gzip bomb (tiny base64 → GBs inflated) could OOM the runner. 5 MB is
// orders of magnitude above any real state marker; gunzipSync throws RangeError past
// it, which decodeMarker's try/catch turns into the `{}` fail-safe.
const MAX_DECODE_BYTES = 5_000_000;

/** A review finding. Loose by design — only the fields the fingerprint reads matter here. */
export interface Finding {
  path?: string;
  category?: string;
  text?: string;
  fp?: string;
  /** 1-based line number when the finding is anchored to a line. */
  line?: number;
  [k: string]: unknown;
}

export interface HistoryEntry {
  sha: string;
  ts: number;
  verdict: string;
  counts: { new: number; open: number; resolved: number; total: number };
}

// --- Runtime validation for a decoded marker (a PR comment is attacker-influenceable). ---
// Findings stay permissive (any object, fields preserved) so a marker the bash action
// wrote — whose finding fields are loosely typed — still decodes byte-compatibly. History
// is shape-checked but falls back to [] on any mismatch rather than discarding the whole
// state, keeping decodeMarker fail-safe.
const StoredFindingSchema = z.object({}).passthrough();
const HistoryEntrySchema = z.object({
  sha: z.string(),
  ts: z.number(),
  verdict: z.string(),
  counts: z.object({
    new: z.number(),
    open: z.number(),
    resolved: z.number(),
    total: z.number(),
  }),
});
const ReviewStateSchema = z.object({
  schema: z.literal("toolu-review-state"),
  version: z.literal(1),
  findings: z.array(StoredFindingSchema).catch([]),
  history: z.array(HistoryEntrySchema).catch([]),
});

export interface ReviewState {
  schema: "toolu-review-state";
  version: 1;
  findings: Finding[];
  history: HistoryEntry[];
}

/**
 * Canonical fingerprint string for a finding: path+category+normtext concatenated
 * with no separator (FP_SEP=""), matching the deployed review-state.sh. `line` is
 * deliberately excluded so the fingerprint survives line drift across edits.
 */
function canonString(f: Finding): string {
  const path = f.path ?? "";
  const category = f.category ?? "";
  const normText = (f.text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^ +/, "")
    .replace(/ +$/, "")
    .slice(0, 200);
  return `${path}${FP_SEP}${category}${FP_SEP}${normText}`;
}

/** sha1 hex of the canonical string — identical to bash `sha1sum` of the same bytes. */
export function fingerprint(f: Finding): string {
  return createHash("sha1").update(canonString(f), "utf8").digest("hex");
}

/** Stamp `.fp` on every finding (idempotent — overwrites any prior fp). */
export function attachFps(findings: Finding[]): Finding[] {
  return findings.map((f) => ({ ...f, fp: fingerprint(f) }));
}

/** Encode state JSON into the one-line sticky marker (gzip+base64, no newlines). */
export function encodeMarker(state: ReviewState): string {
  const payload = gzipSync(Buffer.from(JSON.stringify(state), "utf8")).toString("base64");
  return `${MARKER_PREFIX}${payload}${MARKER_SUFFIX}`;
}

/**
 * Decode a comment body (or bare marker) back into state. FAIL-SAFE: a missing
 * marker, bad base64, bad gzip, invalid JSON, or a payload that inflates past
 * {@link MAX_DECODE_BYTES} (gzip-bomb guard) all yield `{}` — never throws, so a
 * corrupt or hostile marker just starts memory fresh (matches the bash decode).
 */
export function decodeMarker(body: string): ReviewState | Record<string, never> {
  const re = new RegExp(
    `${escapeRegExp(MARKER_PREFIX)}([A-Za-z0-9+/=]*)${escapeRegExp(MARKER_SUFFIX)}`,
  );
  const m = body.match(re);
  const payload = m?.[1];
  if (!payload) return {};
  try {
    const json = gunzipSync(Buffer.from(payload, "base64"), {
      maxOutputLength: MAX_DECODE_BYTES,
    }).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    const result = ReviewStateSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DiffInput {
  prior: ReviewState | null;
  current_findings: Finding[];
  scope: { in_scope_paths: string[]; full_review: boolean };
  head_sha: string;
  verdict: string;
  /** Clock for the history-entry timestamp (epoch MILLISECONDS), default Date.now. */
  now?: () => number;
}

export interface DiffResult {
  new: Finding[];
  open: Finding[];
  resolved: Finding[];
  counts: { new: number; open: number; resolved: number; total: number };
  history_entry: HistoryEntry;
  next_state: ReviewState;
}

/**
 * Partition current findings against the prior state by fingerprint:
 * new (not seen before), open (seen), resolved (prior, gone now — only when
 * `full_review` AND the path is in scope). History is capped to the last 10.
 */
export function diffState(input: DiffInput): DiffResult {
  const current = attachFps(input.current_findings);
  const priorFindings = input.prior?.findings ?? [];
  const priorFps = new Set(priorFindings.map((f) => f.fp));
  const currentFps = new Set(current.map((f) => f.fp));
  const inScope = new Set(input.scope.in_scope_paths);

  const fresh = current.filter((f) => !priorFps.has(f.fp));
  const open = current.filter((f) => priorFps.has(f.fp));
  const resolved = input.scope.full_review
    ? priorFindings.filter((f) => !currentFps.has(f.fp) && inScope.has(f.path ?? ""))
    : [];

  const counts = {
    new: fresh.length,
    open: open.length,
    resolved: resolved.length,
    total: current.length,
  };
  // Epoch SECONDS from the injected ms clock (default Date.now), so a pinned clock
  // makes the marker deterministic — the module-local timer was unreachable before.
  const nowMs = (input.now ?? Date.now)();
  const history_entry: HistoryEntry = {
    sha: input.head_sha.slice(0, 7),
    ts: Math.floor(nowMs / 1000),
    verdict: input.verdict,
    counts,
  };
  const history = [...(input.prior?.history ?? []), history_entry].slice(-10);

  return {
    new: fresh,
    open,
    resolved,
    counts,
    history_entry,
    next_state: { schema: "toolu-review-state", version: 1, findings: current, history },
  };
}
