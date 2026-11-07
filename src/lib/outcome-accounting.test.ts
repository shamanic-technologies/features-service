import { describe, expect, it } from "vitest";
import { accountingReturn, costVariance, effectiveTrials, expectedRouteFigures, outcomeAccountingOf, yieldToNext, type RouteLeg } from "./outcome-accounting.js";

// The framework's worked example (docs/gtm-factory-framework.md §10): LTR $2,100; Start -> Lead interested $1 per
// attempt at 2% ($50 per interested lead), -> Meeting booked $2 at 40% ($5 per meeting), -> Paid client $10 at 20% ($50
// per paying client). Cost from Start: $50, $130, $700. Value backward: meeting $410, interested lead $162.
const route: RouteLeg[] = [
  { fromStep: null, toStep: "lead_interested", ratePct: null, rateBasis: null, costPerUnitUsd: 50, costBasis: "measured" },
  { fromStep: "lead_interested", toStep: "meeting_booked", ratePct: 40, rateBasis: "measured", costPerUnitUsd: 5, costBasis: "measured", legKey: "lead_interested_to_meeting_booked" },
  { fromStep: "meeting_booked", toStep: "paid_client", ratePct: 20, rateBasis: "default", costPerUnitUsd: 50, costBasis: "default" },
];

describe("outcome accounting (OUTCOME-ACCOUNTING-1107): the framework's two calculations", () => {
  it("cost forward from Start and NET value backward match the framework's worked example", () => {
    const meeting = expectedRouteFigures(route, "meeting_booked", 2100);
    expect(meeting.costFromStartUsd).toBe(130);
    expect(meeting.costPerUnitUsd).toBe(5);
    expect(meeting.netValuePerUnitUsd).toBe(410);
    expect(meeting.rolledYieldPct).toBe(40);
    expect(meeting.next).toMatchObject({ step: "paid_client", ratePct: 20 });
    const lead = expectedRouteFigures(route, "lead_interested", 2100);
    expect(lead.costFromStartUsd).toBe(50);
    expect(lead.netValuePerUnitUsd).toBe(162);
    expect(expectedRouteFigures(route, "paid_client", 2100)).toMatchObject({ costFromStartUsd: 700, netValuePerUnitUsd: 2100, next: null });
    expect(expectedRouteFigures(route, "signup", 2100)).toMatchObject({ costFromStartUsd: null, costFromStartUnavailableReason: "outcome_not_on_route" });
  });

  it("an open decision counts for its elapsed share of the window (framework §8: 100 decisions, 70% due, 2 successes = 2.86%)", () => {
    const trials = [...Array(98).fill({ day: "2026-11-01", nextUnits: 0, units: 1 }), { day: "2026-11-01", nextUnits: 1, units: 1 }, { day: "2026-11-01", nextUnits: 1, units: 1 }];
    // 6 of a 10-day window elapsed on 98 open ones: 98 x 0.6 + 2 = 60.8 trials.
    expect(effectiveTrials(trials, 10, "2026-11-07")).toBeCloseTo(60.8, 6);
    expect(effectiveTrials(trials, 0, "2026-11-07")).toBe(100);
  });

  it("expected yield pools the route rate (200 trials) with the measured trials: 3 of 50 at a 2% prior = 2.8%", () => {
    const next = { step: "meeting_booked", ratePct: 2, rateBasis: "default", legKey: null, costPerUnitUsd: 0 };
    const trials = Array.from({ length: 50 }, (_, i) => ({ day: null, nextUnits: i < 3 ? 1 : 0, units: 1 }));
    const y = yieldToNext(next, trials, null, 0, "2026-11-07");
    expect(y.measuredPct).toBe(6);
    expect(y.expectedPct).toBeCloseTo(2.8, 6);
    const untracked = yieldToNext(next, null, "no_visit_attribution_on_outcome", 0, "2026-11-07");
    expect(untracked).toMatchObject({ measuredPct: null, measuredUnavailableReason: "no_visit_attribution_on_outcome", expectedPct: 2 });
  });

  it("variance splits into yield and mix that add up to it", () => {
    // Standard $5 a meeting at 40%: $2 an attempt. Actual $8 a meeting at 25%: $2 an attempt. All yield.
    expect(costVariance(8, 5, { measuredPct: 25, standardPct: 40 }, null)).toMatchObject({ usd: 3, yieldUsd: 3, mixUsd: 0, pct: 60 });
    // Actual $6 at 40%: $2.40 an attempt. All mix.
    expect(costVariance(6, 5, { measuredPct: 40, standardPct: 40 }, null)).toMatchObject({ usd: 1, yieldUsd: 0, mixUsd: 1 });
    expect(costVariance(6, 5, null, "attempts_not_on_ledger")).toMatchObject({ usd: 1, yieldUsd: null, splitUnavailableReason: "attempts_not_on_ledger" });
  });

  it("a return only at a campaign's Target", () => {
    expect(accountingReturn([], null, 410, 130)).toMatchObject({ isCampaignTarget: false, unavailableReason: "outcome_is_no_campaign_target", measured: { roiMultiple: null } });
    expect(accountingReturn(["c1"], { targetUnits: 2, spentUsd: 100 }, 2100, 700)).toMatchObject({ isCampaignTarget: true, measured: { roiMultiple: 42, learning: true }, expected: { roiMultiple: 3 } });
  });

  it("assembles one report: a published outcome made from Start reads its cost from Start = its cost per Unit", () => {
    const figures = expectedRouteFigures([{ fromStep: null, toStep: "post", ratePct: null, rateBasis: null, costPerUnitUsd: null, costBasis: null }], "post", 1000);
    const r = outcomeAccountingOf({
      outcomeKey: "linkedin_post_published",
      step: "post",
      route: figures,
      actual: { units: 9, spentUsd: 0.162239 },
      expectedCostOverride: { usd: 0.018027, basis: "measured", source: "own_spend" },
      yield: yieldToNext(null, null, null, 0, "2026-11-07"),
      yieldInto: null,
      yieldIntoReason: "attempts_not_on_ledger",
      lifetimeRevenueUsd: 1000,
      lifetimeRevenueSource: "fleet_median",
      ret: accountingReturn([], null, null, null),
    });
    expect(r.costPerUnit).toMatchObject({ actualUsd: 0.018027, expectedUsd: 0.018027, expectedSource: "own_spend" });
    expect(r.costFromStart).toMatchObject({ actualUsd: 0.018027, expectedUsd: 0.018027, route: ["post"] });
    expect(r.returns.unavailableReason).toBe("outcome_is_no_campaign_target");
  });
});
