/**
 * ONE BRAND'S COMMITTED spend, dated by UTC day — the time axis `costEconomics.committedCostUsd`
 * has never had.
 *
 * Reads runs-service `GET /v1/stats/public/costs/timeseries`, the SAME dated-cost endpoint the
 * cross-org trend surfaces use, narrowed to one org + one brand (+ one campaign when the caller is
 * campaign-scoped) and to the feature's workflow lineage. runs documents the reconciliation
 * invariant explicitly — summing the buckets for a filter equals the untimed total from the plain
 * cost aggregation for that same filter — so the LAST cumulative point of a series built on this is
 * the same dollar figure `fetchRunsCostCents` returns for the same basis, and the dated ROI curve
 * terminates exactly on the headline ROI. That is the whole reason this reads the same aggregator instead of estimating a
 * daily shape from anything else.
 *
 * COMMITTED, because this service has exactly ONE spend basis and every money figure derived from
 * run spend rides it (see cost-economics.ts). So this reads `totalCostInUsdCents` — and its FROZEN
 * NET twin `netTotalCostInUsdCents` under `?pricing=net`, exactly like every other cost read here: no
 * read-time discount multiply, no billing call, and a NET request that finds no net twin fails loud
 * rather than quietly charting full price under a discount banner. Reading the billed-only field here
 * would put the ROI chart on a different basis from the ROI card directly above it.
 *
 * The endpoint takes no auth; the api-key is sent for parity with the other runs reads. Fail-loud on
 * transport / non-OK / malformed body — the caller decides whether to degrade (the /revenue Overview
 * wraps it fail-SOFT, because a missing curve must never 502 an Overview whose every other number
 * is correct).
 */

import { fetchWithRetry } from "./fetch-retry.js";
import type { Pricing } from "./pricing.js";
import { singleCampaignId, type CampaignFilter } from "./campaign-scope.js";
import { featureSlugsParam, type FeatureScope } from "./feature-scope.js";

/**
 * @returns Map<YYYY-MM-DD, committed spend in USD for that day>. Days with no runs are ABSENT (runs
 * never fabricates an empty bucket) — a consumer treats an absent day as zero spend, which it is.
 */
export async function fetchBrandCommittedSpendByDay(
  brandId: string,
  campaignScope: CampaignFilter,
  // ONE channel, or the SET an offer is sold through (lib/feature-scope.ts). The timeseries route
  // comma-splits `featureSlugs` exactly as the untimed cost read does, so the sum-equals-total
  // invariant holds across a multi-channel scope too.
  featureScope: FeatureScope,
  headers: { orgId: string },
  pricing: Pricing = "gross",
): Promise<Map<string, number>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    interval: "day",
    featureSlugs: featureSlugsParam(featureScope),
    orgId: headers.orgId,
    brandId,
  });
  // runs takes ONE campaign, never a list — a multi-member identity therefore reads the BRAND's
  // curve (its own superset) rather than a partial one. `?campaignId=` narrows as it does everywhere.
  const campaignId = singleCampaignId(campaignScope);
  if (campaignId) params.set("campaignId", campaignId);

  const response = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, {
    headers: { "x-api-key": apiKey },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `runs-service /v1/stats/public/costs/timeseries failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as {
    buckets?: Array<Record<string, unknown> & { period?: unknown }>;
  };
  if (!Array.isArray(data.buckets)) {
    throw new Error("runs-service costs/timeseries returned no buckets array");
  }

  const field = pricing === "net" ? "netTotalCostInUsdCents" : "totalCostInUsdCents";
  const byDay = new Map<string, number>();
  for (const bucket of data.buckets) {
    if (typeof bucket.period !== "string") {
      throw new Error("runs-service costs/timeseries bucket missing period");
    }
    const raw = bucket[field];
    // NET never silently falls back to GROSS: showing undiscounted money under a discount banner is
    // the exact failure the frozen-net contract exists to prevent.
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new Error(`runs-service costs/timeseries bucket missing ${field}`);
    }
    const cents = Number(raw);
    if (!Number.isFinite(cents)) {
      throw new Error(`runs-service costs/timeseries bucket has non-numeric ${field}`);
    }
    const day = bucket.period.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cents / 100);
  }
  return byDay;
}
