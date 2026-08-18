import { eq, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { SEED_FEATURES } from "./features.js";

/**
 * Sweep-delete any DB row whose slug is no longer in SEED_FEATURES, THEN upsert every seed
 * feature by slug. Seed file is the source of truth. Called on every cold start. Idempotent.
 *
 * THE PRUNE RUNS FIRST, AND THAT ORDER IS LOAD-BEARING — do not move it back to the end.
 * Renaming a feature's SLUG is a delete plus an insert, and the two rows overlap on every other
 * column while both exist. `features.name` is UNIQUE, so upserting the new slug before the dead one
 * is gone violates `features_name_unique` (`23505`) — which throws on the BOOT path, before
 * `app.listen()`, so the container never binds, the deploy health check fails and the box rolls the
 * whole service back. Pruning first means the dead row is gone before its replacement is written,
 * and a slug rename is a plain deploy. Cost 2026-08-18 (features-service#785): the
 * feedback-request channel rename crash-looped prod's new build on
 * `Key (name)=(Sales Feedback Request Cold Email Outreach) already exists` and was rolled back.
 */
export async function registerSeedFeatures(): Promise<void> {
  const seedSlugs = SEED_FEATURES.map((f) => f.slug);
  const deleted = await db
    .delete(features)
    .where(notInArray(features.slug, seedSlugs))
    .returning({ slug: features.slug });

  for (const row of deleted) {
    console.log(`[features-service] Deleted stale feature: ${row.slug}`);
  }

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
          salesFunnels: [...seed.salesFunnels],
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
        salesFunnels: [...seed.salesFunnels],
      });

      console.log(`[features-service] Inserted feature: ${seed.slug}`);
    }
  }

  console.log(`[features-service] Seed registration complete (${SEED_FEATURES.length} features, ${deleted.length} pruned)`);
}
