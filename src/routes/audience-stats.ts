import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { computeAudienceStats, validateAudienceStatsQuery, type ComputeResult } from "../lib/audience-stats-compute.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";
import { resolveOfferCampaignIds, OfferHasNoCampaignsError } from "../lib/offer-scope.js";

const router = Router();

router.get("/features/:featureSlug/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId, userId, runId } = req as AuthenticatedRequest;

    // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) {
      return res.status(400).json({ error: "pricing must be one of: gross, net" });
    }
    // NET reads runs#179's frozen net cost fields (no billing call, no read-time multiply); GROSS is
    // byte-identical. The selector is threaded into computeAudienceStats' cost read below. A NET request
    // where the net figure is absent throws inside computeAudienceStats → 502 (never cached, no fallback).

    // Validate FIRST — the economics read below is a NETWORK call, and it must never run for a request
    // that is going to 400 anyway. With an unreachable brand-service the retrying client burns seconds
    // before failing, which is a hang, not just wasted work (it turned two validation tests into 5s
    // timeouts in CI while they passed locally). Shares ONE definition of "valid" with
    // computeAudienceStats, which calls the same validator, so the route cannot drift from the lib.
    const validated = validateAudienceStatsQuery(req);
    if (!validated.ok) {
      return res.status(validated.status).json({ error: validated.error });
    }

    // ── Offer scope ──────────────────────────────────────────────────────────
    // `?offerId=` narrows every per-audience cost and engagement numerator to the ONE offer a brand
    // sells — the grain between the brand and its campaigns (see lib/offer-scope.ts). It resolves to
    // the offer's campaign ids and takes the campaign-scope path the single `?campaignId=` already
    // takes, with more than one member. Absent → byte-identical to today.
    //
    // The AUDIENCES themselves stay brand-wide, exactly as they do under a campaign scope: an audience
    // is a brand-level entity that several offers may address, and hiding one because this offer has
    // not reached it yet would answer a question about the audience list with one about the spend.
    const offerId = ((req.query.offerId as string | undefined) ?? "").trim() || undefined;
    if (offerId && req.query.campaignId) {
      return res.status(400).json({ error: "offerId and campaignId are mutually exclusive: a campaign already sells exactly one offer" });
    }
    // Fail-loud: with the partition unreadable there is no way to tell the offer's spend from the
    // brand's, and answering anyway would rank audiences on money this offer never spent.
    const offerCampaignIds = offerId
      ? await resolveOfferCampaignIds(offerId, validated.brandId, featureSlug, { orgId, userId, runId })
      : undefined;

    // A funnel the brand never declared has no cost to serve — "we could not estimate this" and "it
    // costs zero" are different statements, and only the first is true. 404 with the reason rather than
    // pricing a funnel the org never said it sells through. Fires ONLY on `?funnel=`, so every existing
    // goal-keyed request takes no extra read.
    if (validated.funnelKey) {
      let declared: string[];
      try {
        declared = (await fetchDeclaredSalesFunnels(validated.brandId, orgId)).map((f) => f.funnelKey);
      } catch (err) {
        if (err instanceof SalesFunnelsUnavailableError) {
          return res.status(502).json({ error: err.message, reason: "declared_funnels_unavailable" });
        }
        throw err;
      }
      if (!declared.includes(validated.funnelKey)) {
        return res.status(404).json({
          error: `this brand has not declared the ${validated.funnelKey} funnel, so there is no cost to estimate for it`,
          reason: "funnel_not_declared",
          declaredFunnelKeys: declared,
        });
      }
    }

    // The derived cost columns (cost per form submission / signup / sale) project through the brand's
    // economics via `fetchBrandProjectedParents`, so the body goes stale the moment the economics change.
    // Folding the fingerprint into the cache key makes an economics write land on a different cell, which
    // forces a fresh compute instead of replaying a pre-write snapshot until the hard-stale cap. Read here
    // for the KEY only; the compute does its own read on a miss (one extra brand-service call on the miss
    // path, not worth threading an override down through fetchBrandProjectedParents).
    //
    // Fail-soft, via a real try/catch rather than a trailing `.catch()`: `fetchEffectiveEconomics`
    // validates its env and can throw SYNCHRONOUSLY before its first await, which a funneled `.catch()`
    // would not see. This read feeds a cache KEY, not the response, so its failure must not change the
    // endpoint's HTTP semantics — degrade to "no fingerprint in the key" and let the compute (which reads
    // economics fail-loud) decide the status.
    // THE BRAND-LEVEL read's body is priced on the brand's DECLARED SET, which is not a query parameter —
    // so a brand that adds or drops a funnel would keep being served the previous set's answer (with a
    // `funnelCoverage` naming funnels it no longer sells through) until the hard-stale cap. Folding the
    // declared keys into the key makes a re-declaration land on a DIFFERENT cell, exactly as the economics
    // fingerprint does for an economics write. Fail-soft: it feeds the KEY, not the response — a read that
    // cannot be answered still 502s from the compute, which owns that decision.
    let decl: string | undefined;
    if (!validated.funnelKey && validated.goal === null) {
      try {
        decl = (await fetchDeclaredSalesFunnels(validated.brandId, orgId))
          .map((f) => f.funnelKey)
          .sort()
          .join(",");
      } catch (err) {
        console.warn(
          `[features-service] audience-stats declared-funnel key unavailable (keying without it): ${(err as Error).message}`,
        );
      }
    }

    let econ: string | undefined;
    try {
      econ = economicsFingerprint(
        await fetchEffectiveEconomics(validated.brandId, { orgId, userId, runId, featureSlug }),
      );
    } catch (err) {
      console.warn(
        `[features-service] audience-stats economics fingerprint unavailable (keying without it): ${(err as Error).message}`,
      );
    }

    // Gold SWR: the cost + membership + email fan-out runs off the request path ~once per TTL, keyed on
    // every input that shapes the body. The ComputeResult is deterministic (validation 400/404 or a
    // ranked envelope) so it is safe to cache; transient downstream failures THROW inside
    // computeAudienceStats and propagate to the catch below (a 502, never cached).
    const scopeKey = buildScopeKey(featureSlug, {
      orgId,
      brandId: req.query.brandId,
      goal: req.query.goal,
      // The funnel changes the cost basis of every column, so it MUST be in the key — keyed on the
      // CANONICAL value the validator resolved, so `reply_meeting` and `sales_meetings_from_conversation`
      // share one cell instead of fragmenting it. Absent → dropped → byte-identical to a goal-only key.
      funnel: validated.funnelKey,
      statuses: req.query.statuses,
      limit: req.query.limit,
      brandProfileId: req.query.brandProfileId,
      pricing,
      econ,
      decl,
      // Campaign scope is part of the cache key so campaign-scoped and brand-wide snapshots never
      // collide. Absent → dropped by buildScopeKey → key byte-identical to the brand-wide request.
      campaignId: req.query.campaignId,
      // Same rule one grain up: an offer-scoped body and the brand-wide one must never share a cell.
      offerId,
    });
    const result = await servedCached<ComputeResult>({
      view: "audience-stats",
      scopeKey,
      orgId,
      compute: () => computeAudienceStats(req, pricing, offerCampaignIds),
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.envelope);
  } catch (error) {
    // An offer no campaign of this brand sells has no spend to rank audiences on — named, never
    // answered with the brand's own numbers and never with a fabricated zero.
    if (error instanceof OfferHasNoCampaignsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_campaigns", offerId: error.offerId });
    }
    // The BRAND-LEVEL read (no funnel, no goal) prices the brand through the funnels it DECLARED, so a
    // declaration we cannot read leaves it with no question to answer — reported as what failed, never
    // as a substituted default set and never as a zero return. Same reason string the `?funnel=` path
    // above uses, so a consumer reads one word for one failure.
    if (error instanceof SalesFunnelsUnavailableError) {
      console.error("[features-service] Audience stats: declared set unavailable:", error.message);
      return res.status(502).json({
        error: `could not read the sales funnels this brand declared, and features-service will not substitute a default set: ${error.message}`,
        reason: "declared_funnels_unavailable",
      });
    }
    console.error("[features-service] Audience stats error:", error);
    res.status(502).json({ error: "Failed to compute audience stats" });
  }
});

export default router;
