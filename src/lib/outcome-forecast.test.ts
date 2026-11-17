import { describe, it, expect } from "vitest";
import { campaignForecastOf, chooseDelay, chooseEntryCost, chooseYield, forecastOf, lagSharesOf, rngOf, scaledCapacity, DEFAULT_DELAY_MEDIAN_DAYS, type CampaignForecastInput, type ForecastInput } from "./outcome-forecast.js";
import { rateEstimateOf, type DelayDistribution, type TransitionStat } from "./outcome-silver.js";
import type { SpendCapacityInput } from "./spend-capacity.js";

const prior = { shape: 0.5, rate: 500 };
const delayOf = (n: number, hours = 48): DelayDistribution => ({ n, meanHours: hours, medianHours: hours, p10Hours: hours / 2, p25Hours: hours / 2, p75Hours: hours * 2, p90Hours: hours * 2, cdf: [{ hours: hours * 2, share: 1 }] });
const stat = (fromUnits: number, toUnits: number, pairs = 0): TransitionStat => ({ fromUnits, toUnits, foreignToUnits: 0, linkedToUnits: pairs, linkCoverage: toUnits > 0 ? pairs / toUnits : null, exposure: fromUnits, censoredBy: null, yield: rateEstimateOf({ toUnits, exposure: fromUnits }, prior), prior, delay: pairs > 0 ? delayOf(pairs) : null });

describe("chooseYield (campaign measured > brand measured > fleet measured > plan > default)", () => {
  it("the campaign's own yield when its exposure outweighs the fleet prior", () => {
    const y = chooseYield({ campaign: stat(3000, 6), brand: stat(9000, 30), fleet: stat(90000, 200) }, 0.05, { fromUnits: 3000, toUnits: 6 })!;
    expect(y).toMatchObject({ source: "campaign", shape: 6.5, rate: 3500, thinnerScopes: [] });
    expect(y.evidence.map((e) => e.scope)).toEqual(["campaign", "brand", "fleet"]);
  });
  it("a thin campaign falls to its brand, and says so", () => {
    expect(chooseYield({ campaign: stat(100, 0), brand: stat(9000, 30), fleet: stat(90000, 200) }, null, { fromUnits: 100, toUnits: 0 })).toMatchObject({ source: "brand", shape: 30.5, rate: 9500, thinnerScopes: ["campaign"] });
  });
  it("campaign and brand both thin: the fleet prior, nudged by the campaign's own thin evidence", () => {
    expect(chooseYield({ campaign: stat(2, 0), brand: stat(40, 1), fleet: stat(90000, 200) }, 0.05, { fromUnits: 2, toUnits: 0 })).toMatchObject({ source: "fleet", shape: 0.5, rate: 502, thinnerScopes: ["campaign", "brand"] });
    expect(chooseYield({ campaign: null, brand: null, fleet: stat(90000, 200) }, 0.05, { fromUnits: 0, toUnits: 0 })).toMatchObject({ source: "fleet", thinnerScopes: [] });
    // UNIT-LINKS-CONSUME-1117-FIX: each scope's evidence says how much of its counted Units the ledger's links tie.
    expect(chooseYield({ campaign: stat(3000, 2700, 1800), brand: null, fleet: stat(90000, 200, 150) }, null, { fromUnits: 3000, toUnits: 2700 })!.evidence).toEqual([
      { scope: "campaign", fromUnits: 3000, toUnits: 2700, linkedToUnits: 1800, linkCoverage: 1800 / 2700, exposure: 3000, delayPairs: 1800 },
      { scope: "fleet", fromUnits: 90000, toUnits: 200, linkedToUnits: 150, linkCoverage: 0.75, exposure: 90000, delayPairs: 150 },
    ]);
  });
  it("never measured anywhere: the plan line's rate, then the campaign's own counts, then nothing", () => {
    const none = { campaign: null, brand: null, fleet: null };
    const plan = chooseYield(none, 0.05, { fromUnits: 2, toUnits: 0 })!;
    expect(plan.source).toBe("plan");
    expect(plan.shape / plan.rate).toBeCloseTo(0.5 / 12, 9); // half a Unit over 10 + 2 from-Units: the plan's 5%, pulled by 2 Units with nothing
    expect(chooseYield(none, null, { fromUnits: 50, toUnits: 5 })).toMatchObject({ source: "default", shape: 5.5, rate: 50 });
    expect(chooseYield(none, null, { fromUnits: 0, toUnits: 0 })).toBeNull();
  });
});

describe("chooseDelay", () => {
  it("the finest scope with at least 10 pairs", () => {
    expect(chooseDelay({ campaign: stat(1, 1, 3), brand: stat(1, 1, 12), fleet: stat(1, 1, 400) })).toMatchObject({ source: "brand", pairs: 12, thinSample: false });
  });
  it("every sample thin: the largest one measured still beats the default, flagged thin", () => {
    expect(chooseDelay({ campaign: stat(1, 1, 2), brand: null, fleet: stat(1, 1, 3) })).toMatchObject({ source: "fleet", pairs: 3, thinSample: true });
  });
  it("no pair anywhere: the default, half within 21 days", () => {
    const d = chooseDelay({ campaign: null, brand: stat(5, 0), fleet: null });
    expect(d).toMatchObject({ source: "default", pairs: 0, medianHours: DEFAULT_DELAY_MEDIAN_DAYS * 24 });
    const lag = lagSharesOf(d.cdf);
    expect(lag.slice(0, 21).reduce((a, v) => a + v, 0)).toBeCloseTo(0.5, 2);
    expect(lag.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
  });
});

describe("chooseEntryCost", () => {
  it("measured on the campaign: everything it spent over its first-milestone Units, with a bootstrap interval", () => {
    const days = [{ spendUsd: 10, units: 100 }, { spendUsd: 30, units: 100 }, { spendUsd: 20, units: 200 }, { spendUsd: 5, units: 0 }];
    const c = chooseEntryCost(days, { costPerEntryUsd: 9, basis: "default" }, rngOf(1))!;
    expect(c).toMatchObject({ source: "campaign", usdPerUnit: 65 / 400, spentUsd: 65, units: 400, planBasis: null });
    expect(c.p10).toBeLessThan(c.usdPerUnit);
    expect(c.p90).toBeGreaterThan(c.usdPerUnit);
    expect(c.draws).toHaveLength(200);
  });
  it("under 30 Units the plan line prices it; with no plan, nothing", () => {
    expect(chooseEntryCost([{ spendUsd: 10, units: 29 }], { costPerEntryUsd: 0.4, basis: "fleet" }, rngOf(1))).toMatchObject({ source: "plan", usdPerUnit: 0.4, planBasis: "fleet", draws: [0.4] });
    expect(chooseEntryCost([], { costPerEntryUsd: null, basis: null }, rngOf(1))).toBeNull();
  });
});

const NOW = "2026-06-01T00:00:00.000Z";
const sure = (rate: number) => ({ shape: 1e6, rate: 1e6 / rate }); // a yield known almost exactly
const sameDay = { cdf: [{ hours: 24, share: 1 }] };
const base = (over: Partial<ForecastInput>): ForecastInput => ({
  now: NOW,
  milestones: [{ step: "a", label: "A", unitsByDay: [] }, { step: "b", label: "B", unitsByDay: [] }],
  yields: [sure(0.1)],
  delays: [sameDay],
  entryCostDraws: [1],
  spendUsd: Array.from({ length: 400 }, () => 100),
  targetRevenueUsd: 500,
  seriesDays: 30,
  searchDays: 365,
  draws: 400,
  seed: 7,
  ...over,
});

describe("forecastOf (the projection)", () => {
  it("money buys first-milestone Units day by day; each transition thins them by its yield", () => {
    const f = forecastOf(base({}));
    expect(f.days[0]).toBe("2026-06-02");
    expect(f.days).toHaveLength(30);
    const [a, b] = f.outcomes;
    // $100 a day at $1 a Unit: day +10 closes 11 segments (today in full, since now is midnight) = 1,100 A, 110 B.
    expect(a!.cumulativeUnits.expected[9]).toBeCloseTo(1100, 0);
    expect(Math.abs(a!.cumulativeUnits.median[9]! - 1100)).toBeLessThan(15);
    expect(b!.cumulativeUnits.expected[9]).toBeCloseTo(110, 0);
    expect(b!.cumulativeUnits.p10[9]!).toBeLessThan(b!.cumulativeUnits.median[9]!);
    expect(b!.cumulativeUnits.p90[9]!).toBeGreaterThan(b!.cumulativeUnits.median[9]!);
    expect(b!.cumulativeUnits.p10[9]!).toBeGreaterThan(90); // Poisson(110): p10 = 97
    expect(b!.isTarget).toBe(true);
    expect(f.spendAheadUsd[9]).toBe(1100);
    expect(f.expectedRevenueUsd!.expected[9]).toBeCloseTo(55000, -2);
    expect(a!.unitsPerTarget!.median).toBeCloseTo(10, 1);
    expect(a!.expectedRevenuePerUnitUsd!.median).toBeCloseTo(50, 0);
    expect(b!.expectedRevenuePerUnitUsd!.median).toBe(500);
    expect(f.nextTarget).toMatchObject({ shareWithinSearch: 1, medianInDays: 0, medianDate: "2026-06-01", expectedOneInDays: 0, expectedOneByDate: "2026-06-01" });
  });

  it("Units already produced keep maturing along the delay curve, with no spend at all", () => {
    // 1,000 A made 2 days ago; B arrives evenly over 10 days: 2 days are gone, 8 remain = 80% of 1,000 x 10% = 80 B to come.
    const f = forecastOf(base({ spendUsd: [], milestones: [{ step: "a", label: "A", unitsByDay: [{ date: "2026-05-30", units: 1000 }] }, { step: "b", label: "B", unitsByDay: [{ date: "2026-05-31", units: 7 }] }], delays: [{ cdf: [{ hours: 240, share: 1 }] }] }));
    const b = f.outcomes[1]!;
    expect(b.unitsToDate).toBe(7);
    expect(f.outcomes[0]!.cumulativeUnits.median[29]).toBe(1000); // nothing bought
    expect(b.cumulativeUnits.expected[29]).toBeCloseTo(87, 0);
    expect(b.cumulativeUnits.expected[7]).toBeCloseTo(87, 0); // all arrived once the curve ends
    expect(b.cumulativeUnits.expected[2]).toBeCloseTo(7 + 40, 0); // today + 3 days = 4 of the 8 days left
    expect(f.spendAheadUsd[29]).toBe(0);
    expect(f.expectedRevenueUsd!.expected[29]).toBeCloseTo(80 * 500, -3); // revenue ahead only: the 7 already made are not in it
  });

  it("a rare Target: the tunnel is wide and the next one can fall beyond the search", () => {
    // $1 a day at $1 a Unit, 1 Target per 500 Units: one Target every ~500 days.
    const f = forecastOf(base({ spendUsd: Array.from({ length: 400 }, () => 1), yields: [{ shape: 2, rate: 1000 }], draws: 1000 }));
    expect(f.nextTarget.shareWithinSearch).toBeGreaterThan(0.25);
    expect(f.nextTarget.shareWithinSearch).toBeLessThan(0.75);
    expect(f.nextTarget.earlyDate).not.toBeNull();
    expect(f.nextTarget.lateDate).toBeNull(); // later than the search in the slow case: said, never a made-up date
    // The mean pace: 1 Unit a day x 0.2% = one Target expected every 500 days, past the 365 searched here.
    expect(f.nextTarget.expectedOneInDays).toBeNull();
    const longer = forecastOf(base({ spendUsd: Array.from({ length: 900 }, () => 1), yields: [sure(0.002)], searchDays: 800 }));
    expect(longer.nextTarget.expectedOneInDays).toBe(499); // segments 0..499 = 500 days of $1
    expect(longer.nextTarget.expectedOneByDate).toBe("2027-10-13");
    expect(f.outcomes[1]!.cumulativeUnits.median[29]).toBe(0);
    expect(f.outcomes[1]!.cumulativeUnits.expected[29]!).toBeGreaterThan(0);
  });

  it("the same inputs give the same projection (a stored body does not flicker)", () => {
    expect(forecastOf(base({}))).toEqual(forecastOf(base({})));
  });
});

describe("campaignForecastOf (hypotheses named, alternative budgets)", () => {
  const capacity: SpendCapacityInput = { campaignStatus: "ongoing", budget: { period: "monthly", amountUsd: 300, periodEnd: "2026-07-01T00:00:00.000Z", remainingUsd: 0, reached: true }, volumeReached: null, unreadableReason: null };
  const days = (n: number, from: string, units: number) => Array.from({ length: n }, (_, k) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10), units }));
  const stats: Record<string, TransitionStat> = {
    "campaign|k_a|k_b": stat(3000, 2700, 2700),
    "fleet|k_a|k_b": stat(90000, 80000, 80000),
    "campaign|k_b|k_c": stat(2700, 2, 2),
    "brand|k_b|k_c": stat(2700, 2, 2),
    "fleet|k_b|k_c": stat(200000, 150, 150),
    "fleet|k_c|k_d": stat(160, 3, 3),
  };
  const input: CampaignForecastInput = {
    now: NOW,
    salesFunnelCampaignId: "c1",
    hasTarget: true,
    milestones: [
      { step: "a", label: "A", ledgerKeys: ["k_a"], unitsByDay: days(30, "2026-05-01", 100), neededPerTarget: 20000 },
      { step: "b", label: "B", ledgerKeys: ["k_b", "k_b2"], unitsByDay: days(30, "2026-05-01", 90), neededPerTarget: 18000 },
      { step: "c", label: "C", ledgerKeys: ["k_c"], unitsByDay: [{ date: "2026-05-20", units: 2 }], neededPerTarget: 20 },
      { step: "d", label: "D", ledgerKeys: ["k_d"], unitsByDay: [], neededPerTarget: 1 },
    ],
    spendByDay: days(30, "2026-05-01", 0).map((d) => ({ date: d.date, spendUsd: 10 })),
    capacity,
    spendPerDayUsd: 10,
    spendPerDaySource: "daily_budget",
    plan: { costPerTargetUsd: 3000, basis: "default" },
    targetValueUsd: 75000,
    transition: (scope, a, b) => stats[`${scope}|${a}|${b}`] ?? null,
    silverComputedAt: "2026-06-01T00:00:00.000Z",
  };

  it("names, per figure, the scope it came from and the budget assumed", () => {
    const body = campaignForecastOf(input);
    expect(body.unavailableReason).toBeNull();
    expect(body.hypotheses.budget).toMatchObject({ source: "budget_cap", hypothesis: "the_stated_budget_continues", monthlyUsd: 300, capPeriod: "monthly", pausedReason: "budget_cap_reached", resumesAt: "2026-07-01T00:00:00.000Z" });
    expect(body.hypotheses.entryCost).toMatchObject({ step: "a", source: "campaign", usdPerUnit: 0.1, spentUsd: 300, units: 3000 });
    const [ab, bc, cd] = body.hypotheses.transitions;
    expect(ab).toMatchObject({ fromStep: "a", toStep: "b", fromOutcomeKey: "k_a", toOutcomeKey: "k_b" });
    expect(ab!.yield.source).toBe("campaign");
    expect(ab!.delay).toMatchObject({ source: "campaign", pairs: 2700, thinSample: false });
    expect(bc!.yield.source).toBe("campaign"); // 2,700 from-Units outweigh the prior's 500
    expect(bc!.delay).toMatchObject({ source: "fleet", pairs: 150 }); // 2 pairs is thin: the fleet's curve
    expect(cd!.yield).toMatchObject({ source: "fleet", thinnerScopes: [] }); // the campaign never paired c -> d
    expect(cd!.delay).toMatchObject({ source: "fleet", pairs: 3, thinSample: true });
    expect(body.hypotheses.targetValue).toEqual({ usd: 75000, source: "plan_target_value" });
  });

  it("the cap reached holds the spend until its window resets; a bigger budget brings the Target sooner", () => {
    const body = campaignForecastOf(input);
    const f = body.forecast!;
    expect(f.outcomes.map((o) => o.step)).toEqual(["a", "b", "c", "d"]);
    expect(f.outcomes[0]!.unitsToDate).toBe(3000);
    expect(f.spendAheadUsd[28]).toBe(0); // June: the cap is spent
    expect(f.spendAheadUsd[59]).toBe(300); // July's $300 at $10 a day, spent by the 30th
    expect(f.spendAheadUsd[60]).toBe(300 + 10 * 1); // August 1 opens a new window
    expect(body.alternatives.map((a) => a.monthlyBudgetUsd)).toEqual([600, 1500, 3000]);
    // At twice the budget the extra $300 is spendable now (the cap is no longer reached).
    expect(body.alternatives[0]!.spendAheadUsd[28]).toBeGreaterThan(0);
    const share = [body.forecast!.nextTarget.shareWithinSearch, ...body.alternatives.map((a) => a.nextTarget.shareWithinSearch)];
    expect(share[3]!).toBeGreaterThan(share[0]!);
    const d0 = body.forecast!.nextTarget.medianInDays;
    const d3 = body.alternatives[2]!.nextTarget.medianInDays;
    expect(d3).not.toBeNull();
    if (d0 !== null) expect(d3!).toBeLessThan(d0);
  });

  it("never blank: what cannot be projected says why", () => {
    expect(campaignForecastOf({ ...input, hasTarget: false })).toMatchObject({ unavailableReason: "campaign_states_no_target", forecast: null });
    expect(campaignForecastOf({ ...input, transition: () => null, milestones: input.milestones.map((m) => ({ ...m, neededPerTarget: null, unitsByDay: [] })) })).toMatchObject({ unavailableReason: "yield_unmeasured:a->b", forecast: null });
    // A stopped campaign spends nothing more: what already ran still matures, and the reason is on the budget.
    const stopped = campaignForecastOf({ ...input, capacity: { ...capacity, campaignStatus: "stopped" } });
    expect(stopped.hypotheses.budget).toMatchObject({ source: null, unavailableReason: "campaign_stopped", monthlyUsd: null });
    expect(stopped.forecast!.spendAheadUsd[547]).toBe(0);
    expect(stopped.alternatives).toEqual([]);
  });

  it("scaledCapacity: the budget had it been m times what it is, from now", () => {
    expect(scaledCapacity(capacity, 5).budget).toMatchObject({ amountUsd: 1500, remainingUsd: 1200, reached: false });
    expect(scaledCapacity(capacity, 1)).toBe(capacity);
  });
});
