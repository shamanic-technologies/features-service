/**
 * A scope's COMMITTED spend per (UTC day, runs service, runs task), with the runs that carried committed cost: what a
 * day's spend bought, action by action (`lib/spend-charts.ts`, SPEND-CHARTS-1019). runs-service
 * `GET /v1/stats/costs/timeseries?groupBy=serviceName,taskName` (org-scoped, runs-service #340): summed over the tasks,
 * a day's money equals the unsplit bucket, so the actions add up to the day's spend to the decimal.
 *
 * The scope is filtered EXACTLY like the dated spend read (`fetchBrandCommittedSpendByDay`): the campaign ids, the
 * feature slugs through `runsFeatureSlugsParam`, and a pipe's own attribution (`pipeRunsScope`). Fails loud.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { campaignScopeIds, type CampaignFilter } from "./campaign-scope.js";
import { pipeRunsScope } from "./pipe-spend-attribution.js";
import { runsFeatureSlugsParam, type FeatureScope } from "./feature-scope.js";
import { isVendorPricing, type Pricing } from "./pricing.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import type { TaskSpendRow } from "./spend-charts.js";

export async function fetchSpendByTaskDay(
  brandId: string,
  campaignScope: CampaignFilter,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
  pricing: Pricing,
): Promise<TaskSpendRow[]> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  if (isVendorPricing(pricing)) throw new Error(`fetchSpendByTaskDay: no billed dated spend on the ${pricing} basis`);
  const field = pricing === "net" ? "netTotalCostInUsdCents" : "totalCostInUsdCents";

  const pipe = pipeRunsScope(campaignScope);
  const ids = campaignScopeIds(pipe.campaignScope);
  const chunks: (string[] | null)[] = [];
  if (ids.length === 0) chunks.push(null);
  for (let i = 0; i < ids.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) chunks.push(ids.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));

  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;

  const out: TaskSpendRow[] = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      interval: "day",
      groupBy: "serviceName,taskName",
      featureSlugs: runsFeatureSlugsParam(featureScope, pipe.releasedOriginSlugs),
      brandId,
    });
    if (chunk) params.set("campaignIds", chunk.join(","));
    const response = await fetchWithRetry(`${url}/v1/stats/costs/timeseries?${params}`, { headers: reqHeaders });
    if (!response.ok) throw new Error(`runs-service /v1/stats/costs/timeseries (by task) failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries (by task) returned no buckets array");
    for (const b of data.buckets) {
      const raw = b[field];
      if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries (by task) bucket missing period");
      if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`runs-service costs/timeseries (by task) bucket missing ${field}`);
      if (typeof b.committedRunCount !== "number") throw new Error("runs-service costs/timeseries (by task) bucket missing committedRunCount");
      const cents = Number(raw);
      if (!Number.isFinite(cents)) throw new Error(`runs-service costs/timeseries (by task) bucket has non-numeric ${field}`);
      out.push({
        date: b.period.slice(0, 10),
        serviceName: typeof b.serviceName === "string" ? b.serviceName : null,
        taskName: typeof b.taskName === "string" ? b.taskName : null,
        spendUsd: cents / 100,
        runs: b.committedRunCount,
      });
    }
  }
  return out;
}
