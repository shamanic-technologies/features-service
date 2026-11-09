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
import {
  accountingReturn,
  expectedRouteFigures,
  outcomeAccountingOf,
  yieldToNext,
  effectiveTrials,
  type ExpectedRouteFigures,
  type OutcomeAccounting,
  type RouteLeg,
  type UnitTrial,
} from "./outcome-accounting.js";

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

/**
 * OUTCOME-COST-CUMUL-1109: the process chain, first step first (the reverse of the served order). A step's `$ Spent`
 * carries its own spend + every step above it here, never a step below (`lib/step-cost-attribution.ts`).
 */
export const STEP_COST_CHAIN: readonly OutcomeCostStep[] = [...OUTCOME_COST_STEPS].reverse();

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

/** One counted outcome: the person, the day they first reached the step (null = undated), the campaign credited. */
export interface CountedOutcome {
  day: string | null;
  campaignId: string | null;
}

/**
 * PURE. Per step, each counted outcome keyed on the person (one per person).
 *   - `served`: the offer's campaigns served this person (`campaignId` in `servedCampaignIds`);
 *   - `handedActed`: the leads a follow-up pipe of the offer ACTED on (we messaged them);
 *   - contacted by us = served AND an email/message went out (`signals.contacted`), or acted on by a follow-up pipe.
 */
export function contactedOutcomeLeads(
  persons: readonly EnginePerson[],
  /** The leads the scope's campaigns served (`ScopePeople.servedLeadIds`), never re-derived from campaign ids. */
  servedLeadIds: ReadonlySet<string>,
  handedActed: ReadonlySet<string>,
  scopeStart: string | null,
): Map<OutcomeCostStep, Map<string, CountedOutcome>> {
  const out = new Map<OutcomeCostStep, Map<string, CountedOutcome>>(OUTCOME_COST_STEPS.map((s) => [s, new Map()]));
  const seen = new Set<string>();
  for (const p of persons) {
    if (seen.has(p.leadId)) continue;
    seen.add(p.leadId);
    const campaignId = p.campaignId ?? null;
    const served = servedLeadIds.has(p.leadId);
    if (served) out.get("lead_found")!.set(p.leadId, { day: dayOf(p.servedAt ?? null), campaignId });
    const contacted = (served && Boolean(p.signals.contacted)) || handedActed.has(p.leadId);
    if (!contacted) continue;
    const notOurs = new Set(p.unpricedSignals ?? []);
    for (const [step, signal] of Object.entries(SIGNAL_OF_OUTCOME_STEP) as [OutcomeCostStep, string][]) {
      if (!p.signals[signal] || notOurs.has(signal)) continue;
      const day = dayOf(p.signalDates?.[signal] ?? null);
      // An outcome before the offer's first spend day is not the offer's (another campaign, or the client's own).
      if (day !== null && scopeStart !== null && day < scopeStart) continue;
      out.get(step)!.set(p.leadId, { day, campaignId });
    }
  }
  return out;
}

/** PURE. Per step, the day each counted outcome was first reached (null = undated), one entry per person. */
export function contactedOutcomeDays(
  persons: readonly EnginePerson[],
  servedLeadIds: ReadonlySet<string>,
  handedActed: ReadonlySet<string>,
  scopeStart: string | null,
): Map<OutcomeCostStep, (string | null)[]> {
  const leads = contactedOutcomeLeads(persons, servedLeadIds, handedActed, scopeStart);
  return new Map([...leads].map(([step, m]) => [step, [...m.values()].map((o) => o.day)]));
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

/** Why a step has no figure on a path no leg of which lands on it: the step the path LEAVES FROM is on it, unpriced. */
function notOnPathReason(path: SalesPath, step: string): string {
  return path.legs[0]?.fromStep?.key === step ? "start_step_not_priced_on_route" : "step_not_on_expected_path";
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
  for (const step of OUTCOME_COST_STEPS) out.set(step, none(path ? notOnPathReason(path, step) : (unavailableReason ?? "no_priced_sales_path")));
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

/** PURE. The expected sales path as the route the report walks (framework §10): each leg's yield and cost per Unit. */
export function pathRouteLegs(path: SalesPath): RouteLeg[] {
  return path.legs.map((l) => ({
    fromStep: l.fromStep?.key ?? null,
    toStep: l.toStep.key,
    ratePct: l.conversionRatePct,
    rateBasis: l.rateSource,
    // The client's team works a human leg: it costs us nothing.
    costPerUnitUsd: l.workedBy === "human" ? 0 : l.costPerOutcomeUsd,
    costBasis: l.workedBy === "human" ? "customer_team" : l.costSource,
    legKey: l.legKey,
  }));
}

/**
 * PURE. The value of one outcome of each step on the offer's expected sales path, NET (OUTCOME-ACCOUNTING-1107, framework
 * §10: `V(paid client) = lifetime revenue`, `V(s) = max(0, y x V(next) - c)`). Re-bases the gross LTR ÷ outcomes needed
 * (which never subtracted what the later milestones cost).
 */
export function stepValues(path: SalesPath | null, unavailableReason: string | null): Map<string, StepValue> {
  const out = new Map<string, StepValue>();
  const none = (reason: string): StepValue => ({ valuePerOutcomeUsd: null, unavailableReason: reason });
  for (const step of OUTCOME_COST_STEPS) out.set(step, none(path ? notOnPathReason(path, step) : (unavailableReason ?? "no_priced_sales_path")));
  if (!path) return out;
  const legs = pathRouteLegs(path);
  // The step the path leaves from is valued too, back through the first leg (`expectedRouteFigures`).
  const start = path.legs[0]?.fromStep?.key ?? null;
  for (const step of [...(start ? [start] : []), ...path.legs.map((l) => l.toStep.key)]) {
    if (!out.has(step)) continue;
    const f = expectedRouteFigures(legs, step, path.lifetimeRevenueUsd);
    out.set(step, f.netValuePerUnitUsd === null ? none(f.netValueUnavailableReason ?? "step_has_no_value") : { valuePerOutcomeUsd: round2(f.netValuePerUnitUsd), unavailableReason: null });
  }
  return out;
}

/** What the lead-outcome report of one step reads, beyond the counts the series holds. */
export interface LeadStepAccountingInputs {
  step: OutcomeCostStep;
  /** The expected path's route figures for the step (null = no priced path). */
  figures: ExpectedRouteFigures;
  /** The yield INTO the step on the path (its leg's rate) and the step it comes from. */
  intoLeg: { fromStep: string | null; ratePct: number | null; legKey: string | null } | null;
  outcomes: ReadonlyMap<OutcomeCostStep, ReadonlyMap<string, CountedOutcome>>;
  /** The unit campaign ids of the offer whose pipe lands on the step (the Engine making it, ours). */
  landingUnitIds: ReadonlySet<string>;
  /** Their committed spend, whole history (null = unreadable). */
  landingSpendUsd: number | null;
  /** The offer's whole spend ÷ the step's outcomes (full absorption): the actual cost from Start. */
  actualCostFromStartUsd: number | null;
  /** The funnel campaigns whose Target is the step, with their unit ids and spend. */
  targets: ReadonlyArray<{ campaignId: string; unitCampaignIds: readonly string[] }>;
  targetSpendUsd: number | null;
  windowDaysOf: (legKey: string | null) => number;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: string | null;
  expectedBasis: string | null;
  today: string;
}

/** PURE. Trials of a step toward a next step: every counted Unit at `from`, credited when the same person reached `to`. */
function trialsBetween(outcomes: LeadStepAccountingInputs["outcomes"], from: string | null, to: string | null): UnitTrial[] | null {
  const at = from ? outcomes.get(from as OutcomeCostStep) : undefined;
  const next = to ? outcomes.get(to as OutcomeCostStep) : undefined;
  if (!at || !next) return null;
  return [...at].map(([leadId, o]) => ({ day: o.day, nextUnits: next.has(leadId) ? 1 : 0, units: 1 }));
}

/** PURE. The cost-accounting report of one lead outcome of the offer (framework §10, §12). */
export function leadStepAccounting(i: LeadStepAccountingInputs): OutcomeAccounting {
  const at = i.outcomes.get(i.step) ?? new Map<string, CountedOutcome>();
  // Ours: the step's Units credited to a unit of the Engine making it (its own leg's spend ÷ what that leg made).
  const made = [...at.values()].filter((o) => o.campaignId !== null && i.landingUnitIds.has(o.campaignId)).length;
  const next = i.figures.next;
  const nextTrials = next ? trialsBetween(i.outcomes, i.step, next.step) : null;
  const nextReason = !next ? null : nextTrials === null ? "next_milestone_not_counted_for_offer" : null;
  const intoTrials = i.intoLeg?.fromStep ? trialsBetween(i.outcomes, i.intoLeg.fromStep, i.step) : null;
  const intoMeasured =
    intoTrials && i.intoLeg ? (() => {
      const n = effectiveTrials(intoTrials, i.windowDaysOf(i.intoLeg.legKey), i.today);
      return n > 0 ? (intoTrials.reduce((a, t) => a + t.nextUnits, 0) / n) * 100 : null;
    })() : null;
  const targetIds = new Set(i.targets.flatMap((t) => t.unitCampaignIds));
  const targetUnits = [...at.values()].filter((o) => o.campaignId !== null && targetIds.has(o.campaignId)).length;
  const ret = accountingReturn(
    i.targets.map((t) => t.campaignId),
    i.targetSpendUsd === null ? null : { targetUnits, spentUsd: i.targetSpendUsd },
    i.step === "paid_client" ? i.lifetimeRevenueUsd : i.figures.netValuePerUnitUsd,
    i.figures.costFromStartUsd,
  );
  return outcomeAccountingOf({
    outcomeKey: i.step,
    step: i.step,
    route: i.figures,
    actual: { units: made, spentUsd: i.landingSpendUsd ?? 0 },
    actualUnavailableReason: i.landingUnitIds.size === 0 ? "not_made_by_our_campaigns" : i.landingSpendUsd === null ? "spend_unreadable" : null,
    actualCostFromStartUsd: i.actualCostFromStartUsd,
    actualCostFromStartReason: "no_outcome_yet",
    expectedCostSource: i.expectedBasis,
    yield: yieldToNext(next, nextTrials, nextReason, i.windowDaysOf(next?.legKey ?? null), i.today),
    yieldInto: i.intoLeg ? { measuredPct: intoMeasured, standardPct: i.intoLeg.ratePct } : null,
    yieldIntoReason: !i.intoLeg ? "outcome_not_on_route" : i.intoLeg.fromStep === null || i.intoLeg.ratePct === null ? "entry_leg_has_no_yield" : intoTrials === null ? "previous_milestone_not_counted_for_offer" : null,
    lifetimeRevenueUsd: i.lifetimeRevenueUsd,
    lifetimeRevenueSource: i.lifetimeRevenueSource,
    ret,
  });
}

export interface OutcomeCostMonth {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** OUTCOME-COST-CUMUL-1109: the month's spend carried by the step (its own + every step above it). */
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
    /** OUTCOME-COST-CUMUL-1109: the step's cost from Start = its own spend + every step above it in the chain. */
    spendUsd: number;
    /** OUR Units of the step (the divisor of `costPerOutcomeUsd`). */
    outcomes: number;
    /** Of `outcomes`, those with no date (counted in the last month). */
    undatedOutcomes: number;
    costPerOutcomeUsd: number | null;
    learning: boolean;
  };
  expected: StepExpectedCost;
  /** What one outcome of the step is worth (expected path, NET: OUTCOME-ACCOUNTING-1107), served beside its cost. */
  value: StepValue;
  months: OutcomeCostMonth[];
  /** OUTCOME-ACCOUNTING-1107: the step's cost-accounting report (`lib/outcome-accounting.ts`). */
  accounting: OutcomeAccounting | null;
  /** OUTCOME-COST-CUMUL-1109: how the scope's spend reaches this step (process costing). */
  spendAttribution: StepSpendShare;
}

/** OUTCOME-COST-CUMUL-1109: the step's part of the scope's spend. */
export interface StepSpendShare {
  /** The step's OWN spend, before cumulating: Σ over every step = the scope's spend, to the cent. */
  ownSpendUsd: number;
  /** The step above it in the chain whose `$ Spent` this one adds to (null = the first step). */
  aboveStepKey: OutcomeCostStep | null;
  /** The ledger's own production cost traced to the step (the absorption base), USD. */
  tracedCostUsd: number;
  /** sinceInception.spendUsd ÷ the scope's spend (0..1, unrounded). */
  cumulativeShare: number;
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
  /** The step's report, given its since-inception cost per outcome (the actual cost from Start). */
  accountingOf?: (step: OutcomeCostStep, costFromStartUsd: number | null) => OutcomeAccounting;
  /**
   * OUTCOME-COST-CUMUL-1109: the share of the scope's spend each step carries CUMULATIVELY (`stepSpendAttribution`) and
   * its traced cost. Absent = the whole spend enters at the first step (every step carries all of it).
   */
  attribution?: { cumulativeShareOf: (step: OutcomeCostStep) => number; tracedCostUsdOf: (step: OutcomeCostStep) => number };
  today: string;
}): OutcomeCostStepSeries[] {
  const { spendByDay, outcomeDays, learningBarOf, expectedOf, valueOf, accountingOf, attribution, today } = input;
  const shareOf = (step: OutcomeCostStep) => attribution?.cumulativeShareOf(step) ?? 1;
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
  const runningUsd: number[] = [];
  let running = 0;
  for (const m of months) {
    running += spendUsdByMonth.get(m) ?? 0;
    runningUsd.push(running);
  }
  // OUTCOME-COST-CUMUL-1109: a step's cumulative spend = the scope's running spend × its cumulative share, rounded ONCE
  // per month (so its months add up to it, and a step below never reads less than the step above: shares are monotone).
  const centsOf = (step: OutcomeCostStep) => runningUsd.map((usd) => Math.round(usd * shareOf(step) * 100));
  const lastCents = (step: OutcomeCostStep | null) => (step === null ? 0 : (centsOf(step).at(-1) ?? 0));

  return OUTCOME_COST_STEPS.map((stepKey): OutcomeCostStepSeries => {
    const bar = learningBarOf(stepKey);
    const cumulativeCents = centsOf(stepKey);
    const at = STEP_COST_CHAIN.indexOf(stepKey);
    const aboveStepKey = at > 0 ? STEP_COST_CHAIN[at - 1]! : null;
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
      months: series,
      accounting: accountingOf ? accountingOf(stepKey, end?.cumulativeCostPerOutcomeUsd ?? null) : null,
      spendAttribution: {
        ownSpendUsd: (lastCents(stepKey) - lastCents(aboveStepKey)) / 100,
        aboveStepKey,
        tracedCostUsd: round2(attribution?.tracedCostUsdOf(stepKey) ?? 0),
        cumulativeShare: shareOf(stepKey),
      },
    };
  });
}
