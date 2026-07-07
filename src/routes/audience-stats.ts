import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";

const router = Router();

router.get("/features/:featureSlug/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId } = req as AuthenticatedRequest;
    // Gold SWR: the cost + membership + email fan-out runs off the request path ~once per TTL, keyed on
    // every input that shapes the body. The ComputeResult is deterministic (validation 400/404 or a
    // ranked envelope) so it is safe to cache; transient downstream failures THROW inside
    // computeAudienceStats and propagate to the catch below (a 502, never cached).
    const scopeKey = buildScopeKey(featureSlug, {
      orgId,
      brandId: req.query.brandId,
      goal: req.query.goal,
      statuses: req.query.statuses,
      limit: req.query.limit,
      brandProfileId: req.query.brandProfileId,
    });
    const result = await servedCached<ComputeResult>({
      view: "audience-stats",
      scopeKey,
      orgId,
      compute: () => computeAudienceStats(req),
    });
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
