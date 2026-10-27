import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const spendCalls: unknown[][] = [];
vi.mock("../lib/brand-spend-by-day-client.js", () => ({
  fetchBrandCommittedSpendByDay: vi.fn(async (...args: unknown[]) => {
    spendCalls.push(args);
    return new Map([
      ["2026-07-03", 100],
      ["2026-08-10", 60],
    ]);
  }),
}));
vi.mock("../lib/brand-level-spend.js", async (orig) => ({
  ...(await orig<typeof import("../lib/brand-level-spend.js")>()),
  fetchBrandLevelSpend: vi.fn(async () => ({
    brandCampaignLessTotalCents: 1000,
    sources: [],
    totalCents: 1000,
    actualCents: 1000,
    byDay: new Map([["2026-08-01", { totalCents: 1000, actualCents: 1000 }]]),
  })),
}));
const peopleCalls: unknown[][] = [];
vi.mock("../lib/spend-charts-io.js", async (orig) => ({
  ...(await orig<typeof import("../lib/spend-charts-io.js")>()),
  fetchFollowupActionRows: vi.fn(async () => [
    { actingCampaignId: "u2", leadId: "h", firstClaimedAt: "2026-08-01T00:00:00Z", firstActedAt: "2026-08-01T00:00:00Z", actedCount: 1, claimCount: 1 },
  ]),
  readScopePeople: vi.fn(async (...args: unknown[]) => {
    peopleCalls.push(args);
    return [
      { leadId: "a", campaignId: "u1", servedAt: "2026-07-03T00:00:00Z", signals: { contacted: true, positiveReply: true }, signalDates: { positiveReply: "2026-07-09T00:00:00Z" } },
      { leadId: "h", campaignId: "u1", servedAt: "2026-07-04T00:00:00Z", signals: { contacted: true, positiveReply: true, meeting: true }, signalDates: { positiveReply: "2026-07-20T00:00:00Z", meeting: "2026-08-05T00:00:00Z" } },
      { leadId: "x", campaignId: "u1", servedAt: "2026-07-04T00:00:00Z", signals: { signup: true }, signalDates: { signup: "2026-08-06T00:00:00Z" } },
    ];
  }),
}));
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async () => ({
    pipeSteps: new Map([
      ["cold-email|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
      ["ai-meeting-booking|conversation_to_meeting_booked", { fromStep: "conversation", toStep: "meeting_booked" }],
    ]),
  })),
}));
vi.mock("../lib/expected-return.js", async (orig) => ({
  ...(await orig<typeof import("../lib/expected-return.js")>()),
  offerExpectedModel: vi.fn(async () => {
    throw new Error("down");
  }),
}));

import { computeOutcomeCostSeries } from "./outcome-cost-series.js";

const rows = [
  {
    id: "sfc1",
    brandId: "b1",
    offerId: "o1",
    salesFunnelId: "f1",
    salesFunnelName: "F",
    status: "ongoing",
    stopReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    units: [
      { campaignId: "u1", pipeId: "cold-email|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", status: "ongoing" },
      { campaignId: "u2", pipeId: "ai-meeting-booking|conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", status: "ongoing" },
    ],
  },
] as never;

describe("computeOutcomeCostSeries (OUTCOME-COST-SERIES-1027)", () => {
  beforeEach(() => {
    spendCalls.length = 0;
    peopleCalls.length = 0;
  });

  it("reads the offer spend chart's scope (legacy campaigns + brand-level) and divides the same spend for every step", async () => {
    const body = await computeOutcomeCostSeries(
      "o1",
      "b1",
      rows,
      [
        { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy1", "u1"] },
        { featureSlug: "ai-meeting-booking", campaignIds: ["u2"] },
      ],
      "net",
      { orgId: "org1", userId: "u", runId: "r", featureSlug: undefined },
      "2026-10-27",
    );
    expect(spendCalls[0][1]).toEqual(["legacy1", "u1", "u2"]);
    expect(spendCalls[0][4]).toBe("net");
    expect(peopleCalls[0][1]).toEqual(["legacy1", "u1", "u2"]);
    expect(body.firstSpendDay).toBe("2026-07-03");

    const reply = body.steps.find((s) => s.stepKey === "conversation")!;
    const meeting = body.steps.find((s) => s.stepKey === "meeting_booked")!;
    const signup = body.steps.find((s) => s.stepKey === "signup")!;
    // $100 + $60 + $10 brand-level = $170 on every step.
    expect(body.steps.every((s) => s.sinceInception.spendUsd === 170)).toBe(true);
    expect(reply.sinceInception).toMatchObject({ outcomes: 2, costPerOutcomeUsd: 85, learning: false });
    expect(reply.learningOutcomesRequired).toBe(1);
    expect(meeting.sinceInception).toMatchObject({ outcomes: 1, costPerOutcomeUsd: 170, learning: true });
    // The signup was never preceded by a message of ours: Learning, no spend floor.
    expect(signup.sinceInception).toMatchObject({ outcomes: 0, costPerOutcomeUsd: null, learning: true });
    expect(signup.expected.unavailableReason).toBe("expected_model_unavailable");
    for (const s of body.steps) {
      const last = s.months.at(-1)!;
      expect(last.cumulativeCostPerOutcomeUsd).toBe(s.sinceInception.costPerOutcomeUsd);
      expect(last.cumulativeSpendUsd).toBe(s.sinceInception.spendUsd);
    }
  });
});
