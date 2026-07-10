import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, resolveDiscountFactor } from "../lib/pricing.js";

const router = Router();

router.get("/features/:featureSlug/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId } = req as AuthenticatedRequest;

    // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) {
      return res.status(400).json({ error: "pricing must be one of: gross, net" });
    }
    // NET → the org's discount factor (fail-loud if unresolvable, 502 via catch). GROSS → 1 (no billing call).
    // Resolved OUTSIDE servedCached so a NET resolution failure never persists a snapshot.
    const discountFactor = await resolveDiscountFactor(pricing, orgId);

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
      pricing,
    });
    const result = await servedCached<ComputeResult>({
      view: "audience-stats",
      scopeKey,
      orgId,
      compute: () => computeAudienceStats(req, discountFactor),
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
