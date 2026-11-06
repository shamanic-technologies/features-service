import { describe, expect, it } from "vitest";
import { campaignTargetRowOf, sumCumulativeDays, PROJECTION_DAYS, type CampaignTargetInput } from "./campaign-targets.js";

const NOW = "2026-11-06T12:00:00.000Z";
const base: CampaignTargetInput = {
  salesFunnelCampaignId: "c1",
  name: "Cold Email Meetings",
  offerId: "o1",
  mode: "proactive",
  target: { key: "meeting_booked", label: "Meeting booked", lifecycleRung: "meeting_booked" },
  targetDays: [
    { date: "2026-11-03", cumulativeOutcomes: 0 },
    { date: "2026-11-04", cumulativeOutcomes: 1 },
    { date: "2026-11-05", cumulativeOutcomes: 1 },
    { date: "2026-11-06", cumulativeOutcomes: 3 },
  ],
  undatedTargetCount: 3,
  spentUsd: 300,
  spendByDay: [
    { date: "2026-11-03", spendUsd: 70 },
    { date: "2026-11-04", spendUsd: 70 },
    { date: "2026-11-05", spendUsd: 70 },
    { date: "2026-11-06", spendUsd: 90 },
  ],
  targetValueUsd: 400,
  targetValueUnavailableReason: null,
  plan: { computedAt: "2026-11-06T09:00:00.000Z", funnelId: "f1", costPerTargetUsd: 50, basis: "fleet", unavailableReason: null },
  dailyBudgetUsd: 100,
  now: NOW,
};

describe("campaign Targets (OUTCOME-RUNG-AND-TARGET-1106)", () => {
  it("serves count, $ per Target, measured return, the past per day and the plan's projection", () => {
    const r = campaignTargetRowOf(base);
    expect(r.outcomesToDate).toBe(3);
    expect(r.costPerOutcomeUsd).toBe(100);
    expect(r.measuredReturn).toEqual({ roiMultiple: 4, valueUsd: 1200, spentUsd: 300, unavailableReason: null });
    expect(r.past.map((p) => p.outcomes)).toEqual([0, 1, 0, 2]);
    expect(r.past[r.past.length - 1]!.cumulativeOutcomes).toBe(r.outcomesToDate);
    // $100 a day ÷ $50 per Target = 2 a day, one every 12 hours.
    expect(r.projection).toMatchObject({ planComputedAt: "2026-11-06T09:00:00.000Z", spendPerDaySource: "daily_budget", outcomesPerDay: 2, nextExpectedInHours: 12, nextExpectedAt: "2026-11-07T00:00:00.000Z", unavailableReason: null });
    expect(r.projection.daily).toHaveLength(PROJECTION_DAYS);
    expect(r.projection.daily[0]).toEqual({ date: "2026-11-07", expectedOutcomes: 2, cumulativeExpectedOutcomes: 5 });
  });

  it("the past never moves with the Plan: two plan ticks, same past, only the projection changes", () => {
    const a = campaignTargetRowOf(base);
    const b = campaignTargetRowOf({ ...base, plan: { ...base.plan!, computedAt: "2026-11-06T12:00:00.000Z", funnelId: "f2", costPerTargetUsd: 25 } });
    expect(b.past).toEqual(a.past);
    expect([b.outcomesToDate, b.costPerOutcomeUsd, b.measuredReturn]).toEqual([a.outcomesToDate, a.costPerOutcomeUsd, a.measuredReturn]);
    expect(b.projection.outcomesPerDay).toBe(4);
    expect(b.projection.planFunnelId).toBe("f2");
  });

  it("no daily budget: projects on the last 7 days' spend pace; nothing at all: a reason", () => {
    const pace = campaignTargetRowOf({ ...base, dailyBudgetUsd: null });
    expect(pace.projection).toMatchObject({ spendPerDaySource: "spend_pace_7d", spendPerDayUsd: 30 });
    const none = campaignTargetRowOf({ ...base, dailyBudgetUsd: null, spendByDay: [] });
    expect(none.projection).toMatchObject({ outcomesPerDay: null, daily: [], nextExpectedAt: null, unavailableReason: "no_daily_budget_and_no_recent_spend" });
    expect(campaignTargetRowOf({ ...base, plan: null }).projection.unavailableReason).toBe("plan_not_computed_yet");
  });

  it("a Target with no value (after Paid client) serves no return, with its reason; zero outcomes: no $ per outcome, a 0x return", () => {
    expect(campaignTargetRowOf({ ...base, targetValueUsd: null, targetValueUnavailableReason: "target_has_no_value" }).measuredReturn).toMatchObject({ roiMultiple: null, unavailableReason: "target_has_no_value" });
    const zero = campaignTargetRowOf({ ...base, targetDays: [{ date: "2026-11-06", cumulativeOutcomes: 0 }] });
    expect(zero).toMatchObject({ outcomesToDate: 0, costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "no_target_outcome_yet" });
    expect(zero.measuredReturn.roiMultiple).toBe(0);
  });

  it("a Target no pipe of the campaign dates: the funnel count, no past series, said so", () => {
    const r = campaignTargetRowOf({ ...base, targetDays: null, undatedTargetCount: 2 });
    expect(r).toMatchObject({ outcomesToDate: 2, past: [], pastUnavailableReason: "target_not_dated_for_this_campaign", costPerOutcomeUsd: 150 });
  });

  it("sums two pipes landing on the Target per day", () => {
    expect(sumCumulativeDays([[{ date: "2026-11-01", cumulativeOutcomes: 1 }, { date: "2026-11-03", cumulativeOutcomes: 2 }], [{ date: "2026-11-02", cumulativeOutcomes: 5 }]])).toEqual([
      { date: "2026-11-01", cumulativeOutcomes: 1 },
      { date: "2026-11-02", cumulativeOutcomes: 6 },
      { date: "2026-11-03", cumulativeOutcomes: 7 },
    ]);
  });
});
