// review/verdict.ts — render the markdown verdict comment and its label. Port of
// format-verdict.sh: maps the verdict to its PR label + badge, assembles the body
// (via render.ts), and enforces GitHub's comment-size ceiling by shrinking the
// findings list lowest-severity-first while the recap, history, and state marker
// always survive — the marker MUST stay the last line.
//
// VERDICT MAPPING (parity-critical):
//   approved → `merge-approved` / "✅ Approved"
//   error    → `request-changes` / "🚫 Review incomplete — provider error"
//   changes  → `request-changes` / "⚠️ Changes requested"
// "error" carries the request-changes label on purpose: a failed review must
// never auto-merge (the do-not-approve fail-safe), but the badge says plainly it
// was a provider error, not a real request for changes.
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { FindingCluster } from "@/review/cluster.js";
import {
  buildFindingsSection,
  buildTruncatedFindingsSection,
  renderBody,
  type ReviewBody,
} from "./render.js";

/** GitHub rejects comment bodies over 65536 chars; we rebuild below this ceiling. */
const BODY_SIZE_LIMIT = 65000;

const DEFAULT_BOT_NAME = "Toolu — Code Review";
const DEFAULT_BOT_LOGO_URL =
  "https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png";

/** Branding + memory context for {@link formatVerdict}, passed in (never env). */
export interface VerdictOptions {
  /** Branding name (default "Toolu — Code Review"). */
  botName?: string;
  /** Branding logo URL (default the shipped logo). */
  botLogoUrl?: string;
  /** Branch name shown in the heading and "View job" context (default "unknown"). */
  branch?: string;
  /** Job-log URL for the header + truncation note (default "https://github.com"). */
  jobUrl?: string;
  /** Optional "finished in Xm Ys" duration shown in the header. */
  duration?: string;
  /** Pre-rendered recap markdown ("" when no prior review). */
  recap?: string;
  /** Pre-rendered history markdown ("" when no history). */
  history?: string;
  /** Pre-encoded state marker — appended as the LAST line; never dropped. */
  historyMarker?: string;
  /** Deterministic findings (gitleaks/opengrep) for the Mechanical-checks summary. */
  mechanical?: MechanicalFinding[];
  /** Comment verbosity (VERBOSITY input). "compact" (default) collapses the checklist;
   *  "full" restores the multi-line checklist. Only the checklist differs — the dedup /
   *  empty-section fixes apply in both modes. */
  verbosity?: "compact" | "full";
  /** File count of the reviewed diff — shown in the compact checklist line (default 0). */
  changedFiles?: number;
  /** MAX_ROUNDS surrender note shown under the verdict ("" → omit). */
  capNote?: string;
  /** Pre-rendered coverage-ledger section with its per-path exception rows
   *  (review/ledger.ts `renderLedger`). Joins the shrink ladder AHEAD of findings. */
  ledger?: string;
  /** The same section reduced to its counts summary (`renderLedgerSummary`) — the
   *  ladder's rung between the full ledger and dropping the section entirely. */
  ledgerSummary?: string;
  /** Findings GitHub could not anchor inline (`InlineReviewResult.unanchored`). */
  unanchored?: Finding[];
  /** Findings GitHub's Reviews API rejected with a 422 even when posted alone
   *  (`InlineReviewResult.dropped`, isolated by github/reviewBatch.ts's bisection). */
  dropped?: Finding[];
  /** This round's clusters — multi-member ones render an enumerated block. */
  clusters?: FindingCluster[];
}

/** Thrown when the body cannot fit under the size cap without dropping the marker. */
export class VerdictIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictIntegrityError";
  }
}

/**
 * Format the verdict comment body and its PR label.
 *
 * @param result - the review result (verdict, findings, review_plan,
 *   other_checks, top_must_fix). A null/empty verdict defaults to "approved"
 *   when there are no findings, else "changes" (the bash default).
 * @param opts - branding + the pre-rendered recap/history + the state marker.
 * @returns `{ body, label }` — the full markdown body (marker last) and the bare
 *   label slug ("merge-approved" | "request-changes").
 * @throws VerdictIntegrityError if even a findings-free body + marker exceeds the
 *   size cap (never silently drops the marker).
 */
export function formatVerdict(
  result: ProviderResult,
  opts: VerdictOptions,
): { body: string; label: string } {
  const findings = result.findings ?? [];
  const verdict = resolveVerdict(result.verdict, findings.length);
  const { label, badge } = labelAndBadge(verdict);

  const header = buildHeader(opts.duration, opts.jobUrl ?? "https://github.com");
  const marker = opts.historyMarker ?? "";

  const body: ReviewBody = {
    verdictLabel: `\`${label}\``,
    verdictBadge: badge,
    // Surface the real error + the model's finish_reason when present, so a parse
    // failure ("could not parse") is distinguishable from output truncation ("length").
    errorDetail:
      result.error !== undefined && result.error !== ""
        ? result.error + (result.finishReason ? ` [finish_reason: ${result.finishReason}]` : "")
        : "",
    // "LLM judgment unavailable" keys off the RESOLVED verdict, not errorDetail: a
    // recovered truncation sets `error` while still delivering findings + a verdict.
    llmErrored: verdict === "error",
    header,
    branch: opts.branch ?? "unknown",
    jobUrl: opts.jobUrl ?? "https://github.com",
    botName: opts.botName ?? DEFAULT_BOT_NAME,
    botLogoUrl: opts.botLogoUrl ?? DEFAULT_BOT_LOGO_URL,
    reviewPlan: result.review_plan ?? "",
    otherChecks: result.other_checks ?? "",
    topMustFix: result.top_must_fix ?? [],
    findings,
    changedFiles: opts.changedFiles ?? 0,
    // Default compact: only an explicit "full" restores the multi-line checklist.
    compact: opts.verbosity !== "full",
    recap: opts.recap ?? "",
    history: opts.history ?? "",
    marker,
    mechanical: opts.mechanical ?? [],
    capNote: opts.capNote ?? "",
    ledger: opts.ledger ?? "",
    unanchored: opts.unanchored ?? [],
    dropped: opts.dropped ?? [],
    clusters: opts.clusters ?? [],
  };

  const rendered = fitToSizeLimit(body, marker, opts.ledgerSummary ?? "");
  return { body: rendered, label };
}

/**
 * Fit the body under BODY_SIZE_LIMIT along a fixed ladder (spec §Coverage ledger:
 * the ledger joins it AHEAD of findings):
 *
 *   1. everything;
 *   2. the coverage ledger's per-path exception ROWS dropped (counts summary kept);
 *   3. the coverage ledger SECTION dropped entirely;
 *   4. only then findings shrink, lowest-severity-first — the bash halves `keep`
 *      each pass (FINDINGS_COUNT → … → 0), so the worst findings survive longest.
 *
 * The recap, history and marker are never candidates (renderBody emits them
 * unconditionally). If a findings-free body still overflows after all four rungs,
 * that is an integrity failure — throw, never drop the marker.
 */
function fitToSizeLimit(body: ReviewBody, marker: string, ledgerSummary: string): string {
  // `ledgerRungs`' FIRST rung is `body` itself (its non-empty tuple type pins that),
  // so the everything-included render IS the loop's first pass — rendering it before
  // the loop would render the largest body twice on every single verdict. The seeds
  // below are only what the compiler needs; the loop always overwrites both, and a
  // body that somehow escaped it un-rendered fails loudly in assertMarkerLast.
  let current = body;
  let rendered = "";
  for (const rung of ledgerRungs(body, ledgerSummary)) {
    current = rung;
    rendered = renderBody(rung, buildFindingsSection(rung.findings));
    if (rendered.length <= BODY_SIZE_LIMIT) {
      assertMarkerLast(rendered, marker);
      return rendered;
    }
  }

  let keep = current.findings.length;
  while (keep > 0 && rendered.length > BODY_SIZE_LIMIT) {
    keep = Math.floor(keep / 2);
    const section = buildTruncatedFindingsSection(current.findings, keep, current.jobUrl);
    rendered = renderBody(current, section);
  }

  // A body with no findings to shrink cannot be made smaller here; it is returned
  // as-is (the pre-ladder behavior) rather than failing the run. Only a body that
  // WAS shrunk to zero findings and still overflows is an integrity failure.
  if (rendered.length > BODY_SIZE_LIMIT && body.findings.length > 0) {
    throw new VerdictIntegrityError(
      `verdict body cannot fit under ${BODY_SIZE_LIMIT} chars even with no findings; ` +
        "refusing to drop the state marker",
    );
  }
  assertMarkerLast(rendered, marker);
  return rendered;
}

/**
 * The ladder's ledger rungs, largest first: the body as given, then with the
 * ledger's per-path rows dropped, then with the section gone. A body carrying no
 * ledger has exactly one rung — today's behavior, unchanged. The return type is a
 * NON-EMPTY tuple headed by `body` itself, which is what lets {@link fitToSizeLimit}
 * fold the everything-included render into the loop instead of computing it twice.
 */
function ledgerRungs(body: ReviewBody, ledgerSummary: string): [ReviewBody, ...ReviewBody[]] {
  const rungs: [ReviewBody, ...ReviewBody[]] = [body];
  if (body.ledger === "") return rungs;
  if (ledgerSummary !== "" && ledgerSummary !== body.ledger) {
    rungs.push({ ...body, ledger: ledgerSummary });
  }
  rungs.push({ ...body, ledger: "" });
  return rungs;
}

/** The marker, when present, must be the last line of the body — fail loudly otherwise. */
function assertMarkerLast(rendered: string, marker: string): void {
  if (marker === "") return;
  if (!rendered.includes(marker)) {
    throw new VerdictIntegrityError("body-size guard dropped the state marker");
  }
  const trimmed = rendered.replace(/\n+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  if (lastLine !== marker) {
    throw new VerdictIntegrityError("state marker is not the last line of the body");
  }
}

/**
 * Default an empty/null verdict to approved (no findings) or changes (has findings);
 * "error" passes through. The single home of the default-verdict rule — pipeline.ts
 * imports this rather than re-deriving it, so the fail-safe can't drift between the
 * two call sites.
 */
export function resolveVerdict(
  verdict: ProviderResult["verdict"] | "" | null | undefined,
  findingsCount: number,
): ProviderResult["verdict"] {
  if (verdict === "approved" || verdict === "changes" || verdict === "error") return verdict;
  return findingsCount === 0 ? "approved" : "changes";
}

/** Map the verdict to its PR label slug + human badge (the parity-critical table). */
function labelAndBadge(verdict: ProviderResult["verdict"]): { label: string; badge: string } {
  if (verdict === "approved") {
    return { label: "merge-approved", badge: "✅ Approved" };
  }
  if (verdict === "error") {
    return { label: "request-changes", badge: "🚫 Review incomplete — provider error" };
  }
  return { label: "request-changes", badge: "⚠️ Changes requested" };
}

/** The header line: "**AI Code Review finished[ in DURATION]** —— [View job](url)". */
function buildHeader(duration: string | undefined, jobUrl: string): string {
  const base = duration
    ? `**AI Code Review finished in ${duration}**`
    : "**AI Code Review finished**";
  return `${base} —— [View job](${jobUrl})`;
}

/** Re-export so callers can build findings without importing render.ts directly. */
export type { Finding };
