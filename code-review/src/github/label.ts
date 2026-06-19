// github/label.ts — set the verdict label (a real GitHub label chip) on the PR,
// mirroring the machine-readable token in the summary comment so the PR is
// filterable/automatable from the UI. Port of post-label.sh.
//
// Adds the verdict label and removes the OPPOSITE one, so a PR never carries
// both `merge-approved` and `request-changes` at once. "error" maps
// to the request-changes label on purpose (a failed review must not auto-merge).
// Honors MANAGE_LABELS (false → no-op). Non-fatal: any API error is caught and
// reported; this never throws.
import { errorMessage } from "@/errors.js";

const APPROVED_LABEL = "merge-approved";
const CHANGES_LABEL = "request-changes";
const APPROVED_COLOR = "0e8a16";
const CHANGES_COLOR = "d93f0b";

/** The slice of an Octokit REST client this module uses. */
export interface LabelClient {
  rest: {
    issues: {
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
        description: string;
      }): Promise<unknown>;
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
    };
  };
}

/** Repo + PR coordinates for the label operations. */
export interface LabelTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Options for {@link setVerdictLabel}. */
export interface LabelOptions {
  /** When false, the whole step is a no-op (mirrors INPUT_MANAGE_LABELS=false). */
  manageLabels?: boolean;
}

/** Outcome of {@link setVerdictLabel} — non-fatal, so failures are reported, not thrown. */
export interface LabelResult {
  /** Whether the verdict label was set. */
  changed: boolean;
  /** The label that was added (when changed). */
  added?: string;
  /** Why nothing changed (skip reason or caught error message). */
  reason?: string;
}

/** Map a verdict to (label-to-add, label-to-remove, chip-color), or null for no change. */
function mapVerdict(verdict: string): { add: string; remove: string; color: string } | null {
  switch (verdict) {
    case "approved":
      return { add: APPROVED_LABEL, remove: CHANGES_LABEL, color: APPROVED_COLOR };
    case "changes":
    case "error":
      return { add: CHANGES_LABEL, remove: APPROVED_LABEL, color: CHANGES_COLOR };
    default:
      return null;
  }
}

/**
 * Set the PR's verdict label and remove the opposite one.
 *
 * Ensures the label exists (idempotent — an "already exists" error is ignored),
 * removes the opposite verdict label (a 404 when it isn't set is ignored), then
 * adds the verdict label. Honors `manageLabels:false` as a no-op and treats an
 * unknown verdict as "no label change". Never throws — any API error is caught.
 *
 * @param octokit - the injected REST client.
 * @param verdict - the review verdict: "approved" | "changes" | "error".
 * @param target - repo + PR coordinates.
 * @param opts - {@link LabelOptions} (MANAGE_LABELS).
 */
export async function setVerdictLabel(
  octokit: LabelClient,
  verdict: string,
  target: LabelTarget,
  opts: LabelOptions = {},
): Promise<LabelResult> {
  if (opts.manageLabels === false) return { changed: false, reason: "MANAGE_LABELS=false" };

  const mapping = mapVerdict(verdict);
  if (!mapping) return { changed: false, reason: `verdict '${verdict}' — no label change` };

  const { owner, repo, prNumber } = target;

  // Ensure the label exists (a fresh repo may lack it). An "already exists"
  // failure is the expected idempotent case — swallow it.
  try {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: mapping.add,
      color: mapping.color,
      description: "AI code review verdict",
    });
  } catch {
    // already exists / insufficient perms — non-fatal, the add below still tries.
  }

  // Remove the opposite verdict label (ignore a 404 when it isn't set).
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: prNumber,
      name: mapping.remove,
    });
  } catch {
    // not set — ignore.
  }

  // Add the verdict label.
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [mapping.add],
    });
    return { changed: true, added: mapping.add };
  } catch (err) {
    return { changed: false, reason: errorMessage(err, "labels API request failed") };
  }
}
