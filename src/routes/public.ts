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
  type WorkflowMetadata,
  type PublicFilters,
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

// ── Shared scoring helpers ───────────────────────────────────────────────────

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
 * Get count-type output keys from a feature (used by `best` to iterate all metrics).
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
  filters?: PublicFilters,
): Promise<Map<string, Record<string, number>>> {
  const sources = requiredSources(keys);
  const merged = new Map<string, Record<string, number>>();

  const promises: Promise<Map<string, Record<string, number>>>[] = [];
  if (sources.has("email-gateway")) {
    promises.push(fetchPublicEmailStats(featureSlugsStr, groupBy, filters));
  }
  if (sources.has("journalists")) {
    promises.push(fetchPublicJournalistsStats(featureSlugsStr, groupBy, filters));
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

interface ScoredEntry {
  totalCostInUsdCents: number;
  totalOutcomes: number;
  costPerOutcome: number | null;
  completedRuns: number;
}

/**
 * Build workflow upgrade chains: for each active workflow, collect all workflow slugs
 * in its upgrade chain (deprecated predecessors that upgraded to it).
 */
function buildUpgradeChains(workflows: WorkflowMetadata[]): Map<string, string[]> {
  // upgradedTo ID → workflow slugs that upgraded to it
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
      // Find workflows whose upgradedTo points to currentId
      const preds = predecessorMap.get(currentId) ?? [];
      for (const predSlug of preds) {
        slugs.add(predSlug);
        // Find the ID for this predecessor slug to continue BFS
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
 * Score workflows or brands by cost-per-outcome for a single objective.
 * Returns entries sorted ascending by costPerOutcome (nulls last).
 */
function scoreByObjective(
  costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>,
  outcomeMap: Map<string, Record<string, number>>,
  objectiveKey: string,
): Map<string, ScoredEntry> {
  const scored = new Map<string, ScoredEntry>();

  for (const [key, cost] of costMap) {
    const outcomes = outcomeMap.get(key)?.[objectiveKey] ?? 0;
    scored.set(key, {
      totalCostInUsdCents: cost.totalCostInUsdCents,
      totalOutcomes: outcomes,
      costPerOutcome: outcomes > 0 ? cost.totalCostInUsdCents / outcomes : null,
      completedRuns: cost.completedRuns,
    });
  }

  return scored;
}

/**
 * Aggregate costs and outcomes across workflow upgrade chains.
 * Returns maps keyed by active workflow slug with summed stats.
 */
function aggregateAcrossChains(
  chains: Map<string, string[]>,
  costGroups: { dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }[],
  outcomeMap: Map<string, Record<string, number>>,
  dimensionKey: string,
): { costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>; aggregatedOutcomes: Map<string, Record<string, number>> } {
  // Build per-slug cost lookup
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

// ── Ranked/Best handler logic ────────────────────────────────────────────────

export async function handleRanked(
  featureDynastySlug: string | undefined,
  objective: string | undefined,
  brandId: string | undefined,
  groupBy: string | undefined,
  limit: number,
  res: import("express").Response,
): Promise<void> {
  if (!featureDynastySlug) {
    res.status(400).json({ error: "Query parameter 'featureDynastySlug' is required" });
    return;
  }
  if (!objective) {
    res.status(400).json({ error: "Query parameter 'objective' is required" });
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
  const featureSlugsStr = featureSlugs.join(",");
  const filters: PublicFilters = {};
  if (brandId) filters.brandId = brandId;

  const isBrandGrouping = groupBy === "brand";
  const statsGroupBy = isBrandGrouping ? "brandId" : "workflowSlug";

  const [workflows, costGroups, outcomeMap] = await Promise.all([
    isBrandGrouping ? Promise.resolve([]) : fetchPublicWorkflows(featureSlugsStr, "all"),
    fetchPublicCosts(featureSlugsStr, statsGroupBy, filters),
    fetchOutcomeStats(featureSlugsStr, statsGroupBy, [objective], filters),
  ]);

  let scored: Map<string, ScoredEntry>;

  if (isBrandGrouping) {
    // Direct brand aggregation — no upgrade chains needed
    const costMap = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
    for (const group of costGroups) {
      const key = group.dimensions.brandId;
      if (!key) continue;
      costMap.set(key, {
        totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
        completedRuns: group.runCount,
      });
    }
    scored = scoreByObjective(costMap, outcomeMap, objective);
  } else {
    // Aggregate across workflow upgrade chains
    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, outcomeMap, "workflowSlug");
    scored = scoreByObjective(costMap, aggregatedOutcomes, objective);
  }

  // Sort: lowest costPerOutcome first, nulls last
  const sorted = [...scored.entries()].sort(([, a], [, b]) => {
    if (a.costPerOutcome === null && b.costPerOutcome === null) return 0;
    if (a.costPerOutcome === null) return 1;
    if (b.costPerOutcome === null) return -1;
    return a.costPerOutcome - b.costPerOutcome;
  }).slice(0, limit);

  const workflowBySlug = new Map(workflows.map((w) => [w.slug, w]));

  const results = sorted.map(([key, stats]) => {
    if (isBrandGrouping) {
      return { brand: { brandId: key }, stats };
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

  res.json({ results });
}

export async function handleBest(
  featureDynastySlug: string | undefined,
  brandId: string | undefined,
  by: string | undefined,
  res: import("express").Response,
): Promise<void> {
  if (!featureDynastySlug) {
    res.status(400).json({ error: "Query parameter 'featureDynastySlug' is required" });
    return;
  }
  if (by !== "workflow" && by !== "brand") {
    res.status(400).json({ error: "Query parameter 'by' is required and must be 'workflow' or 'brand'" });
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
  const filters: PublicFilters = {};
  if (brandId) filters.brandId = brandId;

  const isBrandMode = by === "brand";
  const statsGroupBy = isBrandMode ? "brandId" : "workflowSlug";

  const [workflows, costGroups, outcomeMap] = await Promise.all([
    isBrandMode ? Promise.resolve([]) : fetchPublicWorkflows(featureSlugsStr, "all"),
    fetchPublicCosts(featureSlugsStr, statsGroupBy, filters),
    fetchOutcomeStats(featureSlugsStr, statsGroupBy, countKeys, filters),
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
    console.error("[features-service] Public stats ranked error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/stats/best ───────────────────────────────────────────────────

router.get("/public/stats/best", async (req, res) => {
  try {
    await handleBest(
      req.query.featureDynastySlug as string | undefined,
      req.query.brandId as string | undefined,
      req.query.by as string | undefined,
      res,
    );
  } catch (error) {
    console.error("[features-service] Public stats best error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
