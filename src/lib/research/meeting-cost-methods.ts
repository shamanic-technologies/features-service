/**
 * EVERY WAY WE COMPUTE A BOOKED MEETING'S COST, SIDE BY SIDE (owner 2026-10-24, MEETING-COST-METHODS-1024: « display
 * horizontal sections like the one you already have, but with every relevant method you can imagine to compute this
 * value over time and as a snapshot »). Pure. One `months` chart per method on the `meeting-cost` study, each title
 * saying MEASURED or EXPECTED and its basis, so two figures never sit under one label:
 *
 *  1. MEASURED average (the study's own chart, unchanged): every reporting brand's spend ÷ every meeting.
 *  2. MEASURED median client: each reporting brand's own spend ÷ its own meetings, then the median across brands (a
 *     brand that spent with no meeting is the most expensive, never dropped: `clientMedian`).
 *  3. EXPECTED, outcome prices (`/public/stats/outcome-prices`): best cold email workflow's cost per positive reply ÷
 *     the best meeting booking workflow's rate + its cost per meeting, on INCURRED mature-else-flash figures. Not
 *     stored anywhere before: recorded day by day from the day this shipped, never back-filled.
 *  4. EXPECTED, the public index (Cold Email Cost Per Meeting Index): the same formula on the leg rankings' money rows,
 *     recorded day by day since Oct 18, 2026. Same formula as 3, NOT the same inputs (prod 2026-10-24: $794 vs $614,
 *     the reply cost read $183 vs $141), so two rows.
 *  5. LEDGER (production cost, every path, `<outcome>-cost-every-path`): a FLOOR while coverage < 95% or days still
 *     computing. A since-inception total with no history: recorded day by day from the day this shipped.
 *
 * The recorded series live in `fleet_index_points` under research slugs (never served by `/public/indexes`).
 */
import { MONTHS, dayText, n, usd } from "./format.js";
import { clientMedian } from "./pipe-series.js";
import { COVERAGE_BAR_PCT } from "./outcome-cost.js";
import type { ResearchChart, ResearchPoint } from "./types.js";
import type { FleetIndexPoint } from "../fleet-indexes.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";
import type { MeetingPriceArithmetic, OutcomePrice } from "../outcome-prices.js";

export const MEETING_COST_INDEX_SLUG = "cold-email-cost-per-meeting";
export const MEETING_COST_OUTCOME_PRICES_SLUG = "research:meeting-cost:outcome-prices";
export const MEETING_COST_LEDGER_SLUG = "research:meeting-cost:ledger";


/** One stored day of a method (a `fleet_index_points` row, the fields a chart reads). */
export interface MethodDay {
  day: string;
  value: number | null;
  status: string;
  outcomes: number;
  unavailableReason: string | null;
  inputs: Record<string, unknown>;
  /** `recorded` = written live that day; `recomputed` = rebuilt later as of the end of that day. */
  basis?: string;
  /** When the row was written (ISO). */
  recordedAt?: string;
}

/** The recorded methods; null = could not be read this build (the row says so). */
export interface MeetingCostMethods {
  outcomePrices: MethodDay[] | null;
  index: MethodDay[] | null;
  ledger: MethodDay[] | null;
}

/** One brand's meetings and spend by month (the study's `ReportingBrand`, restated to keep this module standalone). */
interface BrandMonths {
  meetingsByMonth: Record<string, number>;
  spendByMonth: Record<string, number>;
}

const meetingsText = (k: number) => `${n(k)} ${k === 1 ? "meeting" : "meetings"}`;
const brandsText = (k: number) => `${n(k)} ${k === 1 ? "brand" : "brands"}`;
const monthOf = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;

/** PURE. Today's point replaces any stored row of the same day (the build recorded it, or failed to). */
export function withToday(rows: readonly MethodDay[], today: MethodDay | null): MethodDay[] {
  const past = rows.filter((r) => !today || r.day !== today.day);
  return today ? [...past, today].sort((a, b) => a.day.localeCompare(b.day)) : [...past];
}

/** PURE. The point the build records for the outcome prices' meeting price; null = nothing to record (unreadable). */
export interface MeetingPriceRead {
  maturity: OutcomePrice["maturity"];
  priceUsd: number | null;
  unmeasuredReason: string | null;
  arithmetic: MeetingPriceArithmetic | null;
  legs: ReadonlyArray<{ workflowDynastySlug: string | null; figures: { outcomes: number } | null }>;
}

export function outcomePricesPoint(price: MeetingPriceRead | null): FleetIndexPoint | null {
  if (!price) return null;
  const [reply, meeting] = price.legs;
  const outcomes = Math.min(reply?.figures?.outcomes ?? 0, meeting?.figures?.outcomes ?? 0);
  const a = price.arithmetic;
  return {
    indexSlug: MEETING_COST_OUTCOME_PRICES_SLUG,
    value: price.priceUsd,
    status: price.maturity === "mature" ? "signal" : "noise",
    outcomes: Math.round(outcomes),
    contacted: null,
    workflowDynastySlug: meeting?.workflowDynastySlug ?? null,
    workflowDynastyName: null,
    unavailableReason: price.priceUsd === null ? (price.unmeasuredReason ?? "not_priced") : null,
    inputs: {
      formula: "reply_cost / meeting_rate + meeting_leg_cost",
      costBasis: "incurred",
      maturity: price.maturity,
      replyWorkflowDynastySlug: reply?.workflowDynastySlug ?? null,
      meetingWorkflowDynastySlug: meeting?.workflowDynastySlug ?? null,
      replyCostUsd: a?.replyCostUsd ?? null,
      meetingRatePct: a?.meetingRatePct ?? null,
      meetingLegCostUsd: a?.meetingLegCostUsd ?? null,
      meetingsBooked: meeting?.figures?.outcomes ?? null,
    },
  };
}

/** PURE. The point the build records for the ledger's cost per booked meeting; null = nothing priced to record. */
export function ledgerPoint(unit: OutcomeUnitCost | null, coveragePct: number | null, daysMissing: number, outcomesRequired: number): FleetIndexPoint | null {
  if (!unit || unit.unpricedReason || unit.unitCostUsd === null || unit.unitCostUsd <= 0 || unit.produced <= 0) return null;
  const floor = coveragePct === null || coveragePct < COVERAGE_BAR_PCT || daysMissing > 0;
  return {
    indexSlug: MEETING_COST_LEDGER_SLUG,
    value: unit.unitCostUsd,
    status: floor || unit.produced < outcomesRequired ? "noise" : "signal",
    outcomes: Math.round(unit.produced),
    contacted: null,
    workflowDynastySlug: null,
    workflowDynastyName: null,
    unavailableReason: null,
    inputs: { floor: floor ? "yes" : "no", coveragePct, daysMissing, unpricedInputs: unit.unpricedInputs.length },
  };
}

const DAY_MS = 86_400_000;
const addDays = (day: string, k: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + k * DAY_MS).toISOString().slice(0, 10);
const dayRange = (first: string, last: string): string[] => {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * PURE. The past days the ledger history must (re)compute now: every day from the first day the ledger holds a booked
 * meeting to yesterday, except a recorded day and a recomputed one already written today (UTC). Oldest first.
 */
export function ledgerHistoryDays(firstDay: string | null, today: string, stored: readonly MethodDay[]): string[] {
  if (!firstDay || firstDay >= today) return [];
  const fresh = new Set(stored.filter((r) => r.basis === "recorded" || (r.recordedAt ?? "").slice(0, 10) >= today).map((r) => r.day));
  return dayRange(firstDay, addDays(today, -1)).filter((d) => !fresh.has(d));
}

/** PURE. A past day's ledger point (recomputed): the priced point, else a null one so the day is not asked again. */
export function ledgerHistoryPoint(unit: OutcomeUnitCost | null, coveragePct: number | null, daysMissing: number, outcomesRequired: number): FleetIndexPoint {
  return (
    ledgerPoint(unit, coveragePct, daysMissing, outcomesRequired) ?? {
      indexSlug: MEETING_COST_LEDGER_SLUG,
      value: null,
      status: "noise",
      outcomes: Math.round(unit?.produced ?? 0),
      contacted: null,
      workflowDynastySlug: null,
      workflowDynastyName: null,
      unavailableReason: "no_meeting_priced_yet",
      inputs: { coveragePct, daysMissing },
    }
  );
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * PURE. Method 2, the median client: month bars = the median brand's cost that month (brands that spent that month);
 * the line = the median brand's cost on everything up to that month. A median landing on a brand with spend and no
 * meeting has no point (it reads "no meeting", never a number). Null = no point at all.
 */
export function medianChart(brands: readonly BrandMonths[], months: readonly string[], partial: string | null, outcomesRequired: number): ResearchChart | null {
  const point = (ym: string, med: NonNullable<ReturnType<typeof clientMedian>>, meetings: number, toDate: boolean): ResearchPoint => ({
    label: monthOf(ym),
    value: Number(med.medianUsd!.toFixed(2)),
    display: usd(med.medianUsd!),
    note: `${brandsText(med.clients)} spent${toDate ? " to date" : ""}, ${n(med.clientsWithoutOutcome)} with no meeting · ${meetingsText(meetings)}${ym === partial ? " · month in progress" : ""}`,
    thin: meetings < outcomesRequired,
    ...(ym === partial ? { partial: true } : {}),
  });
  const bars: ResearchPoint[] = [];
  const line: ResearchPoint[] = [];
  for (const m of months) {
    const month = brands.map((b) => ({ spentUsd: b.spendByMonth[m] ?? 0, outcomes: b.meetingsByMonth[m] ?? 0 }));
    const mMed = clientMedian(month);
    const mMeetings = month.filter((c) => c.spentUsd > 0).reduce((a, c) => a + c.outcomes, 0);
    if (mMed && mMed.medianUsd !== null) bars.push(point(m, mMed, mMeetings, false));
    const cum = brands.map((b) => {
      let spentUsd = 0;
      let outcomes = 0;
      for (const [k, v] of Object.entries(b.spendByMonth)) if (k <= m) spentUsd += v;
      for (const [k, v] of Object.entries(b.meetingsByMonth)) if (k <= m) outcomes += v;
      return { spentUsd, outcomes };
    });
    const cMed = clientMedian(cum);
    const cMeetings = cum.filter((c) => c.spentUsd > 0).reduce((a, c) => a + c.outcomes, 0);
    if (cMed && cMed.medianUsd !== null) line.push(point(m, cMed, cMeetings, true));
  }
  if (!bars.length && !line.length) return null;
  return {
    kind: "months",
    title: "Measured, median client: cost per meeting booked by month",
    lowerIsBetter: true,
    points: bars,
    cumulative: { title: "Measured, median client: since inception", points: line },
    note: `Each reporting brand's own spend on cold email and meeting booking divided by its own meetings booked after a positive reply, then the median brand: a $50 brand and a $2,000 brand do not drag it. A brand that spent with no meeting counts as the most expensive; a month whose median brand has no meeting has no bar. Learning below ${meetingsText(outcomesRequired)} behind the figure.`,
  };
}

/** PURE. Method 2's figure today (the line's last point), or why there is none. */
export function medianToday(brands: readonly BrandMonths[]): ReturnType<typeof clientMedian> {
  return clientMedian(
    brands.map((b) => ({
      spentUsd: Object.values(b.spendByMonth).reduce((a, v) => a + v, 0),
      outcomes: Object.values(b.meetingsByMonth).reduce((a, v) => a + v, 0),
    })),
  );
}

function dayPoints(rows: readonly MethodDay[], display: (r: MethodDay) => string, note: (r: MethodDay) => string, thin: (r: MethodDay) => boolean): ResearchPoint[] {
  return rows
    .filter((r) => r.value !== null && Number.isFinite(r.value))
    .map((r) => ({ label: dayText(r.day), value: Number(r.value!.toFixed(2)), display: display(r), note: note(r), thin: thin(r) }));
}

const recomputedText = (r: MethodDay): string => (r.basis === "recomputed" ? " · recomputed as of that day" : "");

const firstDayText = (rows: readonly MethodDay[]) => {
  const first = rows.find((r) => r.value !== null && Number.isFinite(r.value));
  return first ? dayText(first.day) : null;
};

/** PURE. Method 3: the outcome prices' meeting price, day by day from its first recorded day. */
export function outcomePricesChart(rows: readonly MethodDay[]): ResearchChart | null {
  const points = dayPoints(
    rows,
    (r) => usd(r.value!),
    (r) => {
      const reply = num(r.inputs.replyCostUsd);
      const rate = num(r.inputs.meetingRatePct);
      const mb = num(r.inputs.meetingLegCostUsd);
      return reply !== null && rate !== null && mb !== null
        ? `${usd(reply)} per positive reply ÷ ${rate.toFixed(1)}% booked + ${usd(mb)} per meeting · ${meetingsText(num(r.inputs.meetingsBooked) ?? 0)} behind the rate${r.inputs.maturity === "mature" ? "" : " · early (a leg on flash figures)"}${recomputedText(r)}`
        : `${meetingsText(r.outcomes)} behind the rate${recomputedText(r)}`;
    },
    (r) => r.status === "noise",
  );
  if (!points.length) return null;
  return {
    kind: "months",
    title: `Expected, outcome prices: cost per meeting booked, day by day from ${firstDayText(rows)}`,
    lowerIsBetter: true,
    points,
    note: "Our best cold email workflow's cost per positive reply, divided by the share of positive replies our best meeting booking workflow books, plus that workflow's cost per meeting: the price a new client is quoted (outcome prices), on what each workflow incurred, mature figures where a workflow has them. Past days recomputed as of the end of each day (the people, replies, meetings and spend dated by then, the workflows that could run then), recorded live from Oct 24, 2026.",
  };
}

/** PURE. Method 4: the public Cold Email Cost Per Meeting Index, every recorded day. */
export function indexChart(rows: readonly MethodDay[]): ResearchChart | null {
  const points = dayPoints(
    rows,
    (r) => usd(r.value!),
    (r) => {
      const reply = num(r.inputs.interestIndexValue);
      const rate = num(r.inputs.interestToMeetingPct);
      const mb = num(r.inputs.meetingPipeCostPerMeetingUsd);
      return reply !== null && rate !== null && mb !== null
        ? `${usd(reply)} per positive reply ÷ ${rate.toFixed(1)}% booked + ${usd(mb)} per meeting · ${meetingsText(r.outcomes)} behind the rate${recomputedText(r)}`
        : `${meetingsText(r.outcomes)} behind the rate${recomputedText(r)}`;
    },
    (r) => r.status === "noise",
  );
  if (!points.length) return null;
  return {
    kind: "months",
    title: `Expected, public index (Cold Email Cost Per Meeting Index): day by day from ${firstDayText(rows)}`,
    lowerIsBetter: true,
    points,
    note: "The same formula as the outcome prices, on the leg rankings' money rows (the best proven workflow that can still run, else the best available, marked Learning): the figure our landing publishes, recorded live from Oct 18, 2026, earlier days recomputed as of the end of each day.",
  };
}

/** PURE. Method 5: the ledger's production cost per booked meeting, day by day from its first recorded day. */
export function ledgerChart(rows: readonly MethodDay[]): ResearchChart | null {
  const floor = (r: MethodDay) => r.inputs.floor === "yes";
  const points = dayPoints(
    rows,
    (r) => `${floor(r) ? "≥ " : ""}${usd(r.value!)}`,
    (r) => {
      const cov = num(r.inputs.coveragePct);
      const missing = num(r.inputs.daysMissing) ?? 0;
      return `${meetingsText(r.outcomes)} · ${cov === null ? "an unknown share" : `${cov < 10 ? cov.toFixed(1) : Math.round(cov)}%`} of the outcome spend declared${missing > 0 ? ` · ${n(missing)} days still computing` : ""}${floor(r) ? " · a floor" : ""}${recomputedText(r)}`;
    },
    (r) => floor(r) || r.status === "noise",
  );
  if (!points.length) return null;
  return {
    kind: "months",
    title: `Ledger, production cost every path: cost per meeting booked, day by day from ${firstDayText(rows)}`,
    lowerIsBetter: true,
    points,
    note: `Measured on runs-service's ledger since inception (the study "What does a booked meeting cost, every path?"): every client, every path, what each run declared it produced and consumed. A floor (≥) while under ${COVERAGE_BAR_PCT}% of the outcome spend is declared. Each day reads the ledger as of the end of that day (since inception up to it), rolled up with today's rules: past days recomputed, recorded live from Oct 24, 2026.`,
  };
}

/** PURE. One conclusion line per recorded method: its figure today, or why there is none. */
export function methodLines(m: MeetingCostMethods): string[] {
  const last = (rows: MethodDay[] | null) => (rows && rows.length ? rows[rows.length - 1]! : null);
  const op = last(m.outcomePrices);
  const ix = last(m.index);
  const lg = last(m.ledger);
  const out: string[] = [];
  out.push(
    !m.outcomePrices
      ? "Expected, outcome prices: not readable right now."
      : op?.value != null
        ? `Expected, outcome prices: ${usd(op.value)} per meeting booked today (${op.day}).`
        : "Expected, outcome prices: no price today.",
  );
  out.push(
    !m.index
      ? "Expected, public index: not readable right now."
      : ix?.value != null
        ? `Expected, public index: ${usd(ix.value)} per meeting booked on ${ix.day}${op?.value != null && ix.day === op.day ? `, ${usd(Math.abs(op.value - ix.value))} ${op.value > ix.value ? "under" : "over"} the outcome prices: same formula, but each reads its own best workflows' figures` : ""}.`
        : "Expected, public index: no value recorded yet.",
  );
  out.push(
    !m.ledger
      ? "Ledger: not readable right now."
      : lg?.value != null
        ? `Ledger, every path: ${lg.inputs.floor === "yes" ? "at least " : ""}${usd(lg.value)} per meeting booked today (${lg.day})${lg.inputs.floor === "yes" ? ", a floor while the ledger misses part of the spend" : ""}.`
        : "Ledger, every path: no booked meeting priced on the ledger yet.",
  );
  return out;
}
