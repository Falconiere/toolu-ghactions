// sections.test.ts — review/sections.ts, the verdict comment's three size-proof
// sections. They exist BECAUSE a huge PR produces huge lists, so the caps and the
// "what was dropped is stated, never silent" rule are the contract, not decoration.
// The cluster fixtures come from the real `clusterFindings()` over real
// `fingerprint()`-stamped findings, so the blocks rendered here are the blocks a
// real round would render.
import { describe, expect, it } from "vitest";
import {
  buildClusterSection,
  buildDroppedSection,
  buildUnanchoredSection,
  clusterMemberNote,
} from "@/review/sections.js";
import { clusterFindings, type FindingCluster } from "@/review/cluster.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { Finding } from "@/llm/schema.js";
import { fingerprint } from "@/state.js";

/** The caps sections.ts enforces, restated here so a change to either is caught
 *  by a failing expectation rather than by a silently shorter comment. */
const MAX_UNANCHORED_ROWS = 20;
const MAX_CLUSTERS = 10;
const MAX_MEMBERS_LISTED = 10;

/** A stamped finding with a real fingerprint — what the pipeline hands the renderer. */
function stamp(f: {
  path: string;
  line: number;
  severity?: StampedFinding["severity"];
  category?: string;
  text: string;
}): StampedFinding {
  const base = {
    path: f.path,
    line: f.line,
    severity: f.severity ?? "medium",
    category: f.category,
    text: f.text,
  };
  return { ...base, fp: fingerprint({ path: f.path, category: f.category, text: f.text }) };
}

/** `count` repeats of one defect across distinct paths — a real Layer 3 cluster. */
function repeatedCluster(count: number, text: string, prefix = "src/m"): FindingCluster {
  const findings = Array.from({ length: count }, (_, i) =>
    stamp({
      path: `${prefix}${String(i).padStart(3, "0")}.ts`,
      line: 7,
      category: "convention",
      text,
    }),
  );
  const [cluster] = clusterFindings(findings);
  if (cluster === undefined) throw new Error("fixture: clusterFindings produced nothing");
  return cluster;
}

/** A plain schema Finding for the two publish-failure sections. */
function unanchored(i: number, over: Partial<Finding> = {}): Finding {
  return {
    path: `src/u${String(i).padStart(3, "0")}.ts`,
    line: 10 + i,
    severity: "high",
    text: `unanchorable finding ${i}`,
    confidence: "high",
    ...over,
  };
}

describe("buildClusterSection", () => {
  it('returns "" for no clusters and for singleton-only clusters', () => {
    expect(buildClusterSection([])).toBe("");
    const singletons = clusterFindings([
      stamp({ path: "src/a.ts", line: 1, text: "one-off finding" }),
      stamp({ path: "src/b.ts", line: 2, text: "another one-off" }),
    ]);
    expect(singletons.every((c) => c.members.length === 1)).toBe(true);
    expect(buildClusterSection(singletons)).toBe("");
  });

  it("enumerates every member of a small cluster and carries the dismissal note", () => {
    const cluster = repeatedCluster(4, "Use the shared logger instead of console.");
    const section = buildClusterSection([cluster]);

    expect(section).toContain("### Repeated findings (1)");
    // The exemplar's own line: location, category, severity, text.
    expect(section).toContain(
      `- \`${cluster.exemplar.path}:${cluster.exemplar.line}\` _(convention)_: medium: ` +
        "Use the shared logger instead of console.",
    );
    // Every member path is named — 4 is under MAX_MEMBERS_LISTED, so nothing hides.
    expect(section).toContain("Same finding in 4 files:");
    for (const m of cluster.members) expect(section).toContain(`\`${m.path}\``);
    expect(section).not.toContain("more repeated finding");
    // Load-bearing, not decoration: reconcile settles the WHOLE cluster on dismissal.
    expect(section).toContain("_Dismissing this thread dismisses the pattern (4 files)._");
  });

  it("caps the member list at MAX_MEMBERS_LISTED and counts the rest", () => {
    const cluster = repeatedCluster(67, "Use the shared logger instead of console.");
    const section = buildClusterSection([cluster]);

    expect(section).toContain("Same finding in 67 files:");
    // Exactly MAX_MEMBERS_LISTED backticked paths on the member line, plus the count.
    const memberLine = section.split("\n").find((l) => l.includes("Same finding in 67 files:"));
    expect(memberLine).toBeDefined();
    expect((memberLine ?? "").match(/`[^`]+`/g)).toHaveLength(MAX_MEMBERS_LISTED);
    expect(section).toContain(`… ${67 - MAX_MEMBERS_LISTED} more`);
    // The dismissal note still names the TRUE total, not the listed count.
    expect(section).toContain("_Dismissing this thread dismisses the pattern (67 files)._");
  });

  it("caps rendered clusters at MAX_CLUSTERS with an explicit overflow line", () => {
    const clusters = Array.from({ length: MAX_CLUSTERS + 3 }, (_, i) =>
      repeatedCluster(3, `Repeated defect number ${i}.`, `src/g${i}-`),
    );
    const section = buildClusterSection(clusters);

    // The heading counts them ALL; only the blocks are capped.
    expect(section).toContain(`### Repeated findings (${MAX_CLUSTERS + 3})`);
    const blocks = section.split("\n").filter((l) => l.startsWith("- `"));
    expect(blocks).toHaveLength(MAX_CLUSTERS);
    expect(section).toContain("_… 3 more repeated finding(s)_");
    // The hidden ones are counted, never listed — the section cannot grow with PR size.
    expect(section).not.toContain(`Repeated defect number ${MAX_CLUSTERS + 2}.`);
  });

  it("ignores singleton clusters mixed in among multi-member ones", () => {
    const repeated = repeatedCluster(3, "The repeated one.", "src/rep-");
    const [singleton] = clusterFindings([stamp({ path: "src/solo.ts", line: 1, text: "A solo." })]);
    if (singleton === undefined) throw new Error("fixture: no singleton cluster");
    const section = buildClusterSection([singleton, repeated, singleton]);

    expect(section).toContain("### Repeated findings (1)");
    expect(section).not.toContain("A solo.");
  });

  it("omits the category tag when the exemplar carries none", () => {
    const findings = Array.from({ length: 3 }, (_, i) =>
      stamp({ path: `src/nc${i}.ts`, line: 2, text: "No category on this one." }),
    );
    const [cluster] = clusterFindings(findings);
    if (cluster === undefined) throw new Error("fixture: no cluster");
    const section = buildClusterSection([cluster]);
    expect(section).toContain(`\`${cluster.exemplar.path}:${cluster.exemplar.line}\`: medium:`);
    expect(section).not.toContain("_()_");
  });

  it("clusterMemberNote carries the same two facts as the block, standalone", () => {
    // The inline exemplar comment (pipeline/reduce.ts decorateExemplars) and the
    // sticky section must state the SAME thing (AC-4) — one builder, two homes.
    const cluster = repeatedCluster(67, "Use the shared logger instead of console.");
    const note = clusterMemberNote(cluster.members);
    const section = buildClusterSection([cluster]);

    expect(note).toContain("Same finding in 67 files:");
    expect(note).toContain("_Dismissing this thread dismisses the pattern (67 files)._");
    for (const line of note.split("\n\n")) {
      if (line !== "") expect(section).toContain(line);
    }
  });
});

describe("buildUnanchoredSection", () => {
  it('returns "" for an empty list (no filler section)', () => {
    expect(buildUnanchoredSection([])).toBe("");
  });

  it("renders one row per finding with its location, severity and text", () => {
    const section = buildUnanchoredSection([unanchored(0), unanchored(1)]);
    expect(section).toContain("### Unanchored findings (2)");
    expect(section).toContain("GitHub does not show these files in its own diff");
    expect(section).toContain("- `src/u000.ts:10`: high: unanchorable finding 0");
    expect(section).toContain("- `src/u001.ts:11`: high: unanchorable finding 1");
    expect(section).not.toContain("_… ");
  });

  // NOTE: `locationOf`'s line-less branch (`line` undefined/null → bare `path`) is
  // NOT exercised here, and cannot be: both entry points into it are typed
  // `Finding` / `StampedFinding`, whose `line` is a required `number`
  // (llm/schema.ts). Constructing the null case would need a cast the house rules
  // forbid, so the branch is left flagged rather than falsely covered.

  it("caps rows at MAX_UNANCHORED_ROWS and counts the remainder", () => {
    const findings = Array.from({ length: MAX_UNANCHORED_ROWS + 15 }, (_, i) => unanchored(i));
    const section = buildUnanchoredSection(findings);

    // The heading counts every finding; only the rows are capped.
    expect(section).toContain(`### Unanchored findings (${MAX_UNANCHORED_ROWS + 15})`);
    expect(section.split("\n").filter((l) => l.startsWith("- `"))).toHaveLength(
      MAX_UNANCHORED_ROWS,
    );
    expect(section).toContain("_… 15 more_");
    expect(section).not.toContain(`unanchorable finding ${MAX_UNANCHORED_ROWS + 14}`);
  });
});

describe("buildDroppedSection", () => {
  it('returns "" for an empty list', () => {
    expect(buildDroppedSection([])).toBe("");
  });

  it("renders the 422 title with the count and one row per finding", () => {
    const findings = [unanchored(0, { severity: "blocker" }), unanchored(1, { severity: "nit" })];
    const section = buildDroppedSection(findings);

    // The exact title matters: it is how a reader tells an API refusal apart from
    // a finding that never had an anchor at all.
    expect(section).toContain("### Findings GitHub rejected inline (2)");
    expect(section).toContain("GitHub's Reviews API rejected these comments (422)");
    expect(section).toContain("- `src/u000.ts:10`: blocker: unanchorable finding 0");
    expect(section).toContain("- `src/u001.ts:11`: nit: unanchorable finding 1");
  });

  it("shares the row cap with the unanchored section", () => {
    const findings = Array.from({ length: MAX_UNANCHORED_ROWS + 4 }, (_, i) => unanchored(i));
    const section = buildDroppedSection(findings);
    expect(section).toContain(`### Findings GitHub rejected inline (${MAX_UNANCHORED_ROWS + 4})`);
    expect(section.split("\n").filter((l) => l.startsWith("- `"))).toHaveLength(
      MAX_UNANCHORED_ROWS,
    );
    expect(section).toContain("_… 4 more_");
  });

  it("the two publish-failure sections are distinguishable side by side", () => {
    // Both can render in the same body; a reader must be able to tell which is which.
    const combined = buildUnanchoredSection([unanchored(0)]) + buildDroppedSection([unanchored(1)]);
    expect(combined).toContain("### Unanchored findings (1)");
    expect(combined).toContain("### Findings GitHub rejected inline (1)");
  });
});
