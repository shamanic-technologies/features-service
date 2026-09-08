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

/**
 * A process-wide cap on how many operations may be IN FLIGHT at once, independent of how many
 * call sites are asking. `mapWithConcurrency` bounds ONE fan-out; this bounds a shared RESOURCE
 * across every fan-out at the same time — which is what a downstream's connection pool is.
 *
 * Fail-loud: a rejection propagates to its own caller and the slot is released either way.
 */
export interface SlotLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Test seam — how many operations hold a slot right now. */
  readonly inFlight: number;
}

export function createSlotLimiter(limit: number): SlotLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createSlotLimiter: limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  // The slot is HANDED OVER rather than released-then-reacquired: decrementing first would let a
  // caller arriving in the same tick take the slot the woken waiter was already promised, so the
  // cap would be exceeded by one under exactly the burst it exists to bound.
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    get inFlight() {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        // Woken with the slot already ours (see `release`), so `active` is not touched here.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
