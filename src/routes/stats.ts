import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature, type FeatureChart } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { STATS_REGISTRY, getPublicRegistry, type StatsKeyDef } from "../lib/stats-registry.js";

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL!;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY!;
const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL!;
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY!;
const OUTLETS_SERVICE_URL = process.env.OUTLETS_SERVICE_URL!;
const OUTLETS_SERVICE_API_KEY = process.env.OUTLETS_SERVICE_API_KEY!;

const router = Router();

// ── Types ────────────────────────────────────────────────────────────────────

interface SystemStats {
  totalCostInUsdCents: number;
  completedRuns: number;
  activeCampaigns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface StatsGroup {
  workflowName?: string | null;
  brandId?: string | null;
  campaignId?: string | null;
  systemStats: SystemStats;
  stats: Record<string, number | null>;
}

type GroupByDimension = "workflowName" | "brandId" | "campaignId" | "featureSlug";

const VALID_GROUP_BY: Set<string> = new Set(["workflowName", "brandId", "campaignId", "featureSlug"]);

// ── Lineage resolution ──────────────────────────────────────────────────────

/**
 * Collect all slugs in a feature's upgrade chain (ancestors + descendants).
 * Traverses forkedFrom upward and upgradedTo downward to build the full dynasty.
 * Used to aggregate stats across the entire lineage of a feature.
 */
async function collectLineageSlugs(feature: Feature): Promise<string[]> {
  const slugs = new Set<string>();
  slugs.add(feature.slug);

  // Walk up the chain (ancestors via forkedFrom)
  let currentId = feature.forkedFrom;
  const visited = new Set<string>([feature.id]);
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = await db.query.features.findFirst({
      where: eq(features.id, currentId),
    });
    if (!ancestor) break;
    slugs.add(ancestor.slug);
    currentId = ancestor.forkedFrom;
  }

  // Walk down the chain (descendants via upgradedTo)
  currentId = feature.upgradedTo;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const descendant = await db.query.features.findFirst({
      where: eq(features.id, currentId),
    });
    if (!descendant) break;
    slugs.add(descendant.slug);
    currentId = descendant.upgradedTo;
  }

  return [...slugs];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all stats keys referenced by a feature (outputs + charts).
 */
function collectRequiredKeys(feature: Feature): Set<string> {
  const keys = new Set<string>();

  for (const output of feature.outputs) {
    keys.add(output.key);
  }

  for (const chart of feature.charts) {
    if (chart.type === "funnel-bar") {
      for (const step of chart.steps) keys.add(step.key);
    } else if (chart.type === "breakdown-bar") {
      for (const segment of chart.segments) keys.add(segment.key);
    }
  }

  // Also collect raw dependencies of derived keys
  for (const key of [...keys]) {
    const def = STATS_REGISTRY[key];
    if (def?.kind === "derived") {
      keys.add(def.numerator);
      keys.add(def.denominator);
    }
  }

  return keys;
}

/**
 * Determine which sources need to be called for a set of keys.
 */
function requiredSources(keys: Set<string>): Set<string> {
  const sources = new Set<string>();
  for (const key of keys) {
    const def = STATS_REGISTRY[key];
    if (def?.kind === "raw") {
      sources.add(def.source);
    }
  }
  return sources;
}

/**
 * Fetch email stats from email-gateway, grouped by the requested dimension.
 */
async function fetchEmailStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: { userId: string; runId: string },
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy === "workflowName") params.set("groupBy", "workflowName");
  if (groupBy === "brandId") params.set("groupBy", "brandId");
  if (groupBy === "campaignId") params.set("groupBy", "campaignId");
  if (filters.workflowName) params.set("workflowName", filters.workflowName);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/stats?${params}`;
  const response = await fetch(url, {
    headers: {
      "x-api-key": EMAIL_GATEWAY_SERVICE_API_KEY,
      "x-org-id": orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!response.ok) {
    console.error(`[stats] email-gateway /stats failed: ${response.status}`);
    return new Map();
  }

  const data = await response.json() as Record<string, unknown>;
  const result = new Map<string, Record<string, number>>();

  // If grouped, response has { groups: [{ key, broadcast?, transactional? }] }
  if (data.groups && Array.isArray(data.groups)) {
    for (const group of data.groups as Array<Record<string, unknown>>) {
      const groupKey = String(group.key ?? "__total__");
      result.set(groupKey, mergeEmailChannels(group));
    }
  } else {
    // Flat response: { broadcast?, transactional? }
    result.set("__total__", mergeEmailChannels(data));
  }

  return result;
}

/**
 * Merge broadcast + transactional stats into a single record.
 */
function mergeEmailChannels(data: Record<string, unknown>): Record<string, number> {
  const merged: Record<string, number> = {};
  const emailFields = [
    "emailsContacted", "emailsSent", "emailsDelivered", "emailsOpened",
    "emailsClicked", "emailsReplied", "emailsBounced", "recipients",
    "repliesWillingToMeet", "repliesInterested", "repliesNotInterested",
    "repliesOutOfOffice", "repliesUnsubscribe",
  ];

  const broadcast = (data.broadcast ?? {}) as Record<string, number>;
  const transactional = (data.transactional ?? {}) as Record<string, number>;

  for (const field of emailFields) {
    merged[field] = (broadcast[field] ?? 0) + (transactional[field] ?? 0);
  }

  return merged;
}

/**
 * Fetch cost/run stats from runs-service, grouped by the requested dimension.
 * Accepts an array of featureSlugs to aggregate across the full upgrade chain.
 * Makes one call per slug and merges the results.
 */
async function fetchRunsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlugs: string[] | undefined,
  identity: { userId: string; runId: string },
): Promise<Map<string, { totalCostInUsdCents: number; completedRuns: number }>> {
  const slugsToQuery = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);

  if (slugsToQuery.length === 0) {
    // No feature slug filter — single call without featureSlug param
    return fetchRunsStatsForSlug(orgId, groupBy, filters, undefined, identity);
  }

  // Call runs-service once per slug, then merge
  const maps = await Promise.all(
    slugsToQuery.map((slug) => fetchRunsStatsForSlug(orgId, groupBy, filters, slug, identity)),
  );

  // Merge all maps by summing costs and runs per group key
  const merged = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  for (const map of maps) {
    for (const [key, data] of map) {
      const existing = merged.get(key);
      if (existing) {
        existing.totalCostInUsdCents += data.totalCostInUsdCents;
        existing.completedRuns += data.completedRuns;
      } else {
        merged.set(key, { ...data });
      }
    }
  }

  return merged;
}

async function fetchRunsStatsForSlug(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlug: string | undefined,
  identity: { userId: string; runId: string },
): Promise<Map<string, { totalCostInUsdCents: number; completedRuns: number }>> {
  const runsGroupBy = groupBy ?? "workflowName";
  const params = new URLSearchParams({ groupBy: runsGroupBy });
  if (filters.workflowName) params.set("workflowName", filters.workflowName);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (featureSlug) params.set("featureSlug", featureSlug);

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  const response = await fetch(url, {
    headers: {
      "x-api-key": RUNS_SERVICE_API_KEY,
      "x-org-id": orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!response.ok) {
    console.error(`[stats] runs-service /v1/stats/costs failed: ${response.status}`);
    return new Map();
  }

  const data = await response.json() as {
    groups: Array<{
      dimensions: Record<string, string | null>;
      totalCostInUsdCents: string;
      runCount: number;
    }>;
  };

  const result = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();

  for (const group of data.groups) {
    const key = group.dimensions[runsGroupBy] ?? "__total__";
    result.set(key, {
      totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
      completedRuns: group.runCount,
    });
  }

  return result;
}

/**
 * Fetch outlet stats from outlets-service, grouped by the requested dimension.
 */
async function fetchOutletsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: { userId: string; runId: string },
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy === "workflowName") params.set("groupBy", "workflowName");
  if (groupBy === "brandId") params.set("groupBy", "brandId");
  if (groupBy === "campaignId") params.set("groupBy", "campaignId");
  if (filters.workflowName) params.set("workflowName", filters.workflowName);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${OUTLETS_SERVICE_URL}/outlets/stats?${params}`;
  const response = await fetch(url, {
    headers: {
      "x-api-key": OUTLETS_SERVICE_API_KEY,
      "x-org-id": orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!response.ok) {
    console.error(`[stats] outlets-service /outlets/stats failed: ${response.status}`);
    return new Map();
  }

  const data = await response.json() as Record<string, unknown>;
  const result = new Map<string, Record<string, number>>();

  if (data.groups && Array.isArray(data.groups)) {
    for (const group of data.groups as Array<Record<string, unknown>>) {
      const groupKey = String(group.key ?? "__total__");
      result.set(groupKey, extractOutletFields(group));
    }
  } else {
    result.set("__total__", extractOutletFields(data));
  }

  return result;
}

/**
 * Extract outlet stats fields from a response object.
 */
function extractOutletFields(data: Record<string, unknown>): Record<string, number> {
  return {
    outletsDiscovered: Number(data.outletsDiscovered ?? 0),
    avgRelevanceScore: Number(data.avgRelevanceScore ?? 0),
    searchQueriesUsed: Number(data.searchQueriesUsed ?? 0),
  };
}

/**
 * Compute derived stats from raw values.
 */
function computeDerivedStats(
  rawStats: Record<string, number>,
  requiredKeys: Set<string>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};

  for (const key of requiredKeys) {
    const def = STATS_REGISTRY[key];
    if (!def) continue;

    if (def.kind === "raw") {
      result[key] = rawStats[key] ?? null;
    } else if (def.kind === "derived") {
      const num = rawStats[def.numerator];
      const den = rawStats[def.denominator];
      if (num != null && den != null && den > 0) {
        result[key] = num / den;
      } else {
        result[key] = null;
      }
    }
  }

  return result;
}

/**
 * Build system stats from raw data.
 */
function buildSystemStats(runsData: { totalCostInUsdCents: number; completedRuns: number } | undefined): SystemStats {
  return {
    totalCostInUsdCents: runsData?.totalCostInUsdCents ?? 0,
    completedRuns: runsData?.completedRuns ?? 0,
    activeCampaigns: 0, // TODO: call campaign-service
    firstRunAt: null, // TODO: runs-service needs min/max started_at
    lastRunAt: null,
  };
}

// ── GET /stats/registry ──────────────────────────────────────────────────────

/**
 * Returns the complete stats key registry with label and type for each key.
 * The front-end uses this to know how to format and label output columns.
 */
router.get("/stats/registry", apiKeyAuth, async (_req: AuthenticatedRequest, res) => {
  res.json({ registry: getPublicRegistry() });
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────────

/**
 * Returns computed stats for a feature, optionally grouped by a dimension.
 *
 * Query params:
 *   - groupBy: "workflowName" | "brandId" | "campaignId" (optional)
 *   - brandId: filter by brand (optional)
 *   - campaignId: filter by campaign (optional)
 *   - workflowName: filter by workflow (optional)
 */
router.get("/features/:featureSlug/stats", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId, userId, runId } = req;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, featureSlug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const groupByParam = req.query.groupBy as string | undefined;
    const groupBy = (groupByParam && VALID_GROUP_BY.has(groupByParam) ? groupByParam : null) as GroupByDimension | null;

    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;
    if (req.query.workflowName) filters.workflowName = req.query.workflowName as string;

    // Resolve the full upgrade chain — aggregate stats across all ancestors + descendants
    const lineageSlugs = await collectLineageSlugs(feature);

    // Determine which keys and sources we need
    const requiredKeys = collectRequiredKeys(feature);
    const sources = requiredSources(requiredKeys);

    // Fetch data from sources in parallel
    // runs-service: pass all lineage slugs to aggregate across the full chain
    const identity = { userId, runId };
    const [emailStatsMap, runsStatsMap, outletsStatsMap] = await Promise.all([
      sources.has("email-gateway") ? fetchEmailStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("runs") || true ? fetchRunsStats(orgId, groupBy, filters, lineageSlugs, identity) : Promise.resolve(new Map<string, { totalCostInUsdCents: number; completedRuns: number }>()),
      sources.has("outlets") ? fetchOutletsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
    ]);

    if (!groupBy) {
      // No grouping — return flat stats
      const emailStats = emailStatsMap.get("__total__") ?? {};
      const runsStats = runsStatsMap.get("__total__");
      const outletsStats = outletsStatsMap.get("__total__") ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      return res.json({
        featureSlug,
        systemStats: buildSystemStats(runsStats),
        stats: computeDerivedStats(rawStats, requiredKeys),
      });
    }

    // Grouped — collect all group keys from all sources
    const allGroupKeys = new Set<string>();
    for (const key of emailStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of runsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of outletsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);

    // Compute totals for top-level systemStats
    let totalCost = 0;
    let totalRuns = 0;
    for (const runsData of runsStatsMap.values()) {
      totalCost += runsData.totalCostInUsdCents;
      totalRuns += runsData.completedRuns;
    }

    const groups: StatsGroup[] = [];
    for (const groupKey of allGroupKeys) {
      const emailStats = emailStatsMap.get(groupKey) ?? {};
      const runsStats = runsStatsMap.get(groupKey);
      const outletsStats = outletsStatsMap.get(groupKey) ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStats),
        stats: computeDerivedStats(rawStats, requiredKeys),
      };

      // Set the dimension key explicitly
      if (groupBy === "workflowName") group.workflowName = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({
      featureSlug,
      groupBy,
      systemStats: buildSystemStats({ totalCostInUsdCents: totalCost, completedRuns: totalRuns }),
      groups,
    });
  } catch (error) {
    console.error("Feature stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats ──────────────────────────────────────────────────────────────

/**
 * Global stats endpoint — cross-features.
 * Used by performance-service and org overview.
 *
 * Query params:
 *   - groupBy: "featureSlug" | "featureSlug,workflowName" | "workflowName" | "brandId"
 *   - brandId: filter by brand (optional)
 */
router.get("/stats", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { orgId, userId, runId } = req;

    const groupByParam = req.query.groupBy as string | undefined;
    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;

    // For the global endpoint, fetch all active features and aggregate
    const allFeatures = await db.query.features.findMany({
      where: eq(features.status, "active"),
    });

    // Collect ALL keys across all features
    const allKeys = new Set<string>();
    for (const feature of allFeatures) {
      const keys = collectRequiredKeys(feature);
      for (const key of keys) allKeys.add(key);
    }
    const sources = requiredSources(allKeys);

    const groupBy = (groupByParam?.split(",")[0] ?? null) as GroupByDimension | null;

    const identity = { userId, runId };
    const [emailStatsMap, runsStatsMap, outletsStatsMap] = await Promise.all([
      sources.has("email-gateway") ? fetchEmailStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      fetchRunsStats(orgId, groupBy, filters, undefined, identity),
      sources.has("outlets") ? fetchOutletsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
    ]);

    if (!groupBy) {
      // No grouping — flat aggregate
      const emailStats = emailStatsMap.get("__total__") ?? {};
      const runsStats = runsStatsMap.get("__total__");
      const outletsStats = outletsStatsMap.get("__total__") ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      return res.json({
        systemStats: buildSystemStats(runsStats),
        stats: computeDerivedStats(rawStats, allKeys),
      });
    }

    // Grouped
    const allGroupKeys = new Set<string>();
    for (const key of emailStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of runsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of outletsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);

    let totalCost = 0;
    let totalRuns = 0;
    for (const runsData of runsStatsMap.values()) {
      totalCost += runsData.totalCostInUsdCents;
      totalRuns += runsData.completedRuns;
    }

    const groups: StatsGroup[] = [];
    for (const groupKey of allGroupKeys) {
      const emailStats = emailStatsMap.get(groupKey) ?? {};
      const runsStats = runsStatsMap.get(groupKey);
      const outletsStats = outletsStatsMap.get(groupKey) ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStats),
        stats: computeDerivedStats(rawStats, allKeys),
      };

      if (groupBy === "workflowName") group.workflowName = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({
      groupBy: groupByParam,
      systemStats: buildSystemStats({ totalCostInUsdCents: totalCost, completedRuns: totalRuns }),
      groups,
    });
  } catch (error) {
    console.error("Global stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
