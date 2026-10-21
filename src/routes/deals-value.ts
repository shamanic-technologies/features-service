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
import { ContactedValueUnavailableError, contactedValueUnavailableBody } from "../lib/contacted-value-unavailable.js";
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld } from "../lib/brand-ownership.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError } from "../lib/brand-channels.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadIdsByStanding } from "../lib/leads-client.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { loadBrandPricedPopulation, BrandPricesDifferentlyError, type BrandPricingPre } from "./contacted-value.js";
import { priceDealsColumns, type DealsValueResult } from "../lib/deals-value.js";

const router = Router();

/** The brand's column values, computed once per refresh (the Gold snapshot layer caches it). */
export async function computeBrandDealsValue(
  brandId: string,
  headers: DownstreamHeaders,
  pre: BrandPricingPre,
  /**
   * The OFFER grain: only the people served on the offer's campaigns. lead-service's standing is
   * brand-keyed, so a column is the brand's members INTERSECTED with the offer's lead population — a
   * person this offer never worked is not on its board. Omitted → the whole brand (byte-unchanged).
   */
  campaignIds?: string[],
  /** The offer whose Disqualified marks apply (its own or brand-wide); omitted → every mark of the brand. */
  offerId?: string,
): Promise<DealsValueResult> {
  // ONE pipeline figure everywhere (owner 2026-10-21, « On fait tout (toute campaign, tout sales funnels, tout
  // pipes) »; supersedes the 2026-09-26 every-cause board): both columns are priced on the pipeline's own default
  // causes (`DEFAULT_PRICED_CAUSES`, what our pipes caused); a deal that came on its own adds nothing.
  // "Disqualified" is lead-service's MARK beside the standing (v0.83.59), not a standing: a marked person
  // can still stand Interested. The population carries the mark (read once, by the loader, the offer's
  // when offer-scoped), so the card reads $0 `ruled_out` exactly as the pipeline prices that person.
  const [population, interested, won] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { pricedCauses: DEFAULT_PRICED_CAUSES, campaignIds, offerId }),
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

  // At the offer grain a brand member outside the offer's population is not in the offer's column, so
  // `unpricedLeadCount` is always 0 there (the two reads cannot be told apart from a lead-service race).
  const held = new Set(population.persons.map((p) => p.leadId));
  const scoped = (members: Set<string>): Set<string> =>
    campaignIds ? new Set([...members].filter((id) => held.has(id))) : members;

  return priceDealsColumns({
    persons: population.persons,
    paths: population.paths,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    members: { sales_interest: scoped(interested), customer: scoped(won) },
    statedWonAmountUsdByEmail,
    pricedCauses: DEFAULT_PRICED_CAUSES,
  });
}

router.get("/brands/:brandId/deals-value", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  try {
    const channels = await resolveBrandChannels(brandId, headers);
    const [declared] = await Promise.all([fetchDeclaredFunnelsSoft(brandId, headers.orgId), assertBrandHeld(brandId, headers)]);
    const priced = priceOnDeclaredFunnel(declared);
    const result = await servedCached({
      view: "brand-deals-value",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: brandFeatureSlugs(channels).join("+"),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: pricedFingerprint(priced),
        m: "deals-value-v5",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandDealsValue(brandId, headers, { channels, declared }),
    });
    return res.json({ brandId, ...result });
  } catch (error) {
    if (error instanceof BrandHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "brand_has_no_channels", brandId });
    }
    if (error instanceof BrandPricesDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "brand_channels_price_differently", brandId });
    }
    if (error instanceof ContactedValueUnavailableError) return res.status(503).json(contactedValueUnavailableBody(error));
    console.error(`[features-service] Brand deals value error:`, error);
    return res.status(502).json({ error: "Failed to compute brand deals value" });
  }
});

export default router;
