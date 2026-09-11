/**
 * ONE OFFER'S WORKFLOWS — `?groupBy=workflow&offerId=`.
 *
 * The campaign Workflows page is gaining granularity tabs (Campaign · Offer · Brand). Campaign and
 * brand were answered; an `offerId` on the grouped read was IGNORED, so a consumer asking for one
 * offer's per-workflow figures was silently handed the brand's — the wrong-grain bug this fleet has
 * already paid for once.
 *
 * These drive `/revenue?groupBy=workflow` from ONE fixture where the brand's numbers, offer A's and
 * offer B's DIVERGE by construction: two offers run the SAME workflow dynasty with different spend
 * and different people, and a third campaign states no offer at all. So every case asserts the
 * divergence — a suite that only checked "a number came back" would pass on the implementation that
 * ignored the parameter, which is what shipped before.
 *
 * They also pin what must NOT move: a brand whose campaigns all sell ONE offer reads the byte-same
 * groups at both grains, and an un-narrowed read is unchanged.
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
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const SALES = "sales-cold-email-outreach";
const BRAND = "brand-1";
const OFFER_A = "offer-a";
const OFFER_B = "offer-b";
/** An offer whose campaign exists and has never spent — a real, EMPTY answer, never the brand's. */
const OFFER_QUIET = "offer-quiet";
/** An offer no campaign of this brand sells — a named 404, never a fabricated zero. */
const OFFER_UNSOLD = "offer-unsold";

const FEATURE = {
  id: "feat-1", slug: SALES, name: "Sales", description: "x", status: "active",
  outputs: [], charts: [],
  createdAt: new Date(), updatedAt: new Date(),
};

/** A positively-replying lead is worth LTR × replyToMeeting × meetingToClose = 1000 × .4 × .3 = 120. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

/** Two versions of ONE dynasty (`dawn`) beside a second dynasty (`osprey`). */
const WORKFLOWS = [
  { id: "w1", workflowSlug: "dawn-v1", workflowName: "Dawn v1", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 1, status: "inactive", featureSlug: SALES, createdForBrandId: null, upgradedTo: "w2" },
  { id: "w2", workflowSlug: "dawn-v2", workflowName: "Dawn v2", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 2, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
  { id: "w3", workflowSlug: "osprey-v1", workflowName: "Osprey v1", workflowDynastyName: "Osprey", workflowDynastySlug: "osprey", version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
];

/**
 * The brand's campaigns, each stating the OFFER it sells — campaign-service's own column. `n1` states
 * none: it is in no offer's scope, with its spend and its leads, exactly as `?groupBy=offerId` has it.
 */
const CAMPAIGNS = [
  { id: "a1", orgId: "org-1", brandId: BRAND, featureSlug: SALES, offerId: OFFER_A, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: SALES, status: "ongoing", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "a2", orgId: "org-1", brandId: BRAND, featureSlug: SALES, offerId: OFFER_A, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "crm_email", status: "stopped", createdAt: "2026-01-02T00:00:00.000Z" },
  { id: "b1", orgId: "org-1", brandId: BRAND, featureSlug: SALES, offerId: OFFER_B, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "linkedin", status: "ongoing", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "q1", orgId: "org-1", brandId: BRAND, featureSlug: SALES, offerId: OFFER_QUIET, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "phone", status: "ongoing", createdAt: "2026-02-02T00:00:00.000Z" },
  { id: "n1", orgId: "org-1", brandId: BRAND, featureSlug: SALES, offerId: null, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "sms", status: "ongoing", createdAt: "2026-02-03T00:00:00.000Z" },
];

type LeadShape = { clicked?: boolean; positive?: boolean };
function lead(campaignId: string, workflowSlug: string | null, leadId: string, shape: LeadShape = {}): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    workflowSlug,
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: Boolean(shape.clicked),
    bounced: false,
    unsubscribed: false,
    replied: Boolean(shape.positive),
    replyClassification: shape.positive ? "positive" : null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

/** COMMITTED cents per (campaignId, versioned workflow slug) — what runs-service holds. */
interface CostRow { campaignId: string; workflowSlug: string; committed: number; actual: number }

const COSTS: CostRow[] = [
  { campaignId: "a1", workflowSlug: "dawn-v2", committed: 4000, actual: 3000 },
  { campaignId: "a2", workflowSlug: "dawn-v1", committed: 1000, actual: 1000 },
  { campaignId: "a1", workflowSlug: "osprey-v1", committed: 2000, actual: 2000 },
  // Offer B, on the SAME dynasty: a group that ignored the offer scope reads the brand's 13500¢.
  { campaignId: "b1", workflowSlug: "dawn-v2", committed: 8000, actual: 8000 },
  // States no offer — in no offer's scope, and the reason the brand does not equal A + B.
  { campaignId: "n1", workflowSlug: "dawn-v2", committed: 500, actual: 500 },
];

const LEADS = [
  lead("a1", "dawn-v2", "l1", { positive: true }),
  lead("a1", "dawn-v2", "l2"),
  lead("a2", "dawn-v1", "l3", { positive: true }),
  lead("a1", "osprey-v1", "l4", { clicked: true }),
  lead("b1", "dawn-v2", "o1", { positive: true }),
  lead("b1", "dawn-v2", "o2", { positive: true }),
  lead("b1", "dawn-v2", "o3", { positive: true }),
  lead("n1", "dawn-v2", "x1", { positive: true }),
];

interface Options {
  /** Every campaign states OFFER_A — the one-offer brand, which must read the brand's own groups. */
  singleOffer?: boolean;
}

/**
 * Emulates the producers' OWN filtering, so the assertions are about this service's requests rather
 * than about a fixture that hands back whatever is convenient. runs takes no campaign LIST, so a
 * multi-member scope is co-grouped by campaign and folded here.
 */
type FetchImpl = (input: unknown, init?: unknown) => Promise<Response>;

function mockFetch(options: Options = {}): FetchImpl {
  const campaigns = options.singleOffer ? CAMPAIGNS.map((c) => ({ ...c, offerId: OFFER_A })) : CAMPAIGNS;
  const impl: FetchImpl = async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.pathname.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.pathname.endsWith("/campaigns")) return json({ campaigns });
    if (url.pathname.includes("/sales-funnels")) {
      return json({ funnels: [{ funnelKey: "sales_meetings_from_conversation", name: "Meetings from a conversation" }] });
    }
    if (url.pathname.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (url.pathname.includes("/stats/public/costs/timeseries")) {
      const campaignId = q.get("campaignId");
      const total = COSTS.filter((c) => !campaignId || c.campaignId === campaignId).reduce((s, c) => s + c.committed, 0);
      return json({
        interval: "day",
        timezone: "UTC",
        buckets: [{
          period: "2026-02-01",
          totalCostInUsdCents: String(total), actualCostInUsdCents: String(total),
          provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", refundedCostInUsdCents: "0",
          netRefundedCostInUsdCents: "0", netTotalCostInUsdCents: String(total / 2),
          netActualCostInUsdCents: String(total / 2), netProvisionedCostInUsdCents: "0", runCount: 1,
        }],
      });
    }
    if (url.pathname.includes("/stats/costs")) {
      const campaignId = q.get("campaignId");
      const groupBy = (q.get("groupBy") ?? "").split(",");
      const groups = COSTS.filter((c) => !campaignId || c.campaignId === campaignId).map((c) => {
        const dimensions: Record<string, string> = {};
        if (groupBy.includes("workflowSlug")) dimensions.workflowSlug = c.workflowSlug;
        if (groupBy.includes("campaignId")) dimensions.campaignId = c.campaignId;
        if (groupBy.includes("costName")) dimensions.costName = "email-send";
        return {
          dimensions,
          // NET is deliberately HALF the gross here, so a net read cannot pass as a gross one.
          totalCostInUsdCents: String(c.committed),
          actualCostInUsdCents: String(c.actual),
          netTotalCostInUsdCents: String(c.committed / 2),
          netActualCostInUsdCents: String(c.actual / 2),
          runCount: 1, minStartedAt: null, maxStartedAt: null,
        };
      });
      return json({ groups });
    }
    if (url.pathname.includes("/orgs/leads")) {
      const campaignId = q.get("campaignId");
      return json({ leads: campaignId ? LEADS.filter((l) => l.campaignId === campaignId) : LEADS });
    }
    if (url.pathname.includes("/orgs/stats")) {
      const campaignId = q.get("campaignId");
      const contacted = LEADS.filter((l) => !campaignId || l.campaignId === campaignId).length;
      return json({ groups: [{ key: "2026-02-01", broadcast: { recipientStats: { contacted } } }] });
    }
    if (url.pathname.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.pathname.includes("/orgs/status")) return json({ results: [] });
    return json({});
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
  return impl;
}

/** The same fixture, with every request URL recorded — for asserting what the PRODUCERS were asked. */
function recordingFetch(options: Options = {}): string[] {
  const impl = mockFetch(options);
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: unknown) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url);
    return impl(input, init);
  }) as never);
  return seen;
}

interface Group {
  workflowDynastySlug: string;
  workflowSlugs: string[];
  headline: { totalPipelineUsd: number | null };
  costEconomics: { committedCostUsd: number };
  outcomes: { recipientsContacted: number; recipientsRepliesPositive: number; recipientsClicked: number; committedSpentCents: number; cpprCents: number | null; cpcCents: number | null };
}

async function grouped(query: string): Promise<{ status: number; body: Record<string, unknown>; byWorkflow: Record<string, Group> }> {
  const res = await request(app).get(`/features/${SALES}/revenue?brandId=${BRAND}&groupBy=workflow${query}`).set(AUTH);
  const groups: Group[] = (res.body.groups ?? []) as Group[];
  return { status: res.status, body: res.body, byWorkflow: Object.fromEntries(groups.map((g) => [g.workflowDynastySlug, g])) };
}

beforeEach(() => {
  vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as never);
});
afterEach(() => vi.restoreAllMocks());

describe("?groupBy=workflow&offerId= — one offer's workflows, at the offer's grain", () => {
  it("states what THIS offer did through each workflow, and DIVERGES from the brand and from the other offer", async () => {
    mockFetch();

    const brand = await grouped("");
    const a = await grouped(`&offerId=${OFFER_A}`);
    const b = await grouped(`&offerId=${OFFER_B}`);

    // The brand's `dawn` row folds in both offers AND the campaign that states none: 4000+1000+8000+500.
    expect(brand.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(135);
    expect(brand.byWorkflow.dawn.outcomes.recipientsContacted).toBe(7);
    expect(brand.byWorkflow.dawn.outcomes.recipientsRepliesPositive).toBe(6);

    // Offer A: its two campaigns' spend on the dynasty (4000 + 1000) and its own people.
    expect(a.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(50);
    expect(a.byWorkflow.dawn.outcomes.committedSpentCents).toBe(5000);
    expect(a.byWorkflow.dawn.outcomes.recipientsContacted).toBe(3);
    expect(a.byWorkflow.dawn.outcomes.recipientsRepliesPositive).toBe(2);
    // 5000¢ over 2 replies — coherent with the committed basis by construction.
    expect(a.byWorkflow.dawn.outcomes.cpprCents).toBe(2500);
    // Two positively-replying leads in two organisations: 2 × $120.
    expect(a.byWorkflow.dawn.headline.totalPipelineUsd).toBeCloseTo(240, 5);
    // BOTH versions of the dynasty are folded in — one per campaign of the offer.
    expect(a.byWorkflow.dawn.workflowSlugs).toEqual(["dawn-v1", "dawn-v2"]);

    // Offer B, same dynasty, its own numbers — and they are NOT offer A's.
    expect(b.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(80);
    expect(b.byWorkflow.dawn.outcomes.recipientsContacted).toBe(3);
    expect(b.byWorkflow.dawn.outcomes.recipientsRepliesPositive).toBe(3);
    expect(b.byWorkflow.dawn.headline.totalPipelineUsd).toBeCloseTo(360, 5);
    expect(b.byWorkflow.dawn.costEconomics.committedCostUsd).not.toBe(a.byWorkflow.dawn.costEconomics.committedCostUsd);
    expect(b.byWorkflow.dawn.headline.totalPipelineUsd).not.toBe(a.byWorkflow.dawn.headline.totalPipelineUsd);
  });

  it("keeps every workflow of the offer, each on its own numbers — and no other offer's", async () => {
    mockFetch();

    const a = await grouped(`&offerId=${OFFER_A}`);
    const b = await grouped(`&offerId=${OFFER_B}`);

    expect(Object.keys(a.byWorkflow).sort()).toEqual(["dawn", "osprey"]);
    expect(a.byWorkflow.osprey.costEconomics.committedCostUsd).toBe(20);
    expect(a.byWorkflow.osprey.outcomes.recipientsContacted).toBe(1);
    // It reached one person who visited the site and nobody who replied: a MEASURED 0 beside a NULL
    // rate, never a $0 that would read as a free reply.
    expect(a.byWorkflow.osprey.outcomes.recipientsRepliesPositive).toBe(0);
    expect(a.byWorkflow.osprey.outcomes.cpprCents).toBeNull();
    expect(a.byWorkflow.osprey.outcomes.cpcCents).toBe(2000);

    // Offer B never ran osprey, so it has no osprey row — not a zeroed one borrowed from A.
    expect(Object.keys(b.byWorkflow)).toEqual(["dawn"]);
  });

  it("a brand selling ONE offer reads the byte-same groups at both grains", async () => {
    mockFetch({ singleOffer: true });

    const brand = await grouped("");
    const offer = await grouped(`&offerId=${OFFER_A}`);

    expect(offer.byWorkflow).toEqual(brand.byWorkflow);
    expect(offer.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(135);
  });

  it("an offer whose campaigns never spent through a workflow is an EMPTY list, never the brand's figures", async () => {
    mockFetch();

    const quiet = await grouped(`&offerId=${OFFER_QUIET}`);

    expect(quiet.status).toBe(200);
    expect(quiet.body.groups).toEqual([]);
    expect(quiet.byWorkflow.dawn).toBeUndefined();
  });

  it("an offer no campaign of this brand sells is a named 404, never a fabricated zero", async () => {
    mockFetch();

    const res = await request(app)
      .get(`/features/${SALES}/revenue?brandId=${BRAND}&groupBy=workflow&offerId=${OFFER_UNSOLD}`)
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_campaigns");
    expect(res.body.offerId).toBe(OFFER_UNSOLD);
    expect(res.body.groups).toBeUndefined();
  });

  it("naming an offer AND a campaign is a 400 — a campaign already sells exactly one offer", async () => {
    mockFetch();

    const res = await request(app)
      .get(`/features/${SALES}/revenue?brandId=${BRAND}&groupBy=workflow&offerId=${OFFER_A}&campaignId=a1`)
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("mutually exclusive");
  });

  it("asks the producers for the OFFER's campaigns and for no others", async () => {
    const seen = recordingFetch();
    await grouped(`&offerId=${OFFER_A}`);

    const costCalls = seen.filter((u) => u.includes("/stats/costs"));
    expect(costCalls.length).toBeGreaterThan(0);
    // runs takes no campaign LIST, so a multi-member scope is co-grouped by campaign and folded here.
    for (const call of costCalls) {
      const q = new URL(call).searchParams;
      expect(q.get("campaignId")).toBeNull();
      expect((q.get("groupBy") ?? "").split(",")).toContain("campaignId");
    }
    // No campaign outside the offer is ever named on the wire.
    expect(seen.some((u) => u.includes("campaignId=b1") || u.includes("campaignId=n1"))).toBe(false);
  });

  it("honours ?pricing=net under an offer scope", async () => {
    mockFetch();

    const gross = await grouped(`&offerId=${OFFER_A}`);
    const net = await grouped(`&offerId=${OFFER_A}&pricing=net`);

    expect(gross.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(50);
    expect(net.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(25);
    // The volume half is a fact about people and does not move with the pricing basis.
    expect(net.byWorkflow.dawn.outcomes.recipientsContacted).toBe(3);
  });

  it("leaves the un-narrowed grouped read byte-identical", async () => {
    mockFetch();

    const before = await grouped("");
    const after = await grouped("");

    expect(after.body).toEqual(before.body);
    expect(before.body.campaignIdentity).toBeUndefined();
    expect(Object.keys(before.byWorkflow).sort()).toEqual(["dawn", "osprey"]);
  });
});
