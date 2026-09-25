/**
 * A slow-moving VALUE reused across the refreshes of interactive views (features-service#1045).
 *
 * Inside a `servedCached` view compute, `memoizeInteractive(key, ttlMs, compute)` answers from the
 * last successful value for `ttlMs`, then serves that value (up to twice as old) while ONE background
 * compute replaces it — so a view refreshing every few seconds never waits on, nor re-asks, an input
 * that moves on the scale of minutes (an audience's member list). Outside a view compute it is a
 * plain call (as it is with `DOWNSTREAM_READ_SHARE_MS=0`). A failed compute is never cached: the error propagates when nothing may be served, and
 * is logged loudly (the previous value kept) when a background re-read fails.
 */
import { insideInteractiveView } from "./lead-copy.js";

interface Entry {
  at: number;
  value?: unknown;
  pending?: Promise<unknown>;
  refreshing: boolean;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 2_000;

/** Test seam. */
export function __resetInteractiveMemo(): void {
  entries.clear();
}

export async function memoizeInteractive<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  // `DOWNSTREAM_READ_SHARE_MS=0` switches every cross-refresh reuse off (the test suites do).
  if (!insideInteractiveView() || ttlMs <= 0 || process.env.DOWNSTREAM_READ_SHARE_MS === "0") return compute();
  const now = Date.now();
  const entry = entries.get(key);

  if (entry && "value" in entry && entry.pending === undefined) {
    const age = now - entry.at;
    if (age <= ttlMs) return entry.value as T;
    if (age <= 2 * ttlMs) {
      if (!entry.refreshing) {
        entry.refreshing = true;
        compute().then(
          (value) => entries.set(key, { at: Date.now(), value, refreshing: false }),
          (err) => {
            console.error(`[features-service] interactive re-read of ${key} failed (serving the previous value): ${(err as Error).message}`);
            entry.refreshing = false;
          },
        );
      }
      return entry.value as T;
    }
  }
  if (entry?.pending) return entry.pending as Promise<T>;

  const pending = compute();
  entries.set(key, { at: now, pending, refreshing: false });
  try {
    const value = await pending;
    entries.set(key, { at: Date.now(), value, refreshing: false });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return value;
  } catch (err) {
    if (entries.get(key)?.pending === pending) entries.delete(key);
    throw err;
  }
}
