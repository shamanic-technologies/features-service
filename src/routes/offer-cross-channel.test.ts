/**
 * WHAT AN OFFER RETURNED ACROSS EVERY CHANNEL IT IS SOLD THROUGH.
 *
 * Driven from ONE downstream fixture, so the offer's answer and each channel's own answer are two views
 * of the same evidence rather than two computations to reconcile. What they pin:
 *
 *   - the offer accounts for EVERY channel, not just the one a path happens to name;
 *   - MONEY adds across channels and PEOPLE do not — a lead worked through two channels is one lead to
 *     the offer, so the offer's contacted count is BELOW the sum of its channels';
 *   - the per-channel breakdown ships in the SAME response and is byte-equal to that channel's own read,
 *     so a row and the total above it are one statement at two grains;
 *   - a ONE-CHANNEL offer answers identically to that channel's own read, so every brand on one channel
 *     today sees nothing change;
 *   - the existing per-feature reads still mean exactly what they meant.
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

interface CampaignRow {
  offerId: string | null;
  featureSlug: string;
}

interface Fixture {
  /** campaign-service's rows: campaign id → the offer it sells and the channel it runs through. */
  campaigns: Record<string, CampaignRow>;
  /** runs-service spend in cents per campaign id. */
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** email-gateway per-audience send-tag engagement, per campaign id. */
  engagementByCampaign?: Record<string, Record<string, { contacted: number; clicked: number; repliesPositive: number }>>;
  /** email-gateway day series, per campaign id. */
  daysByCampaign?: Record<string, Record<string, { contacted: number; opened: number; clicked: number }>>;
  audiences?: Array<Record<string, unknown>>;
}

/**
 * Every downstream, honouring BOTH filters a cross-channel read depends on: `featureSlugs` (comma-split,
 * as runs-service does) and `campaignId`. A mock that ignored the channel filter could not tell a
 * combined answer from a brand-wide one.
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
            brandId: "b1",
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
    // The cross-org FLEET reads. Empty on purpose: an offer's own figures are realized money, never a
    // fleet benchmark, so a fleet with nothing in it must not move a single number asserted below.
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
    if (path.includes("/audiences")) return json({ audiences: fixture.audiences ?? [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 1000 });

    if (path.endsWith("/orgs/stats")) {
      if (q.get("groupBy") === "audienceId") {
        const per = fixture.engagementByCampaign ?? {};
        const totals = new Map<string, { contacted: number; clicked: number; repliesPositive: number }>();
        for (const [cid, byAudience] of Object.entries(per)) {
          if (!inScope(cid, q)) continue;
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
        const totals = new Map<string, { contacted: number; opened: number; clicked: number }>();
        for (const [cid, byDay] of Object.entries(per)) {
          if (!inScope(cid, q)) continue;
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

/** The live shape: one offer, two cold-email channels, one lead each. */
const TWO_CHANNELS: Fixture = {
  campaigns: {
    c1: { offerId: OFFER, featureSlug: PITCH },
    c2: { offerId: OFFER, featureSlug: FEEDBACK },
    c9: { offerId: "offer-b", featureSlug: PITCH },
  },
  costByCampaign: { c1: 3000, c2: 2000, c9: 7000 },
  leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
};

describe("GET /offers/:offerId/revenue — an offer's money, across every channel it sells through", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation(
      (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("accounts for BOTH channels, and carries each one's own answer beside the total", async () => {
    mockFetch(TWO_CHANNELS);
    const res = await request(app).get(`/offers/${OFFER}/revenue?brandId=b1`).set(AUTH);
    expect(res.status).toBe(200);

    // MONEY ADDS: a cost row belongs to exactly one channel, so $30 + $20 is the offer's spend.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(50, 6);
    // Two replying leads at 120 each — ONE engine pass over both channels' evidence.
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(240, 6);
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(4.8, 6);

    // The breakdown, in the SAME response — the caller never asks N times.
    expect(res.body.channels.map((c: { featureSlug: string }) => c.featureSlug)).toEqual([FEEDBACK, PITCH]);
    const byChannel = Object.fromEntries(res.body.channels.map((c: { featureSlug: string }) => [c.featureSlug, c]));
    expect(byChannel[PITCH].campaignIds).toEqual(["c1"]);
    expect(byChannel[FEEDBACK].campaignIds).toEqual(["c2"]);
    expect(byChannel[PITCH].costEconomics.committedCostUsd).toBeCloseTo(30, 6);
    expect(byChannel[FEEDBACK].costEconomics.committedCostUsd).toBeCloseTo(20, 6);
    // The offer's other offer never enters: c9 spent $70 and is nowhere in the answer.
    expect(res.body.costEconomics.committedCostUsd).toBeLessThan(70);
  });

  // Not byte-equality in PROD, and the assertion says only what the fixture can prove: a channel row
  // reads its spend grouped by workflow while the standalone read groups by cost name, and runs-service
  // returns fractional cents per group, so each rounds once per its own grouping. Same ledger, same
  // scope, same engine — sub-cent apart on real data (see CLAUDE.md).
  it("a channel row reports what that channel's own per-feature read of the same offer reports", async () => {
    mockFetch(TWO_CHANNELS);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=b1`).set(AUTH);
    expect(offer.status).toBe(200);

    mockFetch(TWO_CHANNELS);
    const perFeature = await request(app)
      .get(`/features/${FEEDBACK}/revenue?brandId=b1&offerId=${OFFER}`)
      .set(AUTH);
    expect(perFeature.status).toBe(200);

    const row = offer.body.channels.find((c: { featureSlug: string }) => c.featureSlug === FEEDBACK);
    expect(row.headline).toEqual(perFeature.body.headline);
    expect(row.costEconomics).toEqual(perFeature.body.costEconomics);
  });

  it("PEOPLE are not added: a lead worked through both channels is ONE lead to the offer", async () => {
    // The same person (`leadId: l1`) served under both channels — the case that makes summing wrong.
    const shared: Fixture = {
      campaigns: { c1: { offerId: OFFER, featureSlug: PITCH }, c2: { offerId: OFFER, featureSlug: FEEDBACK } },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l1")],
    };
    mockFetch(shared);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=b1`).set(AUTH);
    expect(offer.status).toBe(200);

    // ONE person, so ONE reply priced — not two. Summing the channels would have said 240.
    expect(offer.body.headline.totalPipelineUsd).toBeCloseTo(120, 6);
    expect(offer.body.recipientsContacted.total).toBe(1);
    const summed = offer.body.channels.reduce(
      (sum: number, c: { headline: { totalPipelineUsd: number } }) => sum + c.headline.totalPipelineUsd,
      0,
    );
    expect(summed).toBeCloseTo(240, 6);
    expect(offer.body.headline.totalPipelineUsd).toBeLessThan(summed);
    // MONEY still adds, in the same breath — the two halves combine differently and both are right.
    expect(offer.body.costEconomics.committedCostUsd).toBeCloseTo(50, 6);
  });

  it("an offer sold through ONE channel answers identically to that channel's own read", async () => {
    const single: Fixture = {
      campaigns: { c1: { offerId: OFFER, featureSlug: PITCH }, c2: { offerId: OFFER, featureSlug: PITCH } },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [replyLead("c1", "l1"), replyLead("c2", "l2")],
    };

    mockFetch(single);
    const perFeature = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=b1&offerId=${OFFER}`)
      .set(AUTH);
    expect(perFeature.status).toBe(200);

    mockFetch(single);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=b1`).set(AUTH);
    expect(offer.status).toBe(200);

    expect(offer.body.headline).toEqual(perFeature.body.headline);
    expect(offer.body.costEconomics).toEqual(perFeature.body.costEconomics);
    expect(offer.body.spend).toEqual(perFeature.body.spend);
    expect(offer.body.recipientsContacted).toEqual(perFeature.body.recipientsContacted);
  });

  it("the existing per-feature read still describes ONE channel, unchanged", async () => {
    mockFetch(TWO_CHANNELS);
    const perFeature = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=b1&offerId=${OFFER}`)
      .set(AUTH);
    expect(perFeature.status).toBe(200);
    // The pitch channel alone: its $30, its one lead. It must NOT have grown to the offer's figures.
    expect(perFeature.body.costEconomics.committedCostUsd).toBeCloseTo(30, 6);
    expect(perFeature.body.headline.totalPipelineUsd).toBeCloseTo(120, 6);
    expect(perFeature.body.channels).toBeUndefined();
  });

  it("an offer no campaign sells is a named 404, never the brand's numbers under its label", async () => {
    mockFetch(TWO_CHANNELS);
    const res = await request(app).get("/offers/offer-nobody-sells/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_channels");
  });

  it("requires a brand", async () => {
    mockFetch(TWO_CHANNELS);
    const res = await request(app).get(`/offers/${OFFER}/revenue`).set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe("GET /offers/:offerId/audience-stats — per-audience economics across channels", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation(
      (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const AUDIENCES = [{ id: "aud-1", name: "A", status: "active", filters: {} }];

  it("counts each audience's spend and engagement across BOTH channels", async () => {
    const fixture: Fixture = {
      ...TWO_CHANNELS,
      audiences: AUDIENCES,
      engagementByCampaign: {
        c1: { "aud-1": { contacted: 10, clicked: 2, repliesPositive: 1 } },
        c2: { "aud-1": { contacted: 20, clicked: 4, repliesPositive: 2 } },
        c9: { "aud-1": { contacted: 999, clicked: 999, repliesPositive: 999 } },
      },
    };
    mockFetch(fixture);
    const res = await request(app).get(`/offers/${OFFER}/audience-stats?brandId=b1&goal=positiveReply`).set(AUTH);
    expect(res.status).toBe(200);

    const row = res.body.audiences[0];
    // A send carries one campaign and one channel, so the two channels ADD — and the other offer's
    // campaign (c9) is nowhere near the answer.
    expect(row.evidence.contacted).toBe(30);
    expect(row.evidence.positiveReplies).toBe(3);
    // The ratio is recomputed from the combined numerators, never averaged: $50 over 3 replies.
    expect(row.metrics.cpprCents).toBeCloseTo(5000 / 3, 4);
    expect(res.body.channels.map((c: { featureSlug: string }) => c.featureSlug)).toEqual([FEEDBACK, PITCH]);
  });

  it("a ONE-channel offer reads what that channel's own offer-scoped read reads", async () => {
    const single: Fixture = {
      campaigns: { c1: { offerId: OFFER, featureSlug: PITCH }, c2: { offerId: OFFER, featureSlug: PITCH } },
      costByCampaign: { c1: 3000, c2: 2000 },
      leads: [],
      audiences: AUDIENCES,
      engagementByCampaign: {
        c1: { "aud-1": { contacted: 10, clicked: 2, repliesPositive: 1 } },
        c2: { "aud-1": { contacted: 20, clicked: 4, repliesPositive: 2 } },
      },
    };

    mockFetch(single);
    const perFeature = await request(app)
      .get(`/features/${PITCH}/audience-stats?brandId=b1&goal=positiveReply&offerId=${OFFER}`)
      .set(AUTH);
    expect(perFeature.status).toBe(200);

    mockFetch(single);
    const offer = await request(app).get(`/offers/${OFFER}/audience-stats?brandId=b1&goal=positiveReply`).set(AUTH);
    expect(offer.status).toBe(200);

    expect(offer.body.audiences).toEqual(perFeature.body.audiences);
  });
});

describe("GET /offers/:offerId/pipeline-activity — per-day activity across channels", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation(
      (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("merges the day buckets of every channel, and states nothing it cannot measure at this grain", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockFetch({
      ...TWO_CHANNELS,
      daysByCampaign: {
        c1: { [today]: { contacted: 5, opened: 3, clicked: 1 } },
        c2: { [today]: { contacted: 7, opened: 2, clicked: 4 } },
        c9: { [today]: { contacted: 999, opened: 999, clicked: 999 } },
      },
    });
    const res = await request(app)
      .get(`/offers/${OFFER}/pipeline-activity?brandId=b1&timezone=UTC&days=1`)
      .set(AUTH);
    expect(res.status).toBe(200);

    const day = res.body.days[0];
    // Events tagged to one campaign, so the channels add exactly — 5 + 7, 3 + 2, 1 + 4.
    expect(day.metrics.outreach.actual).toBe(12);
    expect(day.metrics.opens.actual).toBe(5);
    expect(day.metrics.clicks.actual).toBe(5);
    // A budget is funded per brand with no per-offer ceiling, so the forecast says "we could not
    // measure this" rather than drawing a brand-wide bar beside offer-only ones.
    expect(day.metrics.outreach.expected).toBeNull();
    expect(res.body.summary.dailyBudgetUsd).toBeNull();
    expect(res.body.channels.map((c: { featureSlug: string }) => c.featureSlug)).toEqual([FEEDBACK, PITCH]);
  });

  it("asks brand-service for THIS OFFER's declared chains, not the brand's only one", async () => {
    // A declared funnel carries its offer's OWN lifetime revenue and rates, so an offer read that did
    // not say which offer it meant would price a $200 self-serve plan on a $20k contract's numbers —
    // and would simply 409 for any brand selling more than one thing (brand-service#473).
    mockFetch(TWO_CHANNELS);
    const res = await request(app).get(`/offers/${OFFER}/revenue?brandId=b1`).set(AUTH);
    expect(res.status).toBe(200);

    const seen = vi.mocked(globalThis.fetch).mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url,
    );
    const funnelReads = seen.filter((u: string) => u.includes("/sales-funnels"));
    expect(funnelReads.length).toBeGreaterThan(0);
    for (const url of funnelReads) expect(url).toContain(`offerId=${OFFER}`);
  });
});
