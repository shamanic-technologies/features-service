import { fetchWithRetry } from "./fetch-retry.js";

/**
 * lead-service's people counts for ONE campaign's scope (`GET /orgs/leads/bucket-counts?campaignId=`, org-scoped):
 * the SAME set its Leads page lists for that campaign (resolved to the campaign identity), counted in PEOPLE.
 * `total` = every lead of the scope (buffered, claimed, served); `counts` = one bucket per engagement step (not
 * exclusive); `people.sent`/`people.delivered` = people an email actually left for / reached. Fails loud (a count
 * that cannot be read is never 0).
 */
export interface LeadBucketCounts {
  total: number;
  counts: Record<string, number>;
  people: { sent: number; delivered: number; interested: number };
}

export async function fetchLeadBucketCounts(
  campaignId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<LeadBucketCounts> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-service-name": "features-service" };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(
    `${url}/orgs/leads/bucket-counts?campaignId=${encodeURIComponent(campaignId)}`,
    { headers: reqHeaders },
    { shareForMs: 15_000 },
  );
  if (!response.ok) throw new Error(`lead-service /orgs/leads/bucket-counts failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as Partial<LeadBucketCounts>;
  if (typeof data.total !== "number" || !data.counts || typeof data.counts !== "object" || !data.people || typeof data.people.delivered !== "number" || typeof data.people.sent !== "number") {
    throw new Error("lead-service /orgs/leads/bucket-counts returned a malformed body");
  }
  return { total: data.total, counts: data.counts as Record<string, number>, people: data.people as LeadBucketCounts["people"] };
}
