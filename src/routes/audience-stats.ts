import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { computeAudienceStats } from "../lib/audience-stats-compute.js";

const router = Router();

router.get("/features/:featureSlug/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const result = await computeAudienceStats(req);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.envelope);
  } catch (error) {
    console.error("[features-service] Audience stats error:", error);
    res.status(502).json({ error: "Failed to compute audience stats" });
  }
});

export default router;
