import { fetchWithRetry } from "./fetch-retry.js";

/**
 * human-service is the single source of truth for customer-targeting filter-sets
 * ("audiences"). An audience's id is the canonical attribution key (`audienceId`)
 * used across runs/outcomes — the backfill preserved ids, so historical evidence
 * joins unchanged.
 *
 * Env is read at CALL time (not module load) so a missing var does not crash
 * boot — the targeting read fails loud only when actually invoked.
 */

/**
 * Targeting filter-set shape, mirrored from the human-service `GET /orgs/audiences`
 * contract (same convention as the locally-mirrored `Goal`/`SalesEconomics` types).
 * Faithful passthrough: features-service does not interpret these fields, it
 * forwards them to the audience-stats consumer (campaign-service → lead-finding).
 */
export interface AudienceFilters {
  titles?: string[];
  seniorities?: string[];
  functions?: string[];
  locationCountries?: string[];
  locationStates?: string[];
  locationCities?: string[];
  companyNames?: string[];
  companyDomains?: string[];
  industries?: string[];
  keywords?: string[];
  employeeMin?: number;
  employeeMax?: number;
  companySizes?: string[];
  revenueRanges?: string[];
  fundingStages?: string[];
  technologies?: string[];
}

export type AudienceStatus = "active" | "paused" | "archived";

export interface Audience {
  id: string;
  brandId: string;
  name: string;
  status: AudienceStatus;
  filters: AudienceFilters | null;
}

interface AudienceFetchHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  featureSlug?: string;
}

function buildAudienceFetchHeaders(brandId: string, headers: AudienceFetchHeaders): Record<string, string> {
  const baseUrl = process.env.HUMAN_SERVICE_URL;
  const apiKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  }
  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;
  return reqHeaders;
}

/**
 * Fetch a brand's audiences from human-service for the given lifecycle statuses.
 * Org-scoped (the caller's x-org-id). The ranking signal (cost/outcome evidence) is
 * already org-scoped, so a cross-org audience would carry zero evidence and never
 * rank — org-scoping the candidate list is functionally equivalent to the old
 * brand-scoped audience read for the actual consumer.
 *
 * human-service `GET /orgs/audiences` accepts a SINGLE `status` filter, so we fetch
 * one request per requested status and merge. An audience has exactly one status, so
 * the merged list never double-counts. Default `["active"]` preserves the historical
 * active-only behavior byte-for-byte (one request, `status=active`).
 */
export async function fetchAudiencesByStatuses(
  brandId: string,
  statuses: AudienceStatus[],
  headers: AudienceFetchHeaders,
): Promise<Audience[]> {
  const baseUrl = process.env.HUMAN_SERVICE_URL;
  if (!baseUrl) {
    throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  }
  const reqHeaders = buildAudienceFetchHeaders(brandId, headers);

  const perStatus = await Promise.all(
    statuses.map(async (status) => {
      const params = new URLSearchParams({ brandId, status });
      const response = await fetchWithRetry(`${baseUrl}/orgs/audiences?${params}`, {
        headers: reqHeaders,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`human-service audiences failed (${response.status}): ${text}`);
      }
      const data = (await response.json()) as { audiences: Audience[] };
      return data.audiences;
    }),
  );

  return perStatus.flat();
}

/**
 * Fetch the ACTIVE audiences for a brand from human-service. Thin wrapper over
 * `fetchAudiencesByStatuses` for the common active-only callers (workflow-projection
 * audience grain, pipeline-activity) — byte-identical to the original single `status=active` read.
 */
export async function fetchActiveAudiences(
  brandId: string,
  headers: AudienceFetchHeaders,
): Promise<Audience[]> {
  return fetchAudiencesByStatuses(brandId, ["active"], headers);
}

/**
 * Fetch the canonical member emails of one audience (people served under it —
 * provenance membership, human-service#42). Paginates to `limit` (max 500/page).
 * These are the recipients whose outcomes are attributed to this audience: the
 * audience-stats outcomes path resolves audience membership READ-TIME from here
 * (NOT from send-time tagging), then reads per-email outcomes from email-gateway.
 */
export async function fetchAudienceMemberEmails(
  audienceId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<string[]> {
  const baseUrl = process.env.HUMAN_SERVICE_URL;
  const apiKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const emails: string[] = [];
  const pageSize = 500;
  let offset = 0;
  // Bounded loop: stop when a page returns fewer than pageSize rows.
  for (;;) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    const response = await fetchWithRetry(`${baseUrl}/orgs/audiences/${audienceId}/members?${params}`, {
      headers: reqHeaders,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`human-service audience members failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { members: Array<{ emailNorm: string | null }>; total: number };
    for (const m of data.members) {
      if (m.emailNorm) emails.push(m.emailNorm);
    }
    if (data.members.length < pageSize) break;
    offset += pageSize;
  }
  return emails;
}
