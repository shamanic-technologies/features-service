import { Router } from "express";
import { eq, or, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { batchUpsertFeaturesSchema, prefillRequestSchema } from "../lib/schemas.js";
import { computeSignature, slugify, versionedName, versionedSlug } from "../lib/signature.js";
import { extractBrandFields } from "../lib/brand-client.js";

const router = Router();

/**
 * Resolve a unique name + slug for a feature.
 * If the signature already exists → upsert (return existing slug/name).
 * If the name collides but signature differs → auto-suffix v2, v3, etc.
 */
async function resolveNameAndSlug(
  name: string,
  signature: string
): Promise<{ name: string; slug: string; existingId: string | null }> {
  // Check if this exact signature already exists
  const bySignature = await db.query.features.findFirst({
    where: eq(features.signature, signature),
  });
  if (bySignature) {
    return { name: bySignature.name, slug: bySignature.slug, existingId: bySignature.id };
  }

  // Signature is new — find a unique name/slug
  const baseSlug = slugify(name);
  let version = 1;
  let candidateName = name;
  let candidateSlug = baseSlug;

  while (true) {
    const collision = await db.query.features.findFirst({
      where: or(
        eq(features.name, candidateName),
        eq(features.slug, candidateSlug),
      ),
    });

    if (!collision) {
      return { name: candidateName, slug: candidateSlug, existingId: null };
    }

    version++;
    candidateName = versionedName(name, version);
    candidateSlug = versionedSlug(baseSlug, version);
  }
}

/**
 * PUT /features — Batch upsert features (idempotent, for cold-start registration).
 *
 * Signature = hash of sorted input keys + sorted output keys.
 * - Same signature → upsert metadata (labels, descriptions, charts, etc.)
 * - Same name but different signature → auto-suffix name/slug with v2, v3, etc.
 */
router.put("/features", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = batchUpsertFeaturesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const results = [];
    for (const f of parsed.data.features) {
      const signature = computeSignature(
        f.inputs.map((i) => i.key),
        f.outputs.map((o) => o.key),
      );

      const resolved = await resolveNameAndSlug(f.name, signature);

      const values = {
        name: resolved.existingId ? resolved.name : resolved.name,
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
        workflowColumns: f.workflowColumns,
        charts: f.charts,
        resultComponent: f.resultComponent ?? null,
        defaultWorkflowName: f.defaultWorkflowName ?? null,
      };

      if (resolved.existingId) {
        // Same signature → upsert metadata
        const [updated] = await db
          .update(features)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(features.id, resolved.existingId))
          .returning();
        results.push(updated);
      } else {
        // New feature
        const [created] = await db
          .insert(features)
          .values({ slug: resolved.slug, signature, ...values })
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
 * Query params: status, category, channel, audienceType, implemented
 */
router.get("/features", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const status = (req.query.status as string) || "active";
    const category = req.query.category as string | undefined;
    const channel = req.query.channel as string | undefined;
    const audienceType = req.query.audienceType as string | undefined;
    const implemented = req.query.implemented as string | undefined;

    const conditions = [eq(features.status, status)];
    if (category) conditions.push(eq(features.category, category));
    if (channel) conditions.push(eq(features.channel, channel));
    if (audienceType) conditions.push(eq(features.audienceType, audienceType));
    if (implemented !== undefined) conditions.push(eq(features.implemented, implemented === "true"));

    const results = await db.query.features.findMany({
      where: and(...conditions),
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

/**
 * Recursively flatten any value to a plain string.
 * Handles brand-service response shapes:
 *   - strings → pass through
 *   - arrays → recursively flatten each element, join with ". "
 *   - { elements: [...] } → flatten the elements array
 *   - { text: "..." } or { value: "..." } → extract the string
 *   - objects with mixed keys → collect non-null values recursively
 */
function flattenValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(flattenValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(". ") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Common wrapper: { elements: [...] }
    if (Array.isArray(obj.elements)) return flattenValue(obj.elements);
    // Direct string fields
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
    // Collect all non-null leaf values
    const parts = Object.values(obj).map(flattenValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(". ") : null;
  }
  return String(value);
}

/**
 * POST /features/:slug/prefill — Pre-fill input values for a feature.
 *
 * Takes a brandId, looks up the feature's inputs, calls brand-service
 * to extract values via AI (cached 30 days), and returns prefilled values
 * mapped to each input key.
 *
 * Query param ?format=text|full (default: full)
 *   - text: returns { value: string | null } — flat strings for form inputs
 *   - full: returns { value: unknown, cached, sourceUrls } — complete data from brand-service
 *
 * The dashboard calls this instead of brand-service directly — features-service
 * owns the routing logic (brand-service today, other sources tomorrow).
 */
router.post("/features/:slug/prefill", apiKeyAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { slug } = req.params;
    const format = (req.query.format as string) || "full";

    if (format !== "text" && format !== "full") {
      return res.status(400).json({ error: "format must be 'text' or 'full'" });
    }

    const parsed = prefillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { brandId } = parsed.data;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, slug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // Build extract-fields request from the feature's inputs
    const fields = feature.inputs.map((input) => ({
      key: input.extractKey,
      description: input.description,
    }));

    const extractedResults = await extractBrandFields(brandId, fields, {
      orgId: req.orgId,
      userId: req.userId,
      runId: req.runId,
    });

    // Map extracted values back to input keys
    const extractedByKey = new Map(extractedResults.map((r) => [r.key, r]));

    if (format === "text") {
      const prefilled: Record<string, string | null> = {};
      for (const input of feature.inputs) {
        const result = extractedByKey.get(input.extractKey);
        prefilled[input.key] = flattenValue(result?.value ?? null);
      }
      return res.json({ slug: feature.slug, brandId, format: "text", prefilled });
    }

    // format === "full"
    const prefilled: Record<string, { value: unknown; cached: boolean; sourceUrls: string[] | null }> = {};
    for (const input of feature.inputs) {
      const result = extractedByKey.get(input.extractKey);
      prefilled[input.key] = {
        value: result?.value ?? null,
        cached: result?.cached ?? false,
        sourceUrls: result?.sourceUrls ?? null,
      };
    }

    res.json({
      slug: feature.slug,
      brandId,
      format: "full",
      prefilled,
    });
  } catch (error) {
    console.error("Prefill feature error:", error);
    if (error instanceof Error && error.message.includes("brand-service")) {
      return res.status(502).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
