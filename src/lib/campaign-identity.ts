/**
 * A campaign's IDENTITY is (org, brand, offer, leg, acquisition channel) — campaign-service's own
 * key (its `uniq_campaigns_org_brand_offer_leg_channel`, migration 0058). The WORKFLOW is not
 * part of it: selection re-picks a workflow every run, and campaign-service now switches the
 * workflow of the campaign already alive on an identity instead of creating a second campaign.
 *
 * Before it did, so one brand grew 137 stopped rows — one per workflow version — each holding a
 * slice of a history nobody could read as one campaign. Those rows stay: they carry real runs and
 * real costs, keyed on their own campaign id in runs-service. Nothing here rewrites or repoints
 * any of it; this module only decides which campaign ids answer to ONE customer-visible campaign,
 * so the stats surfaces can total them together.
 *
 * EVERY PART IS READ FROM campaign-service, never re-derived. Wave C3 took the retired sales funnel
 * out of the key (campaign-service drops the column); a row that states no leg is a real state,
 * pooled with the other leg-less rows of its (org, brand, offer, channel) exactly as the producer's
 * `coalesce(leg_key, '')` pools them — never placed on a leg it did not state.
 */

import { matchFunnelLegKey } from "./funnel-legs.js";

/** A campaign row as campaign-service serves it, trimmed to the identity + what we display. */
export interface CampaignIdentityRow {
  id: string;
  orgId?: string | null;
  /** The identity's brand. Stored since campaign-service migration 0044; null on a row predating it. */
  brandId?: string | null;
  /** Legacy array the brand used to live in — read ONLY as a fallback for `brandId`. */
  brandIds?: string[] | null;
  featureSlug?: string | null;
  /** Stored since migration 0044; null on a row predating it. */
  acquisitionChannel?: string | null;
  /**
   * The OFFER this campaign sells — one distinct thing the brand sells, owned by brand-service and
   * exposed as a UUID. It is PART of the campaign identity (campaign-service's own
   * `uniq_campaigns_org_brand_offer_leg_channel`), and it is also the grain ABOVE the campaign, read
   * so `offer-scope.ts` can partition a brand's campaigns by it.
   *
   * OPTIONAL because campaign-service ships the column in the same wave and every historical row
   * predates it. Null / absent is a real state — "this campaign states no offer" — and such a
   * campaign belongs to no offer rather than to a default one.
   */
  offerId?: string | null;
  /**
   * The LEG this campaign is bought for — this service's own canonical leg id carried back by
   * campaign-service. PART of the identity key, and read also because a campaign's outcome is its
   * LEG's step (see `lib/learning-phase.ts`). Null / absent is a real state.
   */
  legKey?: string | null;
  /**
   * The SALES FUNNEL this row is a unit of (this service's catalogue id), stamped by campaign-service on every
   * unit of a funnel campaign; null on a campaign predating funnels. What an offer sells through is read off it
   * (`lib/offer-funnel-campaigns.ts`).
   */
  salesFunnelId?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

/**
 * A part the row does not state (an offer or a leg). Pooled together — campaign-service's own
 * unique index keys on `coalesce(offer_id, '')` / `coalesce(leg_key, '')` for exactly that reason —
 * and distinct from every real id, so "states none" stays its own readable state.
 */
const UNSTATED = "\u0000unstated";

/** One identity, and every campaign id that answers to it. */
export interface CampaignIdentity {
  key: string;
  acquisitionChannel: string | null;
  /** Every member, ascending, the live ones first in `liveCampaignIds`. */
  campaignIds: string[];
  liveCampaignIds: string[];
  /**
   * The member a consumer renders the identity's line on: the live campaign when there is one
   * (there is at most one — campaign-service's index enforces it among `ongoing` rows), else the
   * most recently created member. Never a synthesized id.
   */
  representativeId: string;
  /**
   * THE OFFER THIS CAMPAIGN SELLS — the one thing that lets a campaign-scoped read price on the right
   * proposition. A brand selling SEVERAL offers has several sets of conversion rates and several
   * lifetime revenues, and brand-service refuses (409 `SEVERAL_OFFERS`) to guess which one a
   * brand-scoped read means. A campaign sells exactly ONE offer, so a request naming a campaign names
   * the offer transitively — which is the only path available, since `?offerId=` beside `?campaignId=`
   * is a 400 by design.
   *
   * It is part of the identity KEY (campaign-service's own org+brand+offer+leg+channel index), so every
   * member states the same one (or none).
   * `null` when no member states one, which is a real state for every row predating the column, and it
   * keeps today's answer (brand-scoped, one offer resolved by brand-service itself).
   *
   * Deliberately NOT on `CampaignIdentityView`: it shapes which question we ask brand-service, not what
   * we tell a consumer, so no response body moves.
   */
  offerId: string | null;
  /**
   * Every LEG the members state (canonical keys, ascending) — what a campaign-scoped read is priced
   * through since wave C1 (a campaign is offer × leg × channel; its stated funnel is no longer read to
   * price it). Empty when no member states one. Like `offerId`, NOT on `CampaignIdentityView`.
   */
  legKeys: string[];
}

/**
 * The resolved families for one (brand, feature), plus the lookup every caller needs.
 *
 * A campaign we could not place — campaign-service does not know it, or the row predates
 * migration 0044 and states no brand / channel — is its OWN family of one. It is never folded
 * onto another identity on a guess, so the worst case is today's per-campaign-id behaviour.
 */
export interface CampaignFamilies {
  byCampaignId: Map<string, CampaignIdentity>;
  /** Every member of `campaignId`'s family, itself included. `[campaignId]` when unplaceable. */
  familyOf(campaignId: string): string[];
  identityOf(campaignId: string): CampaignIdentity | null;
}

/** `true` when a campaign row is alive — campaign-service's own `ongoing` status. */
function isLive(row: CampaignIdentityRow): boolean {
  return row.status === "ongoing";
}

function brandOf(row: CampaignIdentityRow): string | null {
  return row.brandId ?? row.brandIds?.[0] ?? null;
}

/**
 * The identity key, or null when the row does not state enough of it to be pooled with anything.
 *
 * Null is deliberate: a row with no brand or no acquisition channel is one campaign-service could
 * not police either (its unique index skips exactly those), so pooling it here would invent an
 * identity the owner never asserted.
 */
export function identityKeyOf(row: CampaignIdentityRow): string | null {
  const brandId = brandOf(row);
  const channel = row.acquisitionChannel ?? null;
  if (!brandId || !channel) return null;
  const orgId = row.orgId ?? "";
  const legKey = row.legKey ? (matchFunnelLegKey(row.legKey) ?? row.legKey) : UNSTATED;
  return `${orgId}|${brandId}|${row.offerId ?? UNSTATED}|${legKey}|${channel}`;
}

/** Group campaign rows into identities. Pure — the network read lives in the client below. */
export function buildCampaignFamilies(rows: CampaignIdentityRow[]): CampaignFamilies {
  const byKey = new Map<string, CampaignIdentityRow[]>();
  const unplaceable: CampaignIdentityRow[] = [];

  for (const row of rows) {
    if (!row.id) continue;
    const key = identityKeyOf(row);
    if (key === null) {
      unplaceable.push(row);
      continue;
    }
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const byCampaignId = new Map<string, CampaignIdentity>();

  const register = (key: string, members: CampaignIdentityRow[]): void => {
    const campaignIds = members.map((m) => m.id).sort();
    const liveCampaignIds = members.filter(isLive).map((m) => m.id).sort();
    // The live campaign carries the identity's line. With none, the most recent member does — a
    // deterministic pick (createdAt desc, id asc) so the same family always names the same row.
    const fallback = [...members].sort((a, b) => {
      const at = a.createdAt ?? "";
      const bt = b.createdAt ?? "";
      if (at !== bt) return at < bt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    })[0];
    const identity: CampaignIdentity = {
      key,
      acquisitionChannel: members[0]?.acquisitionChannel ?? null,
      campaignIds,
      liveCampaignIds,
      representativeId: liveCampaignIds[0] ?? fallback.id,
      offerId: members.find((m) => m.offerId)?.offerId ?? null,
      legKeys: [...new Set(members.map((m) => (m.legKey ? matchFunnelLegKey(m.legKey) : null)).filter((k): k is string => k !== null))].sort(),
    };
    for (const id of campaignIds) byCampaignId.set(id, identity);
  };

  for (const [key, members] of byKey) register(key, members);
  // Each unplaceable row is its own family of one, keyed on its own id so it can never collide
  // with a real identity key (which always carries four `|` separators and a channel).
  for (const row of unplaceable) register(`campaign:${row.id}`, [row]);

  return {
    byCampaignId,
    familyOf(campaignId: string): string[] {
      return byCampaignId.get(campaignId)?.campaignIds ?? [campaignId];
    },
    identityOf(campaignId: string): CampaignIdentity | null {
      return byCampaignId.get(campaignId) ?? null;
    },
  };
}

/**
 * The identity a campaign's figures were totalled over, as served to a consumer.
 *
 * It names the FAMILY rather than pointing at one row: `representativeId` is the LIVE campaign when
 * there is one (campaign-service allows at most one alive per identity), so a consumer renders
 * exactly one line per identity while the stopped ancestors it folds in stay visible in
 * `campaignIds`.
 */
export interface CampaignIdentityView {
  key: string;
  acquisitionChannel: string | null;
  campaignIds: string[];
  liveCampaignIds: string[];
  representativeId: string;
}

/** A campaign campaign-service does not know is its own identity of one — never folded onto another. */
export function describeIdentity(identity: CampaignIdentity | null, campaignId: string): CampaignIdentityView {
  if (!identity) {
    return {
      key: `campaign:${campaignId}`,
      acquisitionChannel: null,
      campaignIds: [campaignId],
      liveCampaignIds: [],
      representativeId: campaignId,
    };
  }
  return {
    key: identity.key,
    acquisitionChannel: identity.acquisitionChannel,
    campaignIds: identity.campaignIds,
    liveCampaignIds: identity.liveCampaignIds,
    representativeId: identity.representativeId,
  };
}

/** The families of a brand with no campaign known to campaign-service — every id is its own. */
export const EMPTY_CAMPAIGN_FAMILIES: CampaignFamilies = buildCampaignFamilies([]);
