import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { computeSignature, slugify, versionedName, versionedSlug, composeDynastyName } from "../lib/signature.js";
import { SEED_FEATURES } from "./features.js";

/**
 * Register seed features at cold start.
 * Uses dynasty-aware signature-based upsert logic.
 * Idempotent — safe to call on every boot.
 *
 * For each seed feature:
 * - Same signature exists → update metadata in-place
 * - Same dynasty (base_name, fork_name=null) but different signature → upgrade (deprecate old, create new version)
 * - New feature → create new dynasty
 */
export async function registerSeedFeatures(): Promise<void> {
  console.log(`[features-service] Registering ${SEED_FEATURES.length} seed features...`);

  for (const f of SEED_FEATURES) {
    const inputKeys = f.inputs.map((i) => i.key);
    const outputKeys = f.outputs.map((o) => o.key);
    const signature = computeSignature(inputKeys, outputKeys);
    const baseName = f.name;
    const dynastyName = composeDynastyName(baseName, null);
    const dynastySlugVal = slugify(dynastyName);

    // Check if this exact signature already exists
    const bySignature = await db.query.features.findFirst({
      where: eq(features.signature, signature),
    });

    const metadataValues = {
      description: f.description,
      icon: f.icon,
      category: f.category,
      channel: f.channel,
      audienceType: f.audienceType,
      implemented: f.implemented,
      displayOrder: f.displayOrder,
      status: f.status,
      inputs: f.inputs,
      outputs: f.outputs,
      charts: f.charts,
      entities: f.entities,
    };

    if (bySignature) {
      // Same signature → upsert metadata in-place
      await db
        .update(features)
        .set({ ...metadataValues, updatedAt: new Date() })
        .where(eq(features.id, bySignature.id));
      console.log(`[features-service] Updated (signature match): ${bySignature.slug}`);
      continue;
    }

    // Signature is new — check if dynasty exists (base_name match, fork_name=null)
    const activeInDynasty = await db.query.features.findFirst({
      where: and(
        eq(features.baseName, baseName),
        isNull(features.forkName),
        eq(features.status, "active"),
      ),
    });

    if (activeInDynasty) {
      // Dynasty exists, signature changed → upgrade
      // Find next version
      const existing = await db.query.features.findMany({
        where: eq(features.dynastySlug, dynastySlugVal),
        columns: { version: true },
      });
      const nextVersion = existing.length > 0
        ? Math.max(...existing.map((e) => e.version)) + 1
        : 1;

      // Create new version
      const [created] = await db.insert(features).values({
        baseName,
        forkName: null,
        dynastyName,
        dynastySlug: dynastySlugVal,
        version: nextVersion,
        slug: versionedSlug(dynastySlugVal, nextVersion),
        name: versionedName(dynastyName, nextVersion),
        signature,
        ...metadataValues,
      }).returning();

      // Deprecate old
      await db
        .update(features)
        .set({
          status: "deprecated",
          upgradedTo: created.id,
          updatedAt: new Date(),
        })
        .where(eq(features.id, activeInDynasty.id));

      console.log(`[features-service] Upgraded: ${activeInDynasty.slug} → ${created.slug}`);
    } else {
      // New dynasty
      const [created] = await db.insert(features).values({
        baseName,
        forkName: null,
        dynastyName,
        dynastySlug: dynastySlugVal,
        version: 1,
        slug: versionedSlug(dynastySlugVal, 1),
        name: versionedName(dynastyName, 1),
        signature,
        ...metadataValues,
      }).returning();
      console.log(`[features-service] Created: ${created.slug}`);
    }
  }

  console.log(`[features-service] Seed registration done.`);
}
