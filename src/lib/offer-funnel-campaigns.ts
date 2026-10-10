/**
 * HOW AN OFFER SELLS, READ OFF ITS SALES FUNNEL CAMPAIGNS (owner 2026-10-10: a campaign IS a sales funnel).
 *
 * Replaces brand-service's per-offer "selected sales path" (the steps + legs ticked, the accepted channels and
 * the ticked paths), retired with this change: campaign-service stamps every unit of a funnel campaign with its
 * `salesFunnelId` (this service's own catalogue id, the same identity as an offer listing's `combinationKey`), so
 * the legs an offer sells through are the legs of the funnels it runs, and the paths it SELECTED are the funnels
 * whose campaign is on. Pure: the caller reads the campaign rows (it already does).
 */
import type { CampaignIdentityRow } from "./campaign-identity.js";

/** The legs of a sales funnel id (`<leg>@<channel>+<leg>+...`, this service's own format), in order. */
export function salesFunnelLegKeys(salesFunnelId: string): string[] {
  return salesFunnelId
    .split("+")
    .map((part) => part.split("@")[0].trim())
    .filter((k) => k !== "");
}

export interface OfferFunnelSelection {
  /** The legs of every funnel the offer has a campaign on (any status), sorted; `stated` = it has one. */
  salesPath: { stated: boolean; legKeys: string[] | null; statedAt: null };
  /** The funnels whose campaign is ON (`ongoing`); never stated (null keys) when none is. */
  selected: { stated: boolean; combinationKeys: string[] | null; statedAt: null };
}

/**
 * PURE: the offer's funnels off its campaign rows. A brand selling exactly this one offer counts a row that
 * states no offer as its (the rule `offerLegKeys` reads by).
 */
export function offerFunnelSelection(rows: readonly CampaignIdentityRow[], offerId: string, soleOffer = false): OfferFunnelSelection {
  const all = new Set<string>();
  const on = new Set<string>();
  for (const r of rows) {
    const id = typeof r.salesFunnelId === "string" ? r.salesFunnelId.trim() : "";
    if (!id) continue;
    if (r.offerId ? r.offerId !== offerId : !soleOffer) continue;
    all.add(id);
    if (r.status === "ongoing") on.add(id);
  }
  const legKeys = [...new Set([...all].flatMap(salesFunnelLegKeys))].sort();
  return {
    salesPath: all.size > 0 ? { stated: true, legKeys, statedAt: null } : { stated: false, legKeys: null, statedAt: null },
    selected: on.size > 0 ? { stated: true, combinationKeys: [...on].sort(), statedAt: null } : { stated: false, combinationKeys: null, statedAt: null },
  };
}
