/**
 * ONE BASIS FOR EVERY RATIO — the pure pieces. Each case asserts the DIVERGENCE between the whole
 * history and the mature cohort, and that a ratio equals the totals it states it divides.
 */
import { describe, it, expect } from "vitest";
import { closedWonOf, WHOLE_BASIS, type RatioBasis } from "./ratio-basis.js";
import { buildRevenueOutcomes } from "./revenue-outcomes.js";
import { buildFunnelSteps, ALL_STEP_EVIDENCE } from "./funnel-steps.js";
import { buildCostEconomics } from "./cost-economics.js";
import type { EnginePerson } from "./revenue-engine.js";

function person(id: string, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId: id,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId: `o-${id}`,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    signals: { contacted: true, ...signals },
    ...extra,
  } as EnginePerson;
}

// Doc Dinners' shape: 26 positive replies over $5,503.46 committed; 23 of them in the mature cohort,
// whose spend is $3,984.27.
const ALL = Array.from({ length: 26 }, (_, i) => person(`r${i}`, { positiveReply: true }));
const MATURE = ALL.slice(0, 23);
const WHOLE_COST = { committedCents: 550346, actualCents: 543179 };
const MATURE_BASIS: RatioBasis = {
  kind: "mature",
  days: 14,
  cost: { committedCents: 398427, actualCents: 390000 },
  persons: MATURE,
};

describe("the volume half's rates ride the ROI's basis", () => {
  it("cost per positive reply = mature spend ÷ mature replies (~$173), not the whole history (~$212)", () => {
    const o = buildRevenueOutcomes(ALL, WHOLE_COST, MATURE_BASIS);
    expect(o.recipientsRepliesPositive).toBe(26);
    expect(o.committedSpentCents).toBe(550346);
    expect(o.cpprCents).toBeCloseTo(398427 / 23, 9);
    expect(o.cpprCents).not.toBeCloseTo(550346 / 26, 0);
    expect(o.cpprCents).toBeCloseTo(o.ratioBasis.committedSpentCents! / o.ratioBasis.recipientsRepliesPositive!, 9);
    expect(o.ratioBasis).toEqual({
      maturityDays: 14,
      committedSpentCents: 398427,
      recipientsClicked: 0,
      recipientsRepliesPositive: 23,
      unmeasuredReason: null,
    });
  });

  it("the whole basis is byte-identical to the rates without one", () => {
    const withBasis = buildRevenueOutcomes(ALL, WHOLE_COST, WHOLE_BASIS);
    const without = buildRevenueOutcomes(ALL, WHOLE_COST);
    expect(withBasis).toEqual(without);
    expect(without.cpprCents).toBeCloseTo(550346 / 26, 9);
  });

  it("unknown legs and an all-young scope null the rates with a named reason — never 0", () => {
    expect(buildRevenueOutcomes(ALL, WHOLE_COST, { kind: "unknown" }).ratioBasis.unmeasuredReason).toBe("maturity_unknown");
    const young = buildRevenueOutcomes(ALL, WHOLE_COST, {
      kind: "mature",
      days: 14,
      cost: { committedCents: 0, actualCents: 0 },
      persons: [],
    });
    expect(young.cpprCents).toBeNull();
    expect(young.ratioBasis).toMatchObject({ committedSpentCents: null, unmeasuredReason: "maturing" });
  });
});

describe("the funnel rungs' cost per reach rides the same basis", () => {
  it("divides the mature spend by the rung's mature count, and states both", () => {
    const persons = [
      ...Array.from({ length: 4 }, (_, i) => person(`m${i}`, { clicked: true })),
      ...Array.from({ length: 3 }, (_, i) => person(`y${i}`, { clicked: true })),
    ];
    const mature: RatioBasis = { kind: "mature", days: 14, cost: { committedCents: 6000, actualCents: 6000 }, persons: persons.slice(0, 4) };
    const f = buildFunnelSteps("form_magnet", persons, 10000, ALL_STEP_EVIDENCE, null, mature, 10000);
    const visit = f.steps[0];
    expect(visit.recipientsReached).toBe(7);
    expect(visit.ratioBasisRecipientsReached).toBe(4);
    expect(visit.costPerReachCents).toBeCloseTo(1500, 9);
    expect(f.committedSpentCents).toBe(10000);
    expect(f.ratioBasis).toEqual({ maturityDays: 14, committedSpentCents: 6000, unmeasuredReason: null });

    const whole = buildFunnelSteps("form_magnet", persons, 10000, ALL_STEP_EVIDENCE);
    expect(whole.steps[0].costPerReachCents).toBeCloseTo(10000 / 7, 9);
    expect(whole.steps[0].ratioBasisRecipientsReached).toBe(7);
  });
});

describe("costEconomics serves the totals its ratios divide, and a measured return", () => {
  it("roiMultiple = ratioBasis.totalPipelineUsd ÷ ratioBasis.committedCostUsd, and the measured return divides the same spend", () => {
    const ce = buildCostEconomics({
      committedCostInUsdCents: 550346,
      actualCostInUsdCents: 543179,
      totalPipelineUsd: 7759.14,
      lifetimeRevenueUsd: 2500,
      maturity: { days: 14, committedCostInUsdCents: 398427, totalPipelineUsd: 6023.97 },
      realized: { closedWonCount: 1, closedWonRevenueUsd: 2500 },
    });
    expect(ce.committedCostUsd).toBeCloseTo(5503.46, 9);
    expect(ce.ratioBasis).toEqual({ committedCostUsd: 3984.27, totalPipelineUsd: 6023.97 });
    expect(ce.roiMultiple).toBeCloseTo(6023.97 / 3984.27, 9);
    expect(ce.realizedReturn).toEqual({ closedWonCount: 1, closedWonRevenueUsd: 2500, roiMultiple: 2500 / 3984.27 });
    expect(ce.realizedReturn!.roiMultiple).toBeCloseTo(0.627, 3);
  });

  it("no realized input → null, never a fabricated 0; maturity unknown → every basis total null", () => {
    const plain = buildCostEconomics({ committedCostInUsdCents: 1000, actualCostInUsdCents: 1000, totalPipelineUsd: 50 });
    expect(plain.realizedReturn).toBeNull();
    expect(plain.ratioBasis).toEqual({ committedCostUsd: 10, totalPipelineUsd: 50 });
    const unknown = buildCostEconomics({
      committedCostInUsdCents: 1000,
      actualCostInUsdCents: 1000,
      totalPipelineUsd: 50,
      maturity: { unknown: true },
      realized: { closedWonCount: 1, closedWonRevenueUsd: 100 },
    });
    expect(unknown.ratioBasis).toEqual({ committedCostUsd: null, totalPipelineUsd: null });
    expect(unknown.realizedReturn).toBeNull();
  });
});

describe("closedWonOf — which sales were ours, and what they were worth", () => {
  it("counts a priced won deal at its stated amount, else the lifetime revenue; skips not-ours and ruled-out", () => {
    const r = closedWonOf(
      [
        person("ours", { closeWin: true }),
        person("stated", { closeWin: true }, { valueUsd: 9000 }),
        person("theirs", { closeWin: true }, { unpricedSignals: ["closeWin"] }),
        person("dead", { closeWin: true }, { deadSignals: ["closeWin"] }),
        person("open", { positiveReply: true }),
      ],
      2500,
    );
    expect(r).toEqual({ closedWonCount: 2, closedWonRevenueUsd: 11500 });
  });

  it("0 closed is a measured 0; a won deal nobody can value is null, not $0", () => {
    expect(closedWonOf([person("a", { positiveReply: true })], 2500)).toEqual({ closedWonCount: 0, closedWonRevenueUsd: 0 });
    expect(closedWonOf([person("a", { closeWin: true })], null)).toBeNull();
  });
});
