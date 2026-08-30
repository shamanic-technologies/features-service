import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { declaredFunnelsToRank } from "../lib/declared-funnels.js";
import { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError, UnknownSalesFunnelError } from "../lib/sales-funnels-client.js";
import { rankDeclaredFunnels } from "../lib/funnel-ranking.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { MAXIMIZE_ERROR, parseMaximize } from "../lib/maximize.js";
import { fetchWorkflowProjectionEvidence } from "./workflow-projection.js";
import type { Identity } from "../lib/workflow-projection-grains.js";

const router = Router();

// ── GET /features/:featureSlug/funnel-ranking ────────────────────────────────
//
// THE NAME SAYS WHAT IT DOES. This endpoint used to be `goal-arbitration`, and it used to BE the
// decision: campaign-service asked which goal to work and ran the one that came back. It does not
// arbitrate anything any more: it RANKS the sales funnels a brand declared it sells through, on what
// the CALLER says it is maximising (`?maximize=return|conversionRate`, defaulting to return per dollar
// and stated back on `maximize`) — see lib/maximize.ts for why a rate is a different question and why
// the word is not `objective`.
// `/features/:featureSlug/goal-arbitration` stays mounted as a DEPRECATED ALIAS serving a byte-identical
// body, for exactly as long as it takes the fleet's callers to move to `/funnel-ranking`; its removal is
// a separate change.
//
// ONE answer per brand: EVERY sales funnel the brand declared, ranked by what it returns per dollar,
// plus the best workflow and per-audience evidence for the best-returning one.
//
// IT IS ADVICE, NOT A GATE. Which funnel actually runs is decided by what the customer FUNDS —
// campaign-service works every funded funnel, each paced against its own ceiling. This endpoint answers
// the other question: which funnel has returned best, and how do the others compare, so a customer can
// decide where to move their money. Every declared funnel is ranked on its HISTORY, funded or not;
// there is deliberately no billing read here (see lib/funnel-ranking.ts). The legacy
// `arbitration` / `workflow` / `rows` fields stay byte-compatible for campaign-service, which still
// reads them to pace a brand that has no per-funnel funding, and are derived from the same pick.
//
// The declared set is read from BRAND-SERVICE and is never accepted from the caller. The heavy evidence
// fan-out is goal-INDEPENDENT and therefore SHARES the Gold snapshot `/workflow-projection` already
// maintains (same view, same scope key) — ranking N funnels adds zero IO over reading one.
//
// EACH FUNNEL IS PRICED ON ITS OWN FUNNEL. A funnel no longer carries a goal (brand-service #434) and
// the goal could not have answered this anyway: `sales_meetings_from_conversation` and
// `sales_meetings_from_website` both mapped onto `meetingBooked`, so the two were charged the same
// blended both-channel price. They are now scored on the channel each actually buys through, so a brand
// declaring both gets two different costs and a ranking that can tell it which one to fund.
//
// FAIL-LOUD, no substituted set: when the declaration cannot be READ the endpoint 502s with
// `reason: "authorized_goals_unavailable"` naming what failed, rather than defaulting to the brand's
// single optimizationGoal or to the whole goal vocabulary and answering as if that were real. That
// covers an EMPTY funnel list from brand-service — this org has never STATED what it sells through,
// which is a producer gap, not an answer. There is no "answered, but sells through nothing" to
// confuse it with: brand-service refuses to switch off an org's last active funnel, so having
// answered always leaves at least one.

const handleFunnelRanking = async (req: Request, res: Response) => {
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

  // WHAT THE CALLER IS MAXIMISING — a RETURN per dollar (the default, and the only ordering this
  // endpoint produced before) or a CONVERSION RATE, for the brand whose binding constraint is a finite
  // list rather than its budget. Absent → `return`, byte-identical; unrecognised → loud 400.
  const maximizeParam = parseMaximize(req.query as Record<string, unknown>);
  if (!maximizeParam.ok) {
    return res.status(400).json({ error: MAXIMIZE_ERROR, reason: "maximize_unrecognised" });
  }
  const maximize = maximizeParam.maximize;

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
      // The DECLARED SET, likewise live: the funnels this org sells this brand through. A read that
      // cannot be answered — transport, non-OK, or an empty list (never stated) — throws and is
      // reported below with its own reason, never as a substituted set.
      // The org is part of the QUESTION, not just of the auth: a brand id is shared by every org that
      // claims the same domain, so we must say whose declared set we want.
      fetchDeclaredSalesFunnels(brandId, identity.orgId),
    ]);

    const response = rankDeclaredFunnels({
      featureSlug,
      funnels: declaredFunnelsToRank(funnels),
      evidence,
      economics: effective.economics,
      maximize,
    });
    res.json(response);
  } catch (error) {
    if (error instanceof SalesFunnelsUnavailableError) {
      // We could not READ what the brand declared — distinct from the brand declaring nothing, and
      // never answered with a substituted default set. The wire `reason` keeps its deployed spelling:
      // campaign-service matches on it verbatim to tell "no ranking yet" from a genuine fault.
      console.error("[features-service] Funnel ranking: declared set unavailable:", error.message);
      return res.status(502).json({
        error: `could not read the sales funnels this brand declared, and features-service will not substitute a default set: ${error.message}`,
        reason: "authorized_goals_unavailable",
      });
    }
    if (error instanceof UnknownSalesFunnelError) {
      // A funnel the brand declared that we have no funnel for must never be silently dropped from the
      // ranking — that would rank a smaller set and answer as if it were the whole one, leaving the
      // customer comparing against a list missing one of their own funnels. The wire `reason` keeps its
      // deployed spelling; campaign-service matches on it verbatim.
      console.error("[features-service] Funnel ranking: unrecognised declared sales funnel:", error.raw);
      return res.status(502).json({
        error: `brand-service declared sales funnel "${error.raw}" is not in the known catalogue`,
        reason: "authorized_goal_unrecognised",
      });
    }
    console.error("[features-service] Funnel ranking error:", error);
    res.status(502).json({ error: "Failed to rank the brand's declared sales funnels" });
  }
};

// The canonical path, named for what it does.
router.get("/features/:featureSlug/funnel-ranking", apiKeyAuth, handleFunnelRanking);
// DEPRECATED ALIAS — the pre-retirement path, kept byte-identical while the fleet's callers migrate
// (campaign-service reads `arbitration` / `workflow` / `rows` off it in production to pace a brand with
// no per-funnel funding). Removing it is a SEPARATE change, made once no caller is left on it.
router.get("/features/:featureSlug/goal-arbitration", apiKeyAuth, handleFunnelRanking);

export default router;
