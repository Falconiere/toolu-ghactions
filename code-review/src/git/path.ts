// path.ts — the ONE place that turns git's on-the-wire path spelling into a real
// path string. Git prints a path C-QUOTED (wrapped in `"` with backslash escapes)
// whenever it holds a character it cannot print literally; every other producer
// prints it raw. Two spellings of one path never compare equal, so a module that
// forgets to decode silently treats the file as a different file — which is how
// a non-ASCII path once fell out of the incremental review scope entirely.
//
// Decode at the BOUNDARY, once: every parse site that reads a path out of git
// output (`--name-only`, `--numstat`, `--name-status`, `diff --git`/`+++`/`---`
// and `rename from`/`rename to` headers, `diff-tree`) runs its result through
// {@link unquoteGitPath}, so from there inward a path is always the real string —
// the one the filesystem, the GitHub API, the coverage ledger, and the state
// marker all use.
//
// The reverse direction needs nothing: paths handed BACK to git are passed as
// argv entries through execFileSync, and git accepts a raw path argument. Only
// git's OUTPUT is ever quoted.

/** git's C-quote named escapes → the byte each stands for (`quote_c_style` in quote.c). */
const NAMED_ESCAPE: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  b: 0x08,
  f: 0x0c,
  a: 0x07,
  v: 0x0b,
};

/** A backslash escape: either an octal byte (`\303`, always 3 digits) or a single char. */
const ESCAPE = /\\(?:([0-7]{3})|([\s\S]))/g;

/**
 * Decode one path as git printed it: C-quoted (`"…"`) → the real string;
 * anything else → returned unchanged.
 *
 * A quoted path's interior mixes three things, all handled here:
 *   - octal escapes (`\346\227\245` → `日`), how git spells a non-ASCII byte
 *     under its default `core.quotepath=true`;
 *   - named escapes (`\"`, `\\`, `\t`, `\n`, …), how it spells a character that
 *     would otherwise end or confuse the quoted string — these are emitted even
 *     under `core.quotepath=false`, which is why decoding stays necessary;
 *   - RAW UTF-8 bytes, which is what `core.quotepath=false` leaves behind for
 *     non-ASCII inside a string that some OTHER character forced into quotes
 *     (`日本"x.txt` → `"日本\"x.txt"`).
 * Escapes decode to BYTES and literal runs are re-encoded as UTF-8 bytes, so a
 * multi-byte character survives whether git split it into octal escapes or not.
 * Decoding per JS char code instead would truncate `日` (U+65E5) to one byte.
 *
 * Detection is a plain `"…"` test, which cannot false-positive: a path whose own
 * name starts and ends with `"` contains `"`, so git always quotes it and it
 * arrives as `"\"x\""`, never as a bare `"x"`.
 *
 * Malformed input is preserved rather than dropped — a trailing lone backslash
 * (git never emits one) decodes to a literal backslash instead of vanishing.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);

  const bytes: number[] = [];
  let last = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(inner); m !== null; m = ESCAPE.exec(inner)) {
    pushUtf8(bytes, inner.slice(last, m.index));
    const octal = m[1];
    const named = m[2];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
    } else if (named !== undefined) {
      const code = NAMED_ESCAPE[named];
      // An escape git does not define stands for the character itself (`\z` → `z`).
      if (code === undefined) pushUtf8(bytes, named);
      else bytes.push(code);
    }
    last = m.index + m[0].length;
  }
  // A trailing lone backslash matches neither alternative and rides out here.
  pushUtf8(bytes, inner.slice(last));
  return Buffer.from(bytes).toString("utf8");
}

/** Append `text`'s UTF-8 bytes; correct for astral characters (surrogate pairs). */
function pushUtf8(bytes: number[], text: string): void {
  if (text === "") return;
  for (const byte of Buffer.from(text, "utf8")) bytes.push(byte);
}

/**
 * Decode a `---`/`+++` diff-header operand into a plain path: strip git's
 * trailing-tab separator, decode the quoting, then drop the `a/`/`b/` side
 * prefix. The prefix comes off LAST because the quoting wraps it too
 * (`"b/caf\303\251.ts"` → `b/café.ts` → `café.ts`). Returns `/dev/null`
 * unchanged, which callers test for to spot an add/delete side.
 */
export function headerOperandPath(operand: string): string {
  const untabbed = operand.split("\t")[0] ?? operand;
  const decoded = unquoteGitPath(untabbed);
  return decoded.startsWith("a/") || decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}
