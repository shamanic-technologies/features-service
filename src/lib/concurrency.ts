/**
 * Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result. Used to cap cross-service fan-outs (per-brand / per-dynasty) so a large
 * item set does not burst hundreds of simultaneous sockets at cold-Neon siblings. Fail-loud: any worker
 * rejection propagates out (the same as `Promise.all`).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
