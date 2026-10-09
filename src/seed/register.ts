import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { channelTriggerTypes, features } from "../db/schema.js";
import { CHANNEL_TRIGGER_TYPES } from "../lib/channel-triggers.js";
import { buildChannelCatalogue } from "../lib/channel-catalogue.js";
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
          acquisitionChannel: seed.acquisitionChannel,
          supersededBySlug: seed.supersededBySlug,
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
        acquisitionChannel: seed.acquisitionChannel,
        supersededBySlug: seed.supersededBySlug,
      });

      console.log(`[features-service] Inserted feature: ${seed.slug}`);
    }
  }

  console.log(`[features-service] Seed registration complete (${SEED_FEATURES.length} features, ${deleted.length} pruned)`);
}

/**
 * Upsert every trigger type (`lib/channel-triggers.ts`) and delete any CODE row the code no longer declares
 * (declared rows, `lib/channel-declarations.ts`, are never pruned). Then build the channel catalogue once: a leg naming an unknown trigger, or a
 * channel we run on a trigger nothing fires, THROWS here, on the boot path, and the deploy rolls back rather
 * than publishing a leg that waits forever (`assertLegTriggersDeclared`). Tiny N (7 rows), safe before listen.
 */
export async function registerChannelTriggerTypes(): Promise<void> {
  buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
  // Only CODE rows are pruned: a trigger declared at run time (`origin = 'declared'`) is data, never the code's.
  await db
    .delete(channelTriggerTypes)
    .where(and(eq(channelTriggerTypes.origin, "code"), notInArray(channelTriggerTypes.id, CHANNEL_TRIGGER_TYPES.map((t) => t.id))));
  for (const [displayOrder, t] of CHANNEL_TRIGGER_TYPES.entries()) {
    const row = {
      label: t.label,
      description: t.description,
      icon: t.icon,
      fromStep: t.fromStep,
      firedBy: t.firedBy,
      coded: t.coded,
      displayOrder,
      // A code trigger whose id was declared first is promoted: the code now states it.
      origin: "code",
      kind: "event",
      params: null,
      updatedAt: new Date(),
    };
    await db.insert(channelTriggerTypes).values({ id: t.id, ...row }).onConflictDoUpdate({ target: channelTriggerTypes.id, set: row });
  }
  console.log(`[features-service] Trigger types registered (${CHANNEL_TRIGGER_TYPES.length})`);
}
