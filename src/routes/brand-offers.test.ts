/**
 * EVERY OFFER OF A BRAND, EACH AT THE OFFER GRAIN.
 *
 * Driven from ONE downstream fixture, so a row of the table and the offer's own standalone answer are
 * two views of the same evidence rather than two computations to reconcile. What they pin:
 *
 *   - a row spans EVERY channel the offer is sold through, not the one a per-feature path happens to
 *     name — the contradiction the brand Overview printed;
 *   - a row is byte-equal to that offer's own `/offers/:offerId/revenue` headline + costEconomics;
 *   - MONEY adds across an offer's channels and PEOPLE do not;
 *   - a brand with ONE offer reads the brand's own figures, so nothing moves for it;
 *   - an offer sold through ONE channel reads that channel's own per-offer group, unchanged;
 *   - "no campaign at all" (404) and "campaigns that state no offer" (`offers: []`) stay different
 *     answers;
 *   - the row is LEAN — no leads, no spend block, no series — because a table polls it.
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
const BRAND = "b1";
const OFFER_A = "offer-a";
const OFFER_B = "offer-b";

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

interface Fixture {
  /** campaign-service's rows: campaign id → the channel it runs through and the offer it sells. */
  campaigns: Record<string, { featureSlug: string; offerId: string | null }>;
  /** runs-service spend in cents per campaign id. */
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
}

/**
 * Every downstream, honouring BOTH filters a cross-channel read depends on: `featureSlugs` (comma-split,
 * as runs-service does) and `campaignId`. A mock that ignored either could not tell an offer's combined
 * answer from one channel's, which is the whole thing under test.
 */
function mockFetch(fixture: Fixture): void {
  const inScope = (cid: string, q: URLSearchParams): boolean => {
    const row = fixture.campaigns[cid];
    if (!row) return false;
    const only = q.get("campaignId");
    if (only && only !== cid) return false;
    const slugs = (q.get("featureSlugs") ?? "").split(",").filter(Boolean);
    if (slugs.length > 0 && !slugs.includes(row.featureSlug)) return false;
    return true;
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      const narrowed = q.get("featureSlug");
      return json({
        campaigns: Object.entries(fixture.campaigns)
          .filter(([, row]) => !narrowed || row.featureSlug === narrowed)
          .map(([id, row]) => ({
            id,
            orgId: "org-1",
            brandId: BRAND,
            featureSlug: row.featureSlug,
            funnelKey: "sales_meetings_from_conversation",
            acquisitionChannel: row.featureSlug,
            offerId: row.offerId,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
      });
    }
    if (path.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    // The cross-org FLEET reads. Empty on purpose: an offer's figures are realized money, never a fleet
    // benchmark, so a fleet with nothing in it must not move a single number asserted below.
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});

    if (path.includes("/stats/costs")) {
      const groupBy = q.get("groupBy") ?? "";
      const wantsAudience = groupBy.includes("audienceId");
      const groups = Object.keys(fixture.costByCampaign)
        .filter((cid) => inScope(cid, q))
        .map((cid) => ({
          dimensions: {
            campaignId: cid,
            workflowSlug: "dawn-v1",
            ...(wantsAudience ? { audienceId: "aud-1" } : {}),
          },
          totalCostInUsdCents: String(fixture.costByCampaign[cid]),
          actualCostInUsdCents: String(fixture.costByCampaign[cid]),
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
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 5000 });
    if (path.endsWith("/orgs/stats")) return json({ groups: [] });
    return json({});
  });
}

/** The live shape: one brand, one offer, sold through two cold-email channels, one lead each. */
const ONE_OFFER_TWO_CHANNELS: Fixture = {
  campaigns: { c1: { featureSlug: PITCH, offerId: OFFER_A }, c2: { featureSlug: FEEDBACK, offerId: OFFER_A } },
  costByCampaign: { c1: 4007, c2: 1032 },
  leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
};

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation(
    (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
  );
};

describe("GET /brands/:brandId/offers — every offer, each combined across its channels", () => {
  beforeEach(withFeatures);
  afterEach(() => vi.restoreAllMocks());

  it("a row spans EVERY channel the offer sells through, not the one a per-feature read names", async () => {
    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const res = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.offers).toHaveLength(1);
    const row = res.body.offers[0];
    expect(row.offerId).toBe(OFFER_A);
    // MONEY ADDS across the offer's channels: $40.07 + $10.32. Read through the pitch channel alone —
    // which is what the table printed — it was $40.07.
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
    // ONE engine pass over both channels' evidence: two replying leads at 120.
    expect(row.headline.totalPipelineUsd).toBeCloseTo(240, 6);
    // The row states what it is made of, so a reader never needs a second call.
    expect(row.channels.map((c: { featureSlug: string }) => c.featureSlug)).toEqual([FEEDBACK, PITCH]);
    expect(row.channels.find((c: { featureSlug: string }) => c.featureSlug === PITCH).campaignIds).toEqual(["c1"]);

    // And what the single-channel read still says, unchanged — the contradiction the customer saw.
    const perChannel = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&groupBy=offerId`)
      .set(AUTH);
    expect(perChannel.status).toBe(200);
    expect(perChannel.body.groups[0].costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
  });

  it("a row is byte-equal to that offer's own /offers/:offerId/revenue answer", async () => {
    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const table = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(table.status).toBe(200);

    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const standalone = await request(app).get(`/offers/${OFFER_A}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(standalone.status).toBe(200);

    expect(table.body.offers[0].headline).toEqual(standalone.body.headline);
    expect(table.body.offers[0].costEconomics).toEqual(standalone.body.costEconomics);
  });

  it("a brand selling ONE offer through all its campaigns reads the brand's own answer", async () => {
    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const table = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(table.status).toBe(200);

    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const brand = await request(app).get(`/brands/${BRAND}/revenue`).set(AUTH);
    expect(brand.status).toBe(200);

    // The row under the cards and the cards themselves are one statement — the AC this exists for.
    expect(table.body.offers[0].headline).toEqual(brand.body.headline);
    expect(table.body.offers[0].costEconomics).toEqual(brand.body.costEconomics);
  });

  it("an offer sold through ONE channel answers what that channel's own per-offer group answers", async () => {
    const single: Fixture = {
      campaigns: { c1: { featureSlug: PITCH, offerId: OFFER_A }, c2: { featureSlug: PITCH, offerId: OFFER_B } },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
    };

    mockFetch(single);
    const perChannel = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&groupBy=offerId`)
      .set(AUTH);
    expect(perChannel.status).toBe(200);

    mockFetch(single);
    const table = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(table.status).toBe(200);

    const byOffer = Object.fromEntries(table.body.offers.map((o: { offerId: string }) => [o.offerId, o]));
    for (const group of perChannel.body.groups as Array<{ offerId: string; headline: unknown; costEconomics: unknown }>) {
      expect(byOffer[group.offerId].headline).toEqual(group.headline);
      expect(byOffer[group.offerId].costEconomics).toEqual(group.costEconomics);
    }
  });

  it("MONEY adds across an offer's channels while PEOPLE do not", async () => {
    mockFetch({
      campaigns: { c1: { featureSlug: PITCH, offerId: OFFER_A }, c2: { featureSlug: FEEDBACK, offerId: OFFER_A } },
      costByCampaign: { c1: 4007, c2: 1032 },
      // The SAME person worked through both channels.
      leads: [replyLead("c1", "l1"), replyLead("c2", "l1")],
    });
    const res = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(res.status).toBe(200);

    const row = res.body.offers[0];
    // One person, so ONE reply priced — summing the two channels would have said 240.
    expect(row.headline.totalPipelineUsd).toBeCloseTo(120, 6);
    // Money still adds in the same breath: the two halves combine differently and both are right.
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
  });

  it("each offer is its own row, and the rows do not sum to the brand", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, offerId: OFFER_A },
        c2: { featureSlug: FEEDBACK, offerId: OFFER_B },
        // Stating no offer: in NO row, with its spend and its lead — never parked on a default one.
        c3: { featureSlug: PITCH, offerId: null },
      },
      costByCampaign: { c1: 1000, c2: 2000, c3: 4000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2"), replyLead("c3", "l3")],
    });
    const res = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.offers.map((o: { offerId: string }) => o.offerId)).toEqual([OFFER_A, OFFER_B]);
    const byOffer = Object.fromEntries(res.body.offers.map((o: { offerId: string }) => [o.offerId, o]));
    expect(byOffer[OFFER_A].costEconomics.committedCostUsd).toBeCloseTo(10, 6);
    expect(byOffer[OFFER_B].costEconomics.committedCostUsd).toBeCloseTo(20, 6);
    // The unattributed campaign's $40 is in no row — and still in the brand's own total, which narrows
    // by nothing. That is why the brand read stays the number to trust for "what did this brand do".
    const summed = res.body.offers.reduce(
      (sum: number, o: { costEconomics: { committedCostUsd: number } }) => sum + o.costEconomics.committedCostUsd,
      0,
    );
    expect(summed).toBeCloseTo(30, 6);
  });

  it("is LEAN — the four numbers a table renders, not the lead population it would have to download", async () => {
    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const res = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(res.status).toBe(200);

    const row = res.body.offers[0];
    expect(Object.keys(row).sort()).toEqual(["channels", "costEconomics", "headline", "offerId"]);
    expect(row.leads).toBeUndefined();
    expect(row.spend).toBeUndefined();
    expect(row.timeSeries).toBeUndefined();
    // The four figures the row exists to carry.
    expect(row.headline.totalPipelineUsd).not.toBeNull();
    expect(row.costEconomics.roiMultiple).not.toBeNull();
    expect(row.costEconomics.costOfAcquisitionPct).not.toBeNull();
    expect(row.costEconomics.committedCostUsd).toBeGreaterThan(0);
  });

  it("campaigns that state no offer are an EMPTY list, and no campaign at all is a named 404", async () => {
    mockFetch({
      campaigns: { c1: { featureSlug: PITCH, offerId: null } },
      costByCampaign: { c1: 1000 },
      leads: [],
    });
    const transitional = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(transitional.status).toBe(200);
    expect(transitional.body.offers).toEqual([]);

    vi.restoreAllMocks();
    withFeatures();
    mockFetch({ campaigns: {}, costByCampaign: {}, leads: [] });
    const none = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(none.status).toBe(404);
    expect(none.body.reason).toBe("brand_has_no_channels");
  });

  it("rejects an unrecognised pricing or funnel rather than answering on a guess", async () => {
    mockFetch(ONE_OFFER_TWO_CHANNELS);
    const badPricing = await request(app).get(`/brands/${BRAND}/offers?pricing=cheap`).set(AUTH);
    expect(badPricing.status).toBe(400);
    const badFunnel = await request(app).get(`/brands/${BRAND}/offers?funnel=nope`).set(AUTH);
    expect(badFunnel.status).toBe(400);
  });
});
