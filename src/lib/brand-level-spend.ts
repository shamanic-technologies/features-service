/**
 * THE BRAND'S OWN WORK NO CAMPAIGN CARRIES (setting the brand up, notification emails…) IS PART OF EVERY
 * MONEY FIGURE OF THE OFFER AND BRAND GRAINS, ON ONE BASIS (owner 2026-10-22, ROI-SPENT-SAME-BASIS-1022).
 *
 * Before: the offer's Spent tile (`window.spend`) counted that work in full while its ROI divided only
 * the offer's campaigns' spend, so one page read "$1,102 pipeline, $2,488 spent, ROI 46x" (prod, brand
 * f4d73dab…, offer "Sales-led": $32.31 of campaigns, $2,457 of brand work shared by every offer).
 *
 * THE RULE (owner 2026-10-22, verbatim: "NON LES DEPENSES ECRITES SONT 2K ET win $1K, le ROI DOIT ETRE 0.5
 * NON??"): a scope's return divides the SAME spent figure its Spent tile states, the brand's campaign-less
 * work INCLUDED IN FULL, nothing pro-rated away (no allocation key between offers: every offer of a brand
 * carries all of it, exactly as `window.spend` always stated it).
 *   - BRAND grain: its own feature-filtered read already holds the campaign-less rows of its channels, so
 *     only the rows OUTSIDE them are added (`campaignLessOutsideScope`), never twice.
 *   - OFFER grain: its read is campaign-filtered, so every campaign-less row of the brand is added.
 *   - Brand work is no campaign's outreach waiting for outcomes, so it counts whole on BOTH the flash and
 *     the mature basis (the rule `fetchMatureSpendCents` and `fetchSpendSplit` already apply to it), except
 *     a mature cohort with no spend of its own, which stays `maturing`.
 *
 * Reads (runs-service, fail-loud like every other spend read on these bodies): one cost read grouped by
 * (campaign, feature, cost name), one dated read grouped by campaign, plus, on the brand grain, the dated
 * read of its own channels to take back out what its scope already holds.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { isVendorPricing, runsCostsUrl, selectCostCents, type Pricing } from "./pricing.js";
import { runsFeatureSlugsParam, type FeatureScope } from "./feature-scope.js";
import { campaignLessOutsideScope, type RunsCostGroup, type SpendBreakdown, type SpendSource } from "./spend-client.js";
import type { RunsCostCents } from "./runs-cost-client.js";

export interface BrandLevelSpend {
  /** The brand's WHOLE campaign-less committed spend since inception, USD cents. */
  brandCampaignLessTotalCents: number;
  /** What this scope ADDS to its own read, per cost name, rounded once per name (USD cents). */
  sources: Array<{ source: string; totalCents: number; actualCents: number }>;
  /** Σ sources: what this scope adds to its own lifetime spend. */
  totalCents: number;
  actualCents: number;
  /** What it adds per UTC day (runs' own day buckets), unrounded cents. */
  byDay: Map<string, { totalCents: number; actualCents: number }>;
}

/** PURE. Fold the reads into the scope's added spend. */
export function buildBrandLevelSpend(input: {
  groups: RunsCostGroup[];
  /** Campaign-less spend per day across the brand, and the part of it the scope's own read already holds. */
  campaignLessByDay: Map<string, { totalCents: number; actualCents: number }>;
  heldByDay: Map<string, { totalCents: number; actualCents: number }> | null;
  /** Campaign-scoped (offer) read: every campaign-less row is outside it; else only other features'. */
  campaignScoped: boolean;
  featureSlugs: readonly string[];
  pricing: Pricing;
}): BrandLevelSpend {
  const { pricing } = input;
  let brandCampaignLessTotalCents = 0;
  for (const g of input.groups) if (!g.dimensions?.campaignId) brandCampaignLessTotalCents += selectCostCents(g, "totalCostInUsdCents", pricing);
  const added = new Map<string, { total: number; actual: number }>();
  for (const g of campaignLessOutsideScope(input.groups, input.campaignScoped, input.featureSlugs)) {
    const name = g.dimensions?.costName ?? "unknown";
    const acc = added.get(name) ?? { total: 0, actual: 0 };
    acc.total += selectCostCents(g, "totalCostInUsdCents", pricing);
    acc.actual += selectCostCents(g, "actualCostInUsdCents", pricing);
    added.set(name, acc);
  }
  const sources = [...added]
    .map(([source, v]) => ({ source, totalCents: Math.round(v.total), actualCents: Math.round(v.actual) }))
    .filter((s) => s.totalCents !== 0 || s.actualCents !== 0);
  const byDay = new Map<string, { totalCents: number; actualCents: number }>();
  for (const [day, v] of input.campaignLessByDay) {
    const held = input.heldByDay?.get(day) ?? { totalCents: 0, actualCents: 0 };
    const totalCents = v.totalCents - held.totalCents;
    const actualCents = v.actualCents - held.actualCents;
    if (Math.abs(totalCents) > 1e-9 || Math.abs(actualCents) > 1e-9) byDay.set(day, { totalCents, actualCents });
  }
  return {
    brandCampaignLessTotalCents: Math.round(brandCampaignLessTotalCents),
    sources,
    totalCents: sources.reduce((s, x) => s + x.totalCents, 0),
    actualCents: sources.reduce((s, x) => s + x.actualCents, 0),
    byDay,
  };
}

/** PURE. A scope's own cost plus its brand-level part. */
export function addBrandLevelCost(cost: RunsCostCents, extra: BrandLevelSpend | null): RunsCostCents {
  if (!extra) return cost;
  return { committedCents: cost.committedCents + extra.totalCents, actualCents: cost.actualCents + extra.actualCents };
}

/** PURE. A dated committed spend map (USD per day) plus the brand-level part. */
export function addBrandLevelByDay(byDayUsd: Map<string, number>, extra: BrandLevelSpend | null): Map<string, number> {
  if (!extra) return byDayUsd;
  const out = new Map(byDayUsd);
  for (const [day, v] of extra.byDay) out.set(day, (out.get(day) ?? 0) + v.totalCents / 100);
  return out;
}

function runsEnv() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  return { url, apiKey };
}

/** The brand's cost groups by (campaign, feature, cost name), every channel, since inception. */
async function fetchBrandCostGroups(brandId: string, orgId: string, pricing: Pricing): Promise<RunsCostGroup[]> {
  const { url, apiKey } = runsEnv();
  const params = new URLSearchParams({ groupBy: "campaignId,featureSlug,costName", brandId });
  const response = await fetchWithRetry(runsCostsUrl(url, "org", pricing, params), {
    headers: { "x-api-key": apiKey, "x-org-id": orgId, "x-brand-id": brandId },
  });
  if (!response.ok) throw new Error(`runs-service /v1/stats/costs (brand-level spend) failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { groups?: RunsCostGroup[] };
  if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  return data.groups.filter((g) => g.dimensions?.campaignId !== "__total__");
}

/** The brand's campaign-less spend per UTC day (optionally on some channels only). */
async function fetchCampaignLessByDay(
  brandId: string,
  orgId: string,
  pricing: Pricing,
  featureSlugs?: string,
): Promise<Map<string, { totalCents: number; actualCents: number }>> {
  const { url, apiKey } = runsEnv();
  const params = new URLSearchParams({ interval: "day", groupBy: "campaignId", orgId, brandId });
  if (featureSlugs) params.set("featureSlugs", featureSlugs);
  const response = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) throw new Error(`runs-service /v1/stats/public/costs/timeseries (brand-level spend) failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries returned no buckets array");
  const totalField = pricing === "net" ? "netTotalCostInUsdCents" : "totalCostInUsdCents";
  const actualField = pricing === "net" ? "netActualCostInUsdCents" : "actualCostInUsdCents";
  const out = new Map<string, { totalCents: number; actualCents: number }>();
  for (const b of data.buckets) {
    if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries bucket missing period");
    if (typeof b.campaignId === "string" && b.campaignId) continue;
    const total = Number(b[totalField]);
    const actual = Number(b[actualField]);
    if (!Number.isFinite(total) || !Number.isFinite(actual)) throw new Error(`runs-service costs/timeseries bucket missing ${totalField}/${actualField}`);
    const day = b.period.slice(0, 10);
    const acc = out.get(day) ?? { totalCents: 0, actualCents: 0 };
    acc.totalCents += total;
    acc.actualCents += actual;
    out.set(day, acc);
  }
  return out;
}

/**
 * The brand-level spend a scope carries. `campaignScoped` = the offer grain (every campaign-less row);
 * else the brand grain (the rows its channels' own read does not already hold).
 */
export async function fetchBrandLevelSpend(input: {
  brandId: string;
  orgId: string;
  pricing: Pricing;
  featureScope: FeatureScope;
  campaignScoped: boolean;
}): Promise<BrandLevelSpend> {
  if (isVendorPricing(input.pricing)) throw new Error(`brand-level spend: no billed spend on the ${input.pricing} basis`);
  const slugs = runsFeatureSlugsParam(input.featureScope);
  const [groups, campaignLessByDay, heldByDay] = await Promise.all([
    fetchBrandCostGroups(input.brandId, input.orgId, input.pricing),
    fetchCampaignLessByDay(input.brandId, input.orgId, input.pricing),
    input.campaignScoped ? Promise.resolve(null) : fetchCampaignLessByDay(input.brandId, input.orgId, input.pricing, slugs),
  ]);
  return buildBrandLevelSpend({
    groups,
    campaignLessByDay,
    heldByDay,
    campaignScoped: input.campaignScoped,
    featureSlugs: slugs.split(","),
    pricing: input.pricing,
  });
}

/** What a spend block states about the brand-level part it carries (offer and brand grains). */
export interface BrandLevelSpendBlock {
  /** The brand's whole campaign-less committed spend since inception, USD cents. */
  brandCampaignLessTotalSpentCents: number;
  /** The part of spend.totalSpentCents / actualSpentCents this read adds for it. */
  totalSpentCents: number;
  actualSpentCents: number;
}

/**
 * PURE. A scope's spend breakdown plus its brand-level part: lifetime totals and per-source rows (Σ sources
 * stays the total), and today's spend from the same dated buckets. Replaces `fetchSpendBreakdown`'s old
 * whole-brand `brandLevelToday` add.
 */
export function withBrandLevelBreakdown(breakdown: SpendBreakdown, extra: BrandLevelSpend | null, now: Date = new Date()): SpendBreakdown {
  // Nothing to add (a brand with no campaign-less work): byte-identical to the scope's own read.
  if (!extra || (extra.totalCents === 0 && extra.actualCents === 0 && extra.byDay.size === 0)) return breakdown;
  const byName = new Map(breakdown.sources.map((s) => [s.source, { total: s.totalSpentCents, actual: s.actualSpentCents }] as const));
  for (const s of extra.sources) {
    const acc = byName.get(s.source) ?? { total: 0, actual: 0 };
    byName.set(s.source, { total: acc.total + s.totalCents, actual: acc.actual + s.actualCents });
  }
  const totalSpentCents = breakdown.totalSpentCents + extra.totalCents;
  const actualSpentCents = breakdown.actualSpentCents + extra.actualCents;
  const sources: SpendSource[] = [...byName]
    .map(([source, v]) => ({
      source,
      totalSpentCents: v.total,
      actualSpentCents: v.actual,
      provisionedSpentCents: v.total - v.actual,
      sharePct: totalSpentCents > 0 ? (v.total / totalSpentCents) * 100 : 0,
    }))
    .filter((s) => s.totalSpentCents > 0)
    .sort((a, b) => b.totalSpentCents - a.totalSpentCents || a.source.localeCompare(b.source));
  const today = now.toISOString().slice(0, 10);
  const todayExtra = extra.byDay.get(today) ?? { totalCents: 0, actualCents: 0 };
  const totalSpentTodayCents = breakdown.totalSpentTodayCents + Math.round(todayExtra.totalCents);
  const actualSpentTodayCents = breakdown.actualSpentTodayCents + Math.round(todayExtra.actualCents);
  return {
    totalSpentCents,
    actualSpentCents,
    provisionedSpentCents: totalSpentCents - actualSpentCents,
    totalSpentTodayCents,
    actualSpentTodayCents,
    provisionedSpentTodayCents: totalSpentTodayCents - actualSpentTodayCents,
    sources,
    brandLevel: brandLevelBlock(extra),
  };
}

/** PURE. The block a body states about its brand-level part. */
export function brandLevelBlock(extra: BrandLevelSpend): BrandLevelSpendBlock {
  return {
    brandCampaignLessTotalSpentCents: extra.brandCampaignLessTotalCents,
    totalSpentCents: extra.totalCents,
    actualSpentCents: extra.actualCents,
  };
}
