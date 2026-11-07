import { describe, expect, it } from "vitest";
import { campaignTargetRowOf, offerTargetsOf, sumCumulativeDays, PROJECTION_DAYS, type CampaignTargetInput } from "./campaign-targets.js";

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

describe("one entry per (offer, Target) (TARGET-ROWS-UNIQUE-1107)", () => {
  const member = (i: CampaignTargetInput) => ({ input: i, row: campaignTargetRowOf(i) });
  const paid = { key: "paid_client", label: "Paid client", lifecycleRung: "paid_client" };

  it("a brand with one campaign per Target: each entry equals its campaign row figure for figure", () => {
    const a = member(base);
    const b = member({ ...base, salesFunnelCampaignId: "c2", name: "Other", target: paid, targetValueUsd: 2000 });
    const entries = offerTargetsOf([a, b]);
    expect(entries).toHaveLength(2);
    for (const [entry, m] of [[entries[0]!, a], [entries[1]!, b]] as const) {
      const { salesFunnelCampaignId, name: _n, projection, ...figures } = m.row;
      expect(entry).toEqual({ ...figures, salesFunnelCampaignIds: [salesFunnelCampaignId], projection: { ...projection, unprojectedCampaignIds: [] } });
      expect(entry).not.toHaveProperty("name");
    }
  });

  it("two campaigns on the same Target: ONE entry, sums, $ each and ROI recomputed on the sums (never averaged)", () => {
    // c1: 3 outcomes for $300 ($100 each, 4x). c2: 1 outcome for $20 ($20 each, 20x), budget $40/day at $40 per Target.
    const c2: CampaignTargetInput = {
      ...base,
      salesFunnelCampaignId: "c2",
      name: "Wider Email Replies",
      targetDays: [{ date: "2026-11-05", cumulativeOutcomes: 1 }],
      spentUsd: 20,
      spendByDay: [{ date: "2026-11-05", spendUsd: 20 }],
      plan: { computedAt: "2026-11-06T10:00:00.000Z", funnelId: "f9", costPerTargetUsd: 40, basis: "measured", unavailableReason: null },
      dailyBudgetUsd: 40,
    };
    const [entry, ...rest] = offerTargetsOf([member(base), member(c2)]);
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ offerId: "o1", target: base.target, salesFunnelCampaignIds: ["c1", "c2"], outcomesToDate: 4, spentUsd: 320, costPerOutcomeUsd: 80 });
    // 4 × $400 ÷ $320 = 5x (the average of 4x and 20x would read 12x).
    expect(entry!.measuredReturn).toEqual({ roiMultiple: 5, valueUsd: 1600, spentUsd: 320, unavailableReason: null });
    expect(entry!.past.map((p) => [p.date, p.outcomes, p.cumulativeOutcomes])).toEqual([
      ["2026-11-03", 0, 0],
      ["2026-11-04", 1, 1],
      ["2026-11-05", 1, 2],
      ["2026-11-06", 2, 4],
    ]);
    // 2/day + 1/day = 3/day; $140/day ÷ 3 = $46.6667 per Target; next in 8 hours.
    expect(entry!.projection).toMatchObject({
      outcomesPerDay: 3,
      spendPerDayUsd: 140,
      costPerTargetUsd: 46.6667,
      spendPerDaySource: "daily_budget",
      costPerTargetBasis: "mixed",
      planComputedAt: "2026-11-06T10:00:00.000Z",
      planFunnelId: null,
      nextExpectedInHours: 8,
      unavailableReason: null,
      unprojectedCampaignIds: [],
    });
    expect(entry!.projection.daily[0]).toEqual({ date: "2026-11-07", expectedOutcomes: 3, cumulativeExpectedOutcomes: 7 });
  });

  it("a $0 campaign beside a spending one on the same Target: spend is the spender's, the idle one projects nothing and is named", () => {
    const idle: CampaignTargetInput = { ...base, salesFunnelCampaignId: "c0", targetDays: [{ date: "2026-11-06", cumulativeOutcomes: 0 }], spentUsd: 0, spendByDay: [], dailyBudgetUsd: null };
    const [entry] = offerTargetsOf([member(idle), member(base)]);
    expect(entry).toMatchObject({ salesFunnelCampaignIds: ["c0", "c1"], outcomesToDate: 3, spentUsd: 300, costPerOutcomeUsd: 100 });
    expect(entry!.projection).toMatchObject({ outcomesPerDay: 2, spendPerDaySource: "daily_budget", unprojectedCampaignIds: ["c0"] });
  });

  it("an undated campaign's count rides the last day; an unreadable spend makes the sum unreadable", () => {
    const undated = member({ ...base, salesFunnelCampaignId: "c2", targetDays: null, undatedTargetCount: 2 });
    const [entry] = offerTargetsOf([member(base), undated]);
    expect(entry!.outcomesToDate).toBe(5);
    expect(entry!.past[entry!.past.length - 1]).toEqual({ date: "2026-11-06", outcomes: 4, cumulativeOutcomes: 5 });
    const [blind] = offerTargetsOf([member(base), member({ ...base, salesFunnelCampaignId: "c2", spentUsd: null })]);
    expect(blind).toMatchObject({ spentUsd: null, costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "spend_unreadable" });
  });

  it("two campaigns on different Targets stay two entries; campaigns with no Target share one entry per offer", () => {
    const meeting = member(base);
    const paidRow = member({ ...base, salesFunnelCampaignId: "c2", target: paid });
    // No Target = nothing counted on one (the route reads no Target card).
    const noTarget = { target: null, targetDays: null, undatedTargetCount: null };
    const none1 = member({ ...base, ...noTarget, salesFunnelCampaignId: "c3" });
    const none2 = member({ ...base, ...noTarget, salesFunnelCampaignId: "c4" });
    const otherOffer = member({ ...base, salesFunnelCampaignId: "c5", offerId: "o2" });
    const entries = offerTargetsOf([meeting, none1, paidRow, none2, otherOffer]);
    expect(entries.map((e) => [e.offerId, e.target?.key ?? null, e.salesFunnelCampaignIds])).toEqual([
      ["o1", "meeting_booked", ["c1"]],
      ["o1", null, ["c3", "c4"]],
      ["o1", "paid_client", ["c2"]],
      ["o2", "meeting_booked", ["c5"]],
    ]);
    expect(entries[1]).toMatchObject({ outcomesToDate: null, spentUsd: 600, outcomesUnavailableReason: "campaign_states_no_target", costPerOutcomeUsd: null, projection: { outcomesPerDay: null, unavailableReason: "campaign_states_no_target" } });
    expect(entries[1]!.measuredReturn.roiMultiple).toBeNull();
  });
});
