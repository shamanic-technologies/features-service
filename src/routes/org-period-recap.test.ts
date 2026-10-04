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

const day = (date: string, sent: number, contacted: number, positive = 0, emailed = sent > 0 ? contacted : 0) => ({
  date,
  emailsSent: sent,
  emailsDelivered: Math.round(sent * 0.95),
  recipientsContacted: contacted,
  recipientsEmailed: emailed,
  recipientsRepliesPositive: positive,
});
const OFFER = "33333333-3333-4333-8333-333333333333";
const offer = (lifetimeRevenueUsd: number | null, offerId = OFFER) => ({
  offerId,
  lifetimeRevenueUsd,
  lifetimeRevenueStatedAt: lifetimeRevenueUsd === null ? null : "2026-09-01 08:16:15.704+00",
});

function setDeps(over: Parameters<typeof __setRecapDepsForTest>[0]) {
  __setRecapDepsForTest({
    brandIds: async () => [BRAND],
    brandDays: async () => [day("2026-09-20", 200, 100), day("2026-09-21", 200, 100)],
    economics: async () => ECON,
    offers: async () => [offer(null)],
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
      expectedAdditionalRecipientsEnrolled: 202, // 200 enrolled on $99 → $100 more lines up 202.02
      expectedAdditionalRecipientsEnrolledNullReason: null,
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
    expect(res.body.outbound).toEqual({
      emailsSent: 0, emailsDelivered: 0, recipientsContacted: 0, recipientsEnrolled: 0, recipientsEmailed: 0,
      sendStatus: "nothing_sent", deliveryRatePct: null, deliveryRateNullReason: "nothing_sent",
    });
    expect(res.body.expectedPositiveReplies).toBe(0);
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, expectedRevenueUsd: null, nullReason: "nothing_sent", lifetimeRevenueNullReason: "nothing_sent" });
    expect(res.body.budgetIncrease).toMatchObject({
      expectedAdditionalRevenueUsd: null,
      nullReason: "nothing_sent",
      expectedAdditionalRecipientsEnrolled: null,
      expectedAdditionalRecipientsEnrolledNullReason: "nothing_sent",
    });
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

  it("the customer's STATED offer lifetime revenue wins over the brand's averaged economics (Legistai, 2026-10-04)", async () => {
    // Brand effective economics say $2,500 (cross-brand-average); the customer stated $2,100 on the offer.
    setDeps({
      economics: async () => ({ ...ECON, source: "cross-brand-average" as const }),
      offers: async () => [offer(2100)],
    });
    const res = await get();
    // 3 replies × 20% × $2,100 = $1,260 over $99.
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: 2100,
      lifetimeRevenueSource: "offer_stated",
      expectedRevenueUsd: 1260,
      roiMultiple: 12.73,
    });
    expect(res.body.budgetIncrease.expectedAdditionalRevenueUsd).toBe(1272.73);
    expect(res.body.brands[0]).toMatchObject({
      lifetimeRevenuePerClientUsd: 2100,
      lifetimeRevenueSource: "offer_stated",
      lifetimeRevenueOfferId: OFFER,
      lifetimeRevenueStatedAt: "2026-09-01 08:16:15.704+00",
      economicsSource: "cross-brand-average",
    });
  });

  it("no offer states a lifetime revenue → the brand's economics, said so", async () => {
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ lifetimeRevenuePerClientUsd: 2500, lifetimeRevenueSource: "brand_economics" });
    expect(res.body.brands[0].lifetimeRevenueOfferId).toBeNull();
  });

  it("offers stating different lifetime revenues → null + lifetime_revenue_differs_across_offers, never an average", async () => {
    setDeps({ offers: async () => [offer(2100), offer(900, "44444444-4444-4444-8444-444444444444")] });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: null,
      lifetimeRevenueNullReason: "lifetime_revenue_differs_across_offers",
      roiMultiple: null,
      nullReason: "lifetime_revenue_differs_across_offers",
    });
    expect(res.body.expectedPositiveReplies).toBe(3);
  });

  it("a brand the org no longer holds (offers null) still counts its sends, valued on its economics", async () => {
    setDeps({ offers: async () => null });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ lifetimeRevenuePerClientUsd: 2500, lifetimeRevenueSource: "brand_economics" });
  });

  it("leads lined up but no email out yet → sendStatus lined_up_not_sent, never 'sent' (Legistai: 302 contacted / 0 sent)", async () => {
    setDeps({ brandDays: async () => [day("2026-10-03", 0, 173), day("2026-10-04", 0, 129)] });
    const res = await get("from=2026-10-03&to=2026-10-04");
    expect(res.body.outbound).toEqual({
      emailsSent: 0,
      emailsDelivered: 0,
      recipientsContacted: 302,
      recipientsEnrolled: 302,
      recipientsEmailed: 0,
      sendStatus: "lined_up_not_sent",
      deliveryRatePct: null,
      deliveryRateNullReason: "nothing_sent",
    });
    expect(res.body.brands[0]).toMatchObject({ recipientsContacted: 302, recipientsEmailed: 0 });
  });

  it("+$100 states how many more recipients it lines up, linear at current results (Legistai: 302 on $98.97 → 305)", async () => {
    setDeps({
      brandDays: async () => [day("2026-10-03", 0, 173), day("2026-10-04", 0, 129)],
      spendByDay: async () => new Map([["2026-10-03", 50], ["2026-10-04", 48.97]]),
    });
    const res = await get("from=2026-10-03&to=2026-10-04");
    expect(res.body.spendUsd).toBe(98.97);
    // 100 × 302 / 98.97 = 305.14 → 305 whole recipients.
    expect(res.body.budgetIncrease).toMatchObject({
      expectedAdditionalRecipientsEnrolled: 305,
      expectedAdditionalRecipientsEnrolledNullReason: null,
    });
  });

  it("emails out → sendStatus emails_sent with the emailed lead count", async () => {
    const res = await get();
    expect(res.body.outbound).toMatchObject({ sendStatus: "emails_sent", recipientsEnrolled: 200, recipientsEmailed: 200 });
  });

  it("an unreadable offer statement is a 502, never an averaged value", async () => {
    setDeps({ offers: async () => { throw new Error("brand-service down"); } });
    expect((await get()).status).toBe(502);
  });

  it("sends but no spend in the window → no_spend_in_window", async () => {
    setDeps({ spendByDay: async () => new Map() });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ expectedRevenueUsd: 1500, roiMultiple: null, nullReason: "no_spend_in_window" });
    expect(res.body.budgetIncrease).toMatchObject({
      expectedAdditionalRecipientsEnrolled: null,
      expectedAdditionalRecipientsEnrolledNullReason: "no_spend_in_window",
    });
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
        { brandId: "a", days: [day("2026-09-20", 10, 100)], economics: ECON, offers: [offer(null)] },
        { brandId: "b", days: [day("2026-09-20", 10, 100)], economics: ECON, offers: [offer(1000)] },
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
