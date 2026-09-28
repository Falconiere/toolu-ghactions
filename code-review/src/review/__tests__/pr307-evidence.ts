// pr307-evidence.ts — loader for the recorded Falconiere/comemory PR #307 review
// comments (fixtures/pr307-abstentions.json): every top-level code-review@v8 inline
// finding the PR collected, verbatim, each labelled `drop` when its own text
// concludes there is no defect. Shared by the self-negation, validation, schema and
// pipeline replay tests so they all judge the same real bodies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

const Pr307Comment = z.object({
  id: z.number(),
  path: z.string(),
  line: z.number(),
  severity: z.enum(["blocker", "high", "medium", "low", "nit"]),
  category: z.string().nullable(),
  expected: z.enum(["drop", "keep"]),
  text: z.string(),
});

/** One recorded PR #307 inline finding. */
export type Pr307Comment = z.infer<typeof Pr307Comment>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const PR307 = z
  .object({
    source: z.record(z.record(z.string())),
    comments: z.array(Pr307Comment),
  })
  .parse(JSON.parse(readFileSync(join(TEST_DIR, "fixtures", "pr307-abstentions.json"), "utf8")));

/** All 71 recorded comments, in the order GitHub returned them. */
export const PR307_COMMENTS: readonly Pr307Comment[] = PR307.comments;

/** Post-change source text (path → line → text) at the reviewed commit, for the four
 *  findings the latest summary comment published. */
export const PR307_SOURCE: Readonly<Record<string, Readonly<Record<string, string>>>> =
  PR307.source;

/** The four findings summary comment 5857256243 published: one mixed body
 *  (`store.rs:158`) and three that conclude there is no defect. */
export const PR307_SUMMARY_IDS = [4117024334, 4117024341, 4117024344, 4117024346] as const;

/** The recorded comment with GitHub id `id`; throws when the fixture lacks it. */
export function pr307Comment(id: number): Pr307Comment {
  const comment = PR307_COMMENTS.find((entry) => entry.id === id);
  if (comment === undefined) throw new Error(`missing recorded PR 307 comment ${id}`);
  return comment;
}
