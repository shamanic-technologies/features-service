import { describe, expect, it } from "vitest";
import { buildRevenueWindow, firstActivityDate, inceptionDates, parseWindowDays, windowDates } from "./revenue-window.js";
import { campaignLessOutsideScope, type RunsCostGroup } from "./spend-client.js";

const series = (daily: Array<{ date: string; count: number }>, undatedCount = 0) => ({
  total: daily.reduce((s, d) => s + d.count, 0) + undatedCount,
  daily,
  undatedCount,
});

describe("parseWindowDays", () => {
  it("absent → no window; 1..90 → it; anything else → refused", () => {
    expect(parseWindowDays(undefined)).toBeUndefined();
    expect(parseWindowDays("7")).toBe(7);
    expect(parseWindowDays("30")).toBe(30);
    expect(parseWindowDays("all")).toBe("all");
    expect(parseWindowDays("ALL")).toBeNull();
    expect(parseWindowDays("0")).toBeNull();
    expect(parseWindowDays("91")).toBeNull();
    expect(parseWindowDays("7d")).toBeNull();
    expect(parseWindowDays(["7"])).toBeNull();
  });
});

describe("windowDates", () => {
  it("is N UTC days ascending, ending today", () => {
    expect(windowDates(new Date("2026-10-03T15:00:00Z"), 3)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
});

describe("since inception", () => {
  const now = new Date("2026-10-03T15:00:00Z");
  it("inceptionDates runs from the first day to today; just today when nothing is dated", () => {
    expect(inceptionDates(now, "2026-09-30")).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(inceptionDates(now, null)).toEqual(["2026-10-03"]);
    expect(inceptionDates(now, "2026-10-09")).toEqual(["2026-10-03"]);
    expect(inceptionDates(now, "2026-01-01")).toHaveLength(276);
  });
  it("firstActivityDate is the earliest non-zero day across every source", () => {
    expect(firstActivityDate({
      emailsByDay: new Map([["2026-03-01", { sent: 0, delivered: 0, bounced: 0 }], ["2026-04-02", { sent: 1, delivered: 1, bounced: 0 }]]),
      spendByDay: { scoped: new Map(), brandLevel: new Map([["2026-02-10", 12]]), scopedTotal: new Map(), brandLevelTotal: new Map([["2026-02-10", 12]]) },
      series: [series([{ date: "2026-05-01", count: 1 }])],
      pipelineTimeSeries: [],
    })).toBe("2026-02-10");
    expect(firstActivityDate({ emailsByDay: null, spendByDay: null, series: [], pipelineTimeSeries: [] })).toBeNull();
  });
});

describe("buildRevenueWindow", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const base = {
    dates,
    recipientsRepliesPositive: series([{ date: "2026-09-20", count: 4 }, { date: "2026-10-02", count: 1 }], 2),
    recipientsClicked: series([{ date: "2026-10-03", count: 3 }]),
  };

  it("every total is the sum of its own daily values, zero-filled", () => {
    const w = buildRevenueWindow({
      ...base,
      emailsByDay: new Map([
        ["2026-09-30", { sent: 500, delivered: 490, bounced: 10 }],
        ["2026-10-01", { sent: 100, delivered: 95, bounced: 5 }],
        ["2026-10-03", { sent: 900, delivered: 891, bounced: 9 }],
      ]),
      spendByDay: {
        scoped: new Map([["2026-10-01", 100.4], ["2026-10-03", 2999.6], ["2026-09-01", 50000]]),
        brandLevel: new Map([["2026-10-03", 585.2]]),
        scopedTotal: new Map([["2026-10-01", 100.4], ["2026-10-03", 4500.1], ["2026-09-01", 50000]]),
        brandLevelTotal: new Map([["2026-10-03", 585.2], ["2026-10-02", 12.3]]),
      },
      totalPipelineUsd: 100,
      pipelineTimeSeries: [],
    });
    expect(w.days).toBe(3);
    expect(w.startDate).toBe("2026-10-01");
    expect(w.endDate).toBe("2026-10-03");
    expect(w.emails!.sent).toBe(1000);
    expect(w.emails!.daily.map((d) => d.sent)).toEqual([100, 0, 900]);
    expect(w.emails!.delivered).toBe(w.emails!.daily.reduce((s, d) => s + d.delivered, 0));
    expect(w.emails!.bounced).toBe(14);
    expect(w.emails!.deliveryRatePct).toBeCloseTo(98.6);
    expect(w.emails!.daily[1].deliveryRatePct).toBeNull();
    expect(w.spend!.daily.map((d) => d.actualSpentCents)).toEqual([100, 0, 3585]);
    expect(w.spend!.actualSpentCents).toBe(3685);
    expect(w.spend!.brandLevelActualSpentCents).toBe(585);
    expect(w.spend!.costPerEmailSentCents).toBeCloseTo(3.685);
    // COMMITTED twin: actual + open holds, same composition, same days.
    expect(w.spend!.daily.map((d) => d.totalSpentCents)).toEqual([100, 12, 5085]);
    expect(w.spend!.daily.map((d) => d.provisionedSpentCents)).toEqual([0, 12, 1500]);
    expect(w.spend!.totalSpentCents).toBe(5197);
    expect(w.spend!.totalSpentCents).toBe(w.spend!.daily.reduce((s, d) => s + d.totalSpentCents, 0));
    expect(w.spend!.provisionedSpentCents).toBe(w.spend!.totalSpentCents - w.spend!.actualSpentCents);
    expect(w.spend!.brandLevelTotalSpentCents).toBe(597);
    expect(w.spend!.totalCostPerEmailSentCents).toBeCloseTo(5.197);
    expect(w.recipientsRepliesPositive).toEqual({
      total: 1,
      daily: [{ date: "2026-10-01", count: 0 }, { date: "2026-10-02", count: 1 }, { date: "2026-10-03", count: 0 }],
    });
    expect(w.recipientsClicked.total).toBe(3);
  });

  it("cost per email is null when nothing was sent, and every part null when unread", () => {
    const w = buildRevenueWindow({
      ...base,
      emailsByDay: new Map(),
      spendByDay: { scoped: new Map([["2026-10-03", 3100]]), brandLevel: new Map(), scopedTotal: new Map([["2026-10-03", 3500]]), brandLevelTotal: new Map() },
      totalPipelineUsd: null,
      pipelineTimeSeries: [],
    });
    expect(w.emails!.sent).toBe(0);
    expect(w.emails!.deliveryRatePct).toBeNull();
    expect(w.spend!.costPerEmailSentCents).toBeNull();
    expect(w.expectedPipeline).toBeNull();
    const none = buildRevenueWindow({ ...base, emailsByDay: null, spendByDay: null, totalPipelineUsd: 1, pipelineTimeSeries: [] });
    expect(none.emails).toBeNull();
    expect(none.spend).toBeNull();
  });

  it("the expected pipeline curve ends at the headline when every organisation is dated", () => {
    const w = buildRevenueWindow({
      ...base,
      emailsByDay: null,
      spendByDay: null,
      totalPipelineUsd: 243.46,
      pipelineTimeSeries: [
        { date: "2026-09-01T10:00:00.000Z", cumulativePipelineUsd: 40 },
        { date: "2026-10-02T08:00:00.000Z", cumulativePipelineUsd: 100 },
        { date: "2026-10-03T08:21:15.869Z", cumulativePipelineUsd: 200 },
        { date: "2026-10-03T15:51:54.000Z", cumulativePipelineUsd: 243.46 },
      ],
    });
    expect(w.expectedPipeline!.daily).toEqual([
      { date: "2026-10-01", cumulativePipelineUsd: 40 },
      { date: "2026-10-02", cumulativePipelineUsd: 100 },
      { date: "2026-10-03", cumulativePipelineUsd: 243.46 },
    ]);
    expect(w.expectedPipeline!.totalPipelineUsd).toBe(243.46);
    expect(w.expectedPipeline!.undatedPipelineUsd).toBe(0);
  });

  it("states the undated pipeline instead of dating it", () => {
    const w = buildRevenueWindow({
      ...base,
      emailsByDay: null,
      spendByDay: null,
      totalPipelineUsd: 300,
      pipelineTimeSeries: [{ date: "2026-10-02T08:00:00.000Z", cumulativePipelineUsd: 100 }],
    });
    expect(w.expectedPipeline!.daily.at(-1)!.cumulativePipelineUsd).toBe(100);
    expect(w.expectedPipeline!.undatedPipelineUsd).toBe(200);
  });
});

describe("buildRevenueWindow — queuedEmails (snapshot)", () => {
  const base = { dates: ["2026-10-03"], emailsByDay: null, spendByDay: null, recipientsRepliesPositive: series([]), recipientsClicked: series([]), totalPipelineUsd: null, pipelineTimeSeries: [] };

  it("serves the sender's count, a measured 0 included, with no reason", () => {
    expect(buildRevenueWindow({ ...base, queuedEmails: { queued: 2505 } })).toMatchObject({ queuedEmails: 2505, queuedEmailsUnavailableReason: null });
    expect(buildRevenueWindow({ ...base, queuedEmails: { queued: 0 } })).toMatchObject({ queuedEmails: 0, queuedEmailsUnavailableReason: null });
  });

  it("is null with a reason when unknown, never 0", () => {
    expect(buildRevenueWindow({ ...base, queuedEmails: { queued: null } })).toMatchObject({ queuedEmails: null, queuedEmailsUnavailableReason: "sender_queue_unreadable" });
    expect(buildRevenueWindow({ ...base, queuedEmails: null })).toMatchObject({ queuedEmails: null, queuedEmailsUnavailableReason: "stats_unreadable" });
  });
});

describe("campaignLessOutsideScope (today's brand-level spend)", () => {
  const g = (campaignId: string | null, featureSlug: string | null, cents: string): RunsCostGroup => ({
    dimensions: { campaignId, featureSlug },
    totalCostInUsdCents: cents,
    actualCostInUsdCents: cents,
    runCount: 1,
  });
  const groups = [
    g("c1", "sales-cold-email-outreach", "2722"),
    g(null, "sales-cold-email-outreach", "7"),
    g(null, "ai-meeting-booking", "4"),
    g(null, null, "574"),
  ];

  it("a campaign-scoped read (an offer) adds every campaign-less row", () => {
    expect(campaignLessOutsideScope(groups, true, ["sales-cold-email-outreach"]).map((x) => x.actualCostInUsdCents)).toEqual(["7", "4", "574"]);
  });

  it("a brand-wide read adds only the campaign-less rows its own feature filter did not hold", () => {
    expect(campaignLessOutsideScope(groups, false, ["sales-cold-email-outreach"]).map((x) => x.actualCostInUsdCents)).toEqual(["4", "574"]);
  });
});
