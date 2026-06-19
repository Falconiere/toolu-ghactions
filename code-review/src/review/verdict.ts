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
import type { ProviderResult } from "@/llm/openrouter.js";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
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
    header,
    branch: opts.branch ?? "unknown",
    jobUrl: opts.jobUrl ?? "https://github.com",
    botName: opts.botName ?? DEFAULT_BOT_NAME,
    botLogoUrl: opts.botLogoUrl ?? DEFAULT_BOT_LOGO_URL,
    reviewPlan: result.review_plan ?? "",
    otherChecks: result.other_checks ?? "",
    topMustFix: result.top_must_fix ?? [],
    findings,
    recap: opts.recap ?? "",
    history: opts.history ?? "",
    marker,
    mechanical: opts.mechanical ?? [],
  };

  const rendered = fitToSizeLimit(body, marker);
  return { body: rendered, label };
}

/**
 * Render the body, then shrink findings lowest-severity-first until it fits under
 * BODY_SIZE_LIMIT. The bash halves `keep` each pass (FINDINGS_COUNT → … → 0); we
 * reproduce that, so the worst findings survive longest. The recap/history/marker
 * are always present (renderBody emits them unconditionally). If a findings-free
 * body still overflows, that is an integrity failure — throw, never drop.
 */
function fitToSizeLimit(body: ReviewBody, marker: string): string {
  let rendered = renderBody(body, buildFindingsSection(body.findings));
  if (rendered.length <= BODY_SIZE_LIMIT || body.findings.length === 0) {
    assertMarkerLast(rendered, marker);
    return rendered;
  }

  let keep = body.findings.length;
  while (keep > 0 && rendered.length > BODY_SIZE_LIMIT) {
    keep = Math.floor(keep / 2);
    const section = buildTruncatedFindingsSection(body.findings, keep, body.jobUrl);
    rendered = renderBody(body, section);
  }

  if (rendered.length > BODY_SIZE_LIMIT) {
    throw new VerdictIntegrityError(
      `verdict body cannot fit under ${BODY_SIZE_LIMIT} chars even with no findings; ` +
        "refusing to drop the state marker",
    );
  }
  assertMarkerLast(rendered, marker);
  return rendered;
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
