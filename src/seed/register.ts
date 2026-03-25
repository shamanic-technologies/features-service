import { eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { computeSignature, slugify } from "../lib/signature.js";
import { SEED_FEATURES } from "./features.js";

/**
 * Register seed features at cold start.
 * Uses the same signature-based upsert logic as PUT /features.
 * Idempotent — safe to call on every boot.
 */
export async function registerSeedFeatures(): Promise<void> {
  console.log(`[seed] Registering ${SEED_FEATURES.length} features...`);

  for (const f of SEED_FEATURES) {
    const inputKeys = f.inputs.map((i) => i.key);
    const outputKeys = f.outputs.map((o) => o.key);
    const signature = computeSignature(inputKeys, outputKeys);

    // Check if this exact signature already exists
    const bySignature = await db.query.features.findFirst({
      where: eq(features.signature, signature),
    });

    const values = {
      name: f.name,
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
      // Same signature → upsert metadata
      await db
        .update(features)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(features.id, bySignature.id));
      console.log(`[seed] Updated (signature match): ${bySignature.slug}`);
    } else {
      // Signature changed or new feature — check if same name already exists
      const baseSlug = slugify(f.name);
      const byName = await db.query.features.findFirst({
        where: or(
          eq(features.name, f.name),
          eq(features.slug, baseSlug),
        ),
      });

      if (byName) {
        // Same name/slug, different signature → update in place (outputs changed)
        await db
          .update(features)
          .set({ ...values, signature, updatedAt: new Date() })
          .where(eq(features.id, byName.id));
        console.log(`[seed] Updated (signature changed): ${byName.slug}`);
      } else {
        // Truly new feature — insert
        await db.insert(features).values({
          slug: baseSlug,
          signature,
          ...values,
        });
        console.log(`[seed] Created: ${baseSlug}`);
      }
    }
  }

  console.log(`[seed] Done.`);
}
