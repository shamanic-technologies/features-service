import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";

/**
 * Resolve a feature dynasty slug to all its versioned slugs.
 * Local DB query — no HTTP call.
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
 * Build a reverse map: versioned feature slug → dynasty slug.
 * Single DB query, used for groupBy featureDynastySlug remapping.
 */
export async function buildFeatureSlugToDynastyMap(): Promise<Map<string, string>> {
  const all = await db.query.features.findMany({
    columns: { slug: true, dynastySlug: true },
  });
  const map = new Map<string, string>();
  for (const f of all) {
    map.set(f.slug, f.dynastySlug);
  }
  return map;
}
