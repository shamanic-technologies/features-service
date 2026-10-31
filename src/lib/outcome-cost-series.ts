/**
 * WHAT ONE OUTCOME COSTS, PER MONTH AND SINCE INCEPTION, FOR EVERY OUTCOME STEP OF AN OFFER
 * (owner 2026-10-27, OUTCOME-COST-SERIES-1027; read by dashboard v2's Outcomes > <step> pages).
 *
 * $ / outcome = what the client spent on the offer's campaigns ÷ the outcomes reached by people WE contacted (owner's
 * choice "A"; rejected "B": our spend ÷ everyone the client's own tools report, it counts people we never wrote to).
 *
 *   - SPEND: the offer's whole spend, the byte-same scope as `/offers/:id/spend-charts` and the brand offers row
 *     (every campaign of the offer, every channel, legacy campaigns included, + the brand's campaign-less work), on the
 *     caller's pricing. Every step divides that SAME spend: a state's unit cost carries every lower state it needed
 *     (cost-accounting rule 4, full absorption), and what the client paid is one figure, never split by step.
 *   - OUTCOMES of a step: the people the offer's campaigns served (or its follow-up pipes acted on) whom we CONTACTED,
 *     who reached the step, the step NOT tagged as another factory's win (`unpricedSignals`, lead-service's cause), and
 *     not before the offer's first spend day. Lead found = the people the offer's campaigns were served (found by us).
 *   - Each person counts once per step (a state reached once), in the month they first reached it; an undated one lands
 *     in the LAST month (so the last cumulative = the since-inception headline, to the cent).
 *   - Zero outcomes: `costPerOutcomeUsd` null (never the spend as a floor), `learning` true, and the expected value.
 *
 * PURE: no IO. The reads live in `routes/outcome-cost-series.ts`.
 */
import type { EnginePerson } from "./revenue-engine.js";
import type { SalesPath } from "./offer-sales-paths.js";

/** The outcome steps served, most advanced first (every step a lead-state page lists, plus Lead found). */
export const OUTCOME_COST_STEPS = [
  "paid_client",
  "meeting_attended",
  "meeting_booked",
  "signup",
  "form_submitted",
  "conversation",
  "website_visit",
  "lead_found",
] as const;
export type OutcomeCostStep = (typeof OUTCOME_COST_STEPS)[number];

/** The engine signal a person carries once they reached a step (Lead found is the serve itself). */
export const SIGNAL_OF_OUTCOME_STEP: Readonly<Record<Exclude<OutcomeCostStep, "lead_found">, string>> = {
  paid_client: "closeWin",
  meeting_attended: "meetingAttended",
  meeting_booked: "meeting",
  signup: "signup",
  form_submitted: "formSubmission",
  conversation: "positiveReply",
  website_visit: "clicked",
};

const dayOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

/**
 * PURE. Per step, the day each counted outcome was first reached (null = undated), one entry per person.
 *   - `served`: the offer's campaigns served this person (`campaignId` in `servedCampaignIds`);
 *   - `handedActed`: the leads a follow-up pipe of the offer ACTED on (we messaged them);
 *   - contacted by us = served AND an email/message went out (`signals.contacted`), or acted on by a follow-up pipe.
 */
export function contactedOutcomeDays(
  persons: readonly EnginePerson[],
  servedCampaignIds: ReadonlySet<string>,
  handedActed: ReadonlySet<string>,
  scopeStart: string | null,
): Map<OutcomeCostStep, (string | null)[]> {
  const out = new Map<OutcomeCostStep, (string | null)[]>(OUTCOME_COST_STEPS.map((s) => [s, []]));
  const seen = new Set<string>();
  for (const p of persons) {
    if (seen.has(p.leadId)) continue;
    seen.add(p.leadId);
    const served = p.campaignId != null && servedCampaignIds.has(p.campaignId);
    if (served) out.get("lead_found")!.push(dayOf(p.servedAt ?? null));
    const contacted = (served && Boolean(p.signals.contacted)) || handedActed.has(p.leadId);
    if (!contacted) continue;
    const notOurs = new Set(p.unpricedSignals ?? []);
    for (const [step, signal] of Object.entries(SIGNAL_OF_OUTCOME_STEP) as [OutcomeCostStep, string][]) {
      if (!p.signals[signal] || notOurs.has(signal)) continue;
      const day = dayOf(p.signalDates?.[signal] ?? null);
      // An outcome before the offer's first spend day is not the offer's (another campaign, or the client's own).
      if (day !== null && scopeStart !== null && day < scopeStart) continue;
      out.get(step)!.push(day);
    }
  }
  return out;
}

/** The expected cost of one outcome of a step, when nothing (or too little) is measured yet. */
export interface StepExpectedCost {
  costPerOutcomeUsd: number | null;
  /** The weakest basis of the model the figure is read off (measured, stated, fleet, default). Null with the reason. */
  basis: string | null;
  /** The sales path (stored spelling) the figure is read off. */
  combinationKey: string | null;
  unavailableReason: string | null;
}

/**
 * PURE. The expected cost of one outcome of each step ON ONE PRICED SALES PATH (the offer's expected model's path):
 * the platform cost of every leg up to the step, per paying client (`costPerPayingClientUsd`), ÷ the step's outcomes
 * needed per paying client. A state's cost carries the lower states it needed (cost-accounting rule 4). A human leg costs
 * us nothing; an unpriced platform leg up to the step leaves it null.
 */
export function expectedStepCosts(path: SalesPath | null, basis: string | null, unavailableReason: string | null): Map<string, StepExpectedCost> {
  const out = new Map<string, StepExpectedCost>();
  const none = (reason: string): StepExpectedCost => ({ costPerOutcomeUsd: null, basis: null, combinationKey: path?.combinationKey ?? null, unavailableReason: reason });
  for (const step of OUTCOME_COST_STEPS) out.set(step, none(path ? "step_not_on_expected_path" : (unavailableReason ?? "no_priced_sales_path")));
  if (!path) return out;
  let cumulative: number | null = 0;
  for (const leg of path.legs) {
    if (leg.workedBy === "platform") cumulative = cumulative === null || leg.costPerPayingClientUsd === null ? null : cumulative + leg.costPerPayingClientUsd;
    const step = leg.toStep.key;
    if (!out.has(step)) continue;
    const needed = leg.outcomesNeededPerPayingClient;
    if (cumulative === null) out.set(step, none("leg_cost_unavailable"));
    else if (needed === null || needed <= 0) out.set(step, none("zero_conversion_rate"));
    else out.set(step, { costPerOutcomeUsd: round2(cumulative / needed), basis, combinationKey: path.combinationKey, unavailableReason: null });
  }
  return out;
}

/** What one outcome of a step is worth to the client, read off the SAME expected sales path as its expected cost. */
export interface StepValue {
  /** The offer's lifetime revenue ÷ the step's outcomes needed per paying client on the expected path. Null with the reason. */
  valuePerOutcomeUsd: number | null;
  unavailableReason: string | null;
}

/**
 * PURE. The value of one outcome of each step on the offer's expected sales path (P5 OUTCOMES-ENTRY, owner 2026-10-31
 * "Go with all": an outcome card states its $ / outcome AND its ROI where the outcome is valued). Paid client = the
 * lifetime revenue; an earlier step = the lifetime revenue ÷ how many of that step one paying client needs.
 */
export function stepValues(path: SalesPath | null, unavailableReason: string | null): Map<string, StepValue> {
  const out = new Map<string, StepValue>();
  const none = (reason: string): StepValue => ({ valuePerOutcomeUsd: null, unavailableReason: reason });
  for (const step of OUTCOME_COST_STEPS) out.set(step, none(path ? "step_not_on_expected_path" : (unavailableReason ?? "no_priced_sales_path")));
  if (!path) return out;
  const ltr = path.lifetimeRevenueUsd;
  for (const leg of path.legs) {
    const step = leg.toStep.key;
    if (!out.has(step)) continue;
    const needed = leg.outcomesNeededPerPayingClient;
    if (ltr === null || !(ltr > 0)) out.set(step, none("no_lifetime_revenue"));
    else if (needed === null || needed <= 0) out.set(step, none("zero_conversion_rate"));
    else out.set(step, { valuePerOutcomeUsd: round2(ltr / needed), unavailableReason: null });
  }
  return out;
}

/** PURE. value ÷ cost, 2 decimals; null when either side is missing or the cost is not positive. */
export function roiOf(valueUsd: number | null, costUsd: number | null): number | null {
  if (valueUsd === null || costUsd === null || !(costUsd > 0)) return null;
  return round2(valueUsd / costUsd);
}

export interface OutcomeCostMonth {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** What the client spent on the offer this month. */
  spendUsd: number;
  /** Outcomes of the step first reached this month by people we contacted (undated ones count in the last month). */
  outcomes: number;
  /** spendUsd ÷ outcomes; null at 0 outcomes (never the spend as a floor). */
  costPerOutcomeUsd: number | null;
  cumulativeSpendUsd: number;
  cumulativeOutcomes: number;
  /** cumulativeSpendUsd ÷ cumulativeOutcomes as of the month end; null at 0 outcomes. */
  cumulativeCostPerOutcomeUsd: number | null;
  /** True while the cumulative outcomes are below the step's learning bar. */
  learning: boolean;
}

export interface OutcomeCostStepSeries {
  stepKey: OutcomeCostStep;
  /** Outcomes the step must hold before its cost is judged (the leg maturity bar, `lib/maturity.ts`). */
  learningOutcomesRequired: number;
  /** Since inception: equals the last month's cumulative figures. */
  sinceInception: {
    spendUsd: number;
    outcomes: number;
    /** Of `outcomes`, those with no date (counted in the last month). */
    undatedOutcomes: number;
    costPerOutcomeUsd: number | null;
    learning: boolean;
  };
  expected: StepExpectedCost;
  /** What one outcome of the step is worth (expected path), served beside its cost so a reader never divides. */
  value: StepValue;
  /**
   * Return of one outcome: value.valuePerOutcomeUsd ÷ a cost per outcome. `measured` over sinceInception's cost (null at 0
   * outcomes or when the step is not valued), `expected` over expected's cost. A reader shows `measured`, else `expected`
   * marked expected.
   */
  roi: { measured: number | null; expected: number | null };
  months: OutcomeCostMonth[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const monthOf = (day: string): string => day.slice(0, 7);

/** PURE. Every `YYYY-MM` from `from` to `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * PURE. One series per step. The months run from the first month holding spend or a dated outcome (of ANY step, so
 * every step shares one axis) to the current month. The last cumulative spend is the headline to the cent.
 */
export function buildOutcomeCostSeries(input: {
  spendByDay: ReadonlyMap<string, number>;
  outcomeDays: ReadonlyMap<OutcomeCostStep, readonly (string | null)[]>;
  learningBarOf: (step: OutcomeCostStep) => number;
  expectedOf: (step: OutcomeCostStep) => StepExpectedCost;
  valueOf: (step: OutcomeCostStep) => StepValue;
  today: string;
}): OutcomeCostStepSeries[] {
  const { spendByDay, outcomeDays, learningBarOf, expectedOf, valueOf, today } = input;
  // Spend is summed EXACTLY (unrounded) and rounded ONCE on the cumulative, so the last cumulative is the scope's whole
  // spend to the cent (the offer spend chart's total) and each month's spend is the difference of two rounded
  // cumulatives (the months add up to the cumulative exactly).
  const spendUsdByMonth = new Map<string, number>();
  for (const [day, usd] of spendByDay) {
    if (day > today) continue;
    spendUsdByMonth.set(monthOf(day), (spendUsdByMonth.get(monthOf(day)) ?? 0) + usd);
  }
  const dated = [...outcomeDays.values()].flat().filter((d): d is string => d !== null && d <= today);
  const firstMonth = [...spendUsdByMonth.keys(), ...dated.map(monthOf)].sort()[0] ?? null;
  const months = firstMonth ? monthsBetween(firstMonth, monthOf(today)) : [];
  const last = months.at(-1) ?? null;
  const cumulativeCents: number[] = [];
  let runningUsd = 0;
  for (const m of months) {
    runningUsd += spendUsdByMonth.get(m) ?? 0;
    cumulativeCents.push(Math.round(runningUsd * 100));
  }

  return OUTCOME_COST_STEPS.map((stepKey): OutcomeCostStepSeries => {
    const bar = learningBarOf(stepKey);
    const days = outcomeDays.get(stepKey) ?? [];
    const perMonth = new Map<string, number>();
    let undated = 0;
    for (const d of days) {
      // Undated, or dated past today (a clock skew), lands in the last month: never dropped.
      const m = d !== null && d <= today ? monthOf(d) : null;
      if (m === null) undated += 1;
      const key = m ?? last;
      if (key !== null) perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
    }
    let cumOutcomes = 0;
    const series = months.map((month, i): OutcomeCostMonth => {
      const cumCents = cumulativeCents[i];
      const cents = cumCents - (i > 0 ? cumulativeCents[i - 1] : 0);
      const outcomes = perMonth.get(month) ?? 0;
      cumOutcomes += outcomes;
      return {
        month,
        spendUsd: cents / 100,
        outcomes,
        costPerOutcomeUsd: outcomes > 0 ? round2(cents / 100 / outcomes) : null,
        cumulativeSpendUsd: cumCents / 100,
        cumulativeOutcomes: cumOutcomes,
        cumulativeCostPerOutcomeUsd: cumOutcomes > 0 ? round2(cumCents / 100 / cumOutcomes) : null,
        learning: cumOutcomes < bar,
      };
    });
    const end = series.at(-1);
    const expected = expectedOf(stepKey);
    const value = valueOf(stepKey);
    const measuredCost = end?.cumulativeCostPerOutcomeUsd ?? null;
    return {
      stepKey,
      learningOutcomesRequired: bar,
      sinceInception: {
        spendUsd: end?.cumulativeSpendUsd ?? 0,
        outcomes: end?.cumulativeOutcomes ?? 0,
        undatedOutcomes: undated,
        costPerOutcomeUsd: end?.cumulativeCostPerOutcomeUsd ?? null,
        learning: end?.learning ?? true,
      },
      expected,
      value,
      roi: { measured: roiOf(value.valuePerOutcomeUsd, measuredCost), expected: roiOf(value.valuePerOutcomeUsd, expected.costPerOutcomeUsd) },
      months: series,
    };
  });
}
