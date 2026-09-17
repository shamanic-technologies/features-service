/**
 * WHAT SHARE OF THE PEOPLE THIS SCOPE REACHED HAVE CONVERTED, DAY BY DAY — the dated twin of the
 * conversion rate the body already states as a scalar, and the third curve of the campaign Overview.
 *
 * The service could say what share of a campaign's outreach converts RIGHT NOW and nothing about
 * whether it is getting better. Both ingredients were already on the body — `recipientsContacted`
 * carries the dated population and the per-signal series carry the dated driver counts — and the one
 * thing no consumer could obtain is the two joined. The ban on dividing two served figures in the
 * browser is not a style objection here: a lead carrying NO timestamp on either leg is in the scope's
 * totals while sitting on no day, so a browser-side cumulative sum would divide two differently-sized
 * populations and the curve's last point would stop agreeing with the rate printed above it. One
 * screen, two numbers for one statistic.
 *
 * ── BOTH LEGS ARE CUMULATIVE, FOR THE REASON THE TWO SIBLING CURVES STATE ───────────────────────
 *
 * Outreach on a day earns conversions days or weeks later, so `that day's outcomes ÷ that day's
 * contacted` oscillates between 0 and absurd and describes nothing — the identical objection
 * `roiHistory` and `costPerOutcomeHistory` answer the same way. The cumulative form is the one that
 * converges, and its last point is the scope's own conversion rate rather than a second opinion about
 * it.
 *
 * ── THE OUTCOME IS THE SCOPE'S OWN LEG'S STEP, AND THIS SERVICE NAMES IT ────────────────────────
 *
 * Never the driver signal under another name, and never a noun the consumer picked. The terms are the
 * byte-same `ScopeOutcomeTerms` the cost-per-outcome curve is denominated in, resolved ONCE by the
 * leader resolution `learningPhase` uses — so the two curves a consumer draws side by side can never
 * be measuring two different steps. `outcomeObserved` says which a reader is looking at: an ENTRY
 * leg's count is a raw OBSERVATION (rate 1), a deeper leg's is that observation walked forward
 * through the funnel's own declared rates and is therefore fractional.
 *
 * ── THE DENOMINATOR IS REACH, AND IT IS THE SAME PEOPLE THE NUMERATOR CAME FROM ─────────────────
 *
 * `contacted` is the scope's own REACH — every distinct lead it emailed, bounces and unsubscribes
 * INCLUDED, the identical base `funnelSteps.contactedRecipients` states and for the identical reason:
 * a bounce is a real loss at the very first rung and it was paid for, so a rate that quietly divided
 * by the survivors would hide the people this campaign bought and never reached. Both legs are built
 * from the SAME `leads[]` rows of the SAME campaign-scoped snapshot, so the scoping is correct by
 * CONSTRUCTION rather than by a narrowing that could be forgotten — there is no producer to re-ask
 * and no fan-out to get wrong. A campaign-scoped read can therefore never divide its brand's
 * population, which is the defect `costPerOutcomeHistory`'s spend leg shipped with and had to fix.
 *
 * ── WHAT IT RECONCILES WITH ─────────────────────────────────────────────────────────────────────
 *
 * `scopeConversionRatePct` is the WHOLE scope's rate — every outcome over every person reached,
 * dated or not — so it IS `100 × rateFromDriver × outcomes.recipientsClicked ÷
 * outcomes.recipientsContacted` (or `recipientsRepliesPositive` on a reply-driven funnel) for the
 * same body, by construction: one deduped person set, counted once. On an ENTRY leg it is also the
 * `funnelSteps` rung for that same leg, which converts from `Contacted`.
 *
 * The curve's LAST POINT is the rate over the DATED population alone, so it equals
 * `scopeConversionRatePct` exactly when nothing is undated and legitimately differs otherwise. That
 * is stated rather than corrected: `undatedContacted` and `undatedOutcomes` ride the block for the
 * same reason `roiHistory` states `undatedPipelineUsd`, so a consumer can always see how much of the
 * scope the curve describes. Dating them would invent a day; dropping them would leave the served
 * scalar unexplainable. Do NOT "fix" the gap by flooring one onto the other.
 *
 * ── A MEASURED 0 IS NOT A MISSING ANSWER, AND THE NULL RULE IS NOT THE COST CURVE'S ─────────────
 *
 * `conversionRatePct` is NULL only when the cumulative population is still 0 — there is no
 * denominator, so there is no rate. A day with people reached and nobody converted is a MEASURED
 * `0`: "nobody converted" is a real answer a reader acts on, and nulling it would hide the very
 * period a customer is asking about. That is deliberately the OPPOSITE of
 * `costPerOutcomeHistory`, which nulls at 0 outcomes because a cost per nothing cannot be divided at
 * all — do NOT "harmonise" the two.
 *
 * (features-service#992.)
 */

import type { ChannelStepDef } from "./acquisition-channels.js";
import type { ScopeOutcomeTerms } from "./cost-per-outcome-history.js";
import type { SignalSeries } from "./revenue-engine.js";

/** One UTC calendar day of the curve. BOTH legs are CUMULATIVE since the scope's first day. */
export interface ConversionRateHistoryPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Every distinct lead this scope REACHED (bounces and unsubscribes included) up to this day. */
  cumulativeContacted: number;
  /** Every outcome of this leg's step DATED up to this day. Fractional on a deeper leg. */
  cumulativeOutcomes: number;
  /**
   * `100 × cumulativeOutcomes / cumulativeContacted`. NULL only when nobody has been reached yet —
   * no denominator. A `0` here is MEASURED: people were reached and nobody converted.
   */
  conversionRatePct: number | null;
}

/** WHAT SHARE OF THIS SCOPE'S OUTREACH CONVERTS, ACROSS ITS LIFE — named, dated, divided by nobody. */
export interface ConversionRateHistory {
  /** The step every count here is denominated in — this service's answer, not the caller's. */
  outcomeStep: ChannelStepDef;
  /** The leg that step closes, canonical. */
  legKey: string;
  /** TRUE ⟺ the counts are raw OBSERVATIONS rather than walked forward through the funnel's rates. */
  outcomeObserved: boolean;
  /** Ascending, one entry per day that reached somebody or dated an outcome. Empty when neither. */
  daily: ConversionRateHistoryPoint[];
  /** The curve's final cumulative population — the part of the scope's reach it describes. */
  datedContacted: number;
  /** Leads this scope reached whose outreach carries no timestamp, so they sit on no day. */
  undatedContacted: number;
  /** The curve's final cumulative outcome count. */
  datedOutcomes: number;
  /** Outcomes whose driver signal carries no timestamp, so they sit on no day. */
  undatedOutcomes: number;
  /**
   * THE WHOLE SCOPE'S RATE — every outcome over everybody reached, dated or not. The figure the curve
   * converges toward, and the one that reconciles with the `outcomes` block above it. NULL only when
   * the scope has reached nobody. Served rather than left to a division, so one screen states one
   * number.
   */
  scopeConversionRatePct: number | null;
}

/**
 * Fold the scope's dated REACH and its dated driver signal into one cumulative conversion-rate curve.
 *
 * PURE — no IO, no wall clock. Days come only from the two inputs, so a re-read on a later day
 * returns the same points.
 *
 * Both series are the scope's OWN per-signal series off the SAME `leads[]` rows (`recipientsContacted`
 * and `recipientsClicked` / `recipientsRepliesPositive`), i.e. distinct leads off the snapshot the
 * `outcomes` block counts — so the curve and that block can never describe different people. Each
 * day's driver count is multiplied by the leg's rate, which is 1 for an entry leg and fractional
 * below it.
 */
export function buildConversionRateHistory(
  contacted: SignalSeries,
  driver: SignalSeries,
  terms: ScopeOutcomeTerms,
): ConversionRateHistory {
  const contactedByDay = new Map<string, number>();
  for (const point of contacted.daily) {
    contactedByDay.set(point.date, (contactedByDay.get(point.date) ?? 0) + point.count);
  }
  const outcomesByDay = new Map<string, number>();
  for (const point of driver.daily) {
    outcomesByDay.set(point.date, (outcomesByDay.get(point.date) ?? 0) + point.count * terms.rateFromDriver);
  }

  const days = [...new Set([...contactedByDay.keys(), ...outcomesByDay.keys()])].sort();

  const daily: ConversionRateHistoryPoint[] = [];
  let cumulativeContacted = 0;
  let cumulativeOutcomes = 0;
  for (const date of days) {
    cumulativeContacted += contactedByDay.get(date) ?? 0;
    cumulativeOutcomes += outcomesByDay.get(date) ?? 0;
    daily.push({
      date,
      cumulativeContacted,
      cumulativeOutcomes,
      // No denominator is the ONLY unmeasurable case. Nobody converting is a measurement.
      conversionRatePct: cumulativeContacted === 0 ? null : (cumulativeOutcomes / cumulativeContacted) * 100,
    });
  }

  const undatedOutcomes = driver.undatedCount * terms.rateFromDriver;
  const scopeContacted = cumulativeContacted + contacted.undatedCount;

  return {
    outcomeStep: terms.outcomeStep,
    legKey: terms.legKey,
    outcomeObserved: terms.outcomeObserved,
    daily,
    datedContacted: cumulativeContacted,
    undatedContacted: contacted.undatedCount,
    datedOutcomes: cumulativeOutcomes,
    undatedOutcomes,
    scopeConversionRatePct:
      scopeContacted === 0 ? null : ((cumulativeOutcomes + undatedOutcomes) / scopeContacted) * 100,
  };
}
