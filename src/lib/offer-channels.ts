/**
 * WHICH ACQUISITION CHANNELS AN OFFER IS SOLD THROUGH, and which campaigns carry each one.
 *
 * `offer-scope.ts` answers the offer question INSIDE one channel: given a feature slug, which of its
 * campaigns sell this offer. That is the right shape for a per-channel read, and it is what every
 * `/features/:slug/...?offerId=` surface uses. It is the wrong shape for the question a customer's
 * offer screen actually asks.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────────────────────────
 *
 * A brand sells ONE offer through SEVERAL acquisition channels at once — a channel IS a feature slug
 * (see the catalogue section of CLAUDE.md), each one funded and paced on its own money, each running
 * its own campaigns against the same offer, the same funnel and the same audiences. "What did this
 * offer return" is therefore a question with several channels in it, while every per-feature read
 * names exactly one and silently answers "what did it return THROUGH THIS ONE CHANNEL".
 *
 * While a brand had one channel the two questions had the same answer. The moment a second channel is
 * funded they diverge, and they diverge SILENTLY: nothing errors, the figures are simply about less
 * than the screen claims.
 *
 * ── WHY THE CONSUMER CANNOT ASSEMBLE IT ─────────────────────────────────────────────────────────
 *
 * It does not own which channels an offer sells through — that lives on the campaign row, here — so
 * it would have to be told them, then ask once per channel and combine. And the combine is not a sum:
 * see `additive vs not` in the offer route's header. The only place the parts can be combined the way
 * they actually combine is where the parts are computed.
 *
 * ── WHAT THIS MODULE ASSUMES, AND WHAT IT DOES NOT ──────────────────────────────────────────────
 *
 * Exactly what `offer-scope.ts` assumes, read one narrowing wider: campaign-service owns the campaign
 * row and states both the `offerId` it sells and the `featureSlug` it runs through. Nothing is
 * inferred, nothing is re-attributed, and a campaign stating no offer belongs to no offer rather than
 * to a default one. The only difference is that the read is NOT narrowed to a feature slug, because
 * the set of slugs is the answer.
 */
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";

/** One acquisition channel an offer is sold through, and the campaigns carrying it. */
export interface OfferChannel {
  /** The channel — a feature slug, this fleet's only name for an acquisition channel. */
  featureSlug: string;
  /** The campaigns of this brand selling this offer through this channel, ascending. */
  campaignIds: string[];
}

/** A brand's campaigns, partitioned by (offer × channel). */
export interface OfferChannelMap {
  /** Every offer any of the brand's campaigns states, ascending. */
  offerIds: string[];
  /** The channels one offer is sold through, ascending by slug. `[]` for an offer it does not sell. */
  channelsOf(offerId: string): OfferChannel[];
}

/**
 * A read named an offer no campaign of this brand sells through any channel.
 *
 * Its own type because the route answers it 404 with a named reason rather than 502: an offer with no
 * campaign has no evidence and there is no number to serve. Distinguishable from a campaign-service
 * OUTAGE, which fails loud for the opposite reason — with the partition unreadable we cannot tell the
 * offer's campaigns from the brand's, and answering anyway would print the brand's money under the
 * offer's name.
 */
export class OfferHasNoChannelsError extends Error {
  constructor(
    readonly offerId: string,
    readonly brandId: string,
  ) {
    super(
      `no campaign of brand ${brandId} sells offer ${offerId} through any acquisition channel, so there is nothing to measure for it`,
    );
    this.name = "OfferHasNoChannelsError";
  }
}

/** PURE: partition campaign rows by (offer × channel). The network read lives below. */
export function buildOfferChannelMap(rows: CampaignIdentityRow[]): OfferChannelMap {
  const byOffer = new Map<string, Map<string, string[]>>();

  for (const row of rows) {
    // A row with no id is not a campaign anything can be scoped to; a row with no offer belongs to no
    // offer; a row with no channel cannot be told from another channel's, and the whole point here is
    // to answer per channel — so all three are deliberately in no bucket rather than parked on one.
    if (!row.id || !row.offerId || !row.featureSlug) continue;
    let channels = byOffer.get(row.offerId);
    if (!channels) {
      channels = new Map<string, string[]>();
      byOffer.set(row.offerId, channels);
    }
    const bucket = channels.get(row.featureSlug);
    if (bucket) bucket.push(row.id);
    else channels.set(row.featureSlug, [row.id]);
  }

  return {
    offerIds: [...byOffer.keys()].sort(),
    channelsOf(offerId: string): OfferChannel[] {
      const channels = byOffer.get(offerId);
      if (!channels) return [];
      return [...channels.entries()]
        .map(([featureSlug, campaignIds]) => ({ featureSlug, campaignIds: [...campaignIds].sort() }))
        .sort((a, b) => (a.featureSlug < b.featureSlug ? -1 : a.featureSlug > b.featureSlug ? 1 : 0));
    },
  };
}

/** The partition for a brand with no campaign campaign-service knows. */
export const EMPTY_OFFER_CHANNEL_MAP: OfferChannelMap = buildOfferChannelMap([]);

/**
 * Read EVERY campaign of the brand — no channel narrowing — and partition by (offer × channel).
 *
 * FAIL-LOUD. The partition IS the answer here: with it unreadable there are no channels to combine
 * and no way to tell the offer's campaigns from the brand's, so the only alternative to failing is
 * printing the brand's money under an offer's label.
 */
export async function fetchOfferChannelMap(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<OfferChannelMap> {
  return buildOfferChannelMap(await fetchBrandCampaignRows(brandId, undefined, headers));
}

/**
 * The channels ONE offer is sold through.
 *
 * Throws {@link OfferHasNoChannelsError} rather than returning `[]`: an empty channel set reads as
 * BRAND-WIDE everywhere downstream (an empty campaign scope is "no filter", not "nothing"), so
 * returning it would silently widen an offer's question into the brand's — the exact contradiction
 * this grain exists to remove.
 */
export async function resolveOfferChannels(
  offerId: string,
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<OfferChannel[]> {
  const channels = (await fetchOfferChannelMap(brandId, headers)).channelsOf(offerId);
  if (channels.length === 0) throw new OfferHasNoChannelsError(offerId, brandId);
  return channels;
}

/** Every campaign of the offer, across every channel, ascending — the scope every figure is computed over. */
export function offerCampaignIds(channels: OfferChannel[]): string[] {
  return channels.flatMap((channel) => channel.campaignIds).sort();
}

/** Every channel the offer is sold through, ascending — the feature scope its money is read over. */
export function offerFeatureSlugs(channels: OfferChannel[]): string[] {
  return channels.map((channel) => channel.featureSlug);
}
