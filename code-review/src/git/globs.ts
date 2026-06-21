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
 * Translate one tracked-path glob entry into a matcher. `dir/**` and `dir/` are
 * prefix matches (everything under dir/); anything else is a shell-style glob
 * where `*` matches any run including `/` and `?` matches one char — reproducing
 * bash `[[ "$p" == $entry ]]` against tracked paths.
 */
export function globMatcher(entry: string): (p: string) => boolean {
  if (entry.endsWith("/**")) {
    const prefix = entry.slice(0, -2); // drop the "**", keep the trailing "/"
    return (p) => p.startsWith(prefix);
  }
  if (entry.endsWith("/")) {
    return (p) => p.startsWith(entry);
  }
  const re = globToRegExp(entry);
  return (p) => re.test(p);
}

/**
 * Compile a shell glob to an anchored RegExp; all else is literal. NOTE: `*` matches any
 * run INCLUDING `/` (and `?` any single char) — bash `[[ "$p" == $entry ]]` semantics, NOT
 * standard globbing. So `src/*.ts` also matches `src/sub/deep.ts`. This is intentional and
 * shared with RULES_GLOB; for a single path segment use an explicit prefix like `src/` or
 * a suffix like `*.ts`.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** True if `path` matches ANY of the glob entries. */
export function anyGlobMatches(globs: readonly string[], path: string): boolean {
  return globs.some((g) => globMatcher(g)(path));
}
