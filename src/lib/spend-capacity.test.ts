import { describe, expect, it } from "vitest";
import { capacityUnavailableReason, expectedScheduleOf, projectSchedule, scaleSchedule, sumSchedules, unconstrainedSchedule, type SpendCapacityInput } from "./spend-capacity.js";
import { funnelCampaignCapsOf } from "./funnel-campaign-budget-client.js";

const NOW = "2026-11-17T12:00:00.000Z";
const running: SpendCapacityInput = { campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: null };
// Wide Email in prod 2026-11-17 (billing's campaign caps view, held to the funnel-wide cap).
const WIDE_EMAIL_CAPS = {
  stated: true,
  maxBudget: {
    amountCents: "22000.0000000000",
    period: "monthly",
    dailyBudgetCents: "733.3333333333",
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    consumedCents: "21998.0391187000",
    remainingCents: "1.9608813000",
    reached: true,
    refusedSpend: { at: "2026-11-13T23:30:30.765Z", requiredCents: "2.6668000000" },
    consumedUnavailableReason: null,
  },
  maxVolume: null,
  capScope: "sales_funnel",
};

describe("PROJECTION-CAP-1117: a projection reads the campaign's real capacity to spend", () => {
  it("parses billing's measured campaign caps (Wide Email's real body)", () => {
    const caps = funnelCampaignCapsOf(WIDE_EMAIL_CAPS);
    expect(caps.dailyBudgetUsd).toBeCloseTo(7.3333, 4);
    expect(caps.budget).toMatchObject({ period: "monthly", amountUsd: 220, periodEnd: "2026-12-01T00:00:00.000Z", reached: true });
    expect(caps.budget!.remainingUsd).toBeCloseTo(0.0196, 4);
    expect(caps.volumeReached).toBeNull();
    expect(funnelCampaignCapsOf({ stated: false, maxBudget: null, maxVolume: null })).toEqual({ dailyBudgetUsd: null, budget: null, volumeReached: null });
  });

  it("a monthly cap reached: nothing expected until the month resets, then the normal pace", () => {
    const caps = funnelCampaignCapsOf(WIDE_EMAIL_CAPS);
    const capacity = { ...running, budget: caps.budget, volumeReached: caps.volumeReached };
    expect(capacityUnavailableReason(capacity)).toBeNull();
    // Lead found at 13 a day (the served figure before the fix: next in 1.85 h).
    const s = expectedScheduleOf(13, caps.dailyBudgetUsd!, capacity, NOW);
    expect(s).toMatchObject({ pausedReason: "budget_cap_reached", resumesAt: "2026-12-01T00:00:00.000Z", outcomesPerDayWhenSpending: 13 });
    const p = projectSchedule(s, 4157, NOW, 30);
    // 12 h left of Nov 17 + 13 full days to Dec 1, then 24 h ÷ 13.
    expect(p.nextExpectedInHours).toBeCloseTo(12 + 13 * 24 + 24 / 13, 1);
    expect(p.nextExpectedAt!.slice(0, 10)).toBe("2026-12-01");
    expect(p.daily.filter((d) => d.date < "2026-12-01").every((d) => d.expectedOutcomes === 0)).toBe(true);
    expect(p.daily.find((d) => d.date === "2026-12-01")!.expectedOutcomes).toBeCloseTo(13, 3);
    expect(p.daily.find((d) => d.date === "2026-11-30")!.cumulativeExpectedOutcomes).toBe(4157);
  });

  it("a budget with a little left: spends it, then nothing until the window resets (weekly, Monday)", () => {
    // $10 left of a $70 week at $10/day, 12 h left today (Tue): $5 today, $5 Wed, then nothing until Monday Nov 23.
    const capacity: SpendCapacityInput = { ...running, budget: { period: "weekly", amountUsd: 70, periodEnd: "2026-11-23T00:00:00.000Z", remainingUsd: 10, reached: false } };
    const s = expectedScheduleOf(2, 10, capacity, NOW);
    expect(s.pausedReason).toBeNull();
    expect(s.outcomes.slice(0, 7).map((o) => Math.round(o * 100) / 100)).toEqual([1, 1, 0, 0, 0, 0, 2]);
    expect(projectSchedule(s, 0, NOW, 30).nextExpectedInHours).toBe(12);
  });

  it("a volume cap reached: paused until its window resets", () => {
    const s = expectedScheduleOf(1, 5, { ...running, volumeReached: { periodEnd: "2026-11-18T00:00:00.000Z" } }, NOW);
    expect(s).toMatchObject({ pausedReason: "volume_cap_reached", resumesAt: "2026-11-18T00:00:00.000Z" });
    expect(projectSchedule(s, 0, NOW, 30).nextExpectedInHours).toBe(36);
  });

  it("a stopped campaign, a one-off cap spent, an unreadable read: nothing expected, the reason named", () => {
    expect(capacityUnavailableReason({ ...running, campaignStatus: "stopped" })).toBe("campaign_stopped");
    expect(capacityUnavailableReason({ ...running, budget: { period: "one_off", amountUsd: 50, periodEnd: null, remainingUsd: 0, reached: true } })).toBe("budget_cap_spent_no_reset");
    expect(capacityUnavailableReason({ ...running, volumeReached: { periodEnd: null } })).toBe("volume_cap_reached_no_reset");
    expect(capacityUnavailableReason({ ...running, budget: { period: "monthly", amountUsd: 50, periodEnd: "2026-12-01T00:00:00.000Z", remainingUsd: null, reached: null } })).toBe("budget_consumption_unreadable");
    expect(capacityUnavailableReason({ ...running, unreadableReason: "billing_caps_unreadable" })).toBe("spend_capacity_unreadable");
  });

  it("no cap: the steady pace, next one in 24 h ÷ pace however slow (past the schedule's reach)", () => {
    expect(projectSchedule(unconstrainedSchedule(2, NOW), 0, NOW, 30).nextExpectedInHours).toBe(12);
    expect(projectSchedule(unconstrainedSchedule(13, NOW), 0, NOW, 30).nextExpectedInHours).toBe(1.85);
    expect(projectSchedule(unconstrainedSchedule(0.0001, NOW), 0, NOW, 30).nextExpectedInHours).toBeCloseTo(240000, 0);
  });

  it("merged campaigns: paused only when every one is, resuming with the first back; a milestone scales its Target's", () => {
    const capped = expectedScheduleOf(1, 5, { ...running, volumeReached: { periodEnd: "2026-11-20T00:00:00.000Z" } }, NOW);
    const both = sumSchedules([capped, unconstrainedSchedule(1, NOW)])!;
    expect(both.pausedReason).toBeNull();
    expect(both.outcomes[1]).toBeCloseTo(1, 6);
    const later = expectedScheduleOf(1, 5, { ...running, volumeReached: { periodEnd: "2026-11-25T00:00:00.000Z" } }, NOW);
    expect(sumSchedules([later, capped])).toMatchObject({ pausedReason: "volume_cap_reached", resumesAt: "2026-11-20T00:00:00.000Z" });
    expect(scaleSchedule(unconstrainedSchedule(2, NOW), 50).outcomesPerDayWhenSpending).toBe(100);
  });
});
