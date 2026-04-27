import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { SEED_FEATURES } from "./features.js";

/**
 * Register seed features via upsert-by-slug.
 * Called on every cold start. Idempotent — updates metadata if the slug exists,
 * inserts if it doesn't. No dynasty logic, no signature matching.
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

  console.log(`[features-service] Seed registration complete (${SEED_FEATURES.length} features)`);
}
