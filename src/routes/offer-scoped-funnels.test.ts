/**
 * A CAMPAIGN NAMES THE OFFER ITS FIGURES ARE PRICED ON — and a brand-scoped read of a brand selling
 * SEVERAL offers DEGRADES with a named reason, it never 502s.
 *
 * A declared sales funnel hangs off an OFFER: each carries its own conversion rates, its own lifetime
 * revenue and its own value proposition. So brand-service refuses (409 `SEVERAL_OFFERS`) a
 * brand-scoped declared-funnel read for a brand selling more than one, rather than serve one
 * proposition's economics under another's name. `audience-stats`, `workflow-projection` and
 * `funnel-ranking` turned that refusal into a 502, and the day a customer declared a second offer
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

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
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
  error: "This brand sells several offers; name the offer.",
  code: "SEVERAL_OFFERS",
  offers: [
    { offerId: OFFER_PRODUCT_LED, name: "Product-led" },
    { offerId: OFFER_SALES_LED, name: "Sales-led" },
  ],
};

const CAMPAIGN_ROWS = [
  {
    id: CAMPAIGN, orgId: "org-1", brandId: MULTI_BRAND, featureSlug: FEATURE.slug,
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

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("campaign:3000/campaigns")) return json({ campaigns: CAMPAIGN_ROWS });

    const declared = url.match(/brand:3000\/internal\/brands\/([^/?]+)\/sales-funnels/);
    if (declared) {
      funnelReads.push(url);
      const offerId = params.get("offerId");
      // The SOLE-offer brand answers whatever is asked, with or without an offer — which is exactly
      // why naming one costs a single-offer brand nothing.
      if (declared[1] === SOLO_BRAND) return json(funnelsFor(offerId));
      // The MULTI-offer brand refuses a read that names none. This is brand-service's deployed 409.
      if (!offerId) return json(SEVERAL_OFFERS_BODY, 409);
      return json(funnelsFor(offerId));
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
    // …and it got there by NAMING the offer on the wire, not by brand-service guessing.
    expect(funnelReads.length).toBeGreaterThan(0);
    for (const url of funnelReads) expect(url).toContain(`offerId=${OFFER_SALES_LED}`);
  });

  it("answers a campaign-scoped `?funnel=` read 200 instead of the 502 that blanked the page", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/audience-stats?brandId=${MULTI_BRAND}&funnel=website_purchases&campaignId=${CAMPAIGN}&pricing=net`,
    );
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
  });

  it("prices a campaign-scoped workflow-projection LEG read on the campaign's offer", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&leg=start_to_website_visit&campaignId=${CAMPAIGN}&pricing=net`,
    );
    expect(res.status).toBe(200);
    expect(res.body.leg.basisFunnelKey).toBe("website_purchases");
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    for (const url of funnelReads) expect(url).toContain(`offerId=${OFFER_SALES_LED}`);
  });
});

describe("a brand-scoped read of a several-offer brand degrades, it never 502s", () => {
  it("answers audience-stats at BRAND grain 200 with a named reason and the offers listed", async () => {
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

  it("answers a brand-grain `?funnel=` audience-stats read 200 rather than 404 funnel_not_declared", async () => {
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${MULTI_BRAND}&funnel=website_purchases`);
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved?.reason).toBe("several_offers");
  });

  it("answers a brand-grain funnel-keyed workflow-projection 200 with the reason on the body", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${MULTI_BRAND}&funnel=website_purchases&objective=self-serve&pricing=net`,
    );
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toEqual({
      reason: "several_offers",
      message: SEVERAL_OFFERS_BODY.error,
      offers: SEVERAL_OFFERS_BODY.offers,
    });
    expect(Array.isArray(res.body.rows)).toBe(true);
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

  it("answers funnel-ranking 200 unrankable with its own reason rather than 502", async () => {
    const res = await get(`/features/${FEATURE.slug}/funnel-ranking?brandId=${MULTI_BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("unrankable");
    expect(res.body.arbitration.reason).toBe("several_offers_unnamed");
    expect(res.body.declaredFunnelsUnresolved?.offers).toEqual(SEVERAL_OFFERS_BODY.offers);
    // campaign-service reads `arbitration.status === "resolved"` to decide whether a ranking exists,
    // so an unrankable body must still carry the shape it parses.
    expect(res.body.rows).toEqual([]);
    expect(res.body.recommendation).toBeNull();
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

  it("reads funnel-ranking resolved, with no offer on the wire", async () => {
    const res = await get(`/features/${FEATURE.slug}/funnel-ranking?brandId=${SOLO_BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.arbitration.reason).not.toBe("several_offers_unnamed");
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    for (const url of funnelReads) expect(url).not.toContain("offerId=");
  });

  it("reads workflow-projection with no offer on the wire and no unresolved block", async () => {
    const res = await get(
      `/features/${FEATURE.slug}/workflow-projection?brandId=${SOLO_BRAND}&funnel=website_purchases&objective=self-serve`,
    );
    expect(res.status).toBe(200);
    expect(res.body.declaredFunnelsUnresolved).toBeUndefined();
    for (const url of funnelReads) expect(url).not.toContain("offerId=");
  });
});

describe("the refusal stays distinguishable from an outage", () => {
  it("still 502s audience-stats when the declared-funnel read genuinely fails", async () => {
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("/sales-funnels")) return json({ error: "boom" }, 503);
      if (url.includes("campaign:3000/campaigns")) return json({ campaigns: CAMPAIGN_ROWS });
      if (url.includes("sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
      return json({});
    });
    const res = await get(`/features/${FEATURE.slug}/audience-stats?brandId=${MULTI_BRAND}&funnel=website_purchases`);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("declared_funnels_unavailable");
  });

  it("still 502s funnel-ranking when the declared-funnel read genuinely fails", async () => {
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("/sales-funnels")) return json({ error: "boom" }, 503);
      if (url.includes("sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
      if (url.includes("workflow:3000/public/workflows")) return json({ workflows: [workflow("wf-a")] });
      if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: [] });
      if (url.includes("email:3000/public/stats")) return json({ groups: [] });
      return json({});
    });
    const res = await get(`/features/${FEATURE.slug}/funnel-ranking?brandId=${MULTI_BRAND}`);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goals_unavailable");
  });
});
