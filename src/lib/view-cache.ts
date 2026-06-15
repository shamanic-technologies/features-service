import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";

/**
 * Gold serving layer — stale-while-revalidate read-through cache for expensive feature views.
 *
 * The authed dashboard endpoints (revenue / stats) compute their body by live-fanning-out to N
 * cold-starting siblings. That fan-out is the dashboard's latency. This wrapper serves the LAST
 * COMPUTED body from `feature_view_snapshots` (one O(1) indexed read) and recomputes a viewed cell
 * in the BACKGROUND ~once per TTL — so the slow fan-out happens once per refresh cycle, never on the
 * request path.
 *
 * Freshness model (per Richardson API-Composition→CQRS, Databricks Gold, Kleppmann derived-data):
 *   - fresh hit  (age < TTL)            → serve snapshot, no recompute.
 *   - stale hit  (age ≥ TTL)            → serve snapshot NOW + kick a single-flight background refresh.
 *   - miss       (never computed)       → compute live ONCE (blocking), persist, serve. Fail-loud: a
 *                                          compute error on miss propagates (the endpoint 502s as before).
 *
 * The snapshot is DERIVED + rebuildable — siblings stay source-of-truth; dropping every row is safe.
 * Eventual-consistency is the documented CQRS tradeoff: a served body is "as-of computedAt", at most
 * ~TTL + one-fan-out-duration stale. The revenue engine's decay is therefore as-of computedAt; with a
 * 5s TTL the drift is negligible against day-scale decay windows.
 *
 * The cache is an OPTIMISATION, never the source of truth: if the snapshot table is unreachable, we
 * log loudly and fall through to a live compute (correct answer, just slow) — NOT a silent swallow.
 */

const DEFAULT_TTL_MS = 5_000;

/** Max age of a refresh claim before another replica may steal it (a hung refresh must not wedge). */
const REFRESH_CLAIM_TTL_MS = 30_000;

export function viewCacheTtlMs(): number {
  const raw = process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

/** Operational kill-switch — cache is ON unless explicitly disabled (tests set "false"). */
function cacheEnabled(): boolean {
  return process.env.FEATURE_VIEW_CACHE_ENABLED !== "false";
}

interface CachedViewArgs<T> {
  /** Logical view family — "revenue" | "revenue-grouped" | "revenue-lens" | "stats". */
  view: string;
  /** Canonical key over ALL inputs that change the body (featureSlug + sorted query string). */
  scopeKey: string;
  orgId: string;
  /** Runs the live engine fan-out and returns the response body. */
  compute: () => Promise<T>;
}

/**
 * Serve `compute`'s result through the Gold snapshot cache. See module doc for the freshness model.
 */
export async function servedCached<T>({ view, scopeKey, orgId, compute }: CachedViewArgs<T>): Promise<T> {
  if (!cacheEnabled()) return compute();

  let row: typeof featureViewSnapshots.$inferSelect | undefined;
  try {
    [row] = await db
      .select()
      .from(featureViewSnapshots)
      .where(and(eq(featureViewSnapshots.view, view), eq(featureViewSnapshots.scopeKey, scopeKey)))
      .limit(1);
  } catch (err) {
    // Cache unreachable → fall through to the authoritative live compute (loud, not silent).
    console.error(`[features-service] view-cache read failed (computing live) view=${view}: ${(err as Error).message}`);
    return compute();
  }

  if (row) {
    const ageMs = Date.now() - new Date(row.computedAt).getTime();
    if (ageMs < viewCacheTtlMs()) {
      return row.body as T; // fresh hit
    }
    // Stale hit — serve immediately, refresh in the background (single-flight across replicas).
    void revalidate(view, scopeKey, orgId, compute);
    return row.body as T;
  }

  // Miss — compute live ONCE (fail-loud on error: propagate to the endpoint), then persist.
  const body = await compute();
  await upsertSnapshot(view, scopeKey, orgId, body).catch((err) => {
    console.error(`[features-service] view-cache miss-persist failed view=${view}: ${(err as Error).message}`);
  });
  return body;
}

/** Background refresh of one stale cell. Single-flight via a conditional claim; never throws. */
async function revalidate<T>(view: string, scopeKey: string, orgId: string, compute: () => Promise<T>): Promise<void> {
  try {
    const claimed = await claimRefresh(view, scopeKey);
    if (!claimed) return; // another request/replica is already refreshing this cell
    const body = await compute();
    await upsertSnapshot(view, scopeKey, orgId, body);
  } catch (err) {
    // Keep serving the stale body; release the claim so a later read can retry.
    console.error(`[features-service] view-cache revalidate failed (serving stale) view=${view}: ${(err as Error).message}`);
    await releaseRefresh(view, scopeKey).catch(() => {});
  }
}

/** Atomically claim the refresh slot. Returns true iff this caller won the single-flight race. */
async function claimRefresh(view: string, scopeKey: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - REFRESH_CLAIM_TTL_MS);
  const claimed = await db
    .update(featureViewSnapshots)
    .set({ refreshingAt: new Date() })
    .where(
      and(
        eq(featureViewSnapshots.view, view),
        eq(featureViewSnapshots.scopeKey, scopeKey),
        or(isNull(featureViewSnapshots.refreshingAt), lt(featureViewSnapshots.refreshingAt, cutoff)),
      ),
    )
    .returning({ id: featureViewSnapshots.id });
  return claimed.length > 0;
}

async function releaseRefresh(view: string, scopeKey: string): Promise<void> {
  await db
    .update(featureViewSnapshots)
    .set({ refreshingAt: null })
    .where(and(eq(featureViewSnapshots.view, view), eq(featureViewSnapshots.scopeKey, scopeKey)));
}

async function upsertSnapshot(view: string, scopeKey: string, orgId: string, body: unknown): Promise<void> {
  await db
    .insert(featureViewSnapshots)
    .values({ view, scopeKey, orgId, body, computedAt: new Date(), refreshingAt: null })
    .onConflictDoUpdate({
      target: [featureViewSnapshots.view, featureViewSnapshots.scopeKey],
      set: { body, orgId, computedAt: new Date(), refreshingAt: null },
    });
}

/**
 * Build a canonical cache scope key from the path slug + request query. Only query params change the
 * body (identity headers do not), so the key is `featureSlug|k=v&k=v` with params sorted for stability.
 */
export function buildScopeKey(featureSlug: string, query: Record<string, unknown>): string {
  const params: string[][] = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${featureSlug}|${new URLSearchParams(params).toString()}`;
}
