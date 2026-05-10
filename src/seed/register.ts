import { eq, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { SEED_FEATURES } from "./features.js";

/**
 * Register seed features via upsert-by-slug, then sweep-delete any DB rows
 * whose slug is no longer in SEED_FEATURES. Seed file is the source of truth.
 * Called on every cold start. Idempotent.
 */
export async function registerSeedFeatures(): Promise<void> {
  for (const seed of SEED_FEATURES) {
    const existing = await db.query.features.findFirst({
      where: eq(features.slug, seed.slug),
    });

    if (existing) {
      await db
        .update(features)
        .set({
          name: seed.name,
          description: seed.description,
          icon: seed.icon,
          implemented: seed.implemented,
          displayOrder: seed.displayOrder,
          status: seed.status,
          inputs: seed.inputs,
          outputs: seed.outputs,
          charts: seed.charts,
          entities: seed.entities,
          updatedAt: new Date(),
        })
        .where(eq(features.slug, seed.slug));

      console.log(`[features-service] Updated feature: ${seed.slug}`);
    } else {
      await db.insert(features).values({
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        icon: seed.icon,
        implemented: seed.implemented,
        displayOrder: seed.displayOrder,
        status: seed.status,
        inputs: seed.inputs,
        outputs: seed.outputs,
        charts: seed.charts,
        entities: seed.entities,
      });

      console.log(`[features-service] Inserted feature: ${seed.slug}`);
    }
  }

  const seedSlugs = SEED_FEATURES.map((f) => f.slug);
  const deleted = await db
    .delete(features)
    .where(notInArray(features.slug, seedSlugs))
    .returning({ slug: features.slug });

  for (const row of deleted) {
    console.log(`[features-service] Deleted stale feature: ${row.slug}`);
  }

  console.log(`[features-service] Seed registration complete (${SEED_FEATURES.length} features, ${deleted.length} pruned)`);
}
