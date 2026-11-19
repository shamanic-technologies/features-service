import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildSilverStats,
  delayBinRange,
  delayCdfAt,
  delayDistributionOf,
  distributionOf,
  DELAY_EDGES_HOURS,
  EXACT_DELAY_MAX_PAIRS,
  fitGammaPrior,
  gammaP,
  gammaQuantile,
  rateEstimateOf,
  FLEET_SCOPE_ID,
  ENTRY_COST_FROM_KEY,
  type EntryCostStat,
  type PairBinRow,
  type SilverStatRow,
  type TransitionStat,
  type UnitCostStat,
} from "./outcome-silver.js";
import { linkPageChanges, linkRowOf, linkSourceOf, unitRowOf, type LedgerUnitLink } from "./outcome-silver-io.js";
import { carriedLedgerUnits, sumLedgerUnits } from "./campaign-ledger-units-client.js";

describe("distributionOf (cost per Unit)", () => {
  it("mean, median and percentiles of weighted points, with the sample size", () => {
    // 10 Units: 6 at $1, 3 at $2, 1 at $10.
    const d = distributionOf([{ value: 2, weight: 3 }, { value: 1, weight: 6 }, { value: 10, weight: 1 }])!;
    expect(d).toEqual({ n: 10, mean: 2.2, median: 1, p10: 1, p25: 1, p75: 2, p90: 2 });
  });
  it("takes the exact sum when the points are binned, and is null without a sample", () => {
    expect(distributionOf([{ value: 1.23, weight: 2 }], 2.468)!.mean).toBeCloseTo(1.234, 10);
    expect(distributionOf([])).toBeNull();
    expect(distributionOf([{ value: 3, weight: 0 }])).toBeNull();
  });
});

describe("delayDistributionOf (delay of a transition)", () => {
  it("quantiles interpolate inside the bin, the mean is exact, the curve is cumulative", () => {
    // bin 11 = [24 h, 36 h): 4 pairs; bin 13 = [48 h, 72 h): 4 pairs; bin 18 = [168 h, 240 h): 2 pairs.
    expect(delayBinRange(11)).toEqual([24, 36]);
    expect(delayBinRange(0)).toEqual([0, 0.25]);
    const d = delayDistributionOf(new Map([[13, 4], [11, 4], [18, 2]]), 700)!;
    expect(d.n).toBe(10);
    expect(d.meanHours).toBe(70);
    expect(d.p10Hours).toBeCloseTo(27, 6); // a quarter into [24, 36)
    expect(d.medianHours).toBeCloseTo(54, 6); // a quarter into [48, 72)
    expect(d.p90Hours).toBeCloseTo(204, 6); // half of [168, 240)
    expect(d.cdf).toEqual([{ hours: 24, share: 0 }, { hours: 36, share: 0.4 }, { hours: 48, share: 0.4 }, { hours: 72, share: 0.8 }, { hours: 168, share: 0.8 }, { hours: 240, share: 1 }]);
    expect(delayCdfAt(d.cdf, 0)).toBe(0);
    expect(delayCdfAt(d.cdf, 18)).toBe(0);
    expect(delayCdfAt(d.cdf, 30)).toBeCloseTo(0.2, 6);
    expect(delayCdfAt(d.cdf, 54)).toBeCloseTo(0.5, 6);
    expect(delayCdfAt(d.cdf, 100)).toBeCloseTo(0.8, 6);
    expect(delayCdfAt(d.cdf, 9999)).toBe(1);
    expect(delayDistributionOf(new Map(), 0)).toBeNull();
  });
});

describe("the yield estimate (Gamma-Poisson)", () => {
  it("gamma quantiles match closed forms", () => {
    expect(gammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(gammaQuantile(0.5, 1, 1)).toBeCloseTo(Math.LN2, 6);
    expect(gammaQuantile(0.9, 1, 2)).toBeCloseTo(Math.log(10) / 2, 6);
    // Gamma(0.5, 0.5) = chi-square with 1 degree of freedom: its median is 0.4549.
    expect(gammaQuantile(0.5, 0.5, 0.5)).toBeCloseTo(0.4549, 3);
  });
  it("a group's posterior is the prior plus its Units over its exposure, with an interval", () => {
    const e = rateEstimateOf({ toUnits: 2, exposure: 3000 }, { shape: 0.5, rate: 500 });
    expect(e.shape).toBe(2.5);
    expect(e.rate).toBe(3500);
    expect(e.mean).toBeCloseTo(2.5 / 3500, 12);
    expect(e.p10).toBeLessThan(e.median);
    expect(e.median).toBeLessThan(e.mean); // right-skewed
    expect(e.p90).toBeGreaterThan(e.mean);
    // No evidence = the prior itself: never a zero rate.
    expect(rateEstimateOf({ toUnits: 0, exposure: 0 }, { shape: 0.5, rate: 500 }).mean).toBeCloseTo(0.001, 12);
  });
  it("the fleet prior keeps the pooled rate; alike campaigns make it strong, unlike campaigns weak", () => {
    const alike = fitGammaPrior([{ toUnits: 10, exposure: 1000 }, { toUnits: 11, exposure: 1000 }, { toUnits: 9, exposure: 1000 }, { toUnits: 10, exposure: 1000 }]);
    const unlike = fitGammaPrior([{ toUnits: 0, exposure: 1000 }, { toUnits: 60, exposure: 1000 }, { toUnits: 1, exposure: 1000 }, { toUnits: 19, exposure: 1000 }]);
    expect(alike.shape / alike.rate).toBeCloseTo(0.01, 9);
    expect(unlike.shape / unlike.rate).toBeCloseTo(0.02, 9);
    expect(alike.rate).toBeGreaterThan(unlike.rate * 20);
    // Nothing ever made: half a Unit over the pooled exposure, never zero. One group: the weakest prior.
    expect(fitGammaPrior([{ toUnits: 0, exposure: 400 }, { toUnits: 0, exposure: 600 }]).shape / fitGammaPrior([{ toUnits: 0, exposure: 400 }, { toUnits: 0, exposure: 600 }]).rate).toBeCloseTo(0.0005, 9);
    expect(fitGammaPrior([{ toUnits: 5, exposure: 100 }])).toEqual({ shape: 0.5, rate: 10 });
    expect(fitGammaPrior([])).toEqual({ shape: 0.5, rate: 0.5 });
  });
});

describe("buildSilverStats (the three distributions at the three scopes)", () => {
  // Two funnel campaigns of brand B1 (F1 = unit campaigns u1 + u2, F2 = u3), one of brand B2 (F3 = u4). Outcomes are
  // made-up names on purpose: the build knows none.
  const funnelOf = (c: string) => ({ u1: "F1", u2: "F1", u3: "F2", u4: "F3" })[c] ?? null;
  const today = "2026-03-01";
  const stats = buildSilverStats({
    today,
    funnelOf,
    unitDays: [
      { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 100 },
      { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-02-28", units: 100 },
      { outcomeKey: "beta", campaignIds: ["u2"], brandId: "B1", day: "2026-01-03", units: 20 },
      { outcomeKey: "alpha", campaignIds: ["u3"], brandId: "B1", day: "2026-01-01", units: 300 },
      { outcomeKey: "alpha", campaignIds: ["u4"], brandId: "B2", day: "2026-01-01", units: 600 },
      { outcomeKey: "beta", campaignIds: ["u4"], brandId: "B2", day: "2026-01-02", units: 30 },
    ],
    unitCosts: [
      { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", costNetCents: 10, units: 150, sumNetCents: 1500, sumGrossCents: 3000 },
      { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", costNetCents: 30, units: 50, sumNetCents: 1500, sumGrossCents: 3000 },
      { outcomeKey: "alpha", campaignIds: ["u4"], brandId: "B2", costNetCents: 50, units: 600, sumNetCents: 30000, sumGrossCents: 30000 },
    ],
    pairBins: [
      // F1: 20 beta Units came 48-72 h after an alpha Unit (alpha in u1, beta in u2: same funnel campaign).
      { fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u1"], brandId: "B1", bin: 13, pairs: 20, sumHours: 1200, samplesHours: null },
      // F3: 30 pairs at 24-36 h.
      { fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u4"], brandId: "B2", bin: 11, pairs: 30, sumHours: 900, samplesHours: null },
    ],
    // Every beta Unit of F1 is tied by a link; 24 of F3's 30.
    linkedTo: [
      { fromKey: "alpha", toKey: "beta", campaignIds: ["u2"], brandId: "B1", sources: [{ campaignIds: ["u1"], brandId: "B1" }], units: 20 },
      { fromKey: "alpha", toKey: "beta", campaignIds: ["u4"], brandId: "B2", sources: [{ campaignIds: ["u4"], brandId: "B2" }], units: 24 },
    ],
  });
  const row = (scope: string, scopeId: string, fromKey: string, toKey: string) => stats.find((r) => r.scope === scope && r.scopeId === scopeId && r.fromKey === fromKey && r.toKey === toKey) as SilverStatRow | undefined;
  const transition = (scope: string, scopeId: string) => (row(scope, scopeId, "alpha", "beta")!.body as { stat: TransitionStat }).stat;
  const cost = (scope: string, scopeId: string) => (row(scope, scopeId, "", "alpha")!.body as { stat: UnitCostStat }).stat;

  it("cost per Unit: mean, median, percentiles and sample size per scope", () => {
    expect(cost("campaign", "F1")).toEqual({ units: 200, costUsd: { n: 200, mean: 0.15, median: 0.1, p10: 0.1, p25: 0.1, p75: 0.1, p90: 0.3 }, meanGrossCostUsd: 0.3 });
    expect(cost("brand", "B1").costUsd.n).toBe(200);
    const fleet = cost("fleet", FLEET_SCOPE_ID);
    expect(fleet.units).toBe(800);
    expect(fleet.costUsd.mean).toBeCloseTo(0.4125, 9);
    expect(fleet.costUsd.median).toBe(0.5);
    expect(row("campaign", "F2", "", "alpha")).toBeUndefined(); // no cost stated on its Units
  });

  it("delay: each scope's own pairs", () => {
    expect(transition("campaign", "F1").delay).toMatchObject({ n: 20, meanHours: 60, medianHours: 60 });
    expect(transition("campaign", "F3").delay).toMatchObject({ n: 30, meanHours: 30 });
    expect(transition("fleet", FLEET_SCOPE_ID).delay).toMatchObject({ n: 50, meanHours: 42 });
    expect(transition("campaign", "F2").delay).toBeNull();
  });

  it("yield: Units over CENSORED exposure, shrunk to the fleet prior, with its interval", () => {
    const f1 = transition("campaign", "F1");
    // 100 alpha Units are 59 days old (all due), 100 are one day old: at 36 h the F1 curve [48 h, 72 h) has let nothing through.
    expect(f1.fromUnits).toBe(200);
    expect(f1.toUnits).toBe(20);
    expect(f1.censoredBy).toBe("campaign");
    expect(f1.exposure).toBeCloseTo(100, 6);
    expect(f1.yield.shape).toBeCloseTo(f1.prior.shape + 20, 9);
    expect(f1.yield.rate).toBeCloseTo(f1.prior.rate + 100, 6);
    expect(f1.yield.p10).toBeLessThan(f1.yield.median);
    expect(f1.yield.p90).toBeGreaterThan(f1.yield.median);
    // F2 made 300 alpha and no beta: no delay of its own, censored by its brand's curve; a low yield, never zero.
    const f2 = transition("campaign", "F2");
    expect(f2).toMatchObject({ fromUnits: 300, toUnits: 0, censoredBy: "brand" });
    expect(f2.exposure).toBeCloseTo(300, 6);
    expect(f2.yield.mean).toBeGreaterThan(0);
    expect(f2.yield.mean).toBeLessThan(f1.yield.mean);
    // The prior is the fleet's, the same for every scope; the fleet row serves it as what a new campaign can expect.
    const fleet = transition("fleet", FLEET_SCOPE_ID);
    expect(fleet.fromUnits).toBe(1100);
    expect(fleet.toUnits).toBe(50);
    expect(fleet.prior).toEqual(f1.prior);
    expect(fleet.yield.mean).toBeCloseTo(fleet.prior.shape / fleet.prior.rate, 12);
    expect(fleet.prior.shape / fleet.prior.rate).toBeCloseTo(50 / fleet.exposure, 9); // the fleet's pooled rate, on its censored exposure
    // Brand scope pools its campaigns.
    expect(transition("brand", "B1")).toMatchObject({ fromUnits: 500, toUnits: 20 });
  });

  it("UNIT-LINKS-CONSUME-1117-FIX: the yield is counted on UNITS; a missing link never lowers it, the coverage says how much is tied", () => {
    // Prod 2026-11-17: a campaign made 4,157 `from` Units and 3,737 `to` Units, of which the ledger's links tie 2,495.
    const s = buildSilverStats({
      today,
      funnelOf,
      unitDays: [
        { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 4157 },
        { outcomeKey: "beta", campaignIds: ["u1"], brandId: "B1", day: "2026-01-03", units: 3737 },
        // Units no campaign carries: in no yield, on either side (nothing ties them to a funnel).
        { outcomeKey: "alpha", campaignIds: [], brandId: "B1", day: "2026-01-01", units: 1000 },
        { outcomeKey: "beta", campaignIds: [], brandId: "B1", day: "2026-01-03", units: 500 },
        // UNIT-LINK-COVERAGE-1117: Units of a campaign in NO sales funnel campaign (u9) are in no yield either: its sent
        // Units outnumber its found Units 9 to 1 because the found ones were made before the ledger held them.
        { outcomeKey: "alpha", campaignIds: ["u9"], brandId: "B1", day: "2026-01-01", units: 1000 },
        { outcomeKey: "beta", campaignIds: ["u9"], brandId: "B1", day: "2026-01-03", units: 9000 },
      ],
      unitCosts: [],
      pairBins: [{ fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u1"], brandId: "B1", bin: 12, pairs: 2495, sumHours: 2495 * 40, samplesHours: null }],
      linkedTo: [{ fromKey: "alpha", toKey: "beta", campaignIds: ["u1"], brandId: "B1", sources: [{ campaignIds: ["u1"], brandId: "B1" }], units: 2495 }, { fromKey: "alpha", toKey: "beta", campaignIds: ["u9"], brandId: "B1", sources: [{ campaignIds: ["u9"], brandId: "B1" }], units: 700 }],
    });
    const t = (scope: string, id: string) => (s.find((r) => r.scope === scope && r.scopeId === id && r.fromKey === "alpha")!.body as { stat: TransitionStat }).stat;
    const f1 = t("campaign", "F1");
    expect(f1).toMatchObject({ fromUnits: 4157, toUnits: 3737, linkedToUnits: 2495 });
    expect(f1.linkCoverage).toBeCloseTo(2495 / 3737, 12);
    // The yield is the counts' (0.90), not the links' (0.60).
    expect(f1.yield.mean).toBeGreaterThan(0.89);
    expect(f1.yield.mean).toBeLessThan(0.91);
    // The delay still comes from the linked pairs.
    expect(f1.delay!.n).toBe(2495);
    for (const [scope, id] of [["brand", "B1"], ["fleet", FLEET_SCOPE_ID]] as const) expect(t(scope, id)).toMatchObject({ fromUnits: 4157, toUnits: 3737, linkedToUnits: 2495 });
    expect(t("fleet", FLEET_SCOPE_ID).prior.shape / t("fleet", FLEET_SCOPE_ID).prior.rate).toBeCloseTo(3737 / t("fleet", FLEET_SCOPE_ID).exposure, 9);
    // No `to` Unit at all: the coverage is unknown, never 0 or 1.
    const none = buildSilverStats({ today, funnelOf, unitDays: [{ outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 10 }, { outcomeKey: "alpha", campaignIds: ["u3"], brandId: "B1", day: "2026-01-01", units: 10 }, { outcomeKey: "beta", campaignIds: ["u3"], brandId: "B1", day: "2026-01-02", units: 1 }], unitCosts: [], pairBins: [{ fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u3"], brandId: "B1", bin: 5, pairs: 1, sumHours: 3.5, samplesHours: [3.5] }], linkedTo: [{ fromKey: "alpha", toKey: "beta", campaignIds: ["u3"], brandId: "B1", sources: [{ campaignIds: ["u3"], brandId: "B1" }], units: 1 }] });
    expect((none.find((r) => r.scope === "campaign" && r.scopeId === "F1" && r.fromKey === "alpha")!.body as { stat: TransitionStat }).stat).toMatchObject({ toUnits: 0, linkedToUnits: 0, linkCoverage: null });
  });

  it("UNIT-LINKS-CONSUME-1117-FIX: on a small sample the served quantiles are EXACT (n = 1, 2, 4), above the threshold they are read off the bins", () => {
    const binsOf = (hours: number[]) => {
      const m = new Map<number, number>();
      for (const h of hours) {
        const bin = DELAY_EDGES_HOURS.filter((e) => e <= h).length;
        m.set(bin, (m.get(bin) ?? 0) + 1);
      }
      return m;
    };
    const dist = (hours: number[], samples: number[] | null) => delayDistributionOf(binsOf(hours), hours.reduce((a, h) => a + h, 0), samples)!;
    // n = 1: every quantile is the pair's own delay.
    expect(dist([5], [5])).toMatchObject({ n: 1, meanHours: 5, medianHours: 5, p10Hours: 5, p90Hours: 5 });
    // n = 2: the median is the middle of the two.
    const two = dist([2, 10], [10, 2]);
    expect(two.medianHours).toBe(6);
    expect(two.p10Hours).toBeCloseTo(2.8, 9);
    expect(two.p90Hours).toBeCloseTo(9.2, 9);
    // n = 4 (prod 2026-11-17, four pairs: the bins read 36 h = 1.5 d where the pairs' median is 50.33 h = 2.097 d).
    const four = [30, 34, 66.66, 70];
    expect(dist(four, null).medianHours).toBe(36);
    expect(dist(four, four).medianHours).toBeCloseTo(50.33, 9);
    expect(dist(four, four).p25Hours).toBeCloseTo(33, 9);
    expect(dist(four, four).cdf).toEqual(dist(four, null).cdf); // the curve stays the bins'
    // Samples that do not cover every pair are not a sample of the whole: the bins answer.
    expect(dist(four, [30, 34]).medianHours).toBe(36);
    // A scope pools its groups' samples; one group too large to carry them (or more than the threshold in all) ends the exact read.
    const build = (rows: PairBinRow[]) => {
      const out = buildSilverStats({ today, funnelOf, unitDays: [{ outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 500 }], unitCosts: [], pairBins: rows, linkedTo: [] });
      return (out.find((r) => r.scope === "fleet" && r.fromKey === "alpha")!.body as { stat: TransitionStat }).stat.delay!;
    };
    const row = (campaign: string, hours: number[], withSamples = true): PairBinRow[] => [...binsOf(hours)].map(([bin, pairs]) => ({ fromKey: "alpha", toKey: "beta", fromCampaignIds: [campaign], brandId: "B1", bin, pairs, sumHours: hours.filter((h) => DELAY_EDGES_HOURS.filter((e) => e <= h).length === bin).reduce((a, h) => a + h, 0), samplesHours: withSamples ? hours.filter((h) => DELAY_EDGES_HOURS.filter((e) => e <= h).length === bin) : null }));
    expect(build([...row("u1", [30, 34]), ...row("u3", [66.66, 70])]).medianHours).toBeCloseTo(50.33, 9);
    expect(build([...row("u1", [30, 34]), ...row("u3", [66.66, 70], false)]).medianHours).toBe(36);
    expect(EXACT_DELAY_MAX_PAIRS).toBe(200);
    const many = Array.from({ length: 201 }, () => 25);
    expect(build(row("u1", many)).medianHours).toBe(30); // 201 pairs: the middle of the bin [24 h, 36 h)
    expect(build(row("u1", many.slice(0, 200))).medianHours).toBe(25); // 200 pairs: the pairs' own
  });
});

describe("FORECAST-ENTRY-COST-BASIS-1118: what campaigns spend ALL IN per Unit of their first milestone", () => {
  // F1 (brand B1): finds leads (u1) and sends (u2); F2 (B1) and F3 (B2) only write and send. Made-up outcome names.
  const funnelOf = (c: string) => ({ u1: "F1", u2: "F1", u3: "F2", u4: "F3" })[c] ?? null;
  const rank: Record<string, number | null> = { found: 1, written: null, sent: 2, replied: 3 };
  const rows = buildSilverStats({
    today: "2026-03-01",
    funnelOf,
    rankOf: (k) => rank[k] ?? null,
    unitDays: [
      { outcomeKey: "found", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 100 },
      { outcomeKey: "sent", campaignIds: ["u2"], brandId: "B1", day: "2026-01-02", units: 90 },
      { outcomeKey: "written", campaignIds: ["u3"], brandId: "B1", day: "2026-01-02", units: 40 },
      { outcomeKey: "sent", campaignIds: ["u3"], brandId: "B1", day: "2026-01-02", units: 40 },
      { outcomeKey: "written", campaignIds: ["u4"], brandId: "B2", day: "2026-01-02", units: 10 },
      { outcomeKey: "sent", campaignIds: ["u4"], brandId: "B2", day: "2026-01-02", units: 10 },
      { outcomeKey: "written", campaignIds: ["legacy"], brandId: "B1", day: "2026-01-02", units: 500 }, // in no sales funnel campaign
    ],
    unitCosts: [
      { outcomeKey: "found", campaignIds: ["u1"], brandId: "B1", costNetCents: 20, units: 100, sumNetCents: 2000, sumGrossCents: 2000 },
      { outcomeKey: "sent", campaignIds: ["u2"], brandId: "B1", costNetCents: 10, units: 90, sumNetCents: 900, sumGrossCents: 900 },
      { outcomeKey: "written", campaignIds: ["u3"], brandId: "B1", costNetCents: 7, units: 40, sumNetCents: 296, sumGrossCents: 296 },
      { outcomeKey: "sent", campaignIds: ["u3"], brandId: "B1", costNetCents: 0.1, units: 40, sumNetCents: 4, sumGrossCents: 4 },
      { outcomeKey: "written", campaignIds: ["u4"], brandId: "B2", costNetCents: 10, units: 10, sumNetCents: 100, sumGrossCents: 100 },
      { outcomeKey: "written", campaignIds: ["legacy"], brandId: "B1", costNetCents: 9, units: 500, sumNetCents: 4500, sumGrossCents: 4500 },
    ],
    pairBins: [],
    linkedTo: [],
  });
  const entry = (scope: string, id: string, key: string) => (rows.find((r) => r.scope === scope && r.scopeId === id && r.fromKey === ENTRY_COST_FROM_KEY && r.toKey === key)?.body as { stat: EntryCostStat } | undefined)?.stat;
  it("a campaign's first milestone is the lowest-rung outcome it makes; its cost is EVERYTHING it spent over those Units", () => {
    expect(entry("campaign", "F1", "found")).toEqual({ campaigns: 1, units: 100, spendUsd: 29 }); // finding and sending, per lead found
    // F2 makes written (on no rung) and sent: its first milestone is sent, at $3.00 / 40 = $0.075 all in (a send alone: $0.001).
    expect(entry("campaign", "F2", "sent")).toEqual({ campaigns: 1, units: 40, spendUsd: 3 });
    expect(entry("campaign", "F2", "written")).toBeUndefined();
    expect(entry("campaign", "F1", "sent")).toBeUndefined(); // sent is not F1's first milestone
  });
  it("a brand and the fleet pool the campaigns sharing a first milestone; a campaign in no sales funnel campaign is in none", () => {
    expect(entry("brand", "B1", "sent")).toEqual({ campaigns: 1, units: 40, spendUsd: 3 });
    expect(entry("brand", "B1", "found")).toEqual({ campaigns: 1, units: 100, spendUsd: 29 });
    expect(entry("fleet", FLEET_SCOPE_ID, "sent")).toEqual({ campaigns: 2, units: 50, spendUsd: 4 });
    expect(rows.filter((r) => r.fromKey === ENTRY_COST_FROM_KEY && r.scope === "fleet").map((r) => r.toKey).sort()).toEqual(["found", "sent"]);
    // Without the rung catalogue no such row is built.
    expect(buildSilverStats({ today: "2026-03-01", funnelOf, unitDays: [], unitCosts: [], pairBins: [], linkedTo: [] }).filter((r) => r.fromKey === ENTRY_COST_FROM_KEY)).toEqual([]);
  });
});

describe("UNIT-LINK-LEFTOVERS-1117: a `to` Unit the links tie only to another scope's `from` Units is in no yield of this one", () => {
  // Prod 2026-11-17: a campaign 10 days old found 113 leads and sent 1,087 first messages, one per lead: 106 to its own
  // leads, 981 to leads the brand's EARLIER campaigns (in no sales funnel campaign) had found. Counted whole it read 9.6.
  const funnelOf = (c: string) => ({ src: "F1", mail: "F1", other: "F2" })[c] ?? null;
  const s = buildSilverStats({
    today: "2026-03-01",
    funnelOf,
    unitDays: [
      { outcomeKey: "alpha", campaignIds: ["src"], brandId: "B1", day: "2026-01-01", units: 113 },
      { outcomeKey: "beta", campaignIds: ["mail"], brandId: "B1", day: "2026-01-03", units: 1087 },
      { outcomeKey: "alpha", campaignIds: ["other"], brandId: "B1", day: "2026-01-01", units: 400 },
    ],
    unitCosts: [],
    pairBins: [{ fromKey: "alpha", toKey: "beta", fromCampaignIds: ["src"], brandId: "B1", bin: 12, pairs: 106, sumHours: 106 * 40, samplesHours: null }],
    linkedTo: [
      { fromKey: "alpha", toKey: "beta", campaignIds: ["mail"], brandId: "B1", sources: [{ campaignIds: ["src"], brandId: "B1" }], units: 100 },
      // Tied to a `from` Unit of the campaign AND to one outside it: made from the campaign's own.
      { fromKey: "alpha", toKey: "beta", campaignIds: ["mail"], brandId: "B1", sources: [{ campaignIds: ["legacy"], brandId: "B1" }, { campaignIds: ["src"], brandId: "B1" }], units: 6 },
      // Tied only to leads of a campaign in no funnel campaign: outside every scope.
      { fromKey: "alpha", toKey: "beta", campaignIds: ["mail"], brandId: "B1", sources: [{ campaignIds: ["legacy"], brandId: "B1" }], units: 900 },
      // Tied only to leads of ANOTHER funnel campaign of the brand: outside the campaign, inside its brand and the fleet.
      { fromKey: "alpha", toKey: "beta", campaignIds: ["mail"], brandId: "B1", sources: [{ campaignIds: ["other"], brandId: "B1" }], units: 61 },
    ],
  });
  const t = (scope: string, id: string) => (s.find((r) => r.scope === scope && r.scopeId === id && r.fromKey === "alpha")!.body as { stat: TransitionStat }).stat;
  it("the campaign's yield is its own leads' (106 of 113), the 981 others are named, the 20 unlinked still count", () => {
    const f1 = t("campaign", "F1");
    expect(f1).toMatchObject({ fromUnits: 113, toUnits: 126, foreignToUnits: 961, linkedToUnits: 106 });
    expect(f1.linkCoverage).toBeCloseTo(106 / 126, 12);
    expect(f1.yield.mean).toBeLessThan(1.2);
  });
  it("the brand and the fleet keep what another of their funnel campaigns found, and leave out what no funnel campaign found", () => {
    for (const [scope, id] of [["brand", "B1"], ["fleet", FLEET_SCOPE_ID]] as const) expect(t(scope, id)).toMatchObject({ fromUnits: 513, toUnits: 187, foreignToUnits: 900, linkedToUnits: 167 });
  });
  it("reads a source as the SQL group spells it", () => {
    expect(linkSourceOf("a,b|B1")).toEqual({ campaignIds: ["a", "b"], brandId: "B1" });
    expect(linkSourceOf("|")).toEqual({ campaignIds: [], brandId: null });
    expect(linkSourceOf("a|")).toEqual({ campaignIds: ["a"], brandId: null });
  });
});

describe("UNIT-LINKS-CONSUME-1117: pairs, delays and campaigns come from the ledger's stored links", () => {
  const funnelOf = (c: string) => ({ u1: "F1", u2: "F1", u3: "F2" })[c] ?? null;
  const unit = (id: string, outcomeKey: string, at: string, campaignId: string | null, campaignIds: string[], brandIds = ["B1"]) => ({ id, outcomeKey, at, runId: "r", brandIds, campaignId, campaignIds });
  const link = (over: Partial<LedgerUnitLink> = {}): LedgerUnitLink => ({
    fromUnit: unit("11111111-1111-4111-8111-111111111111", "alpha", "2026-01-01T00:00:00.000Z", "u1", ["u1"]),
    toUnit: unit("22222222-2222-4222-8222-222222222222", "beta", "2026-01-03T00:00:00.000Z", null, ["u1"]),
    delaySeconds: 7200,
    removedAt: null,
    ...over,
  });

  it("the delay kept is the one the link STATES (delaySeconds), never a difference of dates worked out here", () => {
    // The two dates are 48 h apart; the ledger states 2 h: the stated delay is the one stored.
    const row = linkRowOf(link());
    expect(row.delaySeconds).toBe(7200);
    expect(row).toMatchObject({ fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u1"], toCampaignId: null, toCampaignIds: ["u1"], fromBrandId: "B1" });
    expect(() => linkRowOf(link({ delaySeconds: undefined as unknown as number }))).toThrow(/delaySeconds/);
    // A consumed Unit of two brands states no single brand.
    expect(linkRowOf(link({ fromUnit: unit("11111111-1111-4111-8111-111111111111", "alpha", "2026-01-01T00:00:00.000Z", "u1", ["u1"], ["B1", "B2"]) })).fromBrandId).toBeNull();
  });

  it("a link served with removedAt is dropped; a link served again replaces itself (the last state wins)", () => {
    const other = { ...link().toUnit, id: "33333333-3333-4333-8333-333333333333" };
    const page = [
      link({ delaySeconds: 10 }),
      link({ toUnit: other }),
      link({ delaySeconds: 99 }), // served again: moved
      link({ toUnit: other, removedAt: "2026-02-01T00:00:00.000Z" }), // no longer stands
    ];
    const { upserts, removals } = linkPageChanges(page);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ toUnitId: "22222222-2222-4222-8222-222222222222", delaySeconds: 99 });
    expect(removals).toEqual([{ fromUnitId: "11111111-1111-4111-8111-111111111111", toUnitId: other.id }]);
    // Removed then served standing again: it stands.
    expect(linkPageChanges([link({ removedAt: "2026-02-01T00:00:00.000Z" }), link()]).removals).toEqual([]);
  });

  it("a Unit declared late under no campaign counts for the campaign(s) its link names, once in the brand and the fleet", () => {
    const s = buildSilverStats({
      today: "2026-03-01",
      funnelOf,
      unitDays: [
        { outcomeKey: "alpha", campaignIds: ["u1"], brandId: "B1", day: "2026-01-01", units: 50 },
        // 4 late beta Units carried by u1, 1 carried by BOTH u1 and u3 (two funnel campaigns), 2 carried by none.
        { outcomeKey: "beta", campaignIds: ["u1"], brandId: "B1", day: "2026-01-05", units: 4 },
        { outcomeKey: "beta", campaignIds: ["u1", "u3"], brandId: "B1", day: "2026-01-06", units: 1 },
        { outcomeKey: "beta", campaignIds: [], brandId: "B1", day: "2026-01-06", units: 2 },
        { outcomeKey: "gamma", campaignIds: ["u1"], brandId: "B1", day: "2026-01-07", units: 2 },
        { outcomeKey: "gamma", campaignIds: ["u1", "u3"], brandId: "B1", day: "2026-01-07", units: 1 },
      ],
      unitCosts: [],
      pairBins: [
        { fromKey: "alpha", toKey: "beta", fromCampaignIds: ["u1"], brandId: "B1", bin: 13, pairs: 5, sumHours: 300, samplesHours: null },
        { fromKey: "beta", toKey: "gamma", fromCampaignIds: ["u1"], brandId: "B1", bin: 11, pairs: 2, sumHours: 60, samplesHours: null },
        { fromKey: "beta", toKey: "gamma", fromCampaignIds: ["u1", "u3"], brandId: "B1", bin: 11, pairs: 1, sumHours: 30, samplesHours: null },
      ],
      linkedTo: [],
    });
    const t = (scope: string, id: string, fromKey: string, toKey: string) => (s.find((r) => r.scope === scope && r.scopeId === id && r.fromKey === fromKey && r.toKey === toKey)?.body as { stat: TransitionStat } | undefined)?.stat;
    // The late beta Units are `from` Units of the campaign they carry: F1 holds 5 of them, F2 the one it shares.
    expect(t("campaign", "F1", "beta", "gamma")).toMatchObject({ fromUnits: 5, toUnits: 3 });
    expect(t("campaign", "F2", "beta", "gamma")).toMatchObject({ fromUnits: 1, toUnits: 1 });
    // Counted once in the brand and the fleet (the Unit two campaigns carry is one Unit); the Units no campaign carries are in no yield.
    expect(t("brand", "B1", "beta", "gamma")).toMatchObject({ fromUnits: 5, toUnits: 3 });
    expect(t("fleet", FLEET_SCOPE_ID, "beta", "gamma")).toMatchObject({ fromUnits: 5, toUnits: 3 });
    // The delay is the linked pairs' own.
    expect(t("campaign", "F1", "beta", "gamma")!.delay).toMatchObject({ n: 3, meanHours: 30 });
    expect(t("campaign", "F1", "alpha", "beta")).toMatchObject({ fromUnits: 50, toUnits: 5 });
  });

  it("the campaign page counts a carried Unit once, on the day it was made", () => {
    const carried = carriedLedgerUnits([
      { outcomeKey: "beta", day: "2026-01-05" },
      { outcomeKey: "beta", day: "2026-01-05" },
      { outcomeKey: "gamma", day: "2026-01-09" },
    ]);
    const own = { byOutcome: new Map([["beta", new Map([["2026-01-05", 1]])]]), daysMissing: ["2026-01-09"] };
    const sum = sumLedgerUnits([own, carried]);
    expect([...sum.byOutcome.get("beta")!]).toEqual([["2026-01-05", 3]]);
    expect([...sum.byOutcome.get("gamma")!]).toEqual([["2026-01-09", 1]]);
    expect(sum.daysMissing).toEqual(["2026-01-09"]);
  });

  it("no pair is worked out by subject and date any more: the read-side pairing is gone", () => {
    const io = readFileSync(new URL("./outcome-silver-io.ts", import.meta.url), "utf8");
    expect(io).not.toContain("x.subject = b.subject");
    expect(io).not.toContain("CROSS JOIN LATERAL");
    expect(io).toContain("FROM outcome_unit_links l WHERE l.from_key =");
    expect(io).toContain("/internal/stats/outcome-chains/unit-links");
    // Stats stored under an older rule are never served: both readers ask for the sweep made on today's rule.
    for (const route of ["../routes/outcome-forecast.ts", "../routes/outcome-distributions.ts"]) {
      const src = readFileSync(new URL(route, import.meta.url), "utf8");
      expect(src).toContain("readCurrentSilverSweep()");
      expect(src).not.toContain("readSilverSweepRecord");
    }
    expect(io).toContain("record.rule === SILVER_RULE ? record : null");
    // The campaign page reads the carried Units at its ledger call site.
    const page = readFileSync(new URL("../routes/campaign-targets.ts", import.meta.url), "utf8");
    expect(page).toContain("readCarriedUnits(row.units.map((u) => u.campaignId))");
    expect(page).toContain("carriedLedgerUnits(carried)");
  });
});

describe("unitRowOf (the copy of one ledger Unit)", () => {
  it("keeps the Unit as declared; one brand only when the run names exactly one", () => {
    const u = { id: "0108aa84-94f6-4042-9389-043632f17f5a", organizationId: "o1", outcomeKey: "alpha", subjectService: "svc", subjectId: "s1", declaredAt: "2026-11-10T00:31:45.569Z", tags: { brandIds: ["b1"], campaignId: "c1" }, reversal: null, cost: { netCents: "2.7679000000", grossCents: "5.5358000000" } };
    expect(unitRowOf(u)).toEqual({ id: u.id, outcomeKey: "alpha", subject: "svc:s1", declaredAt: new Date(u.declaredAt), orgId: "o1", brandId: "b1", campaignId: "c1", costNetCents: 2.7679, costGrossCents: 5.5358, reversed: false });
    expect(unitRowOf({ ...u, tags: { brandIds: ["b1", "b2"], campaignId: null }, cost: null, reversal: { reversedAt: "x" } })).toMatchObject({ brandId: null, campaignId: null, costNetCents: null, costGrossCents: null, reversed: true });
  });
});

describe("ONE mechanism: no code path keyed on an outcome, a channel or an Engine (OUTCOME-FORECAST-1117)", () => {
  // Every outcome the ledger holds today, every channel word, the lifecycle rungs: none may appear in the code (comments stripped).
  const BANNED = [
    "message_sent", "message_written", "lead_found", "lead_identified", "email_found", "email_checked", "company_researched", "website_visit", "lead_visited",
    "lead_interested", "signup", "conversation", "positive_reply", "meeting_booked", "meeting_attended", "paid_client", "purchase", "form_submitted", "booking_call",
    "post_published", "post_viewed", "newsletter", "backlink", "llm_completion", "audience_built",
    "email", "linkedin", "whatsapp", "threads", "instantly", "cold", "outreach", "reply", "replies", "meeting", "sourcing",
  ];
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const file of SILVER_AND_GOLD_FILES()) {
    it(`${file} names none`, () => {
      const code = stripComments(readFileSync(new URL(file, import.meta.url), "utf8")).toLowerCase();
      for (const word of BANNED) expect(code, `"${word}" in ${file}`).not.toMatch(new RegExp(`(^|[^a-z])${word}([^a-z]|$)`));
    });
  }
});

function SILVER_AND_GOLD_FILES(): string[] {
  return ["./outcome-silver.ts", "./outcome-silver-io.ts", "../routes/outcome-distributions.ts", "./outcome-forecast.ts", "../routes/outcome-forecast.ts", "./campaign-change-log.ts", "./campaign-change-log-io.ts", "../routes/campaign-changes.ts"];
}
