import { Router } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { batchUpsertFeaturesSchema, createFeatureSchema, updateFeatureSchema } from "../lib/schemas.js";
import { computeSignature, slugify, versionedName, versionedSlug, composeDynastyName, pickForkName } from "../lib/signature.js";
import { extractBrandFields } from "../lib/brand-client.js";
import { flattenValue } from "../lib/flatten.js";

const router = Router();

// ── Dynasty helpers ─────────────────────────────────────────────────────────

/**
 * Find the next available version number for a dynasty.
 */
async function nextVersionInDynasty(dynastySlug: string): Promise<number> {
  const existing = await db.query.features.findMany({
    where: eq(features.dynastySlug, dynastySlug),
    columns: { version: true },
  });
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((f) => f.version)) + 1;
}

/**
 * Generate a unique fork name for a given base_name.
 * Queries existing fork names for this base_name and picks an unused codename.
 */
async function generateForkName(baseName: string): Promise<string> {
  const existing = await db.query.features.findMany({
    where: eq(features.baseName, baseName),
    columns: { forkName: true },
  });
  const usedNames = new Set(
    existing.map((f) => f.forkName).filter((n): n is string => n !== null),
  );
  return pickForkName(usedNames);
}

/**
 * Resolve dynasty identity for a new feature.
 *
 * If a dynasty with this base_name + fork_name=null already exists:
 *   - For upsert (isUpsert=true): this is an upgrade within the existing dynasty
 *   - For create (isUpsert=false): auto-generate a fork_name to create a new dynasty
 *
 * Returns the full dynasty identity needed to create the feature record.
 */
async function resolveDynastyIdentity(
  name: string,
  signature: string,
  opts: { isUpsert: boolean },
): Promise<
  | { kind: "existing"; existingId: string }
  | { kind: "upgrade"; baseName: string; forkName: string | null; dynastyName: string; dynastySlug: string; version: number; deprecateId: string }
  | { kind: "new"; baseName: string; forkName: string | null; dynastyName: string; dynastySlug: string; version: number }
> {
  // Check if this exact signature already exists (idempotent upsert)
  const bySignature = await db.query.features.findFirst({
    where: eq(features.signature, signature),
  });
  if (bySignature) {
    return { kind: "existing", existingId: bySignature.id };
  }

  if (opts.isUpsert) {
    // Batch upsert: match dynasty by base_name + fork_name=null (seed features)
    const activeInDynasty = await db.query.features.findFirst({
      where: and(
        eq(features.baseName, name),
        isNull(features.forkName),
        eq(features.status, "active"),
      ),
    });

    if (activeInDynasty) {
      // Dynasty exists with an active feature → upgrade
      const dSlug = activeInDynasty.dynastySlug;
      const nextVersion = await nextVersionInDynasty(dSlug);
      return {
        kind: "upgrade",
        baseName: activeInDynasty.baseName,
        forkName: activeInDynasty.forkName,
        dynastyName: activeInDynasty.dynastyName,
        dynastySlug: dSlug,
        version: nextVersion,
        deprecateId: activeInDynasty.id,
      };
    }

    // No existing dynasty — create new
    const dynastyName = composeDynastyName(name, null);
    const dSlug = slugify(dynastyName);
    return {
      kind: "new",
      baseName: name,
      forkName: null,
      dynastyName,
      dynastySlug: dSlug,
      version: 1,
    };
  }

  // POST /features (create): if base_name collision, generate fork name
  const existingWithBaseName = await db.query.features.findFirst({
    where: eq(features.baseName, name),
  });

  if (existingWithBaseName) {
    // Collision — generate a fork name for a new dynasty
    const forkName = await generateForkName(name);
    const dynastyName = composeDynastyName(name, forkName);
    const dSlug = slugify(dynastyName);
    return {
      kind: "new",
      baseName: name,
      forkName,
      dynastyName,
      dynastySlug: dSlug,
      version: 1,
    };
  }

  // No collision — new dynasty with no fork name
  const dynastyName = composeDynastyName(name, null);
  const dSlug = slugify(dynastyName);
  return {
    kind: "new",
    baseName: name,
    forkName: null,
    dynastyName,
    dynastySlug: dSlug,
    version: 1,
  };
}

// ── PUT /features — Batch upsert (cold-start registration) ─────────────────

router.put("/features", apiKeyAuth, async (req, res) => {
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

      const resolved = await resolveDynastyIdentity(f.name, signature, { isUpsert: true });

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

      if (resolved.kind === "existing") {
        // Same signature → upsert metadata in-place
        const [updated] = await db
          .update(features)
          .set({ ...metadataValues, updatedAt: new Date() })
          .where(eq(features.id, resolved.existingId))
          .returning();
        results.push(updated);
      } else if (resolved.kind === "upgrade") {
        // Signature changed within dynasty → deprecate old, create new version
        await db
          .update(features)
          .set({ status: "deprecated", updatedAt: new Date() })
          .where(eq(features.id, resolved.deprecateId));

        const [created] = await db
          .insert(features)
          .values({
            baseName: resolved.baseName,
            forkName: resolved.forkName,
            dynastyName: resolved.dynastyName,
            dynastySlug: resolved.dynastySlug,
            version: resolved.version,
            slug: versionedSlug(resolved.dynastySlug, resolved.version),
            name: versionedName(resolved.dynastyName, resolved.version),
            signature,
            ...metadataValues,
          })
          .returning();

        // Link predecessor
        await db
          .update(features)
          .set({ upgradedTo: created.id })
          .where(eq(features.id, resolved.deprecateId));

        results.push(created);
      } else {
        // New dynasty
        const [created] = await db
          .insert(features)
          .values({
            baseName: resolved.baseName,
            forkName: resolved.forkName,
            dynastyName: resolved.dynastyName,
            dynastySlug: resolved.dynastySlug,
            version: resolved.version,
            slug: versionedSlug(resolved.dynastySlug, resolved.version),
            name: versionedName(resolved.dynastyName, resolved.version),
            signature,
            ...metadataValues,
          })
          .returning();
        results.push(created);
      }
    }

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] Upsert features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /features — Create a single feature ───────────────────────────────

router.post("/features", apiKeyAuth, async (req, res) => {
  try {
    const parsed = createFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const f = parsed.data;
    const signature = computeSignature(
      f.inputs.map((i) => i.key),
      f.outputs.map((o) => o.key),
    );

    // Check for duplicate signature
    const existingSig = await db.query.features.findFirst({
      where: eq(features.signature, signature),
    });
    if (existingSig) {
      return res.status(409).json({
        error: "A feature with the same input/output keys already exists",
        existingSlug: existingSig.slug,
      });
    }

    const resolved = await resolveDynastyIdentity(f.name, signature, { isUpsert: false });
    if (resolved.kind === "existing") {
      // Should not happen — we already checked signature above
      return res.status(409).json({ error: "Feature already exists" });
    }
    if (resolved.kind === "upgrade") {
      return res.status(409).json({ error: "Cannot create — would upgrade an existing dynasty. Use PUT /features for upserts." });
    }

    const slug = f.slug || versionedSlug(resolved.dynastySlug, resolved.version);

    // Check slug collision (for user-provided slugs)
    if (f.slug) {
      const existingSlug = await db.query.features.findFirst({
        where: eq(features.slug, slug),
      });
      if (existingSlug) {
        return res.status(409).json({ error: `Slug "${slug}" already exists` });
      }
    }

    const [created] = await db
      .insert(features)
      .values({
        baseName: resolved.baseName,
        forkName: resolved.forkName,
        dynastyName: resolved.dynastyName,
        dynastySlug: resolved.dynastySlug,
        version: resolved.version,
        slug,
        name: versionedName(resolved.dynastyName, resolved.version),
        signature,
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
      })
      .returning();

    res.status(201).json({ feature: created });
  } catch (error) {
    console.error("[features-service] Create feature error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PUT /features/:slug — Update or fork (fork-on-write) ────────────────────

router.put("/features/:slug", apiKeyAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const parsed = updateFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await db.query.features.findFirst({
      where: eq(features.slug, slug),
    });
    if (!existing) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const data = parsed.data;

    // Determine if signature changes
    const finalInputs = data.inputs ?? existing.inputs;
    const finalOutputs = data.outputs ?? existing.outputs;
    const newSignature = computeSignature(
      finalInputs.map((i) => i.key),
      finalOutputs.map((o) => o.key),
    );

    const signatureChanged = newSignature !== existing.signature;

    if (!signatureChanged) {
      // ── Metadata-only update — safe to apply in-place ──────────────────
      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (data.description !== undefined) updates.description = data.description;
      if (data.icon !== undefined) updates.icon = data.icon;
      if (data.category !== undefined) updates.category = data.category;
      if (data.channel !== undefined) updates.channel = data.channel;
      if (data.audienceType !== undefined) updates.audienceType = data.audienceType;
      if (data.implemented !== undefined) updates.implemented = data.implemented;
      if (data.displayOrder !== undefined) updates.displayOrder = data.displayOrder;
      if (data.status !== undefined) updates.status = data.status;
      if (data.charts !== undefined) updates.charts = data.charts;
      if (data.entities !== undefined) updates.entities = data.entities;
      if (data.inputs !== undefined) updates.inputs = data.inputs;
      if (data.outputs !== undefined) updates.outputs = data.outputs;

      const [updated] = await db
        .update(features)
        .set(updates)
        .where(eq(features.id, existing.id))
        .returning();

      return res.json({ feature: updated });
    }

    // ── Signature changed ─────────────────────────────────────────────────

    // Check if the new signature already exists (convergence)
    const convergenceTarget = await db.query.features.findFirst({
      where: eq(features.signature, newSignature),
    });

    if (convergenceTarget) {
      // ── Convergence: deprecate this feature, point to existing ────────
      await db
        .update(features)
        .set({
          status: "deprecated",
          upgradedTo: convergenceTarget.id,
          updatedAt: new Date(),
        })
        .where(eq(features.id, existing.id));

      return res.json({
        feature: convergenceTarget,
        convergedFrom: {
          id: existing.id,
          slug: existing.slug,
          status: "deprecated",
          upgradedTo: convergenceTarget.id,
        },
      });
    }

    // ── Fork: create new dynasty ──────────────────────────────────────────
    const forkName = await generateForkName(existing.baseName);
    const dynastyName = composeDynastyName(existing.baseName, forkName);
    const dynastySlug = slugify(dynastyName);
    const forkVersion = 1;

    const [forked] = await db
      .insert(features)
      .values({
        baseName: existing.baseName,
        forkName,
        dynastyName,
        dynastySlug,
        version: forkVersion,
        slug: versionedSlug(dynastySlug, forkVersion),
        name: versionedName(dynastyName, forkVersion),
        signature: newSignature,
        description: data.description ?? existing.description,
        icon: data.icon ?? existing.icon,
        category: data.category ?? existing.category,
        channel: data.channel ?? existing.channel,
        audienceType: data.audienceType ?? existing.audienceType,
        implemented: data.implemented ?? existing.implemented,
        displayOrder: data.displayOrder ?? existing.displayOrder,
        status: "active",
        inputs: finalInputs,
        outputs: finalOutputs,
        charts: data.charts ?? existing.charts,
        entities: data.entities ?? existing.entities,
        forkedFrom: existing.id,
      })
      .returning();

    // Deprecate the original and link to fork
    await db
      .update(features)
      .set({
        status: "deprecated",
        upgradedTo: forked.id,
        updatedAt: new Date(),
      })
      .where(eq(features.id, existing.id));

    res.status(201).json({
      feature: forked,
      forkedFrom: {
        id: existing.id,
        slug: existing.slug,
        status: "deprecated",
        upgradedTo: forked.id,
      },
    });
  } catch (error) {
    console.error("[features-service] Update/fork feature error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/dynasty — Resolve dynasty identity from a versioned slug ──

router.get("/features/dynasty", apiKeyAuth, async (req, res) => {
  try {
    const slug = req.query.slug as string | undefined;
    if (!slug) {
      return res.status(400).json({ error: "Query parameter 'slug' is required" });
    }

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, slug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    res.json({
      feature_dynasty_name: feature.dynastyName,
      feature_dynasty_slug: feature.dynastySlug,
    });
  } catch (error) {
    console.error("[features-service] Dynasty resolution error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/dynasty/slugs — All versioned slugs in a dynasty ──────────

router.get("/features/dynasty/slugs", apiKeyAuth, async (req, res) => {
  try {
    const dynastySlug = req.query.dynastySlug as string | undefined;
    if (!dynastySlug) {
      return res.status(400).json({ error: "Query parameter 'dynastySlug' is required" });
    }

    const results = await db.query.features.findMany({
      where: eq(features.dynastySlug, dynastySlug),
      columns: { slug: true, version: true },
    });

    if (results.length === 0) {
      return res.status(404).json({ error: "No features found for this dynasty slug" });
    }

    // Sort by version ascending for predictable output
    results.sort((a, b) => a.version - b.version);

    res.json({ slugs: results.map((f) => f.slug) });
  } catch (error) {
    console.error("[features-service] Dynasty slugs resolution error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/dynasties — All dynasties with their versioned slugs ───────

router.get("/features/dynasties", apiKeyAuth, async (req, res) => {
  try {
    const all = await db.query.features.findMany({
      columns: { dynastySlug: true, slug: true, version: true },
    });

    // Group by dynastySlug
    const map = new Map<string, Array<{ slug: string; version: number }>>();
    for (const f of all) {
      const list = map.get(f.dynastySlug) ?? [];
      list.push({ slug: f.slug, version: f.version });
      map.set(f.dynastySlug, list);
    }

    const dynasties = [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dynastySlug, items]) => ({
        dynastySlug,
        slugs: items.sort((a, b) => a.version - b.version).map((i) => i.slug),
      }));

    res.json({ dynasties });
  } catch (error) {
    console.error("[features-service] List dynasties error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features — List all features ───────────────────────────────────────

router.get("/features", apiKeyAuth, async (req, res) => {
  try {
    const { status, category, channel, audienceType, implemented } = req.query as Record<string, string | undefined>;

    const conditions = [eq(features.status, status || "active")];
    if (category) conditions.push(eq(features.category, category));
    if (channel) conditions.push(eq(features.channel, channel));
    if (audienceType) conditions.push(eq(features.audienceType, audienceType));
    if (implemented !== undefined) conditions.push(eq(features.implemented, implemented === "true"));

    const results = await db.query.features.findMany({
      where: and(...conditions),
    });

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] List features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/by-dynasty/:dynastySlug — Get active feature by dynasty slug ─

router.get("/features/by-dynasty/:dynastySlug", apiKeyAuth, async (req, res) => {
  try {
    const { dynastySlug } = req.params;

    const feature = await db.query.features.findFirst({
      where: and(
        eq(features.dynastySlug, dynastySlug),
        eq(features.status, "active"),
      ),
    });

    if (!feature) {
      return res.status(404).json({ error: `No active feature found for dynasty slug "${dynastySlug}"` });
    }

    res.json({ feature });
  } catch (error) {
    console.error("[features-service] Get feature by dynasty slug error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /features/:slug — Get a single feature by exact versioned slug ───────

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

// ── GET /features/:dynastySlug/inputs — Get inputs by dynasty slug ───────────
// Path param is a dynasty slug. Resolves to the active version in that dynasty.

router.get("/features/:dynastySlug/inputs", apiKeyAuth, async (req, res) => {
  try {
    const { dynastySlug } = req.params;

    const feature = await db.query.features.findFirst({
      where: and(
        eq(features.dynastySlug, dynastySlug),
        eq(features.status, "active"),
      ),
    });

    if (!feature) {
      return res.status(404).json({ error: `No active feature found for dynasty slug "${dynastySlug}"` });
    }

    res.json({
      slug: feature.slug,
      dynastySlug: feature.dynastySlug,
      name: feature.dynastyName,
      inputs: feature.inputs,
    });
  } catch (error) {
    console.error("[features-service] Get feature inputs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /features/:dynastySlug/prefill — Pre-fill input values ─────────────
// Path param is a dynasty slug. Resolves to the active version in that dynasty.

router.post("/features/:dynastySlug/prefill", apiKeyAuth, async (req, res) => {
  try {
    const { dynastySlug } = req.params;
    const format = (req.query.format as string) || "full";

    if (format !== "text" && format !== "full") {
      return res.status(400).json({ error: "format must be 'text' or 'full'" });
    }

    const auth = req as AuthenticatedRequest;

    if (!auth.brandId) {
      return res.status(400).json({ error: "x-brand-id header is required" });
    }

    const feature = await db.query.features.findFirst({
      where: and(
        eq(features.dynastySlug, dynastySlug),
        eq(features.status, "active"),
      ),
    });

    if (!feature) {
      return res.status(404).json({ error: `No active feature found for dynasty slug "${dynastySlug}"` });
    }

    // Build extract-fields request from the feature's inputs
    const fields = feature.inputs.map((input) => ({
      key: input.extractKey,
      description: input.description,
    }));

    const extractedResults = await extractBrandFields(fields, {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      brandId: auth.brandId,
      campaignId: auth.campaignId,
      featureSlug: auth.featureSlug,
    });

    // Map extracted values back to input keys
    if (format === "text") {
      const prefilled: Record<string, string | null> = {};
      for (const input of feature.inputs) {
        const result = extractedResults[input.extractKey];
        prefilled[input.key] = flattenValue(result?.value ?? null);
      }
      return res.json({ slug: feature.slug, brandId: auth.brandId, format: "text", prefilled });
    }

    // format === "full"
    const prefilled: Record<string, { value: unknown; byBrand: Record<string, unknown> }> = {};
    for (const input of feature.inputs) {
      const result = extractedResults[input.extractKey];
      prefilled[input.key] = {
        value: result?.value ?? null,
        byBrand: result?.byBrand ?? {},
      };
    }

    res.json({
      slug: feature.slug,
      brandId: auth.brandId,
      format: "full",
      prefilled,
    });
  } catch (error) {
    console.error("[features-service] Prefill feature error:", error);
    if (error instanceof Error && error.message.includes("brand-service")) {
      return res.status(502).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
