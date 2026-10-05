/**
 * GET /internal/orgs/:orgId/period-recap — the figures billing-service's subscription email reads.
 * Pins: the return (and the +$100 gain) is the dashboard's SERVED return for the offer that sent, never a
 * window recomputation; an org with no sends answers 0 where 0 is true and null + reason where unknown;
 * expected replies: a young brand on the fleet rate, a mature brand on its own; validation; auth; fail-loud.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: app } = await import("../index.js");
const { __setRecapDepsForTest } = await import("./org-period-recap.js");
const { buildOrgPeriodRecap, windowDays, isCalendarDay, windowOutcomeCount } = await import("../lib/org-period-recap.js");

const ORG = "22222222-2222-4222-8222-222222222222";
const BRAND = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // start_to_conversation cutoff = 2026-09-10
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

/** The Today page's figure for Legistai on 2026-10-04: not mature, to-date 4.33x > 1 → shown. */
const LEGISTAI_FLASH_ROI = 4.331570924843547;
const offerReturn = (
  pair: { flash: { roiMultiple: number | null } | null; mature: { roiMultiple: number | null } | null; isMature: boolean | null },
  offerId = OFFER,
) => ({ offerId, pair, pipelineUsd: 402.58, committedCostUsd: 92.94 });
const NOT_MATURE = { flash: { roiMultiple: LEGISTAI_FLASH_ROI }, mature: { roiMultiple: null }, isMature: false };

function setDeps(over: Parameters<typeof __setRecapDepsForTest>[0]) {
  __setRecapDepsForTest({
    brandIds: async () => [BRAND],
    brandDays: async () => [day("2026-09-20", 200, 100), day("2026-09-21", 200, 100)],
    // The lifetime revenue is the OFFER's stated one (brand-level economics retired 2026-10-05).
    offers: async () => [offer(2500)],
    spendByDay: async () => new Map([["2026-09-20", 50], ["2026-09-21", 49], ["2026-08-01", 1000]]),
    offerReturn: async () => offerReturn(NOT_MATURE),
    fleetRate: () => FLEET,
    now: () => NOW,
    ...over,
  });
}

const get = (q = "from=2026-09-15&to=2026-10-14") =>
  request(app).get(`/internal/orgs/${ORG}/period-recap?${q}`).set("x-api-key", "test-key");

describe("GET /internal/orgs/:orgId/period-recap", () => {
  beforeEach(() => setDeps({}));

  it("the return is the dashboard's served return for the offer, never the window's reply-route valuation (Legistai, 2026-10-04)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.window).toEqual({ from: "2026-09-15", to: "2026-10-14", grain: "utc_day", days: 30 });
    expect(b.outbound).toMatchObject({ emailsSent: 400, emailsDelivered: 380, recipientsContacted: 200, deliveryRatePct: 95, deliveryRateNullReason: null });
    // Expected replies: 200 contacted × 1.5% fleet = 3. The window's reply route would have valued them at
    // 3 × 20% × $2,500 = $1,500 over $99 = 15.15x: that second formula is exactly what must NOT be served.
    expect(b.expectedPositiveReplies).toBe(3);
    expect(b.brands[0].rateSource).toBe("fleet");
    expect(b.spendUsd).toBe(99);
    expect(b.expectedReturn.roiMultiple).toBe(LEGISTAI_FLASH_ROI); // byte the served figure, not rounded
    expect(b.expectedReturn).toMatchObject({
      basis: "served_return",
      returnHalf: "flash",
      expectedRevenueUsd: Math.round(LEGISTAI_FLASH_ROI * 99 * 100) / 100,
      expectedPaidClients: Math.round(((LEGISTAI_FLASH_ROI * 99) / 2500) * 10000) / 10000,
      lifetimeRevenuePerClientUsd: 2500,
      nullReason: null,
      returnScopes: [
        {
          brandId: BRAND,
          offerId: OFFER,
          roiMultiple: LEGISTAI_FLASH_ROI,
          half: "flash",
          isMature: false,
          flashRoiMultiple: LEGISTAI_FLASH_ROI,
          matureRoiMultiple: null,
          pipelineUsd: 402.58,
          committedCostUsd: 92.94,
          nullReason: null,
        },
      ],
    });
    expect(b.budgetIncrease).toMatchObject({
      amountUsd: 100,
      basis: "linear_at_served_return",
      expectedAdditionalRevenueUsd: 433.16, // 100 × the served return
      expectedAdditionalPositiveReplies: 3.03,
      expectedAdditionalRecipientsEnrolled: 202, // 200 enrolled on $99 → $100 more lines up 202.02
      expectedAdditionalRecipientsEnrolledNullReason: null,
      revenueMultiple: 2.01,
      nullReason: null,
    });
  });

  it("a mature offer is shown its MATURE return", async () => {
    setDeps({ offerReturn: async () => offerReturn({ flash: { roiMultiple: 9 }, mature: { roiMultiple: 2.5 }, isMature: true }) });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: 2.5, returnHalf: "mature" });
    expect(res.body.budgetIncrease.expectedAdditionalRevenueUsd).toBe(250);
  });

  it("a not-mature offer at or under 1x reads Learning on the dashboard → null + return_learning, never a figure", async () => {
    setDeps({ offerReturn: async () => offerReturn({ flash: { roiMultiple: 0.8 }, mature: { roiMultiple: null }, isMature: false }) });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, expectedRevenueUsd: null, nullReason: "return_learning" });
    expect(res.body.budgetIncrease).toMatchObject({ expectedAdditionalRevenueUsd: null, revenueMultiple: null, nullReason: "return_learning" });
    expect(res.body.expectedPositiveReplies).toBe(3);
  });

  it("two offers shown different returns → null + return_differs_across_scopes, never a blend", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    setDeps({
      offers: async () => [offer(null), offer(null, OTHER)],
      offerReturn: async (_o, _b, offerId) =>
        offerReturn(offerId === OFFER ? NOT_MATURE : { flash: { roiMultiple: 2 }, mature: { roiMultiple: null }, isMature: false }, offerId),
    });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, nullReason: "return_differs_across_scopes" });
    expect(res.body.expectedReturn.returnScopes.map((s: { offerId: string }) => s.offerId)).toEqual([OFFER, OTHER]);
  });

  it("an offer with no campaign is not a scope; the one that sends states the return", async () => {
    setDeps({
      offers: async () => [offer(null), offer(null, "44444444-4444-4444-8444-444444444444")],
      offerReturn: async (_o, _b, offerId) => (offerId === OFFER ? offerReturn(NOT_MATURE) : null),
    });
    const res = await get();
    expect(res.body.expectedReturn.roiMultiple).toBe(LEGISTAI_FLASH_ROI);
  });

  it("an unreadable served return is a 502, never the window's valuation", async () => {
    setDeps({ offerReturn: async () => { throw new Error("offer revenue failed"); } });
    expect((await get()).status).toBe(502);
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
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, expectedRevenueUsd: null, nullReason: "nothing_sent", lifetimeRevenueNullReason: "nothing_sent", returnScopes: [] });
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
    // The return does not depend on the reply rate: it is the served one.
    expect(res.body.expectedReturn.roiMultiple).toBe(LEGISTAI_FLASH_ROI);
    expect(res.body.budgetIncrease).toMatchObject({ expectedAdditionalPositiveReplies: null, nullReason: "reply_rate_unavailable" });
    expect(res.body.outbound.emailsSent).toBe(400);
  });

  it("a sending brand whose offer states no lifetime revenue → none (economics_missing), the served return still stated", async () => {
    setDeps({ offers: async () => [offer(null)] });
    const res = await get();
    expect(res.body.expectedPositiveReplies).toBe(3);
    expect(res.body.expectedReturn).toMatchObject({
      roiMultiple: LEGISTAI_FLASH_ROI,
      expectedPaidClients: null,
      lifetimeRevenuePerClientUsd: null,
      lifetimeRevenueNullReason: "economics_missing",
    });
  });

  it("the lifetime revenue is the customer's STATED offer value, said so (Legistai, 2026-10-04)", async () => {
    // The retired brand economics said $2,500 (cross-brand-average); the customer stated $2,100 on the
    // offer, and that is the only value read now.
    setDeps({ offers: async () => [offer(2100)] });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: 2100,
      lifetimeRevenueSource: "offer_stated",
      roiMultiple: LEGISTAI_FLASH_ROI,
    });
    expect(res.body.brands[0]).toMatchObject({
      lifetimeRevenuePerClientUsd: 2100,
      lifetimeRevenueSource: "offer_stated",
      lifetimeRevenueOfferId: OFFER,
      lifetimeRevenueStatedAt: "2026-09-01 08:16:15.704+00",
    });
    // The brand-level economics' provenance is gone from the wire.
    expect(res.body.brands[0]).not.toHaveProperty("economicsSource");
  });

  it("no offer states a lifetime revenue → null + economics_missing, never the brand's (retired) economics or an average", async () => {
    setDeps({ offers: async () => [offer(null)] });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: null,
      lifetimeRevenueSource: null,
      lifetimeRevenueNullReason: "economics_missing",
      expectedPaidClients: null,
    });
    expect(res.body.brands[0]).toMatchObject({ lifetimeRevenuePerClientUsd: null, lifetimeRevenueSource: null, lifetimeRevenueOfferId: null });
  });

  it("offers stating different lifetime revenues → null + lifetime_revenue_differs_across_offers, never an average", async () => {
    setDeps({ offers: async () => [offer(2100), offer(900, "44444444-4444-4444-8444-444444444444")] });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: null,
      lifetimeRevenueNullReason: "lifetime_revenue_differs_across_offers",
      expectedPaidClients: null,
    });
    expect(res.body.expectedPositiveReplies).toBe(3);
  });

  it("a brand the org no longer holds (offers null) still counts its sends; its return is unreadable, said so", async () => {
    setDeps({ offers: async () => null });
    const res = await get();
    expect(res.body.outbound.recipientsContacted).toBe(200);
    // No statements to read → no lifetime revenue either (no brand-economics fallback any more).
    expect(res.body.expectedReturn).toMatchObject({
      lifetimeRevenuePerClientUsd: null,
      lifetimeRevenueSource: null,
      lifetimeRevenueNullReason: "economics_missing",
      roiMultiple: null,
      nullReason: "return_unavailable",
    });
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

  it("sends but no spend in the window → the return and +$100 stand, the per-window-dollar figures say no_spend_in_window", async () => {
    setDeps({ spendByDay: async () => new Map() });
    const res = await get();
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: LEGISTAI_FLASH_ROI, expectedRevenueUsd: 0, nullReason: null });
    expect(res.body.budgetIncrease).toMatchObject({
      expectedAdditionalRevenueUsd: 433.16,
      revenueMultiple: null,
      expectedAdditionalPositiveReplies: null,
      expectedAdditionalRecipientsEnrolled: null,
      expectedAdditionalRecipientsEnrolledNullReason: "no_spend_in_window",
      nullReason: "no_spend_in_window",
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

describe("actualOutcomes: what HAPPENED in the window, on the dashboard's dated series (billing's informational email)", () => {
  const series = (daily: Array<[string, number]>, undatedCount = 0) => ({
    total: daily.reduce((n, [, c]) => n + c, 0) + undatedCount,
    daily: daily.map(([date, count]) => ({ date, count })),
    undatedCount,
  });
  type Series = ReturnType<typeof series>;
  const withOutcomes = (replies: Series | null, meetings: Series | null, offerId = OFFER) => ({
    ...offerReturn(NOT_MATURE, offerId),
    outcomeSeries: { positiveReplies: replies, meetingsBooked: meetings },
  });

  it("sums the served dated series over the window's days only", async () => {
    setDeps({
      offerReturn: async () =>
        withOutcomes(series([["2026-08-01", 5], ["2026-09-20", 2], ["2026-10-14", 1], ["2026-10-15", 9]]), series([["2026-09-25", 1]])),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.actualOutcomes).toEqual({
      basis: "dashboard_dated_series",
      positiveReplies: 3, // 09-20 + 10-14 (both bounds inclusive), never 08-01 nor 10-15
      positiveRepliesNullReason: null,
      meetingsBooked: 1,
      meetingsBookedNullReason: null,
    });
  });

  it("counts a brand that sent NOTHING in the window (a reply lands on an earlier send); its return is not a scope", async () => {
    const QUIET = "44444444-4444-4444-8444-444444444444";
    setDeps({
      brandIds: async () => [BRAND, QUIET],
      brandDays: async (_o, brandId) => (brandId === BRAND ? [day("2026-09-20", 200, 100)] : [day("2026-08-01", 50, 50)]),
      offerReturn: async (_o, brandId) =>
        brandId === BRAND ? withOutcomes(series([]), series([])) : withOutcomes(series([["2026-09-30", 2]]), series([["2026-10-02", 1]]), "o-quiet"),
    });
    const res = await get();
    expect(res.body.actualOutcomes).toMatchObject({ positiveReplies: 2, meetingsBooked: 1 });
    expect(res.body.expectedReturn.returnScopes.map((s: { brandId: string }) => s.brandId)).toEqual([BRAND]);
  });

  it("an unreadable series is null outcomes_unavailable, an undated outcome null undated_outcomes — never 0", async () => {
    setDeps({ offerReturn: async () => withOutcomes(null, series([["2026-09-25", 1]], 1)) });
    const res = await get();
    expect(res.body.actualOutcomes).toMatchObject({
      positiveReplies: null,
      positiveRepliesNullReason: "outcomes_unavailable",
      meetingsBooked: null,
      meetingsBookedNullReason: "undated_outcomes",
    });
  });

  it("nothing happened is a measured 0", () => {
    expect(windowOutcomeCount([series([["2026-08-01", 4]])], new Set(["2026-09-20"]))).toEqual({ count: 0, nullReason: null });
    expect(windowOutcomeCount([], new Set(["2026-09-20"]))).toEqual({ count: 0, nullReason: null });
  });
});

describe("org-period-recap pure helpers", () => {
  it("windowDays is inclusive and isCalendarDay refuses rolled-over dates", () => {
    expect(windowDays("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("brands valued differently → no single lifetime revenue, the shared served return still stated", () => {
    const r = buildOrgPeriodRecap({
      orgId: ORG,
      from: "2026-09-15",
      to: "2026-10-14",
      now: NOW,
      brands: [
        { brandId: "a", days: [day("2026-09-20", 10, 100)], offers: [offer(2500)], returns: [offerReturn(NOT_MATURE)] },
        { brandId: "b", days: [day("2026-09-20", 10, 100)], offers: [offer(1000)], returns: [offerReturn(NOT_MATURE, "o2")] },
      ],
      spendByDay: new Map([["2026-09-20", 100]]),
      fleetRate: FLEET,
    });
    expect(r.expectedReturn.lifetimeRevenuePerClientUsd).toBeNull();
    expect(r.expectedReturn.lifetimeRevenueNullReason).toBe("lifetime_revenue_differs_across_brands");
    expect(r.expectedReturn.roiMultiple).toBe(LEGISTAI_FLASH_ROI);
    expect(r.expectedReturn.returnScopes.map((s) => s.brandId)).toEqual(["a", "b"]);
  });
});
