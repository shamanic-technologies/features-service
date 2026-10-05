/**
 * WHAT AN OFFER'S PEOPLE ARE WORTH — the Deals-board column values and the contacted-but-not-engaged
 * value, for ONE offer of a brand, across every channel it is sold through.
 *
 *   GET /offers/:offerId/deals-value?brandId=      — `/brands/:brandId/deals-value`, at the offer grain
 *   GET /offers/:offerId/contacted-value?brandId=  — `/brands/:brandId/contacted-value`, at the offer grain
 *
 * Same semantics, same pricing and same body as the brand reads; what narrows is WHO: only the leads
 * served on the offer's campaigns (every channel), read the way `/offers/:offerId/revenue` reads them,
 * priced on the OFFER's declared funnels and LTR (the same `fetchDeclaredFunnelsSoft(…, offerId)` the
 * offer's revenue prices on). So each figure is the one the offer's own revenue read carries:
 *
 *   - Interested = each person at the engine's expected value on every cause, a SUBSET of
 *     `/offers/:offerId/revenue?cause=outreach,other,unstated`'s pipeline.
 *   - Contacted value = what these leads add to `/offers/:offerId/revenue`'s pipeline. The per-(campaign
 *     × workflow) ENTRY RATES are the brand cell's (the one cell every pipeline read prices a contacted
 *     lead on), borrowed as is: a group is one campaign, so its rate applies unchanged to the offer's
 *     leads — and a second computation could price the column off a different number than the pipeline.
 *
 * People do not add across offers: a lead served under two offers is in both offers' populations (it is
 * one person to each), so offer A + offer B can exceed the brand. A brand member no campaign of this
 * offer served is not on the offer's board.
 *
 * An offer no campaign sells is 404 `offer_has_no_channels`, never the brand's numbers. `?pricing=` is
 * accepted and validated like every offer read (no figure here is a cost, so it moves nothing).
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, type DownstreamHeaders } from "./revenue.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { OfferHasNoChannelsError, type OfferChannel } from "../lib/offer-channels.js";
import { resolveRequest, resolveOfferFunnel, OfferChannelsPriceDifferentlyError } from "./offer-economics.js";
import {
  getBrandContactedValue,
  loadBrandPricedPopulation,
  parseContactedValuePage,
  pageContactedValue,
} from "./contacted-value.js";
import { computeBrandDealsValue } from "./deals-value.js";
import { priceContactedLeads, type ContactedValueResult } from "../lib/contacted-value.js";
import type { DealsValueResult } from "../lib/deals-value.js";

const router = Router();

/**
 * The offer's campaign SET in the key (a newly launched campaign moves every figure while no other key
 * part does), hashed: an offer can carry hundreds of campaigns and the key sits in a btree index.
 */
function campaignSetKey(campaignIds: string[]): string {
  return createHash("sha1").update(campaignIds.join("+")).digest("hex").slice(0, 12);
}

/** Why the brand's entry rates could not be borrowed (every lead then reads unpriced, as in the pipeline). */
export type BrandEntryRatesUnavailableReason =
  | "brand_contacted_value_unreadable"
  | "no_economics"
  | "no_client_value"
  | "no_entry_path"
  | "no_entry_rate";

export type OfferContactedValueResult = ContactedValueResult & {
  /** Where `workflows[]` (each group's entry rates) comes from: always the brand's contacted-value cell. */
  entryRatesFrom: "brand";
  brandEntryRatesUnavailableReason: BrandEntryRatesUnavailableReason | null;
};

/** The offer's pricing inputs, read once to key the cache and handed to the compute. */
async function offerPricing(offerId: string, brandId: string, headers: DownstreamHeaders, channels: OfferChannel[]) {
  // Fails loud on several funnels BEFORE the population loader asks the brand-worded question.
  resolveOfferFunnel(offerId, channels);
  const [declared, effective] = await Promise.all([
    fetchDeclaredFunnelsSoft(brandId, headers.orgId, offerId),
    fetchEffectiveEconomics(brandId, headers),
  ]);
  const priced = priceOnDeclaredFunnel(declared, effective);
  return {
    pre: { channels, declared, effective },
    keyParts: {
      decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
      econ: economicsFingerprint(priced.economics),
    },
  };
}

/** PURE-ish. The offer's contacted value: its population and terms, the brand's entry rates. */
export async function computeOfferContactedValue(
  brandId: string,
  headers: DownstreamHeaders,
  pre: Parameters<typeof loadBrandPricedPopulation>[2],
  campaignIds: string[],
): Promise<OfferContactedValueResult> {
  const [population, brandCell] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { campaignIds }),
    // Soft, exactly like the pipeline's own read of this cell (`contactedPricingSoft`): unreadable →
    // no rate, which is what the offer's pipeline prices these leads on too.
    getBrandContactedValue(brandId, headers).catch((err: Error) => {
      console.warn(`[features-service] offer contacted value (brand ${brandId}): brand entry rates unreadable — every lead unpriced: ${err.message}`);
      return null;
    }),
  ]);
  const unavailable: BrandEntryRatesUnavailableReason | null =
    brandCell === null ? "brand_contacted_value_unreadable" : brandCell.unmeasuredReason;
  const result = priceContactedLeads({
    paths: population.paths,
    persons: population.persons,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    entryRatesFrom: unavailable === null ? brandCell!.workflows : null,
  });
  return { ...result, entryRatesFrom: "brand", brandEntryRatesUnavailableReason: unavailable };
}

function offerError(res: import("express").Response, error: unknown, what: string) {
  if (error instanceof OfferHasNoChannelsError) {
    return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
  }
  if (error instanceof OfferChannelsPriceDifferentlyError) {
    return res.status(409).json({ error: error.message, reason: "offer_channels_price_differently", offerId: error.offerId });
  }
  console.error(`[features-service] Offer ${what} error:`, error);
  return res.status(502).json({ error: `Failed to compute offer ${what}` });
}

router.get("/offers/:offerId/deals-value", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, headers, channels, campaignIds, featureSlugs } = resolved;
    const { pre, keyParts } = await offerPricing(offerId, brandId, headers, channels);
    const result = await servedCached<DealsValueResult>({
      view: "offer-deals-value",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        campaigns: campaignSetKey(campaignIds),
        ...keyParts,
        m: "deals-value-v2",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandDealsValue(brandId, headers, pre, campaignIds),
    });
    return res.json({ offerId, brandId, ...result });
  } catch (error) {
    return offerError(res, error, "deals value");
  }
});

router.get("/offers/:offerId/contacted-value", apiKeyAuth, async (req, res) => {
  const page = parseContactedValuePage(req.query as Record<string, unknown>);
  if ("error" in page) return res.status(400).json({ error: page.error });
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, headers, channels, campaignIds, featureSlugs } = resolved;
    const { pre, keyParts } = await offerPricing(offerId, brandId, headers, channels);
    const result = await servedCached<OfferContactedValueResult>({
      view: "offer-contacted-value",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        campaigns: campaignSetKey(campaignIds),
        ...keyParts,
        m: "contacted-value-v3",
      }),
      orgId: headers.orgId,
      compute: () => computeOfferContactedValue(brandId, headers, pre, campaignIds),
    });
    return res.json({ offerId, brandId, ...pageContactedValue(result, page) });
  } catch (error) {
    return offerError(res, error, "contacted value");
  }
});

export default router;
