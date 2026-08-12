import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature } from "../db/schema.js";
import { STATS_REGISTRY } from "../lib/stats-registry.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchDynastySpendByDay,
  fetchPublicWorkflowEngagementLatency,
  fetchPublicJournalistsStats,
  fetchBrandInfoBatch,
  type WorkflowMetadata,
  type EngagementLatencyMetric,
} from "../lib/public-stats-clients.js";
import { getFunnel, type SalesEconomics } from "../lib/funnel-registry.js";
import { projectedCostPerOutcome } from "../lib/cost-engine.js";
import {
  buildObjectiveAverages,
  buildBucketedLifetimeAverages,
  buildCostPerOutcomeTrend,
  buildCostPerOutcomeDistribution,
  buildWorkflowCostPerOutcome,
  recentWindowCostPerOutcome,
  windowBaseOutcome,
  fetchFleetBrandEconomics,
  fetchFunnelBucketDataset,
  bucketBrandsForObjective,
  mergeSpendByDay,
  mergeOutcomesByDay,
  meanFleetEconomics,
  normalizeObjective,
  type ObjectiveAverages,
  type TrendPoint,
  type DayOutcome,
  type CostPerOutcomeDistribution,
  type BucketedBrand,
  type WorkflowCostRow,
  type WorkflowGrainInput,
} from "../lib/cross-org-cost-per-outcome.js";
import { fetchFeatureMemberships } from "../lib/feature-memberships-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { fetchFleetEmailsSentByDay, fetchFleetSendingForecast } from "../lib/send-forecast-client.js";
import { aggregateFleetNewSequences } from "../lib/send-forecast-aggregate.js";
import {
  buildSendForecast,
  coldEmailOutreachSlugs,
  utcDateRange,
  addUtcDays,
  type SendForecastDay,
  type SendForecastSummary,
} from "../lib/send-forecast-compute.js";
import { buildAccountsAudit, type AccountsAudit } from "../lib/accounts-compute.js";
import { buildCustomerHealthBoard, type CustomerHealthBoard } from "../lib/customer-health-compute.js";
import { buildActiveUsersHistory, type ActiveUsersHistory } from "../lib/active-users-compute.js";
import { buildRevenueHistory, type RevenueHistory } from "../lib/revenue-history-compute.js";
import { buildActiveUsersByUser, type ActiveUsersByUser } from "../lib/active-users-by-user-compute.js";
import { apiKeyOnly } from "../middleware/auth.js";
import { BrandOwnershipError, fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { computeFeatureRevenue, buildCostEconomics, type DownstreamHeaders } from "./revenue.js";
import { servedCached, PLATFORM_SCOPE_ORG_ID } from "../lib/view-cache.js";

const router = Router();

// ── The ONE cross-org memo primitive: stale-while-revalidate, per-surface windows ───────────────────
//
// Shared by EVERY cross-org /public/* + /internal/stats/* endpoint (these have no per-org scope_key, so
// they don't use the Gold `feature_view_snapshots` layer). Every cache is a `PublicCache` (uniform shape)
// and every read goes through `servedPublicCached` — the caller names the payload type via <T>.
//
// TWO windows per entry, doing DIFFERENT jobs — read them as a pair, tuning one alone regresses the other
// (the same split the Gold layer documents in `view-cache.ts`, for the same reasons):
//   • FRESH — inside it a read serves the entry and does NO work. So FRESH is what governs how often the
//     expensive cross-service fan-out actually RE-RUNS: once per fresh window per VIEWED key. A key
//     nobody reads never refreshes at all.
//   • STALE — past FRESH the entry is STILL served instantly, and a single-flight refresh runs BEHIND the
//     response. Only past STALE (or on a genuinely cold key) does a reader wait for the fan-out.
// So no caller ever blocks while a previous value exists, and an actively-read key is never more than one
// refresh cycle behind — lengthening FRESH cuts call count without making a reader stare at an old number
// for longer than that cycle.
interface CacheWindows {
  /** Serve with zero work inside this window — i.e. how often the fan-out re-runs for a VIEWED key. */
  freshMs: number;
  /** Past FRESH: still served instantly + refreshed behind the request. Past STALE: the reader waits. */
  staleMs: number;
}

/**
 * Cross-org COST surfaces (`/public/stats/{ranked,best,revenue,cost-projection,cost-per-outcome-*,
 * workflow-cost-per-outcome,best-model-cost-per-outcome-trend}` + the shared goal-bucket dataset).
 *
 * Every figure on these is a FLEET-LIFETIME aggregate — cross-org totals over ALL history — and each miss
 * costs runs-service one of three unbounded ledger scans measured at 11-14 s (runs-service#206). At the
 * historical 60 s window that scan re-ran every minute per replica, for numbers that cannot visibly move
 * in a minute: a lifetime pooled cost moves by the fleet's few minutes of spend against months of it, i.e.
 * below the rounding of what the staff analytics page and the public landing render.
 *
 * FRESH 15 min is therefore the honest freshness of the underlying quantity, not a compromise: it cuts
 * runs-service scans on these surfaces by ~15x and nothing observable changes. STALE 6 h is sized for the
 * LOW-TRAFFIC public landing — reads there come in bursts with long gaps, and the alternative for the
 * first visitor after a quiet night is a ~13 s cold build on the request path (the #547 residual). A
 * 6-hour-old lifetime "going rate" is still a truthful one, and that visitor's own read refreshes it
 * behind them, so the next reader is current. A key read more often than every 6 h stays warm forever.
 */
const LIFETIME_AGGREGATE_WINDOWS: CacheWindows = { freshMs: 15 * 60_000, staleMs: 6 * 60 * 60_000 };

/**
 * Fleet AUDIT surfaces (`/internal/stats/{send-forecast,accounts,active-users,active-users-by-user,
 * revenue}` + the workflow engagement-latency public read).
 *
 * These describe MUTABLE operational state a staff member acts on and then re-reads — a budget change, a
 * brand pause, an account going active. FRESH stays at the historical 60 s on purpose: they are not the
 * surfaces runs-service#206 measured, and buying call-count here would be paid for in "I changed it and
 * the audit still shows the old value". They gain only the STALE half — a read past 60 s is now served
 * instantly off the last value and refreshed behind the request instead of blocking on the fleet fan-out.
 */
const FLEET_AUDIT_WINDOWS: CacheWindows = { freshMs: 60_000, staleMs: 30 * 60_000 };

type PublicCache = Map<string, { payload: unknown; freshUntil: number; staleUntil: number }>;

// Single-flight guard, per (cache, key). Load-bearing on a COLD key: the admin page loads several of these
// surfaces AT ONCE and several of them share one O(brands) fan-out, so without it every concurrent miss
// runs its own fan-out and stampedes the (Neon-backed, cold-start-sensitive) siblings. It ALSO guards the
// background refresh, so a burst of stale reads kicks exactly one rebuild. Keyed off the cache object so
// each surface gets its own map and no surface can block another.
const publicCacheInFlight = new WeakMap<PublicCache, Map<string, Promise<unknown>>>();

function inFlightFor(cache: PublicCache): Map<string, Promise<unknown>> {
  let flights = publicCacheInFlight.get(cache);
  if (!flights) {
    flights = new Map();
    publicCacheInFlight.set(cache, flights);
  }
  return flights;
}

function setPublicCache<T>(cache: PublicCache, key: string, payload: T, windows: CacheWindows): void {
  const now = Date.now();
  // Prune on write: a past-STALE entry is never served again, and these maps are keyed by
  // (featureSlug × objective × window params) on NO-AUTH routes — so without this an arbitrary caller
  // could mint unbounded keys that each pin a payload for the (now much longer) stale window.
  for (const [existingKey, entry] of cache) {
    if (entry.staleUntil <= now) cache.delete(existingKey);
  }
  cache.set(key, { payload, freshUntil: now + windows.freshMs, staleUntil: now + windows.staleMs });
}

/** Run `compute` ONCE per (cache, key) at a time and store the result. Concurrent callers — a request-path
 *  cold read and a background revalidation alike — join the one in-flight promise. The slot is cleared on
 *  settle (success OR failure) so a later read retries and a failure still propagates to every joiner. */
function refreshPublicCache<T>(
  cache: PublicCache,
  key: string,
  windows: CacheWindows,
  compute: () => Promise<T>,
): Promise<T> {
  const flights = inFlightFor(cache);
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const flight = (async () => {
    try {
      const payload = await compute();
      setPublicCache(cache, key, payload, windows);
      return payload;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight;
}

/**
 * Serve a cross-org surface through the two-window cache: fresh hit → the entry, no work; stale hit → the
 * entry INSTANTLY plus a single-flight background refresh; cold (or past STALE) → the single-flight
 * compute, awaited, FAIL-LOUD (a compute error propagates → the route 502s; nothing is ever fabricated).
 * A failed BACKGROUND refresh keeps the prior entry — it never zeroes real cached data — and is logged
 * loud; the next read retries it.
 */
async function servedPublicCached<T>(opts: {
  cache: PublicCache;
  key: string;
  windows: CacheWindows;
  /** Surface name for the background-refresh failure log. */
  label: string;
  compute: () => Promise<T>;
}): Promise<T> {
  const { cache, key, windows, label, compute } = opts;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && entry.freshUntil > now) return entry.payload as T;
  if (entry && entry.staleUntil > now) {
    if (!inFlightFor(cache).has(key)) {
      refreshPublicCache(cache, key, windows, compute).catch((error) => {
        console.error(`[features-service] ${label} background refresh failed (${key}):`, error);
      });
    }
    return entry.payload as T;
  }
  return refreshPublicCache(cache, key, windows, compute);
}

/** Test seam helper — drop every entry AND every in-flight build for one surface. */
function clearPublicCache(cache: PublicCache): void {
  cache.clear();
  inFlightFor(cache).clear();
}

/** Test seam helper — expire ONLY the FRESH window of every entry (keeping the payload + stale window), to
 *  assert a past-fresh read is served instantly off the last-known value and refreshes behind the request. */
function expirePublicCacheFreshWindow(cache: PublicCache): void {
  for (const [key, entry] of cache) cache.set(key, { ...entry, freshUntil: 0 });
}

/** Test seam helper — await any in-flight (re)build for one surface so a follow-up read is deterministic. */
async function awaitPublicCacheRefresh(cache: PublicCache): Promise<void> {
  await Promise.allSettled([...inFlightFor(cache).values()]);
}

/** Every cross-org cache in this module, for the whole-module test seams below. */
function allPublicCaches(): PublicCache[] {
  return [
    publicRankedCache,
    publicBestCache,
    publicWorkflowLatencyCache,
    goalBucketDatasetCache,
    revenueCache,
    costProjectionCache,
    costPerOutcomeTrendCache,
    workflowCostPerOutcomeCache,
    bestModelCostPerOutcomeTrendCache,
    costPerOutcomeLifetimeCache,
    costPerOutcomeDistributionCache,
    sendForecastCache,
    accountsCache,
    activeUsersCache,
    activeUsersByUserCache,
    revenueHistoryCache,
  ];
}

/** Test seam — expire ONLY the FRESH window on EVERY cross-org cache (payloads + stale windows kept), so a
 * test can drive the stale-while-revalidate path without waiting out a real fresh window. */
export function __expirePublicCacheFreshWindowsForTest(): void {
  for (const cache of allPublicCaches()) expirePublicCacheFreshWindow(cache);
}

/** Test seam — await every in-flight background refresh across the cross-org caches. */
export async function __awaitPublicCacheRefreshForTest(): Promise<void> {
  await Promise.allSettled(allPublicCaches().map((cache) => awaitPublicCacheRefresh(cache)));
}

const publicRankedCache: PublicCache = new Map();
const publicBestCache: PublicCache = new Map();
const publicWorkflowLatencyCache: PublicCache = new Map();

/** Test seam — reset the in-memory public stats caches. */
export function __resetPublicStatsCache(): void {
  clearPublicCache(publicRankedCache);
  clearPublicCache(publicBestCache);
  clearPublicCache(publicWorkflowLatencyCache);
}

/** Race a promise against a timeout that REJECTS after `ms` — bounds a per-item async op so a single
 * stalled call can't leave the batch's `Promise.all` pending forever. The timer is cleared on settle so
 * it never keeps the event loop alive. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The goal-bucketed per-brand dataset (spend + outcomes + goal + economics per brand) is objective-
// INDEPENDENT and expensive (one O(brands) cross-service fan-out, ~13s cold), so the trend (per-objective)
// + lifetime + distribution surfaces share ONE copy through the two-window cache above. Its windows are
// the LIFETIME ones: the dataset is all-history pooled spend/outcomes per brand, so a 15-minute-old copy
// is the same copy, and the long stale window keeps the low-traffic landing off the cold build entirely
// (#547 residual). The single-flight guard is what stops the admin page — which loads trend once per
// objective PLUS lifetime PLUS distribution simultaneously — from running that one fan-out six times over.
const goalBucketDatasetCache: PublicCache = new Map();

/** Test seam — reset the shared goal-bucketed dataset cache (entries + in-flight). */
export function __resetFunnelBucketDatasetCache(): void {
  clearPublicCache(goalBucketDatasetCache);
}

/** Test seam — expire ONLY the fresh window (keeping the stale payload), to assert a past-fresh read is
 * served from the last-known dataset WITHOUT a synchronous request-path fan-out. */
export function __expireFunnelBucketFreshCacheForTest(): void {
  expirePublicCacheFreshWindow(goalBucketDatasetCache);
}

/** Test seam — await any in-flight background goal-bucket dataset refresh(es), so a follow-up request
 * deterministically observes the refreshed dataset. */
export async function __awaitFunnelBucketRefresh(): Promise<void> {
  await awaitPublicCacheRefresh(goalBucketDatasetCache);
}

function getFunnelBucketDatasetCached(featureSlug: string): Promise<BucketedBrand[]> {
  return servedPublicCached<BucketedBrand[]>({
    cache: goalBucketDatasetCache,
    key: featureSlug,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "goal-bucket dataset",
    compute: () => fetchFunnelBucketDataset(featureSlug),
  });
}

// ── GET /public/features — List active features (landing page) ──────────────

router.get("/public/features", async (_req, res) => {
  try {
    const results = await db.query.features.findMany({
      where: eq(features.status, "active"),
    });

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] Public list features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Get all count-type stats keys from the registry.
 */
function getAllCountKeys(): string[] {
  return Object.entries(STATS_REGISTRY)
    .filter(([, def]) => def.kind === "raw" && def.type === "count")
    .map(([key]) => key);
}

/**
 * Get all output keys (raw + derived dependencies) from the registry.
 */
function getAllOutputKeys(): string[] {
  const keys = new Set<string>();
  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    keys.add(key);
    if (def.kind === "derived") {
      keys.add(def.numerator);
      keys.add(def.denominator);
    }
  }
  return [...keys];
}

/**
 * Determine which downstream sources are needed for a set of stats keys.
 */
function requiredSources(keys: string[]): Set<string> {
  const sources = new Set<string>();
  for (const key of keys) {
    const def = STATS_REGISTRY[key];
    if (def?.kind === "raw") sources.add(def.source);
    if (def?.kind === "derived") {
      const numDef = STATS_REGISTRY[def.numerator];
      const denDef = STATS_REGISTRY[def.denominator];
      if (numDef?.kind === "raw") sources.add(numDef.source);
      if (denDef?.kind === "raw") sources.add(denDef.source);
    }
  }
  return sources;
}

/**
 * Fetch all outcome stats from relevant sources.
 */
async function fetchOutcomeStats(
  featureSlug: string,
  groupBy: string,
  keys: string[],
): Promise<Map<string, Record<string, number>>> {
  const sources = requiredSources(keys);
  const merged = new Map<string, Record<string, number>>();

  // Each stat family is an INDEPENDENT upstream source. A failure in one (e.g. a
  // journalists-service 500) must NOT zero the others — so fetch via allSettled and
  // merge only the families that succeeded. A rejected family is logged loudly (fail
  // loud per family, per CLAUDE.md) and simply contributes no keys; its stats default
  // to 0/null downstream, but the succeeding families still populate. One upstream
  // outage can no longer blank the unrelated sales recipient/email stats.
  const families: { source: string; promise: Promise<Map<string, Record<string, number>>> }[] = [];
  if (sources.has("email-gateway")) families.push({ source: "email-gateway", promise: fetchPublicEmailStats(featureSlug, groupBy) });
  if (sources.has("journalists")) families.push({ source: "journalists", promise: fetchPublicJournalistsStats(featureSlug, groupBy) });

  const results = await Promise.allSettled(families.map((f) => f.promise));
  results.forEach((result, i) => {
    const { source } = families[i];
    if (result.status === "rejected") {
      console.error(
        `[features-service] outcome stat family "${source}" failed (featureSlug=${featureSlug}, groupBy=${groupBy}) — other families unaffected:`,
        result.reason,
      );
      return;
    }
    for (const [key, stats] of result.value) {
      const existing = merged.get(key) ?? {};
      Object.assign(existing, stats);
      merged.set(key, existing);
    }
  });

  return merged;
}

/**
 * Compute all stats (raw + derived) for a single group.
 */
function computeGroupStats(
  rawOutcomes: Record<string, number>,
  cost: { totalCostInUsdCents: number; completedRuns: number },
): Record<string, number | null> {
  const allRaw: Record<string, number> = {
    ...rawOutcomes,
    totalCostInUsdCents: cost.totalCostInUsdCents,
    completedRuns: cost.completedRuns,
  };

  const result: Record<string, number | null> = {};

  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    if (def.kind === "raw") {
      result[key] = allRaw[key] ?? 0;
    } else if (def.kind === "derived") {
      const num = allRaw[def.numerator];
      const den = allRaw[def.denominator];
      result[key] = (num != null && den != null && den > 0) ? num / den : null;
    }
  }

  result.totalCostInUsdCents = cost.totalCostInUsdCents;
  result.completedRuns = cost.completedRuns;

  return result;
}

/**
 * Build workflow upgrade chains for aggregation.
 */
export function buildUpgradeChains(workflows: WorkflowMetadata[]): Map<string, string[]> {
  const predecessorMap = new Map<string, string[]>();
  const idToSlug = new Map<string, string>();
  const activeWorkflows: WorkflowMetadata[] = [];

  for (const wf of workflows) {
    idToSlug.set(wf.id, wf.workflowSlug);
    if (wf.status === "active") activeWorkflows.push(wf);
    if (wf.upgradedTo) {
      const list = predecessorMap.get(wf.upgradedTo) ?? [];
      list.push(wf.workflowSlug);
      predecessorMap.set(wf.upgradedTo, list);
    }
  }

  const chains = new Map<string, string[]>();
  for (const wf of activeWorkflows) {
    const slugs = new Set<string>([wf.workflowSlug]);
    const queue = [wf.id];
    const visited = new Set<string>([wf.id]);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const preds = predecessorMap.get(currentId) ?? [];
      for (const predSlug of preds) {
        slugs.add(predSlug);
        for (const [id, slug] of idToSlug) {
          if (slug === predSlug && !visited.has(id)) { visited.add(id); queue.push(id); }
        }
      }
    }

    chains.set(wf.workflowSlug, [...slugs]);
  }

  return chains;
}

export function aggregateAcrossChains(
  chains: Map<string, string[]>,
  costGroups: { dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }[],
  outcomeMap: Map<string, Record<string, number>>,
  dimensionKey: string,
): { costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>; aggregatedOutcomes: Map<string, Record<string, number>> } {
  const perSlugCost = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  for (const group of costGroups) {
    const slug = group.dimensions[dimensionKey];
    if (!slug) continue;
    perSlugCost.set(slug, { totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)), completedRuns: group.runCount });
  }

  const costMap = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  const aggregatedOutcomes = new Map<string, Record<string, number>>();

  for (const [activeSlug, chainSlugs] of chains) {
    let totalCost = 0, totalRuns = 0;
    const mergedOutcomes: Record<string, number> = {};

    for (const slug of chainSlugs) {
      const cost = perSlugCost.get(slug);
      if (cost) { totalCost += cost.totalCostInUsdCents; totalRuns += cost.completedRuns; }
      const outcomes = outcomeMap.get(slug);
      if (outcomes) { for (const [k, v] of Object.entries(outcomes)) { mergedOutcomes[k] = (mergedOutcomes[k] ?? 0) + v; } }
    }

    if (totalRuns > 0) {
      costMap.set(activeSlug, { totalCostInUsdCents: totalCost, completedRuns: totalRuns });
      aggregatedOutcomes.set(activeSlug, mergedOutcomes);
    }
  }

  return { costMap, aggregatedOutcomes };
}

// ── Ranked handler ──────────────────────────────────────────────────────────

export async function handleRanked(
  featureSlug: string | undefined,
  requestedObjective: string | undefined,
  groupBy: string | undefined,
  limit: number,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  if (groupBy !== "workflow" && groupBy !== "brand") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'workflow' or 'brand'" });
    return;
  }

  const feature = await db.query.features.findFirst({
    where: eq(features.slug, featureSlug),
  });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const objective = requestedObjective ?? "costPerRecipientPositiveReplyCents";
  const objectiveDef = STATS_REGISTRY[objective];
  const sortDirection = (objectiveDef?.kind === "derived" && objectiveDef.type === "currency") ? "asc" : "desc";
  const cacheKey = `${featureSlug}|${objective}|${groupBy}|${limit}`;
  const payload = await servedPublicCached<{ objective: string; sortDirection: "asc" | "desc"; results: unknown[] }>({
    cache: publicRankedCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "public ranked",
    compute: async () => {
    const isBrandGrouping = groupBy === "brand";
    const statsGroupBy = isBrandGrouping ? "brandId" : "workflowSlug";

    const allKeys = getAllOutputKeys();

    const [workflows, costGroups, outcomeMap] = await Promise.all([
      isBrandGrouping ? Promise.resolve([]) : fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, statsGroupBy),
      fetchOutcomeStats(featureSlug, statsGroupBy, allKeys),
    ]);

    let costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>;
    let aggregatedOutcomes: Map<string, Record<string, number>>;

    if (isBrandGrouping) {
      costMap = new Map();
      aggregatedOutcomes = outcomeMap;
      for (const group of costGroups) {
        const key = group.dimensions.brandId;
        if (!key) continue;
        costMap.set(key, { totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)), completedRuns: group.runCount });
      }
    } else {
      const chains = buildUpgradeChains(workflows);
      const agg = aggregateAcrossChains(chains, costGroups, outcomeMap, "workflowSlug");
      costMap = agg.costMap;
      aggregatedOutcomes = agg.aggregatedOutcomes;
    }

    const entries: { key: string; stats: Record<string, number | null> }[] = [];
    for (const [key, cost] of costMap) {
      const rawOutcomes = aggregatedOutcomes.get(key) ?? {};
      const stats = computeGroupStats(rawOutcomes, cost);
      entries.push({ key, stats });
    }

    entries.sort((a, b) => {
      const aVal = a.stats[objective];
      const bVal = b.stats[objective];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
    });

    const top = entries.slice(0, limit);

    let brandInfoMap = new Map<string, { id: string; name: string | null; domain: string | null }>();
    if (isBrandGrouping && top.length > 0) {
      brandInfoMap = await fetchBrandInfoBatch(top.map((e) => e.key));
    }

    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    const results = top.map(({ key, stats }) => {
      if (isBrandGrouping) {
        const brand = brandInfoMap.get(key);
        return { brand: { id: key, name: brand?.name ?? null, domain: brand?.domain ?? null }, stats };
      }
      const wf = workflowBySlug.get(key);
      return {
        workflow: wf ? {
          id: wf.id,
          workflowSlug: wf.workflowSlug,
          workflowName: wf.workflowName,
          workflowDynastyName: wf.workflowDynastyName,
          workflowDynastySlug: wf.workflowDynastySlug,
          version: wf.version,
          featureSlug: wf.featureSlug,
          createdForBrandId: wf.createdForBrandId,
        } : { workflowSlug: key },
        stats,
      };
    });

    return { objective, sortDirection, results };
    },
  });
  res.json(payload);
}

// ── Best handler ────────────────────────────────────────────────────────────

export async function handleBest(
  featureSlug: string | undefined,
  groupBy: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  if (groupBy !== "workflow" && groupBy !== "brand") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'workflow' or 'brand'" });
    return;
  }

  const feature = await db.query.features.findFirst({
    where: eq(features.slug, featureSlug),
  });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const countKeys = getAllCountKeys();
  const isBrandMode = groupBy === "brand";
  const statsGroupBy = isBrandMode ? "brandId" : "workflowSlug";
  const cacheKey = `${featureSlug}|${groupBy}`;
  const payload = await servedPublicCached<{ best: Record<string, unknown> }>({
    cache: publicBestCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "public best",
    compute: async () => {
    const [workflows, costGroups, outcomeMap] = await Promise.all([
      isBrandMode ? Promise.resolve([]) : fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, statsGroupBy),
      fetchOutcomeStats(featureSlug, statsGroupBy, countKeys),
    ]);

    let costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>;
    let aggregatedOutcomes: Map<string, Record<string, number>>;

    if (isBrandMode) {
      costMap = new Map();
      aggregatedOutcomes = outcomeMap;
      for (const group of costGroups) {
        const key = group.dimensions.brandId;
        if (!key) continue;
        costMap.set(key, { totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)), completedRuns: group.runCount });
      }
    } else {
      const chains = buildUpgradeChains(workflows);
      const agg = aggregateAcrossChains(chains, costGroups, outcomeMap, "workflowSlug");
      costMap = agg.costMap;
      aggregatedOutcomes = agg.aggregatedOutcomes;
    }

    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    const best: Record<string, { workflowSlug?: string; workflowName?: string; brandId?: string; createdForBrandId?: string | null; value: number } | null> = {};

    for (const metricKey of countKeys) {
      let bestKey: string | null = null;
      let bestCostPerOutcome = Infinity;

      for (const [key, cost] of costMap) {
        const outcomes = aggregatedOutcomes.get(key)?.[metricKey] ?? 0;
        if (outcomes <= 0) continue;
        const cpo = cost.totalCostInUsdCents / outcomes;
        if (cpo < bestCostPerOutcome) { bestCostPerOutcome = cpo; bestKey = key; }
      }

      if (bestKey === null) {
        best[metricKey] = null;
      } else if (isBrandMode) {
        best[metricKey] = { brandId: bestKey, value: bestCostPerOutcome };
      } else {
        const wf = workflowBySlug.get(bestKey);
        best[metricKey] = { workflowSlug: wf?.workflowSlug ?? bestKey, workflowName: wf?.workflowName ?? bestKey, createdForBrandId: wf?.createdForBrandId ?? null, value: bestCostPerOutcome };
      }
    }

    return { best };
    },
  });
  res.json(payload);
}

// ── Public revenue handler ───────────────────────────────────────────────────
//
// Cross-org expected pipeline revenue + CAC + ROI per brand for the public benchmarks
// tables. Same EXACT engine the in-app dashboard runs (`/features/:slug/revenue`):
// for each (org, brand) that has leads for the feature we run computeFeatureRevenue,
// FORWARDING the owning org's x-org-id to the existing /orgs/* reads (those tiers require
// only x-org-id, so a service can compute on any org's behalf). A brand's number is the
// SUM across the orgs it appears in — leads are disjoint per org, so this never double-
// counts at the lead level. CAC/ROI fall out of buildCostEconomics, byte-identical to the
// dashboard. The compute is heavy (one engine pass per (org, brand)), so the assembled
// response is cached in-memory for a short TTL — it is the same for every public caller.

interface PublicRevenueResult {
  brand: { id: string; name: string | null; domain: string | null };
  headline: { totalPipelineUsd: number | null };
  costEconomics: ReturnType<typeof buildCostEconomics>;
  timeline?: Array<{ date: string; cumulativePipelineUsd: number }>;
}
interface PublicRevenuePayload {
  featureSlug: string;
  groupBy: "brand";
  results: PublicRevenueResult[];
}

const revenueCache: PublicCache = new Map();

/** Test seam — reset the in-memory public-revenue cache. */
export function __resetPublicRevenueCache(): void {
  clearPublicCache(revenueCache);
}

/** Slim feature-wide rollup of expected pipeline — sum of every brand's non-null totalPipelineUsd
 *  (null when no brand has usable economics). Lets the landing show one number without the ~1.9 MB
 *  per-brand timeline arrays. Derived from the SAME computed/cached payload as the full response. */
function revenueRollup(payload: PublicRevenuePayload): { featureSlug: string; totalPipelineUsd: number | null } {
  const vals = payload.results
    .map((r) => r.headline.totalPipelineUsd)
    .filter((v): v is number => v !== null);
  return {
    featureSlug: payload.featureSlug,
    totalPipelineUsd: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null,
  };
}

export async function handlePublicRevenue(
  featureSlug: string | undefined,
  groupBy: string | undefined,
  res: import("express").Response,
  rollup = false,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  // brand grouping only for now — per-workflow revenue (workflow-scoped cost + leads filter)
  // ships as a follow-up once lead-service exposes the workflowSlug lead filter.
  if (groupBy !== "brand") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'brand'" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const cacheKey = `${featureSlug}:${groupBy}`;
  const payload = await servedPublicCached<PublicRevenuePayload>({
    cache: revenueCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "public revenue",
    compute: async () => {
    const funnel = getFunnel(featureSlug);
    const memberships = await fetchFeatureMemberships(featureSlug);

    // One revenue compute per DISTINCT (org, brand) pair (workflow collapsed for the brand table).
    const pairKey = (orgId: string, brandId: string) => `${orgId}::${brandId}`;
    const pairs = [
      ...new Map(memberships.map((m) => [pairKey(m.orgId, m.brandId), { orgId: m.orgId, brandId: m.brandId }])).values(),
    ];

    const computed = await Promise.all(
      pairs.map(async ({ orgId, brandId }) => {
        const headers: DownstreamHeaders = { orgId, featureSlug };
        try {
          const body = await computeFeatureRevenue(featureSlug, brandId, undefined, funnel, headers);
          return {
            brandId,
            pipeline: body.headline.totalPipelineUsd,
            costUsd: body.costEconomics.actualCostUsd,
            timeSeries: body.timeSeries,
          };
        } catch (error) {
          if (error instanceof BrandOwnershipError) {
            console.log(
              `[features-service] skipping stale feature membership for public revenue: featureSlug=${featureSlug}, orgId=${orgId}, brandId=${brandId}`,
            );
            return null;
          }
          throw error;
        }
      }),
    );

    // Aggregate per brand: pipeline = sum of the orgs' non-null pipelines (null iff EVERY org's is
    // null — i.e. no saved economics anywhere); cost always sums. Leads are disjoint per org, so the
    // sum does not double-count.
    const byBrand = new Map<string, { pipelineSum: number; hasPipeline: boolean; costCents: number; timelineDeltas: Map<string, number> }>();
    for (const c of computed) {
      if (c === null) continue;
      const agg = byBrand.get(c.brandId) ?? { pipelineSum: 0, hasPipeline: false, costCents: 0, timelineDeltas: new Map<string, number>() };
      if (c.pipeline !== null) {
        agg.pipelineSum += c.pipeline;
        agg.hasPipeline = true;
      }
      agg.costCents += Math.round(c.costUsd * 100);
      let previous = 0;
      for (const point of c.timeSeries) {
        const delta = point.cumulativePipelineUsd - previous;
        previous = point.cumulativePipelineUsd;
        if (delta <= 0) continue;
        agg.timelineDeltas.set(point.date, (agg.timelineDeltas.get(point.date) ?? 0) + delta);
      }
      byBrand.set(c.brandId, agg);
    }

    const brandIds = [...byBrand.keys()];
    const brandInfo = await fetchBrandInfoBatch(brandIds);

    const results: PublicRevenueResult[] = brandIds.map((brandId) => {
      const agg = byBrand.get(brandId)!;
      const totalPipelineUsd = agg.hasPipeline ? agg.pipelineSum : null;
      const info = brandInfo.get(brandId);
      let cumulativePipelineUsd = 0;
      const timeline = [...agg.timelineDeltas.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, delta]) => {
          cumulativePipelineUsd += delta;
          return { date, cumulativePipelineUsd };
        });
      return {
        brand: { id: brandId, name: info?.name ?? null, domain: info?.domain ?? null },
        headline: { totalPipelineUsd },
        costEconomics: buildCostEconomics(agg.costCents, totalPipelineUsd),
        ...(timeline.length > 0 ? { timeline } : {}),
      };
    });

    // Default sort: highest pipeline first (null pipeline last), then highest cost (deterministic).
    results.sort((a, b) => {
      const ap = a.headline.totalPipelineUsd;
      const bp = b.headline.totalPipelineUsd;
      if (ap === null && bp === null) return b.costEconomics.actualCostUsd - a.costEconomics.actualCostUsd;
      if (ap === null) return 1;
      if (bp === null) return -1;
      if (bp !== ap) return bp - ap;
      return b.costEconomics.actualCostUsd - a.costEconomics.actualCostUsd;
    });

    const body: PublicRevenuePayload = { featureSlug, groupBy: "brand", results };
    return body;
    },
  });
  // The rollup is a pure projection of the SAME cached payload — never a second compute.
  res.json(rollup ? revenueRollup(payload) : payload);
}

// ── Public workflow engagement latency handler ───────────────────────────────
//
// Public-safe workflow-level timing metrics for benchmark/report workflow rows.
// The average/median math belongs to the email producer because median requires
// event-level duration distributions; features-service only enriches the
// producer-owned workflowSlug aggregates with public workflow identity and
// filters out any unknown keys before returning a no-auth response.

interface PublicWorkflowEngagementLatencyResult {
  workflow: {
    id: string;
    workflowSlug: string;
    workflowName: string;
    workflowDynastyName: string;
    workflowDynastySlug: string;
    version: number;
    featureSlug: string;
    createdForBrandId: string | null;
  };
  timeToFirstLinkClick: EngagementLatencyMetric;
  timeToFirstPositiveReply: EngagementLatencyMetric;
}

interface PublicWorkflowEngagementLatencyPayload {
  featureSlug: string;
  groupBy: "workflow";
  results: PublicWorkflowEngagementLatencyResult[];
}

export async function handlePublicWorkflowEngagementLatency(
  featureSlug: string | undefined,
  groupBy: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  if (groupBy !== "workflow") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'workflow'" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const cacheKey = `${featureSlug}|${groupBy}`;
  const payload = await servedPublicCached<PublicWorkflowEngagementLatencyPayload>({
    cache: publicWorkflowLatencyCache,
    key: cacheKey,
    windows: FLEET_AUDIT_WINDOWS,
    label: "public workflow engagement latency",
    compute: async () => {
    const [workflows, latencyByWorkflow] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "active"),
      fetchPublicWorkflowEngagementLatency(featureSlug),
    ]);

    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));
    const results: PublicWorkflowEngagementLatencyResult[] = [];

    for (const [workflowSlug, latency] of latencyByWorkflow) {
      const wf = workflowBySlug.get(workflowSlug);
      if (!wf) continue;
      results.push({
        workflow: {
          id: wf.id,
          workflowSlug: wf.workflowSlug,
          workflowName: wf.workflowName,
          workflowDynastyName: wf.workflowDynastyName,
          workflowDynastySlug: wf.workflowDynastySlug,
          version: wf.version,
          featureSlug: wf.featureSlug,
          createdForBrandId: wf.createdForBrandId,
        },
        timeToFirstLinkClick: latency.timeToFirstLinkClick,
        timeToFirstPositiveReply: latency.timeToFirstPositiveReply,
      });
    }

    results.sort((a, b) => {
      const ar = a.timeToFirstPositiveReply.medianMs;
      const br = b.timeToFirstPositiveReply.medianMs;
      if (ar === null && br === null) return a.workflow.workflowSlug.localeCompare(b.workflow.workflowSlug);
      if (ar === null) return 1;
      if (br === null) return -1;
      if (ar !== br) return ar - br;
      return a.workflow.workflowSlug.localeCompare(b.workflow.workflowSlug);
    });

    const body: PublicWorkflowEngagementLatencyPayload = { featureSlug, groupBy: "workflow", results };
    return body;
    },
  });
  res.json(payload);
}

// ── Public cost-projection handler ────────────────────────────────────────────
//
// Feature-wide EXPECTED (projected, not tracked) average cost per meeting-booked and per purchase.
// Real meeting/closed events ARE tracked (instantly manual qualifications) but thinly populated, so
// the landing wants the projection — the SAME EV math the revenue engine / workflow-projection run:
// each workflow's GLOBAL unit costs (cost/click, cost/positive-reply — cross-org, feature-scoped) pushed
// through each brand's EFFECTIVE conversion economics. Per brand we pick the BEST workflow for EACH metric
// (lowest projected cost) independently, then take the unweighted mean across all client brands. Cross-org,
// no auth. brand-service owns the null→cross-brand-average economics defaulting; a brand with no usable
// economics contributes nothing. One economics fetch per brand → cached in-memory briefly.

interface PublicCostProjectionPayload {
  featureSlug: string;
  /** Legacy top-level fields (Wave 1 admin cards) — kept byte-equal to
   * avgCostPerOutcomeByObjective.meetingBooked / .websitePurchase. `avgCostPerPurchase` keeps its name
   * (admin reads it) but now sources the renamed `websitePurchase` objective. */
  avgCostPerMeetingBooked: number | null;
  avgCostPerPurchase: number | null;
  /** Fleet-average cost-per-outcome for EVERY optimization objective (null where no brand is backed).
   * websiteVisit / positiveReply = CPC / CPPR; the rest project through the funnel. Gap #1 (#485).
   * Carries `websitePurchase` (renamed from `purchase`) + the combined `sales`. The transitional
   * `purchase` alias was dropped once distribute.you migrated to `websitePurchase` (admin reads
   * `websitePurchase ?? purchase`; landing objectives never included purchase). */
  avgCostPerOutcomeByObjective: ObjectiveAverages;
  brandCount: number;
}

const costProjectionCache: PublicCache = new Map();

/** Test seam — reset the in-memory cost-projection cache. */
export function __resetPublicCostProjectionCache(): void {
  clearPublicCache(costProjectionCache);
}

export async function handlePublicCostProjection(
  featureSlug: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const payload = await servedPublicCached<PublicCostProjectionPayload>({
    cache: costProjectionCache,
    key: featureSlug,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "public cost-projection",
    compute: async () => {
    // GLOBAL per-workflow unit costs (cross-org, feature-scoped) — fetched once, shared across brands.
    // Same dynasty-chain aggregation as /public/stats/best|ranked and the authed workflow-projection route.
    const [workflows, costGroups, emailStats, memberships] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchFeatureMemberships(featureSlug),
    ]);

    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");

    const unitCostList: { clickUsd: number | null; replyUsd: number | null }[] = [];
    for (const [slug, cost] of costMap) {
      const outcomes = aggregatedOutcomes.get(slug) ?? {};
      const costUsd = cost.totalCostInUsdCents / 100;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const clicks = outcomes.recipientsClicked ?? 0;
      unitCostList.push({
        clickUsd: clicks > 0 && costUsd > 0 ? costUsd / clicks : null,
        replyUsd: replies > 0 && costUsd > 0 ? costUsd / replies : null,
      });
    }

    // One economics fetch per DISTINCT brand (forward any owning org — the /orgs/* tier needs only x-org-id).
    // A stale membership (BrandOwnershipError) or a brand with no economics contributes nothing.
    const brandToOrg = new Map<string, string>();
    for (const m of memberships) {
      if (!brandToOrg.has(m.brandId)) brandToOrg.set(m.brandId, m.orgId);
    }

    const perBrandEconomicsRaw = await Promise.all(
      [...brandToOrg.entries()].map(async ([brandId, orgId]) => {
        try {
          const effective = await fetchEffectiveEconomics(brandId, { orgId, featureSlug });
          return effective.economics;
        } catch (error) {
          if (error instanceof BrandOwnershipError) {
            console.log(
              `[features-service] skipping stale feature membership for public cost-projection: featureSlug=${featureSlug}, orgId=${orgId}, brandId=${brandId}`,
            );
            return null;
          }
          throw error;
        }
      }),
    );
    const perBrandEconomics = perBrandEconomicsRaw.filter((e): e is SalesEconomics => e != null);

    // Fleet averages across ALL objectives (per-brand best across the fleet unit costs → mean over brands).
    const { objectives, brandCount } = buildObjectiveAverages(unitCostList, perBrandEconomics);

    return {
      featureSlug,
      avgCostPerMeetingBooked: objectives.meetingBooked,
      avgCostPerPurchase: objectives.websitePurchase, // legacy top-level alias → renamed objective
      avgCostPerOutcomeByObjective: objectives,
      brandCount,
    };
    },
  });
  res.json(payload);
}

// ── GET /public/stats/cost-per-outcome-trend ─────────────────────────────────
//
// Gap #2 (#485). Dated moving-average cost-per-outcome series for ONE objective, cross-org: each display
// day anchors a trailing window that accumulates backward until it holds ~`windowOutcomes` of the
// objective's base outcomes, then reports that window's fleet-spend ÷ outcomes (projected objectives push
// the window unit costs through the fleet-mean economics). Joins runs-service dated fleet spend (public
// costs groupBy=day) against email-gateway dated outcomes (public stats groupBy=day). null cost points
// where the window is unbacked — never a false $0.

const DEFAULT_TREND_DAYS = 30;
const MAX_TREND_DAYS = 180;
const DEFAULT_WINDOW_OUTCOMES = 100;
const MAX_WINDOW_OUTCOMES = 100_000;
const MAX_TREND_LOOKBACK_DAYS = 365;

interface CostPerOutcomeTrendPayload {
  featureSlug: string;
  objective: string;
  windowOutcomes: number;
  points: TrendPoint[];
}

const costPerOutcomeTrendCache: PublicCache = new Map();

/** Test seam — reset the in-memory cost-per-outcome-trend cache. */
export function __resetCostPerOutcomeTrendCache(): void {
  clearPublicCache(costPerOutcomeTrendCache);
}

export async function handleCostPerOutcomeTrend(
  featureSlug: string | undefined,
  objectiveParam: string | undefined,
  daysParam: string | undefined,
  windowParam: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  const objective = normalizeObjective(objectiveParam);
  if (!objective) {
    res.status(400).json({ error: "Query parameter 'objective' is required (one of the optimization goals)" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const parsedDays = parseInt(daysParam ?? "", 10);
  const days = Number.isFinite(parsedDays) && parsedDays >= 1 ? Math.min(parsedDays, MAX_TREND_DAYS) : DEFAULT_TREND_DAYS;
  const parsedWindow = parseInt(windowParam ?? "", 10);
  const windowOutcomes =
    Number.isFinite(parsedWindow) && parsedWindow >= 1 ? Math.min(parsedWindow, MAX_WINDOW_OUTCOMES) : DEFAULT_WINDOW_OUTCOMES;

  const cacheKey = `trend:${featureSlug}:${objective}:${days}:${windowOutcomes}`;
  const payload = await servedPublicCached<CostPerOutcomeTrendPayload>({
    cache: costPerOutcomeTrendCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "cost-per-outcome trend",
    compute: async () => {
    // Goal-bucketed: sum spend + outcomes over ONLY the brands whose optimization goal is relevant to
    // this objective (e.g. CPC excludes reply-driven + meeting-driven brands) so the moving average is
    // not diluted by off-goal spend.
    const dataset = await getFunnelBucketDatasetCached(featureSlug);
    const bucket = bucketBrandsForObjective(dataset, objective);
    const spendByDay = mergeSpendByDay(bucket);
    const outcomesByDay = mergeOutcomesByDay(bucket);

    const fleetEcon = meanFleetEconomics(bucket.map((b) => b.economics));
    const todayIso = new Date().toISOString().slice(0, 10);
    const points = buildCostPerOutcomeTrend({
      objective,
      todayIso,
      days,
      windowOutcomes,
      maxLookbackDays: MAX_TREND_LOOKBACK_DAYS,
      spendByDay,
      outcomesByDay,
      fleetEcon,
    });

    return { featureSlug, objective, windowOutcomes, points };
    },
  });
  res.json(payload);
}

// ── GET /public/stats/workflow-cost-per-outcome ──────────────────────────────
//
// Gap #3 (#485). Per-workflow (dynasty) cross-org cost-per-outcome for ONE objective, guaranteed to
// POPULATE when the workflow has spend: unit costs run through the PROJECTED cost-engine, flooring to
// max(spent, fleet-parent unit cost) when the outcome denominator is 0. Same crossOrg dynasty rollup as
// /public/stats/best. Sorted by spend desc.

interface WorkflowCostPerOutcomePayload {
  featureSlug: string;
  objective: string;
  /** The trailing-window size (base outcomes) the per-row `recentCostPerOutcomeUsd` moving average targets
   * — the SAME window semantics as /public/stats/cost-per-outcome-trend. */
  windowOutcomes: number;
  workflows: WorkflowCostRow[];
}

const workflowCostPerOutcomeCache: PublicCache = new Map();
// Single-flight guard for the OFF-request-path recent-rate warm (see handler below): at most one
// background fan-out per cache key at a time. Holds the in-flight promise so tests can deterministically
// await the warm before asserting the populated cache.
const workflowRecentWarmInFlight = new Map<string, Promise<void>>();

// Persisted per-dynasty RECENT rates, keyed by cacheKey, on their OWN TTL, independent of the payload
// cache's windows. Decouples the recent-rate lifetime from the payload's: once a warm populates the recent
// rates, a payload cache-MISS re-seeds the served payload from this store instead of re-nulling the recent
// column while the next warm runs. So a normal read
// carries the last-known recent rate reliably, not only in the few seconds right after a warm.
// A CLEAN warm (every dynasty's fetch succeeded) is trusted for the full window — no re-warm for 10 min,
// so reads seed from the store and the O(dynasty-count) fan-out does NOT run again, keeping load off the
// (cold-Neon-sensitive) sibling services the request-path lifetime fan-out also depends on.
const RECENT_RATE_TTL_MS = 10 * 60_000;
// A DEGRADED warm (≥1 dynasty's fetch failed/timed out — typically cold-start churn) is trusted only
// briefly, so the next read after this window re-warms and SELF-HEALS the failed dynasties once the
// computes are warm — without re-fanning-out on every payload miss (which would contend with the request path).
const RECENT_RATE_DEGRADED_TTL_MS = 90_000;
const workflowRecentRateStore = new Map<string, { map: Map<string, number | null>; expiresAt: number }>();

// Per-dynasty warm budget. A single hung cross-service fetch (cold Neon TCP stall with no reject) must NOT
// block the whole warm's `Promise.all` — if it did, the warm never settles, its `.finally()` never clears
// `workflowRecentWarmInFlight`, and NO future warm ever runs for that cacheKey → recent stays permanently
// null (the exact stuck-flag failure that kept the default window all-null even after the producers were
// fixed). Racing each dynasty against this timeout guarantees every dynasty settles → the warm always
// completes, always clears its flag, and a stalled dynasty degrades to null (retried next warm). The warm
// is OFF the request path (no gateway deadline), so this is generous — it only fires on a genuine hang, NOT
// on a merely-slow cold-Neon fetch (fetchWithRetry already handles cold-start connect retries); killing a
// slow-but-live fetch would spuriously null a backed dynasty for a whole warm cycle.
const RECENT_WARM_PER_DYNASTY_TIMEOUT_MS = 45_000;
// Cap how many dynasties' dated fan-outs run at once. The warm fetches TWO cross-service calls per dynasty
// (runs timeseries + email-gateway dated outcomes); firing all ~25 dynasties at once = ~50 concurrent
// connections that overwhelm cold-start Neon-backed siblings, making EVERY fetch slow enough to trip the
// per-dynasty timeout → the whole warm degrades to all-null. Capping concurrency keeps each fetch fast
// enough to beat the timeout (which then only fires on a genuine hang), so backed dynasties populate.
const RECENT_WARM_CONCURRENCY = 6;

function getStoredRecentRates(cacheKey: string): Map<string, number | null> | null {
  const entry = workflowRecentRateStore.get(cacheKey);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.map;
}

function setStoredRecentRates(cacheKey: string, map: Map<string, number | null>, ttlMs: number = RECENT_RATE_TTL_MS): void {
  workflowRecentRateStore.set(cacheKey, { map, expiresAt: Date.now() + ttlMs });
}

/** Test seam — reset the in-memory workflow-cost-per-outcome cache. */
export function __resetWorkflowCostPerOutcomeCache(): void {
  clearPublicCache(workflowCostPerOutcomeCache);
  workflowRecentWarmInFlight.clear();
  workflowRecentRateStore.clear();
}

/** Test seam — expire ONLY the payload cache (simulating a lapsed fresh+stale window) while keeping the
 * longer-lived recent-rate store, to assert a payload-miss re-serves the last-known recent rates instead
 * of re-nulling the column. */
export function __expireWorkflowPayloadCacheForTest(): void {
  clearPublicCache(workflowCostPerOutcomeCache);
}

/** Test-only export of the per-item timeout primitive. */
export const __withTimeoutForTest = withTimeout;

/** Test-only export of the concurrency-limited map primitive. */
export const __mapWithConcurrencyForTest = mapWithConcurrency;

/** Test seam — await any in-flight background recent-rate warm(s), so a follow-up request deterministically
 * observes the recent-populated cache entry. */
export async function __awaitWorkflowRecentWarm(): Promise<void> {
  await Promise.all([...workflowRecentWarmInFlight.values()]);
}

export async function handleWorkflowCostPerOutcome(
  featureSlug: string | undefined,
  objectiveParam: string | undefined,
  windowParam: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  const objective = normalizeObjective(objectiveParam);
  if (!objective) {
    res.status(400).json({ error: "Query parameter 'objective' is required (one of the optimization goals)" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  // Same window sizing as the fleet cost-per-outcome trend (default 100 base outcomes, same clamp).
  const parsedWindow = parseInt(windowParam ?? "", 10);
  const windowOutcomes =
    Number.isFinite(parsedWindow) && parsedWindow >= 1 ? Math.min(parsedWindow, MAX_WINDOW_OUTCOMES) : DEFAULT_WINDOW_OUTCOMES;

  const cacheKey = `wf-cpo:${featureSlug}:${objective}:${windowOutcomes}`;
  const payload = await servedPublicCached<WorkflowCostPerOutcomePayload>({
    cache: workflowCostPerOutcomeCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "workflow cost-per-outcome",
    compute: async () => {
    const [workflows, costGroups, emailStats, perBrandEconomics] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchFleetBrandEconomics(featureSlug),
    ]);

    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    // Roll each active-workflow chain up to its dynasty (two active heads sharing a dynasty merge).
    const byDynasty = new Map<string, WorkflowGrainInput>();
    for (const [slug, cost] of costMap) {
      const wf = workflowBySlug.get(slug);
      if (!wf) continue;
      const outcomes = aggregatedOutcomes.get(slug) ?? {};
      const spentUsd = cost.totalCostInUsdCents / 100;
      const clicks = outcomes.recipientsClicked ?? 0;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const existing = byDynasty.get(wf.workflowDynastySlug);
      if (existing) {
        existing.spentUsd += spentUsd;
        existing.clicks += clicks;
        existing.replies += replies;
      } else {
        byDynasty.set(wf.workflowDynastySlug, {
          workflowDynastySlug: wf.workflowDynastySlug,
          workflowDynastyName: wf.workflowDynastyName,
          spentUsd,
          clicks,
          replies,
        });
      }
    }

    // crossOrg is the top grain of the per-workflow cost cascade: a 0-outcome workflow floors to its OWN
    // spend (parent = null in buildWorkflowCostPerOutcome), NOT a cross-workflow pooled average — so no
    // fleet-parent unit cost is computed here.
    const fleetEcon = meanFleetEconomics(perBrandEconomics);
    const todayIso = new Date().toISOString().slice(0, 10);
    const dynastyInputs = [...byDynasty.values()];

    // Build the response for a given per-dynasty recent-rate map. The lifetime cost / spend / clicks /
    // replies come from the (already-fetched, fast) main fan-out; `recentByDynasty` carries the trailing-
    // window moving average (a dynasty absent from the map → null recent, never a false $0).
    const buildPayload = (recentByDynasty: Map<string, number | null>): WorkflowCostPerOutcomePayload => ({
      featureSlug,
      objective,
      windowOutcomes,
      workflows: buildWorkflowCostPerOutcome({
        objective,
        rows: dynastyInputs,
        fleetEcon,
        projectedFloor: projectedCostPerOutcome,
        recentByDynasty,
      }),
    });

    // The per-dynasty RECENT going rate needs, PER dynasty, a dated-spend timeseries (runs) + dated outcomes
    // (email-gateway) — and neither producer exposes a single-call (day × dynasty) split (runs' timeseries
    // only FILTERS by dynasty, email-gateway's groupBy is single-dimension), so it is an O(dynasty-count)
    // cross-service fan-out. On top of the Neon-backed siblings' cold-start churn, running that fan-out ON
    // the request path pushed the endpoint past the gateway timeout (and rejected the whole Promise.all on
    // any one transient sub-failure) → 500 (regression, PR #521). So it stays OFF the request path: serve
    // the lifetime rows IMMEDIATELY (the same handful of calls as the healthy /cost-per-outcome-lifetime
    // sibling), SEEDED with the last-known recent rates from the persisted store (so a payload-TTL miss
    // re-serves them instead of re-nulling), then warm the recent rates in the background. A never-yet-warmed
    // or genuinely-unbacked dynasty stays null ("—"), never a false $0.
    const seededRecent = getStoredRecentRates(cacheKey);
    const built = buildPayload(seededRecent ?? new Map());

    // Warm when the persisted recent rates are stale/absent (single-flight per cache key). Stale-while-
    // revalidate: the served payload is already seeded from the store above (a miss never re-nulls the column
    // — no flicker), and this background warm refreshes the store for later reads. Self-heal without hammering
    // is achieved by a VARIABLE store TTL (see the warm's `setStoredRecentRates` below): a CLEAN warm is
    // trusted 10 min (no re-warm → the O(dynasty) fan-out doesn't contend with the request-path lifetime
    // fan-out for the same cold-Neon siblings), while a DEGRADED warm (any dynasty failed/timed out) is
    // trusted only ~90s → the next read re-warms and heals the failed dynasties once the computes are warm.
    if (seededRecent === null && !workflowRecentWarmInFlight.has(cacheKey)) {
      const warm = (async () => {
        let failures = 0;
        // Seed from the last-known map so a dynasty whose fan-out transiently fails/stalls this round keeps
        // its prior rate instead of flickering to null; a genuinely-unbacked dynasty is (re)set to null.
        const recentByDynasty = new Map<string, number | null>(getStoredRecentRates(cacheKey) ?? []);
        // PER-DYNASTY resilient: each dynasty's dated fan-out is independently caught AND time-bounded so ONE
        // failing/stalled dynasty nulls only ITSELF, never the whole set (mirrors the stat-families doctrine).
        // The timeout is load-bearing: a hung cross-service fetch (cold Neon, no reject) would otherwise leave
        // the outer Promise.all pending forever → the warm never settles → its `.finally()` never clears the
        // in-flight flag → NO future warm runs for this cacheKey → recent stays permanently null (the exact
        // stuck-flag failure observed in prod). Racing each dynasty guarantees the warm always completes.
        await mapWithConcurrency(dynastyInputs, RECENT_WARM_CONCURRENCY, async (r) => {
            try {
              const outcome = await withTimeout(
                (async () => {
                  const [spendByDay, dayFields] = await Promise.all([
                    fetchDynastySpendByDay(featureSlug, r.workflowDynastySlug),
                    fetchPublicEmailStats(featureSlug, "day", undefined, r.workflowDynastySlug),
                  ]);
                  const outcomesByDay = new Map<string, DayOutcome>();
                  for (const [day, fields] of dayFields) {
                    if (day === "__total__") continue;
                    outcomesByDay.set(day, {
                      clicks: fields.recipientsClicked ?? 0,
                      replies: fields.recipientsRepliesPositive ?? 0,
                    });
                  }
                  return recentWindowCostPerOutcome({
                    objective,
                    todayIso,
                    windowOutcomes,
                    maxLookbackDays: MAX_TREND_LOOKBACK_DAYS,
                    spendByDay,
                    outcomesByDay,
                    fleetEcon,
                  });
                })(),
                RECENT_WARM_PER_DYNASTY_TIMEOUT_MS,
                `recent-rate warm dynasty ${r.workflowDynastySlug}`,
              );
              recentByDynasty.set(r.workflowDynastySlug, outcome);
            } catch (error) {
              // Fail-soft per dynasty: count it (drives the DEGRADED store TTL → a soon self-heal), log loud,
              // retain this dynasty's prior/null recent (never a false $0), retried next warm.
              failures++;
              console.error(
                `[features-service] workflow-cost-per-outcome recent-rate warm failed for dynasty ${r.workflowDynastySlug} (${cacheKey}):`,
                error,
              );
              if (!recentByDynasty.has(r.workflowDynastySlug)) recentByDynasty.set(r.workflowDynastySlug, null);
            }
        });
        // Persist whatever populated (partial is fine) and overwrite the served payload. A CLEAN warm is
        // trusted the full 10-min TTL (no re-warm → no sibling contention); a DEGRADED warm (≥1 fetch failed/
        // timed out) is trusted only ~90s so the next read re-warms and heals the failed dynasties.
        setStoredRecentRates(cacheKey, recentByDynasty, failures > 0 ? RECENT_RATE_DEGRADED_TTL_MS : RECENT_RATE_TTL_MS);
          setPublicCache(workflowCostPerOutcomeCache, cacheKey, buildPayload(recentByDynasty), LIFETIME_AGGREGATE_WINDOWS);
      })()
        .catch((error) => {
          // Belt-and-suspenders: the per-dynasty catches above already fail-soft, so this only fires on a
          // non-fetch bug. Never 500s the endpoint (the response was already sent).
          console.error(`[features-service] workflow-cost-per-outcome recent-rate warm crashed (${cacheKey}):`, error);
        })
        .finally(() => {
          workflowRecentWarmInFlight.delete(cacheKey);
        });
      workflowRecentWarmInFlight.set(cacheKey, warm);
    }

    return built;
    },
  });
  res.json(payload);
}

// ── GET /public/stats/best-model-cost-per-outcome-trend ──────────────────────
//
// The dated cost-per-outcome trend of the SINGLE BEST cross-org workflow model — the drop-in replacement
// for the landing's pooled /cost-per-outcome-trend, made COHERENT with the "best model" HEADLINE (the
// min cost-per-outcome across workflows the landing reads from /public/stats/workflow-cost-per-outcome).
// The pooled trend blended ALL ~21 workflows into one average (~$250) while the headline shows the best
// single model (~$52) — two different metrics on the same card. This series plots the best model over
// time so the line agrees with the headline.
//
// DESIGN CHOICE (documented) — the series is the currently-BEST workflow DYNASTY's OWN dated trailing-
// window moving average, NOT a best-of-fleet envelope (per-day min across workflows). Rationale:
//   • Coherent BY CONSTRUCTION with the headline: the best model is picked ONCE the SAME way the headline
//     picks it (cheapest LIFETIME costPerOutcomeUsd among dynasties with the objective's OBSERVED base
//     outcome > 0), then we plot THAT model's real cost history. The most-recent backed point is that
//     model's recent cost (~$52-class), never the pooled ~$250.
//   • Honest single-model line: every point is ONE real workflow's cost — never blended/pooled across
//     workflows (the metric being eradicated) — and it is that model's ACTUAL trajectory, NOT a
//     min-of-many-noisy-windows envelope (downward-biased, and jumps between workflows day-to-day = noisy
//     for a marketing line).
//   • Request-path-safe: it fetches only the ONE best dynasty's dated spend + outcomes (2 cross-service
//     calls), NOT the O(dynasty-count) per-workflow dated fan-out that forced /workflow-cost-per-outcome's
//     recent rate OFF the request path — so no background warm / persisted store is needed here.
// Same trailing-window smoothing as /public/stats/cost-per-outcome-trend (reuses buildCostPerOutcomeTrend),
// so it is a true drop-in. Cost points null where the best model's window is unbacked — never a false $0.

interface BestModelCostPerOutcomeTrendPayload {
  featureSlug: string;
  objective: string;
  windowOutcomes: number;
  /** The single best workflow dynasty this series plots — the currently-cheapest by LIFETIME
   * cost-per-outcome among dynasties with the objective's OBSERVED base outcome > 0 (the SAME pick the
   * landing headline makes). Null when NO workflow has an observed outcome (cold start) → empty points. */
  bestWorkflowDynastySlug: string | null;
  bestWorkflowDynastyName: string | null;
  /** The best model's LIFETIME cost-per-outcome (USD) — the headline number this trend's most-recent
   * backed point tracks. Null when no best model exists. */
  bestWorkflowLifetimeCostPerOutcomeUsd: number | null;
  /** Dated moving-average series for the best model (one point per trailing display day). Empty array
   * when no best model exists (cold start). Same TrendPoint shape as /cost-per-outcome-trend. */
  points: TrendPoint[];
}

const bestModelCostPerOutcomeTrendCache: PublicCache = new Map();

/** Test seam — reset the in-memory best-model-cost-per-outcome-trend cache. */
export function __resetBestModelCostPerOutcomeTrendCache(): void {
  clearPublicCache(bestModelCostPerOutcomeTrendCache);
}

export async function handleBestModelCostPerOutcomeTrend(
  featureSlug: string | undefined,
  objectiveParam: string | undefined,
  daysParam: string | undefined,
  windowParam: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  const objective = normalizeObjective(objectiveParam);
  if (!objective) {
    res.status(400).json({ error: "Query parameter 'objective' is required (one of the optimization goals)" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  // Same window/day sizing + clamps as the pooled /cost-per-outcome-trend (this is its best-model twin).
  const parsedDays = parseInt(daysParam ?? "", 10);
  const days = Number.isFinite(parsedDays) && parsedDays >= 1 ? Math.min(parsedDays, MAX_TREND_DAYS) : DEFAULT_TREND_DAYS;
  const parsedWindow = parseInt(windowParam ?? "", 10);
  const windowOutcomes =
    Number.isFinite(parsedWindow) && parsedWindow >= 1 ? Math.min(parsedWindow, MAX_WINDOW_OUTCOMES) : DEFAULT_WINDOW_OUTCOMES;

  const cacheKey = `best-model-trend:${featureSlug}:${objective}:${days}:${windowOutcomes}`;
  const payload = await servedPublicCached<BestModelCostPerOutcomeTrendPayload>({
    cache: bestModelCostPerOutcomeTrendCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "best-model cost-per-outcome trend",
    compute: async () => {
    // Pick the best model the SAME way the landing headline does: build the per-dynasty LIFETIME
    // cost-per-outcome rows (the request-path-safe fan-out — single groupBy calls, NOT per-dynasty dated),
    // exactly as /public/stats/workflow-cost-per-outcome does, then take the cheapest observed>0 dynasty.
    const [workflows, costGroups, emailStats, perBrandEconomics] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchFleetBrandEconomics(featureSlug),
    ]);

    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    const byDynasty = new Map<string, WorkflowGrainInput>();
    for (const [slug, cost] of costMap) {
      const wf = workflowBySlug.get(slug);
      if (!wf) continue;
      const outcomes = aggregatedOutcomes.get(slug) ?? {};
      const spentUsd = cost.totalCostInUsdCents / 100;
      const clicks = outcomes.recipientsClicked ?? 0;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const existing = byDynasty.get(wf.workflowDynastySlug);
      if (existing) {
        existing.spentUsd += spentUsd;
        existing.clicks += clicks;
        existing.replies += replies;
      } else {
        byDynasty.set(wf.workflowDynastySlug, {
          workflowDynastySlug: wf.workflowDynastySlug,
          workflowDynastyName: wf.workflowDynastyName,
          spentUsd,
          clicks,
          replies,
        });
      }
    }

    const fleetEcon = meanFleetEconomics(perBrandEconomics);
    const todayIso = new Date().toISOString().slice(0, 10);
    const rows = buildWorkflowCostPerOutcome({
      objective,
      rows: [...byDynasty.values()],
      fleetEcon,
      projectedFloor: projectedCostPerOutcome,
    });

    // Best model = cheapest LIFETIME cost-per-outcome among dynasties with the objective's OBSERVED base
    // outcome > 0. A 0-outcome workflow reads its OWN spend (never a cross-workflow average), so it is NOT
    // the best AT producing the outcome — the SAME observed>0 filter the landing headline applies.
    let best: WorkflowCostRow | null = null;
    for (const r of rows) {
      const observed = windowBaseOutcome(objective, r.observedClicks, r.observedPositiveReplies);
      if (observed <= 0 || r.costPerOutcomeUsd == null || r.costPerOutcomeUsd <= 0) continue;
      if (best == null || r.costPerOutcomeUsd < (best.costPerOutcomeUsd as number)) best = r;
    }

    let points: TrendPoint[] = [];
    if (best) {
      // Fetch ONLY the best dynasty's dated spend + dated outcomes (2 calls — request-path-safe), then plot
      // its OWN trailing-window moving average via the SAME builder the pooled trend uses. Never pooled.
      const [spendByDay, dayFields] = await Promise.all([
        fetchDynastySpendByDay(featureSlug, best.workflowDynastySlug),
        fetchPublicEmailStats(featureSlug, "day", undefined, best.workflowDynastySlug),
      ]);
      const outcomesByDay = new Map<string, DayOutcome>();
      for (const [day, fields] of dayFields) {
        if (day === "__total__") continue;
        outcomesByDay.set(day, {
          clicks: fields.recipientsClicked ?? 0,
          replies: fields.recipientsRepliesPositive ?? 0,
        });
      }
      points = buildCostPerOutcomeTrend({
        objective,
        todayIso,
        days,
        windowOutcomes,
        maxLookbackDays: MAX_TREND_LOOKBACK_DAYS,
        spendByDay,
        outcomesByDay,
        fleetEcon,
      });
    }

    return {
      featureSlug,
      objective,
      windowOutcomes,
      bestWorkflowDynastySlug: best?.workflowDynastySlug ?? null,
      bestWorkflowDynastyName: best?.workflowDynastyName ?? null,
      bestWorkflowLifetimeCostPerOutcomeUsd: best?.costPerOutcomeUsd ?? null,
      points,
    };
    },
  });
  res.json(payload);
}

// ── GET /public/stats/cost-per-outcome-lifetime ──────────────────────────────
//
// The staff admin table's "All-time avg" column (extends #485). Cross-org (fleet-wide) LIFETIME pooled
// average cost-per-outcome for EVERY objective in ONE call: total all-history fleet spend ÷ total
// all-history fleet outcomes, projected objectives pushed through the fleet-mean economics. This is the
// window→∞ limit of /public/stats/cost-per-outcome-trend — it reuses the SAME data sources (runs-service
// dated fleet spend + email-gateway dated outcomes) summed over ALL days, so the "All-time avg" is exactly
// where each objective's trend line converges. A true lifetime average can NOT be recovered from the
// moving-average windows (avg-of-windows ≠ lifetime avg), so it is a backend-owned field. Null (never a
// false $0) when the objective's denominator is 0 or its rate is absent.

interface CostPerOutcomeLifetimePayload {
  featureSlug: string;
  /** Pooled all-history cost-per-outcome per objective (websiteVisit / positiveReply = pooled CPC / CPPR;
   * the rest project through the fleet-mean economics). Null where the objective is unbacked. Carries the
   * renamed `websitePurchase` + combined `sales` (the transitional `purchase` alias was dropped once
   * distribute.you migrated to `websitePurchase`). */
  avgCostPerOutcomeByObjective: ObjectiveAverages;
  /** Total cross-org fleet spend (USD, committed) over all dated history. */
  totalSpentUsd: number;
  /** Total cross-org clicks (website visits) over all dated history — the CPC denominator. */
  totalClicks: number;
  /** Total cross-org positive replies over all dated history — the CPPR denominator. */
  totalPositiveReplies: number;
  /** Number of client brands with usable economics that backed the fleet-mean projection. */
  brandCount: number;
}

const costPerOutcomeLifetimeCache: PublicCache = new Map();

/** Test seam — reset the in-memory cost-per-outcome-lifetime cache. */
export function __resetCostPerOutcomeLifetimeCache(): void {
  clearPublicCache(costPerOutcomeLifetimeCache);
}

export async function handleCostPerOutcomeLifetime(
  featureSlug: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const payload = await servedPublicCached<CostPerOutcomeLifetimePayload>({
    cache: costPerOutcomeLifetimeCache,
    key: featureSlug,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "cost-per-outcome lifetime",
    compute: async () => {
    // Goal-bucketed: each objective's pooled all-history cost is summed over ONLY the brands whose
    // optimization goal is relevant to it (the window→∞ limit of the objective's bucketed trend). The
    // SAME per-brand dataset the trend uses. Top-level totals sum ALL bucketable brands (context).
    const dataset = await getFunnelBucketDatasetCached(featureSlug);
    const objectives = buildBucketedLifetimeAverages(dataset);

    let totalSpentUsd = 0;
    let totalClicks = 0;
    let totalPositiveReplies = 0;
    for (const b of dataset) {
      for (const v of b.spendByDay.values()) totalSpentUsd += v;
      for (const o of b.outcomesByDay.values()) {
        totalClicks += o.clicks;
        totalPositiveReplies += o.replies;
      }
    }

    return {
      featureSlug,
      avgCostPerOutcomeByObjective: objectives,
      totalSpentUsd,
      totalClicks,
      totalPositiveReplies,
      brandCount: dataset.length,
    };
    },
  });
  res.json(payload);
}

// ── GET /public/stats/cost-per-outcome-distribution ──────────────────────────
//
// The cross-org DISTRIBUTION (histogram) of an objective's cost-per-outcome across the brands the fleet
// runs — the SPREAD around the average the marketing site renders so the "going rate" reads as a real
// range (cheap tail / bulk / expensive tail), not a single flat number. The distribution UNIT is the
// BRAND: each brand contributes ONE data point = its pooled all-history cost-per-outcome, goal-bucketed
// exactly like the trend + lifetime surfaces (a brand feeds an objective only when its optimization goal
// is in that objective's bucket), so the contributing brand set + central tendency stay coherent with
// those surfaces. Reuses the SAME shared per-brand dataset (getFunnelBucketDatasetCached).
//
// PUBLIC / no-auth → the payload carries ONLY aggregate histogram buckets + summary stats, NEVER a
// per-brand value or id. Empty/soft below MIN_DISTRIBUTION_BRANDS: buckets = [] and every scalar null
// (the consumer shows "not enough data yet") — never a false $0. NOTE the central tendency here is the
// UNWEIGHTED per-brand mean/median (the going rate ACROSS brands); it legitimately differs from
// cost-per-outcome-lifetime's spend-WEIGHTED pooled average (a different, per-brand question).

const DEFAULT_DISTRIBUTION_BUCKETS = 10;
const MAX_DISTRIBUTION_BUCKETS = 50;
/** Fewer than this many brands with a usable cost cannot form a meaningful spread (and would risk
 *  revealing an individual brand's cost on a public surface) → the distribution is returned empty/null. */
const MIN_DISTRIBUTION_BRANDS = 2;

interface CostPerOutcomeDistributionPayload extends CostPerOutcomeDistribution {
  featureSlug: string;
  /** Canonical camelCase objective the distribution is for. */
  objective: string;
  /** The unit each data point represents — a brand's pooled all-history cost-per-outcome. */
  unit: "brand";
  /** Number of equal-width histogram bars requested (the bars may collapse to 1 when all values are equal). */
  bucketCount: number;
}

const costPerOutcomeDistributionCache: PublicCache = new Map();

/** Test seam — reset the in-memory cost-per-outcome-distribution cache. */
export function __resetCostPerOutcomeDistributionCache(): void {
  clearPublicCache(costPerOutcomeDistributionCache);
}

export async function handleCostPerOutcomeDistribution(
  featureSlug: string | undefined,
  objectiveParam: string | undefined,
  bucketsParam: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureSlug) {
    res.status(400).json({ error: "Query parameter 'featureSlug' is required" });
    return;
  }
  const objective = normalizeObjective(objectiveParam);
  if (!objective) {
    res.status(400).json({ error: "Query parameter 'objective' is required (one of the optimization goals)" });
    return;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }

  const parsedBuckets = parseInt(bucketsParam ?? "", 10);
  const bucketCount =
    Number.isFinite(parsedBuckets) && parsedBuckets >= 1
      ? Math.min(parsedBuckets, MAX_DISTRIBUTION_BUCKETS)
      : DEFAULT_DISTRIBUTION_BUCKETS;

  const cacheKey = `cpo-dist:${featureSlug}:${objective}:${bucketCount}`;
  const payload = await servedPublicCached<CostPerOutcomeDistributionPayload>({
    cache: costPerOutcomeDistributionCache,
    key: cacheKey,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "cost-per-outcome distribution",
    compute: async () => {
    // Goal-bucketed: only the brands whose optimization goal is relevant to this objective contribute a
    // data point (a reply-driven brand does not appear in the CPC histogram). SAME dataset as trend/lifetime.
    const dataset = await getFunnelBucketDatasetCached(featureSlug);
    const bucketBrands = bucketBrandsForObjective(dataset, objective);
    const distribution = buildCostPerOutcomeDistribution({
      objective,
      brands: bucketBrands,
      bucketCount,
      minBrands: MIN_DISTRIBUTION_BRANDS,
    });

    return {
      featureSlug,
      objective,
      unit: "brand" as const,
      bucketCount,
      ...distribution,
    };
    },
  });
  res.json(payload);
}

// ── GET /internal/stats/send-forecast ─────────────────────────────────────────

const PAST_WINDOW_DAYS = 7;
const DEFAULT_FORECAST_DAYS = 14;
const MAX_FORECAST_DAYS = 90;

interface SendForecastPayload {
  days: SendForecastDay[];
  summary: SendForecastSummary;
}

const sendForecastCache: PublicCache = new Map();

/** Test seam — reset the in-memory send-forecast cache. */
export function __resetSendForecastCache(): void {
  clearPublicCache(sendForecastCache);
}

/**
 * GET /internal/stats/send-forecast?days=N — GLOBAL (cross-org, fleet-wide) projection of how many
 * outreach emails the fleet will send per calendar day, stacking three email-grain series:
 * past real sends (`actualSent`), already-scheduled in-flight follow-ups (`inFlightSent`), and new
 * budget-driven sequences on the D0/D3/D10 model (`forecastNew`). See send-forecast-compute.ts.
 */
export async function handleSendForecast(daysParam: string | undefined, res: import("express").Response): Promise<void> {
  const parsed = parseInt(daysParam ?? "", 10);
  const days = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, MAX_FORECAST_DAYS) : DEFAULT_FORECAST_DAYS;

  const cacheKey = `send-forecast:${days}`;
  const payload = await servedPublicCached<SendForecastPayload>({
    cache: sendForecastCache,
    key: cacheKey,
    windows: FLEET_AUDIT_WINDOWS,
    label: "send-forecast",
    compute: async () => {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const dates = utcDateRange(addUtcDays(todayIso, -PAST_WINDOW_DAYS), addUtcDays(todayIso, days));

    const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
    const coldSlugs = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug));
    const coldCsv = coldSlugs.join(",");

    // Series 1 (past actuals) + Series 2 (in-flight scheduled) + Series 3 (budget-driven new cohorts).
    const [actualByDay, inFlightByDay, fleet] = await Promise.all([
      coldCsv ? fetchFleetEmailsSentByDay(coldCsv) : Promise.resolve(new Map<string, number>()),
      fetchFleetSendingForecast(),
      aggregateFleetNewSequences(coldSlugs, now),
    ]);

    const built = buildSendForecast({
      dates,
      todayIso,
      totalNewPerDay: fleet.totalNewPerDay,
      todayNewOverride: fleet.todayNewOverride,
      actualByDay,
      inFlightByDay,
      summary: {
        totalDailyBudgetUsd: fleet.totalDailyBudgetUsd,
        remainingTodayUsd: fleet.remainingTodayUsd,
        activeBrandCount: fleet.activeBrandCount,
        totalNewSequencesPerDay: fleet.totalNewPerDay,
      },
    });

    return built;
    },
  });
  res.json(payload);
}

// ── GET /internal/stats/accounts ─────────────────────────────────────────────

// Single global (cross-org) result → a 1-key Map so it uses the SAME shared memo helper as the others.
const accountsCache: PublicCache = new Map();

/** Test seam — reset the in-memory accounts-audit cache. */
export function __resetAccountsCache(): void {
  clearPublicCache(accountsCache);
}

/**
 * GET /internal/stats/accounts — GLOBAL (cross-org, fleet-wide) list of every cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account
 * is truly ACTIVE, plus fleet financial stats (total active daily budget → MRR → ARR). All money +
 * the active determination + MRR/ARR are computed HERE; the admin dashboard renders only. See
 * accounts-compute.ts. Fleet-audit cache windows (60 s fresh, stale-served + refreshed behind the request
 * up to 30 min), same pattern as the other /internal/stats/* audits.
 */
export async function handleAccounts(res: import("express").Response): Promise<void> {
  const payload = await servedPublicCached<AccountsAudit>({
    cache: accountsCache,
    key: "accounts",
    windows: FLEET_AUDIT_WINDOWS,
    label: "accounts audit",
    compute: async () => {
    const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
    const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");

    return buildAccountsAudit(coldCsv, new Date());
    },
  });
  res.json(payload);
}

// ── GET /internal/stats/customer-health ──────────────────────────────────────

/**
 * FRESH window for the fleet health board. A COLD build fans out ~5 heavy composites (audience-stats,
 * revenue, workflow-projection) PER customer across every cold scale-to-zero sibling — tens of seconds.
 * So the board is served from the Gold `feature_view_snapshots` layer, and its freshness is tuned for a
 * slowly-changing FLEET AUDIT, NOT a per-request dashboard cell: a snapshot up to `TTL` old is served
 * instantly with NO recompute; between `TTL` and `MAX_STALE` it is served instantly + a single-flight
 * background refresh is kicked; only beyond `MAX_STALE` does a read recompute synchronously (correct-but-
 * slow ONCE). Documented as-of staleness: the board is at most `MAX_STALE` (10 min) old.
 */
const CUSTOMER_HEALTH_TTL_MS = 120_000; // 2 min — fresh-serve window (no recompute)
const CUSTOMER_HEALTH_MAX_STALE_MS = 600_000; // 10 min — hard cap before a blocking recompute

/**
 * GET /internal/stats/customer-health — GLOBAL (cross-org, fleet-wide) "Customer Success" health board:
 * one ready-composed row per cold-email customer (org × brand), currently-active first, each with a
 * green/yellow/red health badge, identity, recency/retention, optimization goal, conversion-tracker
 * context, breakeven CAC (= LTR), full economics, realized CAC/ROI/%CAC, an audiences rollup + best
 * audience, best workflow, and current status. ALL metrics computed + owned here; the dashboard renders
 * only. See customer-health-compute.ts.
 *
 * Served through the Gold snapshot layer (`servedCached`, `feature_view_snapshots`) as an O(1) indexed
 * read on a warm/stale hit — the slow fleet fan-out runs in the BACKGROUND on the SWR refresh cycle,
 * never on the request path. GLOBAL scope (no per-org key): view="customer-health", scopeKey="global",
 * platform sentinel org. Per-row fail-soft (v0.92.2) lives INSIDE buildCustomerHealthBoard → the
 * background compute still degrades a failing customer, never 500s the persisted snapshot. If the
 * snapshot table is unreachable, servedCached logs loud + falls through to a live compute. `asOf` in the
 * body reflects the snapshot's compute time (the `now` passed at build) = the documented as-of semantic.
 */
export async function handleCustomerHealth(res: import("express").Response): Promise<void> {
  const board = await servedCached<CustomerHealthBoard>({
    view: "customer-health",
    scopeKey: "global",
    orgId: PLATFORM_SCOPE_ORG_ID,
    ttlMs: CUSTOMER_HEALTH_TTL_MS,
    maxStaleMs: CUSTOMER_HEALTH_MAX_STALE_MS,
    compute: async () => {
      const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
      const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");
      return buildCustomerHealthBoard(coldCsv, new Date());
    },
  });
  res.json(board);
}

// ── GET /internal/stats/active-users ─────────────────────────────────────────

const DEFAULT_ACTIVE_USERS_WINDOWS = { days: 90, weeks: 26, months: 12 };
const MAX_ACTIVE_USERS_WINDOWS = { days: 365, weeks: 104, months: 36 };

// Single-flight lives in the shared cache helper — a miss triggers a per-org runs-service fan-out and the
// admin page can double-load, so concurrent same-key callers must join ONE build.
const activeUsersCache: PublicCache = new Map();

/** Test seam — reset the in-memory active-users cache + in-flight guard. */
export function __resetActiveUsersCache(): void {
  clearPublicCache(activeUsersCache);
}

/** Parse an optional trailing-window count: default when absent, clamp to [1, max], 400 on non-numeric. */
function parseWindow(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`invalid window value: ${raw}`);
  return Math.min(n, max);
}

/**
 * GET /internal/stats/active-users — GLOBAL (cross-org, fleet-wide) HISTORY of active users (distinct
 * orgs with an active, funded, non-paused cold-email brand) bucketed monthly / weekly / daily, each with
 * period-over-period growth, plus the LIVE current total (the accounts-audit active-user count). The
 * history is reconstructed from per-day ACTUALIZED cold-email spend (a billed-spend day = the active
 * verdict observed after the fact). Aggregate counts only. See active-users-compute.ts. Fleet-audit cache
 * windows (60 s fresh, stale-served behind a background refresh up to 30 min).
 */
export async function handleActiveUsers(
  query: { days?: string; weeks?: string; months?: string },
  res: import("express").Response,
): Promise<void> {
  let windows: { days: number; weeks: number; months: number };
  try {
    windows = {
      days: parseWindow(query.days, DEFAULT_ACTIVE_USERS_WINDOWS.days, MAX_ACTIVE_USERS_WINDOWS.days),
      weeks: parseWindow(query.weeks, DEFAULT_ACTIVE_USERS_WINDOWS.weeks, MAX_ACTIVE_USERS_WINDOWS.weeks),
      months: parseWindow(query.months, DEFAULT_ACTIVE_USERS_WINDOWS.months, MAX_ACTIVE_USERS_WINDOWS.months),
    };
  } catch {
    res.status(400).json({ error: "days/weeks/months must be positive integers" });
    return;
  }

  const cacheKey = `active-users:${windows.days}:${windows.weeks}:${windows.months}`;
  const payload = await servedPublicCached<ActiveUsersHistory>({
    cache: activeUsersCache,
    key: cacheKey,
    windows: FLEET_AUDIT_WINDOWS,
    label: "active-users history",
    compute: async () => {
      const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
      const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");
      return buildActiveUsersHistory(coldCsv, new Date(), windows);
    },
  });
  res.json(payload);
}

// ── GET /internal/stats/active-users-by-user ─────────────────────────────────

// Single-flight lives in the shared cache helper — a miss triggers a per-org runs-service + client-service
// fan-out and the admin page can double-load, so concurrent callers must join ONE build.
const activeUsersByUserCache: PublicCache = new Map();

/** Test seam — reset the in-memory per-user active-history cache + in-flight guard. */
export function __resetActiveUsersByUserCache(): void {
  clearPublicCache(activeUsersByUserCache);
}

/**
 * GET /internal/stats/active-users-by-user — the PER-USER breakdown of the aggregate active-users
 * history. One row per user (org) EVER active (billed cold-email spend), carrying that user's active
 * months / weeks / days SINCE INCEPTION, a pre-derived summary (first/last active month, first/last
 * active week, retention-window-in-weeks), and current-week / current-month "active at least once"
 * flags for the admin tab counts. Same universe + same "active" notion as GET /internal/stats/active-users.
 * Staff-gated upstream at api-service (per-org rows allowed on this internal surface). Fleet-audit cache
 * windows (60 s fresh, stale-served behind a background refresh up to 30 min).
 */
export async function handleActiveUsersByUser(res: import("express").Response): Promise<void> {
  const payload = await servedPublicCached<ActiveUsersByUser>({
    cache: activeUsersByUserCache,
    key: "active-users-by-user",
    windows: FLEET_AUDIT_WINDOWS,
    label: "active-users by user",
    compute: async () => {
      const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
      const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");
      return buildActiveUsersByUser(coldCsv, new Date());
    },
  });
  res.json(payload);
}

// ── GET /internal/stats/revenue ──────────────────────────────────────────────

const DEFAULT_REVENUE_WINDOWS = { days: 90, weeks: 26, months: 12 };
const MAX_REVENUE_WINDOWS = { days: 365, weeks: 104, months: 36 };

// Single-flight lives in the shared cache helper — a miss triggers a per-org runs-service fan-out and the
// admin page can double-load, so concurrent same-key callers must join ONE build.
const revenueHistoryCache: PublicCache = new Map();

/** Test seam — reset the in-memory revenue-history cache + in-flight guard. */
export function __resetRevenueHistoryCache(): void {
  clearPublicCache(revenueHistoryCache);
}

/**
 * GET /internal/stats/revenue — GLOBAL (cross-org, fleet-wide) HISTORY of realized revenue (summed
 * ACTUALIZED cold-email spend across all orgs) bucketed monthly / weekly / daily, each with period-over-
 * period growth; plus the total since inception, a per-day-since-inception line ("MRR over time"), and the
 * LIVE current MRR (accounts-audit fleet active daily budget × 30). Same universe + same "active = real
 * billed cold-email spend" signal as GET /internal/stats/active-users. Aggregate totals only. Fleet-audit
 * cache windows (60 s fresh, stale-served behind a background refresh up to 30 min).
 */
export async function handleRevenueHistory(
  query: { days?: string; weeks?: string; months?: string },
  res: import("express").Response,
): Promise<void> {
  let windows: { days: number; weeks: number; months: number };
  try {
    windows = {
      days: parseWindow(query.days, DEFAULT_REVENUE_WINDOWS.days, MAX_REVENUE_WINDOWS.days),
      weeks: parseWindow(query.weeks, DEFAULT_REVENUE_WINDOWS.weeks, MAX_REVENUE_WINDOWS.weeks),
      months: parseWindow(query.months, DEFAULT_REVENUE_WINDOWS.months, MAX_REVENUE_WINDOWS.months),
    };
  } catch {
    res.status(400).json({ error: "days/weeks/months must be positive integers" });
    return;
  }

  const cacheKey = `revenue:${windows.days}:${windows.weeks}:${windows.months}`;
  const payload = await servedPublicCached<RevenueHistory>({
    cache: revenueHistoryCache,
    key: cacheKey,
    windows: FLEET_AUDIT_WINDOWS,
    label: "revenue history",
    compute: async () => {
      const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
      const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");
      return buildRevenueHistory(coldCsv, new Date(), windows);
    },
  });
  res.json(payload);
}

// ── GET /public/stats/ranked ─────────────────────────────────────────────────

router.get("/public/stats/ranked", async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitParam) && limitParam >= 1 ? limitParam : 3;
    await handleRanked(req.query.featureSlug as string | undefined, req.query.objective as string | undefined, req.query.groupBy as string | undefined, limit, res);
  } catch (error) {
    console.error("[features-service] Public stats ranked error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/best ───────────────────────────────────────────────────

router.get("/public/stats/best", async (req, res) => {
  try {
    await handleBest(req.query.featureSlug as string | undefined, req.query.groupBy as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public stats best error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/revenue ────────────────────────────────────────────────

router.get("/public/stats/revenue", async (req, res) => {
  try {
    await handlePublicRevenue(
      req.query.featureSlug as string | undefined,
      req.query.groupBy as string | undefined,
      res,
      req.query.rollup === "true",
    );
  } catch (error) {
    console.error("[features-service] Public stats revenue error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/send-forecast (api-key only; staff-gated upstream at api-service) ─────────

router.get("/internal/stats/send-forecast", apiKeyOnly, async (req, res) => {
  try {
    await handleSendForecast(req.query.days as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Internal stats send-forecast error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/accounts (api-key only; staff-gated upstream at api-service) ──────────────

router.get("/internal/stats/accounts", apiKeyOnly, async (_req, res) => {
  try {
    await handleAccounts(res);
  } catch (error) {
    console.error("[features-service] Internal stats accounts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/customer-health (api-key only; staff-gated upstream at api-service) ───────

router.get("/internal/stats/customer-health", apiKeyOnly, async (_req, res) => {
  try {
    await handleCustomerHealth(res);
  } catch (error) {
    console.error("[features-service] Internal stats customer-health error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/active-users (api-key only; staff-gated upstream at api-service) ──────────

router.get("/internal/stats/active-users", apiKeyOnly, async (req, res) => {
  try {
    await handleActiveUsers(
      { days: req.query.days as string | undefined, weeks: req.query.weeks as string | undefined, months: req.query.months as string | undefined },
      res,
    );
  } catch (error) {
    console.error("[features-service] Internal stats active-users error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/active-users-by-user (api-key only; staff-gated upstream at api-service) ──

router.get("/internal/stats/active-users-by-user", apiKeyOnly, async (_req, res) => {
  try {
    await handleActiveUsersByUser(res);
  } catch (error) {
    console.error("[features-service] Internal stats active-users-by-user error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /internal/stats/revenue (api-key only; staff-gated upstream at api-service) ───────────────

router.get("/internal/stats/revenue", apiKeyOnly, async (req, res) => {
  try {
    await handleRevenueHistory(
      { days: req.query.days as string | undefined, weeks: req.query.weeks as string | undefined, months: req.query.months as string | undefined },
      res,
    );
  } catch (error) {
    console.error("[features-service] Internal stats revenue error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/cost-projection ────────────────────────────────────────

router.get("/public/stats/cost-projection", async (req, res) => {
  try {
    await handlePublicCostProjection(req.query.featureSlug as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public stats cost-projection error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/cost-per-outcome-trend ─────────────────────────────────

router.get("/public/stats/cost-per-outcome-trend", async (req, res) => {
  try {
    await handleCostPerOutcomeTrend(
      req.query.featureSlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.days as string | undefined,
      req.query.windowOutcomes as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats cost-per-outcome-trend error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/workflow-cost-per-outcome ──────────────────────────────

router.get("/public/stats/workflow-cost-per-outcome", async (req, res) => {
  try {
    await handleWorkflowCostPerOutcome(
      req.query.featureSlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.windowOutcomes as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats workflow-cost-per-outcome error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/best-model-cost-per-outcome-trend ──────────────────────

router.get("/public/stats/best-model-cost-per-outcome-trend", async (req, res) => {
  try {
    await handleBestModelCostPerOutcomeTrend(
      req.query.featureSlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.days as string | undefined,
      req.query.windowOutcomes as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats best-model-cost-per-outcome-trend error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/cost-per-outcome-lifetime ──────────────────────────────

router.get("/public/stats/cost-per-outcome-lifetime", async (req, res) => {
  try {
    await handleCostPerOutcomeLifetime(req.query.featureSlug as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public stats cost-per-outcome-lifetime error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/cost-per-outcome-distribution ──────────────────────────

router.get("/public/stats/cost-per-outcome-distribution", async (req, res) => {
  try {
    await handleCostPerOutcomeDistribution(
      req.query.featureSlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.buckets as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats cost-per-outcome-distribution error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/workflow-engagement-latency ───────────────────────────

router.get("/public/stats/workflow-engagement-latency", async (req, res) => {
  try {
    await handlePublicWorkflowEngagementLatency(req.query.featureSlug as string | undefined, req.query.groupBy as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public workflow engagement latency error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
