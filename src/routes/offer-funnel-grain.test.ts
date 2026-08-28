/**
 * ONE SALES FUNNEL OF ONE OFFER, ANSWERED IN MONEY AT ITS OWN GRAIN.
 *
 * Driven from the SAME downstream fixture as the offer's own table, so a funnel's page and the row
 * that table shows for it are two views of one evidence set rather than two computations to reconcile.
 * What they pin:
 *
 *   - the funnel page carries what the lean row cannot — the spend breakdown, the return-on-spend curve
 *     and the dated actual series — which is the whole reason the read exists;
 *   - every figure is scoped to the FUNNEL's own campaigns: it is never the offer's numbers under a
 *     funnel's name, and the chart it draws is its own;
 *   - the money the page states is byte-equal to the money the offer's table states for the same funnel;
 *   - a funnel served by ONE campaign is byte-equal to that campaign's own answer;
 *   - a funnel served by one campaign per STEP is the same read over the larger set, and a funnel whose
 *     legs are only partly funded answers with what it has;
 *   - a funnel we cannot price reports its real spend beside a NULL return and names the gap;
 *   - the customer's own declared money rides it exactly as it rides the row;
 *   - a funnel the offer does not sell is a NAMED 404 stating the ones it does, and an unrecognised
 *     funnel word is a 400;
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
    // The DATED cost buckets behind the return-on-spend curve. Same rows the untimed read returns, one
    // bucket each — runs guarantees Sigma buckets equals that total for the same filter.
    if (path.includes("/costs/timeseries")) {
      return json({
        buckets: Object.keys(fixture.costByCampaign)
          .filter((cid) => inScope(cid, q))
          .map((cid) => ({ period: "2026-01-02", totalCostInUsdCents: String(fixture.costByCampaign[cid]) })),
      });
    }
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

const revenueUrl = (funnelKey: string, offer = OFFER) =>
  `/offers/${offer}/funnels/${funnelKey}/revenue?brandId=${BRAND}`;

describe("GET /offers/:offerId/funnels/:funnelKey/revenue — one funnel's money, in full", () => {
  beforeEach(withFeatures);
  afterEach(() => vi.restoreAllMocks());

  it("answers at the (offer x sales funnel) grain, carrying what the lean row cannot", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.offerId).toBe(OFFER);
    expect(res.body.brandId).toBe(BRAND);
    expect(res.body.funnelKey).toBe(CONVERSATION);
    expect(res.body.steps).toEqual(["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(res.body.campaignIds).toEqual(["c1"]);
    expect(res.body.costBasis).toBe("charged");
    expect(res.body.priced).toBe(true);
    expect(res.body.unpricedReason).toBeNull();

    // The funnel's own money: $40.07, not the offer's $50.39.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);

    // THE THREE THINGS THE ROW CANNOT CARRY, and the reason this route exists.
    // 1. the spend broken down the way the cost card reads it.
    expect(res.body.spend).not.toBeNull();
    expect(res.body.spend.totalSpentCents).toBe(4007);
    expect(Array.isArray(res.body.spend.sources)).toBe(true);
    // 2. the return over the customer's life with the brand — measured on both legs, and its dated and
    // undated halves account for the whole headline rather than dropping what cannot sit on a day.
    expect(res.body.roiHistory).not.toBeNull();
    expect(res.body.roiHistory.datedPipelineUsd + res.body.roiHistory.undatedPipelineUsd).toBeCloseTo(
      res.body.headline.totalPipelineUsd,
      6,
    );
    expect(res.body.roiHistory.daily[res.body.roiHistory.daily.length - 1].cumulativeSpendUsd).toBeCloseTo(
      40.07,
      6,
    );
    // 3. the dated series behind the activity chart, plus the leads they are built from.
    expect(res.body.recipientsContacted.total).toBe(1);
    // ONE lead, and it is the one this funnel's campaign reached — the other funnel's is not here.
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].leadId).toBe("l1");
  });

  it("states the funnel's OWN money — never the offer's numbers under a funnel's name", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const funnel = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(funnel.status).toBe(200);
    expect(offer.status).toBe(200);

    // The offer sells through two funnels, so its money is strictly larger than either one's.
    expect(offer.body.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
    expect(funnel.body.costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
    expect(funnel.body.spend.totalSpentCents).toBeLessThan(offer.body.spend.totalSpentCents);
    // And the series are the funnel's campaigns and nobody else's: the offer reached two leads.
    expect(offer.body.recipientsContacted.total).toBe(2);
    expect(funnel.body.recipientsContacted.total).toBe(1);
  });

  it("is byte-equal to the row the offer's own table shows for the same funnel", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const page = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const table = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(page.status).toBe(200);
    expect(table.status).toBe(200);

    const row = funnelsOf(table.body)[CONVERSATION];
    // One shared pricing rule, one shared engine: the page and the table can never print two prices.
    expect(page.body.headline).toEqual(row.headline);
    expect(page.body.costEconomics).toEqual(row.costEconomics);
    expect(page.body.combinedCostEconomics).toEqual(row.combinedCostEconomics);
    expect(page.body.outcomes).toEqual(row.outcomes);
    expect(page.body.priced).toBe(row.priced);
  });

  it("a funnel served by a SINGLE campaign is byte-equal to that campaign's own answer", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const funnel = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const campaign = await request(app).get(`/features/${PITCH}/revenue?brandId=${BRAND}&campaignId=c1`).set(AUTH);
    expect(funnel.status).toBe(200);
    expect(campaign.status).toBe(200);

    // Today every funnel is one campaign, so nothing about today's numbers moves.
    expect(funnel.body.headline).toEqual(campaign.body.headline);
    expect(funnel.body.costEconomics).toEqual(campaign.body.costEconomics);
    expect(funnel.body.spend.totalSpentCents).toBe(campaign.body.spend.totalSpentCents);
    expect(funnel.body.recipientsContacted).toEqual(campaign.body.recipientsContacted);
  });

  it("a funnel sold ONE CAMPAIGN PER STEP is the same read over the larger set, partial legs and all", async () => {
    // The shape the product is moving to: three campaigns buying three links of ONE funnel, across two
    // channels. None of them has a return of its own; the funnel does.
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
    const res = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.campaignIds).toEqual(["s1", "s2", "s3"]);
    // The funnel's money is every step's money: $10 + $20 + $30, and the spend card reads the same.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(60, 6);
    expect(res.body.spend.totalSpentCents).toBe(6000);
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(
      (res.body.headline.totalPipelineUsd as number) / 60,
      6,
    );
    // The per-channel breakdown says which legs are funded — partial is normal, not broken.
    const legs = (res.body.channels as Array<{ featureSlug: string; campaignIds: string[] }>).map(
      (c) => [c.featureSlug, c.campaignIds] as const,
    );
    expect(legs).toEqual([
      [FEEDBACK, ["s3"]],
      [PITCH, ["s1", "s2"]],
    ]);
    // Its legs' money adds up to the funnel's, with nothing counted twice.
    const summed = (res.body.channels as Array<{ costEconomics: { committedCostUsd: number } }>).reduce(
      (n, c) => n + c.costEconomics.committedCostUsd,
      0,
    );
    expect(summed).toBeCloseTo(60, 6);
    // People do NOT add across legs the same way: two leads, one per funded leg, deduped once.
    expect(res.body.recipientsContacted.total).toBe(2);
  });

  it("a funnel we cannot price reports its real spend beside a NULL return, naming the gap", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: "website_purchases", offerId: OFFER },
      },
      costByCampaign: { c1: 1000, c2: 2500 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "click")],
    });
    const res = await request(app).get(revenueUrl("website_purchases")).set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.priced).toBe(false);
    expect(res.body.unpricedReason).toBe("funnel_not_declared");
    // The customer paid it, so it is reported — in full, breakdown included.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(25, 6);
    expect(res.body.spend.totalSpentCents).toBe(2500);
    // Nothing is borrowed from the funnel beside it, and nothing is invented.
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.costEconomics.roiMultiple).toBeNull();
    expect(res.body.costEconomics.costPerAcquisitionUsd).toBeNull();
    // "We could not price this" and "this reached nobody" are different statements: the volume is real,
    // and it is on `outcomes` — the cold-start path prices no lead, so it lists none either.
    expect(res.body.outcomes.recipientsContacted).toBe(1);
  });

  it("the customer's own declared money rides it, apart from what we charged", async () => {
    mockFetch({
      ...ONE_CAMPAIGN_PER_FUNNEL,
      stepCosts: [
        { campaignId: "c1", step: "meeting_attended", kind: "outcome", costCents: 12_000 },
        { campaignId: "c1", step: "sale", kind: "never", costCents: 8_000 },
        // Another funnel's statement: attributed by CAMPAIGN, so it must not touch this page.
        { campaignId: "c2", step: "sale", kind: "outcome", costCents: 50_000 },
      ],
    });
    const res = await request(app).get(revenueUrl(CONVERSATION)).set(AUTH);
    expect(res.status).toBe(200);

    // What we CHARGED is untouched — none of their money is folded into it.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(40.07, 6);
    expect(res.body.customerCost).toEqual({ declaredCostUsd: 200, statedCount: 2, unstatedCount: 0 });
    expect(res.body.costCoverage).toBe("platform_and_customer_spend");
    expect(res.body.combinedCostEconomics.committedCostUsd).toBeCloseTo(240.07, 6);
    // A funnel ending in a human leg is dearer, so its return is SMALLER than the billed link's alone.
    expect(res.body.combinedCostEconomics.roiMultiple).toBeLessThan(res.body.costEconomics.roiMultiple);
  });

  it("a funnel the offer does not sell is a NAMED 404 stating the ones it does", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(revenueUrl("form_magnet")).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("funnel_not_sold");
    expect(res.body.funnelKey).toBe("form_magnet");
    // Never an empty body and never the offer's own numbers: it says where the money actually is.
    expect((res.body.soldFunnelKeys as string[]).sort()).toEqual([CONVERSATION, WEBSITE].sort());

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const noOffer = await request(app).get(revenueUrl(CONVERSATION, "offer-nobody-sells")).set(AUTH);
    expect(noOffer.status).toBe(404);
    expect(noOffer.body.reason).toBe("offer_has_no_channels");
  });

  it("a word naming no funnel is a 400, and so are a missing brandId and a bad pricing", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    expect((await request(app).get(revenueUrl("not-a-funnel")).set(AUTH)).status).toBe(400);
    expect(
      (await request(app).get(`/offers/${OFFER}/funnels/${CONVERSATION}/revenue`).set(AUTH)).status,
    ).toBe(400);
    expect(
      (await request(app).get(`${revenueUrl(CONVERSATION)}&pricing=whatever`).set(AUTH)).status,
    ).toBe(400);
  });

  it("a pre-retirement funnel spelling is accepted, like every other funnel-keyed read", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app).get(revenueUrl("reply_meeting")).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.funnelKey).toBe(CONVERSATION);
  });

  it("EVERY EXISTING GRAIN answers exactly as it does now", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const table = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(table.status).toBe(200);
    expect(table.body.funnels).toHaveLength(2);

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const offer = await request(app).get(`/offers/${OFFER}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(offer.status).toBe(200);
    expect(offer.body.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const brand = await request(app).get(`/brands/${BRAND}/revenue`).set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.costEconomics.committedCostUsd).toBeCloseTo(50.39, 6);
  });
});

describe("GET /offers/:offerId/funnels/:funnelKey/{pipeline-activity,audience-stats}", () => {
  beforeEach(withFeatures);
  afterEach(() => vi.restoreAllMocks());

  it("the funnel draws its OWN chart, and nulls what this grain cannot measure", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app)
      .get(`/offers/${OFFER}/funnels/${CONVERSATION}/pipeline-activity?brandId=${BRAND}&timezone=UTC&days=3`)
      .set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.funnelKey).toBe(CONVERSATION);
    // The channels merged into the series are the funnel's funded legs, nobody else's.
    expect(res.body.channels).toEqual([{ featureSlug: PITCH, campaignIds: ["c1"] }]);
    expect(res.body.days).toHaveLength(3);
    // A budget is funded per brand with no per-funnel ceiling to divide, and the conversion tracker is
    // brand-keyed — null is "we could not measure this at this grain", never a share and never a zero.
    expect(res.body.summary.dailyBudgetUsd).toBeNull();
    for (const day of res.body.days as Array<{ metrics: Record<string, { expected: number | null }> }>) {
      expect(day.metrics.outreach.expected).toBeNull();
    }
  });

  it("the per-audience read narrows to the funnel's campaigns and echoes what it is about", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const res = await request(app)
      .get(`/offers/${OFFER}/funnels/${CONVERSATION}/audience-stats?brandId=${BRAND}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.funnelKey).toBe(CONVERSATION);
    expect(res.body.channels).toEqual([{ featureSlug: PITCH, campaignIds: ["c1"] }]);
    expect(Array.isArray(res.body.audiences)).toBe(true);
  });

  it("both refuse an unsold funnel by NAME, exactly as the money read does", async () => {
    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const chart = await request(app)
      .get(`/offers/${OFFER}/funnels/form_magnet/pipeline-activity?brandId=${BRAND}&timezone=UTC`)
      .set(AUTH);
    expect(chart.status).toBe(404);
    expect(chart.body.reason).toBe("funnel_not_sold");

    mockFetch(ONE_CAMPAIGN_PER_FUNNEL);
    const audiences = await request(app)
      .get(`/offers/${OFFER}/funnels/form_magnet/audience-stats?brandId=${BRAND}`)
      .set(AUTH);
    expect(audiences.status).toBe(404);
    expect(audiences.body.reason).toBe("funnel_not_sold");
  });
});
