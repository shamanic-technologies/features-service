/**
 * Canonical brand(+campaign)+feature spend, decomposed by cost source, from runs-service.
 *
 * NAMING CONVENTION (product-owner mandated — total/actual/provisioned, applied service-wide so a
 * field name can never lie about which accounting it carries):
 *   - total…        = COMMITTED = ACTUAL + PROVISIONED (the money already reserved — what the
 *                     dashboard "Total spent" / CPC now show).
 *   - actual…       = actualized / billed spend only (only `actual` counts as billable usage).
 *   - provisioned…  = open provisioned holds only (reserved for scheduled follow-up sends, not yet
 *                     billed; released — net drop — when a hold cancels or actualizes).
 *
 * runs-service `/v1/stats/costs` returns BOTH `totalCostInUsdCents` (committed = actual + provisioned
 * holds) and `actualCostInUsdCents` (billable) per group, so we read both and derive provisioned =
 * total − actual. (Earlier this client read only `actualCostInUsdCents` and mislabelled it
 * `totalSpentCents` — features-service#396; the name now matches the value.)
 *
 * Returns ONE coherent block (each {total,actual,provisioned} triple satisfies total = actual +
 * provisioned, and the top-level totals equal Σ over `sources`):
 *   - {total,actual,provisioned}SpentCents      = Σ over the feature-scoped run population.
 *   - {total,actual,provisioned}SpentTodayCents  = Σ for runs started since 00:00 UTC today.
 *   - sources[]  = per cost-name committed/actual/provisioned spend + committed share-of-total,
 *                  descending — the "top cost sources" list + percentages, pre-computed.
 *
 * The totals are derived from the SAME per-source rows the dashboard lists, so "Total spent" and the
 * source breakdown are coherent by construction, and any CPC derived from these totals reconciles
 * with the displayed spend.
 *
 * Fail-loud: a swallowed runs error would fake $0 spend → fake CPC / $0.00 cost. Any transport /
 * non-OK / malformed response throws and the caller returns 502 (mirrors fetchRunsCostCents).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCents, type Pricing } from "./pricing.js";
import { campaignFamilySet, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";
import { featureSlugsParam, type FeatureScope } from "./feature-scope.js";

export interface SpendSource {
  /** runs-service cost name (the billable line item, e.g. "apollo people-search", "email-send-step-1"). */
  source: string;
  /** Committed spend attributed to this source (actual + provisioned), USD cents. */
  totalSpentCents: number;
  /** Actualized / billed spend attributed to this source, USD cents. */
  actualSpentCents: number;
  /** Open provisioned holds attributed to this source (= total − actual), USD cents. */
  provisionedSpentCents: number;
  /** This source's share of the COMMITTED total (totalSpentCents), percent (0–100). 0 when the committed total is 0. */
  sharePct: number;
}

export interface SpendBreakdown {
  /** COMMITTED total = actual + provisioned (the displayed "Total spent"). */
  totalSpentCents: number;
  /** Actualized / billed spend only. */
  actualSpentCents: number;
  /** Open provisioned holds only (= total − actual). */
  provisionedSpentCents: number;
  /** COMMITTED total for runs started since 00:00 UTC today. */
  totalSpentTodayCents: number;
  /** Actualized / billed spend for runs started since 00:00 UTC today. */
  actualSpentTodayCents: number;
  /** Open provisioned holds for runs started since 00:00 UTC today (= total − actual). */
  provisionedSpentTodayCents: number;
  sources: SpendSource[];
}

interface RunsCostGroup {
  dimensions?: Record<string, string | null>;
  /** COMMITTED = actual + provisioned holds. */
  totalCostInUsdCents: string;
  /** Actualized / billed only. */
  actualCostInUsdCents: string;
  /** Frozen-NET twins (runs#179) — present when NET pricing is requested; read via selectCostCents. */
  netTotalCostInUsdCents?: string;
  netActualCostInUsdCents?: string;
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

/**
 * Σ committed (actual + provisioned holds) and Σ actual (billed) across the groups, USD cents.
 * GROSS reads the gross fields; NET reads runs#179's frozen net twins (fail-loud if absent).
 */
function sumGroups(groups: RunsCostGroup[], pricing: Pricing): { totalCents: number; actualCents: number } {
  let totalCents = 0;
  let actualCents = 0;
  for (const g of groups) {
    totalCents += Math.round(selectCostCents(g, "totalCostInUsdCents", pricing));
    actualCents += Math.round(selectCostCents(g, "actualCostInUsdCents", pricing));
  }
  return { totalCents, actualCents };
}

/**
 * Fold a family's (costName, campaignId) groups back onto costName, keeping only its members.
 *
 * The selector runs HERE, so NET stays fail-loud on a group missing runs#179's frozen net twin —
 * and the folded group carries the selected cents under BOTH the gross and net names, so the
 * caller's later `selectCostCents` reads that same already-selected number on either basis.
 * Returns the groups untouched when the scope is not a multi-member family.
 */
function collapseFamilyGroups(
  groups: RunsCostGroup[],
  family: Set<string> | null,
  pricing: Pricing,
): RunsCostGroup[] {
  if (!family) return groups;
  const byCostName = new Map<string, { total: number; actual: number; runCount: number }>();
  for (const g of groups) {
    const cid = g.dimensions?.campaignId;
    if (!cid || !family.has(cid)) continue;
    const costName = g.dimensions?.costName ?? "unknown";
    const acc = byCostName.get(costName) ?? { total: 0, actual: 0, runCount: 0 };
    acc.total += Math.round(selectCostCents(g, "totalCostInUsdCents", pricing));
    acc.actual += Math.round(selectCostCents(g, "actualCostInUsdCents", pricing));
    acc.runCount += g.runCount ?? 0;
    byCostName.set(costName, acc);
  }
  return [...byCostName].map(([costName, acc]) => ({
    dimensions: { costName },
    totalCostInUsdCents: String(acc.total),
    actualCostInUsdCents: String(acc.actual),
    netTotalCostInUsdCents: String(acc.total),
    netActualCostInUsdCents: String(acc.actual),
    runCount: acc.runCount,
  }));
}

/** Start of the current UTC day as an ISO timestamp (for the today-spend filter). */
function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function fetchSpendBreakdown(
  brandId: string,
  // One campaign, or the family sharing one identity (see campaign-identity.ts). A family
  // co-groups campaignId and re-aggregates by costName here, so the whole family still costs the
  // same TWO runs calls a single campaign does.
  campaignScope: CampaignFilter,
  // ONE channel, or the SET an offer is sold through (lib/feature-scope.ts). runs comma-splits
  // `featureSlugs`, so a multi-channel offer still costs the same TWO calls.
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
  now: Date = new Date(),
  // NET pricing: read runs#179's FROZEN net cents (netTotal/netActual per source) instead of the gross
  // fields (no read-time multiply). GROSS (the default) reads the gross fields → byte-identical. Ratios
  // (sharePct) are unchanged — a share is discount-invariant since numerator + denominator use the same
  // basis. provisioned is derived (net total − net actual == runs' netProvisioned by construction).
  pricing: Pricing = "gross",
): Promise<SpendBreakdown> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const campaignId = singleCampaignId(campaignScope);
  const family = campaignFamilySet(campaignScope);
  const groupBy = family ? "costName,campaignId" : "costName";

  const reqHeaders = buildHeaders(apiKey, brandId, campaignId, headers);

  // By-source (groupBy=costName): the per-line-item rows carrying committed + actual. The totals are
  // Σ of these, so "Total spent" == sum of the source list the dashboard renders (coherent by
  // construction) for each of committed / actual / provisioned.
  const featureSlugs = featureSlugsParam(featureScope);
  const sourceParams = new URLSearchParams({ groupBy, brandId, featureSlugs });
  if (campaignId) sourceParams.set("campaignId", campaignId);

  // Today: the same feature-scoped population restricted to runs started since 00:00 UTC.
  const todayParams = new URLSearchParams({ groupBy, brandId, featureSlugs, startedAfter: startOfUtcDay(now) });
  if (campaignId) todayParams.set("campaignId", campaignId);

  const [rawSourceGroups, rawTodayGroups] = await Promise.all([
    fetchCostGroups(baseUrl, apiKey, sourceParams, reqHeaders),
    fetchCostGroups(baseUrl, apiKey, todayParams, reqHeaders),
  ]);

  // A family's groups arrive split per (costName, campaignId): keep only its members and fold the
  // split back onto costName, so the per-source rows below read exactly as a single campaign's do.
  const sourceGroups = collapseFamilyGroups(rawSourceGroups, family, pricing);
  const todayGroups = collapseFamilyGroups(rawTodayGroups, family, pricing);

  const all = sumGroups(sourceGroups, pricing);
  const today = sumGroups(todayGroups, pricing);

  const sources: SpendSource[] = sourceGroups
    .map((g) => {
      const totalCents = Math.round(selectCostCents(g, "totalCostInUsdCents", pricing));
      const actualCents = Math.round(selectCostCents(g, "actualCostInUsdCents", pricing));
      return {
        source: g.dimensions?.costName ?? "unknown",
        totalSpentCents: totalCents,
        actualSpentCents: actualCents,
        provisionedSpentCents: totalCents - actualCents,
        // Share of the COMMITTED total — coherent with the displayed "Total spent". Discount-invariant:
        // numerator + denominator use the same basis, so the ratio is identical for gross vs net.
        sharePct: all.totalCents > 0 ? (totalCents / all.totalCents) * 100 : 0,
      };
    })
    // A row with committed 0 has actual 0 too (committed ≥ actual ≥ 0), so dropping it preserves the
    // invariant total == Σ sources for all three accountings.
    .filter((s) => s.totalSpentCents > 0)
    .sort((a, b) => b.totalSpentCents - a.totalSpentCents || a.source.localeCompare(b.source));

  return {
    totalSpentCents: all.totalCents,
    actualSpentCents: all.actualCents,
    provisionedSpentCents: all.totalCents - all.actualCents,
    totalSpentTodayCents: today.totalCents,
    actualSpentTodayCents: today.actualCents,
    provisionedSpentTodayCents: today.totalCents - today.actualCents,
    sources,
  };
}
