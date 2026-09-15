/**
 * A BRAND SELLING SEVERAL OFFERS IS STILL A BRAND WITH CAMPAIGNS TO PRICE.
 *
 * A declared funnel hangs off an OFFER: each carries its own conversion rates, its own lifetime revenue
 * and its own value proposition, so brand-service refuses a BRAND-scoped declaration read for a brand
 * selling several (409 `SEVERAL_OFFERS`) rather than serving one proposition's economics under the
 * other's name. features-service turned that refusal into a 502, and from the moment one org clicked
 * "create offer" a second time — 2026-09-09, org `f0420eb5…` on brand `f4d73dab…` (distribute.you) —
 * the campaign Workflows matrix, the audience cost columns and the best-model figures went blank on
 * every poll.
 *
 * A campaign sells exactly ONE offer, so a request that names a campaign has already named the offer
 * transitively — and it CANNOT name it any other way (`/audience-stats` 400s when `offerId` and
 * `campaignId` arrive together). So the offer is resolved server-side from the producer that owns the
 * campaign row, and the BRAND grain — which genuinely has no single answer — degrades with a named
 * reason instead of a 502.
 *
 * ONE fixture drives every case, and every assertion is a DIVERGENCE: the two offers are priced twenty
 * times apart ($200 self-serve against a $20,000 contract) on the SAME brand, the SAME funnel and the
 * SAME evidence. A suite that only checked "it answered 200" would pass on an implementation that read
 * the brand scope and served whichever offer brand-service happened to resolve — which is the outcome
 * worse than the 502 this replaces.
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
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const SLUG = "sales-cold-email-outreach";
const FEATURE = {
  id: "feat-1", slug: SLUG, name: "Sales", description: "x",
  status: "active", createdAt: new Date(), updatedAt: new Date(),
};
const BRAND = "brand-1";
const PRODUCT_LED = "832126f3-f3f1-4601-885d-bc8e101e5680";
const SALES_LED = "5a2868bb-ac88-42f6-a00a-e49b89b04079";
/** The campaign on the reported brand, selling the product-led offer. */
const CAMPAIGN_PRODUCT = "647572d9-729e-4731-9456-28fa351be92c";
/** Its sibling on the SAME brand and the SAME funnel, selling the other proposition. */
const CAMPAIGN_SALES = "9a6d3f52-1c2b-4a7e-9f40-2b2c1d5e7a08";

/** The brand-wide effective terms. Each OFFER refines the lifetime revenue twenty-fold apart. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000, replyToMeetingPct: 30, visitToMeetingPct: 20, meetingToClosePct: 50,
  visitToClosePct: 10, visitToSignupPct: 20, signupToPaidClientPct: 40, visitToPaidClientPct: 20,
  replyToPaidClientPct: 50, visitToFormSubmissionPct: 25, formSubmissionToPaidClientPct: 20,
};

const funnelRow = (funnelKey: string, lifetimeRevenueUsd: number) => ({
  funnelKey, active: true, name: funnelKey, steps: [], rates: {},
  lifetimeRevenueUsd, destinationUrl: null, bookingUrl: null, updatedAt: "2026-09-15T00:00:00.000Z",
});

/** What each offer declares — the SAME funnel, priced on its own proposition. */
const DECLARATION: Record<string, unknown[]> = {
  [PRODUCT_LED]: [funnelRow("website_purchases", 200)],
  [SALES_LED]: [funnelRow("website_purchases", 20000)],
};

const SEVERAL_OFFERS_BODY = {
  error: `Brand ${BRAND} sells 2 offers (Product-led, Sales-led), so a brand-scoped call has no single answer: each offer carries its own conversion rates, its own lifetime revenue and its own value proposition. Name the offer.`,
  code: "SEVERAL_OFFERS",
  offers: [
    { offerId: PRODUCT_LED, name: "Product-led" },
    { offerId: SALES_LED, name: "Sales-led" },
  ],
};

const CAMPAIGN_ROWS = [
  { id: CAMPAIGN_PRODUCT, orgId: "org-1", brandId: BRAND, featureSlug: SLUG, funnelKey: "website_purchases", acquisitionChannel: "cold_email", offerId: PRODUCT_LED, legKey: "start_to_website_visit", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: CAMPAIGN_SALES, orgId: "org-1", brandId: BRAND, featureSlug: SLUG, funnelKey: "website_purchases", acquisitionChannel: "linkedin", offerId: SALES_LED, legKey: "start_to_website_visit", status: "ongoing", createdAt: "2026-09-02T00:00:00.000Z" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}
const workflow = (slug: string) => ({
  id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastySlug: slug, workflowDynastyName: slug,
  version: 1, status: "active", featureSlug: SLUG, createdForBrandId: null, upgradedTo: null,
});
const costGroup = (dimensions: Record<string, string>, cents: number) => ({
  dimensions, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null,
});
const emailGroup = (key: string, contacted: number, clicked: number, repliesPositive: number) => ({
  key,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

/** How brand-service behaves for this brand on this run. */
type Declaration = "several_offers" | "single_offer" | "outage";
let declaration: Declaration = "several_offers";
/** Whether campaign-service answers — the fail-soft path that leaves the offer unknown. */
let campaignServiceDown = false;
/** Every downstream URL the request touched, so the request SHAPE can be asserted. */
let calls: string[] = [];

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    calls.push(url);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("campaign:3000/campaigns")) {
      if (campaignServiceDown) return json({ error: "boom" }, 503);
      return json({ campaigns: CAMPAIGN_ROWS });
    }
    if (url.includes("brand:3000/internal/brands/") && url.includes("/sales-funnels")) {
      if (declaration === "outage") return json({ error: "brand-service is down" }, 503);
      const offerId = params.get("offerId");
      if (declaration === "single_offer") return json({ funnels: DECLARATION[PRODUCT_LED] });
      if (!offerId) return json(SEVERAL_OFFERS_BODY, 409);
      return json({ funnels: DECLARATION[offerId] ?? [] });
    }
    if (url.includes("sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: [workflow("wf-a")] });
    if (url.includes("workflow:3000/workflows")) return json({ workflows: [] });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: [costGroup({ workflowSlug: "wf-a" }, 20000)] });
    if (url.includes("email:3000/public/stats")) return json({ groups: [emailGroup("wf-a", 1000, 100, 200)] });
    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [costGroup({ audienceId: "audience-a", workflowSlug: "wf-a" }, 5000)] });
      return json({ groups: [costGroup({ workflowSlug: "wf-a" }, 20000)] });
    }
    if (url.includes("runs:3000/v1/runs")) return json({ runs: [] });
    if (url.includes("email:3000/orgs/stats")) return json({ groups: [emailGroup("audience-a", 500, 40, 8)] });
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    if (url.includes("lead:3000/internal/brands/")) return json({ emails: [] });
    const members = url.match(/human:3000\/orgs\/audiences\/([^/]+)\/members/);
    if (members) return json({ members: [{ emailNorm: `${members[1]}-1` }], total: 1, limit: 500, offset: 0 });
    if (url.includes("human:3000/orgs/audiences")) {
      return json({ audiences: [{ id: "audience-a", brandId: BRAND, name: "CFOs", status: "active", filters: null }], total: 1, limit: 200, offset: 0 });
    }
    if (url.includes("chat") || url.includes("/internal/models")) return json({ models: [] });
    return json({});
  });
}

const declarationReads = (): string[] => calls.filter((u) => u.includes("/sales-funnels"));

beforeEach(() => {
  declaration = "several_offers";
  campaignServiceDown = false;
  calls = [];
  vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as never);
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

// ── audience-stats ────────────────────────────────────────────────────────────────────────────────

describe("audience-stats prices a campaign on the offer that campaign sells", () => {
  const get = (query: string) =>
    request(app).get(`/features/${SLUG}/audience-stats?brandId=${BRAND}&${query}`).set(AUTH);

  it("the campaign's own offer is read, and the two offers' campaigns are priced twenty times apart", async () => {
    const product = await get(`funnel=website_purchases&campaignId=${CAMPAIGN_PRODUCT}&pricing=net`);
    expect(product.status).toBe(200);
    expect(declarationReads().some((u) => u.includes(`offerId=${PRODUCT_LED}`))).toBe(true);
    const productLtr = product.body.brandProjection.lifetimeRevenueUsd;

    calls = [];
    const sales = await get(`funnel=website_purchases&campaignId=${CAMPAIGN_SALES}&pricing=net`);
    expect(sales.status).toBe(200);
    expect(declarationReads().some((u) => u.includes(`offerId=${SALES_LED}`))).toBe(true);

    // THE DIVERGENCE: one brand, one funnel, one evidence set — two propositions, two prices. An
    // implementation that read the brand scope could only have printed one of these for both.
    expect(productLtr).toBe(200);
    expect(sales.body.brandProjection.lifetimeRevenueUsd).toBe(20000);
    // Neither read had to be told which offer: nothing but the campaign id names it.
    expect(product.body.declaredFunnelsGap).toBeUndefined();
    expect(sales.body.declaredFunnelsGap).toBeUndefined();
  });

  it("the BRAND grain answers 200 with a named reason and the offers to pick from — never a 502", async () => {
    const res = await get("funnel=website_purchases&pricing=net");

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap).toEqual({
      reason: "several_offers",
      offers: SEVERAL_OFFERS_BODY.offers,
      message: SEVERAL_OFFERS_BODY.error,
    });
    // The funnel-specific terms are NOT borrowed from one of the two propositions.
    expect(res.body.brandProjection.lifetimeRevenueUsd).toBe(ECONOMICS.lifetimeRevenueUsd);
    // And the read still answers the volume half it never needed a declaration for.
    expect(res.body.audiences.length).toBe(1);
  });

  it("the BRAND-LEVEL read (no funnel, no goal) degrades its projected columns rather than 502-ing", async () => {
    const res = await get("pricing=net");

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap?.reason).toBe("several_offers");
    // No funnel coverage is claimed — we never read a set, so we do not report one.
    expect(res.body.funnelCoverage).toBeUndefined();
    // Projected, not fabricated: null is "we could not estimate this", never a zero return.
    expect(res.body.brandProjection.returnPerDollar).toBeNull();
    expect(res.body.brandProjection.costPerPaidClientUsd).toBeNull();
    expect(res.body.audiences[0].metrics.cpcCents).not.toBeUndefined();
  });

  it("a brand selling ONE offer is byte-unchanged: no gap, and no offer on the wire", async () => {
    declaration = "single_offer";
    const res = await get(`funnel=website_purchases&campaignId=${CAMPAIGN_PRODUCT}&pricing=net`);

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap).toBeUndefined();
    expect(res.body.brandProjection.lifetimeRevenueUsd).toBe(200);
  });

  it("a genuine declaration OUTAGE still 502s — the two are never conflated", async () => {
    declaration = "outage";
    const res = await get("funnel=website_purchases&pricing=net");

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("declared_funnels_unavailable");
  });

  it("campaign-service down leaves the offer unknown and degrades, rather than guessing one", async () => {
    campaignServiceDown = true;
    const res = await get(`funnel=website_purchases&campaignId=${CAMPAIGN_PRODUCT}&pricing=net`);

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap?.reason).toBe("several_offers");
    expect(declarationReads().every((u) => !u.includes("offerId="))).toBe(true);
  });
});

// ── workflow-projection ───────────────────────────────────────────────────────────────────────────

describe("workflow-projection prices a campaign's leg on that campaign's offer", () => {
  const get = (query: string) =>
    request(app).get(`/features/${SLUG}/workflow-projection?brandId=${BRAND}&${query}`).set(AUTH);

  it("a leg-and-campaign read resolves the offer from the campaign and answers a real leg block", async () => {
    const res = await get(`leg=start_to_website_visit&campaignId=${CAMPAIGN_PRODUCT}&pricing=net`);

    expect(res.status).toBe(200);
    expect(declarationReads().some((u) => u.includes(`offerId=${PRODUCT_LED}`))).toBe(true);
    expect(res.body.declaredFunnelsGap).toBeUndefined();
    expect(res.body.leg.basisFunnelKey).toBe("website_purchases");
    expect(res.body.campaignIdentity.campaignIds).toEqual([CAMPAIGN_PRODUCT]);
  });

  it("the two offers' campaigns are priced twenty times apart on the same leg and the same evidence", async () => {
    const product = await get(`leg=start_to_website_visit&campaignId=${CAMPAIGN_PRODUCT}&pricing=net`);
    const sales = await get(`leg=start_to_website_visit&campaignId=${CAMPAIGN_SALES}&pricing=net`);

    expect(product.body.economics.lifetimeRevenueUsd).toBe(200);
    expect(sales.body.economics.lifetimeRevenueUsd).toBe(20000);
    // The return follows the proposition, which is the entire reason brand-service refuses to guess.
    const brandRow = (b: Record<string, any>) => b.rows.find((r: any) => r.audienceId === null);
    expect(brandRow(sales.body).resolved.roiMultiple).toBeGreaterThan(brandRow(product.body).resolved.roiMultiple);
  });

  it("the BRAND grain (the read that 502'd in production) answers 200 with a named reason", async () => {
    const res = await get("funnel=website_purchases&objective=self-serve&pricing=net");

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap).toEqual({
      reason: "several_offers",
      offers: SEVERAL_OFFERS_BODY.offers,
      message: SEVERAL_OFFERS_BODY.error,
    });
    // It is emphatically NOT the `funnel_not_declared` 404: we could not check, and refusing a funnel
    // the brand may well declare would be an answer we have no evidence for.
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.economics.lifetimeRevenueUsd).toBe(ECONOMICS.lifetimeRevenueUsd);
  });

  it("a leg at BRAND grain answers without claiming a funnel set it never read", async () => {
    const res = await get("leg=start_to_website_visit&pricing=net");

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap?.reason).toBe("several_offers");
    // No basis funnel is named, because none was read — the leg block is absent rather than invented.
    expect(res.body.leg).toBeUndefined();
  });

  it("a brand selling ONE offer is byte-unchanged: no gap, no offer on the wire", async () => {
    declaration = "single_offer";
    const res = await get("funnel=website_purchases&objective=self-serve&pricing=net");

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap).toBeUndefined();
    expect(declarationReads().every((u) => !u.includes("offerId="))).toBe(true);
    expect(res.body.economics.lifetimeRevenueUsd).toBe(200);
  });

  it("a GOAL-keyed read reads no declaration at all, with or without several offers", async () => {
    const res = await get("goal=signup&pricing=net");

    expect(res.status).toBe(200);
    expect(declarationReads()).toEqual([]);
    expect(res.body.declaredFunnelsGap).toBeUndefined();
  });

  it("a genuine declaration OUTAGE still 502s", async () => {
    declaration = "outage";
    const res = await get("funnel=website_purchases&objective=self-serve&pricing=net");

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("declared_funnels_unavailable");
  });
});

// ── funnel-ranking ────────────────────────────────────────────────────────────────────────────────

describe("funnel-ranking answers a several-offer brand instead of 502-ing at it", () => {
  const get = (query = "") =>
    request(app).get(`/features/${SLUG}/funnel-ranking?brandId=${BRAND}${query}`).set(AUTH);

  it("ranks NOTHING and says why, naming the offers — the shape campaign-service reads as 'no ranking yet'", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("unrankable");
    expect(res.body.arbitration.reason).toBe("several_offers");
    expect(res.body.declaredFunnelsGap?.offers).toEqual(SEVERAL_OFFERS_BODY.offers);
    expect(res.body.ranking).toEqual([]);
    // No terms are echoed: the brand-wide set is NOT either offer's, which is the whole problem.
    expect(res.body.economics).toBeNull();
  });

  it("naming the offer ranks it, on that offer's own lifetime revenue", async () => {
    const res = await get(`&offerId=${SALES_LED}`);

    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsGap).toBeUndefined();
    expect(res.body.arbitration.status).toBe("resolved");
    expect(res.body.arbitration.funnelKey).toBe("website_purchases");
    expect(res.body.economics.lifetimeRevenueUsd).toBe(20000);
    expect(declarationReads().some((u) => u.includes(`offerId=${SALES_LED}`))).toBe(true);
  });

  it("a brand selling ONE offer is byte-unchanged: it ranks, with no offer on the wire", async () => {
    declaration = "single_offer";
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("resolved");
    expect(res.body.declaredFunnelsGap).toBeUndefined();
    expect(declarationReads().every((u) => !u.includes("offerId="))).toBe(true);
  });

  it("a genuine declaration OUTAGE still 502s with its deployed reason string", async () => {
    declaration = "outage";
    const res = await get();

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goals_unavailable");
  });
});
