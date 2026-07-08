import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature } from "../db/schema.js";
import { STATS_REGISTRY } from "../lib/stats-registry.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
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
  buildCostPerOutcomeTrend,
  buildWorkflowCostPerOutcome,
  fetchFleetBrandEconomics,
  meanFleetEconomics,
  normalizeObjective,
  type ObjectiveAverages,
  type TrendPoint,
  type DayOutcome,
  type WorkflowCostRow,
  type WorkflowGrainInput,
} from "../lib/cross-org-cost-per-outcome.js";
import { fetchFeatureMemberships } from "../lib/feature-memberships-client.js";
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
import { apiKeyOnly } from "../middleware/auth.js";
import { BrandOwnershipError, fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { computeFeatureRevenue, buildCostEconomics, type DownstreamHeaders } from "./revenue.js";

const router = Router();

const PUBLIC_STATS_TTL_MS = 60_000;

const publicRankedCache = new Map<string, { payload: unknown; expiresAt: number }>();
const publicBestCache = new Map<string, { payload: unknown; expiresAt: number }>();
const publicWorkflowLatencyCache = new Map<string, { payload: unknown; expiresAt: number }>();

/** Test seam — reset the in-memory public stats caches. */
export function __resetPublicStatsCache(): void {
  publicRankedCache.clear();
  publicBestCache.clear();
  publicWorkflowLatencyCache.clear();
}

// The ONE in-memory memo primitive shared by EVERY cross-org /public/* + /internal/stats/* endpoint
// (these have no per-org scope_key, so they don't use the Gold `feature_view_snapshots` layer). Every
// cache is a `PublicCache` (uniform shape) → one get/set/TTL, the caller names the payload type via <T>.
type PublicCache = Map<string, { payload: unknown; expiresAt: number }>;

function getPublicCache<T>(cache: PublicCache, key: string): T | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.payload as T;
}

function setPublicCache<T>(cache: PublicCache, key: string, payload: T): void {
  cache.set(key, { payload, expiresAt: Date.now() + PUBLIC_STATS_TTL_MS });
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
  const cached = getPublicCache<{ objective: string; sortDirection: "asc" | "desc"; results: unknown[] }>(publicRankedCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

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

  const payload = { objective, sortDirection, results };
  setPublicCache(publicRankedCache, cacheKey, payload);
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
  const cached = getPublicCache<{ best: Record<string, unknown> }>(publicBestCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

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

  const payload = { best };
  setPublicCache(publicBestCache, cacheKey, payload);
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
  revenueCache.clear();
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
  const cached = getPublicCache<PublicRevenuePayload>(revenueCache, cacheKey);
  if (cached) {
    res.json(rollup ? revenueRollup(cached) : cached);
    return;
  }

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

  const payload: PublicRevenuePayload = { featureSlug, groupBy: "brand", results };
  setPublicCache(revenueCache, cacheKey, payload);
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
  const cached = getPublicCache<PublicWorkflowEngagementLatencyPayload>(publicWorkflowLatencyCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

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

  const payload: PublicWorkflowEngagementLatencyPayload = { featureSlug, groupBy: "workflow", results };
  setPublicCache(publicWorkflowLatencyCache, cacheKey, payload);
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
   * avgCostPerOutcomeByObjective.meetingBooked / .purchase. */
  avgCostPerMeetingBooked: number | null;
  avgCostPerPurchase: number | null;
  /** Fleet-average cost-per-outcome for EVERY optimization objective (null where no brand is backed).
   * websiteVisit / positiveReply = CPC / CPPR; the rest project through the funnel. Gap #1 (#485). */
  avgCostPerOutcomeByObjective: ObjectiveAverages;
  brandCount: number;
}

const costProjectionCache: PublicCache = new Map();

/** Test seam — reset the in-memory cost-projection cache. */
export function __resetPublicCostProjectionCache(): void {
  costProjectionCache.clear();
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

  const cached = getPublicCache<PublicCostProjectionPayload>(costProjectionCache, featureSlug);
  if (cached) {
    res.json(cached);
    return;
  }

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

  const payload: PublicCostProjectionPayload = {
    featureSlug,
    avgCostPerMeetingBooked: objectives.meetingBooked,
    avgCostPerPurchase: objectives.purchase,
    avgCostPerOutcomeByObjective: objectives,
    brandCount,
  };
  setPublicCache(costProjectionCache, featureSlug, payload);
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
  costPerOutcomeTrendCache.clear();
}

/**
 * Extract the UTC day (YYYY-MM-DD) a runs-service day-grouped cost group belongs to. runs-service owns
 * the exact dimension key for its `groupBy=day` design — read the day-shaped dimension value, falling
 * back to the group's earliest run timestamp. (Consumer stays tolerant to the deployed shape per the
 * live>source rule; conform once runs-service ships.)
 */
function dayKeyFromCostGroup(group: {
  dimensions: Record<string, string | null>;
  minStartedAt?: string | null;
}): string | null {
  for (const v of Object.values(group.dimensions)) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  if (typeof group.minStartedAt === "string" && group.minStartedAt.length >= 10) {
    return group.minStartedAt.slice(0, 10);
  }
  return null;
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
  const cached = getPublicCache<CostPerOutcomeTrendPayload>(costPerOutcomeTrendCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const [spendGroups, dayOutcomeMap, perBrandEconomics] = await Promise.all([
    fetchPublicCosts(featureSlug, "day"),
    fetchPublicEmailStats(featureSlug, "day"),
    fetchFleetBrandEconomics(featureSlug),
  ]);

  const spendByDay = new Map<string, number>();
  for (const g of spendGroups) {
    const day = dayKeyFromCostGroup(g);
    if (!day) continue;
    spendByDay.set(day, (spendByDay.get(day) ?? 0) + Number(g.totalCostInUsdCents) / 100);
  }

  const outcomesByDay = new Map<string, DayOutcome>();
  for (const [day, fields] of dayOutcomeMap) {
    if (day === "__total__") continue;
    outcomesByDay.set(day, {
      clicks: fields.recipientsClicked ?? 0,
      replies: fields.recipientsRepliesPositive ?? 0,
    });
  }

  const fleetEcon = meanFleetEconomics(perBrandEconomics);
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

  const payload: CostPerOutcomeTrendPayload = { featureSlug, objective, windowOutcomes, points };
  setPublicCache(costPerOutcomeTrendCache, cacheKey, payload);
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
  workflows: WorkflowCostRow[];
}

const workflowCostPerOutcomeCache: PublicCache = new Map();

/** Test seam — reset the in-memory workflow-cost-per-outcome cache. */
export function __resetWorkflowCostPerOutcomeCache(): void {
  workflowCostPerOutcomeCache.clear();
}

export async function handleWorkflowCostPerOutcome(
  featureSlug: string | undefined,
  objectiveParam: string | undefined,
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

  const cacheKey = `wf-cpo:${featureSlug}:${objective}`;
  const cached = getPublicCache<WorkflowCostPerOutcomePayload>(workflowCostPerOutcomeCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

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

  // Fleet parent unit costs (crossOrg CPC / CPPR) — the cascade floor the projected engine falls back to.
  let totalSpent = 0, totalClicks = 0, totalReplies = 0;
  for (const r of byDynasty.values()) {
    totalSpent += r.spentUsd;
    totalClicks += r.clicks;
    totalReplies += r.replies;
  }
  const fleetParentClickUsd = totalClicks > 0 && totalSpent > 0 ? totalSpent / totalClicks : null;
  const fleetParentReplyUsd = totalReplies > 0 && totalSpent > 0 ? totalSpent / totalReplies : null;

  const rows = buildWorkflowCostPerOutcome({
    objective,
    rows: [...byDynasty.values()],
    fleetParentClickUsd,
    fleetParentReplyUsd,
    fleetEcon: meanFleetEconomics(perBrandEconomics),
    projectedFloor: projectedCostPerOutcome,
  });

  const payload: WorkflowCostPerOutcomePayload = { featureSlug, objective, workflows: rows };
  setPublicCache(workflowCostPerOutcomeCache, cacheKey, payload);
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
  sendForecastCache.clear();
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
  const cached = getPublicCache<SendForecastPayload>(sendForecastCache, cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

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

  const payload = buildSendForecast({
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

  setPublicCache(sendForecastCache, cacheKey, payload);
  res.json(payload);
}

// ── GET /internal/stats/accounts ─────────────────────────────────────────────

// Single global (cross-org) result → a 1-key Map so it uses the SAME shared memo helper as the others.
const accountsCache: PublicCache = new Map();

/** Test seam — reset the in-memory accounts-audit cache. */
export function __resetAccountsCache(): void {
  accountsCache.clear();
}

/**
 * GET /internal/stats/accounts — GLOBAL (cross-org, fleet-wide) list of every cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account
 * is truly ACTIVE, plus fleet financial stats (total active daily budget → MRR → ARR). All money +
 * the active determination + MRR/ARR are computed HERE; the admin dashboard renders only. See
 * accounts-compute.ts. 60s in-memory cache, same pattern as the other /internal/stats/* audits.
 */
export async function handleAccounts(res: import("express").Response): Promise<void> {
  const cached = getPublicCache<AccountsAudit>(accountsCache, "accounts");
  if (cached) {
    res.json(cached);
    return;
  }

  const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
  const coldCsv = coldEmailOutreachSlugs(allFeatures.map((f) => f.slug)).join(",");

  const payload = await buildAccountsAudit(coldCsv, new Date());

  setPublicCache(accountsCache, "accounts", payload);
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
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats workflow-cost-per-outcome error:", error);
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
