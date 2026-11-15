// git/globs.ts — shared tracked-path glob matching for RULES_GLOB and EXCLUDE_GLOBS
// (reproduces bash `[[ "$p" == $entry ]]` semantics; extracted from rules.ts).

/** Split a glob input on commas and newlines, trimming each entry (drops blanks). */
export function splitGlobs(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

/**
 * Translate one tracked-path glob entry into a whole-path matcher. `*` matches any
 * run INCLUDING `/` and `?` matches one char; all else is literal — bash
 * `[[ "$p" == $entry ]]` semantics, NOT standard globbing, so `src/*.ts` also
 * matches `src/sub/deep.ts` and `dir/**` means everything under `dir/`. An entry
 * ending in `/` is a directory: `dir/` means `dir/*`. Shared with RULES_GLOB.
 */
export function globMatcher(entry: string): (p: string) => boolean {
  const glob = entry.endsWith("/") ? `${entry}*` : entry;
  return (p) => wildcardMatch(glob, p);
}

/**
 * Match `path` against `glob` by backtracking to the last `*` only. A compiled
 * `[\s\S]*` regex backtracks across EVERY star and goes cubic on deep paths
 * (`**` + `/*.snap` vs a 4 000-char path took ~20 s).
 */
function wildcardMatch(glob: string, path: string): boolean {
  let g = 0;
  let p = 0;
  let star = -1;
  let resume = 0;
  while (p < path.length) {
    if (glob[g] === "*") {
      star = g++;
      resume = p;
    } else if (g < glob.length && (glob[g] === "?" || glob[g] === path[p])) {
      g++;
      p++;
    } else if (star !== -1) {
      g = star + 1;
      p = ++resume;
    } else {
      return false;
    }
  }
  while (glob[g] === "*") g++;
  return g === glob.length;
}

/** True if `path` matches ANY of the glob entries. */
export function anyGlobMatches(globs: readonly string[], path: string): boolean {
  return globs.some((g) => globMatcher(g)(path));
}
