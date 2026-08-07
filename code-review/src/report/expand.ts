// report/expand.ts — put cluster MEMBERS back before the report layer runs.
// `reconcile()` works on one representative per cluster (spec §Layer 3), but
// `partitionFindings` (report/partition.ts:201-213) checks exhaustiveness by
// comparing the fps it classified against `findings`/`applied`: a representative-
// only `applied.toCreate` paired with a full member `findings` list under-reports
// 66 of 67 findings, and the reverse pairing fails the check outright. So every
// representative-carrying array — `findings` AND each applied bucket — is expanded
// through {@link expandClusters} first, with the SAME map, so the two stay
// consistent. Lives beside partition.ts rather than inside it only because that
// file is at the 300-line ceiling.
import type { StampedFinding } from "@/pipeline/reviewCall.js";

/** Group a `member fp -> exemplar fp` map (the marker's `clusters`) the other way
 *  round: exemplar fp -> member fps, each list sorted for determinism. */
function membersByExemplar(clusters: Record<string, string>): Map<string, string[]> {
  const byExemplar = new Map<string, string[]>();
  for (const [memberFp, exemplarFp] of Object.entries(clusters)) {
    const list = byExemplar.get(exemplarFp);
    if (list) list.push(memberFp);
    else byExemplar.set(exemplarFp, [memberFp]);
  }
  for (const list of byExemplar.values()) list.sort();
  return byExemplar;
}

/**
 * Expand every cluster representative in `findings` to itself followed by its
 * members, preserving the input order and deduping by fp (a representative that
 * is also listed as its own member appears once). A finding that leads no cluster
 * passes through untouched.
 *
 * `allMembers` is this round's fp -> finding index; a member fp with no finding in
 * it is SKIPPED rather than fabricated — a marker whose `clusters` map outlived
 * the findings it describes must not conjure a finding the run never produced.
 */
export function expandClusters(
  findings: StampedFinding[],
  clusters: Record<string, string>,
  allMembers: ReadonlyMap<string, StampedFinding>,
): StampedFinding[] {
  const byExemplar = membersByExemplar(clusters);
  const out: StampedFinding[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!seen.has(finding.fp)) {
      seen.add(finding.fp);
      out.push(finding);
    }
    for (const memberFp of byExemplar.get(finding.fp) ?? []) {
      const member = allMembers.get(memberFp);
      if (member === undefined || seen.has(memberFp)) continue;
      seen.add(memberFp);
      out.push(member);
    }
  }

  return out;
}
