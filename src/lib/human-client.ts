import { fetchWithRetry } from "./fetch-retry.js";
import { memoizeInteractive } from "./interactive-memo.js";

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
  /**
   * How many of this audience's people are still contactable — pool members NOT suppressed inside the
   * brand's 3-month re-contact window, as human-service counts them on its own list item. 0 on an
   * audience that has been served out (features-service#1035). Absent from an older producer, so
   * OPTIONAL: an absent count is "not stated", never 0.
   */
  availableToContactCount?: number;
  /**
   * The audience's contactable pool size as human-service counts it (its committed provider's own count
   * snapshot). `availableToContactCount` is a subset of it. OPTIONAL for the same reason: absent is
   * "not stated", never 0.
   */
  sizeCount?: number;
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
      // The brand's audience list moves on the scale of minutes: an interactive view reuses it 30s,
      // re-read behind the answer (fetch-retry.ts `shareForMs`, features-service#1045).
      const response = await fetchWithRetry(`${baseUrl}/orgs/audiences?${params}`, { headers: reqHeaders }, { shareForMs: 30_000 });
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
 * How many people each of a brand's ACTIVE audiences can still be served, keyed by audience id —
 * human-service's own `availableToContactCount`, read off the same list the audience grain
 * enumerates (shared 30s, so it usually costs no extra call).
 *
 * FAIL-SOFT, returning `null` ("we could not read this") with a loud log: the figure only lets a
 * consumer skip an audience it would otherwise probe, so an outage must degrade to probing — never to
 * a 502 on a page whose every other figure is right, and never to a 0 that would read as "exhausted".
 * An audience whose count the producer does not state is ABSENT from the map for the same reason.
 */
export async function fetchActiveAudienceAvailabilitySoft(
  brandId: string,
  headers: AudienceFetchHeaders,
): Promise<Map<string, number> | null> {
  try {
    const audiences = await fetchActiveAudiences(brandId, headers);
    const byId = new Map<string, number>();
    for (const a of audiences) {
      if (typeof a.availableToContactCount === "number" && Number.isFinite(a.availableToContactCount)) {
        byId.set(a.id, a.availableToContactCount);
      }
    }
    return byId;
  } catch (err) {
    console.error(
      `[features-service] audience availability read failed for brand=${brandId} — audience rows state availableToContactCount: null:`,
      err,
    );
    return null;
  }
}

/** One active audience's pool as human-service states it: its size and how many of it can still be served. */
export interface AudiencePool {
  size: number;
  remaining: number;
}

/**
 * The POOL of each of a brand's ACTIVE audiences, keyed by audience id — human-service's own `sizeCount`
 * and `availableToContactCount`, the only numbers that answer "how many people can this audience still be
 * served". (An audience's served-member count minus its contacted count is NOT that: it is the backlog of
 * people served and not yet emailed, which a healthy pipeline drains to 0.)
 *
 * FAIL-SOFT to `null` ("we could not read this") with a loud log, never to a 0 that would read as
 * "exhausted". An audience whose producer states neither figure is ABSENT from the map.
 */
export async function fetchActiveAudiencePoolSoft(
  brandId: string,
  headers: AudienceFetchHeaders,
): Promise<Map<string, AudiencePool> | null> {
  try {
    const audiences = await fetchActiveAudiences(brandId, headers);
    const byId = new Map<string, AudiencePool>();
    for (const a of audiences) {
      const size = a.sizeCount;
      const remaining = a.availableToContactCount;
      if (typeof size === "number" && Number.isFinite(size) && typeof remaining === "number" && Number.isFinite(remaining)) {
        byId.set(a.id, { size, remaining });
      }
    }
    return byId;
  } catch (err) {
    console.error(`[features-service] audience pool read failed for brand=${brandId} — remaining-to-contact reads null:`, err);
    return null;
  }
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

  // The member list moves on the scale of minutes; an interactive view refreshing every few seconds
  // reuses it for 30s (re-read behind the answer), keyed on the org it was asked under.
  return memoizeInteractive(`audience-members|${headers.orgId}|${audienceId}`, 30_000, async () => {
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
  });
}
