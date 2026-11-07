/**
 * OUTCOME-ACCOUNTING-1107 (owner 2026-11-07: « Affiche les choses rigoureusement dans une démarche de comptabilité
 * analytique industrielle. Les chiffres réels, comme les chiffres expected nous intéressent tous les deux », then « Apply
 * for all outcome pages »). Every Outcome page (a lead outcome: Signup, Meeting booked, Paid client...; a published
 * outcome: LinkedIn post published, newsletter email sent...) is ONE cost-accounting report, built by ONE rule, the GTM
 * Factory framework's (distribute.you `docs/gtm-factory-framework.md` §10 "The two calculations", §12 "Decide versus
 * report"). PURE; the reads live beside each page (`routes/outcome-cost-series.ts`, `lib/published-units-io.ts`).
 *
 * The four figures, each ACTUAL (measured, from the runs ledger) beside EXPECTED (the Plan), each with its basis and a
 * reason when null:
 *   1. Cost per Unit: actual = ledger cost of OUR runs that made the Units (own production + materials consumed at their
 *      standard cost) ÷ our Units; expected = the cost of one more Unit on the route the Plan prices (`c / y` of the
 *      Engine making it). Variance = actual − expected, split (standard costing) into a YIELD variance
 *      `c_std / y_measured − c_std / y_std` (fewer Units out of the same attempts) and a MIX variance
 *      `(c_actual − c_std) / y_measured` (inputs per attempt in other proportions); the two add up to the variance.
 *      Cost from Start = `C(to) = (C(from) + c) / y` along the route, beside the rolled yield (Π of the yields).
 *   2. Yield into the next milestone: measured = next-milestone Units credited to these Units ÷ these Units, an open
 *      decision counted for its share of the next leg's maturity window already elapsed (§8 "Pooling, delays"); expected
 *      = the Supplier rating's belief: the route's rate as a prior worth `PRIOR_TRIALS` trials, pooled with this
 *      client's measured trials (§8 worked example: 2% x 200 trials).
 *   3. Value per Unit, EXPECTED only, NET: `V(target) = value`, `V(s) = max(0, y x V(next) − c)` backward from Paid
 *      client (the offer's lifetime revenue). Never a measured value below the Target.
 *   4. Return (`returns`), only when the outcome IS a campaign's Target: measured = Target Units those campaigns made from their own
 *      inputs x the Target value ÷ their spend; expected = Target value ÷ cost from Start. Otherwise null with
 *      `outcome_is_no_campaign_target`.
 * Only Units performed by OURS enter cost, yield and return; the client's team Units are counted apart (cost $0 to us).
 */

/** The weight of the route's rate as a prior, in trials (framework §8 worked example: a fleet yield counted as 200 trials). */
export const PRIOR_TRIALS = 200;

/** A return below this many Target Units is Learning (the maturity bar of every leg with no stated rule). */
export const RETURN_MIN_UNITS = 10;

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** One leg of the route the Plan prices, from Start to Paid client (or as far as it reaches). */
export interface RouteLeg {
  /** Null = from Start (the market). */
  fromStep: string | null;
  toStep: string;
  /** The leg's yield, in %: Units of `toStep` out of Units of `fromStep`. Null on a leg from Start (its rate prices nothing). */
  ratePct: number | null;
  /** Where the rate comes from (measured, stated, default...). */
  rateBasis: string | null;
  /** The expected cost of one Unit of `toStep` on this leg (`c / y`); 0 on a leg the client's team or the market performs. */
  costPerUnitUsd: number | null;
  costBasis: string | null;
  /** The leg key (its maturity rule censors open decisions), when known. */
  legKey?: string | null;
}

export interface ExpectedRouteFigures {
  /** The steps from Start to the outcome, in order (Start excluded). */
  route: string[];
  costPerUnitUsd: number | null;
  costPerUnitBasis: string | null;
  costPerUnitUnavailableReason: string | null;
  costFromStartUsd: number | null;
  costFromStartUnavailableReason: string | null;
  /** Π of the yields from the first step after Start to the outcome, in %. Null when one is unknown. */
  rolledYieldPct: number | null;
  rolledYieldFromStep: string | null;
  /** The next milestone on the route, its expected yield and the leg's maturity key. */
  next: { step: string; ratePct: number | null; rateBasis: string | null; legKey: string | null; costPerUnitUsd: number | null } | null;
  /** V(s) = max(0, y x V(next) − c), backward from Paid client. */
  netValuePerUnitUsd: number | null;
  netValueUnavailableReason: string | null;
}

/**
 * PURE. The Plan's figures for the outcome at `step` on a route from Start to Paid client: cost of one Unit, cost from
 * Start, rolled yield, the next milestone, and the NET value of one Unit.
 */
export function expectedRouteFigures(legs: readonly RouteLeg[], step: string, lifetimeRevenueUsd: number | null): ExpectedRouteFigures {
  const at = legs.findIndex((l) => l.toStep === step);
  const empty: ExpectedRouteFigures = {
    route: [],
    costPerUnitUsd: null,
    costPerUnitBasis: null,
    costPerUnitUnavailableReason: "outcome_not_on_route",
    costFromStartUsd: null,
    costFromStartUnavailableReason: "outcome_not_on_route",
    rolledYieldPct: null,
    rolledYieldFromStep: null,
    next: null,
    netValuePerUnitUsd: null,
    netValueUnavailableReason: "outcome_not_on_route",
  };
  if (at < 0) return empty;
  const own = legs[at]!;
  // Cost forward from Start: C(first) = c_first, C(to) = C(from) / y + c (c = the leg's cost per Unit, i.e. c / y of the
  // framework). The rolled yield is Π y from the route's first step to the outcome.
  let cost: number | null = 0;
  let costReason: string | null = null;
  let rolled: number | null = 1;
  for (let i = 0; i <= at; i++) {
    const l = legs[i]!;
    if (i > 0) {
      if (l.ratePct === null) {
        cost = null;
        rolled = null;
        costReason ??= "leg_rate_unavailable";
      } else if (!(l.ratePct > 0)) {
        cost = null;
        rolled = rolled === null ? null : 0;
        costReason ??= "zero_conversion_rate";
      } else {
        if (cost !== null) cost /= l.ratePct / 100;
        if (rolled !== null) rolled *= l.ratePct / 100;
      }
    }
    if (l.costPerUnitUsd === null) {
      cost = null;
      costReason ??= "leg_cost_unavailable";
    } else if (cost !== null) cost += l.costPerUnitUsd;
  }
  const firstStep = legs[0]!.toStep;
  // Value backward from Paid client: V(s) = max(0, y x (V(next) − c_next)) where c_next = the next leg's cost per Unit.
  const last = legs[legs.length - 1]!;
  let value: number | null = null;
  let valueReason: string | null = null;
  if (last.toStep !== "paid_client") valueReason = "route_does_not_reach_paid_client";
  else if (lifetimeRevenueUsd === null || !(lifetimeRevenueUsd > 0)) valueReason = "no_lifetime_revenue";
  else {
    value = lifetimeRevenueUsd;
    for (let i = legs.length - 1; i > at; i--) {
      const l = legs[i]!;
      if (l.ratePct === null || l.costPerUnitUsd === null) {
        value = null;
        valueReason = l.ratePct === null ? "leg_rate_unavailable" : "leg_cost_unavailable";
        break;
      }
      value = Math.max(0, (l.ratePct / 100) * (value - l.costPerUnitUsd));
    }
  }
  const nextLeg = legs[at + 1] ?? null;
  return {
    route: legs.slice(0, at + 1).map((l) => l.toStep),
    costPerUnitUsd: own.costPerUnitUsd === null ? null : round(own.costPerUnitUsd),
    costPerUnitBasis: own.costBasis,
    costPerUnitUnavailableReason: own.costPerUnitUsd === null ? "leg_cost_unavailable" : null,
    costFromStartUsd: cost === null ? null : round(cost),
    costFromStartUnavailableReason: cost === null ? costReason : null,
    rolledYieldPct: rolled === null ? null : round(rolled * 100, 8),
    rolledYieldFromStep: firstStep,
    next: nextLeg ? { step: nextLeg.toStep, ratePct: nextLeg.ratePct, rateBasis: nextLeg.rateBasis, legKey: nextLeg.legKey ?? null, costPerUnitUsd: nextLeg.costPerUnitUsd } : null,
    netValuePerUnitUsd: value === null ? null : round(value, 8),
    netValueUnavailableReason: value === null ? valueReason : null,
  };
}

/** One of our Units of the outcome, with when it was made and whether it reached the next milestone. */
export interface UnitTrial {
  /** UTC day the Unit was made (null = undated: counted as a closed decision). */
  day: string | null;
  /** Next-milestone Units credited to it (a post's visits through its link; 1 for a lead who reached the next step). */
  nextUnits: number;
  /** How many Units it is (1 per post or lead; the emails of a newsletter release). */
  units: number;
}

/**
 * PURE. Effective trials (framework §8): a Unit that already led to the next milestone, or whose decision is older than
 * the next leg's maturity window, counts in full; an open one counts for the share of the window already elapsed (the
 * outcomes usually due by its age, arrivals read as uniform over the window: no delay curve is recorded).
 */
export function effectiveTrials(trials: readonly UnitTrial[], windowDays: number, today: string): number {
  let n = 0;
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  for (const t of trials) {
    if (t.nextUnits > 0 || windowDays <= 0 || t.day === null) {
      n += t.units;
      continue;
    }
    const ageDays = (todayMs - Date.parse(`${t.day}T00:00:00.000Z`)) / 86_400_000;
    n += t.units * Math.min(1, Math.max(0, ageDays / windowDays));
  }
  return n;
}

export interface YieldToNext {
  nextStep: string | null;
  measuredPct: number | null;
  /** Next-milestone Units credited to our Units. */
  measuredNextUnits: number | null;
  /** Effective trials after censoring the open decisions. */
  measuredTrials: number | null;
  measuredUnavailableReason: string | null;
  /** The rating's belief: the route's rate (prior, `PRIOR_TRIALS` trials) pooled with the measured trials. */
  expectedPct: number | null;
  /** The route rate the belief starts from, and its basis. */
  priorPct: number | null;
  priorBasis: string | null;
  expectedUnavailableReason: string | null;
  /** The days an open decision needs before it counts in full (the next leg's maturity rule). */
  censoringWindowDays: number;
}

/** PURE. Measured yield (censored), and the pooled expected yield. `measuredReason` non-null = not tracked for this outcome. */
export function yieldToNext(
  next: ExpectedRouteFigures["next"],
  trials: readonly UnitTrial[] | null,
  measuredReason: string | null,
  windowDays: number,
  today: string,
): YieldToNext {
  const base = { nextStep: next?.step ?? null, priorPct: next?.ratePct ?? null, priorBasis: next?.rateBasis ?? null, censoringWindowDays: windowDays };
  if (!next) return { ...base, measuredPct: null, measuredNextUnits: null, measuredTrials: null, measuredUnavailableReason: "final_milestone", expectedPct: null, expectedUnavailableReason: "final_milestone" };
  let measuredPct: number | null = null;
  let measuredNextUnits: number | null = null;
  let measuredTrials: number | null = null;
  let reason = measuredReason;
  if (reason === null && trials !== null) {
    measuredNextUnits = trials.reduce((a, t) => a + t.nextUnits, 0);
    measuredTrials = round(effectiveTrials(trials, windowDays, today), 4);
    if (!(measuredTrials > 0)) reason = trials.length === 0 ? "no_unit_of_ours_yet" : "every_decision_still_open";
    else measuredPct = round((measuredNextUnits / measuredTrials) * 100, 6);
  } else reason ??= "not_measured";
  const prior = next.ratePct;
  let expectedPct: number | null = null;
  let expectedReason: string | null = null;
  if (prior === null) expectedReason = "route_rate_unavailable";
  else {
    const n = measuredPct !== null ? measuredTrials! : 0;
    const s = measuredPct !== null ? measuredNextUnits! : 0;
    expectedPct = round(((s + (prior / 100) * PRIOR_TRIALS) / (n + PRIOR_TRIALS)) * 100, 6);
  }
  return { ...base, measuredPct, measuredNextUnits, measuredTrials, measuredUnavailableReason: measuredPct === null ? reason : null, expectedPct, expectedUnavailableReason: expectedReason };
}

export interface CostVariance {
  /** actual − expected cost per Unit (positive = adverse). */
  usd: number | null;
  /** usd ÷ expected, in %. */
  pct: number | null;
  /** c_std / y_measured − c_std / y_std. */
  yieldUsd: number | null;
  /** (c_actual − c_std) / y_measured. */
  mixUsd: number | null;
  /** Why the split is null (the yield INTO the outcome is not measured for it). */
  splitUnavailableReason: string | null;
  unavailableReason: string | null;
}

/**
 * PURE. Variance of the cost per Unit and its standard-costing split, from the yield INTO the outcome (measured and
 * standard) on the leg making it: c = cost per attempt = cost per Unit x yield.
 */
export function costVariance(actualUsd: number | null, expectedUsd: number | null, yieldInto: { measuredPct: number | null; standardPct: number | null } | null, splitReason: string | null): CostVariance {
  if (actualUsd === null || expectedUsd === null)
    return { usd: null, pct: null, yieldUsd: null, mixUsd: null, splitUnavailableReason: null, unavailableReason: actualUsd === null ? "no_actual_cost" : "no_expected_cost" };
  const usd = round(actualUsd - expectedUsd);
  const pct = expectedUsd > 0 ? round((usd / expectedUsd) * 100, 2) : null;
  const ym = yieldInto?.measuredPct ?? null;
  const ys = yieldInto?.standardPct ?? null;
  if (ym === null || ys === null || !(ym > 0) || !(ys > 0)) {
    return { usd, pct, yieldUsd: null, mixUsd: null, splitUnavailableReason: splitReason ?? (yieldInto === null ? "yield_into_outcome_not_measured" : "yield_into_outcome_zero_or_unknown"), unavailableReason: null };
  }
  const cStd = expectedUsd * (ys / 100);
  const yieldUsd = round(cStd / (ym / 100) - cStd / (ys / 100));
  return { usd, pct, yieldUsd, mixUsd: round(usd - yieldUsd), splitUnavailableReason: null, unavailableReason: null };
}

export interface AccountingReturn {
  /** True when at least one campaign of the scope targets this outcome. */
  isCampaignTarget: boolean;
  targetCampaignIds: string[];
  measured: { roiMultiple: number | null; targetUnits: number | null; valueUsd: number | null; spentUsd: number | null; learning: boolean; unavailableReason: string | null };
  expected: { roiMultiple: number | null; valuePerUnitUsd: number | null; costFromStartUsd: number | null; unavailableReason: string | null };
  unavailableReason: string | null;
}

/** PURE. The return, only at a campaign's Target. */
export function accountingReturn(
  targetCampaignIds: readonly string[],
  measured: { targetUnits: number; spentUsd: number | null } | null,
  valuePerUnitUsd: number | null,
  costFromStartUsd: number | null,
): AccountingReturn {
  if (targetCampaignIds.length === 0) {
    const reason = "outcome_is_no_campaign_target";
    return {
      isCampaignTarget: false,
      targetCampaignIds: [],
      measured: { roiMultiple: null, targetUnits: null, valueUsd: null, spentUsd: null, learning: false, unavailableReason: reason },
      expected: { roiMultiple: null, valuePerUnitUsd: null, costFromStartUsd: null, unavailableReason: reason },
      unavailableReason: reason,
    };
  }
  const units = measured?.targetUnits ?? 0;
  const spent = measured?.spentUsd ?? null;
  const valueUsd = valuePerUnitUsd === null ? null : round(units * valuePerUnitUsd, 4);
  const mReason = measured === null ? "target_units_unreadable" : valuePerUnitUsd === null ? "target_has_no_value" : spent === null || !(spent > 0) ? "nothing_spent_yet" : units === 0 ? "no_target_unit_yet" : null;
  const eReason = valuePerUnitUsd === null ? "target_has_no_value" : costFromStartUsd === null ? "cost_from_start_unavailable" : !(costFromStartUsd > 0) ? "nothing_of_ours_costs_anything" : null;
  return {
    isCampaignTarget: true,
    targetCampaignIds: [...targetCampaignIds].sort(),
    measured: { roiMultiple: mReason === null ? round(valueUsd! / spent!, 2) : null, targetUnits: measured ? units : null, valueUsd, spentUsd: spent, learning: units < RETURN_MIN_UNITS, unavailableReason: mReason },
    expected: { roiMultiple: eReason === null ? round(valuePerUnitUsd! / costFromStartUsd!, 2) : null, valuePerUnitUsd, costFromStartUsd, unavailableReason: eReason },
    unavailableReason: null,
  };
}

/** The cost-accounting report of one outcome (a page total, or one Unit row). */
export interface OutcomeAccounting {
  outcomeKey: string;
  /** The Plan step the outcome is priced and valued on. */
  step: string | null;
  /** Only Units performed by Ours enter these figures. */
  performedBy: "ours";
  costPerUnit: {
    actualUsd: number | null;
    actualUnits: number;
    actualSpentUsd: number;
    actualBasis: "ledger_full_absorption";
    actualUnavailableReason: string | null;
    expectedUsd: number | null;
    expectedBasis: string | null;
    expectedSource: string | null;
    expectedUnavailableReason: string | null;
    variance: CostVariance;
  };
  costFromStart: {
    actualUsd: number | null;
    actualUnavailableReason: string | null;
    expectedUsd: number | null;
    expectedUnavailableReason: string | null;
    rolledYieldPct: number | null;
    rolledYieldFromStep: string | null;
    route: string[];
  };
  yieldToNext: YieldToNext;
  value: {
    expectedNetPerUnitUsd: number | null;
    basis: "expected_net";
    lifetimeRevenueUsd: number | null;
    lifetimeRevenueSource: string | null;
    unavailableReason: string | null;
  };
  /** Named `returns` (a return block): only at a campaign's Target. */
  returns: AccountingReturn;
}

export interface AccountingInputs {
  outcomeKey: string;
  step: string | null;
  route: ExpectedRouteFigures;
  /** Our Units and the ledger cost of making them (own production + materials consumed). */
  actual: { units: number; spentUsd: number };
  actualUnavailableReason?: string | null;
  /** The actual cost from Start (null = same as the cost per Unit: nothing before it on the route). */
  actualCostFromStartUsd?: number | null;
  actualCostFromStartReason?: string | null;
  /** The expected cost per Unit when the route leg has none (the catalogue's last rung), with its source. */
  expectedCostOverride?: { usd: number; basis: string; source: string } | null;
  expectedCostSource?: string | null;
  yield: YieldToNext;
  /** The measured + standard yield INTO the outcome on the leg making it (variance split). */
  yieldInto: { measuredPct: number | null; standardPct: number | null } | null;
  yieldIntoReason?: string | null;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: string | null;
  ret: AccountingReturn;
}

/** PURE. Assemble the report. */
export function outcomeAccountingOf(i: AccountingInputs): OutcomeAccounting {
  const actualUsd = i.actualUnavailableReason ? null : i.actual.units > 0 ? round(i.actual.spentUsd / i.actual.units) : null;
  const actualReason = i.actualUnavailableReason ?? (i.actual.units > 0 ? null : "no_unit_of_ours_yet");
  const override = i.route.costPerUnitUsd === null ? (i.expectedCostOverride ?? null) : null;
  const expectedUsd = override ? round(override.usd) : i.route.costPerUnitUsd;
  // A route from Start with no milestone before the outcome: its cost from Start IS its cost per Unit.
  const fromStartIsOwn = i.route.route.length === 1;
  const expectedFromStart = i.route.costFromStartUsd ?? (fromStartIsOwn && override ? round(override.usd) : null);
  const actualFromStart = i.actualCostFromStartUsd !== undefined ? i.actualCostFromStartUsd : fromStartIsOwn ? actualUsd : null;
  return {
    outcomeKey: i.outcomeKey,
    step: i.step,
    performedBy: "ours",
    costPerUnit: {
      actualUsd,
      actualUnits: i.actual.units,
      actualSpentUsd: round(i.actual.spentUsd),
      actualBasis: "ledger_full_absorption",
      actualUnavailableReason: actualUsd === null ? actualReason : null,
      expectedUsd,
      expectedBasis: override ? override.basis : i.route.costPerUnitBasis,
      expectedSource: override ? override.source : (i.expectedCostSource ?? null),
      expectedUnavailableReason: expectedUsd === null ? i.route.costPerUnitUnavailableReason : null,
      variance: costVariance(actualUsd, expectedUsd, i.yieldInto, i.yieldIntoReason ?? null),
    },
    costFromStart: {
      actualUsd: actualFromStart ?? null,
      actualUnavailableReason: actualFromStart == null ? (i.actualCostFromStartReason ?? actualReason ?? "cost_from_start_not_measured") : null,
      expectedUsd: expectedFromStart,
      expectedUnavailableReason: expectedFromStart === null ? (i.route.costFromStartUnavailableReason ?? "leg_cost_unavailable") : null,
      rolledYieldPct: i.route.rolledYieldPct,
      rolledYieldFromStep: i.route.rolledYieldFromStep,
      route: i.route.route,
    },
    yieldToNext: i.yield,
    value: {
      expectedNetPerUnitUsd: i.route.netValuePerUnitUsd,
      basis: "expected_net",
      lifetimeRevenueUsd: i.lifetimeRevenueUsd,
      lifetimeRevenueSource: i.lifetimeRevenueSource,
      unavailableReason: i.route.netValueUnavailableReason,
    },
    returns: i.ret,
  };
}
