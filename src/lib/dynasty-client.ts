import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

interface ResolveHeaders {
  apiKey: string;
  orgId: string;
  userId: string;
  runId: string;
}

// ── Feature dynasty resolution (local DB — no HTTP call) ─────────────────────

/**
 * Resolve a feature dynasty slug to all its versioned slugs.
 * Queries our own DB directly — no service call needed.
 */
export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const results = await db.query.features.findMany({
    where: eq(features.dynastySlug, dynastySlug),
    columns: { slug: true, version: true },
  });
  return results
    .sort((a, b) => a.version - b.version)
    .map((f) => f.slug);
}

/**
 * Fetch all feature dynasties with their versioned slugs.
 * Queries our own DB directly.
 */
export async function fetchAllFeatureDynasties(): Promise<DynastyEntry[]> {
  const all = await db.query.features.findMany({
    columns: { dynastySlug: true, slug: true, version: true },
  });

  const map = new Map<string, Array<{ slug: string; version: number }>>();
  for (const f of all) {
    const list = map.get(f.dynastySlug) ?? [];
    list.push({ slug: f.slug, version: f.version });
    map.set(f.dynastySlug, list);
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dynastySlug, items]) => ({
      dynastySlug,
      slugs: items.sort((a, b) => a.version - b.version).map((i) => i.slug),
    }));
}

// ── Workflow dynasty resolution (HTTP call to workflow-service) ───────────────

const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL;
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;

/**
 * Resolve a workflow dynasty slug to all its versioned slugs.
 * Calls workflow-service GET /workflows/dynasty/slugs?dynastySlug=X
 */
export async function resolveWorkflowDynastySlugs(
  dynastySlug: string,
  headers: ResolveHeaders,
): Promise<string[]> {
  if (!WORKFLOW_SERVICE_URL || !WORKFLOW_SERVICE_API_KEY) {
    console.warn("[features-service] WORKFLOW_SERVICE_URL/API_KEY not configured, cannot resolve workflow dynasty");
    return [];
  }

  const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": WORKFLOW_SERVICE_API_KEY,
        "x-org-id": headers.orgId,
        "x-user-id": headers.userId,
        "x-run-id": headers.runId,
      },
    });

    if (!response.ok) {
      console.error(`[features-service] workflow-service dynasty/slugs failed: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { slugs: string[] };
    return data.slugs;
  } catch (error) {
    console.error("[features-service] workflow-service dynasty/slugs error:", (error as Error).message);
    return [];
  }
}

/**
 * Fetch all workflow dynasties with their versioned slugs.
 * Calls workflow-service GET /workflows/dynasties
 */
export async function fetchAllWorkflowDynasties(
  headers: ResolveHeaders,
): Promise<DynastyEntry[]> {
  if (!WORKFLOW_SERVICE_URL || !WORKFLOW_SERVICE_API_KEY) {
    console.warn("[features-service] WORKFLOW_SERVICE_URL/API_KEY not configured, cannot fetch workflow dynasties");
    return [];
  }

  const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasties`;
  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": WORKFLOW_SERVICE_API_KEY,
        "x-org-id": headers.orgId,
        "x-user-id": headers.userId,
        "x-run-id": headers.runId,
      },
    });

    if (!response.ok) {
      console.error(`[features-service] workflow-service /dynasties failed: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { dynasties: DynastyEntry[] };
    return data.dynasties;
  } catch (error) {
    console.error("[features-service] workflow-service /dynasties error:", (error as Error).message);
    return [];
  }
}

// ── Reverse map helper ───────────────────────────────────────────────────────

/**
 * Build a reverse map: versioned slug → dynasty slug.
 * Slugs not in any dynasty fall back to their raw value.
 */
export function buildSlugToDynastyMap(dynasties: DynastyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
