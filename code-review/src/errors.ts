// errors.ts — one shared, best-effort error-to-message helper. Consolidates the
// four byte-identical `errorMessage()` copies that lived in llm/openrouter.ts,
// github/label.ts, github/review.ts, and github/appToken.ts (the openrouter copy
// also unwrapped Error.cause — that fuller behavior is the one kept here).

/**
 * Always yield a non-empty, useful message for a thrown value.
 *
 * Some SDK/API errors carry an empty `.message` (e.g. an HTTP failure with a
 * non-JSON body); fall back through the error name, then the cause's message,
 * then `fallback` — never an empty string, so the caller's logs always say
 * something. A non-Error is `String()`-ed, with "[object Object]" rejected.
 *
 * @param err - the thrown value (Error, string, object, anything).
 * @param fallback - the message used when nothing usable can be extracted.
 */
export function errorMessage(err: unknown, fallback = "unknown error"): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const cause = err.cause;
    if (cause instanceof Error && cause.message) return `${err.name}: ${cause.message}`;
    if (err.name) return err.name;
  }
  const s = String(err);
  return s && s !== "[object Object]" ? s : fallback;
}
