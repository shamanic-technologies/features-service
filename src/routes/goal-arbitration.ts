import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomicsWithAuthorization } from "../lib/sales-economics-client.js";
import { UnknownAuthorizedGoalError } from "../lib/authorized-goals.js";
import { arbitrateGoals } from "../lib/goal-arbitration.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { fetchWorkflowProjectionEvidence } from "./workflow-projection.js";
import type { Identity } from "../lib/workflow-projection-grains.js";

const router = Router();

// ── GET /features/:featureSlug/goal-arbitration ──────────────────────────────
//
// ONE answer per brand: which of the goals the brand AUTHORIZES returns the most per dollar, the best
// workflow for that goal, and the per-audience evidence for that pairing. campaign-service greedily
// picks the first two and Thompson-samples the third; it decides none of them, and it never issues one
// request per goal.
//
// The authorized set is read from BRAND-SERVICE and is never accepted from the caller. It rides the
// same sales-economics-effective payload this endpoint already reads, so the arbitration costs ONE
// brand-service call. The heavy evidence fan-out is goal-INDEPENDENT and therefore SHARES the Gold
// snapshot `/workflow-projection` already maintains (same view, same scope key) — arbitrating N goals
// adds zero IO over reading one.
//
// FAIL-LOUD, no substituted set: when brand-service states no authorized set the endpoint 502s with
// `reason: "authorized_goals_unavailable"` naming what is missing, rather than defaulting to the brand's
// single optimizationGoal or to the whole goal vocabulary and answering as if that were real. An EMPTY
// authorized set is a different thing — a real answer, served 200 as `status: "unrankable"`.

router.get("/features/:featureSlug/goal-arbitration", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  // GROSS (default) vs NET pricing — same selector, same semantics as every sibling cost surface.
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) {
    return res.status(400).json({ error: "pricing must be one of: gross, net" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const identity: Identity = { orgId, userId, runId, featureSlug: headerFeatureSlug };
    const [evidence, brand] = await Promise.all([
      // SAME view + scope key as /workflow-projection: the evidence depends only on
      // (featureSlug, orgId, brandId, pricing) and not on any goal, so both endpoints share one snapshot.
      servedCached({
        view: "workflow-projection-evidence",
        scopeKey: buildScopeKey(featureSlug, { orgId, brandId, pricing }),
        orgId,
        compute: () => fetchWorkflowProjectionEvidence({ featureSlug, brandId, identity, pricing }),
      }),
      // Economics is read LIVE on every request (never cached) — an arbitration run right after an
      // economics write must rank on the NEW terms. Same rule as /workflow-projection.
      fetchEffectiveEconomicsWithAuthorization(brandId, identity),
    ]);

    if (brand.authorizedGoals === null) {
      return res.status(502).json({
        error:
          "brand-service states no authorized goal set for this brand — the goals a brand sells through are brand-service's to declare, and features-service will not substitute a default set",
        reason: "authorized_goals_unavailable",
      });
    }

    const response = arbitrateGoals({
      featureSlug,
      authorizedGoals: brand.authorizedGoals,
      evidence,
      economics: brand.effective.economics,
    });
    res.json(response);
  } catch (error) {
    if (error instanceof UnknownAuthorizedGoalError) {
      // A goal the brand authorized that we cannot map must never be silently dropped from the
      // competition — that would arbitrate a smaller set and answer as if it were the whole one.
      console.error("[features-service] Goal arbitration: unrecognised authorized goal:", error.raw);
      return res.status(502).json({
        error: `brand-service authorized goal "${error.raw}" is not a recognised optimization goal`,
        reason: "authorized_goal_unrecognised",
      });
    }
    console.error("[features-service] Goal arbitration error:", error);
    res.status(502).json({ error: "Failed to arbitrate goals" });
  }
});

export default router;
