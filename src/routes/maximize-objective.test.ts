/**
 * A CALLER SAYS WHAT IT IS MAXIMISING, AND THE TWO ANSWERS ARE A RETURN AND A CONVERSION RATE.
 *
 * Where the pool of people to reach is effectively unbounded the binding constraint is the customer's
 * BUDGET, so the thing to maximise is the return on it — that is what this service has always answered
 * and it stays the default. Where the pool is small and finite the binding constraint is the INVENTORY:
 * the list will be exhausted, so burning fewer people per outcome matters more than what each outcome
 * costs, and the thing to maximise is the CONVERSION RATE.
 *
 * ONE fixture drives every case so the two answers are comparable line by line — two workflows and two
 * declared funnels, deliberately built so that the ordering INVERTS between the objectives at BOTH
 * grains. Nothing here would fail if the parameter were ignored and everything ranked on return; every
 * case asserts the DIVERGENCE, which is the only thing that proves the parameter is load-bearing.
 *
 *  Spend is $100 on each workflow, and the brand declares both meeting funnels.
 *
 *    dyn-volume  — reached 10,000 people, 100 clicks, 1,000 positive replies. Cheap per outcome
 *                  (it reaches everybody) and it converts almost none of the people it burns.
 *    dyn-precise — reached 200 people, 20 clicks, 30 positive replies. Dear per outcome and it
 *                  converts a large share of the small list it touches.
 *
 *  Website funnel (click-bought, $20,000 a client):   return 400,000%; conversion rate 5%.
 *  Conversation funnel (reply-bought, $1,000 a client): return  200,000%; conversion rate 7.5%.
 *
 * So the return question answers "the website funnel, run by dyn-volume" and the conversion-rate
 * question answers "the conversation funnel, run by dyn-precise" — different on every axis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));

vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const PROJECTION = "/features/sales-cold-email-outreach/workflow-projection";
const RANKING = "/features/sales-cold-email-outreach/funnel-ranking";
/** The leg BOTH meeting funnels share — the case a campaign is now identified by. */
const SHARED_LEG = "meeting_booked_to_meeting_attended";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 50,
  visitToMeetingPct: 50,
  meetingToClosePct: 40,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};

const CONVERSATION_FUNNEL = {
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Conversation",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const WEBSITE_FUNNEL = {
  funnelKey: "sales_meetings_from_website",
  name: "Sales Meeting from Website",
  steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { visitToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 20000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const WORKFLOWS = [
  { id: "idv", workflowSlug: "wf-v", workflowName: "V", workflowDynastyName: "Volume", workflowDynastySlug: "dyn-volume", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "idp", workflowSlug: "wf-p", workflowName: "P", workflowDynastyName: "Precise", workflowDynastySlug: "dyn-precise", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];

const cost = (slug: string, cents: number) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null });
const email = (slug: string, contacted: number, clicked: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

const COSTS = [cost("wf-v", 10000), cost("wf-p", 10000)];
const STATS = [email("wf-v", 10000, 100, 1000), email("wf-p", 200, 20, 30)];

function mockFetch(funnels: unknown[] = [CONVERSATION_FUNNEL, WEBSITE_FUNNEL]): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: COSTS });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: COSTS });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      return json({ groups: STATS });
    }
    if (url.includes("/public/stats")) return json({ groups: STATS });
    if (url.includes("/sales-funnels")) return json({ funnels });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: [] });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const project = (query: string) => request(app).get(`${PROJECTION}?brandId=${BRAND}&${query}`).set(AUTH);
const rank = (query = "") => request(app).get(`${RANKING}?brandId=${BRAND}${query ? `&${query}` : ""}`).set(AUTH);
const brandRow = (body: any, slug: string) =>
  body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === slug);

describe("a caller says WHAT to maximise: a RETURN, or a CONVERSION RATE", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("the two objectives recommend DIFFERENT workflows for the same (brand, channel, leg)", async () => {
    mockFetch();
    const byReturn = await project(`leg=${SHARED_LEG}`);
    mockFetch();
    const byRate = await project(`leg=${SHARED_LEG}&maximize=conversionRate`);

    expect(byReturn.status).toBe(200);
    expect(byRate.status).toBe(200);
    // The whole point: same brand, same channel, same leg, two legitimate answers.
    expect(byReturn.body.recommendedWorkflowDynastySlug).toBe("dyn-volume");
    expect(byRate.body.recommendedWorkflowDynastySlug).toBe("dyn-precise");
    expect(byReturn.body.recommendedWorkflowDynastySlug).not.toBe(byRate.body.recommendedWorkflowDynastySlug);
  });

  it("EVERY response states the objective it was ranked under", async () => {
    mockFetch();
    expect((await project(`leg=${SHARED_LEG}`)).body.maximize).toBe("return");
    mockFetch();
    expect((await project(`leg=${SHARED_LEG}&maximize=conversionRate`)).body.maximize).toBe("conversionRate");
    mockFetch();
    expect((await project("goal=meetingBooked")).body.maximize).toBe("return");
    mockFetch();
    expect((await project("funnel=sales_meetings_from_website&maximize=conversion-rate")).body.maximize).toBe("conversionRate");
    mockFetch();
    expect((await rank()).body.maximize).toBe("return");
    mockFetch();
    expect((await rank("maximize=conversionRate")).body.maximize).toBe("conversionRate");
  });

  it("stating NOTHING is byte-identical to stating `return` — the behaviour that already existed", async () => {
    mockFetch();
    const silent = await project(`leg=${SHARED_LEG}`);
    mockFetch();
    const explicit = await project(`leg=${SHARED_LEG}&maximize=return`);
    expect(silent.body).toEqual(explicit.body);

    mockFetch();
    const silentRank = await rank();
    mockFetch();
    const explicitRank = await rank("maximize=return");
    expect(silentRank.body).toEqual(explicitRank.body);
  });

  it("a row carries BOTH figures under EITHER objective, so the two answers are readable side by side", async () => {
    mockFetch();
    const res = await project("funnel=sales_meetings_from_website");

    // dyn-volume: 100 clicks × 50% = 50 meetings off 10,000 people reached → 0.5%, at $2 each.
    const volume = brandRow(res.body, "dyn-volume");
    expect(volume.resolved.costPerOutcomeUsd).toBeCloseTo(2, 6);
    expect(volume.resolved.conversionRatePct).toBeCloseTo(0.5, 6);
    // dyn-precise: 20 clicks × 50% = 10 meetings off 200 people reached → 5%, at $10 each.
    const precise = brandRow(res.body, "dyn-precise");
    expect(precise.resolved.costPerOutcomeUsd).toBeCloseTo(10, 6);
    expect(precise.resolved.conversionRatePct).toBeCloseTo(5, 6);
    // Cheaper AND worse at converting — the inversion the objective exists to let a caller choose on.
    expect(volume.resolved.costPerOutcomeUsd).toBeLessThan(precise.resolved.costPerOutcomeUsd);
    expect(volume.resolved.conversionRatePct).toBeLessThan(precise.resolved.conversionRatePct);
  });

  it("the LEG is priced through the funnel that is best AT WHAT WAS ASKED FOR, and the basis says which", async () => {
    mockFetch();
    const byReturn = await project(`leg=${SHARED_LEG}`);
    mockFetch();
    const byRate = await project(`leg=${SHARED_LEG}&maximize=conversionRate`);

    // The website funnel returns twice as much per dollar; the conversation funnel converts half as
    // many people again. Neither answer is a compromise between them.
    expect(byReturn.body.leg.basisFunnelKey).toBe("sales_meetings_from_website");
    expect(byReturn.body.leg.basis).toBe("best_returning_declared_funnel");
    expect(byRate.body.leg.basisFunnelKey).toBe("sales_meetings_from_conversation");
    expect(byRate.body.leg.basis).toBe("best_converting_declared_funnel");
    // A body that ranked on a rate can never claim it ranked on a return.
    expect(byRate.body.leg.basis).not.toBe("best_returning_declared_funnel");
    // Both figures ride the block either way, so nobody has to re-derive the one they did not ask for.
    expect(byRate.body.leg.conversionRatePct).toBeCloseTo(7.5, 6);
    expect(byReturn.body.leg.returnPerDollar).toBeCloseTo(4000, 6);
    // Still the same funnel the body was priced through — the two can never disagree.
    expect(byRate.body.funnelKey).toBe(byRate.body.leg.basisFunnelKey);
    expect(byReturn.body.funnelKey).toBe(byReturn.body.leg.basisFunnelKey);
  });

  it("`/funnel-ranking` re-orders the SAME declared funnels under the two objectives", async () => {
    mockFetch();
    const byReturn = await rank();
    mockFetch();
    const byRate = await rank("maximize=conversionRate");

    expect(byReturn.body.ranking.map((r: any) => r.funnelKey)).toEqual([
      "sales_meetings_from_website",
      "sales_meetings_from_conversation",
    ]);
    expect(byRate.body.ranking.map((r: any) => r.funnelKey)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(byReturn.body.recommendation.funnelKey).toBe("sales_meetings_from_website");
    expect(byRate.body.recommendation.funnelKey).toBe("sales_meetings_from_conversation");
    // Each funnel states both figures under both objectives — the ordering moved, the evidence did not.
    for (const body of [byReturn.body, byRate.body]) {
      for (const row of body.ranking) {
        expect(typeof row.returnPerDollar).toBe("number");
        expect(typeof row.conversionRatePct).toBe("number");
      }
    }
  });

  it("VOLUME still governs: the evidence block is stated under both objectives, on the basis it used", async () => {
    mockFetch();
    const byRate = await project(`leg=${SHARED_LEG}&maximize=conversionRate`);
    // dyn-precise is what was recommended, so the count is ITS outcomes — 30 replies × 50%, not the
    // volume workflow's 500. A recommendation resting on 15 outcomes says 15.
    expect(byRate.body.leg.evidence.measured).toBe(true);
    expect(byRate.body.leg.evidence.grain).toBe("brand");
    expect(byRate.body.leg.evidence.resolvedOutcomeCount).toBeCloseTo(15, 6);

    mockFetch();
    const byReturn = await project(`leg=${SHARED_LEG}`);
    expect(byReturn.body.leg.evidence.resolvedOutcomeCount).toBeCloseTo(50, 6);
  });

  it("an UNRECOGNISED word FAILS LOUD on both surfaces rather than quietly ranking on return", async () => {
    mockFetch();
    const bad = await project(`leg=${SHARED_LEG}&maximize=whatever`);
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe("maximize_unrecognised");
    mockFetch();
    const badRank = await rank("maximize=cheapest");
    expect(badRank.status).toBe(400);
    expect(badRank.body.reason).toBe("maximize_unrecognised");
  });

  it("the British spelling of the KEY is accepted — the value is what carries the meaning", async () => {
    mockFetch();
    const res = await project(`leg=${SHARED_LEG}&maximise=conversionRate`);
    expect(res.status).toBe(200);
    expect(res.body.maximize).toBe("conversionRate");
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-precise");
  });
});
