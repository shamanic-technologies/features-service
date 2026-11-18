import { describe, it, expect } from "vitest";
import { campaignForecastOf, chooseDelay, chooseEntryCost, chooseYield, delayQuantileOf, forecastOf, lagSharesOf, mixDelayCurves, rngOf, scaledCapacity, DEFAULT_DELAY_MEDIAN_DAYS, PLAN_LINE_SPREAD_CASES, type CampaignForecastInput, type ForecastInput } from "./outcome-forecast.js";
import { gammaQuantile, rateEstimateOf, type DelayDistribution, type TransitionStat } from "./outcome-silver.js";
import type { SpendCapacityInput } from "./spend-capacity.js";

const prior = { shape: 0.5, rate: 500 };
const delayOf = (n: number, hours = 48): DelayDistribution => ({ n, meanHours: hours, medianHours: hours, p10Hours: hours / 2, p25Hours: hours / 2, p75Hours: hours * 2, p90Hours: hours * 2, cdf: [{ hours: hours * 2, share: 1 }] });
const stat = (fromUnits: number, toUnits: number, pairs = 0): TransitionStat => ({ fromUnits, toUnits, foreignToUnits: 0, linkedToUnits: pairs, linkCoverage: toUnits > 0 ? pairs / toUnits : null, exposure: fromUnits, censoredBy: null, yield: rateEstimateOf({ toUnits, exposure: fromUnits }, prior), prior, delay: pairs > 0 ? delayOf(pairs) : null });

describe("chooseYield: each level blended into the one below by its own cases (THIN-SAMPLE-BLEND-1118)", () => {
  const none = { campaign: null, brand: null, fleet: null };
  const mean = (y: { shape: number; rate: number }) => y.shape / y.rate;

  it("n = 0 equals the fallback; a large n equals the measured rate; monotone between", () => {
    const plan = 0.04;
    // The fleet measured 10% over a growing exposure, against a plan line of 4%.
    const at = (exposure: number) => chooseYield({ campaign: null, brand: null, fleet: stat(exposure, exposure * 0.1) }, plan, { fromUnits: 0, toUnits: 0 })!;
    const zero = chooseYield({ campaign: null, brand: null, fleet: stat(0, 0) }, plan, { fromUnits: 0, toUnits: 0 })!;
    expect(mean(zero)).toBeCloseTo(plan, 12);
    expect(zero.source).toBe("plan");
    const sizes = [10, 30, 100, 250, 1000, 10_000, 1_000_000];
    const means = sizes.map((e) => mean(at(e)));
    for (let k = 1; k < means.length; k++) expect(means[k]!).toBeGreaterThan(means[k - 1]!);
    expect(means[0]!).toBeGreaterThan(plan);
    expect(means[means.length - 1]!).toBeCloseTo(0.1, 4);
    // The weight is the cases the fallback would expect over those + 10: 250 exposure at 4% = 10 expected cases = half.
    expect(at(250).blend[1]).toMatchObject({ level: "fleet", cases: 25, exposure: 250, measuredRate: 0.1, fallbackRate: 0.04, weight: 0.5 });
    expect(mean(at(250))).toBeCloseTo(0.07, 12);
    expect(at(250).source).toBe("fleet"); // an even split names the measured level
    expect(at(30).source).toBe("plan");
  });

  it("Wide Email's last step: 3 cases over 23 of exposure barely move the plan line (0.129 raw, 0.042 plan)", () => {
    const fleet: TransitionStat = { ...stat(70, 3), exposure: 23.3 };
    const y = chooseYield({ campaign: { ...stat(2, 0), exposure: 0.8 }, brand: { ...stat(2, 0), exposure: 0.8 }, fleet }, 1 / 24, { fromUnits: 2, toUnits: 0 })!;
    expect(y.source).toBe("plan");
    expect(y.blend.map((l) => l.level)).toEqual(["plan", "fleet", "campaign"]); // the brand holds nothing its campaign does not
    const [planLevel, fleetLevel, campaignLevel] = y.blend as [typeof y.blend[number], typeof y.blend[number], typeof y.blend[number]];
    expect(fleetLevel.measuredRate).toBeCloseTo(3 / 22.5, 9); // the fleet WITHOUT the campaign: no case weighs twice
    expect(fleetLevel.weight).toBeCloseTo(22.5 / 262.5, 9);
    expect(fleetLevel.blendedRate).toBeCloseTo(13 / 262.5, 9); // 0.0495, not 0.129
    expect(mean(y)).toBeGreaterThan(1 / 24);
    expect(mean(y)).toBeLessThan(0.05);
    expect(planLevel.share + fleetLevel.share + campaignLevel.share).toBeCloseTo(1, 12);
    expect(planLevel.share).toBeGreaterThan(0.9);
    expect(y.thinnerScopes).toEqual(["campaign", "brand"]);
  });

  it("a campaign with thousands of cases reads as itself; a thin one leans on its brand, then the fleet", () => {
    const thick = chooseYield({ campaign: stat(4000, 3600), brand: stat(4000, 3600), fleet: stat(90000, 200000) }, 0.5, { fromUnits: 4000, toUnits: 3600 })!;
    expect(thick.source).toBe("campaign");
    expect(mean(thick)).toBeCloseTo(0.9, 2);
    expect(thick.thinnerScopes).toEqual([]);
    const thin = chooseYield({ campaign: stat(100, 0), brand: stat(9100, 30), fleet: stat(99100, 230) }, null, { fromUnits: 100, toUnits: 0 })!;
    expect(thin.source).toBe("brand");
    expect(thin.thinnerScopes).toEqual(["campaign"]);
    expect(thin.blend.map((l) => [l.level, l.cases, l.exposure])).toEqual([["fleet", 200, 90000], ["brand", 30, 9000], ["campaign", 0, 100]]);
    expect(thin.blend[0]).toMatchObject({ fallbackRate: null, weight: 1 }); // no plan rate: the coarsest measured level stands alone
    // Each scope's evidence says how much of its counted Units the ledger's links tie.
    expect(chooseYield({ campaign: stat(3000, 2700, 1800), brand: null, fleet: stat(90000, 200, 150) }, null, { fromUnits: 3000, toUnits: 2700 })!.evidence).toEqual([
      { scope: "campaign", fromUnits: 3000, toUnits: 2700, linkedToUnits: 1800, linkCoverage: 1800 / 2700, exposure: 3000, delayPairs: 1800 },
      { scope: "fleet", fromUnits: 90000, toUnits: 200, linkedToUnits: 150, linkCoverage: 0.75, exposure: 90000, delayPairs: 150 },
    ]);
  });

  it("never measured anywhere: the plan line's rate blended with the campaign's own counts, then those counts alone, then nothing", () => {
    const plan = chooseYield(none, 0.05, { fromUnits: 2, toUnits: 0 })!;
    expect(plan.source).toBe("plan");
    expect(mean(plan)).toBeCloseTo(10 / 202, 12); // ten cases at 5%, pulled by 2 Units with nothing
    expect(chooseYield(none, null, { fromUnits: 50, toUnits: 5 })).toMatchObject({ source: "default", shape: 5.5, rate: 50 });
    expect(chooseYield(none, null, { fromUnits: 0, toUnits: 0 })).toBeNull();
  });
});

describe("FORECAST-FRESH-EVIDENCE-1118: a campaign's own cases count from day one", () => {
  it("Silver holds no row for the campaign yet: its page's live counts are its level, and nothing is taken from the fleet's", () => {
    // Prod 2026-11-18: 106 leads found, 79 messages sent, no Silver row; the fleet says 2.25 messages per lead found.
    const fleet = stat(18800, 42400, 40000);
    const without = chooseYield({ campaign: null, brand: null, fleet }, 0.8, { fromUnits: 106, toUnits: 79 })!;
    expect(without.source).toBe("fleet");
    expect(without.shape / without.rate).toBeGreaterThan(2.2);
    expect(without.campaignEvidence).toBeNull();
    const withLive = chooseYield({ campaign: null, brand: null, fleet }, 0.8, { fromUnits: 106, toUnits: 79 }, { toUnits: 79, exposure: 100 })!;
    expect(withLive).toMatchObject({ source: "campaign", campaignEvidence: "live_counts", thinnerScopes: [] });
    expect(withLive.blend.map((l) => [l.level, l.cases, l.exposure])).toEqual([["plan", null, null], ["fleet", 42400, 18800], ["campaign", 79, 100]]);
    expect(withLive.shape / withLive.rate).toBeGreaterThan(0.79);
    expect(withLive.shape / withLive.rate).toBeLessThan(0.9); // its own 0.79, pulled a little by the fleet's 2.25 (79 cases against 10)
    // A stored row wins over the live counts (it holds what the links say: Units made from another campaign left out).
    const stored = chooseYield({ campaign: stat(113, 106), brand: null, fleet }, 0.8, { fromUnits: 113, toUnits: 1087 }, { toUnits: 1087, exposure: 113 })!;
    expect(stored.campaignEvidence).toBe("silver");
    expect(stored.blend[2]).toMatchObject({ level: "campaign", cases: 106, exposure: 113 });
    expect(stored.blend[1]).toMatchObject({ level: "fleet", cases: 42294, exposure: 18687 }); // the fleet without the stored campaign
    // No exposure yet (nothing due): the campaign holds no evidence.
    expect(chooseYield({ campaign: null, brand: null, fleet }, 0.8, { fromUnits: 0, toUnits: 0 }, { toUnits: 0, exposure: 0 })!.campaignEvidence).toBeNull();
  });
});

describe("FORECAST-TUNNEL-1118: a guess does not narrow the range; a rate is drawn by the cases it is known by", () => {
  const none = { campaign: null, brand: null, fleet: null };
  const range = (y: { shape: number; rate: number }) => gammaQuantile(0.9, y.shape, y.rate) / gammaQuantile(0.1, y.shape, y.rate);

  it("a plan-line-only step is drawn from a wide range, a 1,000-case step from a tight one; the mean is the same blend", () => {
    const planOnly = chooseYield(none, 0.05, { fromUnits: 0, toUnits: 0 })!;
    expect(planOnly.shape / planOnly.rate).toBeCloseTo(0.05, 12);
    expect(planOnly.effectiveCases).toBe(PLAN_LINE_SPREAD_CASES); // half a case: a human's guess
    expect(planOnly.blend[0]).toMatchObject({ level: "plan", spreadCases: 0.5 });
    expect(range(planOnly)).toBeGreaterThan(100); // p90 over p10
    const thousand = chooseYield({ campaign: null, brand: null, fleet: stat(20000, 1000) }, 0.05, { fromUnits: 0, toUnits: 0 })!;
    expect(thousand.effectiveCases).toBe(1000.5);
    expect(range(thousand)).toBeLessThan(1.1);
    expect(thousand.shape / thousand.rate).toBeCloseTo(1010 / 20200, 12); // the mean still blends at 10 cases
    // 3 cases on a plan line: known by 3.5 cases, never by 13.
    const three = chooseYield({ campaign: null, brand: null, fleet: { ...stat(70, 3), exposure: 22.5 } }, 0.05, { fromUnits: 0, toUnits: 0 })!;
    expect(three.effectiveCases).toBe(3.5);
    expect(three.shape / three.rate).toBeCloseTo(13 / 222.5, 12);
    // A fallback well known counts for at most 10: 2 cases of a campaign on a fleet known by 68.
    const leaning = chooseYield({ campaign: stat(3500, 2), brand: null, fleet: stat(52500, 70) }, 0.0013, { fromUnits: 3500, toUnits: 2 })!;
    expect(leaning.blend.map((l) => l.spreadCases)).toEqual([0.5, 68.5, 12]);
    expect(leaning.effectiveCases).toBe(12);
  });

  it("the tunnel: a last step known by a guess leaves many draws without a Target in the horizon; known by 1,000 cases, nearly none; the expected day does not depend on it", () => {
    const run = (shape: number) =>
      forecastOf({
        now: "2026-06-01T00:00:00.000Z",
        milestones: [{ step: "a", label: "A", unitsByDay: [] }, { step: "b", label: "B", unitsByDay: [] }],
        yields: [{ shape, rate: shape / 0.01 }],
        delays: [{ cdf: [{ hours: 24, share: 1 }] }],
        entryCostDraws: [1],
        spendUsd: Array.from({ length: 401 }, () => 2), // 2 A a day x 1% = one B every 50 days on average
        targetRevenueUsd: null,
        seriesDays: 200,
        searchDays: 400,
        draws: 2000,
        seed: 7,
      });
    const guess = run(0.5);
    const known = run(1000);
    expect(known.nextTarget.shareWithinSearch).toBeGreaterThan(0.99);
    expect(guess.nextTarget.shareWithinSearch).toBeLessThan(0.9); // served: the share of draws reaching the Target
    expect(guess.nextTarget.shareWithinSearch).toBeGreaterThan(0.5);
    // Wider on the late side: a guess is mostly a LOW rate with a few high ones (same mean), so the median and the late
    // case come later (or beyond the horizon); the early case is the same small-day arithmetic for both.
    expect(guess.nextTarget.medianInDays!).toBeGreaterThan(known.nextTarget.medianInDays!);
    expect(guess.nextTarget.lateDate === null || guess.nextTarget.lateDate > known.nextTarget.lateDate!).toBe(true);
    // The expected count is the same mean rate: the day it reaches one moves only by sampling noise.
    expect(Math.abs(guess.nextTarget.expectedOneInDays! - known.nextTarget.expectedOneInDays!)).toBeLessThanOrEqual(8);
    expect(known.nextTarget.expectedOneInDays).toBeGreaterThan(44);
    expect(known.nextTarget.expectedOneInDays).toBeLessThan(56);
  });

  it("a delay curve resting on a default: each draw takes ONE curve by share, so the dates spread while the expected flow is the mixture's", () => {
    const fast = [{ hours: 24, share: 1 }];
    const slow = [{ hours: 24 * 199, share: 0 }, { hours: 24 * 200, share: 1 }];
    const input = (delays: ForecastInput["delays"]): ForecastInput => ({
      now: "2026-06-01T00:00:00.000Z",
      milestones: [{ step: "a", label: "A", unitsByDay: [] }, { step: "b", label: "B", unitsByDay: [] }],
      yields: [{ shape: 1e6, rate: 1e6 / 0.5 }],
      delays,
      entryCostDraws: [1],
      spendUsd: [0, 40, ...Array.from({ length: 499 }, () => 0)], // 40 A on day 1 = 20 B, when the delay lets them
      targetRevenueUsd: null,
      seriesDays: 300,
      searchDays: 500,
      draws: 1000,
      seed: 3,
    });
    const mixture = mixDelayCurves(fast, slow, 0.5);
    const fixed = forecastOf(input([{ cdf: mixture }]));
    const drawn = forecastOf(input([{ cdf: mixture, curves: [{ share: 0.5, cdf: fast }, { share: 0.5, cdf: slow }] }]));
    const b = (f: typeof fixed) => f.outcomes[1]!.cumulativeUnits;
    // The mixture alone: every draw holds about 10 B by day 100. One curve per draw: half hold 20, half none.
    expect(b(fixed).p10[99]!).toBeGreaterThan(4);
    expect(b(drawn).p10[99]!).toBe(0);
    expect(b(drawn).p90[99]!).toBeGreaterThan(14);
    // The expected flow is the same mixture.
    expect(Math.abs(b(drawn).expected[99]! - b(fixed).expected[99]!)).toBeLessThan(1.5);
    expect(b(drawn).expected[299]!).toBeCloseTo(20, 0);
    // A curve weighing under 2% is not drawn; a transition stating no mixture draws nothing more.
    const tiny = forecastOf(input([{ cdf: fast, curves: [{ share: 0.99, cdf: fast }, { share: 0.01, cdf: slow }] }]));
    expect(b(tiny).p10[99]!).toBeGreaterThan(10);
    expect(chooseDelay({ campaign: null, brand: null, fleet: stat(1, 1, 2) }).curves.map((c) => [c.level, c.share])).toEqual([["default", 10 / 12], ["fleet", 2 / 12]]);
  });
});

describe("chooseDelay: each measured curve mixed into the one below by its own pairs (THIN-SAMPLE-BLEND-1118)", () => {
  it("no pair anywhere: the default, half within 21 days", () => {
    const d = chooseDelay({ campaign: null, brand: stat(5, 0), fleet: null });
    expect(d).toMatchObject({ source: "default", pairs: 0, thinSample: false });
    expect(d.medianHours).toBeCloseTo(DEFAULT_DELAY_MEDIAN_DAYS * 24, 6);
    const lag = lagSharesOf(d.cdf);
    expect(lag.slice(0, 21).reduce((a, v) => a + v, 0)).toBeCloseTo(0.5, 2);
    expect(lag.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
  });
  it("2 pairs no longer set the curve alone: the default still weighs most, and it says so", () => {
    const d = chooseDelay({ campaign: null, brand: null, fleet: stat(1, 1, 2) });
    expect(d.source).toBe("default");
    expect(d.blend).toEqual([{ level: "default", pairs: 0, medianHours: 504, weight: 1, share: 10 / 12 }, { level: "fleet", pairs: 2, medianHours: 48, weight: 2 / 12, share: 2 / 12 }]);
    expect(d.medianHours).toBeLessThan(504);
    expect(d.medianHours).toBeGreaterThan(300);
    expect(mixDelayCurves([{ hours: 10, share: 1 }], [{ hours: 20, share: 1 }], 0.25)).toEqual([{ hours: 10, share: 0.625 }, { hours: 20, share: 1 }]);
    expect(delayQuantileOf([{ hours: 10, share: 0.625 }, { hours: 20, share: 1 }], 0.5)).toBe(8);
  });
  it("thousands of pairs read as themselves; a level counts only the pairs the finer ones do not hold", () => {
    const d = chooseDelay({ campaign: stat(1, 1, 3000), brand: stat(1, 1, 3000), fleet: stat(1, 1, 3400) });
    expect(d).toMatchObject({ source: "campaign", pairs: 3000, thinSample: false });
    expect(d.blend.map((l) => [l.level, l.pairs])).toEqual([["default", 0], ["fleet", 400], ["campaign", 3000]]); // the brand IS the campaign
    expect(d.medianHours).toBeCloseTo(48, 0);
    const thin = chooseDelay({ campaign: stat(1, 1, 3), brand: stat(1, 1, 15), fleet: stat(1, 1, 415) });
    expect(thin).toMatchObject({ source: "brand", pairs: 15, thinSample: false }); // 12 pairs of its own weigh just over half
    expect(thin.blend.map((l) => [l.level, l.pairs])).toEqual([["default", 0], ["fleet", 400], ["brand", 12], ["campaign", 3]]);
    expect(thin.blend.reduce((a, l) => a + l.share, 0)).toBeCloseTo(1, 12);
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
    // THIN-SAMPLE-BLEND-1118: 2 cases of its own barely move what the rest of the fleet measured (148 cases).
    expect(bc!.yield).toMatchObject({ source: "fleet", thinnerScopes: ["campaign", "brand"], pseudoCases: 10 });
    expect(bc!.yield.blend.map((l) => l.level)).toEqual(["plan", "fleet", "campaign"]);
    expect(bc!.yield.blend[2]!.blendedRate).toBe(bc!.yield.unitsPerUnit); // the last level's blended rate IS the rate used
    expect(bc!.delay).toMatchObject({ source: "fleet", pairs: 150 }); // 2 pairs is thin: the fleet's curve weighs most
    // 3 cases fleet-wide against a plan line: the plan line still weighs most, and the blend says how much each weighs.
    // The campaign's own level is there from its live counts (2 `c` Units, none became `d` yet), weighing little.
    expect(cd!.yield).toMatchObject({ source: "plan", thinnerScopes: ["campaign"], campaignEvidence: "live_counts" });
    expect(cd!.yield.blend.map((l) => [l.level, l.cases])).toEqual([["plan", null], ["fleet", 3], ["campaign", 0]]);
    expect(cd!.yield.unitsPerUnit).toBeGreaterThan(3 / 160);
    expect(cd!.yield.unitsPerUnit).toBeLessThan(0.05);
    expect(cd!.delay).toMatchObject({ source: "default", pairs: 0, thinSample: false });
    expect(cd!.delay.blend.map((l) => [l.level, l.pairs])).toEqual([["default", 0], ["fleet", 3]]);
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
