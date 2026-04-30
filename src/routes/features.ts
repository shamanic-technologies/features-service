import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { extractBrandFields } from "../lib/brand-client.js";
import { flattenValue } from "../lib/flatten.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

// ── GET /features — List all features ───────────────────────────────────────

router.get("/features", apiKeyAuth, async (req, res) => {
  try {
    const status = (req.query.status as string) || "active";

    const results = await db.query.features.findMany({
      where: eq(features.status, status),
    });

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] List features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/:slug — Get a single feature by slug ───────────────────────

router.get("/features/:slug", apiKeyAuth, async (req, res) => {
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
    console.error("[features-service] Get feature error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/:featureSlug/inputs — Get inputs for a feature ─────────────

router.get("/features/:featureSlug/inputs", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, featureSlug),
    });

    if (!feature) {
      return res.status(404).json({ error: `Feature not found: "${featureSlug}"` });
    }

    res.json({
      slug: feature.slug,
      name: feature.name,
      inputs: feature.inputs,
    });
  } catch (error) {
    console.error("[features-service] Get feature inputs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /features/:featureSlug/prefill — Pre-fill input values from brand data ──

interface FeatureInput {
  key: string;
  extractKey: string;
  description: string;
}

router.post("/features/:featureSlug/prefill", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const format = (req.query.format as string) || "full";

    if (format !== "text" && format !== "full") {
      return res.status(400).json({ error: "format must be 'text' or 'full'" });
    }

    const auth = req as AuthenticatedRequest;

    if (!auth.brandId) {
      return res.status(400).json({ error: "x-brand-id header is required" });
    }

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, featureSlug),
    });

    if (!feature) {
      return res.status(404).json({ error: `Feature not found: "${featureSlug}"` });
    }

    traceEvent(auth.runId, { service: "features-service", event: "prefill-start", detail: `featureSlug=${featureSlug}, brandId=${auth.brandId}, format=${format}, inputCount=${(feature.inputs as FeatureInput[]).length}` }, req.headers).catch(() => {});

    const featureInputs = feature.inputs as FeatureInput[];

    const fields = featureInputs.map((input) => ({
      key: input.extractKey,
      description: input.description,
    }));

    traceEvent(auth.runId, { service: "features-service", event: "brand-extract", detail: `Extracting ${fields.length} fields from brand-service for brandId=${auth.brandId}`, data: { fields: fields.map(f => f.key) } }, req.headers).catch(() => {});

    const extractedResults = await extractBrandFields(fields, {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      brandId: auth.brandId,
      campaignId: auth.campaignId,
      featureSlug: auth.featureSlug,
    });

    traceEvent(auth.runId, { service: "features-service", event: "brand-extract-done", detail: `Extracted ${Object.keys(extractedResults).length} fields for brandId=${auth.brandId}` }, req.headers).catch(() => {});

    if (format === "text") {
      const prefilled: Record<string, string | null> = {};
      for (const input of featureInputs) {
        const result = extractedResults[input.extractKey];
        prefilled[input.key] = flattenValue(result?.value ?? null);
      }
      return res.json({ slug: feature.slug, brandId: auth.brandId, format: "text", prefilled });
    }

    const prefilled: Record<string, { value: unknown; byBrand: Record<string, unknown> }> = {};
    for (const input of featureInputs) {
      const result = extractedResults[input.extractKey];
      prefilled[input.key] = {
        value: result?.value ?? null,
        byBrand: result?.byBrand ?? {},
      };
    }

    traceEvent(auth.runId, { service: "features-service", event: "prefill-done", detail: `featureSlug=${featureSlug}, format=${format}, prefilledKeys=${Object.keys(prefilled).length}` }, req.headers).catch(() => {});

    res.json({
      slug: feature.slug,
      brandId: auth.brandId,
      format: "full",
      prefilled,
    });
  } catch (error) {
    console.error("[features-service] Prefill feature error:", error);
    const auth = req as AuthenticatedRequest;
    if (auth.runId) {
      traceEvent(auth.runId, { service: "features-service", event: "prefill-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    if (error instanceof Error && error.message.includes("brand-service")) {
      return res.status(502).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
