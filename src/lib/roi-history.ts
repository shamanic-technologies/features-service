/**
 * RETURN ON SPEND ACROSS A BRAND'S WHOLE LIFE — the dated twin of `costEconomics.roiMultiple`.
 *
 * The Overview's headline ROI answers "is this working?" at one instant. This answers the same
 * question across every day the brand has existed, so a customer can see the return climbing (or
 * not) rather than a raw signal count.
 *
 * BOTH LEGS ARE CUMULATIVE, AND THAT IS THE WHOLE POINT — say it out loud because a period-grain
 * ratio would be a different, far noisier statistic. Spend on a given day buys outcomes that land
 * days or weeks later, so `that day's pipeline ÷ that day's spend` oscillates between 0 and absurd
 * and describes nothing a customer can act on. The cumulative form is the one that converges: each
 * point is "every dollar spent up to this day, against every dollar of pipeline earned up to this
 * day", and its LAST point is — by construction, not by correction — the same ratio the headline
 * reports.
 *
 * THE TWO LEGS COME FROM THE TWO SOURCES THAT ALREADY DATE THEMSELVES, AND NEITHER IS SYNTHESIZED:
 *   - SPEND is dated by runs-service (`/v1/stats/public/costs/timeseries`, one bucket per UTC day,
 *     bucketed by each run's `started_at`). Runs guarantees Σ buckets == the untimed total for the
 *     same filter, so the final cumulative spend equals `costEconomics.actualCostUsd`.
 *   - PIPELINE is dated by the revenue engine's own `timeSeries` — each org steps the cumulative
 *     total up at its most-advanced event date, from the per-lead timestamps email-gateway and
 *     instantly-service supply. Nothing is spread, smoothed or amortised: a chart that quietly
 *     spread spend evenly over time would be inventing the shape of the very thing it claims to show.
 *
 * WHAT IS ABSENT AND WHY. An org whose events carry no timestamp is in the headline total but on no
 * day, so it cannot be placed on this curve — it is reported separately as `undatedPipelineUsd`
 * rather than dropped silently or parked on a fabricated day. `datedPipelineUsd + undatedPipelineUsd
 * === headline.totalPipelineUsd`, so a consumer can always tell how much of the brand's pipeline the
 * curve actually describes.
 *
 * `roiMultiple` is NULL — never 0 — on any day whose cumulative spend is 0 (a day of pipeline before
 * a dollar was ever spent divides by nothing). "We could not measure this" and "the return was zero"
 * are different statements.
 */

import type { TimeSeriesPoint } from "./revenue-engine.js";

/** One UTC calendar day on the brand's return-on-spend curve. Both legs are CUMULATIVE since inception. */
export interface RoiHistoryPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Every dollar of ACTUAL (billed) spend from the brand's first spend up to and including this day. */
  cumulativeSpendUsd: number;
  /** Every dollar of expected pipeline earned by a DATED outcome up to and including this day. */
  cumulativePipelineUsd: number;
  /** cumulativePipelineUsd / cumulativeSpendUsd. NULL when nothing had been spent yet — never 0. */
  roiMultiple: number | null;
}

export interface RoiHistory {
  /** Ascending by date, one entry per day that has spend or a dated outcome. Empty when neither exists. */
  daily: RoiHistoryPoint[];
  /** The curve's final cumulative pipeline — the part of the headline this curve can describe. */
  datedPipelineUsd: number;
  /**
   * Pipeline in the headline total whose outcome carries NO timestamp, so it sits on no day. Reported
   * rather than dropped or dated: `datedPipelineUsd + undatedPipelineUsd === headline.totalPipelineUsd`.
   */
  undatedPipelineUsd: number;
}

/**
 * Fold dated spend and the engine's dated pipeline into one cumulative return-on-spend curve.
 *
 * PURE — no IO, no wall clock. Days come only from the two inputs, so the curve is
 * wall-clock-independent and a re-read on a later day returns the same points.
 *
 * `pipelineTimeSeries` is the engine's ALREADY-cumulative series keyed by ISO timestamp; several
 * points can land on one UTC day, and the day's value is the LAST (highest) of them. A day with
 * spend but no new outcome carries the previous day's pipeline forward — the curve dips, correctly,
 * because more was spent for the same return.
 */
export function buildRoiHistory(
  spendByDayUsd: Map<string, number>,
  pipelineTimeSeries: TimeSeriesPoint[],
  totalPipelineUsd: number | null,
): RoiHistory {
  // Collapse the engine's ISO-stamped cumulative points onto UTC days, keeping each day's LAST value.
  const pipelineByDay = new Map<string, number>();
  for (const point of pipelineTimeSeries) {
    const day = point.date.slice(0, 10);
    const current = pipelineByDay.get(day);
    if (current == null || point.cumulativePipelineUsd > current) {
      pipelineByDay.set(day, point.cumulativePipelineUsd);
    }
  }

  const days = [...new Set([...spendByDayUsd.keys(), ...pipelineByDay.keys()])].sort();

  const daily: RoiHistoryPoint[] = [];
  let cumulativeSpendUsd = 0;
  let cumulativePipelineUsd = 0;
  for (const date of days) {
    cumulativeSpendUsd += spendByDayUsd.get(date) ?? 0;
    // The engine's series is already cumulative — a day with no new outcome carries the last value.
    cumulativePipelineUsd = pipelineByDay.get(date) ?? cumulativePipelineUsd;
    daily.push({
      date,
      cumulativeSpendUsd,
      cumulativePipelineUsd,
      roiMultiple: cumulativeSpendUsd === 0 ? null : cumulativePipelineUsd / cumulativeSpendUsd,
    });
  }

  const datedPipelineUsd = cumulativePipelineUsd;
  // An org with no event date is in the headline but on no day. Clamp at 0: the dated curve is a
  // subset of the headline by construction, so a negative remainder can only be float drift.
  const undatedPipelineUsd =
    totalPipelineUsd == null ? 0 : Math.max(0, totalPipelineUsd - datedPipelineUsd);

  return { daily, datedPipelineUsd, undatedPipelineUsd };
}
