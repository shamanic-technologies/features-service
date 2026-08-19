/**
 * WHICH CAMPAIGNS SELL ONE OFFER — the only thing this service needs to know about an offer, and the
 * whole of what it may assume about one.
 *
 * An OFFER is one distinct thing a brand sells: its value proposition plus the sales funnels it sells
 * through, with their own conversion rates and lifetime revenue. brand-service owns the entity and
 * exposes it as a UUID; a campaign carries the offer it sells. So the hierarchy is
 * Org > Brand > Offer > Campaign, and an offer sits BETWEEN the brand read and the per-campaign one.
 *
 * ── WHY THE GRAIN IS ANSWERED HERE AND NOT IN THE BROWSER ───────────────────────────────────────
 *
 * An offer routinely holds several campaigns (one per acquisition channel, one per funnel), so a
 * consumer without this grain would have to sum several per-campaign groups and re-divide the ratios.
 * A ratio of sums is not the sum of ratios: the ROI it printed would contradict the same brand's ROI
 * one click away. Same reason `groupBy=campaignId` and `groupBy=workflow` are answered here.
 *
 * ── HOW AN OFFER IS ATTRIBUTED, AND WHAT IS NOT RE-ATTRIBUTED ───────────────────────────────────
 *
 * Neither runs-service nor lead-service carries an offer dimension: what they FROZE at write time is
 * the CAMPAIGN — the `campaignId` on each cost row, and the `campaignId` lead-service stamped on each
 * `leads_campaigns` row at serve time. The campaign IS therefore the frozen link, and this module
 * only decides which campaigns answer to one offer. Not one dollar and not one lead is re-attributed:
 * every figure is computed by the same engine, off the same evidence, with the offer's campaign ids
 * as the scope — exactly what a `?campaignId=` read already does for one campaign.
 *
 * The offer a campaign sells is READ FROM campaign-service, the owner of the campaign row, never
 * inferred — the same posture `campaign-identity.ts` takes for the funnel and the channel. This is
 * NOT the forbidden "read a row's CURRENT value": what that rule bans is inferring a campaign's
 * WORKFLOW from its row, because campaign-service switches the workflow of a campaign that is already
 * alive, so its current workflow mis-attributes everything it spent before the switch. The offer is
 * what the campaign SELLS; it does not switch under a live campaign, and there is no frozen offer tag
 * anywhere else to read instead.
 *
 * ── WHAT DOES NOT RECONCILE, AND WHY THAT IS NOT AN ERROR ───────────────────────────────────────
 *
 * The offer groups do NOT sum to the brand, the same way the per-campaign and per-workflow groups do
 * not. A lead served under two offers' campaigns is ONE lead to the brand and belongs to both offers,
 * and the engine's per-organisation combination is not additive across partitions. A campaign the
 * producer states no offer for is in NO group, and so are its leads and its spend — parking them on an
 * offer would invent an attribution nobody recorded. Both are properties of counting people, not
 * figures to correct.
 *
 * ── NULL IS A TRANSITION STATE AND IT READS AS ONE ──────────────────────────────────────────────
 *
 * `offerId` is OPTIONAL on the campaign row: campaign-service ships it in the same wave, and every
 * historical row predates it. A brand whose campaigns state no offer therefore has NO offers — the
 * grouped read serves `groups: []` and a scoped read 404s naming the reason. That is the honest
 * answer while the producer catches up; answering with the brand's own numbers under an offer's label
 * would be the silent fallback this fleet forbids.
 */
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";

/**
 * A brand's campaigns, partitioned by the offer they sell.
 *
 * `campaignIdsOf` returns the members ASCENDING so a scope is deterministic — the cache key it is
 * folded into must not depend on the order campaign-service happened to serve its rows in.
 */
export interface OfferCampaigns {
  /** Every offer the brand's campaigns state, ascending. Empty when none of them states one. */
  offerIds: string[];
  /** The campaigns selling this offer, ascending. `[]` for an offer no campaign of this brand sells. */
  campaignIdsOf(offerId: string): string[];
  /** The offer a campaign sells, or null when the producer states none. */
  offerIdOf(campaignId: string): string | null;
}

/**
 * A scoped read named an offer no campaign of this brand+feature sells.
 *
 * Its own error type because the route answers it with a 404 and a named reason rather than a 502: an
 * offer with no campaign has no evidence, and there is no number to serve. Distinguishable from a
 * campaign-service OUTAGE, which is fail-loud for the opposite reason — with the partition unreadable
 * we cannot tell an offer's campaigns from the brand's, and answering anyway would print the brand's
 * money under the offer's name.
 */
export class OfferHasNoCampaignsError extends Error {
  constructor(
    readonly offerId: string,
    readonly brandId: string,
    readonly featureSlug: string,
  ) {
    super(
      `no campaign of brand ${brandId} sells offer ${offerId} through ${featureSlug}, so there is nothing to measure for it`,
    );
    this.name = "OfferHasNoCampaignsError";
  }
}

/** PURE: partition campaign rows by the offer each one states. The network read lives below. */
export function buildOfferCampaigns(rows: CampaignIdentityRow[]): OfferCampaigns {
  const byOffer = new Map<string, string[]>();
  const byCampaign = new Map<string, string>();

  for (const row of rows) {
    // A row with no id is not a campaign we can scope anything to; a row with no offer belongs to no
    // offer, and is deliberately in no bucket rather than parked on one.
    if (!row.id || !row.offerId) continue;
    byCampaign.set(row.id, row.offerId);
    const bucket = byOffer.get(row.offerId);
    if (bucket) bucket.push(row.id);
    else byOffer.set(row.offerId, [row.id]);
  }
  for (const ids of byOffer.values()) ids.sort();

  return {
    offerIds: [...byOffer.keys()].sort(),
    campaignIdsOf(offerId: string): string[] {
      return byOffer.get(offerId) ?? [];
    },
    offerIdOf(campaignId: string): string | null {
      return byCampaign.get(campaignId) ?? null;
    },
  };
}

/** The partition for a brand with no campaign campaign-service knows — no offer, no member. */
export const EMPTY_OFFER_CAMPAIGNS: OfferCampaigns = buildOfferCampaigns([]);

/**
 * Read the brand's campaigns and partition them by offer.
 *
 * FAIL-LOUD, unlike the campaign-IDENTITY read next door. The identity read is soft because the
 * families decide how per-campaign figures are TOTALLED, not what any of them is — degrading it costs
 * a coarser grouping of correct numbers. Here the partition IS the answer: with it unreadable, a
 * grouped read has no groups to serve and a scoped one cannot tell the offer's campaigns from the
 * brand's, so the only alternative to failing is printing the brand's money under an offer's label.
 */
export async function fetchOfferCampaigns(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<OfferCampaigns> {
  return buildOfferCampaigns(await fetchBrandCampaignRows(brandId, featureSlug, headers));
}

/**
 * The campaign ids ONE offer is sold through, for a read that narrowed to it.
 *
 * Throws {@link OfferHasNoCampaignsError} rather than returning `[]`: an empty campaign scope reads as
 * BRAND-WIDE everywhere downstream (`singleCampaignId([])` is undefined, and no producer takes an
 * empty filter to mean "nothing"), so returning it would silently widen an offer's question into the
 * brand's — the exact contradiction this grain exists to remove.
 */
export async function resolveOfferCampaignIds(
  offerId: string,
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<string[]> {
  const campaignIds = (await fetchOfferCampaigns(brandId, featureSlug, headers)).campaignIdsOf(offerId);
  if (campaignIds.length === 0) throw new OfferHasNoCampaignsError(offerId, brandId, featureSlug);
  return campaignIds;
}
