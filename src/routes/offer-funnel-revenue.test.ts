/**
 * WHAT EACH OF AN OFFER'S SALES FUNNELS COST AND RETURNED.
 *
 * Driven from ONE downstream fixture, so a funnel row and the answer the customer can already open for
 * the same campaigns are two views of one evidence set rather than two computations to reconcile.
 * What they pin:
 *
 *   - a read answers at the (offer x sales funnel) grain, one row per funnel the offer sells through;
 *   - a funnel served by a SINGLE campaign — every funnel in production today — is byte-equal to that
 *     campaign's own answer, so today's shape is correct by construction;
 *   - a funnel served by SEVERAL campaigns, one per step, is the same row over the larger campaign set:
 *     the money adds and the return is the funnel's, not the last step's;
 *   - MONEY adds across an offer's funnels (Sigma funnels + Sigma unattributed IS the offer's spend) while
 *     PEOPLE do not;
 *   - each funnel is priced on its OWN declared terms — its own rates, its own lifetime revenue;
 *   - a funnel we cannot price says which ingredient is missing and reports its real spend beside a
 *     null return, never a figure borrowed from another funnel;
 *   - a campaign that states no funnel is in NO row, and its id is stated;
 *   - the rows are LEAN — no leads, no spend block, no series — because a table polls them;
 *   - every existing grain answers exactly as it does now.
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
const OFFER = "offer-a";
const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE = "sales_meetings_from_website";

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`, slug, name: slug, description: "x", status: "active",
  outputs: [], charts: [], entities: [],
  createdAt: new Date(), updatedAt: new Date(),
});

/** The brand-wide record. Every rate on it is server-defaulted, which is why a funnel never borrows it. */
const ECONOMICS = {
  lifetimeRevenueUsd: 500,
  replyToMeetingPct: 10,
  visitToMeetingPct: 10,
  meetingToClosePct: 10,
  visitToSignupPct: 10,
  signupToPaidClientPct: 10,
  visitToClosePct: 1,
  replyToPaidClientPct: 1,
  visitToPaidClientPct: 1,
  visitToFormSubmissionPct: 10,
  formSubmissionToPaidClientPct: 10,
};

/**
 * The two funnels, each stating its OWN rates and its OWN lifetime revenue — a $1,000 conversation
 * contract beside a $4,000 website one, so a row priced on the wrong funnel's terms cannot pass.
 */
const DECLARED = [
  {
    funnelKey: CONVERSATION,
    name: "Sales Meeting from Conversation",
    steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
    rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 60 },
    lifetimeRevenueUsd: 1000,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    funnelKey: WEBSITE,
    name: "Sales Meeting from Website",
    steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
    rates: { visitToMeetingPct: 20, meetingBookedToAttendedPct: 50, meetingToClosePct: 60 },
    lifetimeRevenueUsd: 4000,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function lead(
  campaignId: string,
  leadId: string,
  signal: "reply" | "click",
): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    workflowSlug: "dawn-v1",
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: signal === "click",
    bounced: false,
    unsubscribed: false,
    replied: signal === "reply",
    replyClassification: signal === "reply" ? "positive" : null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

interface Fixture {
  /** campaign-service's rows: campaign id -> the channel it runs, the funnel it sells, the offer. */
  campaigns: Record<string, { featureSlug: string; funnelKey: string | null; offerId: string | null }>;
  /** runs-service spend in cents per campaign id. */
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** What brand-service says the brand declared. `null` = the read fails (a producer gap). */
  declared?: typeof DECLARED | null;
  /**
   * What lead-service says the CUSTOMER spent on the legs they worked themselves, per statement.
   * Omitted = a readable, empty set (nobody has stated one). `null` = the read fails.
   */
  stepCosts?: Array<{ campaignId: string | null; step: string; kind: "outcome" | "never"; costCents: number | null }> | null;
}

/**
 * Every downstream, honouring BOTH filters a cross-channel read depends on: `featureSlugs`
 * (comma-split, as runs-service does) and `campaignId`. A mock ignoring either could not tell one
 * funnel's answer from the offer's, which is the whole thing under test.
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
            funnelKey: row.funnelKey,
            acquisitionChannel: row.featureSlug,
            offerId: row.offerId,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
      });
    }
    if (path.includes("/sales-funnels")) {
      const declared = fixture.declared === undefined ? DECLARED : fixture.declared;
      if (declared === null) return new Response("not found", { status: 404 });
      return json({ funnels: declared });
    }
    // The cross-org FLEET reads. Empty on purpose: a funnel's figures are realized money, never a fleet
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
    if (path.includes("/converted-leads")) return json({ outcomes: [] });
    if (path.includes("/step-costs")) {
      const rows = fixture.stepCosts === undefined ? [] : fixture.stepCosts;
      if (rows === null) return new Response("boom", { status: 502 });
      return json({
        brandId: BRAND,
        totalCostCents: rows.reduce((n, r) => n + (r.costCents ?? 0), 0),
        statedCount: rows.filter((r) => r.costCents !== null).length,
        unstatedCount: rows.filter((r) => r.costCents === null).length,
        byStep: {},
        costs: rows.map((r) => ({
          leadId: null,
          leadCampaignId: null,
          campaignId: r.campaignId,
          email: null,
          step: r.step,
          kind: r.kind,
          costCents: r.costCents,
          statedByUserId: null,
          occurredAt: null,
        })),
      });
    }
    if (path.includes("/step-disqualifications")) return json({ disqualifications: [] });
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 5000 });
    if (path.endsWith("/orgs/stats")) return json({ groups: [] });
    return json({});
  });
}

/** TODAY's live shape: one offer, two funnels, ONE campaign each. */
const ONE_CAMPAIGN_PER_FUNNEL: Fixture = {
  campaigns: {
    c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
    c2: { featureSlug: FEEDBACK, funnelKey: WEBSITE, offerId: OFFER },
  },
  costByCampaign: { c1: 4007, c2: 1032 },
  leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "click")],
};

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation(
    (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
  );
};

type FunnelRow = {
  funnelKey: string;
  name: string;
  steps: string[];
  campaignIds: string[];
  channels: Array<{ featureSlug: string; campaignIds: string[] }>;
  priced: boolean;
  unpricedReason: string | null;
  headline: { totalPipelineUsd: number | null };
  costEconomics: { committedCostUsd: number; roiMultiple: number | null; costOfAcquisitionPct: number | null; costPerAcquisitionUsd: number | null };
  customerCost: { declaredCostUsd: number; statedCount: number; unstatedCount: number } | null;
  costCoverage: string;
  combinedCostEconomics: {
    platformCommittedCostUsd: number;
    customerDeclaredCostUsd: number;
    committedCostUsd: number;
    roiMultiple: number | null;
    costOfAcquisitionPct: number | null;
    costPerAcquisitionUsd: number | null;
  };
  outcomes: { recipientsContacted: number } | null;
};

const funnelsOf = (body: { funnels: FunnelRow[] }): Record<string, FunnelRow> =>
  Object.fromEntries(body.funnels.map((c) => [c.funnelKey, c]));

describe("GET /offers/:offerId/funnels — an offer's money, one row per sales funnel", () => {
  beforeEach(withFeatures);
  afterEach(() => vi.restoreAllMocks());

  it("answers at the (offer x sales funnel) grain, stating what each row is made of", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.offerId).toBe(OFFER);
    expect(res.body.brandId).toBe(BRAND);
    // The two markers a consumer needs to know which dollars these are.
    expect(res.body.costBasis).toBe("charged");
    expect(res.body.costCoverage).toBe("platform_spend_only");

    const by = funnelsOf(res.body);
    expect(Object.keys(by).sort()).toEqual([CONVERSATION, WEBSITE].sort());
    expect(by[CONVERSATION].campaignIds).toEqual(["c1"]);
    expect(by[CONVERSATION].channels).toEqual([{ featureSlug: PITCH, campaignIds: ["c1"] }]);
    expect(by[CONVERSATION].steps).toEqual(["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(by[WEBSITE].campaignIds).toEqual(["c2"]);

    // Its own money, not the offer's: $40.07 on the conversation funnel, $10.32 on the website one.
    expect(by[CONVERSATION].costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
    expect(by[WEBSITE].costEconomics.committedCostUsd).toBeCloseTo(10.32, 6);
    // And a return, which is the whole point of the grain.
    expect(by[CONVERSATION].costEconomics.roiMultiple).toBeGreaterThan(0);
    expect(by[CONVERSATION].costEconomics.costOfAcquisitionPct).toBeGreaterThan(0);
    expect(by[CONVERSATION].costEconomics.costPerAcquisitionUsd).toBeGreaterThan(0);
  });

  it("a funnel served by a SINGLE campaign is byte-equal to that campaign's own answer", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const funnels = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(funnels.status).toBe(200);

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const campaign = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&campaignId=c1`)
      .set(AUTH);
    expect(campaign.status).toBe(200);

    const row = funnelsOf(funnels.body)[CONVERSATION];
    // The AC this exists for: today every funnel is one campaign, so nothing about today's numbers moves.
    expect(row.headline).toEqual(campaign.body.headline);
    expect(row.costEconomics).toEqual(campaign.body.costEconomics);
  });

  it("a funnel served by ONE CAMPAIGN PER STEP is the same row over the larger campaign set", async () => {
    // The shape the product is moving to: three campaigns buying three links of ONE funnel. None of
    // them has a return of its own; the funnel does.
    const perStep: Fixture = {
      campaigns: {
        s1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        s2: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        s3: { featureSlug: FEEDBACK, funnelKey: CONVERSATION, offerId: OFFER },
      },
      costByCampaign: { s1: 1000, s2: 2000, s3: 3000 },
      leads: [lead("s1", "l1", "reply"), lead("s3", "l2", "reply")],
    };
    mockFetch(perStep);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    const row = funnelsOf(res.body)[CONVERSATION];
    expect(row.campaignIds).toEqual(["s1", "s2", "s3"]);
    // The funnel's money is every step's money: $10 + $20 + $30.
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(60, 6);
    // And its return is the funnel's, spanning the leads every step reached.
    expect(row.headline.totalPipelineUsd).toBeGreaterThan(0);
    expect(row.costEconomics.roiMultiple).toBeCloseTo((row.headline.totalPipelineUsd as number) / 60, 6);
    // Nothing has to be summed in the browser to get there.
    expect(res.body.funnels).toHaveLength(1);
  });

  it("MONEY adds across an offer's funnels and equals the offer's own spend; PEOPLE do not add", async () => {
    // The SAME person worked through both funnels.
    const shared: Fixture = {
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: FEEDBACK, funnelKey: WEBSITE, offerId: OFFER },
      },
      costByCampaign: { c1: 4007, c2: 1032 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l1", "click")],
    };
    mockFetch(shared);
    const funnels = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(funnels.status).toBe(200);

    mockFetch(shared);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(offer.status).toBe(200);

    const summed = (funnels.body.funnels as FunnelRow[]).reduce((n, c) => n + c.costEconomics.committedCostUsd, 0);
    expect(summed).toBeCloseTo(offer.body.costEconomics.committedCostUsd, 6);
    expect(summed).toBeCloseTo(50.39, 6);

    // ONE person to the offer, and in BOTH funnel rows: the rows deliberately do not sum on people.
    const by = funnelsOf(funnels.body);
    expect(by[CONVERSATION].outcomes?.recipientsContacted).toBe(1);
    expect(by[WEBSITE].outcomes?.recipientsContacted).toBe(1);
    expect(offer.body.outcomes.recipientsContacted).toBe(1);
  });

  it("each funnel is priced on its OWN declared terms, never on the other funnel's or the brand's", async () => {
    // Same evidence on both funnels — one lead each, same spend — so any difference in the money is
    // the funnel's own declaration and nothing else.
    const even: Fixture = {
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: WEBSITE, offerId: OFFER },
      },
      costByCampaign: { c1: 1000, c2: 1000 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "click")],
    };
    mockFetch(even);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    const by = funnelsOf(res.body);
    // A positive reply on the conversation funnel: $1,000 x 40% reply->booked x (50% x 60%) booked->paid.
    expect(by[CONVERSATION].headline.totalPipelineUsd).toBeCloseTo(120, 6);
    // A website visit on the website funnel: $4,000 x 20% visit->booked x 30% booked->paid, combined
    // with the brand-wide self-serve route the funnel does not restate (1% visit->close).
    // Priced on the brand's own $500 record instead, the same click would be worth a fraction of it.
    expect(by[WEBSITE].headline.totalPipelineUsd as number).toBeGreaterThan(240);
    // $CAC is the third unit of the same statement, and it is each funnel's own.
    expect(by[CONVERSATION].costEconomics.costPerAcquisitionUsd).toBeCloseTo(
      1000 / (by[CONVERSATION].costEconomics.roiMultiple as number),
      6,
    );
    expect(by[WEBSITE].costEconomics.costPerAcquisitionUsd).toBeCloseTo(
      4000 / (by[WEBSITE].costEconomics.roiMultiple as number),
      6,
    );
  });

  it("a funnel the brand never declared reports its real spend and a NULL return, naming the gap", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: "website_purchases", offerId: OFFER },
      },
      costByCampaign: { c1: 1000, c2: 2500 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "click")],
    });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    const row = funnelsOf(res.body)["website_purchases"];
    expect(row.priced).toBe(false);
    expect(row.unpricedReason).toBe("funnel_not_declared");
    // The customer paid it, so it is reported.
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(25, 6);
    // Nothing is borrowed from the funnel beside it: no pipeline, no return, no cost of acquisition.
    expect(row.headline.totalPipelineUsd).toBeNull();
    expect(row.costEconomics.roiMultiple).toBeNull();
    expect(row.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(row.costEconomics.costPerAcquisitionUsd).toBeNull();
    // "We could not price this" and "this reached nobody" are different statements: the volume is real.
    expect(row.outcomes?.recipientsContacted).toBe(1);
    // Its declared sibling is unaffected.
    expect(funnelsOf(res.body)[CONVERSATION].priced).toBe(true);
  });

  it("an unreadable declaration names THAT ingredient instead, and still never fabricates a return", async () => {
    mockFetch({ ...ONE_CAMPAIGN_PER_FUNNEL, declared: null });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    for (const row of res.body.funnels as FunnelRow[]) {
      expect(row.priced).toBe(false);
      expect(row.unpricedReason).toBe("no_economics_declared");
      expect(row.headline.totalPipelineUsd).toBeNull();
      expect(row.costEconomics.roiMultiple).toBeNull();
      expect(row.costEconomics.committedCostUsd).toBeGreaterThan(0);
    }
  });

  it("a campaign that states no funnel is in NO row, and its id is stated", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c9: { featureSlug: PITCH, funnelKey: null, offerId: OFFER },
      },
      costByCampaign: { c1: 1000, c9: 4000 },
      leads: [lead("c1", "l1", "reply"), lead("c9", "l9", "reply")],
    });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.funnels).toHaveLength(1);
    expect(res.body.funnels[0].campaignIds).toEqual(["c1"]);
    // Never parked on a default funnel, never dropped in silence — its $40 is in no row and still in
    // the offer's own total, which narrows by nothing.
    expect(res.body.unattributedCampaignIds).toEqual(["c9"]);
  });

  it("the rows are LEAN — no leads, no spend block, no series — because a table polls them", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);

    expect(Object.keys(res.body.funnels[0]).sort()).toEqual(
      [
        "campaignIds", "channels", "combinedCostEconomics", "costCoverage", "costEconomics", "customerCost",
        "funnelKey", "headline", "name", "outcomes", "priced", "steps", "unpricedReason",
      ].sort(),
    );
  });

  it("an offer no campaign of this brand sells is a NAMED 404, never a figure about an unknown scope", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(`/offers/offer-nobody-sells/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_channels");
  });

  it("brandId is required and pricing is fail-loud, like every sibling offer read", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    expect((await request(app).get(`/offers/${OFFER}/funnels`).set(AUTH)).status).toBe(400);
    expect(
      (await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}&pricing=whatever`).set(AUTH)).status,
    ).toBe(400);
  });

  it("EVERY EXISTING GRAIN answers exactly as it does now", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(offer.status).toBe(200);
    expect(offer.body.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
    // The offer body carries no funnel key: this grain is a NEW read, not a widening of an old one.
    expect(offer.body.funnels).toBeUndefined();

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const brand = await request(app).get(`/brands/${BRAND}/revenue`).set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const offers = await request(app).get(`/brands/${BRAND}/offers`).set(AUTH);
    expect(offers.status).toBe(200);
    expect(offers.body.offers).toHaveLength(1);
    expect(offers.body.offers[0].costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
  });
});

/**
 * A FUNNEL'S COST OF ACQUISITION COUNTS WHAT THE CUSTOMER SPENT ON IT TOO.
 *
 * The platform automates the first link and CHARGES for it; the customer runs the meeting and closes
 * the deal, and lead-service records what those legs cost THEM. Driven from the same one fixture, so
 * the charged half and the declared half are two views of one campaign set rather than two
 * computations to reconcile. What they pin:
 *
 *   - a funnel whose customer-worked legs carry declared costs reports a cost of acquisition that
 *     includes them, and a return computed from it;
 *   - a funnel with NONE reports exactly what it reported before this existed;
 *   - the two kinds of money stay tellable apart — `costEconomics` never moves, and none of the
 *     customer's money is folded into what we charged;
 *   - a leg nobody stated a cost for is never fabricated: it raises `unstatedCount` and the funnel says
 *     it can only be partly costed;
 *   - a statement is attributed by CAMPAIGN, so it lands in one row and nowhere else, and one that
 *     cannot be placed is stated apart rather than dropped;
 *   - the stated basis describes what the figures are actually made of, per row and for the payload;
 *   - an unreadable statement set degrades the customer half and 502s nothing.
 */
describe("GET /offers/:offerId/funnels — the customer's own money", () => {
  beforeEach(withFeatures);
  afterEach(() => vi.restoreAllMocks());

  /** $40.07 charged on the conversation funnel; the customer states $120 + $80 of their own legs. */
  const WITH_CUSTOMER_COST: Fixture = {
    ...ONE_CAMPAIGN_PER_FUNNEL,
    stepCosts: [
      { campaignId: "c1", step: "meeting_attended", kind: "outcome", costCents: 12_000 },
      { campaignId: "c1", step: "sale", kind: "never", costCents: 8_000 },
    ],
  };

  it("a funnel whose customer-worked legs carry declared costs is priced with them in", async () => {
    mockFetch(WITH_CUSTOMER_COST);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);
    const by = funnelsOf(res.body);
    const row = by[CONVERSATION];

    // What we CHARGED is untouched — it is a billing fact and none of their money is folded into it.
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
    // What THEY spent, stated apart. A "never" still cost: the meeting was run and went nowhere.
    expect(row.customerCost).toEqual({ declaredCostUsd: 200, statedCount: 2, unstatedCount: 0 });
    expect(row.costCoverage).toBe("platform_and_customer_spend");

    // The two together, and the return that divides by the sum.
    expect(row.combinedCostEconomics.platformCommittedCostUsd).toBeCloseTo(40.07, 6);
    expect(row.combinedCostEconomics.customerDeclaredCostUsd).toBeCloseTo(200, 6);
    expect(row.combinedCostEconomics.committedCostUsd).toBeCloseTo(240.07, 6);
    // The whole point: a funnel ending in a human leg is dearer, so its return is SMALLER than the one
    // computed off the billed link alone — the overstatement is what this closes.
    expect(row.combinedCostEconomics.roiMultiple).toBeLessThan(row.costEconomics.roiMultiple!);
    expect(row.combinedCostEconomics.costOfAcquisitionPct).toBeGreaterThan(row.costEconomics.costOfAcquisitionPct!);
    expect(row.combinedCostEconomics.costPerAcquisitionUsd).toBeGreaterThan(row.costEconomics.costPerAcquisitionUsd!);
    // Same statement in two units, as everywhere else here.
    expect(row.combinedCostEconomics.roiMultiple).toBeCloseTo(
      100 / row.combinedCostEconomics.costOfAcquisitionPct!,
      6,
    );

    // A statement is attributed by CAMPAIGN, so the other funnel's row does not move at all.
    expect(by[WEBSITE].customerCost).toEqual({ declaredCostUsd: 0, statedCount: 0, unstatedCount: 0 });
    expect(by[WEBSITE].costCoverage).toBe("platform_spend_only");
    expect(by[WEBSITE].combinedCostEconomics.committedCostUsd).toBeCloseTo(
      by[WEBSITE].costEconomics.committedCostUsd,
      6,
    );

    // The payload states the WEAKEST of its rows: one funnel here is not costed at all.
    expect(res.body.costCoverage).toBe("platform_spend_only");
    expect(res.body.customerCost.declaredCostUsd).toBeCloseTo(200, 6);
    expect(res.body.customerCost.unattributed).toEqual({ declaredCostUsd: 0, statedCount: 0, unstatedCount: 0 });
  });

  it("a funnel with NO customer-declared cost answers exactly as it does today", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);
    const row = funnelsOf(res.body)[CONVERSATION];

    expect(row.costCoverage).toBe("platform_spend_only");
    expect(row.customerCost).toEqual({ declaredCostUsd: 0, statedCount: 0, unstatedCount: 0 });
    // Additive, not a re-pricing: the combined block IS the charged one when nobody spent anything.
    expect(row.combinedCostEconomics.customerDeclaredCostUsd).toBe(0);
    expect(row.combinedCostEconomics.committedCostUsd).toBeCloseTo(row.costEconomics.committedCostUsd, 6);
    expect(row.combinedCostEconomics.roiMultiple).toBeCloseTo(row.costEconomics.roiMultiple!, 6);
    expect(row.combinedCostEconomics.costPerAcquisitionUsd).toBeCloseTo(row.costEconomics.costPerAcquisitionUsd!, 6);
    expect(res.body.costCoverage).toBe("platform_spend_only");
  });

  it("a leg nobody stated a cost for is NEVER fabricated — the funnel says it is only partly costed", async () => {
    mockFetch({
      ...ONE_CAMPAIGN_PER_FUNNEL,
      stepCosts: [
        { campaignId: "c1", step: "meeting_attended", kind: "outcome", costCents: 12_000 },
        // Stated before the cost became mandatory: nobody was ever asked. Absent is absent.
        { campaignId: "c1", step: "sale", kind: "outcome", costCents: null },
        // A stated ZERO is an ANSWER, not an absence — somebody did that leg for free.
        { campaignId: "c1", step: "meeting_booked", kind: "outcome", costCents: 0 },
      ],
    });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    const row = funnelsOf(res.body)[CONVERSATION];

    expect(row.customerCost).toEqual({ declaredCostUsd: 120, statedCount: 2, unstatedCount: 1 });
    expect(row.costCoverage).toBe("platform_and_partial_customer_spend");
    expect(row.combinedCostEconomics.committedCostUsd).toBeCloseTo(160.07, 6);
    expect(res.body.costCoverage).toBe("platform_and_partial_customer_spend");
  });

  it("a statement that belongs to no funnel of this offer is stated apart, never dropped and never parked", async () => {
    mockFetch({
      ...ONE_CAMPAIGN_PER_FUNNEL,
      stepCosts: [
        { campaignId: "c1", step: "sale", kind: "outcome", costCents: 5_000 },
        // A campaign this offer does not sell through, and a statement naming none at all.
        { campaignId: "elsewhere", step: "sale", kind: "outcome", costCents: 9_900 },
        { campaignId: null, step: "sale", kind: "outcome", costCents: 100 },
      ],
    });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    const by = funnelsOf(res.body);

    expect(by[CONVERSATION].customerCost!.declaredCostUsd).toBeCloseTo(50, 6);
    expect(by[WEBSITE].customerCost!.declaredCostUsd).toBe(0);
    expect(res.body.customerCost.unattributed).toEqual({
      declaredCostUsd: 100,
      statedCount: 2,
      unstatedCount: 0,
    });
    // Nothing is lost: the rows plus the leftovers ARE the brand's statements for this offer's read.
    expect(res.body.customerCost.declaredCostUsd).toBeCloseTo(150, 6);
  });

  it("an unreadable statement set degrades the customer half and 502s nothing", async () => {
    mockFetch({ ...ONE_CAMPAIGN_PER_FUNNEL, stepCosts: null });
    const res = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(res.status).toBe(200);
    const row = funnelsOf(res.body)[CONVERSATION];

    // NULL is "we could not read the statements" — never confused with "nobody stated one" (zeros).
    expect(row.customerCost).toBeNull();
    expect(res.body.customerCost).toBeNull();
    // The stated basis is still TRUE, and every charged figure is exactly what it was.
    expect(res.body.costCoverage).toBe("platform_spend_only");
    expect(row.costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
    expect(row.combinedCostEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
  });
});
