/**
 * WHICH SALES FUNNELS AN OFFER IS SOLD THROUGH, and which campaigns carry each one.
 *
 * `offer-channels.ts` partitions a brand's campaigns by (offer × acquisition CHANNEL) — the grain a
 * customer's offer screen reads. This one partitions the same rows by (offer × sales FUNNEL), which is
 * the grain that is about to become the only one at which a RETURN can be computed at all.
 *
 * ── WHY THE FUNNEL, AND WHY NOW ──────────────────────────────────────────────────────────────────
 *
 * The product is moving to ONE CAMPAIGN PER STEP of a funnel. A campaign then buys a single link —
 * a reply, a booked meeting, an attended meeting — so it has a cost per step and NO return of its
 * own: the lifetime revenue sits at the END of the funnel, and attributing it to whichever link
 * happened to be last would wildly overstate that link. The funnel is the smallest scope that spans a
 * whole path from first contact to a paying client, so it is the smallest scope whose money divides
 * into a return.
 *
 * ── THE PARTITION IS THE PRODUCER'S, NEVER INFERRED ─────────────────────────────────────────────
 *
 * A campaign states its own `funnelKey` and campaign-service owns it (its
 * `uniq_campaigns_org_brand_funnel_channel` key, migration 0044). It is never inferred from the goal:
 * `sales_meetings_from_conversation` and `sales_meetings_from_website` both answer to `meetingBooked`,
 * so a goal→funnel inference prints a funnel the campaign never stated.
 *
 * A campaign that states NO funnel — or one this service's catalogue does not know — is in NO funnel
 * row. It is not parked on a default and it is not dropped in silence either: its id rides the
 * response so a reader can see what its money is missing from. Same rule the offer partition applies
 * to a campaign that states no offer.
 *
 * ── WHAT ADDS, AND WHAT DOES NOT ────────────────────────────────────────────────────────────────
 *
 * A campaign belongs to exactly ONE funnel, so MONEY adds across an offer's funnels with nothing
 * counted twice, and Σ funnels + Σ unattributed IS the offer's own spend. PEOPLE do not: one lead
 * worked through two funnels is ONE lead to the offer and belongs to both rows, the same
 * counting-people property every grain in this service already carries. So the rows do not sum on the
 * pipeline half, and the offer read stays the number to trust for "what did this offer do".
 */
import { matchSalesFunnelKey, SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import type { OfferChannel } from "./offer-channels.js";

/** One sales funnel an offer is sold through, and the campaigns carrying it. */
export interface OfferFunnel {
  /** The funnel, canonicalised onto this service's catalogue. */
  funnelKey: SalesFunnelKey;
  /** The funnel's buyer-facing name, from the catalogue. */
  name: string;
  /** The funnel's steps, in order — so a row renders without the consumer knowing the catalogue. */
  steps: string[];
  /** Every campaign of the offer selling through this funnel, ascending. */
  campaignIds: string[];
  /** The acquisition channels this funnel is sold through, ascending by slug. */
  channels: OfferChannel[];
}

/** A brand's campaigns for ONE offer, partitioned by sales funnel. */
export interface OfferFunnelPartition {
  /** The funnels, in the catalogue's canonical order. */
  funnels: OfferFunnel[];
  /**
   * Campaigns of the offer that state no funnel (or one the catalogue does not know), ascending.
   *
   * A real state, never a gap to fill: their spend is in NO funnel row, and it stays in the offer's
   * own total, which narrows by nothing. Surfaced so a reader can see the difference rather than
   * wonder why the rows do not add up to the offer.
   */
  unattributedCampaignIds: string[];
}

/** PURE: partition one offer's campaign rows by sales funnel. The network read lives in the route. */
export function buildOfferFunnels(rows: CampaignIdentityRow[], offerId: string): OfferFunnelPartition {
  const byFunnel = new Map<SalesFunnelKey, Map<string, string[]>>();
  const unattributed: string[] = [];

  for (const row of rows) {
    // Same three exclusions the offer × channel partition makes, for the same reasons: a row with no
    // id cannot be scoped to, a row for another offer is another offer's, and a row with no channel
    // cannot be told from another channel's.
    if (!row.id || row.offerId !== offerId || !row.featureSlug) continue;
    const key = row.funnelKey ? matchSalesFunnelKey(row.funnelKey) : null;
    if (!key) {
      unattributed.push(row.id);
      continue;
    }
    let channels = byFunnel.get(key);
    if (!channels) {
      channels = new Map<string, string[]>();
      byFunnel.set(key, channels);
    }
    const bucket = channels.get(row.featureSlug);
    if (bucket) bucket.push(row.id);
    else channels.set(row.featureSlug, [row.id]);
  }

  const funnels = [...byFunnel.entries()]
    .map(([funnelKey, channelMap]) => {
      const channels: OfferChannel[] = [...channelMap.entries()]
        .map(([featureSlug, campaignIds]) => ({ featureSlug, campaignIds: [...campaignIds].sort() }))
        .sort((a, b) => (a.featureSlug < b.featureSlug ? -1 : a.featureSlug > b.featureSlug ? 1 : 0));
      return {
        funnelKey,
        name: SALES_FUNNELS[funnelKey].name,
        steps: [...SALES_FUNNELS[funnelKey].steps],
        campaignIds: channels.flatMap((c) => c.campaignIds).sort(),
        channels,
      };
    })
    // The catalogue's own order, so the same evidence always renders the same table.
    .sort((a, b) => salesFunnelOrder(a.funnelKey) - salesFunnelOrder(b.funnelKey));

  return { funnels, unattributedCampaignIds: unattributed.sort() };
}

function salesFunnelOrder(key: SalesFunnelKey): number {
  return Object.keys(SALES_FUNNELS).indexOf(key);
}
