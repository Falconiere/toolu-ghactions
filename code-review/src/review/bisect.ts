// review/bisect.ts — review ONE package with bounded, schema-only bisection
// (spec §Layer 2). Split out of review/chunked.ts, which owns packing, mechanical
// partitioning and the merge; this module owns what happens to a single package
// once its envelope is buildable: the call, the failure classification, the split,
// and the per-path coverage each outcome implies.
//
// Why bisection is schema-only: a `schema` failure means the model could not emit
// structured output for THIS envelope — a smaller envelope usually can, so the
// split is itself the retry (re-issuing the identical envelope is what failed).
// `transport`/`timeout` failures say nothing about envelope size; splitting them
// would multiply load against an already-struggling provider, so they keep the
// existing single retry and never split.
//
// Call budget per originally-failed package: 1 (package) + 2 (halves) + 4
// (quarters) = 7, from BISECT_MAX_DEPTH = 2. A non-bisectable failure (transport,
// timeout, or a single-segment package) instead spends today's one retry, so a
// failed package never costs more than 7 calls on either path.
import type { FileSegment } from "@/git/chunk.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { Envelope } from "@/prompt.js";
import type { CoverageEntry } from "@/review/ledger.js";

/** Max bisection depth: ≤ 4 leaves, so ≤ 7 model calls per failed package. */
export const BISECT_MAX_DEPTH = 2;

/** Everything {@link reviewPackage} needs beyond the segments themselves. */
export interface PackageReviewContext {
  /** Build the envelope for a set of segments + the mechanical findings on them. */
  buildEnvelope: (segments: FileSegment[], mechanical: MechanicalFinding[]) => Envelope;
  /** Run one model review of a built envelope (never throws — it abstains). */
  review: (envelope: Envelope) => Promise<ProviderResult>;
  /** Per-path coverage sink: called once per path per outcome. */
  onCoverage: (path: string, entry: CoverageEntry) => void;
  /** Epoch-ms wall deadline (undefined = no limit), re-checked before every split. */
  wallDeadline?: number | undefined;
}

/**
 * Review one package, bisecting on schema failures up to {@link BISECT_MAX_DEPTH}.
 *
 * Returns the results that actually COVERED the package: one result when it was
 * reviewed whole (or failed unbisectably), the leaf results when it bisected —
 * successful leaves included. `mergeResults` consumes them as one unit, so a
 * package fully covered by its leaves is not a failed chunk while a package with
 * a failed leaf still is (llm/merge.ts).
 *
 * Coverage is reported for every path touched: `reviewed` on a successful call,
 * `unreviewed` for a leaf that failed for good, `pending` for a half skipped
 * because the wall clock ran out. A failed leaf's (empty) result rides along so
 * the merge can count the failure — its files are covered by nothing.
 */
export async function reviewPackage(
  ctx: PackageReviewContext,
  segments: FileSegment[],
  mechanical: MechanicalFinding[],
  depth: number,
): Promise<ProviderResult[]> {
  const result = await ctx.review(ctx.buildEnvelope(segments, mechanical));
  if (result.verdict !== "error") {
    reportCoverage(ctx.onCoverage, segments, { status: "reviewed" });
    return [result];
  }
  if (result.failure === "schema" && depth < BISECT_MAX_DEPTH && segments.length > 1) {
    return bisect(ctx, segments, mechanical, depth);
  }
  // Not bisectable. At the top level that is today's behavior — one clean retry,
  // because the dominant abstain cause is provider-side nondeterminism. Inside a
  // bisection the split already WAS the retry, so a leaf gets no extra call (that
  // is what keeps the 4 leaves inside the 7-call budget).
  //
  // The retry is a DISPATCH, so it obeys the same wall clock as every other one
  // (chunked.ts's per-package check, bisect()'s between-halves check): a run that
  // is already past MAX_WALL_MS must not fire a fresh model call. When the deadline
  // has passed the first result stands and the package falls straight through to
  // failure handling — these paths were attempted and failed, so they ledger
  // `unreviewed` exactly as an exhausted retry would, not `pending` (which means
  // never attempted). Either list resumes the path next round (pipeline/scope.ts
  // unions them), so skipping the retry costs coverage nothing.
  const retryable = depth === 0 && !deadlinePassed(ctx.wallDeadline);
  const final = retryable ? await ctx.review(ctx.buildEnvelope(segments, mechanical)) : result;
  const status = final.verdict === "error" ? "unreviewed" : "reviewed";
  reportCoverage(ctx.onCoverage, segments, { status });
  return [final];
}

/**
 * Split the segments in half (grouping order preserved) and review each half one
 * depth down. Halves run SEQUENTIALLY: bisection is the rare, already-degraded
 * path, and the wall clock must be re-read between halves — a deadline reached
 * mid-bisection ledgers the remaining half `pending` (resumable) rather than
 * spending more calls a run has no time for.
 */
async function bisect(
  ctx: PackageReviewContext,
  segments: FileSegment[],
  mechanical: MechanicalFinding[],
  depth: number,
): Promise<ProviderResult[]> {
  const mid = Math.ceil(segments.length / 2);
  const halves = [segments.slice(0, mid), segments.slice(mid)];
  const parts = splitMechanical(halves, mechanical);
  const out: ProviderResult[] = [];
  for (const [i, half] of halves.entries()) {
    if (half.length === 0) continue;
    if (deadlinePassed(ctx.wallDeadline)) {
      reportCoverage(ctx.onCoverage, half, { status: "pending" });
      continue;
    }
    out.push(...(await reviewPackage(ctx, half, parts[i] ?? [], depth + 1)));
  }
  return out;
}

/** Map a package's mechanical findings onto its halves: each finding rides the
 *  half holding its file; orphans (file in neither half) ride the FIRST half —
 *  the same rule chunked.ts applies across packages. */
function splitMechanical(
  halves: FileSegment[][],
  mechanical: MechanicalFinding[],
): MechanicalFinding[][] {
  const pathSets = halves.map((half) => new Set(half.map((s) => s.path)));
  const parts: MechanicalFinding[][] = halves.map(() => []);
  for (const finding of mechanical) {
    const i = pathSets.findIndex((paths) => paths.has(finding.path));
    parts[i === -1 ? 0 : i]?.push(finding);
  }
  return parts;
}

/** Report one outcome for every path in `segments`. Path-less segments (mode-only
 *  changes carry no `+++`/`---` path) have nothing to ledger and are skipped; each
 *  path gets its OWN entry object so a consumer can store them without aliasing. */
export function reportCoverage(
  onCoverage: (path: string, entry: CoverageEntry) => void,
  segments: FileSegment[],
  entry: CoverageEntry,
): void {
  for (const seg of segments) {
    if (seg.path === "") continue;
    onCoverage(seg.path, { ...entry });
  }
}

/** True when a wall deadline is set and already reached — checked before every
 *  package and every split, never mid-call (a call in flight always finishes). */
export function deadlinePassed(wallDeadline: number | undefined): boolean {
  return wallDeadline !== undefined && Date.now() >= wallDeadline;
}
