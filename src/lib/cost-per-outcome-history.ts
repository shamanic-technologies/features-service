/**
 * WHAT ONE OUTCOME HAS COST THIS SCOPE, DAY BY DAY — the dated twin of the cost-per-outcome the
 * `outcomes` block already states, and the curve a customer reads to answer "is this getting cheaper".
 *
 * The Overview could say what an outcome costs RIGHT NOW and nothing about its trajectory. The two
 * ingredients were both already on the body and could not be joined by anybody: `roiHistory` carries
 * the dated spend, the per-signal series carry the dated driver counts, and a consumer dividing one
 * into the other in the browser is the client-computed statistic this service exists to prevent. It
 * is not a style objection — an outcome carrying NO timestamp is in the scope's total while sitting
 * on no day, so a browser-side cumulative sum under-counts the denominator and the curve's last point
 * stops agreeing with the figure printed directly above it.
 *
 * ── BOTH LEGS ARE CUMULATIVE, FOR THE REASON `roiHistory` STATES ─────────────────────────────────
 *
 * Spend on a day buys outcomes that land days or weeks later, so `that day's spend ÷ that day's
 * outcomes` oscillates between 0 and absurd and describes nothing. The cumulative form is the one
 * that converges, and its LAST point is the scope's own cost per outcome rather than a second opinion
 * about it.
 *
 * ── THE OUTCOME IS THE SCOPE'S OWN LEG'S STEP, AND THIS SERVICE NAMES IT ─────────────────────────
 *
 * Never the driver signal under another name. The count is the observed driver walked forward through
 * the funnel's own declared rates — the byte-same `rateFromDriver` `learningPhase` counts its
 * outcomes with, resolved ONCE by the same leader resolution, so the curve and the verdict beside it
 * can never be denominated in two different things. `outcomeObserved` says which a consumer is
 * reading: an ENTRY leg's count is a raw OBSERVATION (rate 1), a deeper leg's is fractional.
 *
 * ── WHAT IT RECONCILES WITH, AND TO WHAT PRECISION (measured, not assumed) ───────────────────────
 *
 * Both legs are the scope's OWN totals: the spend is runs' dated COMMITTED buckets — the same basis
 * `outcomes.committedSpentCents` rides — and the outcomes are the same deduped leads
 * `outcomes.recipientsClicked` / `recipientsRepliesPositive` count. So for an ENTRY leg the final
 * point IS `outcomes.cpcCents / 100` (or `cpprCents / 100`), and for a deeper leg it is that figure
 * divided by the leg's own rate. Measured in prod 2026-09-17 on brand `9546c4b2…` / campaign
 * `31df7683…` (leg `start_to_website_visit`, 31 clicks, all dated): the dated buckets sum to
 * **$247.193125** against the untimed total's **$247.18** — runs returns fractional cents per group
 * and each grouping rounds once, so the last point reads **$7.9740** against a served **$7.9735**, a
 * 0.006% gap that renders as the same `$7.97`. That is the identical sub-cent property `roiHistory`'s
 * terminal ROI carries against `costEconomics.roiMultiple`; it is stated here rather than claimed
 * away, and it is NOT corrected — flooring one leg onto the other's rounding would be a fabrication.
 *
 * ── WHAT IS ABSENT, AND WHY IT IS REPORTED RATHER THAN FOLDED IN ─────────────────────────────────
 *
 * An outcome whose signal carries no timestamp cannot be placed on a day, so it is stated separately
 * as `undatedOutcomes` — the same treatment `roiHistory` gives `undatedPipelineUsd`, and the reason a
 * consumer can always tell how much of the scope the curve describes
 * (`datedOutcomes + undatedOutcomes` is the scope's whole count). Dating it would invent a day;
 * dropping it silently would leave the final point unexplainable.
 *
 * `costPerOutcomeUsd` is NULL — never 0 — on any day whose cumulative outcomes or cumulative spend is
 * still 0. A scope that has spent and produced nothing has no cost per outcome yet, and a $0 there
 * would say its outcomes were free. "We could not measure this" and "this cost nothing" are different
 * statements, and a consumer renders them differently.
 *
 * (features-service#980.)
 */

import type { ChannelStepDef } from "./acquisition-channels.js";
import type { LegDriver } from "./leg-outcome.js";
import type { SignalSeries } from "./revenue-engine.js";

/**
 * The terms one outcome of this scope is counted and priced on. Resolved ONCE, by the leader
 * resolution `learningPhase` uses, and shared by every dated curve denominated in that outcome — the
 * cost-per-outcome curve here and the conversion-rate curve in `conversion-rate-history.ts`. One
 * resolution, so two curves on one screen can never be denominated in two different steps.
 */
export interface ScopeOutcomeTerms {
  /** The leg the scope is bought for, canonical. */
  legKey: string;
  /** The step the counts below are denominated in — the leg's OWN `toStep`. */
  outcomeStep: ChannelStepDef;
  /** Which observed signal the funnel is entered through. */
  driver: LegDriver;
  /** P(the leg's step | one driver signal). Never null here: an unpriceable leg gets no curve at all. */
  rateFromDriver: number;
  /** TRUE ⟺ the count is a raw OBSERVATION (an entry leg) rather than walked from the driver. */
  outcomeObserved: boolean;
}

/** One UTC calendar day of the curve. BOTH legs are CUMULATIVE since the scope's first day. */
export interface CostPerOutcomeHistoryPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Every dollar of COMMITTED spend from the scope's first spend up to and including this day. */
  cumulativeSpendUsd: number;
  /** Every outcome of this leg's step DATED up to and including this day. Fractional on a deeper leg. */
  cumulativeOutcomes: number;
  /** cumulativeSpendUsd / cumulativeOutcomes. NULL when either is still 0 — never 0. */
  costPerOutcomeUsd: number | null;
}

/** WHAT ONE OUTCOME HAS COST, ACROSS THE SCOPE'S LIFE — named, dated, and divided by nobody. */
export interface CostPerOutcomeHistory {
  /** The step every count here is denominated in — this service's answer, not the caller's. */
  outcomeStep: ChannelStepDef;
  /** The leg that step closes, canonical. */
  legKey: string;
  /** TRUE ⟺ the counts are raw OBSERVATIONS rather than walked forward through the funnel's rates. */
  outcomeObserved: boolean;
  /** Ascending, one entry per day that has spend or a dated outcome. Empty when the scope has neither. */
  daily: CostPerOutcomeHistoryPoint[];
  /** The curve's final cumulative outcome count — the part of the scope's count it describes. */
  datedOutcomes: number;
  /**
   * Outcomes in the scope's total whose signal carries NO timestamp, so they sit on no day. Reported
   * rather than dropped or dated: `datedOutcomes + undatedOutcomes` is the scope's whole count.
   */
  undatedOutcomes: number;
}

/**
 * Fold dated COMMITTED spend and the scope's dated driver signal into one cumulative
 * cost-per-outcome curve.
 *
 * PURE — no IO, no wall clock. Days come only from the two inputs, so a re-read on a later day
 * returns the same points.
 *
 * `driver` is the scope's OWN per-signal series (`recipientsClicked` / `recipientsRepliesPositive`),
 * i.e. distinct leads off the same snapshot the `outcomes` block counts, so the curve and that block
 * can never describe different people. Each day's driver count is multiplied by the leg's rate, which
 * is 1 for an entry leg and fractional below it.
 */
export function buildCostPerOutcomeHistory(
  spendByDayUsd: Map<string, number>,
  driver: SignalSeries,
  terms: ScopeOutcomeTerms,
): CostPerOutcomeHistory {
  const outcomesByDay = new Map<string, number>();
  for (const point of driver.daily) {
    outcomesByDay.set(point.date, (outcomesByDay.get(point.date) ?? 0) + point.count * terms.rateFromDriver);
  }

  const days = [...new Set([...spendByDayUsd.keys(), ...outcomesByDay.keys()])].sort();

  const daily: CostPerOutcomeHistoryPoint[] = [];
  let cumulativeSpendUsd = 0;
  let cumulativeOutcomes = 0;
  for (const date of days) {
    cumulativeSpendUsd += spendByDayUsd.get(date) ?? 0;
    cumulativeOutcomes += outcomesByDay.get(date) ?? 0;
    daily.push({
      date,
      cumulativeSpendUsd,
      cumulativeOutcomes,
      // A scope that has spent with nothing to show has no price yet, and a scope with outcomes and
      // no attributed spend did not get them for free — both are "we could not measure this".
      costPerOutcomeUsd:
        cumulativeOutcomes === 0 || cumulativeSpendUsd === 0 ? null : cumulativeSpendUsd / cumulativeOutcomes,
    });
  }

  return {
    outcomeStep: terms.outcomeStep,
    legKey: terms.legKey,
    outcomeObserved: terms.outcomeObserved,
    daily,
    datedOutcomes: cumulativeOutcomes,
    undatedOutcomes: driver.undatedCount * terms.rateFromDriver,
  };
}
