/**
 * A downstream read's campaign scope: one campaign, or the whole family of campaigns that share
 * one identity (see campaign-identity.ts).
 *
 * Every client that used to take `campaignId: string | undefined` now takes this. The
 * single-campaign forms — `undefined`, a bare string, or a one-element list — take the client's
 * ORIGINAL code path byte for byte, so a brand with one campaign per identity reads exactly as it
 * did. Only a genuine multi-member family takes the aggregating path.
 */
export type CampaignFilter = string | string[] | undefined;

/**
 * The single campaign id to send downstream as a filter, or undefined when the scope is a
 * multi-member family (no producer takes a campaign LIST, so those aggregate locally instead).
 */
export function singleCampaignId(filter: CampaignFilter): string | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter === "string") return filter;
  return filter.length === 1 ? filter[0] : undefined;
}

/** The family's members as a lookup, or null when the scope is not a multi-member family. */
export function campaignFamilySet(filter: CampaignFilter): Set<string> | null {
  if (filter === undefined || typeof filter === "string" || filter.length <= 1) return null;
  return new Set(filter);
}

/** Every campaign id in the scope, or `[]` when the scope is the whole brand. */
export function campaignScopeIds(filter: CampaignFilter): string[] {
  if (filter === undefined) return [];
  return typeof filter === "string" ? [filter] : [...filter];
}
