/**
 * The offer's company-lifecycle cell (`lib/company-lifecycle.ts`), read by BOTH surfaces of the Companies page:
 * `GET /offers/:offerId/deals-value?columns=company_lifecycle` (the tabs) and `GET /offers/:offerId/revenue`, whose
 * `organizations[]` lists every organisation this cell places on a rung (`appendListedOrganizations`), so a tab's
 * count and the rows under it are one set. ONE Gold cell, one key: the two reads can never describe different people.
 */
import { createHash } from "node:crypto";
import { fetchLeadsForRevenue, fetchUniboxLifecycleRows } from "./leads-client.js";
import { dedupPersonsByLead } from "./revenue-engine.js";
import { LIFECYCLE_RUNGS } from "./lifecycle-ladder.js";
import { companyLifecycles, type CompanyLifecycleResult } from "./company-lifecycle.js";
import { servedCached, buildScopeKey } from "./view-cache.js";

type Headers = { orgId: string; userId?: string; runId?: string };

/** The offer's campaign SET in a key, hashed (an offer can carry hundreds of campaigns). */
export function campaignSetKey(campaignIds: string[]): string {
  return createHash("sha1").update(campaignIds.join("+")).digest("hex").slice(0, 12);
}

/**
 * The offer's lead population (the read `/offers/:offerId/revenue` groups its organisations on) and lead-service's
 * Unibox lifecycle on EVERY rung, Lead found included. Nothing is priced. Both reads fail loud.
 */
export async function computeOfferCompanyLifecycle(brandId: string, headers: Headers, campaignIds: string[]): Promise<CompanyLifecycleResult> {
  const [persons, rows] = await Promise.all([
    fetchLeadsForRevenue(brandId, campaignIds, headers),
    fetchUniboxLifecycleRows(brandId, LIFECYCLE_RUNGS.map((r) => r.key), headers),
  ]);
  return companyLifecycles({
    persons: dedupPersonsByLead(persons).map((p) => ({ leadId: p.leadId, orgId: p.orgId })),
    rows: rows.map((r) => ({ leadIds: r.leadIds, rung: r.rung })),
  });
}

/** The Gold cell both reads share. */
export function offerCompanyLifecycleCached(args: {
  offerId: string;
  brandId: string;
  headers: Headers;
  campaignIds: string[];
  featureSlugs: string[];
}): Promise<CompanyLifecycleResult> {
  const { offerId, brandId, headers, campaignIds, featureSlugs } = args;
  return servedCached<CompanyLifecycleResult>({
    view: "offer-company-lifecycle",
    scopeKey: buildScopeKey(offerId, {
      orgId: headers.orgId,
      brandId,
      channels: featureSlugs.join("+"),
      campaigns: campaignSetKey(campaignIds),
      m: "company-lifecycle-v1",
    }),
    orgId: headers.orgId,
    compute: () => computeOfferCompanyLifecycle(brandId, headers, campaignIds),
  });
}

/** Every organisationKey the cell places on a rung: what the revenue read must list. */
export const keysOnARung = (r: CompanyLifecycleResult): Set<string> =>
  new Set(r.organizations.filter((o) => o.lifecycle !== null).map((o) => o.organizationKey));
