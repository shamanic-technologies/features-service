import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { upsertFeatureSchema, batchUpsertFeaturesSchema } from "../lib/schemas.js";

const router = Router();

/**
 * PUT /features — Batch upsert features (idempotent, for cold-start registration).
 * Apps call this at startup to declare their features.
 */
router.put("/features", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = batchUpsertFeaturesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const results = [];
    for (const featureData of parsed.data.features) {
      const existing = await db.query.features.findFirst({
        where: eq(features.slug, featureData.slug),
      });

      if (existing) {
        const [updated] = await db
          .update(features)
          .set({
            name: featureData.name,
            description: featureData.description,
            icon: featureData.icon,
            status: featureData.status,
            inputs: featureData.inputs,
            outputs: featureData.outputs,
            defaultWorkflowName: featureData.defaultWorkflowName ?? null,
            updatedAt: new Date(),
          })
          .where(eq(features.slug, featureData.slug))
          .returning();
        results.push(updated);
      } else {
        const [created] = await db
          .insert(features)
          .values({
            slug: featureData.slug,
            name: featureData.name,
            description: featureData.description,
            icon: featureData.icon,
            status: featureData.status,
            inputs: featureData.inputs,
            outputs: featureData.outputs,
            defaultWorkflowName: featureData.defaultWorkflowName ?? null,
          })
          .returning();
        results.push(created);
      }
    }

    res.json({ features: results });
  } catch (error) {
    console.error("Upsert features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /features — List all features.
 * Query params: status (filter by status, defaults to "active")
 */
router.get("/features", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const status = (req.query.status as string) || "active";

    const results = await db.query.features.findMany({
      where: eq(features.status, status),
    });

    res.json({ features: results });
  } catch (error) {
    console.error("List features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /features/:slug — Get a single feature by slug.
 */
router.get("/features/:slug", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { slug } = req.params;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, slug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    res.json({ feature });
  } catch (error) {
    console.error("Get feature error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /features/:slug/inputs — Get only the inputs for a feature.
 * Used by the dashboard to build the campaign creation form and by the LLM to pre-fill values.
 */
router.get("/features/:slug/inputs", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { slug } = req.params;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, slug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    res.json({
      slug: feature.slug,
      name: feature.name,
      inputs: feature.inputs,
    });
  } catch (error) {
    console.error("Get feature inputs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
