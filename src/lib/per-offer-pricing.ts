/**
 * A BRAND WHOSE CAMPAIGNS SELL SEVERAL OFFERS IS PRICED PERSON BY PERSON (owner 2026-10-09: "Yes fix it",
 * after its Records > Companies page read 0 companies over 8,673 contacts).
 *
 * The brand read of such a brand used to degrade to no pricing (`no_priced_funnel`): one offer's terms
 * under the brand's name would be a guess. Now each contacted person is priced on the OFFER of the
 * campaign that reached them — that offer's own funnels, leg rates and lifetime revenue (stated, else
 * the fleet median) — so every company appears with its own expected value. Never one offer's terms for
 * the whole brand, never an average of offers.
 *
 * Only the brand-scoped read of a several-offer brand takes this path; a single-offer brand, an offer
 * read and a campaign read are byte-unchanged. FAIL-SOFT: an unreadable offer list leaves the brand
 * unpriced exactly as before (logged loud); an offer whose own terms cannot price leaves its people at 0.
 */

import { createHash } from "node:crypto";
import { fetchBrandLegEconomics } from "./brand-leg-economics-client.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { offerLegKeys, fetchPricingFunnels } from "./reading-funnels.js";
import { economicsFingerprint } from "./offer-priced-economics.js";
import { priceOnDeclaredFunnel, type FunnelPricedEconomics } from "./offer-pricing.js";

export interface OfferPricing {
  offerId: string;
  /** Every campaign of the brand selling this offer (every status: a stopped campaign's leads are still its). */
  campaignIds: string[];
  priced: FunnelPricedEconomics;
}

/**
 * The offers of a brand whose campaigns sell MORE THAN ONE offer, each priced on its own terms. Null when
 * the brand's campaigns sell at most one offer (the brand read already prices that offer) or the read
 * failed (logged loud, the brand stays unpriced as before).
 */
export async function fetchPerOfferPricing(brandId: string, orgId: string): Promise<OfferPricing[] | null> {
  try {
    const [legEconomics, rows] = await Promise.all([
      fetchBrandLegEconomics(brandId, orgId),
      fetchBrandCampaignRows(brandId, undefined, { orgId }),
    ]);
    const selling = legEconomics.offers.filter((o) => offerLegKeys(rows, o.offerId).length > 0);
    if (selling.length < 2) return null;
    return await Promise.all(
      selling.map(async (offer) => ({
        offerId: offer.offerId,
        campaignIds: rows.filter((r) => r.offerId === offer.offerId).map((r) => r.id).sort(),
        priced: priceOnDeclaredFunnel(await fetchPricingFunnels(brandId, orgId, offer.offerId, { legEconomics, rows })),
      })),
    );
  } catch (error) {
    console.error(`[features-service] per-offer pricing of brand ${brandId} unavailable (brand stays unpriced): ${(error as Error).message}`);
    return null;
  }
}

/** Cache-key part: every offer's priced economics, so a terms write on any offer lands on a new cell. */
export function perOfferFingerprint(offers: readonly OfferPricing[] | null): string | undefined {
  if (!offers) return undefined;
  const parts = offers.map(
    (o) => `${o.offerId}:${o.campaignIds.join("+")}:${economicsFingerprint({ ...o.priced.economics, pricedFunnelKeys: o.priced.pricedFunnelKeys })}`,
  );
  return createHash("sha1").update(parts.join(",")).digest("hex").slice(0, 12);
}
