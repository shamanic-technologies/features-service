import { Router } from "express";
import { servedFleetPipelines } from "../lib/fleet-pipelines-served.js";
import { fetchFleetLegCampaignsFor } from "../lib/fleet-leg-campaigns.js";
import { fetchReplyLatencyByCampaignGroups } from "../lib/campaign-next-steps-io.js";
import type { LatencyMetric } from "../lib/campaign-next-steps.js";
import { fetchFleetEmailDelivery, type FleetEmailDelivery } from "../lib/fleet-email-delivery.js";
import { fetchEmailDeliveryByVerdict, type EmailDeliveryByVerdict } from "../lib/email-delivery-by-verdict.js";
import { fetchMeetingBookingGain, type MeetingBookingGain } from "../lib/meeting-booking-gain.js";
import { fetchMeetingBookingBeforeAfter, type MeetingBookingBeforeAfter } from "../lib/meeting-booking-before-after.js";
import { awaitWarmStore } from "../lib/await-warm-store.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature } from "../db/schema.js";
import { listDeclaredChannels, listTriggerCatalogue, loadChannelCatalogue, loadRetiredChannels, type RetiredChannel } from "../lib/channel-declarations-store.js";
import { triggerOutcomeKeyOf, triggerTypeOf, type TriggerType } from "../lib/outcome-vocabulary.js";
import { IncludeInlineQueryError, includeInlineOf, isEntryDoor, TRIGGER_ALIASES, triggerCallable } from "../lib/channel-triggers.js";
import { isTriggerCoded } from "../lib/channel-declarations.js";
import { STATS_REGISTRY } from "../lib/stats-registry.js";
import {
  fetchPublicWorkflows,
  executableDynasties,
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchDynastySpendByDay,
  fetchDynastyBilledSpendByDay,
  fetchPublicWorkflowEngagementLatency,
  fetchPublicJournalistsStats,
  fetchBrandInfoBatch,
  type WorkflowMetadata,
  type EngagementLatencyMetric,
  type CostGroup,
} from "../lib/public-stats-clients.js";
import { fetchLegFleetEvidence, fetchLegFleetMatureEvidence } from "../lib/leg-fleet-evidence.js";
import type { Pricing } from "../lib/pricing.js";
import { fetchFleetPositiveRepliesBySlug } from "../lib/fleet-positive-repliers.js";
import { setReplyCountsOnSlugStats } from "../lib/crm-only-repliers.js";
import { legCutoffIso, legMaturity, legMaturityFigures, outcomeFigures, type LegMaturityFigures, type OutcomeFigures } from "../lib/maturity.js";
import { ledgerRegime, pipeOutcomeKey, type LedgerBookRead } from "../lib/ledger-book.js";
import { ledgerSlugEvidence, pipeWorkflowCosts } from "../lib/ledger-pipe-costs.js";
import { withWorkflowRankingMarks } from "../lib/catalogue-mark-serving.js";
import { rankLegWorkflows, type LegWorkflowRankingRow } from "../lib/leg-workflow-ranking.js";
import {
  buildFleetLegMaturity,
  buildFleetMatureBenchmark,
  rollUpLegEvidenceByDynasty,
  type DynastyLegEvidence,
  type FleetMatureBenchmark,
} from "../lib/fleet-leg-maturity.js";
import { refresherBaseUrl } from "../lib/view-refresher.js";
import {
  meetingBookedPrice,
  pickLegPrice,
  websiteVisitPrice,
  type LegPrice,
  type MeetingPriceArithmetic,
  type OutcomePrice,
} from "../lib/outcome-prices.js";
import { computeMeetingLegFleet, getInternalPipeFleet, MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, type MeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { dynastyOfSlug } from "../lib/workflow-scope.js";
import { internalPipeToStep, onDemandPipeTrigger } from "../lib/pipe-kind.js";
import { effectiveSpendSlugs, type SpendSlugs } from "../lib/feature-scope.js";
import { DEFAULT_ENTRY_RATE_PCT, defaultLegRatePct } from "../lib/default-leg-rates.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import type { PlayCatalogue } from "../lib/plays.js";
import { getOnDemandPipeFleet } from "../lib/on-demand-pipe-fleet.js";
import { fetchLegAssignments } from "../lib/workflow-leg-assignments.js";
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
  fetchFunnelBucketDataset,
  bucketBrandsForObjective,
  mergeSpendByDay,
  mergeOutcomesByDay,
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
import { medianFleetEconomics } from "../lib/stated-economics.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { fetchFleetEmailsSentByDay, fetchFleetSendingForecast } from "../lib/send-forecast-client.js";
import { aggregateFleetNewSequences } from "../lib/send-forecast-aggregate.js";
import {
  buildSendForecast,
  observedDailyThroughput,
  coldEmailOutreachSlugs,
  utcDateRange,
  addUtcDays,
  type SendForecastDay,
  type SendForecastSummary,
} from "../lib/send-forecast-compute.js";
import { buildAccountsAudit, type AccountsAudit } from "../lib/accounts-compute.js";
import { buildActiveUsersHistory, type ActiveUsersHistory } from "../lib/active-users-compute.js";
import { buildRevenueHistory, type RevenueHistory } from "../lib/revenue-history-compute.js";
import { buildActiveUsersByUser, type ActiveUsersByUser } from "../lib/active-users-by-user-compute.js";
import { apiKeyOnly } from "../middleware/auth.js";
import type { FleetReplyRate } from "../lib/org-period-recap.js";
import {
  createStatedAmount,
  deleteStatedAmount,
  listStatedAmounts,
  updateStatedAmount,
  StatedAmountConflictError,
} from "../lib/stated-monthly-amounts-store.js";
import { BrandOwnershipError, assertBrandHeld } from "../lib/brand-ownership.js";
import { computeFeatureRevenue, type DownstreamHeaders } from "./revenue.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel } from "./revenue.js";
import { distinctChannelFunnels } from "./offer-economics.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { FUNNEL_LEG_KEYS, funnelLeg, OUTBOUND_LEG_KEY_CORRESPONDENCE, pipeLegKeyOf } from "../lib/funnel-legs.js";
import { resolvePipeLegKey } from "../lib/unpriced-pipes.js";
import { withChannelType } from "../lib/channel-types.js";
import { fetchFleetLegCampaigns, type FleetLegCampaign } from "../lib/fleet-leg-campaigns.js";
import { fleetPopulationCampaigns } from "../lib/fleet-meeting-population.js";
import type { MeetingPopulation } from "../lib/meeting-population.js";
import { computeWorkflowRevenueGroups } from "../lib/workflow-revenue.js";
import { foldFleetPipelines, type FleetDynastyPipeline, type PairDynastyPipeline } from "../lib/fleet-workflow-return.js";
import {
  channelOutcomeEconomicsOf,
  showcaseOutcomesOf,
  showcaseOutcomesPayloadOf,
  type ShowcaseHeroCounts,
  type ChannelOutcomeEconomics,
  type ShowcaseOutcomesPayload,
} from "../lib/outcome-public-reads.js";
import { fetchPricingFunnelsAllOffers } from "../lib/reading-funnels.js";
import { fetchOrgUserEmails } from "../lib/accounts-client.js";
import { buildBrandChannels, brandFeatureSlugs } from "../lib/brand-channels.js";
import {
  brandReadingFunnels,
  showcaseFunnelOf,
  type ShowcaseBrandFunnels,
  type ShowcaseFunnel,
  type ShowcaseFunnelsPayload,
  type ShowcaseGroup,
  type ShowcaseVendorCost,
} from "../lib/showcase-funnels.js";
import { fetchRunsCostCents } from "../lib/runs-cost-client.js";
import { vendorCoverage, VENDOR_COST_UNKNOWN, type VendorCoverage } from "../lib/public-vendor-cost.js";
import {
  buildShowcaseCandidates,
  furthestRungReached,
  isStaffOnlyOrg,
  pickRecentlyStartedByMeetings,
  pickShowcaseClients,
  SHOWCASE_GROUP_SIZE,
  type ShowcaseGroupPick,
} from "../lib/showcase-clients.js";
import { fetchBrandFirstBilledDay } from "../lib/revenue-history-client.js";
import {
  channelStepCatalogue,
  funnelLegCatalogue,
  salesFunnelCatalogue,
  type PublicChannel,
} from "../lib/channel-catalogue.js";
import { pricePair, type PairResult } from "../lib/channel-funnel-economics.js";
import type { ComposedMinimumCommitment } from "../lib/funnel-commercial-terms.js";
import { readFleetReturnSnapshotSoft, writeFleetReturnSnapshotSoft, type BrandSnapshotRow } from "../lib/fleet-return-store.js";
import type { SalesFunnelKey } from "../lib/sales-funnels.js";
import { withCampaignNames } from "../lib/sales-path-names.js";
import { withPipeIdentities } from "../lib/pipe-identities.js";

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
    pipeFleetReplyLatencyCache,
    goalBucketDatasetCache,
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
    channelCatalogueCache,
    channelFunnelEconomicsCache,
    showcaseFunnelsCache,
  ];
}

/**
 * First email -> first positive reply over EVERY org's campaigns of these pipes (channel x canonical leg, campaign-
 * service's stated `legKey`), since inception (CAMPAIGN-NEXT-STEPS-1018, `lib/campaign-next-steps.ts`). Cross-org and
 * lifetime: served through the lifetime windows (15 min fresh / 6 h stale), keyed on the sorted pipes. A pipe nobody
 * runs reads a zero sample, never a borrowed figure. FAIL-LOUD on a cold key.
 */
export async function readPipeFleetReplyLatency(pipes: ReadonlyArray<{ featureSlug: string; legKey: string }>): Promise<LatencyMetric> {
  const sorted = [...new Map(pipes.map((p) => [`${p.featureSlug}|${p.legKey}`, p])).values()].sort((a, b) => `${a.featureSlug}|${a.legKey}`.localeCompare(`${b.featureSlug}|${b.legKey}`));
  const key = sorted.map((p) => `${p.featureSlug}|${p.legKey}`).join(",");
  return servedPublicCached<LatencyMetric>({
    cache: pipeFleetReplyLatencyCache,
    key,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "pipe fleet reply latency",
    compute: async () => {
      const [campaigns] = await fetchFleetLegCampaignsFor([sorted.map((p) => ({ channelSlug: p.featureSlug, computedLegKey: p.legKey }))]);
      const ids = campaigns.map((c) => c.campaignId);
      if (ids.length === 0) return { averageMs: null, medianMs: null, sampleSize: 0 };
      const groups = await fetchReplyLatencyByCampaignGroups({ fleet: ids });
      return groups.fleet ?? { averageMs: null, medianMs: null, sampleSize: 0 };
    },
  });
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
const pipeFleetReplyLatencyCache: PublicCache = new Map();

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

    res.json({ features: results.map(withChannelType) });
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
 * Build workflow upgrade funnels for aggregation.
 */
export function buildWorkflowDynasties(workflows: WorkflowMetadata[]): Map<string, string[]> {
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

  const dynasties = new Map<string, string[]>();
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

    dynasties.set(wf.workflowSlug, [...slugs]);
  }

  return dynasties;
}

export function aggregateAcrossDynasties(
  dynasties: Map<string, string[]>,
  costGroups: { dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }[],
  outcomeMap: Map<string, Record<string, number>>,
  dimensionKey: string,
  // EXACT cents (no per-slug rounding) — what a MATURE figure reads (`lib/maturity.ts`), so a scope's
  // per-workflow cells add up to the scope's own mature spend to the cent. Omitted → the historical
  // per-slug rounding, byte-identical for every flash figure.
  options: { exactCents?: boolean } = {},
): { costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>; aggregatedOutcomes: Map<string, Record<string, number>> } {
  const perSlugCost = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  for (const group of costGroups) {
    const slug = group.dimensions[dimensionKey];
    if (!slug) continue;
    const cents = Number(group.totalCostInUsdCents);
    perSlugCost.set(slug, { totalCostInUsdCents: options.exactCents ? cents : Math.round(cents), completedRuns: group.runCount });
  }

  const costMap = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  const aggregatedOutcomes = new Map<string, Record<string, number>>();

  for (const [activeSlug, versionSlugs] of dynasties) {
    let totalCost = 0, totalRuns = 0;
    const mergedOutcomes: Record<string, number> = {};

    for (const slug of versionSlugs) {
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

  res.json(await readPublicRanked(featureSlug, requestedObjective ?? "costPerRecipientPositiveReplyCents", groupBy, limit));
}

export interface PublicRankedPayload {
  costBasis: "incurred";
  objective: string;
  sortDirection: "asc" | "desc";
  results: Array<{ brand?: { id: string; name: string | null; domain: string | null }; workflow?: unknown; stats: Record<string, number | null> }>;
}

/**
 * The `/public/stats/ranked` body for an EXISTING feature (validation stays in `handleRanked`), served from the
 * same in-memory cache cell, so an in-process reader (the fleet indexes) and the landing's HTTP read share one compute.
 */
export async function readPublicRanked(
  featureSlug: string,
  objective: string,
  groupBy: "workflow" | "brand",
  limit: number,
): Promise<PublicRankedPayload> {
  const objectiveDef = STATS_REGISTRY[objective];
  const sortDirection = (objectiveDef?.kind === "derived" && objectiveDef.type === "currency") ? "asc" : "desc";
  const cacheKey = `${featureSlug}|${objective}|${groupBy}|${limit}`;
  return servedPublicCached<PublicRankedPayload>({
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
      const dynasties = buildWorkflowDynasties(workflows);
      const agg = aggregateAcrossDynasties(dynasties, costGroups, outcomeMap, "workflowSlug");
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

    return { costBasis: "incurred" as const, objective, sortDirection, results };
    },
  });
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
      const dynasties = buildWorkflowDynasties(workflows);
      const agg = aggregateAcrossDynasties(dynasties, costGroups, outcomeMap, "workflowSlug");
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

    return { costBasis: "incurred" as const, best };
    },
  });
  res.json(payload);
}

// ── The per-brand fleet snapshot the homepage's client pick ranks ────────────────────────────────
//
// For every (org, brand) running a cold-email channel: when it was first billed and the furthest rung its
// funnel reached (one engine pass per pair, minutes across the fleet), written to `fleet_return_snapshots`
// (historical table name) OFF the request path, so the showcase pick costs one indexed SELECT. It used to
// carry each brand's pipeline and spend for the public return medians; those reads are deleted
// (ROI-CONSISTENCY-1103: a return exists only where a value lands).

/** How many (org, brand) engine passes the warm runs at once: each reads a brand's whole lead population. */
const FLEET_SNAPSHOT_PAIR_CONCURRENCY = 4;
/** A snapshot older than this is rebuilt behind the showcase read that found it (still served meanwhile). */
const FLEET_SNAPSHOT_STALE_MS = 60 * 60 * 1000;
/**
 * A single brand's engine pass may not hang the whole warm; a hung fetch never rejects on its own. 300 s: the fleet's
 * biggest brand (Doc Dinners, 2026-10-19) finishes in over 2 minutes under paced lead reads.
 */
const FLEET_SNAPSHOT_BRAND_TIMEOUT_MS = 300_000;
/** How much longer a pass still running at the timeout is awaited, after every other pass finished. */
const FLEET_SNAPSHOT_LATE_WAIT_MS = 600_000;
/** Single-flight guard, per feature slug — a burst of cold reads must kick exactly ONE warm. */
const fleetSnapshotWarmInFlight = new Map<string, Promise<void>>();
/** The floor the first-billed-day read looks back from: earlier than this fleet's first billed dollar by years. */
const FIRST_BILLED_FLOOR_ISO = "2020-01-01T00:00:00.000Z";

/** Test seam — await any in-flight fleet snapshot warm(s) so a follow-up read observes the snapshot. */
export async function __awaitFleetSnapshotWarm(): Promise<void> {
  await Promise.allSettled([...fleetSnapshotWarmInFlight.values()]);
}

/**
 * One (org, brand) pair: the furthest RUNG its funnel reached (`furthestRungReached`, off the engine pass's own
 * `funnelSteps`) and the first UTC day it was billed on the channel. Null when the membership is stale (the brand
 * moved orgs). The first-billed day is SOFT: a blip leaves the brand undated (not a recency candidate), never dated
 * with a stand-in.
 */
async function computePairSnapshot(featureSlug: string, funnel: ReturnType<typeof getFunnel>, orgId: string, brandId: string): Promise<{ brandId: string; outcomeCount: number | null; startedOn: string | null } | null> {
  const headers: DownstreamHeaders = { orgId, featureSlug };
  let outcomeCount: number | null;
  try {
    const body = await computeFeatureRevenue(featureSlug, brandId, undefined, funnel, headers, undefined, undefined, false, "net");
    outcomeCount = furthestRungReached(body.funnelSteps);
  } catch (error) {
    if (error instanceof BrandOwnershipError) {
      console.log(`[features-service] fleet snapshot: skipping stale feature membership featureSlug=${featureSlug}, orgId=${orgId}, brandId=${brandId}`);
      return null;
    }
    throw error;
  }
  let startedOn: string | null = null;
  try {
    startedOn = await fetchBrandFirstBilledDay(orgId, brandId, featureSlug, FIRST_BILLED_FLOOR_ISO);
  } catch (err) {
    console.error(`[features-service] fleet snapshot: first-billed day unreadable for brand ${brandId} (org ${orgId}): it is not a recency candidate:`, err);
  }
  return { brandId, outcomeCount, startedOn };
}

/**
 * Recompute one channel's per-brand rows and persist them. Runs OFF the request path. PER-BRAND RESILIENT: one
 * brand's failed or hung pass is logged loud and contributes no row, rather than aborting the warm.
 */
export async function warmFleetBrandSnapshot(featureSlug: string): Promise<void> {
  const existing = fleetSnapshotWarmInFlight.get(featureSlug);
  if (existing) return existing;

  const run = (async () => {
    const funnel = getFunnel(featureSlug);
    const memberships = await fetchFeatureMemberships(featureSlug);
    const pairs = [...new Map(memberships.map((m) => [`${m.orgId}::${m.brandId}`, { orgId: m.orgId, brandId: m.brandId }])).values()];

    // A pass still running at the timeout is NOT dropped: its own promise is awaited AFTER the others for up to
    // FLEET_SNAPSHOT_LATE_WAIT_MS more. No second pass is started (the first keeps the load).
    const late: Array<{ index: number; orgId: string; brandId: string; pass: ReturnType<typeof computePairSnapshot> }> = [];
    const computed = await mapWithConcurrency(pairs.map((p, index) => ({ ...p, index })), FLEET_SNAPSHOT_PAIR_CONCURRENCY, async ({ orgId, brandId, index }) => {
      const pass = computePairSnapshot(featureSlug, funnel, orgId, brandId);
      try {
        return await withTimeout(pass, FLEET_SNAPSHOT_BRAND_TIMEOUT_MS, `fleet snapshot warm ${featureSlug} brand ${brandId}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Timed out after")) {
          console.warn(`[features-service] fleet snapshot warm: brand ${brandId} (org ${orgId}) still running past ${FLEET_SNAPSHOT_BRAND_TIMEOUT_MS} ms, awaited after the others`);
          late.push({ index, orgId, brandId, pass });
          return null;
        }
        console.error(`[features-service] fleet snapshot warm: brand ${brandId} (org ${orgId}) failed and contributes no row:`, err);
        return null;
      }
    });
    for (const l of late) {
      try {
        computed[l.index] = await withTimeout(l.pass, FLEET_SNAPSHOT_LATE_WAIT_MS, `fleet snapshot warm ${featureSlug} brand ${l.brandId} (late)`);
      } catch (err) {
        console.error(`[features-service] fleet snapshot warm: brand ${l.brandId} (org ${l.orgId}) failed and contributes no row:`, err);
      }
    }

    // A brand claimed by several orgs is ONE brand: ONE beginning (the earliest; `YYYY-MM-DD` sorts lexically) and its
    // rung counts summed (leads are disjoint per org; an upper bound, read only as a `> 0` prefilter).
    const byBrand = new Map<string, { startedOn: string | null; outcomes: number; hasOutcomes: boolean }>();
    for (const c of computed) {
      if (c === null) continue;
      const agg = byBrand.get(c.brandId) ?? { startedOn: null, outcomes: 0, hasOutcomes: false };
      if (c.startedOn !== null && (agg.startedOn === null || c.startedOn < agg.startedOn)) agg.startedOn = c.startedOn;
      if (c.outcomeCount !== null) {
        agg.outcomes += c.outcomeCount;
        agg.hasOutcomes = true;
      }
      byBrand.set(c.brandId, agg);
    }
    const rows: BrandSnapshotRow[] = [...byBrand].map(([brandId, a]) => ({ brandId, startedOn: a.startedOn, outcomeCount: a.hasOutcomes ? a.outcomes : null }));
    await writeFleetReturnSnapshotSoft(featureSlug, rows, new Date());
    console.log(`[features-service] fleet snapshot warm complete for ${featureSlug}: ${rows.length} brand(s) of ${pairs.length} membership pair(s)`);
  })()
    .catch((err) => {
      console.error(`[features-service] fleet snapshot warm failed for ${featureSlug}:`, err);
    })
    .finally(() => {
      fleetSnapshotWarmInFlight.delete(featureSlug);
    });

  fleetSnapshotWarmInFlight.set(featureSlug, run);
  return run;
}

/**
 * Warm every cold-email channel's snapshot, fire-and-forget. Called AFTER `app.listen()` so a deploy fills the
 * snapshot without ever blocking the port bind (this fan-out is O(brands) and takes minutes).
 */
export function warmFleetBrandSnapshotsOnBoot(): void {
  void (async () => {
    try {
      const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
      const slugs = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug));
      // Sequential ACROSS channels: each warm is already an O(brands) fan-out with its own cap.
      for (const slug of slugs) await warmFleetBrandSnapshot(slug);
      // The homepage's client PICKS are derived from the rows this warm just wrote.
      warmShowcaseFunnelsOnBoot();
    } catch (err) {
      console.error("[features-service] fleet snapshot boot warm failed:", err);
    }
  })();
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
// through each brand's STATED conversion economics. Per brand we pick the BEST workflow for EACH metric
// (lowest projected cost) independently, then take the unweighted mean across all client brands. Cross-org,
// no auth. A brand with no usable economics contributes nothing (never an average). Cached in-memory briefly.

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
    // Same dynasty-funnel aggregation as /public/stats/best|ranked and the authed workflow-projection route.
    const [workflows, costGroups, emailStats] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
    ]);

    const dynasties = buildWorkflowDynasties(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(dynasties, costGroups, emailStats, "workflowSlug");

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

    // What each brand STATED on its declared funnels — never its brand-wide record, whose NOT NULL server
    // defaults would stand in for rates nobody stated (see lib/stated-economics.ts). The SAME cached
    // per-brand dataset every other fleet cost surface reads, so they agree on the brand set.
    const perBrandEconomics = (await getFunnelBucketDatasetCached(featureSlug))
      .map((b) => b.stated.overall)
      .filter((stated) => Object.keys(stated).length > 0);

    // Fleet figures across ALL objectives (per-brand best across the fleet unit costs → MEDIAN over brands).
    const { objectives, brandCount } = buildObjectiveAverages(unitCostList, perBrandEconomics);

    return {
      // CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at FULL value here (`lib/cost-basis.ts`).
      // Stated on the wire because this figure shares the words "cost per outcome" with a customer's own
      // dashboard, which answers the CHARGED question and drops comped spend.
      costBasis: "incurred" as const,
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

    const fleetEcon = medianFleetEconomics(bucket.map((b) => b.stated.overall)).economics;
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

    return { featureSlug, objective, windowOutcomes, points, costBasis: "incurred" as const };
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
  /** CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at full value (`lib/cost-basis.ts`). */
  costBasis: "incurred";
  featureSlug: string;
  objective: string;
  /** The trailing-window size (base outcomes) the per-row `recentCostPerOutcomeUsd` moving average targets
   * — the SAME window semantics as /public/stats/cost-per-outcome-trend. */
  windowOutcomes: number;
  workflows: Array<WorkflowCostRow & { maturity: LegMaturityFigures | null }>;
  /**
   * THE BENCHMARK ON THE OBJECTIVE'S LEG, over MATURE workflows only (features-service#1196). Null for an
   * objective with no single leg (a projected one), and until the leg's first background warm has landed.
   */
  fleet: (FleetMatureBenchmark & { measured: boolean; cutoffIso: string | null }) | null;
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

// ── ONE LEG'S FLEET MATURITY PER WORKFLOW (`lib/fleet-leg-maturity.ts`, features-service#1196) ────────
//
// `workflows[].maturity` + `fleet` on this read: each workflow's figures on the leg its objective's outcome
// IS (a positive reply → the conversation leg, a website visit → the visit leg), flash and mature, and the
// benchmark taken over MATURE workflows only. The evidence is the leg's fleet cells (`lib/leg-fleet-evidence.ts`
// + the fleet person cell) — the byte-same evidence a leg-keyed workflow-projection's crossOrg grain reads —
// so it is asked of the REFRESHER, where those cells are already warm, and computed here only when the
// refresher is off or unreachable (a second fleet walk in this process is load on lead-service nobody asked
// for). It is warmed OFF the request path: the landing gives this read eight seconds and a cold fleet cell
// takes minutes, so a read before the first warm serves `maturity: null` / `fleet: null` — "not stated yet",
// never a borrowed figure — and the warm overwrites the cached payload when it lands.

/** The leg an OBSERVED objective's outcome is on. A projected objective walks several legs: none. */
export function objectiveLegKey(objective: string): string | null {
  if (objective === "positiveReply") return "start_to_conversation";
  if (objective === "websiteVisit") return "start_to_website_visit";
  return null;
}

/** One leg's fleet maturity per workflow dynasty — JSON-safe, since the refresher answers it over HTTP. */
export interface FleetLegWorkflowMaturity {
  legKey: string;
  cutoffIso: string | null;
  /** FALSE ⟺ the mature cut could not be made (a pair states no serve date): every mature half is null. */
  measured: boolean;
  byDynasty: Array<[string, LegMaturityFigures]>;
}

/**
 * Roll a leg's per-slug evidence up to workflow dynasties, spend summed EXACTLY, on each version's OWN dynasty
 * (`rollUpLegEvidenceByDynasty`): every version counts, a fully deprecated dynasty included. A cost group no
 * workflow names is logged LOUD with its spend (it is in no dynasty's figure).
 */
function legEvidenceByDynasty(
  featureSlug: string,
  legKey: string,
  workflows: WorkflowMetadata[],
  costGroups: CostGroup[],
  emailStats: Map<string, Record<string, number>>,
): Map<string, DynastyLegEvidence> {
  const { byDynasty, unmapped } = rollUpLegEvidenceByDynasty(workflows, costGroups, emailStats);
  if (unmapped.length > 0) {
    const cents = unmapped.reduce((a, u) => a + u.spentCents, 0);
    console.warn(
      `[features-service] leg evidence ${featureSlug}|${legKey}: ${unmapped.length} workflow slug(s) no workflow of the feature names, $${(cents / 100).toFixed(2)} in no dynasty: ${unmapped.map((u) => u.workflowSlug).join(",")}`,
    );
  }
  return byDynasty;
}

/**
 * ONE LEG'S FLEET EVIDENCE PER WORKFLOW VERSION (slug), flash and mature, before any roll-up: what the fleet leg maturity
 * (and so the leg workflow ranking) rolls up to dynasties, and what the Research studies regroup by template or model
 * (LIVE-RESEARCH-1018), so a study and the ranking read ONE evidence. `pricing` = the spend basis (`gross` = the
 * ranking's; `vendor` / `vendorUnpriced` = the staff actual-cost twins).
 */
export interface FleetLegSlugEvidence {
  legKey: string;
  cutoffIso: string | null;
  workflows: WorkflowMetadata[];
  campaigns: FleetLegCampaign[];
  flash: { costGroups: CostGroup[]; emailStats: Map<string, Record<string, number>> };
  /** Null when the mature cut could not be made. */
  mature: { costGroups: CostGroup[]; emailStats: Map<string, Record<string, number>> } | null;
}

export async function fetchFleetLegSlugEvidence(featureSlug: string, legKey: string, slugs: SpendSlugs = "fed", pricing: Pricing = "gross"): Promise<FleetLegSlugEvidence> {
  const [workflows, flash] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    fetchLegFleetEvidence(featureSlug, legKey, pricing, slugs),
  ]);
  const legSet = new Set(flash.campaigns.map((c) => c.campaignId));
  // Positive replies counted on PEOPLE, the leg's campaigns only — the crossOrg grain's own basis. A fleet
  // read has no requesting pair, so none is swapped in.
  setReplyCountsOnSlugStats(
    flash.emailStats,
    await fetchFleetPositiveRepliesBySlug(featureSlug, { orgId: "", brandId: "", repliers: [] }, legSet),
  );
  const cutoffIso = legCutoffIso(legKey);
  const runsMature = cutoffIso
    ? await fetchLegFleetMatureEvidence(featureSlug, legKey, pricing, cutoffIso, null, legSet, slugs)
    : { costGroups: flash.costGroups, emailStats: flash.emailStats };
  // LEDGER-HISTORY-1024: once the ledger reconciles, every version's figures are its ledger figures, both halves.
  const flashBook = await ledgerRegime(pricing);
  if (flashBook) {
    const outcomeKey = await pipeOutcomeKey(featureSlug, legKey);
    const statKey = legMaturity(legKey).outcomeSignal === "clicked" ? "recipientsClicked" : "recipientsRepliesPositive";
    const onBook = (ev: { costGroups: CostGroup[]; emailStats: Map<string, Record<string, number>> }, read: LedgerBookRead) => {
      const o = ledgerSlugEvidence(ev.costGroups, ev.emailStats, outcomeKey, statKey, legSet, read.book, slugs === "fed");
      if (o.missingOnLedger.length > 0) console.error(`[features-service] ledger ${featureSlug}|${legKey}: runs spend on versions the reconciled ledger does not hold: ${o.missingOnLedger.join(",")}`);
      return { costGroups: o.costGroups, emailStats: o.emailStats };
    };
    const matureBook = cutoffIso ? await ledgerRegime(pricing, cutoffIso) : flashBook;
    const ledgerFlash = onBook(flash, flashBook);
    return {
      legKey,
      cutoffIso,
      workflows,
      campaigns: flash.campaigns,
      flash: ledgerFlash,
      mature: !cutoffIso ? ledgerFlash : matureBook && runsMature ? onBook(runsMature, matureBook) : null,
    };
  }
  const mature = runsMature;
  return {
    legKey,
    cutoffIso,
    workflows,
    campaigns: flash.campaigns,
    flash: { costGroups: flash.costGroups, emailStats: flash.emailStats },
    mature: mature ? { costGroups: mature.costGroups, emailStats: mature.emailStats } : null,
  };
}

/** One leg's fleet maturity, computed IN THIS PROCESS (the refresher, or the server when it is off). */
export async function computeFleetLegWorkflowMaturity(featureSlug: string, legKey: string, slugs: SpendSlugs = "fed", pricing: PipeSpendPricing = "gross"): Promise<FleetLegWorkflowMaturity> {
  const ev = await fetchFleetLegSlugEvidence(featureSlug, legKey, slugs, pricing);
  const { workflows, flash, mature, cutoffIso } = ev;
  const matureBy = mature ? legEvidenceByDynasty(featureSlug, legKey, workflows, mature.costGroups, mature.emailStats) : null;
  const dynastySlugs = [...new Set(workflows.map((w) => w.workflowDynastySlug))];
  return {
    legKey,
    cutoffIso,
    measured: matureBy !== null,
    byDynasty: [...buildFleetLegMaturity(legKey, dynastySlugs, legEvidenceByDynasty(featureSlug, legKey, workflows, flash.costGroups, flash.emailStats), matureBy)],
  };
}

/** Ask the refresher (whose fleet cells are warm) for one leg's maturity; compute here when it cannot. */
/**
 * `slugs` (`lib/feature-scope.ts` `SpendSlugs`): `fed` (default) for the forecasts and outcome prices, `own` for a pipe's
 * own measured cost (`fleetPipeFigures`, the agent catalogue and the leg workflow ranking).
 */
async function fetchFleetLegWorkflowMaturity(featureSlug: string, legKey: string, requested: SpendSlugs = "fed"): Promise<FleetLegWorkflowMaturity> {
  const slugs = effectiveSpendSlugs(featureSlug, requested);
  const base = refresherBaseUrl();
  if (base) {
    try {
      const q = new URLSearchParams({ featureSlug, legKey });
      if (slugs === "own") q.set("slugs", "own");
      const res = await fetch(`${base}/internal/fleet-leg-maturity?${q}`, {
        headers: { "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" },
      });
      if (res.ok) return (await res.json()) as FleetLegWorkflowMaturity;
      console.error(`[features-service] refresher answered ${res.status} for fleet leg maturity ${featureSlug}|${legKey}; computing locally`);
    } catch (error) {
      console.error(`[features-service] refresher unreachable for fleet leg maturity ${featureSlug}|${legKey}; computing locally:`, error);
    }
  }
  return computeFleetLegWorkflowMaturity(featureSlug, legKey, slugs);
}

// Fresh 15 min (the fleet cells' own window); a stored value is served however old until a warm replaces it.
const LEG_MATURITY_FRESH_MS = 15 * 60_000;
// A warm that has not landed in this long is abandoned (loud log) so its single-flight flag clears and the
// next read retries — the stuck-flag failure the recent-rate warm above documents.
const LEG_MATURITY_WARM_TIMEOUT_MS = 10 * 60_000;
const legMaturityStore = new Map<string, { value: FleetLegWorkflowMaturity; computedAt: number }>();
const legMaturityWarmInFlight = new Map<string, Promise<void>>();

function storedLegMaturity(featureSlug: string, legKey: string): FleetLegWorkflowMaturity | null {
  return legMaturityStore.get(`${featureSlug}|${legKey}`)?.value ?? null;
}

/** Warm one leg's maturity in the background when absent or past its fresh window; `landed` re-serves. */
function warmLegMaturity(featureSlug: string, legKey: string, landed: () => void): void {
  const key = `${featureSlug}|${legKey}`;
  const entry = legMaturityStore.get(key);
  if (entry && Date.now() - entry.computedAt < LEG_MATURITY_FRESH_MS) return;
  if (legMaturityWarmInFlight.has(key)) return;
  const warm = withTimeout(fetchFleetLegWorkflowMaturity(featureSlug, legKey), LEG_MATURITY_WARM_TIMEOUT_MS, `fleet leg maturity ${key}`)
    .then((value) => {
      legMaturityStore.set(key, { value, computedAt: Date.now() });
      landed();
    })
    .catch((error) => {
      console.error(`[features-service] fleet leg maturity warm failed (${key}), keeping the previous value:`, error);
    })
    .finally(() => {
      legMaturityWarmInFlight.delete(key);
    });
  legMaturityWarmInFlight.set(key, warm);
}

/** Test seam — await any in-flight leg-maturity warm(s). */
export async function __awaitLegMaturityWarm(): Promise<void> {
  await Promise.all([...legMaturityWarmInFlight.values()]);
}

/** Test seam — reset the in-memory workflow-cost-per-outcome cache. */
export function __resetWorkflowCostPerOutcomeCache(): void {
  clearPublicCache(workflowCostPerOutcomeCache);
  workflowRecentWarmInFlight.clear();
  workflowRecentRateStore.clear();
  legMaturityStore.clear();
  legMaturityWarmInFlight.clear();
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
    const [workflows, costGroups, billedCostGroups, emailStats, perBrandEconomics] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      // The BILLED twin (charged, net) of the same groups: what clients were charged, stated beside the
      // benchmark spend. Nothing divides by it here.
      fetchPublicCosts(featureSlug, "workflowSlug", "net", "charged"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      getFunnelBucketDatasetCached(featureSlug).then((dataset) => dataset.map((b) => b.stated.overall)),
    ]);

    const dynasties = buildWorkflowDynasties(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(dynasties, costGroups, emailStats, "workflowSlug");
    const { costMap: billedCostMap } = aggregateAcrossDynasties(dynasties, billedCostGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    // Roll each active-workflow funnel up to its dynasty (two active heads sharing a dynasty merge).
    const byDynasty = new Map<string, WorkflowGrainInput>();
    for (const [slug, cost] of costMap) {
      const wf = workflowBySlug.get(slug);
      if (!wf) continue;
      const outcomes = aggregatedOutcomes.get(slug) ?? {};
      const spentUsd = cost.totalCostInUsdCents / 100;
      const billedSpentUsd = (billedCostMap.get(slug)?.totalCostInUsdCents ?? 0) / 100;
      const clicks = outcomes.recipientsClicked ?? 0;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const existing = byDynasty.get(wf.workflowDynastySlug);
      if (existing) {
        existing.spentUsd += spentUsd;
        existing.billedSpentUsd = (existing.billedSpentUsd ?? 0) + billedSpentUsd;
        existing.clicks += clicks;
        existing.replies += replies;
      } else {
        byDynasty.set(wf.workflowDynastySlug, {
          workflowDynastySlug: wf.workflowDynastySlug,
          workflowDynastyName: wf.workflowDynastyName,
          spentUsd,
          billedSpentUsd,
          clicks,
          replies,
        });
      }
    }

    // crossOrg is the top grain of the per-workflow cost cascade: a 0-outcome workflow floors to its OWN
    // spend (parent = null in buildWorkflowCostPerOutcome), NOT a cross-workflow pooled average — so no
    // fleet-parent unit cost is computed here.
    const fleetEcon = medianFleetEconomics(perBrandEconomics).economics;
    const todayIso = new Date().toISOString().slice(0, 10);
    const dynastyInputs = [...byDynasty.values()];

    // Build the response for a given per-dynasty recent-rate map. The lifetime cost / spend / clicks /
    // replies come from the (already-fetched, fast) main fan-out; `recentByDynasty` carries the trailing-
    // window moving average (a dynasty absent from the map → null recent, never a false $0).
    // The objective's LEG (null for a projected objective) and its fleet maturity, read from the store at
    // BUILD time so every rebuild (the recent-rate warm, the maturity warm) states the latest one.
    const legKey = objectiveLegKey(objective);
    const buildPayload = (recentByDynasty: Map<string, number | null>): WorkflowCostPerOutcomePayload => {
      const rows = buildWorkflowCostPerOutcome({
        objective,
        rows: dynastyInputs,
        fleetEcon,
        projectedFloor: projectedCostPerOutcome,
        recentByDynasty,
      });
      const legMaturity = legKey ? storedLegMaturity(featureSlug, legKey) : null;
      const byDynasty = legMaturity ? new Map(legMaturity.byDynasty) : null;
      const withMaturity = rows.map((row) => ({ ...row, maturity: byDynasty?.get(row.workflowDynastySlug) ?? null }));
      return {
        // CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at FULL value here (`lib/cost-basis.ts`).
        // Stated on the wire because this figure shares the words "cost per outcome" with a customer's own
        // dashboard, which answers the CHARGED question and drops comped spend.
        costBasis: "incurred" as const,
        featureSlug,
        objective,
        windowOutcomes,
        workflows: withMaturity,
        // The benchmark over the workflows THIS read lists (a best a reader cannot find in the list would
        // name nothing), mature ones only.
        fleet:
          legKey && legMaturity
            ? {
                ...buildFleetMatureBenchmark(
                  legKey,
                  new Map(withMaturity.filter((r) => r.maturity).map((r) => [r.workflowDynastySlug, r.maturity!])),
                ),
                measured: legMaturity.measured,
                cutoffIso: legMaturity.cutoffIso,
              }
            : null,
      };
    };

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
    // The leg's maturity, OFF the request path; when it lands the cached payload is rebuilt around it.
    if (legKey) {
      warmLegMaturity(featureSlug, legKey, () =>
        setPublicCache(
          workflowCostPerOutcomeCache,
          cacheKey,
          buildPayload(getStoredRecentRates(cacheKey) ?? seededRecent ?? new Map()),
          LIFETIME_AGGREGATE_WINDOWS,
        ),
      );
    }

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
      getFunnelBucketDatasetCached(featureSlug).then((dataset) => dataset.map((b) => b.stated.overall)),
    ]);

    const dynasties = buildWorkflowDynasties(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(dynasties, costGroups, emailStats, "workflowSlug");
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

    const fleetEcon = medianFleetEconomics(perBrandEconomics).economics;
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
      // CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at FULL value here (`lib/cost-basis.ts`).
      // Stated on the wire because this figure shares the words "cost per outcome" with a customer's own
      // dashboard, which answers the CHARGED question and drops comped spend.
      costBasis: "incurred" as const,
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
      // CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at FULL value here (`lib/cost-basis.ts`).
      // Stated on the wire because this figure shares the words "cost per outcome" with a customer's own
      // dashboard, which answers the CHARGED question and drops comped spend.
      costBasis: "incurred" as const,
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
      // CROSS-ORG PERFORMANCE BENCHMARK — comped spend counts at FULL value here (`lib/cost-basis.ts`).
      // Stated on the wire because this figure shares the words "cost per outcome" with a customer's own
      // dashboard, which answers the CHARGED question and drops comped spend.
      costBasis: "incurred" as const,
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

    // Series 1 (past actuals) + Series 2 (in-flight due, plus the fleet's send capacity, on one
    // payload) + Series 3 (budget-driven new cohorts).
    const [actuals, sending, fleet] = await Promise.all([
      coldCsv
        ? fetchFleetEmailsSentByDay(coldCsv)
        : Promise.resolve({ sentByDay: new Map<string, number>(), createdByDay: new Map<string, number>() }),
      fetchFleetSendingForecast(),
      aggregateFleetNewSequences(coldSlugs, now),
    ]);

    const built = buildSendForecast({
      dates,
      todayIso,
      dailyCapacity: sending.dailyCapacity,
      // What the fleet ACTUALLY sends on a sending day, measured from series 1 — the capacity above
      // is only the ceiling it is bounded by. See send-forecast-compute.ts.
      observedThroughput: observedDailyThroughput(actuals.sentByDay, todayIso),
      totalNewPerDay: fleet.totalNewPerDay,
      todayNewOverride: fleet.todayNewOverride,
      actualByDay: actuals.sentByDay,
      createdByDay: actuals.createdByDay,
      inFlightByDay: sending.scheduledByDay,
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

    // Per-org reads fail-SOFT (2026-10-03): one org's billing timeout degrades THAT org's row to
    // status "unknown" and is named in `unreadOrgReads`, never a 500 of the whole staff page.
    // churnFromBilling (BOARD-CHURNED-TRIAL-1016): a cancelled account reads "churned", from the same
    // billing fleet read the MRR already makes (shared, no extra call).
    return buildAccountsAudit(coldCsv, new Date(), undefined, { recurringRevenue: true, orgReadsFailSoft: true, churnFromBilling: true });
    },
  });
  res.json(payload);
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

// ── The public acquisition-channel catalogue + per-pair economics ────────────────────────────────────
//
// Two NO-AUTH reads, because the marketing site is generated from them and must never be able to drift
// from what we actually charge and actually measured:
//
//   GET /public/channels                  — every acquisition channel, its commercial terms, and the
//                                           kinds of step it can produce (plus the funnels that follow).
//   GET /public/channel-funnel-economics  — one row per (sales funnel, channel) PAIR: either its
//                                           measured economics or an explicit "not enough data".
//
// A customer buys a PAIR. The same funnel costs a very different amount through a phone channel than
// through paid search, so neither a brand-level nor a channel-level aggregate can answer this, and the
// site prints one row per pair.

const channelCatalogueCache: PublicCache = new Map();
const channelFunnelEconomicsCache: PublicCache = new Map();

/** Test seam — reset the acquisition-channel catalogue + per-pair economics caches. */
export function __resetChannelCatalogueCache(): void {
  clearPublicCache(channelCatalogueCache);
  clearPublicCache(channelFunnelEconomicsCache);
  clearPublicCache(channelOutcomeEconomicsCache);
}

async function loadPublishedChannels(): Promise<PublicChannel[]> {
  // Seeded channels + every PUBLISHED run-time declaration (`lib/channel-declarations.ts`).
  return (await loadChannelCatalogue({ publishedOnly: true })).channels;
}

interface ChannelCataloguePayload {
  /** Fleet email delivery (`lib/fleet-email-delivery.ts`): the share of our sent emails the recipient server accepted. */
  emailDelivery: FleetEmailDelivery;
  /** Delivery split by the verifier verdict the address had at send (`lib/email-delivery-by-verdict.ts`). */
  emailDeliveryByVerdict: EmailDeliveryByVerdict;
  /** AI Meeting Booking vs the client's own team on Positive reply -> Meeting booked (`lib/meeting-booking-gain.ts`). */
  meetingBookingGain: MeetingBookingGain;
  /** AI Meeting Booking before vs after go-live, per brand + fleet (`lib/meeting-booking-before-after.ts`). */
  meetingBookingBeforeAfter: MeetingBookingBeforeAfter;
  channels: PublicChannel[];
  /** The RETIRED channels (superseded or deprecated), for DESCRIBING past campaigns: name, icon, legs. Never offered. */
  retiredChannels: RetiredChannel[];
  /** EVERY declared sales funnel, mirrored from brand-service, whether or not a channel sells it today.
   *  Each states the STEP IT STARTS ON in the same vocabulary a channel's `producibleSteps` use, so
   *  "which funnels does this outcome lead into" is a lookup in this payload rather than a translation
   *  table the consumer keeps (and lets go stale). */
  funnels: ReturnType<typeof salesFunnelCatalogue>;
  /** The LEG vocabulary — every leg of every declared funnel, each with its ONE canonical
   *  identifier, the two steps it connects, and the funnels it is a leg of. Performance is measured
   *  per leg and a campaign is bought per leg, so this is the list a consumer keys on; the funnels
   *  a leg lists OVERLAP (a shared leg is on several) and their figures must never be summed. */
  legs: ReturnType<typeof funnelLegCatalogue>;
  /** The step vocabulary itself, so a consumer never hardcodes it to join a channel's legs against a
   *  funnel's. It spans EVERY step of every funnel, not only the ones a funnel can start from — a channel
   *  that performs an internal leg names the step it moves a lead OUT of, and that step is never one. */
  steps: ReturnType<typeof channelStepCatalogue>;
  /** THE OUTCOME CATALOGUE (owner 2026-10-15, `lib/outcome-vocabulary.ts`): the same rows as `steps` (a valued result
   *  a person reaches), each with its plural label. `steps` stays for its readers until they move. */
  outcomes: ReturnType<typeof channelStepCatalogue>;
  /** The LOCKED outbound leg rename (`lib/funnel-legs.ts`): legacy key <-> new key, outbound channels only.
   *  Wave 2: an outbound channel's leg is stored and served in the new key (`lib/served-leg-keys.ts`); a
   *  consumer joining a key from campaign-service or billing still matches both spellings through this list. */
  legKeyCorrespondence: typeof OUTBOUND_LEG_KEY_CORRESPONDENCE;
  /** THE TRIGGER CATALOGUE (`lib/channel-triggers.ts` + `channel_trigger_types` + one generated "⚡ <outcome>" per
   *  outcome lacking one, `listTriggerCatalogue`): what a reactive leg's `triggerId` names, with its label, icon, type
   *  (`outcome` | `condition`), the outcome it reports and whether a caller may fire it. */
  triggers: PublicChannelTrigger[];
  /** ONE TRIGGER PER FACT (`TRIGGER_ID_MERGES`, `lib/channel-triggers.ts`): a merged trigger id and the one trigger it
   *  resolves to. Never in `triggers[]` and never on a pipe; a caller reporting an occurrence under the old id is
   *  recorded and fired as the target (campaign-service). */
  triggerAliases: ReadonlyArray<{ id: string; mergedInto: string }>;
}

interface PublicChannelTrigger {
  id: string;
  label: string;
  description: string;
  icon: string;
  fromStep: string | null;
  firedBy: string;
  coded: boolean;
  /** `code` (stated in `lib/channel-triggers.ts`) or `declared` (created at run time). */
  origin: "code" | "declared";
  /** `event` | `delay` (N days after a step, if nothing happened) | `poll` (a new item at a source) | `reported` (a caller reports it). */
  kind: "event" | "delay" | "poll" | "reported" | "github_issue_in_prod" | "any_of";
  params: Record<string, unknown> | null;
  /** `outcome` ("⚡ <outcome>": a person just reached `outcomeKey`) or `condition` (computed by us). */
  type: TriggerType;
  /** The outcome an outcome trigger reports; null on a condition trigger. */
  outcomeKey: string | null;
  /** A caller (API / MCP / Copilot) may fire it through campaign-service's door. False only for what we compute. */
  callable: boolean;
}

async function loadChannelTriggers(): Promise<PublicChannelTrigger[]> {
  return (await listTriggerCatalogue()).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    icon: t.icon,
    fromStep: t.fromStep,
    firedBy: t.firedBy,
    coded: isTriggerCoded(t),
    origin: t.origin ?? "code",
    kind: t.kind ?? "event",
    params: t.params ?? null,
    type: triggerTypeOf(t),
    outcomeKey: triggerOutcomeKeyOf(t),
    callable: triggerCallable(t),
  }));
}

/** Test/write seam: a declaration write drops the cached public catalogue so the next read shows it. */
export function invalidateChannelCatalogue(): void {
  clearPublicCache(channelCatalogueCache);
}

/**
 * `includeInline` (2026-10-16): `triggers[]` lists ENTRY DOORS only (`isEntryDoor`: an outside reader, an agent, the
 * dashboard is never offered `on_demand` / `lead_requested`); `true` adds the inline ones for our own services
 * (campaign-service validates every declared trigger at its door). One cached build, filtered at serve.
 */
export async function handlePublicChannels(res: import("express").Response, includeInline = false): Promise<void> {
  const payload = await servedPublicCached<ChannelCataloguePayload>({
    cache: channelCatalogueCache,
    key: "catalogue",
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "acquisition-channel catalogue",
    compute: async () => {
      const channels = await withPipeIdentities(await withCampaignNames(await loadPublishedChannels()));
      return {
      channels,
      // Describes past campaigns only: an unreadable list is logged and served empty, never a 500 on the live catalogue.
      retiredChannels: await loadRetiredChannels().catch((err: Error) => {
        console.error(`[features-service] retired channels unreadable (served empty): ${err.message}`);
        return [];
      }),
      funnels: salesFunnelCatalogue(),
      legs: funnelLegCatalogue(channels),
      steps: channelStepCatalogue(),
      outcomes: channelStepCatalogue(),
      legKeyCorrespondence: OUTBOUND_LEG_KEY_CORRESPONDENCE,
      triggers: await loadChannelTriggers(),
      triggerAliases: TRIGGER_ALIASES,
      emailDelivery: await fetchFleetEmailDelivery(),
      emailDeliveryByVerdict: await fetchEmailDeliveryByVerdict(),
      meetingBookingGain: await fetchMeetingBookingGain(),
      meetingBookingBeforeAfter: await fetchMeetingBookingBeforeAfter(),
      };
    },
  });
  res.json(includeInline ? payload : { ...payload, triggers: payload.triggers.filter(isEntryDoor) });
}

/** One (channel × funnel) pair. It carries the pair's MINIMUM RUN LENGTH already composed
 *  (`ComposedMinimumCommitment`), read straight off the catalogue entry this row was built from, so a
 *  pair row and the `/public/channels` entry for the same pair can never state two answers. */
interface ChannelFunnelPairRow extends ComposedMinimumCommitment {
  channelSlug: string;
  channelName: string;
  funnelKey: SalesFunnelKey;
  funnelName: string;
  /** The funnel's steps in order, so a row renders without the consumer knowing the catalogue. */
  funnelSteps: readonly string[];
  result: PairResult;
}

// One channel's dataset build is already single-flighted and cached per slug; this only bounds how many
// distinct channels build at once so a cold catalogue read does not burst the fan-out at the siblings.
const CHANNEL_PAIR_CONCURRENCY = 6;

/**
 * Price every (funnel, channel) pair for these channels.
 *
 * Evidence comes from the SAME per-brand cross-org dataset every other public cost surface reads
 * (`getFunnelBucketDatasetCached`), so a per-pair figure and the fleet cost surfaces cannot disagree
 * about what a channel has spent or produced. A channel nobody has run yet has an empty dataset, which
 * is exactly the "not enough data" answer — reached by the data being absent, never by a special case.
 */
async function buildChannelFunnelEconomics(channels: readonly PublicChannel[]): Promise<ChannelFunnelPairRow[]> {
  const perChannel = await mapWithConcurrency(channels, CHANNEL_PAIR_CONCURRENCY, async (channel) => {
    const dataset = await getFunnelBucketDatasetCached(channel.slug);

    let totalSpentUsd = 0;
    let websiteVisitsProduced = 0;
    let conversationsProduced = 0;
    for (const brand of dataset) {
      for (const spend of brand.spendByDay.values()) totalSpentUsd += spend;
      for (const day of brand.outcomesByDay.values()) {
        websiteVisitsProduced += day.clicks;
        conversationsProduced += day.replies;
      }
    }

    // A unit cost only exists once the step it divides by has actually been produced. Null is "we have
    // not seen one of these yet", never 0 (which would say the step is free).
    const unitCosts = {
      clickUsd: websiteVisitsProduced > 0 ? totalSpentUsd / websiteVisitsProduced : null,
      replyUsd: conversationsProduced > 0 ? totalSpentUsd / conversationsProduced : null,
    };
    return channel.salesFunnels.map((funnel): ChannelFunnelPairRow => {
      // THE MEDIAN OF WHAT THE BRANDS RUNNING THIS CHANNEL STATED ON THIS FUNNEL — never a mean (one
      // brand far from the rest carried it), never their brand-wide record (whose NOT NULL server
      // defaults would stand in for rates nobody stated). A brand that stated nothing on this funnel
      // contributes no data point. See lib/stated-economics.ts.
      const fleet = medianFleetEconomics(
        dataset.map((b) => b.stated.byFunnel[funnel.key] ?? {}),
      );
      const evidence = { totalSpentUsd, conversationsProduced, websiteVisitsProduced, brandCount: fleet.brandCount };
      return {
        channelSlug: channel.slug,
        channelName: channel.name,
        funnelKey: funnel.key,
        funnelName: funnel.name,
        funnelSteps: funnel.steps,
        funnelMinimumCommitmentDays: funnel.funnelMinimumCommitmentDays,
        effectiveMinimumCommitmentDays: funnel.effectiveMinimumCommitmentDays,
        governedBy: funnel.governedBy,
        result: pricePair({
          funnelKey: funnel.key,
          unitCosts,
          economics: fleet.economics,
          lifetimeRevenueUsd: fleet.lifetimeRevenueUsd,
          evidence,
        }),
      };
    });
  });

  return perChannel.flat();
}

interface ChannelFunnelEconomicsPayload {
  /** The channel this read was narrowed to, or null for the whole catalogue. */
  channelSlug: string | null;
  pairs: ChannelFunnelPairRow[];
}

export async function handleChannelFunnelEconomics(
  channelSlug: string | undefined,
  res: import("express").Response,
): Promise<void> {
  const channels = await loadPublishedChannels();

  if (channelSlug) {
    // An unknown channel is a 404 naming what was asked for — never an empty pair list, which a consumer
    // would read as "this channel sells through nothing".
    const known = channels.some((c) => c.slug === channelSlug);
    if (!known) {
      res.status(404).json({ error: `Acquisition channel not found: "${channelSlug}"` });
      return;
    }
  }

  const payload = await servedPublicCached<ChannelFunnelEconomicsPayload>({
    cache: channelFunnelEconomicsCache,
    key: channelSlug ?? "__all__",
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "channel-funnel economics",
    compute: async () => ({
      channelSlug: channelSlug ?? null,
      pairs: await buildChannelFunnelEconomics(
        channelSlug ? channels.filter((c) => c.slug === channelSlug) : channels,
      ),
    }),
  });
  res.json(payload);
}

/** One channel's per-outcome / per-leg PROJECTED economics (wave C4). Read off the SAME pair rows the
 *  funnel-keyed read computes (same dataset cache), re-keyed on outcomes and legs. */
interface ChannelOutcomeEconomicsPayload {
  channelSlug: string | null;
  channels: ChannelOutcomeEconomics[];
}

const channelOutcomeEconomicsCache: PublicCache = new Map();

/** Test seam — reset the per-outcome channel economics cache. */
export function __resetChannelOutcomeEconomicsCache(): void {
  clearPublicCache(channelOutcomeEconomicsCache);
}

export async function handleChannelOutcomeEconomics(
  channelSlug: string | undefined,
  res: import("express").Response,
): Promise<void> {
  const channels = await loadPublishedChannels();
  if (channelSlug && !channels.some((c) => c.slug === channelSlug)) {
    res.status(404).json({ error: `Acquisition channel not found: "${channelSlug}"` });
    return;
  }
  const scope = channelSlug ? channels.filter((c) => c.slug === channelSlug) : channels;
  const payload = await servedPublicCached<ChannelOutcomeEconomicsPayload>({
    cache: channelOutcomeEconomicsCache,
    key: channelSlug ?? "__all__",
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "channel-outcome economics",
    compute: async () => {
      const pairs = await buildChannelFunnelEconomics(scope);
      return {
        channelSlug: channelSlug ?? null,
        channels: scope.map((c) => channelOutcomeEconomicsOf(c, pairs.filter((p) => p.channelSlug === c.slug))),
      };
    },
  });
  res.json(payload);
}

// ── Showcase funnel counts (public, org-less, allowlisted brands) ────────────
//
// The homepage's three named clients, each walked down its own funnel. See lib/showcase-funnels.ts
// for the whole doctrine: the brands are the SERVICE's decision, the answer is COUNTS only, and a
// step nobody reached is still a step.
//
// ── HOW A BRAND'S ORG IS RESOLVED WITHOUT A CALLER ──────────────────────────────────────────────
//
// Every downstream read here is org-scoped (`x-org-id`), and this route has no session. So the org
// is resolved the way the cross-org revenue read already resolves it: lead-service's feature
// memberships enumerate which (org, brand) pairs actually have leads, and the OWNING org's identity
// is what is forwarded to the existing /orgs/* reads. Nothing is guessed, and a brand with no
// membership says so rather than being read under some plausible stand-in.
//
// ── ONE BRAND'S FAILURE IS ONE BRAND'S FAILURE ──────────────────────────────────────────────────
//
// A per-brand read that throws nulls THAT brand's chains with `read_failed` and is logged loud; the
// other two still answer. This is a marketing page — one degraded client must not blank the section
// — and the degradation is stated on the wire rather than dressed as zeros.
const showcaseFunnelsCache: PublicCache = new Map();

/** Test seam — reset the showcase funnel-counts cache (entries + in-flight). */
export function __resetShowcaseFunnelsCache(): void {
  clearPublicCache(showcaseFunnelsCache);
}

/** How many showcase brands are read at once. Three today; the bound is about the downstream fan-out
 *  each one drives (leads, runs, brand, email-gateway), not about the list's length. */
const SHOWCASE_BRAND_CONCURRENCY = 2;

/** The recent group walks deeper: it looks for 3 clients with a booked meeting, rarer than any rung
 *  (prod 2026-10-19: 20 dated clients with a rung past the base). It stops once 3 are found. */
const SHOWCASE_MAX_RECENT_WALKS = 30;

/** Walk every funnel one showcase brand's campaigns sell, under the org that owns its leads. */
async function computeShowcaseBrand(
  brandId: string,
  orgId: string | undefined,
  info: { name: string | null; domain: string | null } | undefined,
): Promise<WalkedShowcaseBrand> {
  const brand = { id: brandId, name: info?.name ?? null, domain: info?.domain ?? null };
  if (!orgId) {
    return { entry: { brand, funnels: [], measured: false, unmeasuredReason: "no_lead_membership" }, heroCounts: null };
  }

  const headers: DownstreamHeaders = { orgId };
  // Which channels the brand runs (the feature scope its evidence is read over).
  const rows = await fetchBrandCampaignRows(brandId, undefined, { orgId });
  const channels = buildBrandChannels(rows);
  if (channels.length === 0) {
    return { entry: { brand, funnels: [], measured: false, unmeasuredReason: "brand_has_no_channels" }, heroCounts: null };
  }
  // Which paths it sells through = the reading paths of the LEGS its campaigns perform, every offer —
  // the same set every pricing read resolves (wave C3: the funnel a campaign row stated is retired).
  // An unreadable leg economics read fails loud and lands on this brand's `read_failed`.
  const soldFunnels = brandReadingFunnels(await fetchPricingFunnelsAllOffers(brandId, orgId));
  if (soldFunnels.length === 0) {
    return { entry: { brand, funnels: [], measured: false, unmeasuredReason: "no_funnel_sold" }, heroCounts: null };
  }

  const featureSlugs = brandFeatureSlugs(channels);
  // The funnel DEFINITION the brand's channels price on — the registry's, not the campaign's stated
  // key. A channel that declares none contributes nothing; several different ones cannot happen today
  // and would mean the brand's evidence cannot be walked as one chain, so the read says so.
  const distinct = distinctChannelFunnels(channels);
  if (distinct.length > 1) {
    throw new Error(`showcase brand ${brandId} runs channels that price on different funnel definitions`);
  }
  const funnel = distinct[0] ?? null;

  // The funnels (each carrying the offer's terms) are read ONCE and shared by every chain. They do not
  // move a single COUNT — the chain's rungs are people, not money — but the engine needs priced economics
  // to take the priced path rather than the cold-start short-circuit, which reads every statement-backed
  // rung as UNMEASURED (an offer stating no lifetime revenue now lands there: no average stands in).
  // The ownership check rides beside it.
  const declaredFunnels = funnel
    ? (await Promise.all([fetchDeclaredFunnelsSoft(brandId, orgId), assertBrandHeld(brandId, headers)]))[0]
    : [];

  const funnels: ShowcaseFunnel[] = [];
  // The hero's two counts (positive replies, meetings booked) are PERSON flags of the brand's whole
  // lead population, the same on every funnel-narrowed pass: taken off the first one that walked.
  let heroCounts: ShowcaseHeroCounts | null = null;
  for (const funnelKey of soldFunnels) {
    const brandPriced = funnel ? priceOnDeclaredFunnel(declaredFunnels, funnelKey) : undefined;
    // The byte-same call the brand revenue read makes for its own body: the brand's
    // whole channel set, no campaign narrowing, ONE engine pass, the named funnel walked.
    //
    // `includeSpend` is TRUE even though nothing here is money, and that is load-bearing: the per-lead
    // SIGNUP / FORM-SUBMISSION attribution sets are fetched on that flag alone, so the cheaper read
    // would leave the middle rung of a website funnel permanently NULL — a gate excluding the very
    // funnel one of the showcase brands sells. A rung we could have measured must not read as one we
    // could not. The extra reads it buys are discarded; three brands behind a 15-minute window pay for
    // them once.
    const body = await computeFeatureRevenue(
      featureSlugs,
      brandId,
      undefined,
      funnel,
      headers,
      undefined,
      brandPriced,
      true,
      // VENDOR (owner 2026-10-31, PUBLIC-VENDOR-COST-1031: « afficher le cost réel, si on enlève notre markup depuis
      // le début »): a visitor reads what each outcome really cost to produce, before our markup, whole history; the
      // client's own dashboard keeps what they paid. Supersedes the NET basis of 2026-10-19. The counts are untouched.
      "vendor",
      funnelKey,
      undefined, // offerId: the brand grain
      undefined, // customerStepCosts: read here
      undefined, // causes: our wins priced (default)
      undefined, // workflowScope: the whole brand
      undefined, // datedSpend: the billed committed spend (default)
      false, // brandLevelSpend
      undefined, // perOfferPricing
      undefined, // listedOrganizationKeys
      // COUNT ONLY OUR WINS (owner 2026-10-29, SHOWCASE-OUR-WINS-1029): every person count this card
      // prints (each rung, positive replies, meetings booked) keeps only the outcomes our outreach
      // caused, per lead-service's stored verdict. Doc Dinners' CRM imported 149 meetings, 7 of them
      // after our email to that person.
      true,
    );
    // The money half rides the SAME body: each rung already carries what it cost.
    if (body.funnelSteps) funnels.push(showcaseFunnelOf(body.funnelSteps));
    if (heroCounts === null && body.funnelSteps) {
      heroCounts = {
        positiveReplies: body.recipientsRepliesPositive.total,
        // lead-service's statements unreadable (`counts` null) → no verdict to count meetings on: null.
        meetingsBooked: body.outcomeCauses.counts === null ? null : body.meetingsBooked.total,
        committedSpentCents: body.funnelSteps.committedSpentCents,
      };
    }
  }

  // Billed spend with no known vendor cost must never make the card read cheap (`lib/public-vendor-cost.ts`): past the
  // tolerance every money figure of the brand is null + `vendor_cost_unknown`; the counts stand.
  const coverage = await brandVendorCoverage(brandId, featureSlugs, headers);
  const vendorCost: ShowcaseVendorCost = {
    unpricedSharePct: coverage.unpricedSharePct,
    moneyUnavailableReason: coverage.servable ? null : VENDOR_COST_UNKNOWN,
  };
  if (!coverage.servable) {
    console.warn(
      `[features-service] showcase brand ${brandId}: ${coverage.unpricedSharePct.toFixed(2)}% of its billed spend has no vendor cost, its money figures are withheld`,
    );
  }
  const shownFunnels = coverage.servable ? funnels : funnels.map(withoutMoney);

  return {
    entry: {
      brand,
      funnels: shownFunnels,
      measured: funnels.length > 0,
      // The chain resolves for every funnel the campaigns state, so an empty list here means the engine
      // could not walk one — the same "we could not read this" a per-rung null says, one level up.
      unmeasuredReason: funnels.length > 0 ? null : "read_failed",
      vendorCost,
    },
    heroCounts: heroCounts && !coverage.servable ? { ...heroCounts, committedSpentCents: null } : heroCounts,
  };
}

/** One showcase brand's vendor cost coverage over the channels its card reads (`lib/public-vendor-cost.ts`). */
async function brandVendorCoverage(brandId: string, featureSlugs: string[], headers: DownstreamHeaders): Promise<VendorCoverage> {
  const [vendor, unpriced, billed] = await Promise.all([
    fetchRunsCostCents(brandId, undefined, featureSlugs, headers, "vendor"),
    fetchRunsCostCents(brandId, undefined, featureSlugs, headers, "vendorUnpriced"),
    fetchRunsCostCents(brandId, undefined, featureSlugs, headers, "gross"),
  ]);
  // Billed = what clients were charged + the unpriced rows (most are comped sends, absent from the charged total).
  return vendorCoverage(vendor.committedCents / 100, unpriced.committedCents / 100, (billed.committedCents + unpriced.committedCents) / 100);
}

/** PURE. A walked chain with every money figure withheld (its counts kept). */
function withoutMoney(f: ShowcaseFunnel): ShowcaseFunnel {
  return { ...f, steps: f.steps.map((st) => ({ ...st, costPerReachUsd: null })) };
}

/** One walked showcase brand: its funnel-keyed entry and its positive-reply / meeting-booked person counts
 *  (the hero card's two figures). */
interface WalkedShowcaseBrand {
  entry: ShowcaseBrandFunnels;
  heroCounts: ShowcaseHeroCounts | null;
}

/** Both showcase payloads, built by ONE walk and cached as ONE cell, so the two vocabularies can never
 *  name different clients or state different figures. */
interface ShowcasePayloads {
  funnels: ShowcaseFunnelsPayload;
  outcomes: ShowcaseOutcomesPayload;
}

/**
 * Fill the showcase cell OFF the request path, at boot.
 *
 * The consumer is a statically-rendered marketing page that gives this read EIGHT SECONDS and drops
 * the section rather than block a build. A COLD cell costs three brands' worth of engine passes —
 * minutes — so the first reader after a deploy or a quiet night would get nothing at all, and the
 * page would fall back to the frozen literals this read exists to replace. Warming at boot means the
 * cell is never cold in practice, and every later read is served from it while it refreshes behind
 * the response (`LIFETIME_AGGREGATE_WINDOWS`, single-flighted).
 *
 * Fired AFTER `app.listen()` and never awaited: awaiting an O(brands) fan-out before the port binds
 * fails the deploy health check and rolls the service back.
 */
export function warmShowcaseFunnelsOnBoot(): void {
  void computeShowcasePayloads()
    .then((payload) => {
      setPublicCache(showcaseFunnelsCache, "__showcase__", payload, LIFETIME_AGGREGATE_WINDOWS);
    })
    .catch((err) => {
      console.error("[features-service] showcase funnels boot warm failed:", err);
    });
}

/**
 * The whole payload: the PICKED group and the clients it names, one brand's failure isolated.
 *
 * THE PICK COSTS ONE INDEXED SELECT PER CHANNEL: the per-brand engine passes already happened, off the request
 * path, in the fleet snapshot warm; this reads the rows they wrote. See `lib/showcase-clients.ts`.
 */
/** The candidate brands every claiming org of which is a staff test org (all members staff). */
async function staffOnlyBrandIds(
  brandIds: readonly string[],
  orgsByBrand: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Set<string>> {
  const orgIds = [...new Set(brandIds.flatMap((id) => [...(orgsByBrand.get(id) ?? [])]))];
  const verdicts = await mapWithConcurrency(orgIds, SHOWCASE_BRAND_CONCURRENCY * 3, async (orgId) => ({
    orgId,
    staffOnly: isStaffOnlyOrg(await fetchOrgUserEmails(orgId)),
  }));
  const staffOrgs = new Set(verdicts.filter((v) => v.staffOnly).map((v) => v.orgId));
  return new Set(
    brandIds.filter((id) => {
      const orgs = orgsByBrand.get(id);
      return orgs !== undefined && orgs.size > 0 && [...orgs].every((o) => staffOrgs.has(o));
    }),
  );
}

async function computeShowcasePayloads(): Promise<ShowcasePayloads> {
  // Every seed slug in one membership read (308 rows fleet-wide, 2026-09-08) rather than a guess
  // at which channels a showcase brand happens to run — a brand that moves to a new channel keeps
  // answering with no change here.
  const allSlugs = (await db.query.features.findMany()).map((f) => f.slug);
  const memberships = allSlugs.length > 0 ? await fetchFeatureMemberships(allSlugs.join(",")) : [];
  const orgByBrand = new Map<string, string>();
  const orgsByBrand = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!orgByBrand.has(m.brandId)) orgByBrand.set(m.brandId, m.orgId);
    orgsByBrand.set(m.brandId, (orgsByBrand.get(m.brandId) ?? new Set()).add(m.orgId));
  }

  // The snapshots to rank over: every cold-email channel's, so a client that runs two of them is ONE
  // client with one beginning, rather than two rows competing with each other.
  // A channel with NO snapshot contributes nothing; only when NONE has one is there nothing to rank,
  // which is the `no_snapshot_yet` silence and a different statement from "nobody qualifies".
  const channelSlugs = coldEmailOutreachSlugs(allSlugs);
  const read = await Promise.all(channelSlugs.map((slug) => readFleetReturnSnapshotSoft(slug)));
  // An absent or aged-out snapshot is rebuilt behind this read (never awaited: the warm takes minutes).
  channelSlugs.forEach((slug, i) => {
    const snap = read[i];
    if (!snap || Date.now() - snap.computedAt.getTime() > FLEET_SNAPSHOT_STALE_MS) void warmFleetBrandSnapshot(slug);
  });
  const snapshots = read.filter((snap): snap is NonNullable<typeof snap> => snap !== null);
  const allCandidates = snapshots.length === 0 ? null : buildShowcaseCandidates(snapshots.map((snap) => snap.brands));
  // The homepage never names a STAFF TEST client: a brand every claiming org of which has only staff
  // members (owner 2026-10-19, Reed of "STAFF TEST - Email Sending E2E" stood on the hero). A failed
  // member read throws: the previous showcase stays served rather than naming an unchecked client.
  const staffOnlyBrands = allCandidates === null ? new Set<string>() : await staffOnlyBrandIds(allCandidates.map((c) => c.brandId), orgsByBrand);
  if (staffOnlyBrands.size > 0) {
    console.log(`[features-service] showcase: ${staffOnlyBrands.size} staff test client(s) left out: ${[...staffOnlyBrands].join(", ")}`);
  }
  const candidates = allCandidates === null ? null : allCandidates.filter((c) => !staffOnlyBrands.has(c.brandId));
  const picks = pickShowcaseClients(candidates, SHOWCASE_GROUP_SIZE);

  // The row is CONFIRMED on each candidate's own walked chain — the one the homepage draws — before a
  // client is named. The walk is bounded so a stale snapshot never turns one refresh into a fleet-wide
  // fan-out.
  const recentWalkable = picks.recentlyStarted.rankedBrandIds.slice(0, SHOWCASE_MAX_RECENT_WALKS);
  const brandInfo = recentWalkable.length > 0 ? await fetchBrandInfoBatch(recentWalkable) : new Map();

  const walkedFull = new Map<string, WalkedShowcaseBrand>();
  const walked = new Map<string, ShowcaseBrandFunnels>();
  const walkAll = async (ids: string[]): Promise<void> => {
    const todo = ids.filter((id) => !walked.has(id));
    const entries = await mapWithConcurrency(
      todo,
      SHOWCASE_BRAND_CONCURRENCY,
      async (brandId): Promise<WalkedShowcaseBrand> => {
        try {
          try {
            return await computeShowcaseBrand(brandId, orgByBrand.get(brandId), brandInfo.get(brandId));
          } catch (first) {
            // One retry: runs-service statement timeouts are transient under load (prod 2026-10-19,
            // Doc Dinners' 162 meetings left the hero row on one 500 per refresh).
            console.warn(`[features-service] showcase funnel read failed for brand ${brandId}, retrying once:`, first);
            return await computeShowcaseBrand(brandId, orgByBrand.get(brandId), brandInfo.get(brandId));
          }
        } catch (error) {
          console.error(`[features-service] showcase funnel read failed for brand ${brandId}:`, error);
          const info = brandInfo.get(brandId);
          return {
            entry: {
              brand: { id: brandId, name: info?.name ?? null, domain: info?.domain ?? null },
              funnels: [],
              measured: false,
              unmeasuredReason: "read_failed",
            },
            heroCounts: null,
          };
        }
      },
    );
    for (const e of entries) {
      walked.set(e.entry.brand.id, e.entry);
      walkedFull.set(e.entry.brand.id, e);
    }
  };

  // The hero row (owner 2026-10-19, SHOWCASE-MEETINGS-1019): walk newest first until 3 clients with a
  // booked meeting are found (or the cap), then name them, filling from the newest positive-reply
  // clients. Each client is judged on the counts its card states (`showcaseOutcomesOf`), so a card
  // never shows 0 meetings and 0 positive replies, and website visits never qualify anybody.
  const confirmRecent = async (pick: ShowcaseGroupPick, walkable: string[]): Promise<ShowcaseGroupPick> => {
    const counted: { brandId: string; meetingsBooked: number | null; positiveReplies: number | null }[] = [];
    const BATCH = 3;
    let verdict = pickRecentlyStartedByMeetings([], pick.requestedCount);
    for (let cursor = 0; cursor < walkable.length && !verdict.complete; cursor += BATCH) {
      const batch = walkable.slice(cursor, cursor + BATCH);
      await walkAll(batch);
      for (const id of batch) {
        const full = walkedFull.get(id);
        const outcomes = full ? showcaseOutcomesOf(full.entry, full.heroCounts).outcomes : [];
        const countOf = (key: string) => outcomes.find((o) => o.key === key)?.peopleReached ?? null;
        counted.push({ brandId: id, meetingsBooked: countOf("meeting_booked"), positiveReplies: countOf("conversation") });
      }
      verdict = pickRecentlyStartedByMeetings(counted, pick.requestedCount);
    }
    if (verdict.rejected > 0) {
      console.log(
        `[features-service] showcase recentlyStarted: ${verdict.rejected} candidate(s) had no meeting booked and no positive reply and were not named`,
      );
    }
    const qualifying = Math.max(0, pick.qualifyingCount - verdict.rejected);
    return verdict.brandIds.length > 0
      ? { ...pick, brandIds: verdict.brandIds, qualifyingCount: qualifying }
      : {
          ...pick,
          brandIds: [],
          measured: false,
          unmeasuredReason: pick.unmeasuredReason ?? "no_qualifying_clients",
          qualifyingCount: qualifying,
        };
  };

  const recentPick = await confirmRecent(picks.recentlyStarted, recentWalkable);
  // EVERY walk failed to read (prod 2026-10-29: lead-service restarting during the boot warm) is NOT
  // "nobody qualifies": throw, so the prior showcase stays served and the next read retries, rather than
  // caching an empty homepage row as a measured answer.
  const walkedEntries = [...walkedFull.values()];
  if (walkedEntries.length > 0 && walkedEntries.every((w) => w.entry.unmeasuredReason === "read_failed")) {
    throw new Error(`showcase: all ${walkedEntries.length} walked candidate(s) failed to read; keeping the prior showcase`);
  }

  const brands = recentPick.brandIds
    .map((id) => walked.get(id))
    .filter((entry): entry is ShowcaseBrandFunnels => entry !== undefined);

  // A group's `measured` is a statement about the PICK — did this ranking name anybody — and each
  // entry's own `measured` is a statement about that client's chain. They are kept apart on purpose:
  // "we could not rank" and "we could not walk this client's funnel" are different silences.
  const groupOf = (pick: ShowcaseGroupPick): ShowcaseGroup => ({
    brands: pick.brandIds
      .map((id) => walked.get(id))
      .filter((entry): entry is ShowcaseBrandFunnels => entry !== undefined),
    measured: pick.measured,
    unmeasuredReason: pick.unmeasuredReason,
    requestedCount: pick.requestedCount,
    qualifyingCount: pick.qualifyingCount,
  });

  const funnelsPayload: ShowcaseFunnelsPayload = {
    costBasis: "vendor",
    brands,
    groups: { recentlyStarted: groupOf(recentPick) },
  };
  const heroCounts = new Map<string, ShowcaseHeroCounts>();
  for (const [id, w] of walkedFull) if (w.heroCounts) heroCounts.set(id, w.heroCounts);
  return { funnels: funnelsPayload, outcomes: showcaseOutcomesPayloadOf(funnelsPayload, heroCounts) };
}

async function readShowcasePayloads(): Promise<ShowcasePayloads> {
  return servedPublicCached<ShowcasePayloads>({
    cache: showcaseFunnelsCache,
    key: "__showcase__",
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "showcase funnels",
    compute: computeShowcasePayloads,
  });
}

export async function handleShowcaseFunnels(res: import("express").Response): Promise<void> {
  res.json((await readShowcasePayloads()).funnels);
}

/** The showcase per OUTCOME (wave C4) — the SAME cell, the same picks, the same figures, no funnel named. */
export async function handleShowcaseOutcomes(res: import("express").Response): Promise<void> {
  res.json((await readShowcasePayloads()).outcomes);
}

// ── GET /public/channels ─────────────────────────────────────────────────────

router.get("/public/channels", async (req, res) => {
  try {
    let includeInline: boolean;
    try {
      includeInline = includeInlineOf(req.query.includeInline);
    } catch (e) {
      if (e instanceof IncludeInlineQueryError) return void res.status(400).json({ error: e.message, reason: e.reason });
      throw e;
    }
    await handlePublicChannels(res, includeInline);
  } catch (error) {
    console.error("[features-service] Public channels error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/channel-funnel-economics ─────────────────────────────────────

router.get("/public/channel-funnel-economics", async (req, res) => {
  try {
    await handleChannelFunnelEconomics(req.query.channelSlug as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public channel-funnel economics error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/channel-outcome-economics (wave C4) ───────────────────────────

router.get("/public/channel-outcome-economics", async (req, res) => {
  try {
    await handleChannelOutcomeEconomics(req.query.channelSlug as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public channel-outcome economics error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/showcase-outcomes (wave C4) ────────────────────────────

router.get("/public/stats/showcase-outcomes", async (_req, res) => {
  try {
    await handleShowcaseOutcomes(res);
  } catch (error) {
    console.error("[features-service] Public showcase outcomes error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/showcase-funnels ───────────────────────────────────────

router.get("/public/stats/showcase-funnels", async (_req, res) => {
  try {
    await handleShowcaseFunnels(res);
  } catch (error) {
    console.error("[features-service] Public showcase funnels error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

// ── /internal/stated-monthly-amounts (api-key only; staff-gated upstream at api-service) ──────────
//
// Full CRUD over the staff-writable record of what a HUMAN says a brand is worth per month, over a
// date range. It is what lets the fleet run-rate be split into an AGENCY half (worth what somebody
// stated) and a SELF-SERVE half (worth its daily budget × 30) — see agency-self-serve-compute.ts.
//
// Every write goes through the store's two rules: a coherent range, and NO OVERLAP with another range
// for the same (org, brand). An overlap is refused with a 409 whose message names the row it collided
// with, because two stated amounts in force on one day is two answers to one question. A write also
// drops the cached revenue payload, so a staff member who states an amount sees the split move on the
// next read instead of waiting out a cache window.

function statedAmountFailure(error: unknown, res: import("express").Response): void {
  if (error instanceof StatedAmountConflictError) {
    res.status(409).json({ error: "stated_amount_conflict", reason: error.message });
    return;
  }
  console.error("[features-service] stated-monthly-amounts error:", error);
  res.status(500).json({ error: "Internal server error" });
}

router.get("/internal/stated-monthly-amounts", apiKeyOnly, async (req, res) => {
  try {
    const orgId = typeof req.query.orgId === "string" ? req.query.orgId : undefined;
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    res.json({ statedAmounts: await listStatedAmounts({ orgId, brandId }) });
  } catch (error) {
    statedAmountFailure(error, res);
  }
});

router.post("/internal/stated-monthly-amounts", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.orgId !== "string" || typeof body.brandId !== "string") {
    res.status(400).json({ error: "orgId and brandId are required — a stated amount is keyed on the (org, brand) pair" });
    return;
  }
  try {
    const created = await createStatedAmount({
      orgId: body.orgId,
      brandId: body.brandId,
      amountUsd: body.amountUsd as number,
      startDate: (body.startDate as string | null | undefined) ?? null,
      endDate: (body.endDate as string | null | undefined) ?? null,
      note: (body.note as string | null | undefined) ?? null,
    });
    __resetRevenueHistoryCache();
    res.status(201).json({ statedAmount: created });
  } catch (error) {
    statedAmountFailure(error, res);
  }
});

router.patch("/internal/stated-monthly-amounts/:id", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // An omitted key keeps its stored value; an explicit null on a bound OPENS that end, which is a real
  // edit — so the patch is built from which keys are PRESENT, never from which are non-null.
  const patch: Parameters<typeof updateStatedAmount>[1] = {};
  if ("amountUsd" in body) patch.amountUsd = body.amountUsd as number;
  if ("startDate" in body) patch.startDate = (body.startDate as string | null) ?? null;
  if ("endDate" in body) patch.endDate = (body.endDate as string | null) ?? null;
  if ("note" in body) patch.note = (body.note as string | null) ?? null;
  try {
    const updated = await updateStatedAmount(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "stated_amount_not_found" });
      return;
    }
    __resetRevenueHistoryCache();
    res.json({ statedAmount: updated });
  } catch (error) {
    statedAmountFailure(error, res);
  }
});

router.delete("/internal/stated-monthly-amounts/:id", apiKeyOnly, async (req, res) => {
  try {
    if (!(await deleteStatedAmount(req.params.id))) {
      res.status(404).json({ error: "stated_amount_not_found" });
      return;
    }
    __resetRevenueHistoryCache();
    res.status(204).send();
  } catch (error) {
    statedAmountFailure(error, res);
  }
});

// ── One leg's fleet campaigns ─────────────────────────────────────────────────────────────────────

/** The campaigns performing one leg of a feature, fleet-wide, keyed `${featureSlug}:${legKey}`. */
const fleetLegCampaignsCache: PublicCache = new Map();

/**
 * The campaigns a FLEET figure of one leg is read on, and on a meeting leg who they are (`lib/meeting-population.ts`):
 * every campaign of the leg, or on a leg landing on a meeting step those of brands that report meetings.
 */
function getFleetLegPopulation(featureSlug: string, legKey: string): Promise<{ campaigns: FleetLegCampaign[]; population: MeetingPopulation | null }> {
  return servedPublicCached({
    cache: fleetLegCampaignsCache,
    key: `${featureSlug}:${legKey}`,
    windows: LIFETIME_AGGREGATE_WINDOWS,
    label: "fleet leg campaigns",
    compute: async () => {
      const { counted, population } = await fleetPopulationCampaigns(featureSlug, legKey, await fetchFleetLegCampaigns(featureSlug, legKey));
      return { campaigns: counted, population };
    },
  });
}

export async function getFleetLegCampaigns(featureSlug: string, legKey: string): Promise<FleetLegCampaign[]> {
  return (await getFleetLegPopulation(featureSlug, legKey)).campaigns;
}

/** Test seam: drop the leg-campaign cache. */
export function __resetFleetWorkflowPipelinesCache(): void {
  clearPublicCache(fleetLegCampaignsCache);
}

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

// The REFRESHER's half of the per-workflow fleet leg maturity (`fetchFleetLegWorkflowMaturity`): the server
// asks this process, whose fleet cells are warm, instead of walking the fleet a second time. Service-auth;
// the gateway does not proxy it. Computes in whichever process answers.
router.get("/internal/fleet-leg-maturity", apiKeyOnly, async (req, res) => {
  const featureSlug = req.query.featureSlug as string | undefined;
  const legKey = await resolvePipeLegKey(featureSlug, String(req.query.legKey ?? ""));
  if (!featureSlug || !legKey) {
    res.status(400).json({ error: "featureSlug and a known legKey are required" });
    return;
  }
  try {
    const slugs: SpendSlugs = req.query.slugs === "own" ? "own" : "fed";
    res.json(await computeFleetLegWorkflowMaturity(featureSlug, legKey, slugs));
  } catch (error) {
    console.error("[features-service] Internal fleet leg maturity error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/outcome-prices ─────────────────────────────────────────
//
// What ONE website visit and ONE booked meeting are expected to cost a brand with no data of its own — the
// public onboarding's "what do you want to buy" choice (`lib/outcome-prices.ts` states the rule). Fleet grain,
// no identity. Every leg's figures are fleet walks that take seconds to minutes, so the payload is built OFF
// the request path (boot warm + a warm kicked by a read past the fresh window) and a read always answers
// from the last build; before the first build it answers `computedAt: null` with every price unmeasured
// (`not_computed_yet`), never a guessed figure.

const COLD_EMAIL_FEATURE_SLUG = "sales-cold-email-outreach";
const OUTCOME_PRICES_FRESH_MS = 15 * 60_000;
const OUTCOME_PRICES_WARM_TIMEOUT_MS = 10 * 60_000;

type OutcomePriceServed = Omit<OutcomePrice, "unmeasuredReason"> & {
  unmeasuredReason: OutcomePrice["unmeasuredReason"] | "not_computed_yet";
};

export interface OutcomePricesPayload {
  grain: "fleet";
  costBasis: "incurred";
  computedAt: string | null;
  outcomes: {
    websiteVisit: OutcomePriceServed & { legs: LegPrice[] };
    meetingBooked: OutcomePriceServed & { arithmetic: MeetingPriceArithmetic | null; legs: LegPrice[] };
  };
}

let outcomePricesStore: { value: OutcomePricesPayload; computedAt: number } | null = null;
let outcomePricesWarm: Promise<void> | null = null;

/**
 * Every workflow that never competes for the leg's price: the ones the owner DEPRECATED on the leg, and the ones
 * workflow-service can no longer run (every version retired, `executableDynasties`). The latter now carry their real
 * figures on the leg (`rollUpLegEvidenceByDynasty`), and a price set by a workflow no run can pick would be a price
 * nobody can buy. The ranking draws the same line (`selectable`).
 */
export async function excludedFromLegPrice(featureSlug: string, legKey: string): Promise<Set<string>> {
  const [rows, workflows] = await Promise.all([fetchLegAssignments(featureSlug, legKey), fetchPublicWorkflows(featureSlug, "all")]);
  const runnable = executableDynasties(workflows);
  const out = new Set([...rows.values()].filter((r) => r.state === "deprecated").map((r) => r.workflowDynastySlug));
  for (const w of workflows) if (!runnable.has(w.workflowDynastySlug)) out.add(w.workflowDynastySlug);
  return out;
}

async function coldEmailLegPrice(legKey: string): Promise<LegPrice> {
  const [maturity, excluded, campaigns] = await Promise.all([
    fetchFleetLegWorkflowMaturity(COLD_EMAIL_FEATURE_SLUG, legKey),
    excludedFromLegPrice(COLD_EMAIL_FEATURE_SLUG, legKey),
    fetchFleetLegCampaigns(COLD_EMAIL_FEATURE_SLUG, legKey),
  ]);
  return pickLegPrice({
    legKey,
    featureSlug: COLD_EMAIL_FEATURE_SLUG,
    byDynasty: new Map(maturity.byDynasty),
    excluded,
    campaignCount: campaigns.length,
  });
}

/**
 * ONE PIPE's fleet price (channel x leg): the best workflow's figures on the leg, mature when any is
 * (`pickLegPrice`). The AI meeting-booking leg reads its own fleet walk (`computeMeetingLegFleet`, reactive
 * attribution); every other pipe the generic leg maturity. A pipe nobody runs answers `no_campaigns_on_leg`
 * without walking anything. (Read by the agent catalogue, `routes/agent-catalogue.ts`.)
 */
export async function fleetLegPrice(featureSlug: string, legKey: string): Promise<LegPrice> {
  // ONE rule for every pipe (`fleetPipeFigures`), the same one the workflow ranking reads.
  const [figures, excluded] = await Promise.all([fleetPipeFigures(featureSlug, legKey), excludedFromLegPrice(featureSlug, legKey)]);
  return pickLegPrice({ legKey, featureSlug, byDynasty: new Map(figures.byDynasty), excluded, campaignCount: figures.campaignCount });
}

/**
 * The price of each PLAY of a pipe (`lib/plays.ts`): the same pick as `fleetLegPrice` over the same figures, minus the
 * dynasties each play's strategy excludes. `strategyExclusions(dynasties)` names, for every dynasty with figures, the
 * excluded set of each play in order. A play excluding nothing prices byte-equal to the pipe.
 */
export async function fleetPlayPrices(
  featureSlug: string,
  legKey: string,
  strategyExclusions: (dynasties: readonly string[]) => ReadonlyArray<ReadonlySet<string>>,
): Promise<LegPrice[]> {
  const [figures, excluded] = await Promise.all([fleetPipeFigures(featureSlug, legKey), excludedFromLegPrice(featureSlug, legKey)]);
  const byDynasty = new Map(figures.byDynasty);
  return strategyExclusions([...byDynasty.keys()]).map((more) =>
    pickLegPrice({ legKey, featureSlug, byDynasty, excluded: new Set([...excluded, ...more]), campaignCount: figures.campaignCount }),
  );
}

export async function computeOutcomePrices(): Promise<OutcomePricesPayload> {
  const [visitLeg, replyLeg, meetingFleet, meetingExcluded] = await Promise.all([
    coldEmailLegPrice("start_to_website_visit"),
    coldEmailLegPrice("start_to_conversation"),
    computeMeetingLegFleet(),
    excludedFromLegPrice(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY),
  ]);
  const meetingLeg = pickLegPrice({
    legKey: MEETING_BOOKING_LEG_KEY,
    featureSlug: MEETING_BOOKING_FEATURE_SLUG,
    byDynasty: new Map(meetingFleet.byDynasty),
    excluded: meetingExcluded,
    campaignCount: meetingFleet.campaignCount,
  });
  if (meetingFleet.unattributableCampaignIds.length > 0) {
    console.warn(
      `[features-service] outcome prices: ${meetingFleet.unattributableCampaignIds.length} meeting-booking campaign(s) ran several workflows and are left out of every workflow: ${meetingFleet.unattributableCampaignIds.join(",")}`,
    );
  }
  return {
    grain: "fleet",
    costBasis: "incurred",
    computedAt: new Date().toISOString(),
    outcomes: {
      websiteVisit: { ...websiteVisitPrice(visitLeg), legs: [visitLeg] },
      meetingBooked: { ...meetingBookedPrice(replyLeg, meetingLeg), legs: [replyLeg, meetingLeg] },
    },
  };
}

/** Rebuild the payload in the background when absent or past its fresh window (single-flight). */
export function warmOutcomePrices(): Promise<void> {
  if (outcomePricesStore && Date.now() - outcomePricesStore.computedAt < OUTCOME_PRICES_FRESH_MS) return Promise.resolve();
  if (outcomePricesWarm) return outcomePricesWarm;
  outcomePricesWarm = withTimeout(computeOutcomePrices(), OUTCOME_PRICES_WARM_TIMEOUT_MS, "outcome prices")
    .then((value) => {
      outcomePricesStore = { value, computedAt: Date.now() };
    })
    .catch((error) => {
      console.error("[features-service] outcome prices warm failed, keeping the previous value:", error);
    })
    .finally(() => {
      outcomePricesWarm = null;
    });
  return outcomePricesWarm;
}

/**
 * The fleet's MEASURED cost per outcome on each leg the outcome-prices payload prices, keyed
 * `${legKey}|${featureSlug}` — read from the last build, never a request-path fleet walk. A leg with no
 * measured price is absent. Kicks a background warm when stale. (Read by `/offers/:offerId/sales-paths`.)
 */
export function fleetLegCostsFromOutcomePrices(): Map<string, number> {
  void warmOutcomePrices();
  const out = new Map<string, number>();
  const value = outcomePricesStore?.value;
  if (!value) return out;
  for (const leg of [...value.outcomes.websiteVisit.legs, ...value.outcomes.meetingBooked.legs]) {
    if (leg.costPerOutcomeUsd !== null && Number.isFinite(leg.costPerOutcomeUsd) && leg.costPerOutcomeUsd > 0) {
      out.set(`${leg.legKey}|${leg.featureSlug}`, leg.costPerOutcomeUsd);
    }
  }
  return out;
}

/**
 * The fleet's conversion per (leg, channel), `${legKey}|${featureSlug}` → percent, from the last outcome-prices
 * build (the best workflow's own conversion on the leg). Empty before the first build. Read by the offer ladder's
 * expected % Conversion of the contacted row (`lib/expected-conversion.ts`).
 */
export function fleetLegConversionRatesFromOutcomePrices(): Map<string, number> {
  void warmOutcomePrices();
  const out = new Map<string, number>();
  const value = outcomePricesStore?.value;
  if (!value) return out;
  for (const leg of [...value.outcomes.websiteVisit.legs, ...value.outcomes.meetingBooked.legs]) {
    if (leg.conversionRatePct !== null && Number.isFinite(leg.conversionRatePct) && leg.conversionRatePct > 0) {
      out.set(`${leg.legKey}|${leg.featureSlug}`, leg.conversionRatePct);
    }
  }
  return out;
}

/** How long a sales-paths read waits on the first outcome-prices build after boot (~2.5 min in prod,
 *  2026-10-03) before failing visibly. Under Caddy's 310 s read timeout. */
export const FLEET_LEG_COSTS_BOOT_WAIT_MS = 200_000;

/**
 * `fleetLegCostsFromOutcomePrices`, but a read that finds the store EMPTY (the boot warm window) awaits the
 * in-flight build instead of answering "nothing measured" (which priced every leg at its seeded default).
 * Still empty after `waitMs` → `StoreNotComputedError` (the route's 503). (`lib/await-warm-store.ts`.)
 */
export async function awaitFleetLegCostsFromOutcomePrices(waitMs: number = FLEET_LEG_COSTS_BOOT_WAIT_MS): Promise<Map<string, number>> {
  await awaitWarmStore(() => outcomePricesStore?.value ?? null, warmOutcomePrices, waitMs, "fleet leg costs (outcome prices)");
  return fleetLegCostsFromOutcomePrices();
}

/**
 * The outcome prices' meeting price for the Research meeting-cost study (MEETING-COST-METHODS-1024), awaiting the first
 * build of this process up to `waitMs`. Null (logged) when no build landed: the study says not readable.
 */
export async function readOutcomePricesMeetingBooked(waitMs: number): Promise<OutcomePricesPayload["outcomes"]["meetingBooked"] | null> {
  try {
    const value = await awaitWarmStore(() => outcomePricesStore?.value ?? null, warmOutcomePrices, waitMs, "outcome prices (research meeting cost)");
    return value.outcomes.meetingBooked;
  } catch (error) {
    console.error("[features-service] research: outcome prices not built in time, the meeting-cost study says not readable:", error);
    return null;
  }
}

/**
 * The fleet's positive-reply rate per contacted lead, as the public onboarding quotes it: the conversion of
 * the best workflow on the cold-email `start_to_conversation` leg, from the last outcome-prices build (never a
 * request-path fleet walk). Null before the first build or when the leg is unmeasured. Kicks a warm when
 * stale. (Read by `GET /internal/orgs/:orgId/period-recap` for a brand with no mature rate of its own.)
 */
export function fleetPositiveReplyRateFromOutcomePrices(): FleetReplyRate | null {
  void warmOutcomePrices();
  const leg = outcomePricesStore?.value.outcomes.meetingBooked.legs.find(
    (l) => l.legKey === "start_to_conversation" && l.featureSlug === COLD_EMAIL_FEATURE_SLUG,
  );
  if (!leg || leg.conversionRatePct === null || !Number.isFinite(leg.conversionRatePct) || leg.conversionRatePct <= 0) return null;
  return { ratePct: leg.conversionRatePct, basis: leg.basis ?? "flash", workflowDynastySlug: leg.workflowDynastySlug };
}

/** Test seam: install an outcome-prices payload as if a warm had built it. */
export function __setOutcomePricesForTest(value: OutcomePricesPayload): void {
  outcomePricesStore = { value, computedAt: Date.now() };
}

/** Test seam. */
export function __resetOutcomePrices(): void {
  outcomePricesStore = null;
  outcomePricesWarm = null;
}

function notComputedYet(): OutcomePricesPayload {
  const none = { maturity: null, priceUsd: null, unmeasuredReason: "not_computed_yet" as const };
  return {
    grain: "fleet",
    costBasis: "incurred",
    computedAt: null,
    outcomes: { websiteVisit: { ...none, legs: [] }, meetingBooked: { ...none, arithmetic: null, legs: [] } },
  };
}

router.get("/public/stats/outcome-prices", (_req, res) => {
  void warmOutcomePrices();
  res.json(outcomePricesStore?.value ?? notComputedYet());
});

// ── GET /public/stats/leg-workflow-ranking ───────────────────────────────────
//
// Every workflow on ONE leg, ranked at the FLEET grain, for a research surface that names no org, brand,
// offer, campaign or audience (`lib/leg-workflow-ranking.ts` states the owner's order rule). Built off the
// request path like outcome-prices: the leg's figures, its pipeline and its billed spend are fleet walks;
// a read answers the last build, before the first `computedAt: null` + no rows, never a guessed figure.

const LEG_RANKING_FRESH_MS = 15 * 60_000;
const LEG_RANKING_WARM_TIMEOUT_MS = 10 * 60_000;

export interface LegWorkflowRankingPayload {
  featureSlug: string;
  legKey: string;
  grain: "fleet";
  /** The cost per outcome, outcomes, spend and rate are on the incurred fleet basis (outcome-prices'). A workflow
   *  serves no return (ROI-CONSISTENCY-1103). */
  costBasis: "incurred";
  computedAt: string | null;
  maturity: { durationDays: number; outcomesRequired: number; cutoffIso: string | null; measured: boolean };
  /** On a pipe landing on a meeting step: the brands counted / left out (`lib/meeting-population.ts`); else null. */
  meetingPopulation?: MeetingPopulation | null;
  /** The pricing every row's `figures` is on (`?pricing=gross|net`, gross by default). Set at serve time. */
  pricing?: "gross" | "net";
  rows: LegWorkflowRankingRow[];
}

/**
 * PURE. The body served for one `?pricing=` (RESEARCH-WF-FIGURES-1022): each row's `figures` on that pricing, the build's
 * net twin never served beside it. A build persisted before the figures existed is served as stored.
 */
export function legRankingOnPricing(
  payload: LegWorkflowRankingPayload,
  pricing: "gross" | "net",
  /** The tactics a dynasty's current version follows (live, never from the build), `not_judged_yet`; null = unreadable. */
  tacticsOf?: ((dynasty: string) => Array<{ id: string; name: string }> | "not_judged_yet") | null,
): LegWorkflowRankingPayload {
  return {
    ...payload,
    pricing,
    rows: payload.rows.map((r) => {
      const { figuresNet, figuresByView: _byView, ...row } = r;
      const priced = pricing === "net" && figuresNet ? { ...row, figures: figuresNet } : row;
      if (tacticsOf === undefined) return priced;
      if (!tacticsOf) return { ...priced, tactics: null, tacticsUnavailableReason: "tactics_unreadable" as const };
      const t = tacticsOf(r.workflowDynastySlug);
      return t === "not_judged_yet" ? { ...priced, tactics: null, tacticsUnavailableReason: t } : { ...priced, tactics: t, tacticsUnavailableReason: null };
    }),
  };
}

/**
 * PURE. The workflow tactics each dynasty's current version follows; `not_judged_yet` when that version lacks a verdict on
 * any workflow tactic (unknown is never an empty list: the page would read "None").
 */
export function workflowTacticsFrom(c: Pick<PlayCatalogue, "tactics" | "tacticsByDynasty">): (dynasty: string) => Array<{ id: string; name: string }> | "not_judged_yet" {
  const workflowTactics = [...c.tactics.values()].filter((t) => (t.appliesTo ?? "workflow") === "workflow");
  return (dynasty) => {
    const verdicts = c.tacticsByDynasty.get(dynasty);
    if (!verdicts || workflowTactics.some((t) => !verdicts.has(t.id))) return "not_judged_yet";
    return workflowTactics
      .filter((t) => verdicts.get(t.id) === true)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  };
}

/** The tactics each dynasty's CURRENT version follows (workflow tactics judged yes), read live off the play catalogue. */
async function workflowTacticsOf(): Promise<((dynasty: string) => Array<{ id: string; name: string }> | "not_judged_yet") | null> {
  try {
    return workflowTacticsFrom(await loadPlayCatalogue());
  } catch (error) {
    console.error("[features-service] leg workflow ranking: tactics unreadable, rows serve none:", error);
    return null;
  }
}

const legRankingStore = new Map<string, { value: LegWorkflowRankingPayload; computedAt: number }>();
const legRankingWarm = new Map<string, Promise<void>>();

/**
 * ONE PIPE'S PER-WORKFLOW FLEET FIGURES, the same rule for every pipe of every channel (owner 2026-10-10: no
 * special case). An ENTRY pipe (from nothing / Lead found) is measured on the leads its campaigns served; an
 * INTERNAL pipe (from any other step) on the people its campaigns acted on and their reaching its `to` step
 * (`lib/meeting-leg-fleet.ts`). Read by the price (`fleetLegPrice`) AND the workflow ranking, so the choice
 * and the ROI see the same figures. Before: one channel's internal pipe (AI meeting booking) was measured on
 * the ledger by its slug and only in the price; the ranking read it as an entry pipe ("0 outcomes from 0
 * people" for rhodium).
 */
/**
 * ONE REGIME FOR EVERY PIPE, on the general ledger (owner 2026-10-24, LEDGER-HISTORY-1024: « Passe tout d'un coup au même
 * régime »; `lib/ledger-pipe-costs.ts`): once the ledger RECONCILES with the runs spend (`ledgerReconciliation`), every
 * pipe (entry, internal, sourcing alike) is priced per workflow on its own production in its campaigns ÷ the outcome of
 * its leg, flash and mature (the run-start cut), and the three measure paths below stand aside. Until then null: every
 * pipe keeps the previous regime, never half the pipes on each. Same campaigns as the previous regime (the leg's stated
 * campaigns, the meeting-population rule where it applies).
 */
async function ledgerPipeFigures(
  featureSlug: string,
  legKey: string,
  campaigns: readonly FleetLegCampaign[],
  pricing: PipeSpendPricing = "gross",
): Promise<Array<[string, LegMaturityFigures]> | null> {
  // The gate is the BILLED book's: a vendor twin is on the ledger exactly when the billed figures are.
  if (!(await ledgerRegime("gross"))) return null;
  const flashRead = await ledgerRegime(pricing);
  if (!flashRead) throw new Error(`[features-service] ledger ${featureSlug}|${legKey}: the ${pricing} book is unreadable while the billed one is open`);
  const outcomeKey = await pipeOutcomeKey(featureSlug, legKey);
  const cutoffIso = legCutoffIso(legKey);
  const matureRead = cutoffIso ? await ledgerRegime(pricing, cutoffIso) : flashRead;
  const ids = new Set(campaigns.map((c) => c.campaignId));
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  const dynastyOf = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const byDynasty = (read: LedgerBookRead) => {
    const out = new Map<string, OutcomeFigures>();
    for (const v of pipeWorkflowCosts(outcomeKey, ids, read.book).values()) {
      const d = dynastyOf.get(v.workflowSlug) ?? v.workflowSlug;
      const prev = out.get(d);
      out.set(d, outcomeFigures((prev?.spentUsd ?? 0) + v.costUsd, (prev?.contacted ?? 0) + v.inputs, (prev?.outcomes ?? 0) + v.outcomes));
    }
    return out;
  };
  const flash = byDynasty(flashRead);
  const mature = matureRead ? byDynasty(matureRead) : null;
  return [...new Set([...flash.keys(), ...(mature ? mature.keys() : [])])].map(
    (d) => [d, legMaturityFigures(legKey, flash.get(d) ?? outcomeFigures(0, 0, 0), mature ? (mature.get(d) ?? outcomeFigures(0, 0, 0)) : null)] as [string, LegMaturityFigures],
  );
}

/**
 * The basis a pipe's per-workflow spend is read on: `gross` (billed, incurred: every reader), or, for the PUBLIC money
 * figures only (PUBLIC-VENDOR-COST-1031), `vendor` (real vendor cost of the priced rows) and `vendorUnpriced` (billed
 * spend on the rows no vendor cost prices). Counts are the same on every basis.
 */
export type PipeSpendPricing = "gross" | "vendor" | "vendorUnpriced";

export async function fleetPipeFigures(
  featureSlug: string,
  legKey: string,
  pricing: PipeSpendPricing = "gross",
): Promise<{
  byDynasty: Array<[string, LegMaturityFigures]>;
  cutoffIso: string | null;
  measured: boolean;
  campaignCount: number;
  meetingPopulation: MeetingPopulation | null;
}> {
  const pipePopulation = await getFleetLegPopulation(featureSlug, legKey);
  const onLedger = await ledgerPipeFigures(featureSlug, legKey, pipePopulation.campaigns, pricing);
  if (onLedger) {
    return { byDynasty: onLedger, cutoffIso: legCutoffIso(legKey), measured: true, campaignCount: pipePopulation.campaigns.length, meetingPopulation: pipePopulation.population };
  }
  // An ON-DEMAND pipe (owner 2026-10-11: the sourcing channels, run only when the cold email pipe asks, each ask its own
  // unit run) is measured on its own runs' spend and the leads its trigger's events say it found (`lib/on-demand-pipe-fleet.ts`).
  const onDemandTrigger = await onDemandPipeTrigger(featureSlug, legKey);
  if (onDemandTrigger) {
    if (pricing !== "gross") throw new Error(`[features-service] pipe ${featureSlug}|${legKey}: an on-demand pipe is not read on the ${pricing} basis`);
    const fleet = await getOnDemandPipeFleet(featureSlug, legKey);
    return { byDynasty: fleet.byDynasty, cutoffIso: legCutoffIso(legKey), measured: true, campaignCount: fleet.campaignCount, meetingPopulation: null };
  }
  const internalToStep = await internalPipeToStep(featureSlug, legKey);
  if (internalToStep && pricing !== "gross") {
    const fleet = await getInternalPipeFleet(featureSlug, legKey, internalToStep);
    return { byDynasty: (await internalPipeSpendOn(featureSlug, legKey, fleet, pricing)).byDynasty, cutoffIso: legCutoffIso(legKey), measured: true, campaignCount: fleet.campaignCount, meetingPopulation: fleet.population };
  }
  if (internalToStep) {
    const fleet = await getInternalPipeFleet(featureSlug, legKey, internalToStep);
    if (fleet.unattributableCampaignIds.length > 0) {
      console.warn(
        `[features-service] pipe ${featureSlug}|${legKey}: ${fleet.unattributableCampaignIds.length} campaign(s) ran several workflows and are left out of every workflow: ${fleet.unattributableCampaignIds.join(",")}`,
      );
    }
    return { byDynasty: fleet.byDynasty, cutoffIso: legCutoffIso(legKey), measured: true, campaignCount: fleet.campaignCount, meetingPopulation: fleet.population };
  }
  const { campaigns, population } = await getFleetLegPopulation(featureSlug, legKey);
  if (campaigns.length === 0) return { byDynasty: [], cutoffIso: legCutoffIso(legKey), measured: true, campaignCount: 0, meetingPopulation: population };
  // The pipe's OWN cost (owner 2026-10-11): an outreach pipe fed by sources reads its own slug only, its sources being
  // pipes measured on theirs (`lib/feature-scope.ts` `SpendSlugs`).
  const maturity =
    pricing === "gross"
      ? await fetchFleetLegWorkflowMaturity(featureSlug, legKey, "own")
      : await computeFleetLegWorkflowMaturity(featureSlug, legKey, effectiveSpendSlugs(featureSlug, "own"), pricing);
  return { ...maturity, campaignCount: campaigns.length, meetingPopulation: population };
}

/**
 * An INTERNAL pipe's spend on a vendor basis (PUBLIC-VENDOR-COST-1031), the SAME attribution as its billed figures
 * (`buildMeetingLegFleet`): per dynasty, each counted campaign credited to the one dynasty that spent on it; pooled, every
 * counted campaign that ran, every dynasty on it. Each campaign's spend is read on `pricing`; the counts are the billed
 * build's own.
 */
export async function internalPipeSpendOn(
  featureSlug: string,
  legKey: string,
  fleet: MeetingLegFleet,
  pricing: "vendor" | "vendorUnpriced",
): Promise<{ byDynasty: Array<[string, LegMaturityFigures]>; pooledByDynasty: Record<string, number> }> {
  const counted = fleet.perCampaign.filter((c) => c.inFleetPopulation);
  const ran = fleet.ranCampaigns ?? [];
  const ids = [...new Set([...counted.map((c) => c.campaignId), ...ran.map((c) => c.campaignId)])].sort();
  const [workflows, groups] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    mapWithConcurrency(ids, 2, async (id) => [id, await fetchPublicCosts(featureSlug, "workflowSlug", pricing, "incurred", [id])] as const),
  ]);
  const toDynasty = dynastyOfSlug(workflows);
  const byCampaign = new Map<string, Map<string, number>>();
  for (const [id, gs] of groups) {
    const m = byCampaign.get(id) ?? new Map<string, number>();
    for (const g of gs) {
      const slug = g.dimensions.workflowSlug;
      if (!slug) continue;
      const d = toDynasty(slug);
      m.set(d, (m.get(d) ?? 0) + Number(g.totalCostInUsdCents));
    }
    byCampaign.set(id, m);
  }
  const spent = new Map<string, number>();
  for (const c of counted) spent.set(c.dynasty, (spent.get(c.dynasty) ?? 0) + (byCampaign.get(c.campaignId)?.get(c.dynasty) ?? 0));
  const pooled = new Map<string, number>();
  for (const c of ran) for (const [d, cents] of byCampaign.get(c.campaignId) ?? []) pooled.set(d, (pooled.get(d) ?? 0) + cents);
  return {
    byDynasty: fleet.byDynasty.map(([d, f]) => {
      const figures = outcomeFigures((spent.get(d) ?? 0) / 100, f.flash?.contacted ?? 0, f.flash?.outcomes ?? 0);
      return [d, legMaturityFigures(legKey, figures, figures)] as [string, LegMaturityFigures];
    }),
    pooledByDynasty: Object.fromEntries([...pooled].filter(([, c]) => c !== 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => [d, c / 100])),
  };
}

/**
 * One pipe's NET spend per workflow dynasty, flash and mature (RESEARCH-WF-FIGURES-1022: the dashboard reads every money
 * figure on what the org pays), and each dynasty's LAST RUN on the pipe, fleet-wide (the newest run start of any of its
 * versions on the pipe's campaigns, every org). An ENTRY pipe reads the byte-same evidence as its gross figures on the
 * net basis; an internal or on-demand pipe states neither per workflow yet = null (rows say so).
 */
async function fleetPipeNetEvidence(
  featureSlug: string,
  legKey: string,
): Promise<{ netSpend: Map<string, { flash: number; mature: number | null }>; lastRunAt: Map<string, string> } | null> {
  if (await onDemandPipeTrigger(featureSlug, legKey)) return null;
  if (await internalPipeToStep(featureSlug, legKey)) return null;
  const ev = await fetchFleetLegSlugEvidence(featureSlug, legKey, effectiveSpendSlugs(featureSlug, "own"), "net");
  const flash = legEvidenceByDynasty(featureSlug, legKey, ev.workflows, ev.flash.costGroups, ev.flash.emailStats);
  const mature = ev.mature ? legEvidenceByDynasty(featureSlug, legKey, ev.workflows, ev.mature.costGroups, ev.mature.emailStats) : null;
  const netSpend = new Map<string, { flash: number; mature: number | null }>();
  for (const d of new Set([...flash.keys(), ...(mature ? mature.keys() : [])])) {
    netSpend.set(d, { flash: (flash.get(d)?.spentCents ?? 0) / 100, mature: mature ? (mature.get(d)?.spentCents ?? 0) / 100 : null });
  }
  const dynastyOf = new Map(ev.workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const lastRunAt = new Map<string, string>();
  for (const g of ev.flash.costGroups) {
    const slug = g.dimensions.workflowSlug;
    const d = slug ? dynastyOf.get(slug) : undefined;
    if (!d || !g.maxStartedAt) continue;
    const prev = lastRunAt.get(d);
    if (!prev || g.maxStartedAt > prev) lastRunAt.set(d, g.maxStartedAt);
  }
  return { netSpend, lastRunAt };
}

/** PURE. The leg's seeded conversion (%): an entry leg's default entry rate, else the seeded leg default; null when none. */
export function legDefaultConversionPct(legKey: string): number | null {
  const leg = funnelLeg(legKey);
  if (!leg) return null;
  const from = leg.fromStep?.key ?? null;
  if (from === null || from === "lead_found") return DEFAULT_ENTRY_RATE_PCT[leg.toStep.key] ?? null;
  return defaultLegRatePct(from, leg.toStep.key);
}

export async function computeLegWorkflowRanking(featureSlug: string, legKey: string): Promise<LegWorkflowRankingPayload> {
  const netP = fleetPipeNetEvidence(featureSlug, legKey).catch((error) => {
    console.error(`[features-service] leg workflow ranking: net evidence unreadable (${featureSlug}, ${legKey}); its net figures and last runs read not measured:`, error);
    return null;
  });
  const [maturity, assignmentRows, workflows] = await Promise.all([
    fleetPipeFigures(featureSlug, legKey),
    fetchLegAssignments(featureSlug, legKey),
    fetchPublicWorkflows(featureSlug, "all"),
  ]);
  const byDynasty = new Map(maturity.byDynasty);
  const assignments = new Map<string, "active" | "deprecated">();
  for (const [slug, row] of assignmentRows) {
    if (row.state === "active" || row.state === "deprecated") assignments.set(slug, row.state);
  }
  const names = new Map<string, string | null>();
  for (const w of workflows) if (!names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName ?? null);
  const rule = legMaturity(legKey);
  return {
    featureSlug,
    legKey,
    grain: "fleet",
    costBasis: "incurred",
    computedAt: new Date().toISOString(),
    maturity: { durationDays: rule.durationDays, outcomesRequired: rule.outcomesRequired, cutoffIso: maturity.cutoffIso, measured: maturity.measured },
    meetingPopulation: maturity.meetingPopulation,
    rows: rankLegWorkflows({
      byDynasty,
      names,
      assignments,
      executable: executableDynasties(workflows),
      ...(await netP.then((net) => ({ netSpend: net?.netSpend ?? null, lastRunAt: net?.lastRunAt ?? null }))),
      defaultConversionPct: legDefaultConversionPct(legKey),
    }),
  };
}

/** The persisted copy of one leg's ranking (`lib/fleet-cell-store.ts`). `-v2`: the builds stored before
 *  ROI-CONSISTENCY-1103 carry the deleted per-workflow return, never served again. */
const legRankingCellKey = (key: string): string => `leg-workflow-ranking-v2:${key}`;

/** Rebuild one leg's ranking in the background when absent or past its fresh window (single-flight). */
export function warmLegWorkflowRanking(featureSlug: string, rawLegKey: string): Promise<void> {
  // One leg, one cell: an outbound channel's new spelling (`lead_found_to_*`) is computed on its funnel leg. Keyed raw,
  // the new spelling built a ranking of zeros (no evidence and no maturity rule under that key) and the fleet indexes,
  // which ask with it, recorded null on 2026-10-18 (LIVE-RESEARCH-1018).
  const legKey = pipeLegKeyOf(featureSlug, rawLegKey);
  const key = `${featureSlug}|${legKey}`;
  const entry = legRankingStore.get(key);
  if (entry && Date.now() - entry.computedAt < LEG_RANKING_FRESH_MS) return Promise.resolve();
  const inFlight = legRankingWarm.get(key);
  if (inFlight) return inFlight;
  const warm = withTimeout(computeLegWorkflowRanking(featureSlug, legKey), LEG_RANKING_WARM_TIMEOUT_MS, `leg workflow ranking ${key}`)
    .then(async (value) => {
      const computedAt = Date.now();
      legRankingStore.set(key, { value, computedAt });
      // The persisted warm copy a fresh process serves while it rebuilds (`readLegWorkflowRanking`).
      await storeFleetCell(legRankingCellKey(key), JSON.stringify(value), computedAt);
    })
    .catch((error) => {
      console.error(`[features-service] leg workflow ranking warm failed (${key}), keeping the previous value:`, error);
    })
    .finally(() => {
      legRankingWarm.delete(key);
    });
  legRankingWarm.set(key, warm);
  return warm;
}

/**
 * One pipe's workflow ranking from the last build (kicks a warm when stale). A pipe never built yet awaits
 * its first build, bounded by `waitMs`; still nothing after that = null (the caller says "not computed yet").
 */
export async function readLegWorkflowRanking(featureSlug: string, rawLegKey: string, waitMs = 60_000): Promise<LegWorkflowRankingPayload | null> {
  const legKey = pipeLegKeyOf(featureSlug, rawLegKey);
  const key = `${featureSlug}|${legKey}`;
  // A fresh process (every deploy) serves the LAST build persisted by any process, and rebuilds behind it:
  // a read never waits on the fleet walk while a copy exists (the agent catalogue's 30 s callers timed out).
  if (!legRankingStore.has(key)) {
    const stored = await loadFleetCell(legRankingCellKey(key));
    if (stored && !legRankingStore.has(key)) {
      try {
        legRankingStore.set(key, { value: JSON.parse(stored.text) as LegWorkflowRankingPayload, computedAt: stored.computedAt });
      } catch (error) {
        console.error(`[features-service] leg workflow ranking ${key}: persisted copy unreadable, rebuilding:`, error);
      }
    }
  }
  if (legRankingStore.has(key)) {
    void warmLegWorkflowRanking(featureSlug, legKey);
    return legRankingStore.get(key)!.value;
  }
  try {
    return await awaitWarmStore(() => legRankingStore.get(key)?.value ?? null, () => warmLegWorkflowRanking(featureSlug, legKey), waitMs, `leg workflow ranking ${key}`);
  } catch (error) {
    console.error(`[features-service] leg workflow ranking ${key} not built after ${Math.round(waitMs / 1000)}s:`, (error as Error).message);
    return null;
  }
}

/** Test seam. */
export function __resetLegWorkflowRanking(): void {
  legRankingStore.clear();
  legRankingWarm.clear();
}

router.get("/public/stats/leg-workflow-ranking", async (req, res) => {
  const featureSlug = req.query.featureSlug as string | undefined;
  // Every pipe's leg, sourcing (`start_to_lead_found`) included: one resolver, no special case (RANKING-SOURCE-LEG-1014).
  const legKey = await resolvePipeLegKey(featureSlug, String(req.query.leg ?? ""));
  if (!featureSlug || !legKey) {
    res.status(400).json({ error: `featureSlug and leg are required; leg must be one of: ${FUNNEL_LEG_KEYS.join(", ")}, or a leg of the channel's own` });
    return;
  }
  const rawPricing = req.query.pricing;
  if (rawPricing !== undefined && rawPricing !== "gross" && rawPricing !== "net") {
    res.status(400).json({ error: "pricing_unrecognised", detail: "pricing must be gross or net" });
    return;
  }
  const pricing: "gross" | "net" = rawPricing === "net" ? "net" : "gross";
  try {
    // A channel is a seeded feature row OR a declared channel (WA-PIPE-RESEARCH-1023: social-post, email-sending and
    // ai-lead-proposal are declared, so their pipes 404'd while the ranking itself builds like any other pipe's).
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature && !(await listDeclaredChannels()).some((c) => c.slug === featureSlug)) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
  } catch (error) {
    console.error("[features-service] leg workflow ranking: feature lookup failed:", error);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  // The last build, the persisted copy included (a fresh process served an empty ranking for minutes after every
  // deploy while the stored copy sat in the cell store); kicks a rebuild when stale, never waits on it.
  const stored = await readLegWorkflowRanking(featureSlug, legKey, 0);
  if (stored) {
    const served = legRankingOnPricing(stored, pricing, await workflowTacticsOf());
    try {
      // Each workflow's own icon + colour (MARKS-1022), given on first sight in rank order, the same on every read.
      res.json(await withWorkflowRankingMarks(served));
    } catch (error) {
      console.error("[features-service] leg workflow ranking: workflow marks unreadable:", error);
      res.status(502).json({ error: "workflow marks unreadable", reason: "marks_unreadable" });
    }
    return;
  }
  const rule = legMaturity(legKey);
  const empty: LegWorkflowRankingPayload = {
    featureSlug,
    legKey,
    grain: "fleet",
    costBasis: "incurred",
    computedAt: null,
    maturity: { durationDays: rule.durationDays, outcomesRequired: rule.outcomesRequired, cutoffIso: null, measured: false },
    pricing,
    rows: [],
  };
  res.json(empty);
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
