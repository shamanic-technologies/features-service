import { eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { computeSignature, slugify, versionedName, versionedSlug } from "../lib/signature.js";
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
      workflowColumns: f.workflowColumns ?? [],
      charts: f.charts ?? [],
      resultComponent: f.resultComponent ?? null,
      defaultWorkflowName: f.defaultWorkflowName ?? null,
    };

    if (bySignature) {
      // Same signature → upsert metadata
      await db
        .update(features)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(features.id, bySignature.id));
      console.log(`[seed] Updated: ${bySignature.slug}`);
    } else {
      // New feature — resolve unique name/slug
      const baseSlug = slugify(f.name);
      let version = 1;
      let candidateName = f.name;
      let candidateSlug = baseSlug;

      while (true) {
        const collision = await db.query.features.findFirst({
          where: or(
            eq(features.name, candidateName),
            eq(features.slug, candidateSlug),
          ),
        });
        if (!collision) break;
        version++;
        candidateName = versionedName(f.name, version);
        candidateSlug = versionedSlug(baseSlug, version);
      }

      await db.insert(features).values({
        slug: candidateSlug,
        signature,
        ...values,
        name: candidateName,
      });
      console.log(`[seed] Created: ${candidateSlug}`);
    }
  }

  console.log(`[seed] Done.`);
}
