import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildSilverStats,
  delayBinRange,
  delayCdfAt,
  delayDistributionOf,
  distributionOf,
  fitGammaPrior,
  gammaP,
  gammaQuantile,
  rateEstimateOf,
  FLEET_SCOPE_ID,
  type SilverStatRow,
  type TransitionStat,
  type UnitCostStat,
} from "./outcome-silver.js";
import { unitRowOf } from "./outcome-silver-io.js";

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
      { outcomeKey: "alpha", campaignId: "u1", brandId: "B1", day: "2026-01-01", units: 100 },
      { outcomeKey: "alpha", campaignId: "u1", brandId: "B1", day: "2026-02-28", units: 100 },
      { outcomeKey: "beta", campaignId: "u2", brandId: "B1", day: "2026-01-03", units: 20 },
      { outcomeKey: "alpha", campaignId: "u3", brandId: "B1", day: "2026-01-01", units: 300 },
      { outcomeKey: "alpha", campaignId: "u4", brandId: "B2", day: "2026-01-01", units: 600 },
      { outcomeKey: "beta", campaignId: "u4", brandId: "B2", day: "2026-01-02", units: 30 },
    ],
    unitCosts: [
      { outcomeKey: "alpha", campaignId: "u1", brandId: "B1", costNetCents: 10, units: 150, sumNetCents: 1500, sumGrossCents: 3000 },
      { outcomeKey: "alpha", campaignId: "u1", brandId: "B1", costNetCents: 30, units: 50, sumNetCents: 1500, sumGrossCents: 3000 },
      { outcomeKey: "alpha", campaignId: "u4", brandId: "B2", costNetCents: 50, units: 600, sumNetCents: 30000, sumGrossCents: 30000 },
    ],
    pairBins: [
      // F1: 20 beta Units came 48-72 h after an alpha Unit (alpha in u1, beta in u2: same funnel campaign).
      { fromKey: "alpha", toKey: "beta", fromCampaignId: "u1", toCampaignId: "u2", brandId: "B1", bin: 13, pairs: 20, sumHours: 1200 },
      // F3: 30 pairs at 24-36 h.
      { fromKey: "alpha", toKey: "beta", fromCampaignId: "u4", toCampaignId: "u4", brandId: "B2", bin: 11, pairs: 30, sumHours: 900 },
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
    expect(fleet.prior.shape / fleet.prior.rate).toBeCloseTo(50 / 1000, 9); // pooled over the campaigns' exposure (100 + 300 + 600)
    // Brand scope pools its campaigns.
    expect(transition("brand", "B1")).toMatchObject({ fromUnits: 500, toUnits: 20 });
  });

  it("a pair whose two Units sit in different funnel campaigns is no campaign's pair", () => {
    const s = buildSilverStats({
      today,
      funnelOf,
      unitDays: [{ outcomeKey: "alpha", campaignId: "u1", brandId: "B1", day: "2026-01-01", units: 10 }],
      unitCosts: [],
      pairBins: [{ fromKey: "alpha", toKey: "beta", fromCampaignId: "u1", toCampaignId: "u3", brandId: "B1", bin: 5, pairs: 4, sumHours: 14 }],
    });
    const t = (scope: string, id: string) => (s.find((r) => r.scope === scope && r.scopeId === id && r.fromKey === "alpha")!.body as { stat: TransitionStat }).stat;
    expect(t("campaign", "F1").toUnits).toBe(0);
    expect(t("brand", "B1").toUnits).toBe(4);
    expect(t("fleet", FLEET_SCOPE_ID).toUnits).toBe(4);
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
  return ["./outcome-silver.ts", "./outcome-silver-io.ts", "../routes/outcome-distributions.ts"];
}
