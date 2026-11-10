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
    const persons = [
      { leadId: "a", campaignId: "u1", servedAt: "2026-07-03T00:00:00Z", signals: { contacted: true, positiveReply: true }, signalDates: { positiveReply: "2026-07-09T00:00:00Z" } },
      { leadId: "h", campaignId: "u1", servedAt: "2026-07-04T00:00:00Z", signals: { contacted: true, positiveReply: true, meeting: true }, signalDates: { positiveReply: "2026-07-20T00:00:00Z", meeting: "2026-08-05T00:00:00Z" } },
      { leadId: "x", campaignId: "u1", servedAt: "2026-07-04T00:00:00Z", signals: { signup: true }, signalDates: { signup: "2026-08-06T00:00:00Z" } },
    ];
    return { persons, servedLeadIds: new Set(persons.map((p) => p.leadId)) };
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

import { computeBrandOutcomeCostSeries, computeOutcomeCostSeries } from "./outcome-cost-series.js";
import { fetchBrandOutcomeLedger } from "../lib/scope-outcome-ledger-io.js";

// LEDGER-ONLY-1107-P2: each step's outcomes are the brand ledger's Units (2 positive replies, 1 meeting booked; a
// producer declares signups elsewhere, none for this brand = a measured 0).
const LEDGER = {
  producedByDay: new Map([
    ["conversation", new Map([["2026-07-09", 1], ["2026-07-20", 1]])],
    ["meeting_booked", new Map([["2026-08-05", 1]])],
  ]),
  ownCostUsd: new Map(),
  unitCosts: new Map(),
  undeclaredConsumptions: new Map(),
  fleetProducers: new Map([["conversation", ["instantly-service"]], ["meeting_booked", ["lead-service"]], ["signup", ["lead-service"]]]),
  daysMissing: [],
  today: "2026-10-27",
};
import * as expectedReturn from "../lib/expected-return.js";

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
    vi.mocked(fetchBrandOutcomeLedger).mockResolvedValue(LEDGER as never);
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
    // No expected path: nothing valued; no step serves a return (ROI-CONSISTENCY-1103).
    expect(signup.value.unavailableReason).toBe("expected_model_unavailable");
    expect(body.steps.every((s) => !("roi" in s))).toBe(true);
    for (const s of body.steps) {
      const last = s.months.at(-1)!;
      expect(last.cumulativeCostPerOutcomeUsd).toBe(s.sinceInception.costPerOutcomeUsd);
      expect(last.cumulativeSpendUsd).toBe(s.sinceInception.spendUsd);
    }
  });

  it("OUTCOME-ACCOUNTING-1107: a step off the offer's expected path is priced and valued on the best path through it", async () => {
    const leg = (from: string, to: string, rate: number | null, cost: number | null) =>
      ({ legKey: `${from}_to_${to}`, fromStep: { key: from }, toStep: { key: to }, workedBy: "platform", conversionRatePct: rate, costPerOutcomeUsd: cost, rateSource: "default", costSource: "default", outcomesNeededPerPayingClient: null, costPerPayingClientUsd: null }) as never;
    const meetingPath = { rank: 1, combinationKey: "meet", lifetimeRevenueUsd: 1000, legs: [leg("lead_found", "conversation", null, 10), leg("conversation", "meeting_booked", 50, 5), leg("meeting_booked", "paid_client", 20, 0)] };
    const signupPath = { rank: 2, combinationKey: "sign", lifetimeRevenueUsd: 1000, legs: [leg("lead_found", "website_visit", null, 1), leg("website_visit", "signup", 10, 2), leg("signup", "paid_client", 10, 0)] };
    vi.mocked(expectedReturn.offerExpectedModel).mockResolvedValueOnce({ offerId: "o1", body: { paths: [signupPath, meetingPath] }, selected: ["meet"], lifetimeRevenueSource: "offer_stated", notRunning: false } as never);
    vi.spyOn(expectedReturn, "expectedForOffer").mockReturnValueOnce({ combinationKey: "meet", basis: "default", unavailableReason: null } as never);
    const body = await computeOutcomeCostSeries("o1", "b1", rows, [], "net", { orgId: "org1", userId: "u", runId: "r", featureSlug: undefined }, "2026-10-27");
    const signup = body.steps.find((s) => s.stepKey === "signup")!;
    // Signup on its own path: C = 1 / 0.10 + 2 = $12; V = 0.10 x (1000 - 0) = $100.
    expect(signup.accounting!.costFromStart).toMatchObject({ expectedUsd: 12, route: ["website_visit", "signup"] });
    expect(signup.accounting!.value.expectedNetPerUnitUsd).toBe(100);
    expect(signup.value.valuePerOutcomeUsd).toBe(100);
    // The meeting stays on the expected path: C = 10 / 0.5 + 5 = $25.
    expect(body.steps.find((s) => s.stepKey === "meeting_booked")!.accounting!.costFromStart.expectedUsd).toBe(25);
  });
});

describe("computeBrandOutcomeCostSeries (BRAND-GRAIN-READS-1107)", () => {
  beforeEach(() => {
    vi.mocked(fetchBrandOutcomeLedger).mockResolvedValue(LEDGER as never);
  });
  const H = { orgId: "org1", userId: "u", runId: "r", featureSlug: undefined };
  const CH = [
    { featureSlug: "ai-meeting-booking", campaignIds: ["u2"] },
    { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy1", "u1"] },
  ];

  it("a brand selling ONE offer reads its offer's series byte for byte (expected model unreadable)", async () => {
    const offer = await computeOutcomeCostSeries("o1", "b1", rows, CH, "net", H, "2026-10-27");
    const brand = await computeBrandOutcomeCostSeries("b1", ["o1"], rows, CH, "net", H, "2026-10-27");
    const { offerId: _o, ...offerRest } = offer;
    const { offerIds, steps, ...brandRest } = brand;
    expect(offerIds).toEqual(["o1"]);
    // BRAND-VALUE-ROI-1108: the brand adds `offerMix` per step, nothing else.
    expect({ ...brandRest, steps: steps.map(({ offerMix: _m, ...st }) => st) }).toEqual(offerRest);
    expect(steps.every((st) => st.offerMix.weightBasis === "single_offer")).toBe(true);
  });

  it("…and with a priced expected model (the picked brand model IS the offer's)", async () => {
    const leg = (from: string, to: string, rate: number | null, cost: number | null) =>
      ({ legKey: `${from}_to_${to}`, fromStep: { key: from }, toStep: { key: to }, workedBy: "platform", conversionRatePct: rate, costPerOutcomeUsd: cost, rateSource: "default", costSource: "default", outcomesNeededPerPayingClient: null, costPerPayingClientUsd: null }) as never;
    const meetingPath = { rank: 1, combinationKey: "meet", lifetimeRevenueUsd: 1000, roi: 3, legs: [leg("lead_found", "conversation", null, 10), leg("conversation", "meeting_booked", 50, 5), leg("meeting_booked", "paid_client", 20, 0)] };
    const model = { offerId: "o1", body: { paths: [meetingPath] }, selected: ["meet"], lifetimeRevenueSource: "offer_stated", notRunning: false } as never;
    vi.mocked(expectedReturn.offerExpectedModel).mockResolvedValueOnce(model).mockResolvedValueOnce(model);
    const offer = await computeOutcomeCostSeries("o1", "b1", rows, CH, "net", H, "2026-10-27");
    const brand = await computeBrandOutcomeCostSeries("b1", ["o1"], rows, CH, "net", H, "2026-10-27");
    const { offerId: _o, ...offerRest } = offer;
    const { offerIds: _i, steps, ...brandRest } = brand;
    expect(offer.steps.find((s) => s.stepKey === "meeting_booked")!.expected.unavailableReason).not.toBe("expected_model_unavailable");
    expect({ ...brandRest, steps: steps.map(({ offerMix: _m, ...st }) => st) }).toEqual(offerRest);
    // BRAND-VALUE-ROI-1108: one offer = its own figures; the traced value and expected return are the offer's own.
    for (const st of steps) {
      const own = offer.steps.find((x) => x.stepKey === st.stepKey)!;
      expect(st.offerMix.offers.map((o) => o.offerId)).toEqual(["o1"]);
      expect(st.offerMix.expectedReturn.roiMultiple).toBe(own.accounting!.returns.expected.roiMultiple);
      if (st.offerMix.isCampaignTarget) expect(st.offerMix.measuredReturn.roiMultiple).toBe(own.accounting!.returns.measured.roiMultiple);
    }
  });
});

describe("pickBrandModel (BRAND-GRAIN-READS-1107)", () => {
  const path = (key: string, roi: number | null) => ({ rank: 1, combinationKey: key, lifetimeRevenueUsd: 1000, roi, legs: [] });
  const m = (offerId: string, roi: number | null, notRunning = false) =>
    ({ offerId, body: { paths: [path(`p-${offerId}`, roi)] }, selected: [], lifetimeRevenueSource: "offer_stated", notRunning }) as never;
  it("one offer = its model; several = the best expected ROI among the running ones; none priced = the first by id", () => {
    const only = m("o1", null);
    expect(expectedReturn.pickBrandModel([only])).toBe(only);
    const a = m("a", 2), b = m("b", 5), c = m("c", 9, true);
    expect(expectedReturn.pickBrandModel([a, b, c])).toBe(b);
    const x = m("x", null), y = m("w", null);
    expect(expectedReturn.pickBrandModel([x, y])).toBe(y);
    expect(expectedReturn.pickBrandModel([])).toBeNull();
  });
});

describe("a campaign launched on its Target alone (BACKLINK-ENGINE-1109)", () => {
  beforeEach(() => {
    spendCalls.length = 0;
    vi.mocked(fetchBrandOutcomeLedger).mockResolvedValue(LEDGER as never);
  });
  const H = { orgId: "org1", userId: "u", runId: "r", featureSlug: undefined };
  const CH = [
    { featureSlug: "ai-meeting-booking", campaignIds: ["u2"] },
    { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy1", "u1"] },
  ];
  // Its one unit is run by the Target's Engine: no pipe, no feature slug, no leg.
  const targetOnly = {
    id: "sfc2",
    brandId: "b1",
    offerId: "o1",
    salesFunnelId: "engine-target",
    salesFunnelName: "B",
    status: "ongoing",
    stopReason: null,
    createdAt: "2026-11-09T00:00:00Z",
    target: "backlink_earned",
    units: [{ campaignId: "e1", pipeId: null, featureSlug: null, legKey: null, workflowSlug: "engine:backlink_earned", status: "ongoing" }],
  };

  it("computes (no throw); the pipe-based figures stay byte-equal, the Engine unit's spend is read on its own id", async () => {
    const spend = vi.mocked((await import("../lib/brand-spend-by-day-client.js")).fetchBrandCommittedSpendByDay);
    // The Engine unit's own spend read (no feature filter) answers nothing here, so every figure must stay put.
    spend.mockImplementation(async (...args: unknown[]) => {
      spendCalls.push(args);
      if (Array.isArray(args[2]) && (args[2] as unknown[]).length === 0) return new Map();
      return new Map([
        ["2026-07-03", 100],
        ["2026-08-10", 60],
      ]);
    });
    const before = await computeBrandOutcomeCostSeries("b1", ["o1"], rows, CH, "net", H, "2026-10-27");
    spendCalls.length = 0;
    const after = await computeBrandOutcomeCostSeries("b1", ["o1"], [...(rows as unknown as unknown[]), targetOnly] as never, CH, "net", H, "2026-10-27");
    expect(after.steps).toEqual(before.steps);
    expect(after.ledgerOutcomes).toEqual(before.ledgerOutcomes);
    // The scope read never names the Engine unit under a feature filter; its own read names it with none.
    const featured = spendCalls.filter((c) => Array.isArray(c[2]) && (c[2] as unknown[]).length > 0);
    expect(featured.every((c) => !(c[1] as string[]).includes("e1"))).toBe(true);
    expect(spendCalls.some((c) => JSON.stringify(c[1]) === JSON.stringify(["e1"]) && (c[2] as unknown[]).length === 0)).toBe(true);
    // The offer read survives it too.
    await expect(computeOutcomeCostSeries("o1", "b1", [...(rows as unknown as unknown[]), targetOnly] as never, CH, "net", H, "2026-10-27")).resolves.toBeTruthy();
  });

  it("the Engine unit's spend joins the scope's spend", async () => {
    const spend = vi.mocked((await import("../lib/brand-spend-by-day-client.js")).fetchBrandCommittedSpendByDay);
    spend.mockImplementation(async (...args: unknown[]) => {
      if (Array.isArray(args[2]) && (args[2] as unknown[]).length === 0) return new Map([["2026-11-09", 0.0527]]);
      return new Map([
        ["2026-07-03", 100],
        ["2026-08-10", 60],
      ]);
    });
    const body = await computeBrandOutcomeCostSeries("b1", ["o1"], [...(rows as unknown as unknown[]), targetOnly] as never, CH, "net", H, "2026-11-10");
    const reply = body.steps.find((s) => s.stepKey === "conversation")!;
    expect(reply.sinceInception.spendUsd).toBeCloseTo(170.05, 2);
  });
});

describe("normalizeUnit (BACKLINK-ENGINE-1109)", () => {
  it("a unit stating no feature slug or leg runs no pipe, whatever pipe id campaign-service built", async () => {
    const { normalizeUnit } = await import("../lib/sales-funnel-campaigns-client.js");
    expect(normalizeUnit({ campaignId: "e1", pipeId: "null|null", featureSlug: null, legKey: null, status: "ongoing" }).pipeId).toBeNull();
    const pipe = { campaignId: "u1", pipeId: "cold-email|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", status: "ongoing" };
    expect(normalizeUnit(pipe)).toBe(pipe);
  });
});
