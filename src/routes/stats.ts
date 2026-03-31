import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature, type FeatureChart } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { STATS_REGISTRY, getPublicRegistry, type StatsKeyDef, type RunFilter } from "../lib/stats-registry.js";
// dynasty-client is used by features.ts for resolution endpoints;
// stats.ts passes dynasty params through to downstream services directly.

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL!;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY!;
const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL!;
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY!;
const OUTLETS_SERVICE_URL = process.env.OUTLETS_SERVICE_URL!;
const OUTLETS_SERVICE_API_KEY = process.env.OUTLETS_SERVICE_API_KEY!;
// Read lazily — not available at module scope in test environments
function getJournalistsServiceUrl(): string { return process.env.JOURNALISTS_SERVICE_URL!; }
function getJournalistsServiceApiKey(): string { return process.env.JOURNALISTS_SERVICE_API_KEY!; }
function getLeadServiceUrl(): string { return process.env.LEAD_SERVICE_URL!; }
function getLeadServiceApiKey(): string { return process.env.LEAD_SERVICE_API_KEY!; }
function getPressKitsServiceUrl(): string { return process.env.PRESS_KITS_SERVICE_URL!; }
function getPressKitsServiceApiKey(): string { return process.env.PRESS_KITS_SERVICE_API_KEY!; }

const router = Router();

// ── Helpers — downstream headers ─────────────────────────────────────────────

interface Identity {
  userId: string;
  runId: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
}

function buildDownstreamHeaders(
  apiKey: string,
  orgId: string,
  identity: Identity,
): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.brandId) h["x-brand-id"] = identity.brandId;
  if (identity.campaignId) h["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) h["x-feature-slug"] = identity.featureSlug;
  return h;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SystemStats {
  totalCostInUsdCents: number;
  completedRuns: number;
  activeCampaigns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface StatsGroup {
  workflowSlug?: string | null;
  workflowDynastySlug?: string | null;
  brandId?: string | null;
  campaignId?: string | null;
  featureDynastySlug?: string | null;
  systemStats: SystemStats;
  stats: Record<string, number | null>;
}

interface RunsStatsEntry {
  totalCostInUsdCents: number;
  completedRuns: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
}

type GroupByDimension = "workflowSlug" | "workflowDynastySlug" | "brandId" | "campaignId" | "featureSlug" | "featureDynastySlug";

const VALID_GROUP_BY: Set<string> = new Set([
  "workflowSlug", "workflowDynastySlug", "brandId", "campaignId", "featureSlug", "featureDynastySlug",
]);

// ── Lineage resolution (BFS predecessor map) ───────────────────────────────

/**
 * Collect all slugs in a feature's upgrade chain using BFS.
 * Handles convergence where one feature has multiple predecessors
 * (two dynasties upgraded to produce the same signature).
 *
 * Algorithm:
 * 1. Load all deprecated features with upgradedTo set
 * 2. Build predecessor map: upgradedTo → [predecessor_ids]
 * 3. BFS from the target feature, walking predecessors backward
 * 4. Also walk upgradedTo forward (for querying deprecated features)
 * 5. Visited set prevents double-counting on convergence
 */
async function collectLineageSlugs(feature: Feature): Promise<string[]> {
  // Load all deprecated features to build the predecessor map
  const deprecated = await db.query.features.findMany({
    where: eq(features.status, "deprecated"),
    columns: { id: true, slug: true, upgradedTo: true },
  });

  // Build predecessor map: successorId → [predecessor records]
  const predecessorMap = new Map<string, Array<{ id: string; slug: string }>>();
  for (const dep of deprecated) {
    if (!dep.upgradedTo) continue;
    const list = predecessorMap.get(dep.upgradedTo) ?? [];
    list.push({ id: dep.id, slug: dep.slug });
    predecessorMap.set(dep.upgradedTo, list);
  }

  const slugs = new Set<string>();
  const visited = new Set<string>();

  // BFS backward (predecessors)
  const queue: string[] = [feature.id];
  slugs.add(feature.slug);
  visited.add(feature.id);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const preds = predecessorMap.get(currentId) ?? [];
    for (const pred of preds) {
      if (visited.has(pred.id)) continue;
      visited.add(pred.id);
      slugs.add(pred.slug);
      queue.push(pred.id);
    }
  }

  // Walk forward via upgradedTo (for querying deprecated features)
  let currentId = feature.upgradedTo;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const descendant = await db.query.features.findFirst({
      where: eq(features.id, currentId),
      columns: { id: true, slug: true, upgradedTo: true },
    });
    if (!descendant) break;
    slugs.add(descendant.slug);
    // Also BFS backward from this descendant to catch converging branches
    const descQueue: string[] = [descendant.id];
    while (descQueue.length > 0) {
      const descId = descQueue.shift()!;
      const descPreds = predecessorMap.get(descId) ?? [];
      for (const pred of descPreds) {
        if (visited.has(pred.id)) continue;
        visited.add(pred.id);
        slugs.add(pred.slug);
        descQueue.push(pred.id);
      }
    }
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
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(EMAIL_GATEWAY_SERVICE_API_KEY, orgId, identity),
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
  } catch (error) {
    console.error(`[stats] email-gateway /stats network error:`, (error as Error).message);
    return new Map();
  }
}

/**
 * Extract broadcast-only email stats (transactional emails are excluded).
 */
function mergeEmailChannels(data: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  const emailFields = [
    "emailsContacted", "emailsSent", "emailsDelivered", "emailsOpened",
    "emailsClicked", "emailsReplied", "emailsBounced", "recipients",
    "repliesWillingToMeet", "repliesInterested", "repliesNotInterested",
    "repliesOutOfOffice", "repliesUnsubscribe", "repliesMoreInfo", "repliesWrongContact",
  ];

  const broadcast = (data.broadcast ?? {}) as Record<string, number>;

  for (const field of emailFields) {
    result[field] = broadcast[field] ?? 0;
  }

  return result;
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
  identity: Identity,
): Promise<Map<string, RunsStatsEntry>> {
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
  const merged = new Map<string, RunsStatsEntry>();
  for (const map of maps) {
    for (const [key, data] of map) {
      const existing = merged.get(key);
      if (existing) {
        existing.totalCostInUsdCents += data.totalCostInUsdCents;
        existing.completedRuns += data.completedRuns;
        if (data.minStartedAt && (!existing.minStartedAt || data.minStartedAt < existing.minStartedAt)) {
          existing.minStartedAt = data.minStartedAt;
        }
        if (data.maxStartedAt && (!existing.maxStartedAt || data.maxStartedAt > existing.maxStartedAt)) {
          existing.maxStartedAt = data.maxStartedAt;
        }
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
  identity: Identity,
): Promise<Map<string, RunsStatsEntry>> {
  const runsGroupBy = groupBy ?? "workflowSlug";
  const params = new URLSearchParams({ groupBy: runsGroupBy });
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (featureSlug) params.set("featureSlug", featureSlug);

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity),
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
        minStartedAt: string | null;
        maxStartedAt: string | null;
      }>;
    };

    const result = new Map<string, RunsStatsEntry>();

    if (!groupBy) {
      // No grouping requested — aggregate all groups into __total__
      let totalCost = 0;
      let totalRuns = 0;
      let minStartedAt: string | null = null;
      let maxStartedAt: string | null = null;
      for (const group of data.groups) {
        totalCost += Math.round(Number(group.totalCostInUsdCents));
        totalRuns += group.runCount;
        if (group.minStartedAt && (!minStartedAt || group.minStartedAt < minStartedAt)) {
          minStartedAt = group.minStartedAt;
        }
        if (group.maxStartedAt && (!maxStartedAt || group.maxStartedAt > maxStartedAt)) {
          maxStartedAt = group.maxStartedAt;
        }
      }
      if (data.groups.length > 0) {
        result.set("__total__", { totalCostInUsdCents: totalCost, completedRuns: totalRuns, minStartedAt, maxStartedAt });
      }
    } else {
      for (const group of data.groups) {
        const key = group.dimensions[runsGroupBy] ?? "__total__";
        result.set(key, {
          totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
          completedRuns: group.runCount,
          minStartedAt: group.minStartedAt ?? null,
          maxStartedAt: group.maxStartedAt ?? null,
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`[stats] runs-service /v1/stats/costs network error:`, (error as Error).message);
    return new Map();
  }
}

/**
 * Collect pipeline stats keys (those with runFilter) from the required keys.
 */
function collectPipelineKeys(requiredKeys: Set<string>): Map<string, RunFilter> {
  const result = new Map<string, RunFilter>();
  for (const key of requiredKeys) {
    const def = STATS_REGISTRY[key];
    if (def?.kind === "raw" && def.runFilter) {
      result.set(key, def.runFilter);
    }
  }
  return result;
}

/**
 * Fetch pipeline counts from runs-service by counting runs per service+task.
 * Returns a map of groupKey → { statsKey → runCount }.
 */
async function fetchPipelineStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlugs: string[] | undefined,
  pipelineKeys: Map<string, RunFilter>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  if (pipelineKeys.size === 0) return new Map();

  // Dedupe filters — multiple stats keys can share the same runFilter
  const filterToKeys = new Map<string, { filter: RunFilter; keys: string[] }>();
  for (const [key, filter] of pipelineKeys) {
    const filterKey = `${filter.serviceName}:${filter.taskName}`;
    const entry = filterToKeys.get(filterKey);
    if (entry) {
      entry.keys.push(key);
    } else {
      filterToKeys.set(filterKey, { filter, keys: [key] });
    }
  }

  // Fetch counts for each unique filter in parallel
  const entries = [...filterToKeys.values()];
  const results = await Promise.all(
    entries.map(async ({ filter, keys }) => {
      const slugsToQuery = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);
      const maps = await Promise.all(
        (slugsToQuery.length > 0 ? slugsToQuery : [undefined]).map((slug) =>
          fetchPipelineStatsForFilter(orgId, groupBy, filters, slug, filter, identity),
        ),
      );

      // Merge across slugs
      const merged = new Map<string, number>();
      for (const map of maps) {
        for (const [groupKey, count] of map) {
          merged.set(groupKey, (merged.get(groupKey) ?? 0) + count);
        }
      }

      return { keys, counts: merged };
    }),
  );

  // Build final map: groupKey → { statsKey → count }
  const output = new Map<string, Record<string, number>>();
  for (const { keys, counts } of results) {
    for (const [groupKey, count] of counts) {
      const existing = output.get(groupKey) ?? {};
      for (const key of keys) {
        existing[key] = count;
      }
      output.set(groupKey, existing);
    }
  }

  return output;
}

async function fetchPipelineStatsForFilter(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlug: string | undefined,
  runFilter: RunFilter,
  identity: Identity,
): Promise<Map<string, number>> {
  const runsGroupBy = groupBy ?? "workflowSlug";
  const params = new URLSearchParams({
    groupBy: runsGroupBy,
    serviceName: runFilter.serviceName,
    taskName: runFilter.taskName,
  });
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (featureSlug) params.set("featureSlug", featureSlug);

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[stats] runs-service pipeline stats failed: ${response.status} (${runFilter.serviceName}/${runFilter.taskName})`);
      return new Map();
    }

    const data = await response.json() as {
      groups: Array<{
        dimensions: Record<string, string | null>;
        runCount: number;
      }>;
    };

    const result = new Map<string, number>();
    if (!groupBy) {
      // No grouping requested — aggregate all groups into __total__
      let total = 0;
      for (const group of data.groups) {
        total += group.runCount;
      }
      if (data.groups.length > 0) {
        result.set("__total__", total);
      }
    } else {
      for (const group of data.groups) {
        const key = group.dimensions[runsGroupBy] ?? "__total__";
        result.set(key, (result.get(key) ?? 0) + group.runCount);
      }
    }

    return result;
  } catch (error) {
    console.error(`[stats] runs-service pipeline stats network error (${runFilter.serviceName}/${runFilter.taskName}):`, (error as Error).message);
    return new Map();
  }
}

/**
 * Fetch outlet stats from outlets-service, grouped by the requested dimension.
 */
async function fetchOutletsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${OUTLETS_SERVICE_URL}/outlets/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(OUTLETS_SERVICE_API_KEY, orgId, identity),
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
  } catch (error) {
    console.error(`[stats] outlets-service /outlets/stats network error:`, (error as Error).message);
    return new Map();
  }
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
 * Fetch journalist stats from journalists-service, grouped by the requested dimension.
 * Maps totalJournalists → journalistsFound and byStatus.contacted → journalistsContacted.
 */
async function fetchJournalistsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  // journalists-service supports groupBy: featureSlug, workflowSlug, featureDynastySlug, workflowDynastySlug
  const supportedGroupBy = new Set(["featureSlug", "workflowSlug", "featureDynastySlug", "workflowDynastySlug"]);
  if (groupBy && supportedGroupBy.has(groupBy)) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${getJournalistsServiceUrl()}/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(getJournalistsServiceApiKey(), orgId, identity),
    });

    if (!response.ok) {
      console.error(`[stats] journalists-service /stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      totalJournalists: number;
      byStatus: Record<string, number>;
      groupedBy?: Record<string, { totalJournalists: number; byStatus: Record<string, number> }>;
    };

    const result = new Map<string, Record<string, number>>();

    if (data.groupedBy && groupBy && supportedGroupBy.has(groupBy)) {
      for (const [key, group] of Object.entries(data.groupedBy)) {
        result.set(key, extractJournalistFields(group));
      }
    } else {
      result.set("__total__", extractJournalistFields(data));
    }

    return result;
  } catch (error) {
    console.error(`[stats] journalists-service /stats network error:`, (error as Error).message);
    return new Map();
  }
}

function extractJournalistFields(data: { totalJournalists: number; byStatus: Record<string, number> }): Record<string, number> {
  return {
    journalistsFound: data.totalJournalists,
    journalistsContacted: data.byStatus.contacted ?? 0,
  };
}

/**
 * Fetch lead stats from lead-service /stats endpoint.
 * Maps served → leadsServed.
 */
async function fetchLeadsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  const supportedGroupBy = new Set(["featureSlug", "workflowSlug", "featureDynastySlug", "workflowDynastySlug", "campaignId", "brandId"]);
  if (groupBy && supportedGroupBy.has(groupBy)) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${getLeadServiceUrl()}/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(getLeadServiceApiKey(), orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] lead-service /stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as
      | { served: number; contacted: number; buffered: number; skipped: number; groups?: undefined }
      | { groups: Array<{ key: string; served: number; contacted: number; buffered: number; skipped: number }> };

    const result = new Map<string, Record<string, number>>();

    if ("groups" in data && data.groups) {
      for (const group of data.groups) {
        result.set(group.key, { leadsServed: group.served });
      }
    } else if ("served" in data) {
      result.set("__total__", { leadsServed: data.served });
    }

    return result;
  } catch (error) {
    console.error(`[features-service] lead-service /stats network error:`, (error as Error).message);
    return new Map();
  }
}

/**
 * Fetch press kit stats from press-kits-service.
 * Calls both /media-kits/stats/views (views + unique visitors) and
 * /media-kits/stats/costs (generation count) in parallel.
 *
 * Supported filters: brandId, campaignId, featureDynastySlug, workflowDynastySlug.
 * Supported groupBy: brandId, campaignId, featureDynastySlug, workflowDynastySlug.
 */
async function fetchPressKitsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const headers = buildDownstreamHeaders(getPressKitsServiceApiKey(), orgId, identity);

  const supportedGroupBy = new Set(["brandId", "campaignId", "featureDynastySlug", "workflowDynastySlug"]);

  function applyFilters(params: URLSearchParams): void {
    if (filters.brandId) params.set("brandId", filters.brandId);
    if (filters.campaignId) params.set("campaignId", filters.campaignId);
    if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
    if (filters.featureDynastySlug) params.set("featureDynastySlug", filters.featureDynastySlug);
  }

  const viewsParams = new URLSearchParams();
  applyFilters(viewsParams);
  if (groupBy && supportedGroupBy.has(groupBy)) {
    viewsParams.set("groupBy", groupBy);
  }

  const costsParams = new URLSearchParams();
  applyFilters(costsParams);
  if (groupBy && supportedGroupBy.has(groupBy)) {
    costsParams.set("groupBy", groupBy);
  }

  try {
    const [viewsRes, costsRes] = await Promise.all([
      fetch(`${getPressKitsServiceUrl()}/media-kits/stats/views?${viewsParams}`, { headers }),
      fetch(`${getPressKitsServiceUrl()}/media-kits/stats/costs?${costsParams}`, { headers }),
    ]);

    // ── Parse views ────────────────────────────────────────────────────────
    const viewsByGroup = new Map<string, { views: number; unique: number }>();

    if (viewsRes.ok) {
      const viewsData = await viewsRes.json() as Record<string, unknown>;
      if (viewsData.groups && Array.isArray(viewsData.groups)) {
        for (const g of viewsData.groups as Array<Record<string, unknown>>) {
          const key = String(g.key ?? "__total__");
          viewsByGroup.set(key, {
            views: Number(g.totalViews ?? 0),
            unique: Number(g.uniqueVisitors ?? 0),
          });
        }
      } else {
        viewsByGroup.set("__total__", {
          views: Number((viewsData as any).totalViews ?? 0),
          unique: Number((viewsData as any).uniqueVisitors ?? 0),
        });
      }
    } else {
      console.error(`[features-service] press-kits-service /media-kits/stats/views failed: ${viewsRes.status}`);
    }

    // ── Parse costs ────────────────────────────────────────────────────────
    const costsByGroup = new Map<string, number>();

    if (costsRes.ok) {
      const costsData = await costsRes.json() as {
        groups: Array<{ dimensions: Record<string, string | null>; runCount: number }>;
      };
      if (!groupBy || !supportedGroupBy.has(groupBy)) {
        let total = 0;
        for (const g of costsData.groups) total += g.runCount;
        if (costsData.groups.length > 0) costsByGroup.set("__total__", total);
      } else {
        for (const g of costsData.groups) {
          const key = g.dimensions[groupBy] ?? "__total__";
          costsByGroup.set(key, (costsByGroup.get(key) ?? 0) + g.runCount);
        }
      }
    } else {
      console.error(`[features-service] press-kits-service /media-kits/stats/costs failed: ${costsRes.status}`);
    }

    // ── Merge into result map ──────────────────────────────────────────────
    const result = new Map<string, Record<string, number>>();
    const allKeys = new Set([...viewsByGroup.keys(), ...costsByGroup.keys()]);

    for (const key of allKeys) {
      const stats: Record<string, number> = {};
      const v = viewsByGroup.get(key);
      if (v) {
        stats.pressKitViews = v.views;
        stats.pressKitUniqueVisitors = v.unique;
      }
      const c = costsByGroup.get(key);
      if (c != null) {
        stats.pressKitsGenerated = c;
      }
      if (Object.keys(stats).length > 0) {
        result.set(key, stats);
      }
    }

    return result;
  } catch (error) {
    console.error(`[features-service] press-kits-service stats network error:`, (error as Error).message);
    return new Map();
  }
}

/**
 * Fetch active campaign count from campaign-service.
 * Campaign-service /stats doesn't support groupBy, so this returns a flat count.
 */
async function fetchActiveCampaigns(
  orgId: string,
  filters: Record<string, string>,
  identity: Identity,
): Promise<number> {
  const campaignUrl = process.env.CAMPAIGN_SERVICE_URL;
  const campaignKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!campaignUrl || !campaignKey) return 0;

  const params = new URLSearchParams({ orgId });
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${campaignUrl}/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(campaignKey, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[stats] campaign-service /stats failed: ${response.status}`);
      return 0;
    }

    const data = await response.json() as {
      stats: {
        byStatus: Record<string, number>;
      };
    };

    return data.stats.byStatus?.active ?? data.stats.byStatus?.running ?? 0;
  } catch (error) {
    console.error(`[stats] campaign-service /stats network error:`, (error as Error).message);
    return 0;
  }
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

function aggregateRunsTotals(runsStatsMap: Map<string, RunsStatsEntry>): RunsStatsEntry {
  let totalCost = 0;
  let totalRuns = 0;
  let minStartedAt: string | null = null;
  let maxStartedAt: string | null = null;
  for (const entry of runsStatsMap.values()) {
    totalCost += entry.totalCostInUsdCents;
    totalRuns += entry.completedRuns;
    if (entry.minStartedAt && (!minStartedAt || entry.minStartedAt < minStartedAt)) {
      minStartedAt = entry.minStartedAt;
    }
    if (entry.maxStartedAt && (!maxStartedAt || entry.maxStartedAt > maxStartedAt)) {
      maxStartedAt = entry.maxStartedAt;
    }
  }
  return { totalCostInUsdCents: totalCost, completedRuns: totalRuns, minStartedAt, maxStartedAt };
}

/**
 * Build system stats from raw data.
 */
function buildSystemStats(
  runsData: RunsStatsEntry | undefined,
  activeCampaigns = 0,
): SystemStats {
  return {
    totalCostInUsdCents: runsData?.totalCostInUsdCents ?? 0,
    completedRuns: runsData?.completedRuns ?? 0,
    activeCampaigns,
    firstRunAt: runsData?.minStartedAt ?? null,
    lastRunAt: runsData?.maxStartedAt ?? null,
  };
}

// ── GET /stats/registry ──────────────────────────────────────────────────────

/**
 * Returns the complete stats key registry with label and type for each key.
 * The front-end uses this to know how to format and label output columns.
 */
router.get("/stats/registry", apiKeyAuth, async (_req, res) => {
  res.json({ registry: getPublicRegistry() });
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────────

router.get("/features/:featureSlug/stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId, userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;

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
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;

    // Scope ALL downstream calls to this feature's dynasty
    filters.featureDynastySlug = feature.dynastySlug;

    // Stats for this exact feature slug only (used by runs-service which filters by slug)
    const slugs = [featureSlug];

    const requiredKeys = collectRequiredKeys(feature);
    const sources = requiredSources(requiredKeys);

    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const pipelineKeys = collectPipelineKeys(requiredKeys);
    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, pressKitsStatsMap, activeCampaigns] = await Promise.all([
      sources.has("email-gateway") ? fetchEmailStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("runs") || true ? fetchRunsStats(orgId, groupBy, filters, slugs, identity) : Promise.resolve(new Map<string, RunsStatsEntry>()),
      sources.has("outlets") ? fetchOutletsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("journalists") ? fetchJournalistsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("leads") ? fetchLeadsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      pipelineKeys.size > 0 ? fetchPipelineStats(orgId, groupBy, filters, slugs, pipelineKeys, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("press-kits") ? fetchPressKitsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      fetchActiveCampaigns(orgId, filters, identity),
    ]);

    if (!groupBy) {
      const emailStats = emailStatsMap.get("__total__") ?? {};
      const runsStats = runsStatsMap.get("__total__");
      const outletsStats = outletsStatsMap.get("__total__") ?? {};
      const journalistsStats = journalistsStatsMap.get("__total__") ?? {};
      const leadsStats = leadsStatsMap.get("__total__") ?? {};
      const pipelineStats = pipelineStatsMap.get("__total__") ?? {};
      const pressKitsStats = pressKitsStatsMap.get("__total__") ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats, ...outletsStats, ...journalistsStats, ...leadsStats, ...pipelineStats, ...pressKitsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      return res.json({
        featureSlug,
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, requiredKeys),
      });
    }

    const allGroupKeys = new Set<string>();
    for (const key of emailStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of runsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of outletsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of journalistsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of leadsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of pipelineStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of pressKitsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);

    const totals = aggregateRunsTotals(runsStatsMap);

    const groups: StatsGroup[] = [];
    for (const groupKey of allGroupKeys) {
      const emailStats = emailStatsMap.get(groupKey) ?? {};
      const runsStats = runsStatsMap.get(groupKey);
      const outletsStats = outletsStatsMap.get(groupKey) ?? {};
      const journalistsStats = journalistsStatsMap.get(groupKey) ?? {};
      const leadsStats = leadsStatsMap.get(groupKey) ?? {};
      const pipelineStats = pipelineStatsMap.get(groupKey) ?? {};
      const pressKitsStats = pressKitsStatsMap.get(groupKey) ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats, ...outletsStats, ...journalistsStats, ...leadsStats, ...pipelineStats, ...pressKitsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, requiredKeys),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({
      featureSlug,
      groupBy,
      systemStats: buildSystemStats(totals, activeCampaigns),
      groups,
    });
  } catch (error) {
    console.error("[features-service] Feature stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/dynasty/stats — Aggregated stats across all dynasty versions ─

router.get("/stats/dynasty", apiKeyAuth, async (req, res) => {
  try {
    const dynastySlug = req.query.dynastySlug as string | undefined;
    if (!dynastySlug) {
      return res.status(400).json({ error: "Query parameter 'dynastySlug' is required" });
    }

    const { orgId, userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;

    // Find any feature in this dynasty to use as the source of keys/charts
    const dynastyFeatures = await db.query.features.findMany({
      where: eq(features.dynastySlug, dynastySlug),
    });

    if (dynastyFeatures.length === 0) {
      return res.status(404).json({ error: "No features found for this dynasty slug" });
    }

    // Use the latest version (active preferred) for key definitions
    const activeFeature = dynastyFeatures.find((f) => f.status === "active")
      ?? dynastyFeatures.sort((a, b) => b.version - a.version)[0];

    // Collect all slugs in the dynasty — plus walk the full lineage for convergence
    const lineageSlugs = await collectLineageSlugs(activeFeature);

    const groupByParam = req.query.groupBy as string | undefined;
    const groupBy = (groupByParam && VALID_GROUP_BY.has(groupByParam) ? groupByParam : null) as GroupByDimension | null;

    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;

    // Scope ALL downstream calls to this dynasty
    filters.featureDynastySlug = dynastySlug;

    const requiredKeys = collectRequiredKeys(activeFeature);
    const sources = requiredSources(requiredKeys);

    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const pipelineKeys = collectPipelineKeys(requiredKeys);
    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, pressKitsStatsMap, activeCampaigns] = await Promise.all([
      sources.has("email-gateway") ? fetchEmailStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("runs") || true ? fetchRunsStats(orgId, groupBy, filters, lineageSlugs, identity) : Promise.resolve(new Map<string, RunsStatsEntry>()),
      sources.has("outlets") ? fetchOutletsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("journalists") ? fetchJournalistsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("leads") ? fetchLeadsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      pipelineKeys.size > 0 ? fetchPipelineStats(orgId, groupBy, filters, lineageSlugs, pipelineKeys, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("press-kits") ? fetchPressKitsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      fetchActiveCampaigns(orgId, filters, identity),
    ]);

    if (!groupBy) {
      const emailStats = emailStatsMap.get("__total__") ?? {};
      const runsStats = runsStatsMap.get("__total__");
      const outletsStats = outletsStatsMap.get("__total__") ?? {};
      const journalistsStats = journalistsStatsMap.get("__total__") ?? {};
      const leadsStats = leadsStatsMap.get("__total__") ?? {};
      const pipelineStats = pipelineStatsMap.get("__total__") ?? {};
      const pressKitsStats = pressKitsStatsMap.get("__total__") ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        ...journalistsStats,
        ...leadsStats,
        ...pipelineStats,
        ...pressKitsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      return res.json({
        dynastySlug,
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, requiredKeys),
      });
    }

    const allGroupKeys = new Set<string>();
    for (const key of emailStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of runsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of outletsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of journalistsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of leadsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of pipelineStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of pressKitsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);

    const totals = aggregateRunsTotals(runsStatsMap);

    const groups: StatsGroup[] = [];
    for (const groupKey of allGroupKeys) {
      const emailStats = emailStatsMap.get(groupKey) ?? {};
      const runsStats = runsStatsMap.get(groupKey);
      const outletsStats = outletsStatsMap.get(groupKey) ?? {};
      const journalistsStats = journalistsStatsMap.get(groupKey) ?? {};
      const leadsStats = leadsStatsMap.get(groupKey) ?? {};
      const pipelineStats = pipelineStatsMap.get(groupKey) ?? {};
      const pressKitsStats = pressKitsStatsMap.get(groupKey) ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats,
        ...outletsStats,
        ...journalistsStats,
        ...leadsStats,
        ...pipelineStats,
        ...pressKitsStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, requiredKeys),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({
      dynastySlug,
      groupBy,
      systemStats: buildSystemStats(totals, activeCampaigns),
      groups,
    });
  } catch (error) {
    console.error("[features-service] Dynasty stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats ──────────────────────────────────────────────────────────────

/**
 * Global stats endpoint — cross-features.
 * Used by performance-service and org overview.
 *
 * Query params:
 *   - groupBy: "featureSlug" | "featureSlug,workflowSlug" | "workflowSlug" | "brandId"
 *   - brandId: filter by brand (optional)
 */
router.get("/stats", apiKeyAuth, async (req, res) => {
  try {
    const { orgId, userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;

    const groupByParam = req.query.groupBy as string | undefined;
    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;
    if (req.query.featureSlug) filters.featureSlug = req.query.featureSlug as string;
    if (req.query.featureDynastySlug) filters.featureDynastySlug = req.query.featureDynastySlug as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;

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

    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const globalPipelineKeys = collectPipelineKeys(allKeys);
    // Dynasty filters and groupBy are passed through to downstream services — they handle resolution natively
    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, activeCampaigns] = await Promise.all([
      sources.has("email-gateway") ? fetchEmailStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      fetchRunsStats(orgId, groupBy, filters, undefined, identity),
      sources.has("outlets") ? fetchOutletsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("journalists") ? fetchJournalistsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      sources.has("leads") ? fetchLeadsStats(orgId, groupBy, filters, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      globalPipelineKeys.size > 0 ? fetchPipelineStats(orgId, groupBy, filters, undefined, globalPipelineKeys, identity) : Promise.resolve(new Map<string, Record<string, number>>()),
      fetchActiveCampaigns(orgId, filters, identity),
    ]);

    if (!groupBy) {
      const emailStats = emailStatsMap.get("__total__") ?? {};
      const runsStats = runsStatsMap.get("__total__");
      const outletsStats = outletsStatsMap.get("__total__") ?? {};
      const journalistsStats = journalistsStatsMap.get("__total__") ?? {};
      const leadsStats = leadsStatsMap.get("__total__") ?? {};
      const pipelineStats = pipelineStatsMap.get("__total__") ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats, ...outletsStats, ...journalistsStats, ...leadsStats, ...pipelineStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      return res.json({
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, allKeys),
      });
    }

    const allGroupKeys = new Set<string>();
    for (const key of emailStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of runsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of outletsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of journalistsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of leadsStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);
    for (const key of pipelineStatsMap.keys()) if (key !== "__total__") allGroupKeys.add(key);

    const totals = aggregateRunsTotals(runsStatsMap);

    const groups: StatsGroup[] = [];
    for (const groupKey of allGroupKeys) {
      const emailStats = emailStatsMap.get(groupKey) ?? {};
      const runsStats = runsStatsMap.get(groupKey);
      const outletsStats = outletsStatsMap.get(groupKey) ?? {};
      const journalistsStats = journalistsStatsMap.get(groupKey) ?? {};
      const leadsStats = leadsStatsMap.get(groupKey) ?? {};
      const pipelineStats = pipelineStatsMap.get(groupKey) ?? {};

      const rawStats: Record<string, number> = {
        ...emailStats, ...outletsStats, ...journalistsStats, ...leadsStats, ...pipelineStats,
        totalCostInUsdCents: runsStats?.totalCostInUsdCents ?? 0,
        completedRuns: runsStats?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStats, activeCampaigns),
        stats: computeDerivedStats(rawStats, allKeys),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "featureDynastySlug") group.featureDynastySlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({
      groupBy: groupByParam,
      systemStats: buildSystemStats(totals, activeCampaigns),
      groups,
    });
  } catch (error) {
    console.error("[features-service] Global stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats/ranked — Authenticated version ───────────────────────────────

import { handleRanked, handleBest } from "./public.js";

router.get("/stats/ranked", apiKeyAuth, async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 10;

    await handleRanked(
      req.query.featureDynastySlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.brandId as string | undefined,
      req.query.groupBy as string | undefined,
      limit,
      res,
    );
  } catch (error) {
    console.error("[features-service] Stats ranked error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats/best — Authenticated version ─────────────────────────────────

router.get("/stats/best", apiKeyAuth, async (req, res) => {
  try {
    await handleBest(
      req.query.featureDynastySlug as string | undefined,
      req.query.brandId as string | undefined,
      req.query.by as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Stats best error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
