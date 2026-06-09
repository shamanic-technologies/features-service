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
import { getFunnel } from "../lib/funnel-registry.js";
import { fetchFeatureMemberships } from "../lib/feature-memberships-client.js";
import { BrandOwnershipError } from "../lib/sales-economics-client.js";
import { computeFeatureRevenue, buildCostEconomics, type DownstreamHeaders } from "./revenue.js";

const router = Router();

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

  res.json({ objective, sortDirection, results });
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

  res.json({ best });
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

const REVENUE_TTL_MS = 60_000;

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

const revenueCache = new Map<string, { payload: PublicRevenuePayload; expiresAt: number }>();

/** Test seam — reset the in-memory public-revenue cache. */
export function __resetPublicRevenueCache(): void {
  revenueCache.clear();
}

export async function handlePublicRevenue(
  featureSlug: string | undefined,
  groupBy: string | undefined,
  res: import("express").Response,
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
  const cached = revenueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.payload);
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
          costUsd: body.costEconomics.totalCostUsd,
          timeSeries: body.timeSeries,
        };
      } catch (error) {
        if (error instanceof BrandOwnershipError) {
          console.warn(
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
    if (ap === null && bp === null) return b.costEconomics.totalCostUsd - a.costEconomics.totalCostUsd;
    if (ap === null) return 1;
    if (bp === null) return -1;
    if (bp !== ap) return bp - ap;
    return b.costEconomics.totalCostUsd - a.costEconomics.totalCostUsd;
  });

  const payload: PublicRevenuePayload = { featureSlug, groupBy: "brand", results };
  revenueCache.set(cacheKey, { payload, expiresAt: Date.now() + REVENUE_TTL_MS });
  res.json(payload);
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
    await handlePublicRevenue(req.query.featureSlug as string | undefined, req.query.groupBy as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Public stats revenue error:", error);
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
