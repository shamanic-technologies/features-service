/**
 * A CAMPAIGN NAMES THE OFFER ITS FIGURES ARE PRICED ON — and a brand-scoped read of a brand selling
 * SEVERAL offers DEGRADES with a named reason, it never 502s.
 *
 * A declared sales funnel hangs off an OFFER: each carries its own conversion rates, its own lifetime
 * revenue and its own value proposition. So brand-service refuses (409 `SEVERAL_OFFERS`) a
 * brand-scoped declared-funnel read for a brand selling more than one, rather than serve one
 * proposition's economics under another's name. `audience-stats`, `workflow-projection` and the
 * (since retired) funnel ranking turned that refusal into a 502, and the day a customer declared a second offer
 * their campaign Workflows matrix, their audience cost columns and their best-model figures all went
 * blank — with no retry and no fallback masking it.
 *
 * A campaign sells exactly ONE offer, so a request naming a campaign names the offer transitively,
 * which is the only path available (`?offerId=` beside `?campaignId=` is a 400 by design).
 *
 * Every case here asserts a DIVERGENCE on ONE fixture — two offers whose funnels are worth 10x
 * different amounts — so a suite that only checked "a number came back" would pass on the
 * implementation this replaces: it would read the WRONG offer's lifetime revenue, or nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => {
  const { everyWorkflowActive } = await import("../lib/leg-assignments-fixture.js");
  return {
    ...(await importOriginal<typeof import("../lib/workflow-leg-assignments.js")>()),
    fetchLegAssignments: vi.fn(async () => everyWorkflowActive()),
  };
});
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
// These suites pin the grains on email-gateway counts alone: the person-grain reply set is not read,
// so every grain reads what it always did (the person basis is guarded in crm-only-repliers.test.ts).
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(async () => undefined),
}));
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
process.env.CHAT_SERVICE_URL = "http://chat:3000";
process.env.CHAT_SERVICE_API_KEY = "chat-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x",
  status: "active", createdAt: new Date(), updatedAt: new Date(),
};

const ECONOMICS = {
  lifetimeRevenueUsd: 1000, replyToMeetingPct: 30, visitToMeetingPct: 20, meetingToClosePct: 50,
  visitToClosePct: 10, visitToSignupPct: 20, signupToPaidClientPct: 40, visitToPaidClientPct: 20,
  replyToPaidClientPct: 50, visitToFormSubmissionPct: 25, formSubmissionToPaidClientPct: 20,
};

// ── THE FIXTURE ───────────────────────────────────────────────────────────────
//
// Shaped like the production brand that reported it: TWO offers declared on one brand, each selling
// through the same funnel key but worth a different amount — Product-led at $500 a client and
// Sales-led at $5,000. A campaign sells ONE of them, so its figures must be priced on that one.
const OFFER_PRODUCT_LED = "832126f3-f3f1-4601-885d-bc8e101e5680";
const OFFER_SALES_LED = "5a2868bb-ac88-42f6-a00a-e49b89b04079";
const CAMPAIGN = "647572d9-729e-4731-9456-28fa351be92c";
const SOLO_BRAND = "brand-solo";
const MULTI_BRAND = "brand-multi";

const OFFER_LTR: Record<string, number> = {
  [OFFER_PRODUCT_LED]: 500,
  [OFFER_SALES_LED]: 5000,
};

const SEVERAL_OFFERS_BODY = {
  // Raised by this service since wave C1 (the offers come from brand-service's offer-economics).
  error: `brand ${"brand-multi"} sells several offers and this read named none`,
  code: "SEVERAL_OFFERS",
  offers: [
    { offerId: OFFER_PRODUCT_LED, name: "Product-led" },
    { offerId: OFFER_SALES_LED, name: "Sales-led" },
  ],
};

const CAMPAIGN_ROWS = [
  {
    id: CAMPAIGN, orgId: "0e9a0000-0000-4000-8000-000000000001", brandId: MULTI_BRAND, featureSlug: FEATURE.slug,
    funnelKey: "website_purchases", acquisitionChannel: "cold_email", legKey: "start_to_website_visit",
    offerId: OFFER_SALES_LED, status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z",
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}
function workflow(slug: string): Record<string, unknown> {
  return {
    id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastySlug: slug, workflowDynastyName: slug,
    version: 1, status: "active", featureSlug: FEATURE.slug, createdForBrandId: null, upgradedTo: null,
  };
}
function costGroup(dimensions: Record<string, string>, cents: number, runCount = 1): Record<string, unknown> {
  return { dimensions, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
function emailGroup(key: string, contacted: number, clicked: number, repliesPositive: number): Record<string, unknown> {
  return { key, broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive } } };
}

/** The declared funnel one OFFER states — its lifetime revenue is what tells the two apart. */
function funnelsFor(offerId: string | null): Record<string, unknown> {
  // A brand-scoped read of the MULTI-offer brand never gets here: brand-service refuses it (409).
  const ltr = offerId ? OFFER_LTR[offerId] ?? 1000 : 1000;
  return {
    funnels: [
      {
        funnelKey: "website_purchases", active: true, name: "Website purchases",
        steps: ["Website visit", "Signup", "Paid client"],
        rates: { visitToSignupPct: 20, signupToPaidClientPct: 40 },
        lifetimeRevenueUsd: ltr, destinationUrl: null, bookingUrl: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  };
}

/** Every declared-funnel URL the request touched, so the request SHAPE can be asserted. */
let funnelReads: string[] = [];
/** The brand's campaigns as campaign-service serves them; a test may add one. */
let campaignRows: Record<string, unknown>[] = CAMPAIGN_ROWS;

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("campaign:3000/campaigns")) return json({ campaigns: campaignRows });

    // Wave C1: brand-service's offer-economics — the brand's leg rates and EVERY offer's lifetime
    // revenue. No offer is named on the wire any more: the pricing read resolves it locally, and a
    // brand-scoped read of the multi-offer brand refuses with the same several-offers answer.
    const legs = url.match(/brand:3000\/internal\/brands\/([^/?]+)\/offer-economics/);
    if (legs) {
      funnelReads.push(url);
      const legRates = [
        { fromStep: "Website visit", toStep: "Signup", ratePct: 20, stated: true, statedAt: "x" },
        { fromStep: "Signup", toStep: "Paid client", ratePct: 40, stated: true, statedAt: "x" },
      ];
      const offers =
        legs[1] === SOLO_BRAND
          ? [{ offerId: OFFER_SALES_LED, name: "Sales-led", lifetimeRevenueUsd: 1000, lifetimeRevenueStatedAt: "x" }]
          : [
              { offerId: OFFER_PRODUCT_LED, name: "Product-led", lifetimeRevenueUsd: OFFER_LTR[OFFER_PRODUCT_LED], lifetimeRevenueStatedAt: "x" },
              { offerId: OFFER_SALES_LED, name: "Sales-led", lifetimeRevenueUsd: OFFER_LTR[OFFER_SALES_LED], lifetimeRevenueStatedAt: "x" },
            ];
      return json({ legRates, offers });
    }

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: [workflow("wf-a")] });
    if (url.includes("workflow:3000/workflows")) return json({ workflows: [] });
    if (url.includes("chat:3000/internal/models")) return json({ models: [] });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: [costGroup({ workflowSlug: "wf-a" }, 20000, 10)] });
    if (url.includes("email:3000/public/stats")) return json({ groups: [emailGroup("wf-a", 1000, 100, 200)] });
    if (url.includes("sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("lead:3000/internal/brands/")) return json({ emails: [] });

    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) {
        return json({ groups: [costGroup({ audienceId: "audience-a", ...(groupBy.includes("workflowSlug") ? { workflowSlug: "wf-a" } : {}), ...(groupBy.includes("campaignId") ? { campaignId: CAMPAIGN } : {}) }, 4000)] });
      }
      if (groupBy === "workflowSlug") return json({ groups: [costGroup({ workflowSlug: "wf-a" }, 4000, 2)] });
      return json({ groups: [] });
    }
    if (url.includes("runs:3000/v1/runs")) return json({ runs: [] });

    if (url.includes("email:3000/orgs/stats")) {
      return json({ groups: [emailGroup(params.get("audienceId") ? "wf-a" : "audience-a", 100, 6, 2)] });
    }

    const members = url.match(/human:3000\/orgs\/audiences\/([^/]+)\/members/);
    if (members) return json({ members: [{ emailNorm: `${members[1]}-1` }], total: 1, limit: 500, offset: 0 });
    if (url.includes("human:3000/orgs/audiences")) {
      return json({
        audiences: [{ id: "audience-a", brandId: MULTI_BRAND, name: "CFOs", status: "active", filters: null }],
        total: 1, limit: 200, offset: 0,
      });
    }
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    return json({});
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  funnelReads = [];
  campaignRows = CAMPAIGN_ROWS;
  (db.query.features.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(FEATURE);
  fetchSpy = mockFetch();
});
afterEach(() => fetchSpy.mockRestore());

const get = (path: string): request.Test => request(app).get(path).set(AUTH);

describe("a campaign names the offer its declared funnels are read under", () => {
  it("prices a campaign-scoped audience-stats read on THE CAMPAIGN'S OWN offer, not the other one", async () => {
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${MULTI_BRAND}&campaignId=${CAMPAIGN}`);
    expect(res.status).toBe(200);
    // THE DIVERGENCE: the campaign sells the $5,000 offer. The $500 one is the other proposition and
    // must never price this campaign — an implementation that read the brand scope gets neither.
    expect(res.body.brandProjection.lifetimeRevenueUsd).toBe(OFFER_LTR[OFFER_SALES_LED]);
    expect(res.body.brandProjection.lifetimeRevenueUsd).not.toBe(OFFER_LTR[OFFER_PRODUCT_LED]);
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    // Wave C1: the offer is resolved HERE from brand-service's offer-economics (no offer on the wire);
    // the lifetime revenue above is what proves which one.
    expect(funnelReads.length).toBeGreaterThan(0);
  });

  it("prices a campaign-scoped workflow-projection LEG read on the campaign's offer", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&campaignId=${CAMPAIGN}&pricing=net`,
    );
    expect(res.status).toBe(200);
    expect(res.body.leg.basisFunnelKey).toBe("website_purchases");
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
  });
});

describe("a brand-scoped read of a several-offer brand degrades, it never 502s", () => {
  it("answers audience-stats at BRAND grain 200 with a named reason and the offers listed", async () => {
    // BOTH offers run a campaign: the brand read cannot stand for one of them (with only the sales-led
    // campaign it IS the sales-led read, `soleOfferWithCampaigns`, owner 2026-10-04).
    campaignRows = [
      ...CAMPAIGN_ROWS,
      { ...CAMPAIGN_ROWS[0], id: "11111111-1111-4111-8111-111111111111", offerId: OFFER_PRODUCT_LED, status: "stopped" },
    ];
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${MULTI_BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toEqual({
      reason: "several_offers",
      message: SEVERAL_OFFERS_BODY.error,
      offers: SEVERAL_OFFERS_BODY.offers,
    });
    // The VOLUME half is a measured fact about spend, not about a proposition — it survives intact.
    expect(res.body.audiences).toHaveLength(1);
    expect(res.body.audiences[0].evidence.contacted).toBe(100);
    // The PROJECTED half is what degrades — null, never one offer's number under the other's name.
    expect(res.body.brandProjection.lifetimeRevenueUsd).toBeNull();
    expect(res.body.brandProjection.returnPerDollar).toBeNull();
  });

  it("refuses a brand-grain LEG read with a 409 naming the offers — never a fabricated funnel set", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit`,
    );
    // A leg is priced THROUGH one of the brand's declared funnels, so the declared set is the answer
    // here rather than a refinement of it. 409, not 502: the caller has a choice it can make.
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("several_offers");
    expect(res.body.offers).toEqual(SEVERAL_OFFERS_BODY.offers);
  });

});

describe("?offerId= prices a (brand, offer) pair that has NO campaign yet", () => {
  // A brand being set up: the customer picks ONE offer and asks what each leg would cost before any
  // campaign exists, so there is no campaign to name the offer through.
  const brandRow = (body: { rows: Array<{ audienceId: string | null; workflow: { workflowDynastySlug: string } }> }) =>
    body.rows.find((r) => r.audienceId === null && r.workflow.workflowDynastySlug === "wf-a") as
      | { resolved: { costPerOutcomeUsd: number | null; roiMultiple: number | null } }
      | undefined;

  for (const leg of ["start_to_website_visit", "start_to_conversation"]) {
    it(`answers the ${leg} leg of a SEVERAL-offer brand with a recommended workflow and a price`, async () => {
      const res = await get(
        `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=${leg}&offerId=${OFFER_SALES_LED}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.recommendedWorkflowDynastySlug).toBe("wf-a");
      expect(brandRow(res.body)?.resolved.costPerOutcomeUsd).toEqual(expect.any(Number));
    });
  }

  it("prices on THE NAMED offer's lifetime revenue — two offers, two returns on identical spend", async () => {
    const path = (offerId: string) =>
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&offerId=${offerId}`;
    const sales = await get(path(OFFER_SALES_LED));
    const product = await get(path(OFFER_PRODUCT_LED));
    expect(sales.status).toBe(200);
    expect(product.status).toBe(200);
    // Same evidence, same cost per outcome: the offer moves what an outcome is WORTH, not what it costs.
    expect(brandRow(sales.body)?.resolved.costPerOutcomeUsd).toBe(brandRow(product.body)?.resolved.costPerOutcomeUsd);
    const salesRoi = brandRow(sales.body)?.resolved.roiMultiple;
    const productRoi = brandRow(product.body)?.resolved.roiMultiple;
    expect(salesRoi).toEqual(expect.any(Number));
    expect(salesRoi).toBeCloseTo((productRoi as number) * (OFFER_LTR[OFFER_SALES_LED] / OFFER_LTR[OFFER_PRODUCT_LED]), 6);
  });

  it("is a 404 for an offer the brand does not sell — never the brand's other offer", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&offerId=not-an-offer`,
    );
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_not_found");
  });

  it("refuses an offerId without a leg, and beside a campaign", async () => {
    const noLeg = await get(`/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&objective=self-serve&offerId=${OFFER_SALES_LED}`);
    expect(noLeg.status).toBe(400);
    expect(noLeg.body.reason).toBe("offer_requires_leg");
    const both = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&offerId=${OFFER_SALES_LED}&campaignId=${CAMPAIGN}`,
    );
    expect(both.status).toBe(400);
    expect(both.body.reason).toBe("offer_and_campaign");
  });

  it("names on the offer the same answer the campaign that sells it gets", async () => {
    const byOffer = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&offerId=${OFFER_SALES_LED}`,
    );
    const byCampaign = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&campaignId=${CAMPAIGN}`,
    );
    expect(brandRow(byOffer.body)?.resolved.roiMultiple).toBe(brandRow(byCampaign.body)?.resolved.roiMultiple);
  });
});

describe("a brand selling ONE offer is byte-unchanged", () => {
  it("reads audience-stats without naming an offer, and states no unresolved block", async () => {
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${SOLO_BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    expect(res.body.funnelCoverage).toBeDefined();
    expect(funnelReads.length).toBeGreaterThan(0);
    for (const url of funnelReads) expect(url).not.toContain("offerId=");
  });

  it("reads workflow-projection with no offer on the wire and no unresolved block", async () => {
    const res = await get(`/features/${FEATURE.slug}/workflow-projection?brandId=${SOLO_BRAND}&objective=self-serve`);
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    for (const url of funnelReads) expect(url).not.toContain("offerId=");
  });
});

describe("the refusal stays distinguishable from an outage", () => {
  it("still 502s audience-stats when the brand's funnel read genuinely fails", async () => {
    // Everything else answers as in every other case; only the read the brand-level projection is
    // priced on fails — an outage, not a question with several answers.
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      urlOf(input).includes("/offer-economics") ? json({ error: "boom" }, 503) : base(input, init),
    );
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${SOLO_BRAND}`);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("declared_funnels_unavailable");
  });

});
