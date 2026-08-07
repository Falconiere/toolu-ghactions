import { describe, it, expect } from "vitest";
import { clusterFindings } from "@/review/cluster.js";
import { fingerprint, type Finding as StateFinding } from "@/state.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";

/** Build a stamped finding (validated shape + fp attached), mirroring
 *  reviewCall.ts's `validate()` — the real path that produces StampedFinding[]. */
function stamp(f: {
  path: string;
  line: number;
  severity?: "blocker" | "high" | "medium" | "low" | "nit";
  category?: string;
  text: string;
}): StampedFinding {
  const stateFinding: StateFinding = { path: f.path, category: f.category, text: f.text };
  return {
    path: f.path,
    line: f.line,
    severity: f.severity ?? "medium",
    category: f.category,
    text: f.text,
    fp: fingerprint(stateFinding),
  };
}

describe("clusterFindings — AC-4 logic half: 67 findings across 67 paths", () => {
  const repeated: StampedFinding[] = Array.from({ length: 67 }, (_, i) =>
    stamp({
      path: `src/module-${String(i).padStart(3, "0")}/index.ts`,
      line: 10,
      category: "convention",
      text: "This file must import the shared logger instead of console.log.",
    }),
  );

  it("collapses into exactly 1 cluster with 67 members, exemplar = lowest fp without priorClusters", () => {
    const clusters = clusterFindings(repeated);
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.members.length).toBe(67);

    const lowestFp = [...repeated.map((f) => f.fp)].sort()[0];
    expect(clusters[0]?.exemplar.fp).toBe(lowestFp);

    // Members are sorted by fp for determinism.
    const fps = clusters[0]?.members.map((m) => m.fp) ?? [];
    expect(fps).toEqual([...fps].sort());
  });

  it("exemplar is the pinned prior exemplar fp when priorClusters names one still present", () => {
    const allFps = [...repeated.map((f) => f.fp)].sort();
    const pinnedFp = allFps[allFps.length - 1];
    if (pinnedFp === undefined) throw new Error("test setup: expected at least one fp");
    // Pin to a fp that is NOT the lowest, so the test actually exercises pinning
    // (not coincidentally matching the no-priorClusters default).
    const priorClusters: Record<string, string> = {};
    for (const fp of allFps) priorClusters[fp] = pinnedFp;

    const clusters = clusterFindings(repeated, priorClusters);
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.exemplar.fp).toBe(pinnedFp);
  });

  it("member fps are byte-identical to the unclustered fingerprints (golden)", () => {
    const before = new Set(repeated.map((f) => f.fp));
    const clusters = clusterFindings(repeated);
    const members = clusters[0]?.members ?? [];
    const after = new Set(members.map((m) => m.fp));
    expect(after).toEqual(before);
    // And each member's fp still matches a fresh fingerprint() computation —
    // clustering never mutated path/category/text.
    for (const m of members) {
      expect(fingerprint({ path: m.path, category: m.category, text: m.text })).toBe(m.fp);
    }
  });
});

describe("clusterFindings — sub-threshold groups stay singletons", () => {
  it("2 identical findings (2 distinct paths) stay 2 singleton clusters", () => {
    const findings = [
      stamp({ path: "src/a.ts", line: 1, category: "style", text: "Use const, not let." }),
      stamp({ path: "src/b.ts", line: 1, category: "style", text: "Use const, not let." }),
    ];
    const clusters = clusterFindings(findings);
    expect(clusters.length).toBe(2);
    for (const c of clusters) {
      expect(c.members.length).toBe(1);
      expect(c.members[0]).toBe(c.exemplar);
    }
  });
});

describe("clusterFindings — mixed batch partitions correctly", () => {
  it("one 3+ group clusters, the rest stay singletons", () => {
    const grouped: StampedFinding[] = Array.from({ length: 5 }, (_, i) =>
      stamp({
        path: `src/g-${i}.ts`,
        line: 3,
        category: "security",
        text: "Hardcoded credential detected in source.",
      }),
    );
    const singletons: StampedFinding[] = [
      stamp({ path: "src/s1.ts", line: 5, category: "perf", text: "N+1 query in the loop body." }),
      stamp({ path: "src/s2.ts", line: 9, category: "correctness", text: "Off-by-one bound." }),
      stamp({ path: "src/s3.ts", line: 2, category: "nit", text: "Rename this variable." }),
    ];
    const clusters = clusterFindings([...grouped, ...singletons]);

    // 1 cluster of 5 + 3 singleton clusters = 4 clusters total.
    expect(clusters.length).toBe(4);
    const multiMember = clusters.filter((c) => c.members.length > 1);
    expect(multiMember.length).toBe(1);
    expect(multiMember[0]?.members.length).toBe(5);
    const singletonClusters = clusters.filter((c) => c.members.length === 1);
    expect(singletonClusters.length).toBe(3);
    // Every singleton's exemplar is its own sole member.
    for (const c of singletonClusters) expect(c.exemplar).toBe(c.members[0]);
  });

  it("distinct category with identical text does NOT merge into the same cluster", () => {
    const findings: StampedFinding[] = [
      stamp({
        path: "src/a.ts",
        line: 1,
        category: "security",
        text: "Same wording, different bucket.",
      }),
      stamp({
        path: "src/b.ts",
        line: 1,
        category: "security",
        text: "Same wording, different bucket.",
      }),
      stamp({
        path: "src/c.ts",
        line: 1,
        category: "security",
        text: "Same wording, different bucket.",
      }),
      stamp({
        path: "src/d.ts",
        line: 1,
        category: "style",
        text: "Same wording, different bucket.",
      }),
    ];
    const clusters = clusterFindings(findings);
    // 3 security findings cluster; the lone style finding stays a singleton.
    expect(clusters.length).toBe(2);
    const sizes = clusters.map((c) => c.members.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 3]);
  });
});

describe("clusterFindings — determinism", () => {
  it("same input (in different array order) produces the same partition", () => {
    const findings: StampedFinding[] = Array.from({ length: 6 }, (_, i) =>
      stamp({
        path: `src/dup-${i}.ts`,
        line: 1,
        category: "convention",
        text: "Migrate to the new logger API.",
      }),
    );
    const shuffled = [
      findings[3],
      findings[0],
      findings[5],
      findings[1],
      findings[4],
      findings[2],
    ].filter((f): f is StampedFinding => f !== undefined);

    const a = clusterFindings(findings);
    const b = clusterFindings(shuffled);

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]?.members.map((m) => m.fp)).toEqual(b[0]?.members.map((m) => m.fp));
    expect(a[0]?.exemplar.fp).toBe(b[0]?.exemplar.fp);
  });
});
