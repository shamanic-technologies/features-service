/**
 * THE TODAY PAGE'S WINDOW (lib/revenue-window.ts) and TODAY'S SPEND on the offer grain.
 *
 *   - an unwindowed read carries no `window` and is otherwise byte-equal to the windowed one;
 *   - today's actual spend counts the brand's campaign-less work (setup, notifications) — prod
 *     2026-10-03, brand 7d9cc3d9…: $31.22 served while runs held $37.07 for the brand;
 *   - every window total is the sum of its own daily values;
 *   - the expected pipeline curve ends at the headline;
 *   - an unrecognised windowDays is a 400.
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
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const PITCH = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER = "offer-a";

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`, slug, name: slug, description: "x", status: "active",
  outputs: [], charts: [], entities: [],
  createdAt: new Date(), updatedAt: new Date(),
});

/** A positively-replying lead is worth LTR x replyToMeeting x meetingToClose = 1000 x .4 x .3 = 120. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
  // The single-step rates the positiveReply / websiteVisit goals price on directly.
  replyToPaidClientPct: 12,
  visitToPaidClientPct: 1,
  visitToFormSubmissionPct: 8,
  formSubmissionToPaidClientPct: 5,
};

function replyLead(campaignId: string, leadId: string): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    workflowSlug: "dawn-v1",
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    replied: true,
    replyClassification: "positive",
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}


const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const CAMPAIGNS: Record<string, { offerId: string; featureSlug: string }> = {
  c1: { offerId: OFFER, featureSlug: PITCH },
  c9: { offerId: "offer-b", featureSlug: PITCH },
};

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      return json({
        campaigns: Object.entries(CAMPAIGNS).map(([id, row]) => ({
          id, orgId: "org-1", brandId: "b1", featureSlug: row.featureSlug, funnelKey: "sales_meetings_from_conversation",
          acquisitionChannel: row.featureSlug, offerId: row.offerId, status: "ongoing", createdAt: "2026-01-01T00:00:00.000Z",
        })),
      });
    }
    if (path.includes("/offer-economics")) return new Response("not found", { status: 404 });
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.endsWith("/costs/timeseries")) {
      // c1 spent yesterday and today; the brand's campaign-less setup ran today, on no channel.
      const rows = [
        // `total` = committed (actual + open holds): c1 holds 1886.2 today, the setup 10.
        { period: YESTERDAY, campaignId: "c1", cents: "1000.4", total: "1000.4" },
        { period: TODAY, campaignId: "c1", cents: "2722.3", total: "4608.5" },
        { period: TODAY, campaignId: "c9", cents: "5000", total: "9000" },
        { period: TODAY, campaignId: null, cents: "584.6", total: "594.6" },
      ].filter((r) => {
        const ids = q.get("campaignIds")?.split(",");
        if (ids && (!r.campaignId || !ids.includes(r.campaignId))) return false;
        if (q.get("featureSlugs") && !r.campaignId) return false;
        return true;
      });
      return json({
        interval: "day", timezone: "UTC",
        buckets: rows.map((r) => ({ period: r.period, campaignId: r.campaignId, actualCostInUsdCents: r.cents, netActualCostInUsdCents: r.cents, totalCostInUsdCents: r.total, netTotalCostInUsdCents: r.total })),
      });
    }
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});
    if (path.includes("/stats/costs")) {
      const groupBy = q.get("groupBy") ?? "";
      if (groupBy === "campaignId,featureSlug") {
        // The brand-level today read: no feature filter, so campaign-less rows of every feature appear.
        return json({ groups: [
          { dimensions: { campaignId: "c1", featureSlug: PITCH }, totalCostInUsdCents: "2722", actualCostInUsdCents: "2722", netTotalCostInUsdCents: "2722", netActualCostInUsdCents: "2722", runCount: 1 },
          { dimensions: { campaignId: null, featureSlug: PITCH }, totalCostInUsdCents: "7", actualCostInUsdCents: "7", netTotalCostInUsdCents: "7", netActualCostInUsdCents: "7", runCount: 1 },
          { dimensions: { campaignId: null, featureSlug: null }, totalCostInUsdCents: "578", actualCostInUsdCents: "578", netTotalCostInUsdCents: "578", netActualCostInUsdCents: "578", runCount: 1 },
        ] });
      }
      const ids = (q.get("campaignIds") ?? q.get("campaignId") ?? "c1").split(",");
      const today = q.get("startedAfter") !== null;
      const cents = today ? "2722" : "3722";
      const groups = ids.includes("c1")
        ? [{ dimensions: { campaignId: "c1", workflowSlug: "dawn-v1", costName: "apollo" }, totalCostInUsdCents: cents, actualCostInUsdCents: cents, netTotalCostInUsdCents: cents, netActualCostInUsdCents: cents, runCount: 1, minStartedAt: null, maxStartedAt: null }]
        : [];
      return json({ groups });
    }
    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (path.endsWith("/orgs/leads")) {
      return json({ leads: [{
        leadId: "l1", campaignId: "c1", workflowSlug: "dawn-v1", email: "l1@x.com", contacted: true, sent: true, delivered: true,
        clicked: false, bounced: false, unsubscribed: false, replied: true, replyClassification: "positive",
        lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "o1", logoUrl: null } },
      }] });
    }
    if (path.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 1000 });
    if (path.endsWith("/orgs/stats")) {
      if (q.get("groupBy") === "day") {
        return json({ groups: [
          { key: YESTERDAY, broadcast: { recipientStats: { contacted: 10 }, emailStats: { sent: 100, delivered: 95, bounced: 5 } } },
          { key: TODAY, broadcast: { recipientStats: { contacted: 3 }, emailStats: { sent: 20, delivered: 20, bounced: 1 } } },
        ] });
      }
      return json({ groups: [] });
    }
    return json({});
  });
}

describe("GET /offers/:offerId/revenue — today's spend and ?windowDays=", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation((async () => FEATURE_ROW(PITCH)) as never);
    vi.mocked(db.query.features.findMany).mockResolvedValue([FEATURE_ROW(PITCH)] as never);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  const read = (extra = "") => request(app).get(`/offers/${OFFER}/revenue?brandId=b1&pricing=net${extra}`).set(AUTH);

  it("today's actual spend counts the brand's campaign-less work; the lifetime figures do not move", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.spend.actualSpentTodayCents).toBe(2722 + 7 + 578);
    expect(res.body.spend.totalSpentTodayCents).toBe(2722 + 7 + 578);
    expect(res.body.spend.actualSpentCents).toBe(3722);
  });

  it("an unwindowed read has no `window` and is byte-equal to the windowed one without it", async () => {
    const plain = await read();
    const windowed = await read("&windowDays=7");
    expect(plain.status).toBe(200);
    expect(windowed.status).toBe(200);
    expect("window" in plain.body).toBe(false);
    const { window, ...rest } = windowed.body;
    expect(window).toBeTruthy();
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain.body));
  });

  it("every window total is the sum of its own daily values", async () => {
    const { body } = await read("&windowDays=7");
    const w = body.window;
    expect(w.days).toBe(7);
    expect(w.endDate).toBe(TODAY);
    expect(w.emails.daily).toHaveLength(7);
    expect(w.emails.sent).toBe(120);
    expect(w.emails.sent).toBe(w.emails.daily.reduce((s: number, d: { sent: number }) => s + d.sent, 0));
    expect(w.emails.bounced).toBe(6);
    expect(w.emails.deliveryRatePct).toBeCloseTo((115 / 120) * 100);
    // c1 yesterday 1000 + c1 today 2722 + the campaign-less 585 today (c9 is another offer's).
    expect(w.spend.daily.at(-1)).toEqual({
      date: TODAY,
      actualSpentCents: 3307,
      brandLevelActualSpentCents: 585,
      totalSpentCents: 5203,
      provisionedSpentCents: 1896,
      brandLevelTotalSpentCents: 595,
    });
    expect(w.spend.actualSpentCents).toBe(1000 + 3307);
    expect(w.spend.actualSpentCents).toBe(w.spend.daily.reduce((s: number, d: { actualSpentCents: number }) => s + d.actualSpentCents, 0));
    expect(w.spend.costPerEmailSentCents).toBeCloseTo(4307 / 120);
    // The committed total (what the Spent tile states): actual + open holds, brand-level work included.
    expect(w.spend.totalSpentCents).toBe(1000 + 5203);
    expect(w.spend.totalSpentCents).toBe(w.spend.daily.reduce((s: number, d: { totalSpentCents: number }) => s + d.totalSpentCents, 0));
    expect(w.spend.provisionedSpentCents).toBe(1896);
    expect(w.spend.totalCostPerEmailSentCents).toBeCloseTo(6203 / 120);
    expect(w.recipientsRepliesPositive.total).toBe(
      w.recipientsRepliesPositive.daily.reduce((s: number, d: { count: number }) => s + d.count, 0),
    );
    expect(w.expectedPipeline.totalPipelineUsd).toBe(body.headline.totalPipelineUsd);
  });

  it("an unrecognised windowDays is a 400", async () => {
    const res = await read("&windowDays=7d");
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("window_days_unrecognised");
  });
});
