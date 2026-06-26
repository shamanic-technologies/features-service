/**
 * Canonical brand(+campaign)+feature ACTUAL spend, decomposed by cost source, from runs-service.
 *
 * "Total spent" on the dashboard is the runs-service ACTUAL spend (only `actual` counts as billable
 * usage — provisioned holds + cancelled reservations are NOT spend). So this client reads
 * `actualCostInUsdCents`, NOT `totalCostInUsdCents` (which includes provisioned holds and is what the
 * old systemStats.totalCostInUsdCents over-reported — the CPC-vs-Total-spent divergence this fixes).
 *
 * Returns ONE coherent block:
 *   - totalSpentCents  = Σ actual across the feature-scoped run population (the canonical "Total spent").
 *   - todaySpentCents  = Σ actual for runs started since 00:00 UTC today.
 *   - sources[]        = per cost-name actual spend + share-of-total, descending — the "top cost
 *                        sources" list + percentages, pre-computed so the dashboard renders verbatim.
 *
 * The total is derived from the SAME per-source rows the dashboard lists, so "Total spent" and the
 * source breakdown are coherent by construction, and any CPC derived from totalSpentCents reconciles
 * with the displayed spend.
 *
 * Fail-loud: a swallowed runs error would fake $0 spend → fake CPC / $0.00 cost. Any transport /
 * non-OK / malformed response throws and the caller returns 502 (mirrors fetchRunsCostCents).
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface SpendSource {
  /** runs-service cost name (the billable line item, e.g. "apollo people-search", "email-send-step-1"). */
  source: string;
  /** Actual spend attributed to this source, USD cents. */
  spentCents: number;
  /** This source's share of totalSpentCents, percent (0–100). 0 when totalSpentCents is 0. */
  sharePct: number;
}

export interface SpendBreakdown {
  totalSpentCents: number;
  todaySpentCents: number;
  sources: SpendSource[];
}

interface RunsCostGroup {
  dimensions?: Record<string, string | null>;
  actualCostInUsdCents: string;
  runCount: number;
}

function buildHeaders(
  apiKey: string,
  brandId: string,
  campaignId: string | undefined,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  if (campaignId) h["x-campaign-id"] = campaignId;
  if (headers.featureSlug) h["x-feature-slug"] = headers.featureSlug;
  return h;
}

async function fetchCostGroups(
  baseUrl: string,
  apiKey: string,
  params: URLSearchParams,
  reqHeaders: Record<string, string>,
): Promise<RunsCostGroup[]> {
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, { headers: reqHeaders });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: RunsCostGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }
  return data.groups;
}

function sumActual(groups: RunsCostGroup[]): number {
  let cents = 0;
  for (const g of groups) cents += Math.round(Number(g.actualCostInUsdCents));
  return cents;
}

/** Start of the current UTC day as an ISO timestamp (for the today-spend filter). */
function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function fetchSpendBreakdown(
  brandId: string,
  campaignId: string | undefined,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
  now: Date = new Date(),
): Promise<SpendBreakdown> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const reqHeaders = buildHeaders(apiKey, brandId, campaignId, headers);

  // By-source (groupBy=costName): the per-line-item actual spend rows. The total is Σ of these,
  // so "Total spent" == sum of the source list the dashboard renders (coherent by construction).
  const sourceParams = new URLSearchParams({ groupBy: "costName", brandId, featureSlugs: featureSlug });
  if (campaignId) sourceParams.set("campaignId", campaignId);

  // Today: the same feature-scoped population restricted to runs started since 00:00 UTC.
  const todayParams = new URLSearchParams({ groupBy: "costName", brandId, featureSlugs: featureSlug, startedAfter: startOfUtcDay(now) });
  if (campaignId) todayParams.set("campaignId", campaignId);

  const [sourceGroups, todayGroups] = await Promise.all([
    fetchCostGroups(baseUrl, apiKey, sourceParams, reqHeaders),
    fetchCostGroups(baseUrl, apiKey, todayParams, reqHeaders),
  ]);

  const totalSpentCents = sumActual(sourceGroups);
  const todaySpentCents = sumActual(todayGroups);

  const sources: SpendSource[] = sourceGroups
    .map((g) => {
      const spentCents = Math.round(Number(g.actualCostInUsdCents));
      return {
        source: g.dimensions?.costName ?? "unknown",
        spentCents,
        sharePct: totalSpentCents > 0 ? (spentCents / totalSpentCents) * 100 : 0,
      };
    })
    .filter((s) => s.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents || a.source.localeCompare(b.source));

  return { totalSpentCents, todaySpentCents, sources };
}
