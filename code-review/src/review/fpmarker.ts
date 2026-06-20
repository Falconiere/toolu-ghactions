// review/fpmarker.ts — a hidden fingerprint marker embedded in every inline review
// comment the bot posts. It lets a later run recognise ITS OWN earlier finding on a
// live PR review thread (to dedup, reply in place, or resolve) without fuzzy-parsing
// the rendered markdown. The marker carries the finding fingerprint from state.ts
// (path+category+normtext sha1 — see {@link fingerprint}), so a thread's first
// comment maps back to a stable finding identity that tolerates line drift.
//
// Format: an HTML comment GitHub renders invisibly, so it never shows to humans but
// survives verbatim in the comment body the API returns on the next run.

/** The hidden marker carrying a finding's fingerprint, appended to an inline comment body. */
export function appendFpMarker(body: string, fp: string): string {
  return `${body}\n\n<!-- toolu-fp:${fp} -->`;
}

/** Extract the fingerprint from a comment body, or null when the marker is absent
 *  (e.g. a human-authored review thread, which the bot must not manage). */
export function extractFpMarker(body: string): string | null {
  const m = body.match(/<!-- toolu-fp:([0-9a-f]+) -->/);
  return m?.[1] ?? null;
}
