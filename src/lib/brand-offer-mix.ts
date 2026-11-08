/**
 * BRAND-VALUE-ROI-1108 (owner 2026-11-08: « le concept de Value et de ROI doit être repensé depuis qu'on ne filtre plus le
 * dashboard par Offer… peut-être une clé de distribution par Offer ? »). One outcome row of a BRAND that sells several
 * offers. PURE; the reads live in `routes/outcome-cost-series.ts`.
 *
 * DECISION (cost-accounting owner): value is TRACED, never allocated. Every Unit our campaigns make was made by a campaign
 * that states ONE offer, so it carries that offer's value (its lifetime revenue walked back to the outcome). A
 * distribution key (clé de répartition, "méthode des sections homogènes") is the tool for INDIRECT charges that no
 * campaign can be tied to; a stated share per offer would replace a measured cause with a guess (Horngren, Cost
 * Accounting: "cause and effect" first, allocation keys last; Kaplan & Cooper, Cost & Effect: trace on the driver, an
 * arbitrary key distorts). The client states nothing.
 *
 *   - MEASURED return of the outcome (only where it IS a campaign Target, ROI-CONSISTENCY-1103) =
 *     Σ offers (our Target Units of that offer's Target campaigns × that offer's value per Unit) ÷ Σ their spend.
 *     Served since inception AND per month (cumulative), so the curve's last point is the headline to the cent.
 *   - EXPECTED figures at the brand = a FLEXIBLE BUDGET at the actual spend mix (Horngren): what the money each offer's
 *     campaigns spent is expected to make on that offer's own Plan. With w = an offer's spend and C, V its expected cost
 *     from Start and value per Unit: expected Units = w ÷ C; expected $ / outcome = Σw ÷ Σ(w ÷ C); value per outcome =
 *     Σ(w ÷ C × V) ÷ Σ(w ÷ C); expected return = Σ(w ÷ C × V) ÷ Σw. Same money as the measured return, so the two compare.
 *     Weights: spend of the campaigns whose Target is the outcome, else of the campaigns making it. One offer = its own
 *     figures, whatever it spent.
 *   - An expected figure has NO history: a standard is set today and never restated over past months with today's
 *     knowledge (hindsight). The chart's dotted line is today's standard.
 */
import { RETURN_MIN_UNITS } from "./outcome-accounting.js";

export interface OfferStepInput {
  offerId: string;
  /** The offer's expected cost from Start of one Unit (its Plan's route) and value per Unit; null with the reason. */
  costFromStartUsd: number | null;
  valuePerOutcomeUsd: number | null;
  figuresUnavailableReason: string | null;
  /** The offer's campaigns whose Target is this outcome (empty = not a Target of this offer). */
  targetCampaignIds: readonly string[];
  /** Whole-history spend by day of those Target campaigns (null = unreadable). */
  targetSpendByDay: ReadonlyMap<string, number> | null;
  /** OUR Units of the outcome those Target campaigns' runs made, by day (null = the ledger cannot state it). */
  targetUnitsByDay: ReadonlyArray<{ date: string; ourUnits: number }> | null;
  targetUnitsUnavailableReason: string | null;
  /** Whole-history spend of the offer's campaigns MAKING the outcome (landing on it), for a non-Target weight. Null = unreadable. */
  makingSpendUsd: number | null;
}

export interface OfferMixOffer {
  offerId: string;
  /** The spend weighting this offer in the brand's expected figures, and its share of the weights. */
  weightUsd: number | null;
  weightShare: number | null;
  valuePerOutcomeUsd: number | null;
  expectedCostPerOutcomeUsd: number | null;
  isCampaignTarget: boolean;
  expectedReturn: { roiMultiple: number | null; unavailableReason: string | null };
  measuredReturn: { roiMultiple: number | null; targetUnits: number | null; valueUsd: number | null; spentUsd: number | null; unavailableReason: string | null };
  unavailableReason: string | null;
}

export interface OfferMixMonth {
  month: string;
  /** Cumulative to the month end: Target campaigns' spend, our Target Units, their traced value, the return. */
  spentUsd: number;
  targetUnits: number;
  valueUsd: number | null;
  roiMultiple: number | null;
}

export interface OfferMixStep {
  rule: "traced_per_offer";
  weightBasis: "single_offer" | "target_campaign_spend" | "making_campaign_spend";
  offers: OfferMixOffer[];
  valuePerOutcomeUsd: number | null;
  valueUnavailableReason: string | null;
  expectedCostPerOutcomeUsd: number | null;
  expectedCostUnavailableReason: string | null;
  isCampaignTarget: boolean;
  expectedReturn: { roiMultiple: number | null; unavailableReason: string | null };
  measuredReturn: {
    roiMultiple: number | null;
    targetUnits: number | null;
    valueUsd: number | null;
    spentUsd: number | null;
    learning: boolean;
    unavailableReason: string | null;
    months: OfferMixMonth[];
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const sumUpTo = (m: ReadonlyMap<string, number>, lastDay: string) => [...m].filter(([d]) => d <= lastDay).reduce((a, [, v]) => a + v, 0);
const unitsUpTo = (u: ReadonlyArray<{ date: string; ourUnits: number }>, lastDay: string) => u.filter((p) => p.date <= lastDay).reduce((a, p) => a + p.ourUnits, 0);
/** The last day of a `YYYY-MM` month, as a sortable string bound (every `YYYY-MM-DD` of the month is <= it). */
const monthEnd = (month: string) => `${month}-99`;

/** PURE. One outcome row's value, expected and measured figures across the brand's offers. `months` = the series axis. */
export function offerMixOfStep(offers: readonly OfferStepInput[], months: readonly string[], today: string): OfferMixStep {
  const isTarget = offers.some((o) => o.targetCampaignIds.length > 0);
  const weightBasis: OfferMixStep["weightBasis"] = offers.length === 1 ? "single_offer" : isTarget ? "target_campaign_spend" : "making_campaign_spend";
  const weightOf = (o: OfferStepInput): number | null =>
    weightBasis === "single_offer" ? 1 : isTarget ? (o.targetCampaignIds.length === 0 ? 0 : o.targetSpendByDay === null ? null : Math.max(0, sumUpTo(o.targetSpendByDay, today))) : o.makingSpendUsd === null ? null : Math.max(0, o.makingSpendUsd);
  const weights = offers.map(weightOf);
  const totalWeight = weights.some((w) => w === null) ? null : (weights as number[]).reduce((a, w) => a + w, 0);

  // Per offer: its own expected and measured return (only where the outcome is one of its campaigns' Target).
  const perOffer: OfferMixOffer[] = offers.map((o, i) => {
    const target = o.targetCampaignIds.length > 0;
    const spent = target && o.targetSpendByDay !== null ? r2(sumUpTo(o.targetSpendByDay, today)) : null;
    const units = target && o.targetUnitsByDay !== null ? unitsUpTo(o.targetUnitsByDay, today) : null;
    const valueUsd = units !== null && o.valuePerOutcomeUsd !== null ? r2(units * o.valuePerOutcomeUsd) : null;
    const noTarget = "outcome_is_no_campaign_target";
    const eReason = !target ? noTarget : o.valuePerOutcomeUsd === null ? (o.figuresUnavailableReason ?? "target_has_no_value") : o.costFromStartUsd === null ? (o.figuresUnavailableReason ?? "cost_from_start_unavailable") : !(o.costFromStartUsd > 0) ? "nothing_of_ours_costs_anything" : null;
    const mReason = !target ? noTarget : units === null ? (o.targetUnitsUnavailableReason ?? "target_units_unreadable") : o.valuePerOutcomeUsd === null ? "target_has_no_value" : spent === null ? "spend_unreadable" : !(spent > 0) ? "nothing_spent_yet" : units === 0 ? "no_target_unit_yet" : null;
    const w = weights[i]!;
    return {
      offerId: o.offerId,
      weightUsd: weightBasis === "single_offer" ? null : w === null ? null : r2(w),
      weightShare: w === null || totalWeight === null || !(totalWeight > 0) ? null : Math.round((w / totalWeight) * 10_000) / 10_000,
      valuePerOutcomeUsd: o.valuePerOutcomeUsd,
      expectedCostPerOutcomeUsd: o.costFromStartUsd === null ? null : r2(o.costFromStartUsd),
      isCampaignTarget: target,
      expectedReturn: { roiMultiple: eReason === null ? r2(o.valuePerOutcomeUsd! / o.costFromStartUsd!) : null, unavailableReason: eReason },
      measuredReturn: { roiMultiple: mReason === null ? r2(valueUsd! / spent!) : null, targetUnits: units, valueUsd, spentUsd: spent, unavailableReason: mReason },
      unavailableReason: o.figuresUnavailableReason,
    };
  });

  // The flexible budget at the actual spend mix: offers with no weight drop out; a weighted offer missing C or V nulls it.
  const weighted = offers.map((o, i) => ({ o, w: weights[i] })).filter(({ w }) => w === null || w > 0);
  let costReason: string | null = null;
  let valueReason: string | null = null;
  let units = 0;
  let money = 0;
  let value = 0;
  if (totalWeight === null) costReason = valueReason = "spend_unreadable";
  else if (weighted.length === 0) costReason = valueReason = "no_spend_yet";
  else
    for (const { o, w } of weighted) {
      if (o.costFromStartUsd === null || !(o.costFromStartUsd > 0)) {
        costReason ??= o.costFromStartUsd === null ? (o.figuresUnavailableReason ?? "offer_expected_cost_unavailable") : "nothing_of_ours_costs_anything";
        continue;
      }
      const u = w! / o.costFromStartUsd;
      units += u;
      money += w!;
      if (o.valuePerOutcomeUsd === null) valueReason ??= o.figuresUnavailableReason ?? "offer_value_unavailable";
      else value += u * o.valuePerOutcomeUsd;
    }
  valueReason ??= costReason;
  const expectedCost = costReason === null && units > 0 ? r2(money / units) : null;
  const valuePer = valueReason === null && units > 0 ? r2(value / units) : null;
  const noTarget = "outcome_is_no_campaign_target";
  const expectedReturn = !isTarget
    ? { roiMultiple: null, unavailableReason: noTarget }
    : valueReason === null && money > 0
      ? { roiMultiple: r2(value / money), unavailableReason: null }
      : { roiMultiple: null, unavailableReason: valueReason ?? "no_spend_yet" };

  // The measured return: traced value over the Target campaigns' spend, since inception and month by month (cumulative).
  const targets = offers.filter((o) => o.targetCampaignIds.length > 0);
  const measuredAt = (lastDay: string) => {
    let spent = 0;
    let tUnits = 0;
    let tValue: number | null = 0;
    let reason: string | null = null;
    for (const o of targets) {
      if (o.targetSpendByDay === null) reason ??= "spend_unreadable";
      else spent += sumUpTo(o.targetSpendByDay, lastDay);
      if (o.targetUnitsByDay === null) {
        reason ??= o.targetUnitsUnavailableReason ?? "target_units_unreadable";
        continue;
      }
      const u = unitsUpTo(o.targetUnitsByDay, lastDay);
      tUnits += u;
      if (u > 0 && o.valuePerOutcomeUsd === null) tValue = null;
      else if (tValue !== null && u > 0) tValue += u * o.valuePerOutcomeUsd!;
    }
    return { spent: r2(spent), tUnits, tValue: tValue === null ? null : r2(tValue), reason };
  };
  const total = measuredAt(today);
  const mReason = !isTarget ? noTarget : (total.reason ?? (total.tValue === null ? "target_has_no_value" : !(total.spent > 0) ? "nothing_spent_yet" : total.tUnits === 0 ? "no_target_unit_yet" : null));
  const readable = isTarget && total.reason === null;
  return {
    rule: "traced_per_offer",
    weightBasis,
    offers: perOffer,
    valuePerOutcomeUsd: valuePer,
    valueUnavailableReason: valuePer === null ? (valueReason ?? "no_spend_yet") : null,
    expectedCostPerOutcomeUsd: expectedCost,
    expectedCostUnavailableReason: expectedCost === null ? (costReason ?? "no_spend_yet") : null,
    isCampaignTarget: isTarget,
    expectedReturn,
    measuredReturn: {
      roiMultiple: mReason === null ? r2(total.tValue! / total.spent) : null,
      targetUnits: readable ? total.tUnits : null,
      valueUsd: readable ? total.tValue : null,
      spentUsd: readable ? total.spent : null,
      learning: !readable || total.tUnits < RETURN_MIN_UNITS,
      unavailableReason: mReason,
      months: !readable
        ? []
        : months.map((month) => {
            const at = measuredAt(month === today.slice(0, 7) ? today : monthEnd(month));
            return { month, spentUsd: at.spent, targetUnits: at.tUnits, valueUsd: at.tValue, roiMultiple: at.tValue !== null && at.spent > 0 && at.tUnits > 0 ? r2(at.tValue / at.spent) : null };
          }),
    },
  };
}
