/**
 * GET /brands/:brandId/deals-value — what each Deals-board column holds in dollars
 * (`lib/deals-value.ts`), per column and per card.
 *
 * A SEPARATE figure: it is added to no pipeline, no ROI, no cost of acquisition and no existing body.
 * WHICH people sit in a column is lead-service's standing (its `?standing=` filter, read here); what
 * they are worth is priced on the byte-same inputs the brand's pipeline is priced on
 * (`loadBrandPricedPopulation`, shared with contacted-value), so an Interested card reads the same
 * number the engine prices that person at (on every outcome cause — see computeBrandDealsValue).
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, type DownstreamHeaders } from "./revenue.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError } from "../lib/brand-channels.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadIdsByStanding } from "../lib/leads-client.js";
import { ALL_OUTCOME_CAUSES } from "../lib/outcome-cause.js";
import { loadBrandPricedPopulation, BrandPricesDifferentlyError, type BrandPricingPre } from "./contacted-value.js";
import { priceDealsColumns, type DealsValueResult } from "../lib/deals-value.js";

const router = Router();

/** The brand's column values, computed once per refresh (the Gold snapshot layer caches it). */
export async function computeBrandDealsValue(
  brandId: string,
  headers: DownstreamHeaders,
  pre: BrandPricingPre,
): Promise<DealsValueResult> {
  // A DEALS board shows what each deal is worth to the customer, whoever caused it — so both columns
  // are priced on EVERY cause state (the engine basis `/revenue?cause=outreach,other,unstated` serves),
  // never on the pipeline's "our outreach only" default. Measured in prod 2026-09-26 (Doc Dinners): on
  // the default, 45 of 54 Interested cards read $0 because their meetings came through the CRM.
  const [population, interested, won] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { fleetEntryStats: false, pricedCauses: ALL_OUTCOME_CAUSES }),
    fetchLeadIdsByStanding(brandId, "sales_interest", headers),
    fetchLeadIdsByStanding(brandId, "customer", headers),
  ]);

  // The WON amount is the one stated on the SALE. Unreadable statements (fail-soft in the loader) leave
  // every won card on the brand's value of a client, and each card says so.
  let statedWonAmountUsdByEmail: Map<string, number> | null = null;
  if (population.observed) {
    statedWonAmountUsdByEmail = new Map();
    for (const [email, f] of population.observed.byEmail) {
      if ("closeWin" in f.reached && f.valueUsd !== null) statedWonAmountUsdByEmail.set(email, f.valueUsd);
    }
  }

  return priceDealsColumns({
    persons: population.persons,
    paths: population.paths,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    members: { sales_interest: interested, customer: won },
    statedWonAmountUsdByEmail,
    pricedCauses: ALL_OUTCOME_CAUSES,
  });
}

router.get("/brands/:brandId/deals-value", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  try {
    const channels = await resolveBrandChannels(brandId, headers);
    const [declared, effective] = await Promise.all([
      fetchDeclaredFunnelsSoft(brandId, headers.orgId),
      fetchEffectiveEconomics(brandId, headers),
    ]);
    const priced = priceOnDeclaredFunnel(declared, effective);
    const result = await servedCached({
      view: "brand-deals-value",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: brandFeatureSlugs(channels).join("+"),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: economicsFingerprint(priced.economics),
        m: "deals-value-v2",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandDealsValue(brandId, headers, { channels, declared, effective }),
    });
    return res.json({ brandId, ...result });
  } catch (error) {
    if (error instanceof BrandHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "brand_has_no_channels", brandId });
    }
    if (error instanceof BrandPricesDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "brand_channels_price_differently", brandId });
    }
    console.error(`[features-service] Brand deals value error:`, error);
    return res.status(502).json({ error: "Failed to compute brand deals value" });
  }
});

export default router;
