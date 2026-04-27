import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth } from "../middleware/auth.js";

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

export default router;
