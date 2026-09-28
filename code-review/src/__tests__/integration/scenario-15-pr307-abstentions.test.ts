// scenario-15-pr307-abstentions — Falconiere/comemory PR #307, replayed end to end.
// Its latest summary published 4 findings (🟠 2 high 🟡 1 medium 🔵 1 low); three of
// them conclude, in their own final sentence, that there is no defect ("… is safe.
// No defect, abstain.", "… No deadlock risk.", "… acceptable for testing the
// client-side refusal."). Every finding here is anchored on its real changed line
// and quotes the real post-change source (comemory @ fa490c8), so ONLY the
// abstention gate can drop them — proven on the real pipeline (`runReview`): no
// inline thread, no severity count, no verdict weight.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import {
  PR307_SOURCE,
  PR307_SUMMARY_IDS,
  pr307Comment,
} from "@/review/__tests__/pr307-evidence.js";
import {
  baseInputs,
  cleanupRepos,
  inlineComments,
  lastBody,
  prContext,
  scratchRepo,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { changes, diffPaths, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

/** Each recorded file with its real line at the recorded number (filler above it). */
function pr307Repo() {
  return scratchRepo((dir) => {
    for (const [path, lines] of Object.entries(PR307_SOURCE)) {
      const out: string[] = [];
      for (const [n, text] of Object.entries(lines)) {
        while (out.length < Number(n) - 1) out.push(`// line ${out.length + 1}`);
        out.push(text);
      }
      writeFile(dir, path, `${out.join("\n")}\n`);
    }
  });
}

/** A recorded PR #307 finding as the model emitted it, quoting its real source line. */
function recorded(id: number, conclusion?: ScriptedFinding["conclusion"]): ScriptedFinding {
  const c = pr307Comment(id);
  const quoted = PR307_SOURCE[c.path]?.[String(c.line)]?.trim();
  if (quoted === undefined) throw new Error(`no recorded source for ${c.path}:${c.line}`);
  return {
    path: c.path,
    line: c.line,
    severity: c.severity,
    confidence: "high",
    category: c.category ?? "correctness",
    text: c.text,
    quoted_line: quoted,
    ...(conclusion === undefined ? {} : { conclusion }),
  };
}

async function review(findings: ScriptedFinding[]) {
  const { dir, headSha } = pr307Repo();
  const { octokit, rec } = fakeOctokit();
  const server = modelServer({
    reply: (call) => {
      const shown = new Set(diffPaths(call));
      return changes(findings.filter((f) => shown.has(f.path)));
    },
  });
  const result = await runReview({
    inputs: baseInputs(),
    octokit,
    context: prContext(headSha),
    fetch: server.fetch,
    cwd: dir,
    now: () => 1_700_000_000_000,
  });
  return { result, rec };
}

describe("scenario 15 — PR #307 abstentions are never published", () => {
  it("publishes only the one real finding of the four the summary counted", async () => {
    const { result, rec } = await review(PR307_SUMMARY_IDS.map((id) => recorded(id)));

    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(1);
    const inline = inlineComments(rec);
    expect(inline.map((c) => `${c.path}:${c.line}`)).toEqual(["src/domains/memories/store.rs:158"]);
    const body = lastBody(rec);
    expect(body).toContain("### Findings (1)");
    expect(body).toContain("🟠 1 high");
    for (const id of PR307_SUMMARY_IDS.slice(1)) {
      expect(body).not.toContain(pr307Comment(id).text);
    }
  }, 30_000);

  it("settles approved when every finding is an abstention", async () => {
    const { result, rec } = await review(PR307_SUMMARY_IDS.slice(1).map((id) => recorded(id)));

    expect(result.verdict).toBe("approved");
    expect(result.findingsCount).toBe(0);
    expect(inlineComments(rec)).toHaveLength(0);
    expect(lastBody(rec)).toContain("### Findings (0)");
  }, 30_000);

  it("drops the real finding too once the model withdraws it with conclusion no_defect", async () => {
    const [mixed] = PR307_SUMMARY_IDS;
    const { result, rec } = await review([recorded(mixed, "no_defect")]);

    expect(result.verdict).toBe("approved");
    expect(inlineComments(rec)).toHaveLength(0);
  }, 30_000);
});
