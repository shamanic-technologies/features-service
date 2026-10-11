/**
 * A BRAND'S SALES FUNNEL CAMPAIGNS, ONE ROW EACH, AS THE DASHBOARD CAMPAIGNS TABLE READS THEM (owner 2026-10-11).
 *
 *   GET /brands/:brandId/sales-funnel-campaigns[?offerId=&pricing=net|gross]
 *
 * A customer campaign is a SALES FUNNEL CAMPAIGN (campaign-service `GET /sales-funnel-campaigns`: brand x offer x
 * sales funnel, one UNIT campaign per pipe). Each row serves, so the browser composes and computes nothing:
 *   - the funnel's NAME (campaign-service's) and FACE, its TYPE, its trigger label and the Type column's label ("Daily", or a reactive funnel's trigger: "Positive replies"):
 *     the SAME trigger label its catalogue funnel row serves; and its PATH as structured items ("Lead found -> Sales Cold Email Outreach -> Positive reply -> Paid client",
 *     `funnelPathView`: from Start, a channel between every two steps, the sourcing leg showing this campaign's own
 *     sources), so the dashboard never parses an id;
 *   - its MONEY SINCE INCEPTION over its units together: ONE engine pass (`computeFeatureRevenue`) over the
 *     units' campaign ids and channels, exactly as the offer grain combines its channels: spend ADDS (every
 *     cost row belongs to one unit, so `investedUsd` = the sum of the units' committed spend, the same
 *     `committedCostUsd` each unit's own campaign read serves), people are deduped, every ratio is recomputed
 *     from the combined numerator and denominator (never a sum or an average of unit ROIs). Priced on the
 *     offer's terms narrowed to the funnels the units' legs walk (the rule a unit's own read follows), with
 *     the maturity verdict (`maturity`, `costEconomics.unmeasuredReason`) the per-campaign reads serve.
 *
 * Units whose channels price on two different funnel definitions cannot be priced as one figure: the row
 * still serves its invested amount, with a null ROI and `moneyUnavailableReason: "units_price_differently"`.
 * A funnel id the catalogue no longer knows serves null copy + `copyUnavailableReason`. campaign-service
 * unreadable = 502 (no row is ever guessed).
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { computeFeatureRevenue, fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import type { FunnelPricedEconomics } from "../lib/offer-pricing.js";
import { distinctChannelFunnels } from "./offer-economics.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { faceOf } from "../lib/catalogue-faces.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing } from "../lib/pricing.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { funnelsContainingLeg, isOutboundLegKeySpelling, storedLegKeyOf } from "../lib/funnel-legs.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import type { DeclaredSalesFunnel } from "../lib/sales-funnels-client.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelUnitRow } from "../lib/sales-funnel-campaigns-client.js";
import { STEP_SIGNAL, takeoverStepOf } from "../lib/value-added.js";
import { computeTakeoverReturn } from "../lib/value-added-io.js";

const router = Router();

export { fetchSalesFunnelCampaigns, type SalesFunnelUnitRow, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";

/** PURE: the offer's terms narrowed to the declared funnels the units' legs walk (a unit's own read rule). */
export function pricingForUnits(declared: DeclaredSalesFunnel[], all: FunnelPricedEconomics, units: readonly SalesFunnelUnitRow[]): FunnelPricedEconomics {
  const legs = units.map((u) => (isOutboundLegKeySpelling(u.legKey) ? storedLegKeyOf(u.legKey) : u.legKey));
  const own = declared.filter((f) => legs.some((leg) => funnelsContainingLeg(leg).includes(f.funnelKey)));
  if (own.length === 0) return all;
  return priceOnDeclaredFunnel(own, own.length === 1 ? own[0].funnelKey : undefined);
}

router.get("/brands/:brandId/sales-funnel-campaigns", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string } };
    const brandId = auth.params.brandId;
    const offerFilter = typeof req.query.offerId === "string" && req.query.offerId.trim() !== "" ? req.query.offerId.trim() : null;
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };

    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, offerFilter, headers), assertBrandHeld(brandId, headers)]);
    const { copies, pipeSteps, pathOf } = await funnelCopiesFor([...new Set(rows.map((r) => r.salesFunnelId))]);

    // The offer's terms, read ONCE per offer and shared by its funnel campaigns.
    const offerIds = [...new Set(rows.map((r) => r.offerId))];
    const declaredByOffer = new Map(await Promise.all(offerIds.map(async (o) => [o, await fetchDeclaredFunnelsSoft(brandId, headers.orgId, o)] as const)));

    const out = await mapWithConcurrency(rows, 3, async (r) => {
      const copy = copies.get(r.salesFunnelId) ?? null;
      if (!copy) console.error(`[features-service] sales funnel campaign ${r.id}: funnel ${r.salesFunnelId} is not in the catalogue (copy null)`);
      const featureSlugs = [...new Set(r.units.map((u) => u.featureSlug))].sort();
      const campaignIds = r.units.map((u) => u.campaignId).sort();
      const distinct = distinctChannelFunnels(r.units);
      const funnel = distinct.length === 1 ? distinct[0] : null;
      const declared = declaredByOffer.get(r.offerId) ?? [];
      const priced = funnel ? pricingForUnits(declared, priceOnDeclaredFunnel(declared), r.units) : undefined;
      // WHERE THIS CAMPAIGN TOOK ITS PEOPLE OVER (`lib/value-added.ts`, owner 2026-10-11, one formula for every
      // campaign): the funnel's first step unless its own units produce it. Null = from nothing (it found them):
      // its return is the engine's ordinary pipeline over its spend. Else it is credited only the value it adds.
      const unitSteps = r.units.flatMap((u) => pipeSteps.get(u.pipeId) ?? []);
      const takeoverStep = copy ? takeoverStepOf(copy.firstStep, unitSteps) : null;
      const takeoverUnit = takeoverStep ? r.units.find((u) => pipeSteps.get(u.pipeId)?.fromStep === takeoverStep) : undefined;
      const takeoverToStep = takeoverUnit ? pipeSteps.get(takeoverUnit.pipeId)!.toStep : null;

      const money = campaignIds.length === 0
        ? null
        : await servedCached({
            view: "sales-funnel-campaign-money",
            scopeKey: buildScopeKey(r.id, {
              orgId: headers.orgId,
              brandId,
              offerId: r.offerId,
              units: campaignIds.join("+"),
              takeover: takeoverStep ?? undefined,
              channels: featureSlugs.join("+"),
              pricing,
              econ: priced ? pricedFingerprint(priced) : undefined,
              decl: funnel ? declared.map((f) => f.funnelKey).sort().join("+") || "none" : undefined,
            }),
            orgId: headers.orgId,
            compute: async () => {
              // A step the engine values nothing at (Lead found) subtracts $0: the engine's own figures ARE the formula.
              if (takeoverStep && STEP_SIGNAL[takeoverStep] && takeoverUnit && takeoverToStep && funnel) {
                const t = await computeTakeoverReturn({
                  brandId,
                  unitCampaignIds: campaignIds,
                  featureSlugs,
                  takeoverStep,
                  takeoverLeg: { legKey: takeoverUnit.legKey, toStep: takeoverToStep },
                  priced,
                  pricing,
                  headers,
                });
                return { headline: t.headline, costEconomics: t.costEconomics, maturity: t.maturity, valueAdded: t.valueAdded };
              }
              const body = await computeFeatureRevenue(featureSlugs, brandId, campaignIds, funnel, headers, undefined, priced, false, pricing, undefined, r.offerId, undefined, DEFAULT_PRICED_CAUSES);
              return { headline: body.headline, costEconomics: body.costEconomics, maturity: body.maturity ?? null, valueAdded: null };
            },
          });

      return {
        id: r.id,
        brandId: r.brandId,
        offerId: r.offerId,
        salesFunnelId: r.salesFunnelId,
        name: r.salesFunnelName,
        face: faceOf(r.salesFunnelName).svgPath,
        status: r.status,
        stopReason: r.stopReason,
        createdAt: r.createdAt,
        type: copy?.type ?? null,
        triggerLabel: copy?.triggerLabel ?? null,
        // The Type column (owner 2026-10-11): "Daily" for a proactive funnel, its trigger for a reactive one.
        typeLabel: copy ? (copy.type === "proactive" ? "Daily" : copy.triggerLabel) : null,
        // The path the dashboard draws in place of the sentence (owner 2026-10-11), structured: never parsed from an id.
        // Its sourcing leg shows the sources THIS campaign runs (its units' channels).
        path: copy ? pathOf(r.salesFunnelId, featureSlugs) : null,
        copyUnavailableReason: copy ? null : "sales_funnel_not_in_catalogue",
        units: r.units.map((u) => ({ campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status })),
        investedUsd: money ? money.costEconomics.committedCostUsd : 0,
        roiMultiple: money && distinct.length <= 1 ? money.costEconomics.roiMultiple : null,
        moneyUnavailableReason: distinct.length > 1 ? "units_price_differently" : null,
        // The pipeline and WHY it is unpriced (`unpricedReason`, e.g. `no_funnel_wired` on an AI meeting
        // booking funnel), the block a campaign row serves: a null ROI always reads with its reason.
        headline: money?.headline ?? null,
        costEconomics: money?.costEconomics ?? null,
        maturity: money?.maturity ?? null,
        // Where this campaign took its people over (null = it found them) and what it added on top of their value
        // there (`lib/value-added.ts`); `headline.totalPipelineUsd` is that value added when a step is named.
        takeoverStep,
        valueAdded: money?.valueAdded ?? null,
      };
    });

    res.json({ brandId, offerId: offerFilter, pricing, costBasis: "charged", salesFunnelCampaigns: out });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] sales funnel campaigns error:", err);
    res.status(502).json({ error: "Failed to read sales funnel campaigns" });
  }
});

export default router;
