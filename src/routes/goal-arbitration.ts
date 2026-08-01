import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { authorizedGoalsFromFunnels, UnknownAuthorizedGoalError } from "../lib/authorized-goals.js";
import { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";
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
// The authorized set is read from BRAND-SERVICE — the sales funnels the brand DECLARED it sells
// through — and is never accepted from the caller. The heavy evidence fan-out is goal-INDEPENDENT and
// therefore SHARES the Gold snapshot `/workflow-projection` already maintains (same view, same scope
// key) — arbitrating N goals adds zero IO over reading one.
//
// FAIL-LOUD, no substituted set: when the declaration cannot be READ the endpoint 502s with
// `reason: "authorized_goals_unavailable"` naming what failed, rather than defaulting to the brand's
// single optimizationGoal or to the whole goal vocabulary and answering as if that were real. That
// covers brand-service's `declared: false` — no set has ever been STATED for this brand — which is a
// producer gap, not an answer. A brand that STATED it sells through no funnel (`declared: true` with an
// empty list) is a different thing entirely — a real answer, served 200 as `status: "unrankable"` with
// reason `no_authorized_goals`. The two payloads are byte-identical on the funnels list, so collapsing
// them would report a brand that never answered as having answered "none".

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
    const [evidence, effective, funnels] = await Promise.all([
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
      fetchEffectiveEconomics(brandId, identity),
      // The AUTHORIZED SET, likewise live: the funnels the brand DECLARED it sells through. `[]` under
      // `declared: true` is a real answer (the brand stated it sells through none); a read that cannot
      // be answered — transport, non-OK, or `declared: false` (never stated) — throws and is reported
      // below with its own reason, never as a substituted set.
      // The org is part of the QUESTION, not just of the auth: a brand id is shared by every org that
      // claims the same domain, so we must say whose declared set we want.
      fetchDeclaredSalesFunnels(brandId, identity.orgId),
    ]);

    const response = arbitrateGoals({
      featureSlug,
      authorizedGoals: authorizedGoalsFromFunnels(funnels),
      evidence,
      economics: effective.economics,
    });
    res.json(response);
  } catch (error) {
    if (error instanceof SalesFunnelsUnavailableError) {
      // We could not READ what the brand authorizes — distinct from the brand authorizing nothing,
      // and never answered with a substituted default set.
      console.error("[features-service] Goal arbitration: authorized set unavailable:", error.message);
      return res.status(502).json({
        error: `could not read the sales funnels this brand declared, and features-service will not substitute a default set: ${error.message}`,
        reason: "authorized_goals_unavailable",
      });
    }
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
