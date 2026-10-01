/**
 * GET /internal/orgs/:orgId/period-recap — the figures billing-service's subscription email reads.
 * Pins: an org with sends + economics answers every figure; an org with no sends answers 0 where 0 is
 * true and null + reason where unknown; a young brand is priced on the fleet rate and says so; a mature
 * brand on its own; validation; auth; fail-loud.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: app } = await import("../index.js");
const { __setRecapDepsForTest } = await import("./org-period-recap.js");
const { buildOrgPeriodRecap, windowDays, isCalendarDay } = await import("../lib/org-period-recap.js");

const ORG = "22222222-2222-4222-8222-222222222222";
const BRAND = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // start_to_conversation cutoff = 2026-09-10
const ECON = {
  economics: {
    lifetimeRevenueUsd: 2500,
    replyToMeetingPct: 30,
    visitToMeetingPct: 9,
    meetingToClosePct: 28,
    visitToSignupPct: 8,
    signupToPaidClientPct: 16,
    visitToClosePct: 1.3,
    replyToPaidClientPct: 20,
  },
  source: "user" as const,
};
const FLEET = { ratePct: 1.5, basis: "mature" as const, workflowDynastySlug: "wf-a" };

const day = (date: string, sent: number, contacted: number, positive = 0) => ({
  date,
  emailsSent: sent,
  emailsDelivered: Math.round(sent * 0.95),
  recipientsContacted: contacted,
  recipientsRepliesPositive: positive,
});

function setDeps(over: Parameters<typeof __setRecapDepsForTest>[0]) {
  __setRecapDepsForTest({
    brandIds: async () => [BRAND],
    brandDays: async () => [day("2026-09-20", 200, 100), day("2026-09-21", 200, 100)],
    economics: async () => ECON,
    spendByDay: async () => new Map([["2026-09-20", 50], ["2026-09-21", 49], ["2026-08-01", 1000]]),
    fleetRate: () => FLEET,
    now: () => NOW,
    ...over,
  });
}

const get = (q = "from=2026-09-15&to=2026-10-14") =>
  request(app).get(`/internal/orgs/${ORG}/period-recap?${q}`).set("x-api-key", "test-key");

describe("GET /internal/orgs/:orgId/period-recap", () => {
  beforeEach(() => setDeps({}));

  it("an org with sends and economics answers every figure, a young brand on the fleet rate", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.window).toEqual({ from: "2026-09-15", to: "2026-10-14", grain: "utc_day", days: 30 });
    expect(b.outbound).toMatchObject({ emailsSent: 400, emailsDelivered: 380, recipientsContacted: 200, deliveryRatePct: 95, deliveryRateNullReason: null });
    // 200 contacted × 1.5% fleet = 3 replies; × 20% = 0.6 paid; × $2,500 = $1,500; spend in window = $99.
    expect(b.expectedPositiveReplies).toBe(3);
    expect(b.brands[0].rateSource).toBe("fleet");
    expect(b.spendUsd).toBe(99);
    expect(b.expectedReturn).toMatchObject({
      expectedPaidClients: 0.6,
      expectedRevenueUsd: 1500,
      roiMultiple: 15.15,
      lifetimeRevenuePerClientUsd: 2500,
      nullReason: null,
    });
    expect(b.budgetIncrease).toMatchObject({
      amountUsd: 100,
      expectedAdditionalRevenueUsd: 1515.15,
      expectedAdditionalPositiveReplies: 3.03,
      revenueMultiple: 2.01,
      nullReason: null,
    });
  });

  it("a brand mature on its own leads is priced on its own rate", async () => {
    setDeps({
      brandDays: async () => [day("2026-08-01", 2000, 1000, 30), day("2026-09-20", 200, 100)],
    });
    const res = await get();
    expect(res.body.brands[0]).toMatchObject({ rateSource: "brand_mature", positiveReplyRatePct: 3 });
    expect(res.body.expectedPositiveReplies).toBe(3); // 100 contacted in window × 3%
    expect(res.body.outbound.emailsSent).toBe(200); // the August day is outside the window
  });

  it("an org with no sends: zeros where zero is true, nulls with reasons where unknown", async () => {
    setDeps({ brandIds: async () => [], spendByDay: async () => new Map() });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.outbound).toEqual({ emailsSent: 0, emailsDelivered: 0, recipientsContacted: 0, deliveryRatePct: null, deliveryRateNullReason: "nothing_sent" });
    expect(res.body.expectedPositiveReplies).toBe(0);
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, expectedRevenueUsd: null, nullReason: "nothing_sent", lifetimeRevenueNullReason: "nothing_sent" });
    expect(res.body.budgetIncrease).toMatchObject({ expectedAdditionalRevenueUsd: null, nullReason: "nothing_sent" });
  });

  it("no mature rate and no fleet benchmark yet → null + reply_rate_unavailable, never 0", async () => {
    setDeps({ fleetRate: () => null });
    const res = await get();
    expect(res.body.expectedPositiveReplies).toBeNull();
    expect(res.body.expectedPositiveRepliesNullReason).toBe("reply_rate_unavailable");
    expect(res.body.expectedReturn.nullReason).toBe("reply_rate_unavailable");
    expect(res.body.outbound.emailsSent).toBe(400);
  });

  it("a sending brand with no economics → economics_missing", async () => {
    setDeps({ economics: async () => ({ economics: null, source: null }) });
    const res = await get();
    expect(res.body.expectedPositiveReplies).toBe(3);
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, nullReason: "economics_missing", lifetimeRevenueNullReason: "economics_missing" });
  });

  it("sends but no spend in the window → no_spend_in_window", async () => {
    setDeps({ spendByDay: async () => new Map() });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ expectedRevenueUsd: 1500, roiMultiple: null, nullReason: "no_spend_in_window" });
  });

  it("validates the org and the window, and requires the api key", async () => {
    expect((await request(app).get(`/internal/orgs/${ORG}/period-recap?from=2026-09-15&to=2026-10-14`)).status).toBe(401);
    expect((await request(app).get(`/internal/orgs/not-a-uuid/period-recap?from=2026-09-15&to=2026-10-14`).set("x-api-key", "test-key")).body.code).toBe("org_id_invalid");
    expect((await get("from=2026-02-31&to=2026-03-10")).body.code).toBe("window_invalid");
    expect((await get("from=2026-09-15&to=2026-09-01")).body.code).toBe("window_invalid");
    expect((await get("from=2026-01-01&to=2026-12-31")).body.code).toBe("window_too_long");
  });

  it("a producer failure is a 502, never a guessed figure", async () => {
    setDeps({ brandDays: async () => { throw new Error("email-gateway down"); } });
    expect((await get()).status).toBe(502);
  });
});

describe("org-period-recap pure helpers", () => {
  it("windowDays is inclusive and isCalendarDay refuses rolled-over dates", () => {
    expect(windowDays("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("brands valued differently → no single lifetime revenue, ROI still served", () => {
    const r = buildOrgPeriodRecap({
      orgId: ORG,
      from: "2026-09-15",
      to: "2026-10-14",
      now: NOW,
      brands: [
        { brandId: "a", days: [day("2026-09-20", 10, 100)], economics: ECON },
        { brandId: "b", days: [day("2026-09-20", 10, 100)], economics: { ...ECON, economics: { ...ECON.economics, lifetimeRevenueUsd: 1000 } } },
      ],
      spendByDay: new Map([["2026-09-20", 100]]),
      fleetRate: FLEET,
    });
    expect(r.expectedReturn.lifetimeRevenuePerClientUsd).toBeNull();
    expect(r.expectedReturn.lifetimeRevenueNullReason).toBe("lifetime_revenue_differs_across_brands");
    // 1.5 replies × 20% × (2500 + 1000) = 1050 / 100
    expect(r.expectedReturn.roiMultiple).toBe(10.5);
  });
});
