/**
 * ACTUAL run spend (USD cents) for a brand (+ optional campaign), scoped to one feature's
 * workflow lineage. Sums `actualCostInUsdCents` (only `actual` counts as billable spend —
 * provisioned holds + cancelled reservations are NOT spend), NOT `totalCostInUsdCents`, so this
 * matches the dashboard's "Total spent" and the per-source breakdown (see spend-client.ts).
 * runs-service resolves `featureSlugs` → the feature's workflow lineage server-side; we sum across
 * the workflow groups.
 *
 * Fail-loud: a swallowed runs error would fake $0 cost → fake "0% cost-of-acquisition /
 * null ROI" business numbers. So any transport / non-OK / malformed response throws and the
 * caller returns 502. This intentionally diverges from /stats's fetchRunsStats (fail-soft to
 * 0) — the revenue path treats cost as a core output, like its leads / economics clients.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCents, type Pricing } from "./pricing.js";

export async function fetchRunsCostCents(
  brandId: string,
  campaignId: string | undefined,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
  // NET pricing: read runs-service's FROZEN net actual-cost (`netActualCostInUsdCents`) instead of the
  // gross `actualCostInUsdCents` (runs#179 freezes each row's discount at write time — no read-time
  // multiply here). GROSS (the default) reads the gross field → byte-identical. Every downstream metric
  // (CAC, ROI, CPC) derives from this, so it comes out net + coherent by construction.
  pricing: Pricing = "gross",
): Promise<number> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  // Mirror /stats: group by workflowSlug, scope to the feature lineage, sum the groups.
  const params = new URLSearchParams({ groupBy: "workflowSlug", brandId, featureSlugs: featureSlug });
  if (campaignId) params.set("campaignId", campaignId);

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  let totalCents = 0;
  for (const group of data.groups) {
    totalCents += Math.round(selectCostCents(group, "actualCostInUsdCents", pricing));
  }
  return totalCents;
}

/**
 * Enumerate the campaignIds that have runs for a brand, scoped to one feature's workflow
 * lineage — the same runs-service source `/stats` uses for its campaignId dimension. Drives
 * GET /features/:slug/revenue?groupBy=campaignId: one group per campaign returned here.
 *
 * Uses `groupBy=campaignId` (vs fetchRunsCostCents's `groupBy=workflowSlug`) purely to read
 * the campaign KEYS — the per-campaign cost is recomputed by the existing fetchRunsCostCents
 * so each group's costEconomics is byte-equal to the standalone campaignId-scoped call.
 *
 * Fail-loud: a swallowed error would silently drop campaigns from the grouped response.
 */
export async function fetchCampaignIdsWithRuns(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<string[]> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ groupBy: "campaignId", brandId, featureSlugs: featureSlug });

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=campaignId) failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { groups?: Array<{ dimensions?: Record<string, string | null> }> };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  const ids = new Set<string>();
  for (const group of data.groups) {
    const campaignId = group.dimensions?.campaignId;
    if (campaignId) ids.add(campaignId);
  }
  return [...ids];
}
