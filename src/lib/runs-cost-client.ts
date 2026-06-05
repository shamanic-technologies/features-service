/**
 * Total run cost (USD cents) for a brand (+ optional campaign), scoped to one feature's
 * workflow lineage. SAME runs-service source as GET /features/:slug/stats
 * systemStats.totalCostInUsdCents — runs-service resolves `featureSlugs` → the feature's
 * workflow lineage server-side, then we sum across the workflow groups.
 *
 * Fail-loud: a swallowed runs error would fake $0 cost → fake "0% cost-of-acquisition /
 * null ROI" business numbers. So any transport / non-OK / malformed response throws and the
 * caller returns 502. This intentionally diverges from /stats's fetchRunsStats (fail-soft to
 * 0) — the revenue path treats cost as a core output, like its leads / economics clients.
 */
export async function fetchRunsCostCents(
  brandId: string,
  campaignId: string | undefined,
  featureSlug: string,
  headers: { orgId: string; userId: string; runId: string; featureSlug?: string },
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
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
    "x-brand-id": brandId,
  };
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetch(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { groups?: Array<{ totalCostInUsdCents: string }> };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  let totalCents = 0;
  for (const group of data.groups) {
    totalCents += Math.round(Number(group.totalCostInUsdCents));
  }
  return totalCents;
}
