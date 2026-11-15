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

/** Minimum distinct paths sharing (category, normText) for a cluster to form.
 *  A smaller group is split by fingerprint — one cluster per distinct `fp`, so a
 *  group of unrelated findings still yields one singleton (`members = [exemplar]`)
 *  each, while findings that share a fp share one cluster. */
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
 *
 * ONE CLUSTER PER FINGERPRINT, always: a sub-threshold bucket is split by `fp`
 * ({@link oneClusterPerFp}), never into one singleton per finding, because two
 * findings can share a fingerprint — see that function for why.
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
      clusters.push(...oneClusterPerFp(group));
    }
  }

  return clusters;
}

/**
 * The sub-threshold fallback: ONE cluster per distinct `fp` in `group`, carrying
 * every finding that shares it (first occurrence leads, so a bucket of distinct
 * fingerprints still yields one singleton per finding, exactly as before).
 *
 * Two findings CAN share a fingerprint: `fp` is sha1(path + category + normText)
 * and deliberately excludes `line` (state.ts), while validate.ts's dedup key
 * includes it — so one defect the model reports at two different lines of the
 * same file survives dedup as two findings with the SAME fp. Emitting one
 * singleton cluster per finding there made the exemplar→members map both
 * pipeline/reduce.ts and pipeline/reviewCall.ts build from these clusters
 * (`new Map(clustered.map((c) => [c.exemplar.fp, c.members]))`) collide on that
 * fp, so the second cluster silently overwrote the first and reconcile resolved
 * one thread while re-creating the other — forever, on every push.
 *
 * Grouping by fp instead makes that map injective: every finding sharing a
 * fingerprint lands in the same bucket (same path + category + normText means the
 * same grouping key by construction), so no two clusters can claim one fp.
 */
function oneClusterPerFp(group: StampedFinding[]): FindingCluster[] {
  const byFp = new Map<string, FindingCluster>();
  for (const finding of group) {
    const cluster = byFp.get(finding.fp);
    if (cluster) cluster.members.push(finding);
    else byFp.set(finding.fp, { exemplar: finding, members: [finding] });
  }
  return [...byFp.values()];
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
