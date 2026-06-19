import { fetchWithRetry } from "./fetch-retry.js";

/**
 * human-service is the single source of truth for customer-targeting filter-sets
 * ("audiences"). Wave 2 backfilled every brand-service customer persona into an
 * audience PRESERVING the persona id as the audience id, so `audience.id` ==
 * the old `customerProfileId` and historical run/outcome evidence still joins
 * unchanged.
 *
 * Env is read at CALL time (not module load) so a missing var does not crash
 * boot — the targeting read fails loud only when actually invoked.
 */

/**
 * Targeting filter-set shape, mirrored from the human-service `GET /orgs/audiences`
 * contract (same convention as the locally-mirrored `Goal`/`SalesEconomics` types).
 * Faithful passthrough: features-service does not interpret these fields, it
 * forwards them to the persona-stats consumer (campaign-service → lead-finding).
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

export interface Audience {
  id: string;
  brandId: string;
  name: string;
  status: "active" | "paused" | "archived";
  filters: AudienceFilters | null;
}

/**
 * Fetch the ACTIVE audiences for a brand from human-service. Org-scoped (the
 * caller's x-org-id). The ranking signal (cost/outcome evidence) is already
 * org-scoped, so a cross-org audience would carry zero evidence and never rank —
 * org-scoping the candidate list is functionally equivalent to the old
 * brand-scoped persona read for the actual consumer.
 */
export async function fetchActiveAudiences(
  brandId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<Audience[]> {
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

  const params = new URLSearchParams({ brandId, status: "active" });
  const response = await fetchWithRetry(`${baseUrl}/orgs/audiences?${params}`, {
    headers: reqHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`human-service audiences failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { audiences: Audience[] };
  return data.audiences;
}
