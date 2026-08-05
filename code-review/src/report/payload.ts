// report/payload.ts — the single source of truth for what a review run reports to
// toolu.sh: turns partitionFindings()'s four buckets into the exact wire body from
// the design doc's "Ingest — POST /machine/review-runs" section. Pure (no I/O, no
// fetch) — report/post.ts sends what this module builds, nothing else decides the
// shape.
//
// THE ONLY CALL SITE OF normalizeCategory(). Every finding's category passes
// through it on the way into the body here, and nowhere else — see
// report/categories.ts's header for why running it any earlier (inside the
// fingerprint) would rotate every in-flight PR's finding identities.
//
// IDENTITY GAP (CLOSED — see report/report-run.ts): the wire body needs GitHub's
// numeric repo id (`repo.id`) and the PR author's login (`pull.authorLogin`).
// `BuildPayloadInput` below declares them as required inputs the caller must
// resolve and pass in, rather than this "pure, no I/O" module guessing or
// reaching into an untyped payload shape. `GithubContext` (pipeline/types.ts)
// now carries both as `repoId?`/`authorLogin?` — populated by main.ts's
// `buildContext()` from `payload.repository.id` and, per trigger path,
// `payload.pull_request.user.login` or `payload.issue.user.login` — and
// report/report-run.ts resolves them from there before calling buildPayload().
import { normalizeCategory } from "./categories.js";
import type { ReportCategory } from "./categories.js";
import type {
  DismissedFinding,
  PartitionedFindings,
  ReportedFinding,
  Settlement,
} from "./partition.js";
import type { PublishTarget } from "@/pipeline/publish.js";
import type { GithubContext } from "@/pipeline/types.js";
import type { ActionInputs } from "@/inputs.js";
import type { ReviewState } from "@/state.js";

/** The action's finding severity enum, reused via {@link ReportedFinding} rather
 *  than re-declared (partition.ts's own alias of the same type is file-private). */
type WireSeverity = NonNullable<ReportedFinding["severity"]>;
/** The action's finding provenance enum, reused the same way. */
type WireSource = NonNullable<ReportedFinding["source"]>;

/**
 * The wire-safe finding shape: identity, anchor, and light classification only.
 * Deliberately excludes `text`, `quoted_line`, `end_line`, `confidence` and
 * `suggestion` — never spread from the internal {@link ReportedFinding}, built
 * field by field, so a future field added upstream cannot leak here by accident.
 * `category` here is ALREADY normalized (see {@link buildFinding}) — the fixed
 * nine-member {@link ReportCategory} vocabulary, never the model's raw string.
 */
export interface PayloadFinding {
  fp: string;
  path: string;
  line: number | null;
  /** Present iff the finding carries metadata at all — see {@link buildFinding}. */
  severity?: WireSeverity;
  category?: ReportCategory;
  source?: WireSource;
}

/** A `dismissed` wire finding, additionally carrying how it was settled. */
export interface PayloadDismissedFinding extends PayloadFinding {
  settlement: Settlement;
}

/**
 * Everything {@link buildPayload} needs, drawn from `PublishInput`'s in-scope
 * fields (`target`, `reviewedSha`, `baseBranch`, `startMs`, `now`, `prior`), the
 * A1 `GithubContext` seam, `ActionInputs`, the settled verdict, and A4's
 * `PartitionedFindings` — plus the two identity fields the module doc's "IDENTITY
 * GAP" note explains are not yet threaded through any of those.
 */
export interface BuildPayloadInput {
  /** GitHub's numeric repository id, sent as a string (the platform's `repoId`
   *  column is `text`, matching `app_repositories`'s durable-across-renames key).
   *  See the module doc's "IDENTITY GAP". */
  repoId: string;
  /** Supplies `owner`/`repo` (→ `repo.fullName`) and `prNumber` (→ `pull.number`).
   *  `target.headSha` is IGNORED here — `pull.headSha` reports {@link reviewedSha}
   *  instead, the PR HEAD sha the review-memory marker itself converges on, not
   *  the ephemeral `pull_request` merge commit `target.headSha` can hold. */
  target: PublishTarget;
  /** See `PublishInput.reviewedSha`'s own doc. Reported as `pull.headSha`. */
  reviewedSha: string;
  baseBranch: string;
  /** The PR author's login, or `null` when unavailable. See the module doc's
   *  "IDENTITY GAP". */
  authorLogin: string | null;
  /** The A1 seam: `githubRunId`/`githubRunAttempt` come straight off these two
   *  fields. `runAttempt` is optional on `GithubContext` for the same reason
   *  `headSha`/`headRef` are (a hand-built test context need not carry one); its
   *  absence here reports `1` — GITHUB_RUN_ATTEMPT is 1-based and never actually
   *  absent in a real run, so "no value" and "first attempt" coincide. */
  context: Pick<GithubContext, "runId" | "runAttempt">;
  /** Only the two fields the wire body needs. */
  inputs: Pick<ActionInputs, "provider" | "model">;
  /** The settled verdict (post `settleVerdict`/`applyRoundCap` in publish.ts) —
   *  not recomputed here, since that logic is private to publish.ts. */
  verdict: "approved" | "changes" | "skip" | "error";
  /** Whether the MAX_ROUNDS surrender cap fired this run. */
  capped: boolean;
  /** Whole-PR review vs. an incremental (changed-lines-only) one. */
  fullReview: boolean;
  startMs: number;
  now: () => number;
  /** Prior review state, read only for `history.length` (see `reportedRound`'s
   *  own doc on {@link ReviewRunPayload}). */
  prior: ReviewState | null;
  /** A4's four disjoint, exhaustive report buckets for this run. */
  partitions: PartitionedFindings;
}

/**
 * The exact `POST /machine/review-runs` body, verbatim from the design doc's
 * Interfaces section. `schemaVersion` is fixed at `1`; forward compatibility
 * comes from bumping it, never from an implicit shape change.
 */
export interface ReviewRunPayload {
  schemaVersion: 1;
  repo: { id: string; fullName: string };
  pull: { number: number; headSha: string; baseBranch: string; authorLogin: string | null };
  run: {
    /** GITHUB_RUN_ID, as a string (identity half one). */
    githubRunId: string;
    /** GITHUB_RUN_ATTEMPT, or `1` on an absent seam value — see
     *  {@link BuildPayloadInput.context}. (identity half two). */
    githubRunAttempt: number;
    /** ADVISORY ONLY — the platform assigns the authoritative `round` as a
     *  per-pull sequence; never use this in a metric. Saturates at 11 past round
     *  10 (`state.ts`'s `diffState()` caps `history` at `.slice(-10)`) — a
     *  pre-existing round-cap bug this field routes around, not fixes. */
    reportedRound: number;
    verdict: "approved" | "changes" | "skip" | "error";
    capped: boolean;
    fullReview: boolean;
    provider: string;
    modelId: string;
    /** `now() - startMs` — the injected clock, never wall time. */
    durationMs: number;
    /** Epoch ms the run started — `startMs` verbatim. */
    startedAt: number;
  };
  findings: {
    new: PayloadFinding[];
    open: PayloadFinding[];
    fixed: PayloadFinding[];
    dismissed: PayloadDismissedFinding[];
  };
}

/**
 * Turn one partition-bucket entry into its wire shape. `severity` presence
 * signals "this entry carries metadata at all" — a current-run finding always
 * has one, while `enrichFromPrior`'s rotated-past case clears all three
 * together — so an absent severity omits category/source rather than invent
 * them. Otherwise: `category` runs through {@link normalizeCategory} (the one
 * call site — see the module doc), and an absent `source` defaults to `"llm"`,
 * matching review/render.ts:188 and review/validate.ts:66.
 */
function buildFinding(f: ReportedFinding): PayloadFinding {
  const out: PayloadFinding = { fp: f.fp, path: f.path, line: f.line };
  if (f.severity !== undefined) {
    out.severity = f.severity;
    out.category = normalizeCategory(f.category);
    out.source = f.source ?? "llm";
  }
  return out;
}

/** {@link buildFinding} plus the settlement value every `dismissed` entry carries. */
function buildDismissedFinding(f: DismissedFinding): PayloadDismissedFinding {
  return { ...buildFinding(f), settlement: f.settlement };
}

/** Build the exact `POST /machine/review-runs` body for one run. The only place
 *  in the repo that decides what is sent — see the module doc. */
export function buildPayload(input: BuildPayloadInput): ReviewRunPayload {
  const { target, partitions } = input;
  return {
    schemaVersion: 1,
    repo: { id: input.repoId, fullName: `${target.owner}/${target.repo}` },
    pull: {
      number: target.prNumber,
      headSha: input.reviewedSha,
      baseBranch: input.baseBranch,
      authorLogin: input.authorLogin,
    },
    run: {
      githubRunId: String(input.context.runId),
      githubRunAttempt: input.context.runAttempt ?? 1,
      reportedRound: (input.prior?.history?.length ?? 0) + 1,
      verdict: input.verdict,
      capped: input.capped,
      fullReview: input.fullReview,
      provider: input.inputs.provider,
      modelId: input.inputs.model,
      durationMs: input.now() - input.startMs,
      startedAt: input.startMs,
    },
    findings: {
      new: partitions.new.map(buildFinding),
      open: partitions.open.map(buildFinding),
      fixed: partitions.fixed.map(buildFinding),
      dismissed: partitions.dismissed.map(buildDismissedFinding),
    },
  };
}
