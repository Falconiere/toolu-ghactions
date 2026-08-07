// expand.test.ts — report/expand.ts's STALE-MARKER guard, on its own. The happy
// path (a representative expanding to its members before the exhaustiveness check)
// is covered in the sibling partition.test.ts, which is at its file-size ceiling;
// what lives here is the branch that decides what happens when the marker's
// `clusters` map has outlived the findings it describes.
//
// That map is persisted across rounds, so it routinely names fps THIS round never
// produced — the author fixed those files, or the round never read them. Expansion
// must then hand the report layer exactly what the round produced, because
// `partitionFindings` treats every fp it is given as a real finding: a fabricated
// member would be reported to toolu.sh as a live finding with no body behind it.
//
// Real data: findings stamped with the real `fingerprint()`, grouped by the real
// `clusterFindings()`, and the cluster map built the way pipeline/reduce.ts builds
// the marker's `clusters` field.
import { describe, expect, it } from "vitest";
import { expandClusters } from "@/report/expand.js";
import { clusterFindings } from "@/review/cluster.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import { fingerprint } from "@/state.js";

const PATTERN_TEXT = "missing null check before dereferencing the config object";

/** One member of the repeated pattern, stamped exactly as reviewCall.ts stamps it. */
function member(i: number): StampedFinding {
  const f = {
    path: `src/pkg/file${String(i).padStart(2, "0")}.ts`,
    line: 10 + i,
    severity: "high" as const,
    category: "correctness",
    text: PATTERN_TEXT,
  };
  return { ...f, fp: fingerprint(f) };
}

/** The marker's `clusters` field for a round: member fp -> exemplar fp, multi-member
 *  clusters only (pipeline/reduce.ts omits singletons). */
function clusterMap(findings: StampedFinding[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cluster of clusterFindings(findings)) {
    if (cluster.members.length < 2) continue;
    for (const m of cluster.members) out[m.fp] = cluster.exemplar.fp;
  }
  return out;
}

describe("expandClusters — a cluster map that outlived its findings", () => {
  // LAST round: 12 repeats, so the marker persists a 12-entry cluster map.
  const lastRound = Array.from({ length: 12 }, (_, i) => member(i));
  const staleClusters = clusterMap(lastRound);
  const exemplar = lastRound.find((m) => staleClusters[m.fp] === m.fp);

  it("the fixture really is a stale 12-member map led by one exemplar", () => {
    expect(Object.keys(staleClusters)).toHaveLength(12);
    expect(new Set(Object.values(staleClusters)).size).toBe(1);
    expect(exemplar).toBeDefined();
  });

  it("skips every member fp this round produced no finding for — nothing is fabricated", () => {
    // THIS round only re-raised three of the twelve; the other nine are fixed.
    if (exemplar === undefined) throw new Error("fixture: no exemplar");
    const survivors = [exemplar, member(5), member(9)];
    const byFp = new Map(survivors.map((f) => [f.fp, f]));

    const expanded = expandClusters([exemplar], staleClusters, byFp);

    // Exactly the three findings that exist — never the nine the map still names.
    expect(expanded.map((f) => f.fp).sort()).toEqual(survivors.map((f) => f.fp).sort());
    // Every entry is an object the round actually produced, by identity.
    for (const f of expanded) expect(survivors).toContain(f);
  });

  it("returns the representative ALONE when the round produced no member at all", () => {
    if (exemplar === undefined) throw new Error("fixture: no exemplar");
    const byFp = new Map([[exemplar.fp, exemplar]]);
    expect(expandClusters([exemplar], staleClusters, byFp)).toEqual([exemplar]);
  });

  it("skips members even when the representative itself is absent from the index", () => {
    // `findings` is the source of truth for what passes through; `allMembers` only
    // gates the members. An empty index must therefore not drop the representative
    // NOR conjure its members.
    if (exemplar === undefined) throw new Error("fixture: no exemplar");
    const expanded = expandClusters([exemplar], staleClusters, new Map());
    expect(expanded).toEqual([exemplar]);
  });

  it("expands nothing when the map is empty (a round with no multi-member cluster)", () => {
    const singletons = [member(0), member(1)].map((f, i) => ({ ...f, text: `distinct ${i}` }));
    const restamped = singletons.map((f) => ({
      ...f,
      fp: fingerprint({ path: f.path, category: f.category, text: f.text }),
    }));
    const byFp = new Map(restamped.map((f) => [f.fp, f]));
    expect(expandClusters(restamped, clusterMap(restamped), byFp)).toEqual(restamped);
  });

  it("dedupes a representative that the map also lists as its own member", () => {
    // reduce.ts writes the exemplar into `clusters` too (member fp -> its own fp),
    // so the expansion walks over the representative a second time.
    if (exemplar === undefined) throw new Error("fixture: no exemplar");
    expect(staleClusters[exemplar.fp]).toBe(exemplar.fp);
    const byFp = new Map(lastRound.map((f) => [f.fp, f]));

    const expanded = expandClusters([exemplar], staleClusters, byFp);
    expect(expanded).toHaveLength(12);
    expect(new Set(expanded.map((f) => f.fp)).size).toBe(12);
    expect(expanded[0]).toBe(exemplar); // …and it stays first, in input order
  });
});
