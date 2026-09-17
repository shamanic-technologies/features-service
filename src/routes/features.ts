import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { extractBrandFields, BrandFieldExtractionError } from "../lib/brand-client.js";
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // WHICH OFFER the channel is being started for. It travels in the BODY under brand-service's own
    // field name, so one vocabulary spans the two services and the api-service gateway — which
    // forwards this body verbatim while whitelisting only `format` on the query string — needs no
    // change. OPTIONAL at every hop: a caller that names none is byte-identical to today.
    //
    // A malformed value is a 400 rather than a quiet drop: silently ignoring it would send the
    // several-offer brand straight back into the 409 this exists to answer, and the caller would have
    // no way to tell it was its own value that was discarded.
    const rawOfferId = (req.body as { offerId?: unknown } | undefined)?.offerId;
    if (rawOfferId !== undefined && rawOfferId !== null) {
      if (typeof rawOfferId !== "string" || !UUID_PATTERN.test(rawOfferId)) {
        return res.status(400).json({ error: "offerId must be a UUID", code: "offer_id_unrecognised" });
      }
    }
    const offerId = typeof rawOfferId === "string" ? rawOfferId : undefined;

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

    const extractedResults = await extractBrandFields(
      fields,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runId: auth.runId,
        brandId: auth.brandId,
        campaignId: auth.campaignId,
        featureSlug: auth.featureSlug,
      },
      offerId,
    );

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
    // brand-service's REFUSALS are answers, not outages, and they reach the caller legibly.
    //
    //  - 409 SEVERAL_OFFERS: the brand sells several things, so the user-facing fields have several
    //    right answers. Served as a 409 carrying the OFFERS, which is exactly what a consumer needs
    //    to let someone pick one and retry. Never swallowed, never resolved by guessing, and NEVER
    //    "the first offer" — substituting a proposition is the fabrication this refusal prevents.
    //  - 404: the named offer is not an offer of this brand. Served as a 404 with brand-service's
    //    own sentence, so a bad id reads as a bad id rather than as a downstream fault.
    //
    // Every other brand-service failure stays a 502, byte-unchanged.
    if (error instanceof BrandFieldExtractionError) {
      if (error.status === 409 && error.code === "SEVERAL_OFFERS") {
        return res.status(409).json({
          error: error.message,
          code: "several_offers",
          offers: error.offers,
        });
      }
      if (error.status === 404) {
        return res.status(404).json({
          error: error.message,
          ...(error.code ? { code: error.code.toLowerCase() } : {}),
        });
      }
      return res.status(502).json({ error: error.message });
    }
    if (error instanceof Error && error.message.includes("brand-service")) {
      return res.status(502).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
