import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";

const router = Router();

// ── GET /public/features — List active features (landing page) ──────────────
// Returns only display-safe fields. No internal IDs, no inputs/outputs definitions.

router.get("/public/features", async (_req, res) => {
  try {
    const results = await db.query.features.findMany({
      where: eq(features.status, "active"),
      columns: {
        dynastyName: true,
        dynastySlug: true,
        description: true,
        icon: true,
        category: true,
        channel: true,
        audienceType: true,
        displayOrder: true,
      },
    });

    results.sort((a, b) => a.displayOrder - b.displayOrder);

    res.json({ features: results });
  } catch (error) {
    console.error("[features-service] Public list features error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /public/features/dynasty/slugs — All versioned slugs in a dynasty ───
// Same as the authenticated version. No sensitive data — just slug strings.

router.get("/public/features/dynasty/slugs", async (req, res) => {
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

    results.sort((a, b) => a.version - b.version);

    res.json({ slugs: results.map((f) => f.slug) });
  } catch (error) {
    console.error("[features-service] Public dynasty slugs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
