/**
 * THE ACTUAL-COST BASIS — the return curve of ONE workflow at brand grain with its spend leg read at
 * VENDOR cost, staff only (lib/actual-cost-history.ts).
 *
 * The fixture's vendor cost is one fifth of the billed committed spend on every row, except where a
 * case makes a row UNPRICED. So every case asserts a DIVERGENCE between the two bases: an
 * implementation that re-served the billed curve under the actual label would fail on the numbers.
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

/** The catalogue: two versions of ONE dynasty (`dawn`) beside a second dynasty (`osprey`). */
const WORKFLOWS = [
  { id: "w1", workflowSlug: "dawn-v1", workflowName: "Dawn v1", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 1, status: "inactive", featureSlug: SALES, createdForBrandId: null, upgradedTo: "w2" },
  { id: "w2", workflowSlug: "dawn-v2", workflowName: "Dawn v2", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 2, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
  { id: "w3", workflowSlug: "osprey-v1", workflowName: "Osprey v1", workflowDynastyName: "Osprey", workflowDynastySlug: "osprey", version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
];
const dynastyOf = (slug: string) => WORKFLOWS.find((w) => w.workflowSlug === slug)?.workflowDynastySlug ?? slug;

/**
 * ONE campaign IDENTITY of two rows (the live one and the ancestor it switched away from), beside a
 * SECOND campaign on another channel. campaign-service's key is (org, brand, offer, leg, channel), so
 * `other` is a different campaign — and it is what makes the brand's numbers diverge from this one's.
 */
const CAMPAIGNS = [
  { id: "stopped", orgId: "org-1", brandId: BRAND, featureSlug: SALES, legKey: "start_to_conversation", acquisitionChannel: SALES, status: "stopped", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "live", orgId: "org-1", brandId: BRAND, featureSlug: SALES, legKey: "start_to_conversation", acquisitionChannel: SALES, status: "ongoing", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "other", orgId: "org-1", brandId: BRAND, featureSlug: SALES, legKey: "start_to_conversation", acquisitionChannel: "crm_email", status: "ongoing", createdAt: "2026-02-01T00:00:00.000Z" },
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
  { campaignId: "live", workflowSlug: "dawn-v2", committed: 4000, actual: 3000 },
  { campaignId: "stopped", workflowSlug: "dawn-v1", committed: 1000, actual: 1000 },
  { campaignId: "live", workflowSlug: "osprey-v1", committed: 2000, actual: 2000 },
  // The OTHER campaign, on the SAME dynasty: the brand grain is dominated by it, so a per-workflow
  // group that ignored the campaign scope reads 13000¢ where this campaign spent 5000¢.
  { campaignId: "other", workflowSlug: "dawn-v2", committed: 8000, actual: 8000 },
  // A RETIRED lineage — real spend and a real lead under a slug workflow-service no longer
  // describes. It is its own dynasty of one, and it is exactly the workflow a "which of these
  // burned money" question is about.
  { campaignId: "live", workflowSlug: "retired-v1", committed: 700, actual: 700 },
];

const LEADS = [
  lead("live", "dawn-v2", "l1", { positive: true }),
  lead("live", "dawn-v2", "l2"),
  lead("stopped", "dawn-v1", "l3", { positive: true }),
  lead("live", "osprey-v1", "l4", { clicked: true }),
  lead("other", "dawn-v2", "o1", { positive: true }),
  lead("other", "dawn-v2", "o2", { positive: true }),
  lead("other", "dawn-v2", "o3", { positive: true }),
  lead("live", "retired-v1", "r1", { positive: true }),
];

interface Options {
  /** `false` = workflow-service unreachable (the fail-loud case for `?workflow=`). */
  catalogue?: boolean;
  /** NET cents per (campaign, slug) — half the gross here, so a net read cannot pass as gross. */
  net?: boolean;
  /** Days whose rows have NO known vendor cost (runs states their billed amount as unpriced). */
  unpricedDays?: string[];
}

/**
 * Emulates the producers' OWN filtering, so the assertions are about this service's requests rather
 * than about a fixture that hands back whatever is convenient: runs applies `campaignId` /
 * `workflowDynastySlug` / `groupBy`, lead-service applies `campaignId`, email-gateway applies both.
 */
type FetchImpl = (input: unknown, init?: unknown) => Promise<Response>;

function mockFetch(options: Options = {}): FetchImpl {
  const catalogue = options.catalogue !== false;
  const impl: FetchImpl = async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.pathname.includes("/public/workflows")) {
      if (!catalogue) return new Response("workflow-service down", { status: 503 });
      return json({ workflows: WORKFLOWS });
    }
    if (url.pathname.endsWith("/campaigns")) return json({ campaigns: CAMPAIGNS });
    // The funnel its campaigns read is ONE chain — so the funnel walk has one to state.
    // Wave C1: the brand states where its replies go (a meeting) — at the brand-wide value, so every
    // term still falls through unchanged — and sells one offer.
    if (url.pathname.includes("/offer-economics")) {
      return json({
        legRates: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct: ECONOMICS.replyToMeetingPct, stated: true, statedAt: "x" }],
        offers: [{ offerId: "offer-1", name: "Offer", lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null }],
      });
    }
    if (url.pathname.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    // The producers filter on the VERSIONED slugs the caller resolved — `workflowSlugs`. The dynasty
    // lever exists on both, and this service deliberately does not use it (see workflow-scope.ts).
    const rowsFor = () => {
      const campaignId = q.get("campaignId");
      const slugs = q.get("workflowSlugs")?.split(",");
      return COSTS.filter(
        (c) => (!campaignId || c.campaignId === campaignId) && (!slugs || slugs.includes(c.workflowSlug)),
      );
    };
    const cents = (n: number) => String(options.net ? n / 2 : n);

    if (url.pathname.includes("/internal/stats/costs/timeseries/vendor")) {
      const dynasty = q.get("workflowDynastySlug");
      const campaignId = q.get("campaignId");
      const total = COSTS.filter(
        (c) => (!campaignId || c.campaignId === campaignId) && (!dynasty || dynastyOf(c.workflowSlug) === dynasty),
      ).reduce((sum, c) => sum + c.committed, 0);
      // runs bounds by startedAfter: the fixture's one day predates any maturity cutoff.
      if (q.get("startedAfter") && q.get("startedAfter")! > "2026-02-01") return json({ interval: "day", timezone: "UTC", buckets: [] });
      const unpriced = options.unpricedDays?.includes("2026-02-01") ?? false;
      return json({
        interval: "day",
        timezone: "UTC",
        buckets: [{
          period: "2026-02-01",
          totalCostInUsdCents: String(total),
          vendorTotalCostInUsdCents: unpriced ? "0" : String(total / 5),
          unpricedTotalCostInUsdCents: unpriced ? String(total) : "0",
          vendorRefundedCostInUsdCents: "0",
          unpricedRefundedCostInUsdCents: "0",
          unpricedCostNames: unpriced ? ["instantly-account-email-sent"] : [],
          runCount: 1,
        }],
      });
    }
    if (url.pathname.includes("/stats/public/costs/timeseries")) {
      // The ONE leg with no slug filter. It resolves the dynasty through workflow-service, which 404s
      // for one it does not describe — reproduced here so the fail-soft degrade is exercised.
      const dynasty = q.get("workflowDynastySlug");
      if (dynasty && !WORKFLOWS.some((w) => w.workflowDynastySlug === dynasty)) {
        return new Response(JSON.stringify({ error: `No workflows found for workflowDynastySlug: ${dynasty}` }), { status: 500 });
      }
      const campaignId = q.get("campaignId");
      const total = COSTS.filter(
        (c) => (!campaignId || c.campaignId === campaignId) && (!dynasty || dynastyOf(c.workflowSlug) === dynasty),
      ).reduce((sum, c) => sum + c.committed, 0);
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
      const groupBy = (q.get("groupBy") ?? "").split(",");
      const groups = rowsFor().map((c) => {
        const dimensions: Record<string, string> = {};
        if (groupBy.includes("workflowSlug")) dimensions.workflowSlug = c.workflowSlug;
        if (groupBy.includes("campaignId")) dimensions.campaignId = c.campaignId;
        if (groupBy.includes("costName")) dimensions.costName = "email-send";
        return {
          dimensions,
          totalCostInUsdCents: cents(c.committed),
          actualCostInUsdCents: cents(c.actual),
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
      const slugs = q.get("workflowSlugs")?.split(",");
      const contacted = LEADS.filter(
        (l) => (!campaignId || l.campaignId === campaignId) && (!slugs || slugs.includes(String(l.workflowSlug))),
      ).length;
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

beforeEach(() => {
  vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as never);
});
afterEach(() => vi.restoreAllMocks());

const ACTUAL = `/internal/features/${SALES}/revenue/actual-cost?brandId=${BRAND}`;

describe("GET /internal/features/:slug/revenue/actual-cost — the return curve at vendor cost", () => {
  it("draws the SAME value leg as the billed curve, over the vendor cost, which reads lower by the markup", async () => {
    const seen = recordingFetch();
    const billed = await request(app).get(`/features/${SALES}/revenue?brandId=${BRAND}&workflow=dawn`).set(AUTH);
    const actual = await request(app).get(`${ACTUAL}&workflow=dawn`).set(AUTH);

    expect(actual.status).toBe(200);
    expect(actual.body.costBasis).toBe("actual");
    expect(actual.body.workflow.workflowDynastySlug).toBe("dawn");
    const a = actual.body.actualCostHistory;
    const b = billed.body.roiHistory;
    // Billed: 4000 + 1000 + 8000 committed cents on dawn = $130. Vendor: a fifth = $26.
    expect(b.daily.at(-1).cumulativeSpendUsd).toBeCloseTo(130, 6);
    expect(a.daily.at(-1).cumulativeSpendUsd).toBeCloseTo(26, 6);
    expect(a.daily.map((p: { cumulativePipelineUsd: number }) => p.cumulativePipelineUsd)).toEqual(
      b.daily.map((p: { cumulativePipelineUsd: number }) => p.cumulativePipelineUsd),
    );
    expect(a.daily.at(-1).roiMultiple).toBeCloseTo(b.daily.at(-1).roiMultiple * 5, 6);
    expect(a.unpricedBilledCostUsd).toBe(0);
    expect(a.unpricedFromDate).toBeNull();
    // The vendor read is the SERVICE-AUTH route, narrowed by the same dynasty.
    const vendorCall = seen.find((u) => u.includes("/internal/stats/costs/timeseries/vendor"));
    expect(vendorCall).toContain("workflowDynastySlug=dawn");
    expect(vendorCall).toContain("orgId=org-1");
  });

  it("an unpriced day reads NULL spend and return, and names the billed amount — never the billed figure", async () => {
    mockFetch({ unpricedDays: ["2026-02-01"] });
    const res = await request(app).get(`${ACTUAL}&workflow=dawn`).set(AUTH);
    const a = res.body.actualCostHistory;
    expect(a.unpricedFromDate).toBe("2026-02-01");
    expect(a.unpricedBilledCostUsd).toBeCloseTo(130, 6);
    expect(a.daily.length).toBeGreaterThan(0);
    expect(a.daily.every((p: { cumulativeSpendUsd: number | null }) => p.cumulativeSpendUsd === null)).toBe(true);
    expect(a.daily.every((p: { roiMultiple: number | null }) => p.roiMultiple === null)).toBe(true);
    expect(a.unpricedCostNames).toEqual(["instantly-account-email-sent"]);
    expect(a.daily.at(-1).cumulativeUnpricedBilledCostUsd).toBeCloseTo(130, 6);
    expect(a.daily.at(-1).cumulativePricedVendorCostUsd).toBe(0);
  });

  it("refuses a grouping, a lens or a pricing selector on this basis", async () => {
    mockFetch();
    for (const q of ["&groupBy=workflow", "&lens=signups", "&pricing=net"]) {
      const res = await request(app).get(`${ACTUAL}${q}`).set(AUTH);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("not_on_actual_cost_basis");
    }
  });
});

describe("the CUSTOMER read can never answer on the actual basis", () => {
  it("is byte-identical with or without an actual-basis parameter, and never reads the vendor route", async () => {
    const seen = recordingFetch();
    const plain = await request(app).get(`/features/${SALES}/revenue?brandId=${BRAND}&workflow=dawn`).set(AUTH);
    const probing = await request(app)
      .get(`/features/${SALES}/revenue?brandId=${BRAND}&workflow=dawn&costBasis=actual&basis=actual&actualCost=true`)
      .set(AUTH);
    expect(probing.status).toBe(200);
    expect(probing.body).toEqual(plain.body);
    expect(plain.body.costBasis).toBe("charged");
    expect(JSON.stringify(plain.body)).not.toContain("actualCostHistory");
    expect(seen.some((u) => u.includes("/timeseries/vendor"))).toBe(false);
  });
});
