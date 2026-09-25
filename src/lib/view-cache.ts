import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { withLiveLeadCopy } from "./lead-copy.js";

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
 *   - too stale  (age ≥ hard max age)   → compute live ONCE (blocking), persist, serve.
 *   - miss       (never computed)       → compute live ONCE (blocking), persist, serve. Fail-loud: a
 *                                          compute error on miss/too-stale propagates (502 as before).
 *
 * The snapshot is DERIVED + rebuildable — siblings stay source-of-truth; dropping every row is safe.
 * Eventual-consistency is the documented CQRS tradeoff: a served body is "as-of computedAt", at most
 * hard-max-age stale.
 *
 * The cache is an OPTIMISATION, never the source of truth: if the snapshot table is unreachable, we
 * log loudly and fall through to a live compute (correct answer, just slow) — NOT a silent swallow.
 */

/**
 * FRESH window — how long a snapshot is served with NO background refresh. This, not `maxStale`, is
 * what governs how often the expensive fan-out actually re-runs: past the TTL every read still serves
 * instantly but ALSO kicks one background revalidation (single-flighted across replicas).
 *
 * 30s pairs with the dashboard's 15s poll: the poll at t=15s is a fresh hit (no work), the poll at
 * t≥30s triggers one refresh — so the fan-out runs at most ~once per 30s per VIEWED cell, the same
 * effective rate as the old 5s-TTL/30s-poll pairing. Dropping the TTL to 5s while polling at 15s would
 * make EVERY poll trigger the fan-out and double the load on the Neon-backed siblings.
 */
const DEFAULT_TTL_MS = 30_000;

/**
 * A CAMPAIGN's Overview views refresh on every poll (features-service#1045). With the live lead copy,
 * the past/today cost split and the shared reads, one refresh of the busiest campaign costs ~1-3s and
 * a fraction of the downstream reads it used to, so these views go stale after
 * {@link campaignLiveTtlMs} (3s by default, under the dashboard's 5s poll) instead of 30s: each poll
 * kicks one background refresh (still single-flight, still only for a cell somebody reads), and a new
 * send, reply or cost reaches the served body within about one refresh plus one poll.
 *
 * Scoped to a campaign, except `pipeline-activity`, whose cell is keyed on the brand and is the
 * Overview's chart whichever campaign page polls it. Every other view keeps {@link DEFAULT_TTL_MS}.
 */
const CAMPAIGN_LIVE_VIEWS = new Set(["revenue", "stats", "audience-stats", "workflow-projection-evidence"]);
const ALWAYS_LIVE_VIEWS = new Set(["pipeline-activity"]);
const DEFAULT_CAMPAIGN_LIVE_TTL_MS = 3_000;

export function campaignLiveTtlMs(): number {
  const raw = process.env.CAMPAIGN_VIEW_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_CAMPAIGN_LIVE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAMPAIGN_LIVE_TTL_MS;
}

/** The TTL a view cell takes when its caller names none. */
export function defaultTtlFor(view: string, scopeKey: string): number {
  if (ALWAYS_LIVE_VIEWS.has(view)) return campaignLiveTtlMs();
  if (CAMPAIGN_LIVE_VIEWS.has(view) && /(^|[|&])campaign(Id)?=/.test(scopeKey)) return campaignLiveTtlMs();
  return viewCacheTtlMs();
}

/**
 * HARD stale cap — there is none by default: a snapshot is served for as long as it is RETAINED.
 *
 * Beyond `maxStaleMs` a read stops serving the snapshot and recomputes SYNCHRONOUSLY, making the
 * caller wait for the full cross-service fan-out. That branch is only worth having when the fan-out is
 * cheap, and it is not: measured in prod 2026-09-24 on campaign `f7b1b610…` (brand `75d7e3e8…`), an
 * uncached compute costs 24s (`/stats?campaignId=`), 24s (`/audience-stats`), 24s (`/pipeline-activity`),
 * 34s (`/revenue`) and 44s (`/workflow-projection`), against 50-200ms for a snapshot hit. The time is
 * almost all WAITING on siblings (a CPU profile of the `/stats` compute was 90% idle): human-service
 * `GET /orgs/audiences` answers in 15-40s, runs-service's cost aggregations in 2-12s, and lead-service's
 * `/orgs/leads` walk ships ~70 MB over four sequential pages in 20-30s.
 *
 * With a 30-minute cap that cost landed on the customer: a dashboard is visited about once a day, so
 * 309 of 328 stored snapshots (94%) sat past the cap at any given moment, and the FIRST page of every
 * session recomputed every view on the request path — the 40-70s LCP the dashboard's web vitals
 * reported, with later pages in the same session answering in 1-3s because by then they were fresh.
 *
 * So the snapshot is now served whatever its age (up to `viewCacheRetentionMs()`, past which it has been
 * pruned and the read is a miss) and refreshed in the BACKGROUND; the dashboard's 15s poll picks up the
 * fresh body within one refresh cycle. This moves the refresh off the request path, it does not make
 * steady-state data staler. It is also exactly what the dashboard already does client-side
 * (`persist-cache.ts` paints last-known content from IndexedDB first, `maxAge: Infinity`), so the
 * backend blocking to look "fresh" was fighting the front end — and still only protected the ONE browser
 * that had a local copy.
 *
 * Staleness of ECONOMICS-dependent bodies is handled by the cache KEY, not this cap: the economics-driven
 * views fold `economicsFingerprint()` into their `scopeKey`, so an economics write changes the cell and
 * forces a fresh compute regardless of age (see `sales-economics-client.economicsFingerprint`). A view
 * that genuinely must never serve old data may still pass its own `maxStaleMs`.
 */
function defaultMaxStaleMs(): number {
  return viewCacheRetentionMs();
}

/**
 * Platform / fleet scope for a GLOBAL (org-less) view — a cross-org internal audit (e.g. the
 * customer-health board) has no per-org `scope_key`. The snapshot row's `org_id` column is `NOT NULL`
 * uuid for bookkeeping only; it is never forwarded to a sibling service, so a nil-UUID is the correct
 * platform sentinel (mirrors how any org-less internal stat keys its own Gold row). Using it avoids a
 * migration to make `org_id` nullable (which drizzle-kit would re-emit spurious `features` drops around
 * — see CLAUDE.md migration gotcha).
 */
export const PLATFORM_SCOPE_ORG_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Max age of a refresh claim before another reader may steal it (a hung refresh must not wedge).
 *
 * Must exceed the slowest REAL refresh, or the claim expires mid-compute and the next stale read starts a
 * second identical fan-out beside the first — doubling load on exactly the siblings that made it slow.
 * Measured uncached computes run 24-44s (and up to ~70s under a page-open burst), so 30s was inside the
 * window; 3 minutes is not.
 */
const REFRESH_CLAIM_TTL_MS = 3 * 60_000;

/**
 * RETENTION — a snapshot untouched for this long is deleted.
 *
 * `computed_at` only ever advances when a cell is READ (miss, too-stale, or background revalidate all
 * go through `upsertSnapshot`), so its age is exactly "time since anyone last looked at this cell".
 * A cell nobody has opened in a week is dead weight: deleting it costs one live compute if it is ever
 * read again, which is the miss path that already exists and is already correct.
 *
 * This is what keeps the Gold table from growing without bound as scope keys churn. Every input that
 * changes a body is folded into `scope_key` — query params, `pricing`, `timezone`, and (for the
 * economics-driven views) the economics fingerprint — so a single brand legitimately mints a NEW cell
 * every time any of those move, and the superseded ones are orphaned by construction, never read again,
 * never overwritten. Measured on prod 2026-07-31: `revenue` held 326 cells / 36 MB of which only 68 had
 * been touched in 24h, plus 91 fully orphaned `workflow-projection` cells left behind by the
 * evidence/projection split. Retired VIEWS age out under the same rule, so this needs no list of live
 * view names to maintain (such a list would rot the moment a view is renamed).
 *
 * Safe by the same argument as the rest of the layer: the snapshot is DERIVED and rebuildable, siblings
 * stay source-of-truth, and dropping every row is correct-but-slow rather than wrong.
 */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * How often the prune sweep may run in one process. The sweep piggybacks on write traffic rather than a
 * timer: a `setInterval` would keep the Neon compute awake around the clock for a table that only needs
 * touching once a day, which is the opposite of what we want on a scale-to-zero project.
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;

const inFlightComputes = new Map<string, Promise<unknown>>();

/** Epoch ms of the last prune attempt in THIS process. 0 = never; the first persist after boot sweeps. */
let lastPruneAt = 0;

export function viewCacheTtlMs(): number {
  const raw = process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

export function viewCacheRetentionMs(): number {
  const raw = process.env.FEATURE_VIEW_SNAPSHOT_RETENTION_MS;
  if (!raw) return DEFAULT_RETENTION_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_MS;
}

/** Test seam — forget that this process has already pruned. */
export function __resetViewCachePruneState(): void {
  lastPruneAt = 0;
}

/** Operational kill-switch — cache is ON unless explicitly disabled (tests set "false"). */
function cacheEnabled(): boolean {
  return process.env.FEATURE_VIEW_CACHE_ENABLED !== "false";
}

interface CachedViewArgs<T> {
  /** Logical view family — "revenue" | "revenue-grouped" | "revenue-lens" | "stats" | "customer-health". */
  view: string;
  /** Canonical key over ALL inputs that change the body (featureSlug + sorted query string). */
  scopeKey: string;
  orgId: string;
  /**
   * Per-view FRESH window override (ms). Omit to use the global `FEATURE_VIEW_SNAPSHOT_TTL_MS` (5s
   * default) — right for a per-request dashboard cell. A HEAVY cross-org FLEET board (customer-health)
   * that changes slowly wants a minutes-scale window so it does NOT re-fan-out every few seconds.
   */
  ttlMs?: number;
  /**
   * Per-view HARD-MAX-STALE override (ms). Beyond this age a read recomputes SYNCHRONOUSLY (blocking)
   * rather than serving too-old data. Omit to serve any retained snapshot (see `defaultMaxStaleMs`).
   */
  maxStaleMs?: number;
  /** Runs the live engine fan-out and returns the response body. */
  compute: () => Promise<T>;
}

/**
 * Serve `compute`'s result through the Gold snapshot cache. See module doc for the freshness model.
 */
export async function servedCached<T>({ view, scopeKey, orgId, ttlMs, maxStaleMs, compute: rawCompute }: CachedViewArgs<T>): Promise<T> {
  // Every view compute reads leads through the live copy (lib/lead-copy.ts): these are the views a
  // customer polls, which is exactly the population the change feed exists for.
  const compute = () => withLiveLeadCopy(rawCompute);
  if (!cacheEnabled()) return compute();
  const ttl = ttlMs ?? defaultTtlFor(view, scopeKey);
  const maxStale = maxStaleMs ?? defaultMaxStaleMs();

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
    if (ageMs < ttl) {
      return row.body as T; // fresh hit
    }
    if (ageMs >= maxStale) {
      return computeAndPersistSingleFlight(view, scopeKey, orgId, compute);
    }
    // Stale hit — serve immediately, refresh in the background (single-flight across replicas).
    void revalidate(view, scopeKey, orgId, compute);
    return row.body as T;
  }

  // Miss — compute live ONCE (fail-loud on error: propagate to the endpoint), then persist.
  return computeAndPersistSingleFlight(view, scopeKey, orgId, compute);
}

async function computeAndPersistSingleFlight<T>(
  view: string,
  scopeKey: string,
  orgId: string,
  compute: () => Promise<T>,
): Promise<T> {
  const key = `${view}\0${scopeKey}`;
  const existing = inFlightComputes.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    const body = await compute();
    await upsertSnapshot(view, scopeKey, orgId, body).catch((err) => {
      console.error(`[features-service] view-cache persist failed view=${view}: ${(err as Error).message}`);
    });
    return body;
  })();

  inFlightComputes.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlightComputes.get(key) === promise) {
      inFlightComputes.delete(key);
    }
  }
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
  void maybePruneStaleSnapshots();
}

/**
 * Delete snapshots nobody has read in `viewCacheRetentionMs()`, at most once per `PRUNE_INTERVAL_MS` per
 * process. Fire-and-forget off a persist that already succeeded, so it never sits between the caller and
 * their body.
 *
 * A failure here is logged and dropped ON PURPOSE, and that is not the swallowed-error the fail-loud rule
 * forbids: pruning is pure housekeeping on a derived table, it produces no value any caller reads, and
 * the only consequence of it never running is a larger table. Propagating would turn a janitorial problem
 * into a 502 on a request whose answer was already computed correctly.
 */
async function maybePruneStaleSnapshots(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now; // claim BEFORE awaiting, so concurrent persists don't each start a sweep
  try {
    const deleted = await db
      .delete(featureViewSnapshots)
      .where(lt(featureViewSnapshots.computedAt, new Date(now - viewCacheRetentionMs())))
      .returning({ id: featureViewSnapshots.id });
    if (deleted.length > 0) {
      console.log(`[features-service] view-cache pruned ${deleted.length} snapshot(s) unread for over the retention window`);
    }
  } catch (err) {
    console.error(`[features-service] view-cache prune failed (table keeps growing): ${(err as Error).message}`);
  }
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
