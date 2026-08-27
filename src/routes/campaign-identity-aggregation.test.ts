/**
 * A campaign's figures are its IDENTITY's figures.
 *
 * The reported prod case: one brand, ONE real campaign, and ~130 campaign rows — campaign-service
 * used to create a new one every time workflow selection switched workflows. The Campaigns page read
 * one line per row: dozens at 0.0x / $0.00 beside the single row carrying six weeks of history.
 *
 * These drive `/revenue` from ONE downstream fixture and assert that every member of a family —
 * the live campaign and each of its stopped ancestors — reports the campaign's whole total, that
 * the spend is the members' spend summed, that a lead served under two of them is ONE lead, and
 * that a brand with one campaign per identity is byte-unchanged.
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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
// The feature must DECLARE the recipient keys — /stats scopes its fan-out to a feature's declared
// outputs, so a mock without them skips email-gateway AND the engagement snapshot entirely.
const RECIPIENT_KEYS = [
  "recipientsContacted", "recipientsSent", "recipientsDelivered", "recipientsOpened", "recipientsClicked",
  "recipientsBounced", "recipientsRepliesPositive", "recipientsRepliesNegative", "recipientsRepliesNeutral",
  "recipientsRepliesAutoReply",
];
const SALES_FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active",
  outputs: RECIPIENT_KEYS.map((key) => ({ key })),
  charts: [],
  createdAt: new Date(), updatedAt: new Date(),
};
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};
const PLATFORM_STATS = {
  broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, clicked: 10, repliesPositive: 10 } },
};

/** A positively-replying lead — EV 120 with the economics above. */
function replyLead(campaignId: string, leadId: string): Record<string, unknown> {
  return {
    leadId,
    campaignId,
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

interface Fixture {
  /** campaign-service rows, verbatim shape. */
  campaigns: Array<Record<string, unknown>>;
  /** Per-campaign ACTUAL cost cents. */
  costByCampaign: Record<string, number>;
  /** Every lead row the brand has, each carrying its own campaignId. */
  leads: Array<Record<string, unknown>>;
  /**
   * What email-gateway answers per campaign — one recipient row per send, so a person served under
   * two campaigns is in BOTH answers. Present only on the suites that assert the person-grain
   * counts; absent leaves `/orgs/stats` empty, as the older cases expect.
   */
  emailByCampaign?: Record<string, number>;
  /** What email-gateway answers for the whole brand — its own distinct count at that grain. */
  emailBrandTotal?: number;
  /** Auto-replies per campaign — the one person-grain key no lead evidence can produce. */
  emailAutoReplyByCampaign?: Record<string, number>;
  /** What the brand DECLARED it sells through. Absent → brand-service serves nothing readable. */
  salesFunnels?: Array<Record<string, unknown>>;
}

/** email-gateway's `/orgs/stats` shape for a given recipient count. */
function recipientStats(contacted: number, autoReply = 0): Record<string, unknown> {
  return {
    broadcast: {
      recipientStats: {
        contacted,
        sent: contacted,
        delivered: contacted,
        opened: 0,
        clicked: 0,
        bounced: 0,
        repliesPositive: contacted,
        repliesNegative: 0,
        repliesNeutral: 0,
        repliesAutoReply: autoReply,
      },
    },
  };
}

function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) return json({ campaigns: fixture.campaigns });
    if (url.includes("/sales-funnels")) {
      if (!fixture.salesFunnels) return new Response("not found", { status: 404 });
      return json({ funnels: fixture.salesFunnels });
    }

    if (url.includes("/stats/costs")) {
      const ids = cid ? [cid] : Object.keys(fixture.costByCampaign);
      // Every cost read here co-groups campaignId (the enumeration, and a family's own read).
      const groups = ids.map((id) => ({
        dimensions: { campaignId: id, workflowSlug: "wf-1", costName: "email-send" },
        totalCostInUsdCents: String(fixture.costByCampaign[id] ?? 0),
        actualCostInUsdCents: String(fixture.costByCampaign[id] ?? 0),
        runCount: 1,
        minStartedAt: null,
        maxStartedAt: null,
      }));
      return json({ groups });
    }
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/public/stats")) return json(PLATFORM_STATS);
    if (url.includes("/orgs/leads")) {
      // lead-service scopes by campaign when asked, else serves the brand's whole page.
      return json({ leads: cid ? fixture.leads.filter((l) => l.campaignId === cid) : fixture.leads });
    }
    if (url.includes("/orgs/stats") && fixture.emailByCampaign) {
      if (url.includes("groupBy=campaignId")) {
        return json({
          groups: Object.entries(fixture.emailByCampaign).map(([id, n]) => ({
            key: id,
            ...recipientStats(n, fixture.emailAutoReplyByCampaign?.[id] ?? 0),
          })),
        });
      }
      const single = cid ?? (new URL(url).searchParams.get("campaignId") ?? undefined);
      const n = single ? (fixture.emailByCampaign[single] ?? 0) : (fixture.emailBrandTotal ?? 0);
      return json(recipientStats(n));
    }
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/orgs/status")) return json({ results: [] });
    return json({});
  });
}

/** 2 stopped ancestors + 1 live campaign, all on ONE identity — the reported prod shape. */
const FAMILY = [
  { id: "stopped-1", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: null, acquisitionChannel: "cold_email", status: "stopped", createdAt: "2026-06-01T00:00:00.000Z" },
  { id: "stopped-2", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: null, acquisitionChannel: "cold_email", status: "stopped", createdAt: "2026-06-15T00:00:00.000Z" },
  { id: "live", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: null, acquisitionChannel: "cold_email", status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z" },
];

describe("campaign figures are the campaign IDENTITY's figures", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("totals the stopped ancestors into the live campaign — every member reports the same whole campaign", async () => {
    mockFetch({
      campaigns: FAMILY,
      costByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000 },
      leads: [replyLead("stopped-1", "l1"), replyLead("stopped-2", "l2"), replyLead("live", "l3")],
    });

    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId")
      .set(AUTH);
    expect(grouped.status).toBe(200);

    // Three leads at EV 120, and $30 + $20 + $50 of spend — one campaign's numbers.
    const byId = Object.fromEntries(grouped.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
    expect(Object.keys(byId).sort()).toEqual(["live", "stopped-1", "stopped-2"]);
    for (const id of ["live", "stopped-1", "stopped-2"]) {
      expect(byId[id].headline.totalPipelineUsd).toBeCloseTo(360, 6);
      expect(byId[id].costEconomics.actualCostUsd).toBeCloseTo(100, 6);
      expect(byId[id].costEconomics.roiMultiple).toBeCloseTo(3.6, 6);
      // The identity names the family and the LIVE member a consumer renders the line on.
      expect(byId[id].campaignIdentity.campaignIds).toEqual(["live", "stopped-1", "stopped-2"]);
      expect(byId[id].campaignIdentity.representativeId).toBe("live");
      expect(byId[id].campaignIdentity.liveCampaignIds).toEqual(["live"]);
      // The funnel is UNSTATED here, and stays so — never inferred from the campaign's goal.
      expect(byId[id].campaignIdentity.funnelKey).toBeNull();
      expect(byId[id].campaignIdentity.acquisitionChannel).toBe("cold_email");
    }

    // Asking about ANY member — the live row or a stopped ancestor — returns that same campaign.
    for (const id of ["live", "stopped-1"]) {
      const single = await request(app)
        .get(`/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=${id}`)
        .set(AUTH);
      expect(single.status).toBe(200);
      expect(single.body.headline.totalPipelineUsd).toBeCloseTo(360, 6);
      expect(single.body.costEconomics.actualCostUsd).toBeCloseTo(100, 6);
      expect(single.body.spend.actualSpentCents).toBe(10000);
      expect(single.body.leads).toHaveLength(3);
      expect(single.body.campaignIdentity.representativeId).toBe("live");
    }
  });

  it("counts a lead served under two members ONCE — a campaign's own total can never exceed the brand's", async () => {
    mockFetch({
      campaigns: FAMILY,
      costByCampaign: { "stopped-1": 3000, live: 5000 },
      // The SAME lead, re-served under the live campaign after its ancestor stopped.
      leads: [replyLead("stopped-1", "shared"), { ...replyLead("live", "shared"), campaignId: "live" }],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=live")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(120, 6); // one lead, not two
  });

  it("a brand with ONE campaign per identity is unchanged — each campaign still reports only its own", async () => {
    mockFetch({
      campaigns: [
        { id: "cold", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "crm", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "crm_email", status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z" },
      ],
      costByCampaign: { cold: 3000, crm: 5000 },
      leads: [replyLead("cold", "l1"), replyLead("crm", "l2")],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId")
      .set(AUTH);

    const byId = Object.fromEntries(res.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
    expect(byId.cold.headline.totalPipelineUsd).toBeCloseTo(120, 6);
    expect(byId.cold.costEconomics.actualCostUsd).toBeCloseTo(30, 6);
    expect(byId.crm.headline.totalPipelineUsd).toBeCloseTo(120, 6);
    expect(byId.crm.costEconomics.actualCostUsd).toBeCloseTo(50, 6);
    expect(byId.cold.campaignIdentity.campaignIds).toEqual(["cold"]);
  });

  it("/stats reports the identity's cost too — the Campaigns page cannot show two totals for one campaign", async () => {
    mockFetch({
      campaigns: FAMILY,
      costByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000 },
      leads: [],
    });

    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&groupBy=campaignId")
      .set(AUTH);
    expect(grouped.status).toBe(200);
    const byId = Object.fromEntries(grouped.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
    expect(Object.keys(byId).sort()).toEqual(["live", "stopped-1", "stopped-2"]);
    for (const id of ["live", "stopped-1", "stopped-2"]) {
      expect(byId[id].systemStats.actualCostInUsdCents).toBe(10000);
      expect(byId[id].campaignIdentity.representativeId).toBe("live");
    }

    // The single-campaign read agrees with the group — same campaign, same number.
    const single = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&campaignId=stopped-1")
      .set(AUTH);
    expect(single.status).toBe(200);
    expect(single.body.systemStats.actualCostInUsdCents).toBe(10000);
  });

  it("a campaign identity never reports more PEOPLE than its brand — the members' recipient rows are not added", async () => {
    // The prod shape (features-service#749): several member campaigns of one identity contacted the
    // SAME people. email-gateway answers each campaign separately, so folding those answers counted
    // `shared` three times — the identity read 4 contacted where the brand reads 2.
    mockFetch({
      campaigns: FAMILY,
      costByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000 },
      leads: [
        replyLead("stopped-1", "shared"),
        replyLead("stopped-2", "shared"),
        replyLead("live", "shared"),
        replyLead("live", "only-live"),
      ],
      // What email-gateway serves per campaign: one recipient row per send, so `shared` is in all three.
      emailByCampaign: { "stopped-1": 1, "stopped-2": 1, live: 2 },
      emailBrandTotal: 2,
    });

    const brand = await request(app).get("/features/sales-cold-email-outreach/stats?brandId=b1").set(AUTH);
    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&groupBy=campaignId")
      .set(AUTH);
    expect(brand.status).toBe(200);
    expect(grouped.status).toBe(200);

    // Two distinct people for the brand, and the identity holds every one of them — not one more.
    expect(brand.body.stats.recipientsContacted).toBe(2);
    expect(brand.body.stats.recipientsRepliesPositive).toBe(2);
    const byId = Object.fromEntries(grouped.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
    for (const id of ["live", "stopped-1", "stopped-2"]) {
      expect(byId[id].stats.recipientsContacted).toBe(2);
      expect(byId[id].stats.recipientsSent).toBe(2);
      expect(byId[id].stats.recipientsRepliesPositive).toBe(2);
      // The one person-grain figure no lead evidence can produce is not summed into the same
      // over-count — a multi-member identity says "could not count" instead.
      expect(byId[id].stats.recipientsRepliesAutoReply).toBeNull();
    }

    // The single-campaign read of a member is the same campaign, so it agrees with the group.
    const single = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&campaignId=stopped-1")
      .set(AUTH);
    expect(single.status).toBe(200);
    expect(single.body.stats.recipientsContacted).toBe(2);
    expect(single.body.stats.recipientsRepliesPositive).toBe(2);
    expect(single.body.stats.recipientsRepliesAutoReply).toBeNull();
  });

  it("a brand with ONE campaign per identity still reports each campaign's own people", async () => {
    mockFetch({
      campaigns: [
        { id: "cold", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "crm", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "crm_email", status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z" },
      ],
      costByCampaign: { cold: 3000, crm: 5000 },
      leads: [replyLead("cold", "l1"), replyLead("cold", "l2"), replyLead("crm", "l3")],
      emailByCampaign: { cold: 2, crm: 1 },
      emailBrandTotal: 3,
      // A single-member identity has nothing to double-count, so this key still answers.
      emailAutoReplyByCampaign: { cold: 1, crm: 0 },
    });

    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&groupBy=campaignId")
      .set(AUTH);
    const byId = Object.fromEntries(grouped.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
    expect(byId.cold.stats.recipientsContacted).toBe(2);
    expect(byId.crm.stats.recipientsContacted).toBe(1);
    expect(byId.cold.stats.recipientsRepliesAutoReply).toBe(1);
  });

  it("degrades to per-campaign figures, never to a wrong number, when campaign-service is unreachable", async () => {
    mockFetch({
      campaigns: FAMILY,
      costByCampaign: { "stopped-1": 3000, live: 5000 },
      leads: [replyLead("stopped-1", "l1"), replyLead("live", "l2")],
    });
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
      if (url.includes("/campaigns?")) return new Response("boom", { status: 500 });
      return inner(input, init);
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=live")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(120, 6); // its own row only
    expect(res.body.campaignIdentity.campaignIds).toEqual(["live"]);
  });
});

/**
 * A campaign STATES the funnel it sells (campaign-service stores `funnel_key` on the row), so a read
 * scoped to that campaign is priced on THAT funnel — its legs and its terms — not on the brand's first
 * declared funnel. The brand-scoped read keeps the deterministic first-declared pick it has today.
 */
describe("a campaign is priced on ITS OWN declared funnel, not the brand's first", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Two campaigns on the same brand, each stating a different funnel. */
  const TWO_FUNNELS = [
    { id: "conv", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", status: "ongoing", createdAt: "2026-06-01T00:00:00.000Z" },
    { id: "web", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", funnelKey: "website_purchases", acquisitionChannel: "cold_email", status: "ongoing", createdAt: "2026-06-02T00:00:00.000Z" },
  ];
  // The conversation funnel is FIRST in catalogue order, so it is what the brand-scoped read prices on.
  const DECLARED = [
    {
      funnelKey: "sales_meetings_from_conversation", active: true, name: "Meetings from conversations",
      steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
      rates: { replyToMeetingPct: 50, meetingToClosePct: 70 }, // reply→paid 35%
      lifetimeRevenueUsd: 2500, destinationUrl: null, bookingUrl: null, updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      funnelKey: "website_purchases", active: true, name: "Website purchases",
      steps: ["Website visit", "Signup", "Paid client"],
      rates: { visitToClosePct: 4 }, // visit→paid 4%
      lifetimeRevenueUsd: 2500, destinationUrl: null, bookingUrl: null, updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  /** A lead that only CLICKED — a leg of the website funnel, of no step of the conversation one. */
  function clickLead(campaignId: string, leadId: string): Record<string, unknown> {
    return { ...replyLead(campaignId, leadId), replied: false, replyClassification: null, clicked: true };
  }

  it("each campaign prices its own funnel's legs, and the brand prices the first declared one", async () => {
    const fixture = {
      campaigns: TWO_FUNNELS,
      costByCampaign: { conv: 1000, web: 1000 },
      leads: [replyLead("conv", "lr"), clickLead("web", "lc")],
      salesFunnels: DECLARED,
    };

    // The conversation campaign: its reply is a leg, priced on its OWN terms (2500 × 50% × 70% = 875).
    mockFetch(fixture);
    const conv = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=conv").set(AUTH);
    expect(conv.status).toBe(200);
    expect(conv.body.headline.totalPipelineUsd).toBe(875);

    // The website-purchase campaign: its visit is a leg, priced on ITS declared visit→paid 4% (the
    // meeting terms fall through to the brand-wide record): 2500 × orP(0.04, 0.05 × 0.30) = 136. Had it
    // been priced on the brand's FIRST declared funnel, a click would have bought nothing at all.
    mockFetch(fixture);
    const web = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=web").set(AUTH);
    expect(web.status).toBe(200);
    expect(web.body.headline.totalPipelineUsd).toBeCloseTo(136, 6);

    // The BRAND-scoped read is priced on every declared funnel's legs — both leads count — with the
    // FIRST declared funnel's terms, exactly as before: the click now runs the conversation funnel's
    // 70% meeting→paid over the brand-wide 2% self-serve, 2500 × orP(0.02, 0.05 × 0.70) = 135.75.
    mockFetch(fixture);
    const brand = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.headline.totalPipelineUsd).toBeCloseTo(875 + 135.75, 6);
  });

  it("an explicit `?funnel=` still wins over the campaign's own funnel (the caller asked for it)", async () => {
    mockFetch({
      campaigns: TWO_FUNNELS,
      costByCampaign: { conv: 1000, web: 1000 },
      leads: [replyLead("conv", "lr")],
      salesFunnels: DECLARED,
    });
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=conv&funnel=website_purchases")
      .set(AUTH);
    expect(res.status).toBe(200);
    // A positive reply is a step of no website funnel → nothing.
    expect(res.body.headline.totalPipelineUsd).toBe(0);
  });

  it("a campaign that states NO funnel falls back to the brand's deterministic pick", async () => {
    mockFetch({
      campaigns: FAMILY, // every member states funnelKey: null
      costByCampaign: { "stopped-1": 0, "stopped-2": 0, live: 1000 },
      leads: [replyLead("live", "lr")],
      salesFunnels: DECLARED,
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=live").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(875); // the first declared funnel's own terms
  });
});
