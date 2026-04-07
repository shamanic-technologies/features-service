import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { features, type Feature } from "../db/schema.js";
import { resolveFeatureDynastySlugs } from "../lib/dynasty-client.js";
import { STATS_REGISTRY } from "../lib/stats-registry.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchPublicJournalistsStats,
  fetchBrandInfoBatch,
  type WorkflowMetadata,
} from "../lib/public-stats-clients.js";

const router = Router();

// ── GET /public/features — List active features (landing page) ──────────────
// Returns only display-safe fields. No internal IDs, no inputs/outputs definitions.

router.get("/public/features", async (_req, res) => {
  try {
    const results = await db.query.features.findMany({
      where: eq(features.status, "active"),
      columns: {
        dynastyName: true,
        dynastySlug: true,
        description: true,
        icon: true,
        category: true,
        channel: true,
        audienceType: true,
        displayOrder: true,
      },
    });

    results.sort((a, b) => a.displayOrder - b.displayOrder);

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] Public list features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/features/dynasty/slugs — All versioned slugs in a dynasty ───
// Same as the authenticated version. No sensitive data — just slug strings.

router.get("/public/features/dynasty/slugs", async (req, res) => {
  try {
    const dynastySlug = req.query.dynastySlug as string | undefined;
    if (!dynastySlug) {
      return res.status(400).json({ error: "Query parameter 'dynastySlug' is required" });
    }

    const results = await db.query.features.findMany({
      where: eq(features.dynastySlug, dynastySlug),
      columns: { slug: true, version: true },
    });

    if (results.length === 0) {
      return res.status(404).json({ error: "No features found for this dynasty slug" });
    }

    results.sort((a, b) => a.version - b.version);

    res.json({ slugs: results.map((f) => f.slug) });
  } catch (error) {
    console.error("[features-service] Public dynasty slugs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a dynasty slug to its active feature and all versioned slugs.
 */
async function resolveFeatureAndSlugs(dynastySlug: string): Promise<{ feature: Feature; featureSlugs: string[] } | null> {
  const featureSlugs = await resolveFeatureDynastySlugs(dynastySlug);
  if (featureSlugs.length === 0) return null;

  const feature = await db.query.features.findFirst({
    where: and(eq(features.dynastySlug, dynastySlug), eq(features.status, "active")),
  });
  if (!feature) return null;

  return { feature, featureSlugs };
}

/**
 * Get all count-type output keys from a feature's outputs.
 */
function getCountOutputKeys(feature: Feature): string[] {
  return feature.outputs
    .map((o) => o.key)
    .filter((key) => {
      const def = STATS_REGISTRY[key];
      return def && def.kind === "raw" && def.type === "count";
    });
}

/**
 * Get all output keys from a feature, plus the raw dependencies of any derived keys.
 */
function collectAllOutputKeys(feature: Feature): string[] {
  const keys = new Set<string>();
  for (const output of feature.outputs) {
    keys.add(output.key);
    const def = STATS_REGISTRY[output.key];
    if (def?.kind === "derived") {
      keys.add(def.numerator);
      keys.add(def.denominator);
    }
  }
  return [...keys];
}

/**
 * Resolve the effective objective key and sort direction from the feature's outputs.
 * Falls back to the first output if no defaultSort is set.
 */
function resolveObjective(feature: Feature, requestedObjective: string | undefined): { key: string; direction: "asc" | "desc" } | null {
  if (requestedObjective) {
    const output = feature.outputs.find((o) => o.key === requestedObjective);
    return { key: requestedObjective, direction: output?.sortDirection ?? "desc" };
  }

  const defaultOutput = feature.outputs.find((o) => o.defaultSort);
  if (defaultOutput) {
    return { key: defaultOutput.key, direction: defaultOutput.sortDirection ?? "desc" };
  }

  const firstOutput = feature.outputs[0];
  if (firstOutput) {
    return { key: firstOutput.key, direction: firstOutput.sortDirection ?? "desc" };
  }

  return null;
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
 * Fetch all outcome stats from relevant sources and merge into a single map:
 * groupKey → { statsKey → value }
 */
async function fetchOutcomeStats(
  featureSlugsStr: string,
  groupBy: string,
  keys: string[],
): Promise<Map<string, Record<string, number>>> {
  const sources = requiredSources(keys);
  const merged = new Map<string, Record<string, number>>();

  const promises: Promise<Map<string, Record<string, number>>>[] = [];
  if (sources.has("email-gateway")) {
    promises.push(fetchPublicEmailStats(featureSlugsStr, groupBy));
  }
  if (sources.has("journalists")) {
    promises.push(fetchPublicJournalistsStats(featureSlugsStr, groupBy));
  }

  const results = await Promise.all(promises);
  for (const map of results) {
    for (const [key, stats] of map) {
      const existing = merged.get(key) ?? {};
      Object.assign(existing, stats);
      merged.set(key, existing);
    }
  }

  return merged;
}

/**
 * Compute all stats (raw + derived) for a single group from its raw values.
 * Only includes keys that are in the feature's output list.
 */
function computeGroupStats(
  rawOutcomes: Record<string, number>,
  cost: { totalCostInUsdCents: number; completedRuns: number },
  feature: Feature,
): Record<string, number | null> {
  const allRaw: Record<string, number> = {
    ...rawOutcomes,
    totalCostInUsdCents: cost.totalCostInUsdCents,
    completedRuns: cost.completedRuns,
  };

  const result: Record<string, number | null> = {};

  for (const output of feature.outputs) {
    const def = STATS_REGISTRY[output.key];
    if (!def) continue;

    if (def.kind === "raw") {
      result[output.key] = allRaw[output.key] ?? 0;
    } else if (def.kind === "derived") {
      const num = allRaw[def.numerator];
      const den = allRaw[def.denominator];
      result[output.key] = (num != null && den != null && den > 0) ? num / den : null;
    }
  }

  // Always include system stats
  result.totalCostInUsdCents = cost.totalCostInUsdCents;
  result.completedRuns = cost.completedRuns;

  return result;
}

/**
 * Build workflow upgrade chains: for each active workflow, collect all workflow slugs
 * in its upgrade chain (deprecated predecessors that upgraded to it).
 */
function buildUpgradeChains(workflows: WorkflowMetadata[]): Map<string, string[]> {
  const predecessorMap = new Map<string, string[]>();
  const idToSlug = new Map<string, string>();
  const activeWorkflows: WorkflowMetadata[] = [];

  for (const wf of workflows) {
    idToSlug.set(wf.id, wf.slug);
    if (wf.status === "active") {
      activeWorkflows.push(wf);
    }
    if (wf.upgradedTo) {
      const list = predecessorMap.get(wf.upgradedTo) ?? [];
      list.push(wf.slug);
      predecessorMap.set(wf.upgradedTo, list);
    }
  }

  const chains = new Map<string, string[]>();
  for (const wf of activeWorkflows) {
    const slugs = new Set<string>([wf.slug]);
    const queue = [wf.id];
    const visited = new Set<string>([wf.id]);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const preds = predecessorMap.get(currentId) ?? [];
      for (const predSlug of preds) {
        slugs.add(predSlug);
        for (const [id, slug] of idToSlug) {
          if (slug === predSlug && !visited.has(id)) {
            visited.add(id);
            queue.push(id);
          }
        }
      }
    }

    chains.set(wf.slug, [...slugs]);
  }

  return chains;
}

/**
 * Aggregate costs and outcomes across workflow upgrade chains.
 */
function aggregateAcrossChains(
  chains: Map<string, string[]>,
  costGroups: { dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }[],
  outcomeMap: Map<string, Record<string, number>>,
  dimensionKey: string,
): { costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>; aggregatedOutcomes: Map<string, Record<string, number>> } {
  const perSlugCost = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  for (const group of costGroups) {
    const slug = group.dimensions[dimensionKey];
    if (!slug) continue;
    perSlugCost.set(slug, {
      totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
      completedRuns: group.runCount,
    });
  }

  const costMap = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  const aggregatedOutcomes = new Map<string, Record<string, number>>();

  for (const [activeSlug, chainSlugs] of chains) {
    let totalCost = 0;
    let totalRuns = 0;
    const mergedOutcomes: Record<string, number> = {};

    for (const slug of chainSlugs) {
      const cost = perSlugCost.get(slug);
      if (cost) {
        totalCost += cost.totalCostInUsdCents;
        totalRuns += cost.completedRuns;
      }
      const outcomes = outcomeMap.get(slug);
      if (outcomes) {
        for (const [k, v] of Object.entries(outcomes)) {
          mergedOutcomes[k] = (mergedOutcomes[k] ?? 0) + v;
        }
      }
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
  featureDynastySlug: string | undefined,
  requestedObjective: string | undefined,
  groupBy: string | undefined,
  limit: number,
  res: import("express").Response,
): Promise<void> {
  if (!featureDynastySlug) {
    res.status(400).json({ error: "Query parameter 'featureDynastySlug' is required" });
    return;
  }
  if (groupBy !== "workflow" && groupBy !== "brand") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'workflow' or 'brand'" });
    return;
  }

  const resolved = await resolveFeatureAndSlugs(featureDynastySlug);
  if (!resolved) {
    res.status(404).json({ error: "No features found for this dynasty slug" });
    return;
  }

  const { feature, featureSlugs } = resolved;
  const objective = resolveObjective(feature, requestedObjective);
  if (!objective) {
    res.status(400).json({ error: "Feature has no outputs defined" });
    return;
  }

  const featureSlugsStr = featureSlugs.join(",");
  const isBrandGrouping = groupBy === "brand";
  const statsGroupBy = isBrandGrouping ? "brandId" : "workflowSlug";

  // Fetch ALL output stats (not just the objective) so we return full stats per group
  const allKeys = collectAllOutputKeys(feature);

  const [workflows, costGroups, outcomeMap] = await Promise.all([
    isBrandGrouping ? Promise.resolve([]) : fetchPublicWorkflows(featureSlugsStr, "all"),
    fetchPublicCosts(featureSlugsStr, statsGroupBy),
    fetchOutcomeStats(featureSlugsStr, statsGroupBy, allKeys),
  ]);

  let costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>;
  let aggregatedOutcomes: Map<string, Record<string, number>>;

  if (isBrandGrouping) {
    costMap = new Map();
    aggregatedOutcomes = outcomeMap;
    for (const group of costGroups) {
      const key = group.dimensions.brandId;
      if (!key) continue;
      costMap.set(key, {
        totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
        completedRuns: group.runCount,
      });
    }
  } else {
    const chains = buildUpgradeChains(workflows);
    const agg = aggregateAcrossChains(chains, costGroups, outcomeMap, "workflowSlug");
    costMap = agg.costMap;
    aggregatedOutcomes = agg.aggregatedOutcomes;
  }

  // Build full stats for each group, then sort by objective
  const entries: { key: string; stats: Record<string, number | null> }[] = [];
  for (const [key, cost] of costMap) {
    const rawOutcomes = aggregatedOutcomes.get(key) ?? {};
    const stats = computeGroupStats(rawOutcomes, cost, feature);
    entries.push({ key, stats });
  }

  // Sort by objective value
  entries.sort((a, b) => {
    const aVal = a.stats[objective.key];
    const bVal = b.stats[objective.key];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    return objective.direction === "asc" ? aVal - bVal : bVal - aVal;
  });

  const top = entries.slice(0, limit);

  // Enrich brands with name/domain from brand-service
  let brandInfoMap = new Map<string, { id: string; name: string | null; domain: string | null }>();
  if (isBrandGrouping && top.length > 0) {
    brandInfoMap = await fetchBrandInfoBatch(top.map((e) => e.key));
  }

  const workflowBySlug = new Map(workflows.map((w) => [w.slug, w]));

  const results = top.map(({ key, stats }) => {
    if (isBrandGrouping) {
      const brand = brandInfoMap.get(key);
      return {
        brand: {
          id: key,
          name: brand?.name ?? null,
          domain: brand?.domain ?? null,
        },
        stats,
      };
    }
    const wf = workflowBySlug.get(key);
    return {
      workflow: wf ? {
        id: wf.id,
        slug: wf.slug,
        name: wf.name,
        dynastyName: wf.dynastyName,
        dynastySlug: wf.dynastySlug,
        version: wf.version,
        featureSlug: wf.featureSlug,
        createdForBrandId: wf.createdForBrandId,
      } : { slug: key },
      stats,
    };
  });

  res.json({
    objective: objective.key,
    sortDirection: objective.direction,
    results,
  });
}

// ── Best handler ────────────────────────────────────────────────────────────

export async function handleBest(
  featureDynastySlug: string | undefined,
  groupBy: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureDynastySlug) {
    res.status(400).json({ error: "Query parameter 'featureDynastySlug' is required" });
    return;
  }
  if (groupBy !== "workflow" && groupBy !== "brand") {
    res.status(400).json({ error: "Query parameter 'groupBy' is required and must be 'workflow' or 'brand'" });
    return;
  }

  const resolved = await resolveFeatureAndSlugs(featureDynastySlug);
  if (!resolved) {
    res.status(404).json({ error: "No features found for this dynasty slug" });
    return;
  }

  const { feature, featureSlugs } = resolved;
  const countKeys = getCountOutputKeys(feature);
  const featureSlugsStr = featureSlugs.join(",");

  const isBrandMode = groupBy === "brand";
  const statsGroupBy = isBrandMode ? "brandId" : "workflowSlug";

  const [workflows, costGroups, outcomeMap] = await Promise.all([
    isBrandMode ? Promise.resolve([]) : fetchPublicWorkflows(featureSlugsStr, "all"),
    fetchPublicCosts(featureSlugsStr, statsGroupBy),
    fetchOutcomeStats(featureSlugsStr, statsGroupBy, countKeys),
  ]);

  let costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>;
  let aggregatedOutcomes: Map<string, Record<string, number>>;

  if (isBrandMode) {
    costMap = new Map();
    aggregatedOutcomes = outcomeMap;
    for (const group of costGroups) {
      const key = group.dimensions.brandId;
      if (!key) continue;
      costMap.set(key, {
        totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
        completedRuns: group.runCount,
      });
    }
  } else {
    const chains = buildUpgradeChains(workflows);
    const agg = aggregateAcrossChains(chains, costGroups, outcomeMap, "workflowSlug");
    costMap = agg.costMap;
    aggregatedOutcomes = agg.aggregatedOutcomes;
  }

  const workflowBySlug = new Map(workflows.map((w) => [w.slug, w]));

  const best: Record<string, {
    workflowSlug?: string;
    workflowName?: string;
    brandId?: string;
    createdForBrandId?: string | null;
    value: number;
  } | null> = {};

  for (const metricKey of countKeys) {
    let bestKey: string | null = null;
    let bestCostPerOutcome = Infinity;

    for (const [key, cost] of costMap) {
      const outcomes = aggregatedOutcomes.get(key)?.[metricKey] ?? 0;
      if (outcomes <= 0) continue;
      const cpo = cost.totalCostInUsdCents / outcomes;
      if (cpo < bestCostPerOutcome) {
        bestCostPerOutcome = cpo;
        bestKey = key;
      }
    }

    if (bestKey === null) {
      best[metricKey] = null;
    } else if (isBrandMode) {
      best[metricKey] = { brandId: bestKey, value: bestCostPerOutcome };
    } else {
      const wf = workflowBySlug.get(bestKey);
      best[metricKey] = {
        workflowSlug: wf?.slug ?? bestKey,
        workflowName: wf?.name ?? bestKey,
        createdForBrandId: wf?.createdForBrandId ?? null,
        value: bestCostPerOutcome,
      };
    }
  }

  res.json({ best });
}

// ── GET /public/stats/ranked ─────────────────────────────────────────────────

router.get("/public/stats/ranked", async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 3;

    await handleRanked(
      req.query.featureDynastySlug as string | undefined,
      req.query.objective as string | undefined,
      req.query.groupBy as string | undefined,
      limit,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats ranked error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/best ───────────────────────────────────────────────────

router.get("/public/stats/best", async (req, res) => {
  try {
    await handleBest(
      req.query.featureDynastySlug as string | undefined,
      req.query.groupBy as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats best error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
