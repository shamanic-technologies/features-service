/**
 * ONE CHOSEN WINDOW OF UTC DAYS, ENDING TODAY — the figures a "last 7 days / last 30 days" card row
 * shows, each as a window TOTAL beside one value PER DAY, so a consumer draws the curve and prints the
 * figure without adding anything up itself (the browser renders served stats, never computes them).
 *
 * Served on the offer and brand revenue reads as `window`, ONLY when `?windowDays=` is asked: an
 * unwindowed read is byte-unchanged (no key, same cache cell).
 *
 * `?windowDays=all` = SINCE INCEPTION (owner 2026-10-03: the Today row states the brand's whole life,
 * no 7/30 switch): the same block, same parts, same composition, over every UTC day from the scope's
 * FIRST dated activity (first email day, first spend day, first reply/visit, first pipeline point) to
 * today. The spend read carries no lower bound, so `spend.totalSpentCents` is everything the brand has
 * committed (setup included); `sinceInception: true` says which kind of window it is.
 *
 * WHAT EACH PART COUNTS, AND WHERE IT IS READ:
 *   - emails — EMAILS (every step), not leads: email-gateway's per-day `emailStats` on the same day
 *     read the `sequences` series rides (`fetchBroadcastEmailsByDay`), the scope's campaigns and
 *     channels. A day is the day the event happened, so a bounce lands on the day it bounced.
 *   - spend — ACTUAL (charged) spend, on the read's pricing basis, dated by runs-service's own day
 *     buckets (run start, UTC). It is the scope's campaigns' spend PLUS the brand's own work no
 *     campaign carries (setting the brand up, notification emails): what was taken from the credit for
 *     this brand, the same composition as `spend.actualSpentTodayCents` on the same read. The
 *     campaign-less part is also stated alone (`brandLevelActualSpentCents`), because an offer of a
 *     brand selling several offers shares it with the others.
 *     Beside it, the COMMITTED twin on the same composition and days: `totalSpentCents` = actual +
 *     the holds still open for runs still working (`provisionedSpentCents`), runs' `total…` field —
 *     what the customer has committed over the window, the figure a "Spent" tile states (owner
 *     2026-10-03). `totalCostPerEmailSentCents` divides THAT total; `costPerEmailSentCents` stays actual.
 *   - recipientsRepliesPositive / recipientsClicked — the body's OWN per-day series (people, first
 *     time each did it) summed over the window's days; an undated one sits on no day and is not in a
 *     window.
 *   - expectedPipeline — the body's headline pipeline, DATED: the engine's own cumulative series
 *     (each organisation steps in at its most advanced dated event), read at the end of each day. Same
 *     basis as `headline.totalPipelineUsd` (the expected pipeline, flash), so its last point IS the
 *     headline whenever every organisation is dated; `undatedPipelineUsd` states the rest otherwise.
 *     Not `roiHistory`'s pipeline leg, which is the REALIZED, mature cohort's.
 *
 * Every total is the sum of its own `daily` values (spend summed in whole cents per day first).
 * Fail-soft per part: a part whose read failed is null with a loud log, never a zero.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { isVendorPricing, type Pricing } from "./pricing.js";
import type { CampaignFilter } from "./campaign-scope.js";
import { campaignScopeIds } from "./campaign-scope.js";
import { featureSlugsParam, type FeatureScope } from "./feature-scope.js";
import { fetchBroadcastEmailsByDay } from "./sequences-client.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import type { SignalSeries, TimeSeriesPoint } from "./revenue-engine.js";

export const WINDOW_DAYS_MIN = 1;
export const WINDOW_DAYS_MAX = 90;

/** The asked window: N days ending today, or `"all"` = since the scope's first activity. */
export type WindowDays = number | "all";

/** `?windowDays=`: absent → undefined (no window); an integer 1..90 → it; `all` → since inception; anything else → null (400). */
export function parseWindowDays(raw: unknown): WindowDays | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === "all") return "all";
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= WINDOW_DAYS_MIN && n <= WINDOW_DAYS_MAX ? n : null;
}

export const WINDOW_DAYS_ERROR = {
  error: `windowDays must be an integer from ${WINDOW_DAYS_MIN} to ${WINDOW_DAYS_MAX}, or all`,
  reason: "window_days_unrecognised",
} as const;

/** The window's UTC days, ascending, the last one being today. */
export function windowDates(now: Date, days: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Every UTC day from `first` (YYYY-MM-DD) to today, ascending; just today when `first` is later or absent. */
export function inceptionDates(now: Date, first: string | null): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = first ? Date.parse(`${first}T00:00:00.000Z`) : NaN;
  const days = Number.isFinite(start) && start < today ? Math.round((today - start) / 86_400_000) + 1 : 1;
  return windowDates(now, days);
}

/** The earliest dated activity across the window's sources (null = none dated). */
export function firstActivityDate(input: {
  emailsByDay: Map<string, { sent: number; delivered: number; bounced: number }> | null;
  spendByDay: WindowSpendByDay | null;
  series: SignalSeries[];
  pipelineTimeSeries: TimeSeriesPoint[];
}): string | null {
  const days: string[] = [];
  if (input.emailsByDay) for (const [d, c] of input.emailsByDay) if (c.sent || c.delivered || c.bounced) days.push(d);
  if (input.spendByDay) {
    const s = input.spendByDay;
    for (const m of [s.scoped, s.brandLevel, s.scopedTotal, s.brandLevelTotal]) for (const [d, c] of m) if (c) days.push(d);
  }
  for (const series of input.series) for (const p of series.daily) if (p.count) days.push(p.date);
  for (const p of input.pipelineTimeSeries) days.push(p.date);
  const valid = days.map((d) => d.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return valid.length ? valid.reduce((a, b) => (b < a ? b : a)) : null;
}

export interface WindowEmailDay {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  /** delivered ÷ sent × 100. Null when nothing was sent, or when delivered exceeds sent (the day's counts contradict). */
  deliveryRatePct: number | null;
}

export interface RevenueWindow {
  days: number;
  sinceInception: boolean;
  startDate: string;
  endDate: string;
  emails: (Omit<WindowEmailDay, "date"> & { daily: WindowEmailDay[] }) | null;
  spend: {
    actualSpentCents: number;
    brandLevelActualSpentCents: number;
    costPerEmailSentCents: number | null;
    totalSpentCents: number;
    provisionedSpentCents: number;
    brandLevelTotalSpentCents: number;
    totalCostPerEmailSentCents: number | null;
    daily: Array<{
      date: string;
      actualSpentCents: number;
      brandLevelActualSpentCents: number;
      totalSpentCents: number;
      provisionedSpentCents: number;
      brandLevelTotalSpentCents: number;
    }>;
  } | null;
  recipientsRepliesPositive: { total: number; daily: Array<{ date: string; count: number }> };
  recipientsClicked: { total: number; daily: Array<{ date: string; count: number }> };
  expectedPipeline: {
    totalPipelineUsd: number;
    undatedPipelineUsd: number;
    daily: Array<{ date: string; cumulativePipelineUsd: number }>;
  } | null;
}

function deliveryRatePct(sent: number, delivered: number): number | null {
  if (sent <= 0 || delivered > sent) return null;
  return (delivered / sent) * 100;
}

/** The runs dated-cost buckets for one filter, split per campaign (null = runs with no campaign). */
async function fetchCampaignSplitDays(
  params: URLSearchParams,
  pricing: Pricing,
): Promise<Array<{ day: string; campaignId: string | null; cents: number; totalCents: number }>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  if (isVendorPricing(pricing)) throw new Error(`revenue window: no charged spend on the ${pricing} basis`);
  params.set("interval", "day");
  params.set("groupBy", "campaignId");
  const response = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`runs-service /v1/stats/public/costs/timeseries failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries returned no buckets array");
  // NET never falls back to GROSS (the frozen-net contract every cost read here keeps).
  const field = pricing === "net" ? "netActualCostInUsdCents" : "actualCostInUsdCents";
  // COMMITTED = actual + open holds (runs' `total…`), on the same basis.
  const totalField = pricing === "net" ? "netTotalCostInUsdCents" : "totalCostInUsdCents";
  const centsOf = (b: Record<string, unknown>, f: string) => {
    const raw = b[f];
    const cents = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
    if (!Number.isFinite(cents)) throw new Error(`runs-service costs/timeseries bucket missing ${f}`);
    return cents;
  };
  return data.buckets.map((b) => {
    if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries bucket missing period");
    const campaignId = typeof b.campaignId === "string" && b.campaignId ? b.campaignId : null;
    return { day: b.period.slice(0, 10), campaignId, cents: centsOf(b, field), totalCents: centsOf(b, totalField) };
  });
}

/**
 * The window's spend per day, in raw cents, in two parts: the scope's campaigns' (on its channels) and
 * the brand's campaign-less work (every channel, and none); each ACTUAL (`scoped`, `brandLevel`) and
 * COMMITTED (`scopedTotal`, `brandLevelTotal`). Fail-loud.
 */
export async function fetchWindowActualSpendByDay(input: {
  brandId: string;
  orgId: string;
  campaignScope: CampaignFilter;
  featureScope: FeatureScope;
  pricing: Pricing;
  /** Absent = no lower bound (since inception). */
  startedAfter?: string;
}): Promise<WindowSpendByDay> {
  const base = () => {
    const p = new URLSearchParams({ orgId: input.orgId, brandId: input.brandId });
    if (input.startedAfter) p.set("startedAfter", input.startedAfter);
    return p;
  };
  const members = campaignScopeIds(input.campaignScope);
  const chunks: string[][] = [];
  for (let i = 0; i < members.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) chunks.push(members.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
  const scopedReads = members.length === 0 ? [undefined] : chunks;
  const [scopedParts, brandWide] = await Promise.all([
    mapWithConcurrency(scopedReads, 6, (chunk) => {
      const p = base();
      p.set("featureSlugs", featureSlugsParam(input.featureScope));
      if (chunk) p.set("campaignIds", chunk.join(","));
      return fetchCampaignSplitDays(p, input.pricing);
    }),
    fetchCampaignSplitDays(base(), input.pricing),
  ]);
  const add = (m: Map<string, number>, day: string, cents: number) => m.set(day, (m.get(day) ?? 0) + cents);
  const scoped = new Map<string, number>();
  const scopedTotal = new Map<string, number>();
  // Campaign rows only: the campaign-less ones are counted ONCE, below, on every channel.
  for (const part of scopedParts) {
    for (const b of part) {
      if (!b.campaignId) continue;
      add(scoped, b.day, b.cents);
      add(scopedTotal, b.day, b.totalCents);
    }
  }
  const brandLevel = new Map<string, number>();
  const brandLevelTotal = new Map<string, number>();
  for (const b of brandWide) {
    if (b.campaignId) continue;
    add(brandLevel, b.day, b.cents);
    add(brandLevelTotal, b.day, b.totalCents);
  }
  return { scoped, brandLevel, scopedTotal, brandLevelTotal };
}

export interface WindowSpendByDay {
  scoped: Map<string, number>;
  brandLevel: Map<string, number>;
  scopedTotal: Map<string, number>;
  brandLevelTotal: Map<string, number>;
}

/** PURE: fold the reads and the body's own series onto the window's days. */
export function buildRevenueWindow(input: {
  dates: string[];
  emailsByDay: Map<string, { sent: number; delivered: number; bounced: number }> | null;
  spendByDay: WindowSpendByDay | null;
  recipientsRepliesPositive: SignalSeries;
  recipientsClicked: SignalSeries;
  totalPipelineUsd: number | null;
  pipelineTimeSeries: TimeSeriesPoint[];
  sinceInception?: boolean;
}): RevenueWindow {
  const { dates } = input;
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  let emails: RevenueWindow["emails"] = null;
  if (input.emailsByDay) {
    const daily = dates.map((date) => {
      const c = input.emailsByDay!.get(date) ?? { sent: 0, delivered: 0, bounced: 0 };
      return { date, sent: c.sent, delivered: c.delivered, bounced: c.bounced, deliveryRatePct: deliveryRatePct(c.sent, c.delivered) };
    });
    const sent = daily.reduce((s, d) => s + d.sent, 0);
    const delivered = daily.reduce((s, d) => s + d.delivered, 0);
    const bounced = daily.reduce((s, d) => s + d.bounced, 0);
    emails = { sent, delivered, bounced, deliveryRatePct: deliveryRatePct(sent, delivered), daily };
  }

  let spend: RevenueWindow["spend"] = null;
  if (input.spendByDay) {
    const s = input.spendByDay;
    const daily = dates.map((date) => {
      const scoped = s.scoped.get(date) ?? 0;
      const brandLevel = s.brandLevel.get(date) ?? 0;
      const scopedTotal = s.scopedTotal.get(date) ?? 0;
      const brandLevelTotal = s.brandLevelTotal.get(date) ?? 0;
      // Rounded ONCE per day on the day's whole spend; the total is the sum of these, exactly.
      const actualSpentCents = Math.round(scoped + brandLevel);
      const totalSpentCents = Math.round(scopedTotal + brandLevelTotal);
      return {
        date,
        actualSpentCents,
        brandLevelActualSpentCents: Math.round(brandLevel),
        totalSpentCents,
        // The day's open holds: committed − actual on the day's rounded figures, so the parts add up.
        provisionedSpentCents: totalSpentCents - actualSpentCents,
        brandLevelTotalSpentCents: Math.round(brandLevelTotal),
      };
    });
    const sum = (k: "actualSpentCents" | "brandLevelActualSpentCents" | "totalSpentCents" | "provisionedSpentCents" | "brandLevelTotalSpentCents") =>
      daily.reduce((acc, d) => acc + d[k], 0);
    const actualSpentCents = sum("actualSpentCents");
    const totalSpentCents = sum("totalSpentCents");
    const sent = emails?.sent ?? null;
    spend = {
      actualSpentCents,
      brandLevelActualSpentCents: sum("brandLevelActualSpentCents"),
      costPerEmailSentCents: sent ? actualSpentCents / sent : null,
      totalSpentCents,
      provisionedSpentCents: sum("provisionedSpentCents"),
      brandLevelTotalSpentCents: sum("brandLevelTotalSpentCents"),
      totalCostPerEmailSentCents: sent ? totalSpentCents / sent : null,
      daily,
    };
  }

  const inWindow = (series: SignalSeries) => {
    const byDate = new Map(series.daily.map((p) => [p.date, p.count] as const));
    const daily = dates.map((date) => ({ date, count: byDate.get(date) ?? 0 }));
    return { total: daily.reduce((s, d) => s + d.count, 0), daily };
  };

  let expectedPipeline: RevenueWindow["expectedPipeline"] = null;
  if (input.totalPipelineUsd !== null) {
    // The engine's series is cumulative and ascending; a day's value is the last point on or before it.
    const points = [...input.pipelineTimeSeries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let i = 0;
    let cumulative = 0;
    const daily = dates.map((date) => {
      while (i < points.length && points[i].date.slice(0, 10) <= date) cumulative = points[i++].cumulativePipelineUsd;
      return { date, cumulativePipelineUsd: cumulative };
    });
    const dated = points.length ? points[points.length - 1].cumulativePipelineUsd : 0;
    expectedPipeline = {
      totalPipelineUsd: input.totalPipelineUsd,
      // Clamped: the dated curve is a subset of the headline, so a negative remainder is float drift.
      undatedPipelineUsd: Math.max(0, input.totalPipelineUsd - dated),
      daily,
    };
  }

  return {
    days: dates.length,
    sinceInception: input.sinceInception ?? false,
    startDate,
    endDate,
    emails,
    spend,
    recipientsRepliesPositive: inWindow(input.recipientsRepliesPositive),
    recipientsClicked: inWindow(input.recipientsClicked),
    expectedPipeline,
  };
}

/** The window for a computed revenue body: reads the two producers (each fail-soft), then folds. */
export async function computeRevenueWindow(input: {
  days: WindowDays;
  brandId: string;
  campaignScope: CampaignFilter;
  featureScope: FeatureScope;
  pricing: Pricing;
  headers: { orgId: string; userId?: string; runId?: string };
  body: {
    headline: { totalPipelineUsd: number | null };
    timeSeries: TimeSeriesPoint[];
    recipientsRepliesPositive: SignalSeries;
    recipientsClicked: SignalSeries;
  };
  now?: Date;
}): Promise<RevenueWindow> {
  const now = input.now ?? new Date();
  const sinceInception = input.days === "all";
  const boundedDates = sinceInception ? null : windowDates(now, input.days as number);
  const startedAfter = boundedDates ? `${boundedDates[0]}T00:00:00.000Z` : undefined;
  const [emailsByDay, spendByDay] = await Promise.all([
    fetchBroadcastEmailsByDay(input.brandId, input.campaignScope, input.featureScope, input.headers).catch((err: Error) => {
      console.error(`[features-service] window emails unreadable for brand ${input.brandId} (window.emails null): ${err.message}`);
      return null;
    }),
    fetchWindowActualSpendByDay({
      brandId: input.brandId,
      orgId: input.headers.orgId,
      campaignScope: input.campaignScope,
      featureScope: input.featureScope,
      pricing: input.pricing,
      startedAfter,
    }).catch((err: Error) => {
      console.error(`[features-service] window spend unreadable for brand ${input.brandId} (window.spend null): ${err.message}`);
      return null;
    }),
  ]);
  const dates =
    boundedDates ??
    inceptionDates(
      now,
      firstActivityDate({
        emailsByDay,
        spendByDay,
        series: [input.body.recipientsRepliesPositive, input.body.recipientsClicked],
        pipelineTimeSeries: input.body.timeSeries,
      }),
    );
  return buildRevenueWindow({
    dates,
    sinceInception,
    emailsByDay,
    spendByDay,
    recipientsRepliesPositive: input.body.recipientsRepliesPositive,
    recipientsClicked: input.body.recipientsClicked,
    totalPipelineUsd: input.body.headline.totalPipelineUsd,
    pipelineTimeSeries: input.body.timeSeries,
  });
}
