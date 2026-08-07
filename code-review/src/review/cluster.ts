// review/cluster.ts — the deterministic reducer (spec §Layer 3): findings that
// are the same defect repeated across ≥3 files collapse into one exemplar-led
// cluster, so publish posts one inline comment per cluster (members enumerated
// in the body) instead of one per file. Every member keeps its own individual
// fingerprint in the state marker — clustering never mutates a finding.
//
// `reconcile` (src/review/reconcile.ts) consumes cluster REPRESENTATIVES (the
// exemplar) only, never members directly; expansion back to the full member
// list happens BEFORE `partitionFindings` (src/report/partition.ts), whose
// exhaustiveness check compares `claimed` against `findings`/`applied` by fp and
// would fail on a representative-only `applied`. A cluster's GitHub thread
// resolves only when ALL member fps are gone.
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import { normText } from "@/state.js";

/** One cluster: the exemplar (whose body publish renders inline) plus every
 *  finding that clustered with it, including the exemplar itself. */
export interface FindingCluster {
  exemplar: StampedFinding;
  members: StampedFinding[];
}

/** Minimum distinct paths sharing (category, normText) for a cluster to form;
 *  smaller groups stay singleton clusters (`members = [exemplar]`). */
const MIN_CLUSTER_PATHS = 3;

/**
 * Group findings sharing the same `category` and IDENTICAL {@link normText} of
 * `text` — the exact rule `fingerprint()` itself uses for text, so two findings
 * in the same group would fingerprint identically but for `path` — across ≥3
 * distinct paths into one cluster. Groups spanning fewer than 3 distinct paths
 * stay singleton clusters, one per finding.
 *
 * The exemplar is pinned via `priorClusters` (member fp -> exemplar fp from the
 * last round): the prior exemplar fp if it is still a member this round, else
 * the lowest member fp (lexicographic). Members are sorted by fp for
 * determinism; each keeps its own `.fp` untouched.
 */
export function clusterFindings(
  findings: StampedFinding[],
  priorClusters?: Record<string, string>,
): FindingCluster[] {
  const groups = groupByCategoryAndText(findings);
  const clusters: FindingCluster[] = [];

  for (const group of groups) {
    const distinctPaths = new Set(group.map((f) => f.path));
    if (distinctPaths.size >= MIN_CLUSTER_PATHS) {
      clusters.push(buildCluster(group, priorClusters));
    } else {
      for (const finding of group) clusters.push({ exemplar: finding, members: [finding] });
    }
  }

  return clusters;
}

/** Group findings by `${category}\0${normText(text)}` — the "near-identical"
 *  key. Group order is insertion order of first occurrence; callers never rely
 *  on cluster array order (determinism lives in each cluster's fp sort). */
function groupByCategoryAndText(findings: StampedFinding[]): StampedFinding[][] {
  const byKey = new Map<string, StampedFinding[]>();
  for (const finding of findings) {
    const key = `${finding.category ?? ""}\0${normText(finding.text)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(finding);
    else byKey.set(key, [finding]);
  }
  return [...byKey.values()];
}

/** Build one multi-member cluster: sort members by fp, pin the exemplar. */
function buildCluster(
  group: StampedFinding[],
  priorClusters: Record<string, string> | undefined,
): FindingCluster {
  const members = [...group].sort((a, b) => a.fp.localeCompare(b.fp));
  const exemplarFp = pinExemplarFp(
    members.map((m) => m.fp),
    priorClusters,
  );
  const exemplar = members.find((m) => m.fp === exemplarFp);
  // `members` is non-empty (a >= 3-distinct-path group has >= 1 finding) and
  // pinExemplarFp always returns either the lowest member fp or a fp it
  // verified is present among `members`, so this can only fire on a broken
  // invariant — fail loudly rather than silently pick an arbitrary exemplar.
  if (exemplar === undefined) {
    throw new Error(`review/cluster.ts: pinned exemplar fp "${exemplarFp}" is not a member`);
  }
  return { exemplar, members };
}

/** The prior exemplar fp if it is still present among this round's member fps,
 *  else the lowest member fp (lexicographic — matches the `members` sort). */
function pinExemplarFp(
  memberFps: string[],
  priorClusters: Record<string, string> | undefined,
): string {
  const sorted = [...memberFps].sort();
  const lowest = sorted[0] ?? "";
  if (!priorClusters) return lowest;

  const memberSet = new Set(memberFps);
  const pinnedCandidates = sorted
    .map((fp) => priorClusters[fp])
    .filter(
      (exemplarFp): exemplarFp is string => exemplarFp !== undefined && memberSet.has(exemplarFp),
    )
    .sort();
  return pinnedCandidates[0] ?? lowest;
}
