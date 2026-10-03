/**
 * A served figure must not depend on uptime. A boot-warmed in-memory store (built AFTER listen(), in the
 * background) is empty for the minutes its first build takes; a read in that window must not answer as if
 * nothing were measured (2026-10-03: right after every deploy, `/offers/:id/sales-paths` priced the
 * ai-meeting-booking leg at its $5 seeded default instead of the fleet-measured $1.41 for ~2.5 minutes).
 *
 * So a read that finds the store EMPTY awaits the in-flight build, bounded by `waitMs`. Still empty after
 * that (build slower than the bound, or failed) → `StoreNotComputedError`, which the route turns into a
 * visible 503 (`reason: "<what>_not_computed_yet"`), never a silent default. Once a value exists it is
 * served at once (a stale value is still a measurement; the caller kicks the background refresh).
 *
 * Pure (no `@/` imports), so it carries a real unit test (`await-warm-store.test.ts`).
 */
export class StoreNotComputedError extends Error {
  constructor(
    readonly what: string,
    readonly waitedMs: number,
  ) {
    super(`${what} not computed yet: the first build after boot had not finished after ${Math.round(waitedMs / 1000)}s`);
    this.name = "StoreNotComputedError";
  }
}

export async function awaitWarmStore<T>(
  read: () => T | null | undefined,
  warm: () => Promise<void>,
  waitMs: number,
  what: string,
): Promise<T> {
  const ready = read();
  if (ready !== null && ready !== undefined) return ready;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
    timer.unref?.();
  });
  try {
    await Promise.race([warm().catch(() => undefined), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const built = read();
  if (built === null || built === undefined) throw new StoreNotComputedError(what, waitMs);
  return built;
}
