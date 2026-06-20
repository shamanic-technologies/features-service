import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { computeAudienceStats, type AudienceStatsEnvelope } from "../lib/audience-stats-compute.js";

const router = Router();

/**
 * DEPRECATED ALIAS of GET /features/:featureSlug/audience-stats.
 *
 * Identical inputs / auth / ranking / row data. The ONLY difference is the response naming:
 * the top-level array is `personas` (not `audiences`) and each row's block is `persona`
 * (not `audience`). Kept so not-yet-migrated consumers (campaign-service direct call,
 * api-service proxy, distribute.you dashboard) keep working during the persona→audience
 * rename. A follow-up PR removes this once consumers migrate. Do NOT add logic here — both
 * surfaces share `computeAudienceStats`.
 */
function toPersonaResponse(env: AudienceStatsEnvelope): Record<string, unknown> {
  return {
    featureSlug: env.featureSlug,
    brandId: env.brandId,
    goal: env.goal,
    brandProfileId: env.brandProfileId,
    sortMetric: env.sortMetric,
    personas: env.audiences.map((row) => ({
      audienceId: row.audienceId,
      brandProfileId: row.brandProfileId,
      persona: row.audience,
      evidence: row.evidence,
      metrics: row.metrics,
    })),
  };
}

router.get("/features/:featureSlug/persona-stats", apiKeyAuth, async (req, res) => {
  try {
    const result = await computeAudienceStats(req);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(toPersonaResponse(result.envelope));
  } catch (error) {
    console.error("[features-service] Persona stats error:", error);
    res.status(502).json({ error: "Failed to compute persona stats" });
  }
});

export default router;
