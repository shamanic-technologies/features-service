import { describe, expect, it } from "vitest";
import {
  addBrandLevelByDay,
  addBrandLevelCost,
  buildBrandLevelSpend,
  withBrandLevelBreakdown,
} from "./brand-level-spend.js";
import type { RunsCostGroup, SpendBreakdown } from "./spend-client.js";
import { buildCostEconomics } from "./cost-economics.js";

const group = (campaignId: string | null, featureSlug: string | null, costName: string, total: number, actual = total): RunsCostGroup => ({
  dimensions: { campaignId, featureSlug, costName },
  totalCostInUsdCents: String(total),
  actualCostInUsdCents: String(actual),
  netTotalCostInUsdCents: String(total),
  netActualCostInUsdCents: String(actual),
  runCount: 1,
});

describe("buildBrandLevelSpend", () => {
  const groups = [
    group("a", "sales-cold-email-outreach", "email-send-step-1", 3000),
    group("b", "sales-cold-email-outreach", "email-send-step-1", 1000),
    group(null, "sales-cold-email-outreach", "anthropic-tokens", 600),
    group(null, null, "notification-email", 400, 300),
  ];
  const byDay = new Map([
    ["2026-10-20", { totalCents: 700, actualCents: 600 }],
    ["2026-10-21", { totalCents: 300, actualCents: 300 }],
  ]);

  it("offer grain: every campaign-less row of the brand, in full (owner: no allocation key), per source and per day", () => {
    const extra = buildBrandLevelSpend({
      groups,
      campaignLessByDay: byDay,
      heldByDay: null,
      campaignScoped: true,
      featureSlugs: ["sales-cold-email-outreach"],
      pricing: "net",
    });
    expect(extra.brandCampaignLessTotalCents).toBe(1000);
    expect(extra.totalCents).toBe(1000);
    expect(extra.actualCents).toBe(900);
    expect(extra.sources).toEqual([
      { source: "anthropic-tokens", totalCents: 600, actualCents: 600 },
      { source: "notification-email", totalCents: 400, actualCents: 300 },
    ]);
    expect(extra.byDay.get("2026-10-20")).toEqual({ totalCents: 700, actualCents: 600 });
  });

  it("brand grain: only the rows its channels' own read does not hold, all of them", () => {
    const extra = buildBrandLevelSpend({
      groups,
      campaignLessByDay: byDay,
      heldByDay: new Map([["2026-10-20", { totalCents: 600, actualCents: 600 }]]),
      campaignScoped: false,
      featureSlugs: ["sales-cold-email-outreach"],
      pricing: "gross",
    });
    expect(extra.totalCents).toBe(400);
    expect(extra.sources.map((s) => s.source)).toEqual(["notification-email"]);
    expect(extra.byDay.get("2026-10-20")).toEqual({ totalCents: 100, actualCents: 0 });
    expect(extra.byDay.get("2026-10-21")).toEqual({ totalCents: 300, actualCents: 300 });
  });
});

describe("one money story: ROI × spend = pipeline on the offer read", () => {
  const extra = buildBrandLevelSpend({
    groups: [group("a", "x", "send", 3231), group(null, null, "setup", 245746)],
    campaignLessByDay: new Map([["2026-10-22", { totalCents: 39, actualCents: 39 }]]),
    heldByDay: null,
    campaignScoped: true,
    featureSlugs: ["x"],
    pricing: "net",
  });
  const own: SpendBreakdown = {
    totalSpentCents: 3231,
    actualSpentCents: 3231,
    provisionedSpentCents: 0,
    totalSpentTodayCents: 39,
    actualSpentTodayCents: 39,
    provisionedSpentTodayCents: 0,
    sources: [{ source: "send", totalSpentCents: 3231, actualSpentCents: 3231, provisionedSpentCents: 0, sharePct: 100 }],
  };

  it("the breakdown, its sources and today's spend carry the brand's work; ROI = pipeline ÷ that spend (0.44x, not 46x)", () => {
    const merged = withBrandLevelBreakdown(own, extra, new Date("2026-10-22T12:00:00Z"));
    expect(merged.totalSpentCents).toBe(3231 + extra.totalCents);
    expect(merged.sources.reduce((s, x) => s + x.totalSpentCents, 0)).toBe(merged.totalSpentCents);
    expect(merged.totalSpentCents).toBe(248977);
    expect(merged.totalSpentTodayCents).toBe(78);
    expect(merged.brandLevel).toEqual({ brandCampaignLessTotalSpentCents: 245746, totalSpentCents: 245746, actualSpentCents: 245746 });

    const cost = { committedCents: merged.totalSpentCents, actualCents: merged.actualSpentCents };
    const economics = buildCostEconomics({ committedCostInUsdCents: cost.committedCents, actualCostInUsdCents: cost.actualCents, totalPipelineUsd: 1102 });
    expect(economics.roiMultiple! * economics.committedCostUsd).toBeCloseTo(1102, 6);
    expect(economics.roiMultiple!).toBeCloseTo(0.4426, 3);
  });

  it("is byte-unchanged when there is no brand-level part", () => {
    expect(withBrandLevelBreakdown(own, null)).toBe(own);
    expect(addBrandLevelCost({ committedCents: 5, actualCents: 4 }, null)).toEqual({ committedCents: 5, actualCents: 4 });
    const days = new Map([["d", 1]]);
    expect(addBrandLevelByDay(days, null)).toBe(days);
  });
});
