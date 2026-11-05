/**
 * TEST FIXTURE. lead-service's `GET /orgs/leads?campaignId=` as it answers in prod: a campaign read widens to the
 * campaign's IDENTITY (the campaign-service rows sharing org, brand, offer, leg and channel), so a read through one
 * member returns every member's rows (`fetchSeveralCampaignsLeads` in `lib/leads-client.ts` relies on it,
 * CAMPAIGN-TOTAL-POSREPLY-1106). Route suites mocking lead-service answer a campaign read with this.
 */
import { buildCampaignFamilies, type CampaignIdentityRow } from "./campaign-identity.js";

export function leadServiceCampaignRead<T extends { campaignId?: string | null }>(
  rows: readonly T[],
  campaignRows: readonly unknown[],
  campaignId: string,
): T[] {
  const members = new Set(buildCampaignFamilies(campaignRows as CampaignIdentityRow[]).familyOf(campaignId));
  return rows.filter((r) => r.campaignId != null && members.has(r.campaignId));
}
