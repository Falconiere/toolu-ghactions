// concurrency.ts — run an async mapper over many items with a bounded number of
// calls in flight, returning results in INPUT order. Used to review diff chunks
// in parallel without firing N provider calls at once (OpenRouter rate limits)
// and without the non-determinism a completion-ordered result would bring.

/**
 * Map `fn` over `items` with at most `limit` concurrent calls, returning results
 * in the SAME order as `items` (not completion order). `limit` is clamped to ≥ 1.
 * Rejections propagate (the first rejection rejects the whole call); callers pass
 * a total `fn` — e.g. reviewWithModel, which abstains instead of throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const max = Math.max(1, Math.floor(limit));
  // Single-threaded JS: `cursor++` reads then increments with no await between,
  // so two workers never claim the same index.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  };
  const count = Math.min(max, items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}
