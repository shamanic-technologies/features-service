/**
 * WHAT EACH OF A BRAND'S OFFERS RETURNS — the money grain between the brand and its campaigns.
 *
 * These drive `/revenue` from ONE downstream fixture and assert that the per-offer answer is the SAME
 * realized-money answer the brand read gives, at a finer grain: one group per offer, each computed
 * over the campaigns that sell it, and — the property that makes the two grains one number rather than
 * two — a brand selling ONE offer reading identically at both.
 *
 * They also pin the scoped reads (`?offerId=` on revenue, stats, audience-stats and pipeline-activity)
 * and what must NOT move: an absent offer leaves every response byte-identical to today, because the
 * dashboard merges straight to production with no staging buffer.
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
const SALES_FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active",
  outputs: [], charts: [], entities: [],
  createdAt: new Date(), updatedAt: new Date(),
};

/** A positively-replying lead is worth LTR x replyToMeeting x meetingToClose = 1000 x .4 x .3 = 120. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
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

/** Contacted and delivered, nothing else — this campaign reached the person and got no answer. */
function silentLead(campaignId: string, leadId: string): Record<string, unknown> {
  return { ...replyLead(campaignId, leadId), replied: false, replyClassification: null };
}

interface Fixture {
  /** campaign-service's rows: campaign id → the offer it states (null = it states none). */
  campaigns: Record<string, string | null>;
  /** runs-service spend, in cents, per campaign id. */
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** email-gateway per-audience send-tag engagement, per campaign id (the audience-stats scope). */
  engagementByCampaign?: Record<string, Record<string, { contacted: number; clicked: number; repliesPositive: number }>>;
  /** email-gateway day series, per campaign id (the pipeline-activity scope). */
  daysByCampaign?: Record<string, Record<string, { contacted: number; opened: number; clicked: number }>>;
  audiences?: Array<Record<string, unknown>>;
}

/** Every downstream this grain touches, keyed so a scoped read and a group hit identical evidence. */
function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      return json({
        campaigns: Object.entries(fixture.campaigns).map(([id, offerId]) => ({
          id,
          orgId: "org-1",
          brandId: "b1",
          featureSlug: "sales-cold-email-outreach",
          funnelKey: "sales_meetings_from_conversation",
          acquisitionChannel: "sales-cold-email-outreach",
          offerId,
          status: "ongoing",
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      });
    }
    if (path.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    // The cross-org FLEET reads (workflow catalogue + its public spend / outcomes). Empty on purpose:
    // an offer's own figures are realized money, never a fleet benchmark, so a fleet with nothing in
    // it must not change a single number asserted below.
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});

    if (path.includes("/stats/costs")) {
      const groupBy = q.get("groupBy") ?? "";
      const only = q.get("campaignId");
      const wantsAudience = groupBy.includes("audienceId");
      const groups = Object.entries(fixture.costByCampaign)
        .filter(([cid]) => !only || cid === only)
        .map(([cid, cents]) => ({
          dimensions: {
            campaignId: cid,
            workflowSlug: "dawn-v1",
            ...(wantsAudience ? { audienceId: "aud-1" } : {}),
          },
          totalCostInUsdCents: String(cents),
          actualCostInUsdCents: String(cents),
          runCount: 1,
          minStartedAt: null,
          maxStartedAt: null,
        }));
      return json({ groups });
    }

    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (path.endsWith("/orgs/leads")) {
      const only = q.get("campaignId");
      return json({ leads: only ? fixture.leads.filter((l) => l.campaignId === only) : fixture.leads });
    }
    if (path.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: fixture.audiences ?? [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 1000 });

    if (path.endsWith("/orgs/stats")) {
      const only = q.get("campaignId");
      if (q.get("groupBy") === "audienceId") {
        const per = fixture.engagementByCampaign ?? {};
        const scoped = only ? { [only]: per[only] ?? {} } : per;
        const totals = new Map<string, { contacted: number; clicked: number; repliesPositive: number }>();
        for (const byAudience of Object.values(scoped)) {
          for (const [audienceId, stats] of Object.entries(byAudience ?? {})) {
            const prev = totals.get(audienceId) ?? { contacted: 0, clicked: 0, repliesPositive: 0 };
            totals.set(audienceId, {
              contacted: prev.contacted + stats.contacted,
              clicked: prev.clicked + stats.clicked,
              repliesPositive: prev.repliesPositive + stats.repliesPositive,
            });
          }
        }
        return json({
          groups: [...totals].map(([key, s]) => ({
            key,
            broadcast: { recipientStats: { contacted: s.contacted, opened: 0, clicked: s.clicked, repliesPositive: s.repliesPositive } },
          })),
        });
      }
      if (q.get("groupBy") === "day") {
        const per = fixture.daysByCampaign ?? {};
        const scoped = only ? { [only]: per[only] ?? {} } : per;
        const totals = new Map<string, { contacted: number; opened: number; clicked: number }>();
        for (const byDay of Object.values(scoped)) {
          for (const [day, s] of Object.entries(byDay ?? {})) {
            const prev = totals.get(day) ?? { contacted: 0, opened: 0, clicked: 0 };
            totals.set(day, { contacted: prev.contacted + s.contacted, opened: prev.opened + s.opened, clicked: prev.clicked + s.clicked });
          }
        }
        return json({ groups: [...totals].map(([key, s]) => ({ key, broadcast: { recipientStats: s } })) });
      }
      return json({ groups: [] });
    }
    return json({});
  });
}

const byOffer = (body: { groups: Array<{ offerId: string }> }): Record<string, any> =>
  Object.fromEntries(body.groups.map((g) => [g.offerId, g]));

describe("GET /revenue?groupBy=offerId — what each of a brand's offers returns", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers ONE lean group per offer, each carrying the same money figures as the sibling grains", async () => {
    mockFetch({
      // Offer A is sold through two campaigns; offer B through one that reached nobody.
      campaigns: { c1: "offer-a", c2: "offer-a", c3: "offer-b" },
      costByCampaign: { c1: 3000, c2: 2000, c3: 4000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=offerId")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["featureSlug", "groupBy", "groups"]);
    expect(res.body.groupBy).toBe("offerId");

    const groups = byOffer(res.body);
    expect(Object.keys(groups).sort()).toEqual(["offer-a", "offer-b"]);
    // Lean, exactly like the per-campaign grain: the identifier, its members, and the money.
    for (const g of res.body.groups) {
      expect(Object.keys(g).sort()).toEqual(["campaignIds", "costEconomics", "headline", "offerId"]);
    }

    // Offer A: two replying leads at 120 each, $30 + $20 of spend across its two campaigns.
    expect(groups["offer-a"].campaignIds).toEqual(["c1", "c2"]);
    expect(groups["offer-a"].headline.totalPipelineUsd).toBeCloseTo(240, 6);
    expect(groups["offer-a"].headline.economicsSource).toBe("sales-economics");
    expect(groups["offer-a"].costEconomics.actualCostUsd).toBeCloseTo(50, 6);
    expect(groups["offer-a"].costEconomics.roiMultiple).toBeCloseTo(4.8, 6);
    expect(groups["offer-a"].costEconomics.costOfAcquisitionPct).toBeCloseTo((50 / 240) * 100, 6);

    // Offer B BURNED it: real spend, nothing back. 0x, not null — the offer the Overview ranks last.
    expect(groups["offer-b"].campaignIds).toEqual(["c3"]);
    expect(groups["offer-b"].costEconomics.actualCostUsd).toBeCloseTo(40, 6);
    expect(groups["offer-b"].headline.totalPipelineUsd).toBe(0);
    expect(groups["offer-b"].costEconomics.roiMultiple).toBe(0);
  });

  it("a brand selling ONE offer reads the SAME figures at the offer grain as at the brand grain", async () => {
    const fixture: Fixture = {
      campaigns: { c1: "offer-a", c2: "offer-a" },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [replyLead("c1", "l1"), silentLead("c2", "l2")],
    };

    mockFetch(fixture);
    const brand = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);

    mockFetch(fixture);
    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=offerId")
      .set(AUTH);
    expect(grouped.status).toBe(200);
    expect(grouped.body.groups).toHaveLength(1);

    // Same request, same engine, same economics — so this is a construction, not a reconciliation.
    expect(grouped.body.groups[0].headline).toEqual(brand.body.headline);
    expect(grouped.body.groups[0].costEconomics).toEqual(brand.body.costEconomics);
  });

  it("a group is byte-equal to the standalone ?offerId= call", async () => {
    const fixture: Fixture = {
      campaigns: { c1: "offer-a", c2: "offer-b" },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
    };

    mockFetch(fixture);
    const scoped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&offerId=offer-a")
      .set(AUTH);
    expect(scoped.status).toBe(200);
    expect(scoped.body.headline.totalPipelineUsd).toBeCloseTo(120, 6);

    mockFetch(fixture);
    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=offerId")
      .set(AUTH);
    const g = byOffer(grouped.body)["offer-a"];
    expect(g.headline).toEqual(scoped.body.headline);
    expect(g.costEconomics).toEqual(scoped.body.costEconomics);
  });

  it("a campaign stating NO offer is in no group — its spend and its leads with it", async () => {
    mockFetch({
      campaigns: { c1: "offer-a", c2: null },
      costByCampaign: { c1: 3000, c2: 9999 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=offerId")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    // The unattributed campaign is nowhere: the groups do not sum to the brand, and parking it on the
    // one offer that exists would invent an attribution nobody recorded.
    expect(byOffer(res.body)["offer-a"].costEconomics.actualCostUsd).toBeCloseTo(30, 6);
    expect(byOffer(res.body)["offer-a"].headline.totalPipelineUsd).toBeCloseTo(120, 6);
  });

  it("a brand whose campaigns state no offer yet serves an empty groups[], never the brand's own money", async () => {
    mockFetch({ campaigns: { c1: null }, costByCampaign: { c1: 3000 }, leads: [replyLead("c1", "l1")] });
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=offerId")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });
});

describe("?offerId= — every per-offer read describes that offer alone", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => vi.restoreAllMocks());

  const TWO_OFFERS: Fixture = {
    campaigns: { c1: "offer-a", c2: "offer-a", c3: "offer-b" },
    costByCampaign: { c1: 3000, c2: 2000, c3: 4000 },
    leads: [replyLead("c1", "l1"), replyLead("c2", "l2"), replyLead("c3", "l3")],
  };

  it("/revenue narrows to the offer's campaigns, and without one answers for the whole brand", async () => {
    mockFetch(TWO_OFFERS);
    const scoped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&offerId=offer-a")
      .set(AUTH);
    expect(scoped.status).toBe(200);
    expect(scoped.body.headline.totalPipelineUsd).toBeCloseTo(240, 6);
    expect(scoped.body.costEconomics.actualCostUsd).toBeCloseTo(50, 6);

    mockFetch(TWO_OFFERS);
    const brand = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);
    // The brand's headline stays the sum across its offers — the offer grain narrows, never replaces.
    expect(brand.body.headline.totalPipelineUsd).toBeCloseTo(360, 6);
    expect(brand.body.costEconomics.actualCostUsd).toBeCloseTo(90, 6);
  });

  it("/stats narrows its cost to the offer's campaigns, and without one is unchanged", async () => {
    mockFetch(TWO_OFFERS);
    const scoped = await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=b1&offerId=offer-a")
      .set(AUTH);
    expect(scoped.status).toBe(200);
    expect(scoped.body.systemStats.totalCostInUsdCents).toBe(5000);

    mockFetch(TWO_OFFERS);
    const brand = await request(app).get("/features/sales-cold-email-outreach/stats?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.systemStats.totalCostInUsdCents).toBe(9000);
  });

  it("/audience-stats narrows each audience's spend and engagement to the offer's campaigns", async () => {
    const fixture: Fixture = {
      ...TWO_OFFERS,
      audiences: [{ id: "aud-1", name: "Aud 1", status: "active", brandId: "b1" }],
      engagementByCampaign: {
        c1: { "aud-1": { contacted: 10, clicked: 2, repliesPositive: 1 } },
        c2: { "aud-1": { contacted: 20, clicked: 3, repliesPositive: 2 } },
        c3: { "aud-1": { contacted: 70, clicked: 9, repliesPositive: 9 } },
      },
    };

    mockFetch(fixture);
    const scoped = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=b1&goal=meetingBooked&offerId=offer-a")
      .set(AUTH);
    expect(scoped.status).toBe(200);
    const scopedRow = scoped.body.audiences[0];
    // Offer A's two campaigns only: 10 + 20 contacted, 1 + 2 positive replies, $30 + $20 of spend.
    expect(scopedRow.evidence.contacted).toBe(30);
    expect(scopedRow.evidence.positiveReplies).toBe(3);
    expect(scopedRow.evidence.totalCostInUsdCents).toBe(5000);

    mockFetch(fixture);
    const brand = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=b1&goal=meetingBooked")
      .set(AUTH);
    expect(brand.status).toBe(200);
    const brandRow = brand.body.audiences[0];
    expect(brandRow.evidence.contacted).toBe(100);
    expect(brandRow.evidence.positiveReplies).toBe(12);
    expect(brandRow.evidence.totalCostInUsdCents).toBe(9000);
  });

  it("/pipeline-activity narrows the actual day series, and states nothing it cannot measure per offer", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fixture: Fixture = {
      ...TWO_OFFERS,
      daysByCampaign: {
        c1: { [today]: { contacted: 5, opened: 2, clicked: 1 } },
        c2: { [today]: { contacted: 7, opened: 3, clicked: 2 } },
        c3: { [today]: { contacted: 90, opened: 40, clicked: 20 } },
      },
    };

    mockFetch(fixture);
    const scoped = await request(app)
      .get(`/features/sales-cold-email-outreach/pipeline-activity?brandId=b1&timezone=UTC&days=1&offerId=offer-a`)
      .set(AUTH);
    expect(scoped.status).toBe(200);
    const day = scoped.body.days[0];
    expect(day.metrics.outreach.actual).toBe(12); // 5 + 7, offer A's two campaigns merged
    // The forecast is what a daily BUDGET buys and a budget is not funded per offer, so it is null
    // here rather than the brand's own bars drawn beside offer-only ones.
    expect(day.metrics.outreach.expected).toBeNull();
    expect(scoped.body.summary.dailyBudgetUsd).toBeNull();

    mockFetch(fixture);
    const brand = await request(app)
      .get(`/features/sales-cold-email-outreach/pipeline-activity?brandId=b1&timezone=UTC&days=1`)
      .set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.days[0].metrics.outreach.actual).toBe(102);
  });

  it("404s an offer no campaign of this brand sells, naming the reason", async () => {
    mockFetch(TWO_OFFERS);
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&offerId=offer-zzz")
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_campaigns");
    expect(res.body.offerId).toBe("offer-zzz");
  });

  it("400s offerId beside campaignId — a campaign already sells exactly one offer", async () => {
    mockFetch(TWO_OFFERS);
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&offerId=offer-a&campaignId=c1")
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});
