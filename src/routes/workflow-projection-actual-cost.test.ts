/**
 * THE LADDER ON ACTUAL COST — `/internal/features/:slug/workflow-projection/actual-cost`, staff only
 * (lib/actual-cost-projection.ts). The fixture's vendor cost is one fifth of the billed spend on every
 * row, except where a case makes a workflow's rows UNPRICED. So every case asserts a DIVERGENCE between
 * the two bases (an implementation re-serving the billed ladder under the actual label fails on the
 * numbers), and that the ORDER is the billed one whatever the vendor figures say.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { offerEconomicsFromDeclared } from "../lib/leg-economics-fixture.js";

vi.unmock("../lib/leg-fleet-evidence.js");
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
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(async () => []),
  // The mature cut's person read (lib/maturity.ts). The fleet person cell is mocked to "cannot be cut"
  // suite-wide (src/vitest.setup.ts), so these flash-figure suites read exactly what they always did.
  fetchScopePersons: vi.fn(async () => []),
}));
// Which Gold cells a read asks for (the cache itself is off in this suite: compute runs through).
const cellViews = vi.hoisted(() => [] as string[]);
vi.mock("../lib/view-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/view-cache.js")>();
  return {
    ...actual,
    servedCached: vi.fn((args: Parameters<typeof actual.servedCached>[0]) => {
      cellViews.push(args.view);
      return actual.servedCached(args);
    }),
  };
});
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
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const { __resetLegFleetEvidence } = await import("../lib/leg-fleet-evidence.js");
const app = (await import("../index.js")).default;

const ORG = "org-1";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OTHER_BRAND = "b2";
const AUTH = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const SLUG = "sales-cold-email-outreach";
const URL_BASE = `/features/${SLUG}/workflow-projection`;
const ACTUAL_BASE = `/internal/features/${SLUG}/workflow-projection/actual-cost`;
const VISIT = "start_to_website_visit";
const CONVERSATION = "start_to_conversation";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 50,
  visitToMeetingPct: 50,
  meetingToClosePct: 40,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const FUNNEL = (funnelKey: string, steps: string[]) => ({
  funnelKey,
  name: funnelKey,
  steps,
  rates: { replyToMeetingPct: 50, visitToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-27T00:00:00.000Z",
});
const FUNNELS = [
  FUNNEL("sales_meetings_from_conversation", ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]),
  FUNNEL("sales_meetings_from_website", ["Website visit", "Meeting booked", "Meeting attended", "Paid client"]),
];

const wf = (slug: string, dynasty: string) => ({
  id: slug, workflowSlug: slug, workflowName: slug, workflowDynastyName: dynasty, workflowDynastySlug: dynasty,
  version: 1, status: "active", featureSlug: SLUG, createdForBrandId: null, upgradedTo: null,
});
const WORKFLOWS = [wf("wf-cer", "dyn-cer"), wf("wf-lyo", "dyn-lyo")];

/** Campaign rows as campaign-service lists them — every org's. */
const CAMPAIGNS = [
  { id: "c-conv-own", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: CONVERSATION },
  { id: "c-conv-other", orgId: "org-2", brandIds: [OTHER_BRAND], featureSlug: SLUG, legKey: CONVERSATION },
  { id: "c-visit-own", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: VISIT },
  { id: "c-visit-other", orgId: "org-2", brandIds: [OTHER_BRAND], featureSlug: SLUG, legKey: VISIT },
  { id: "c-legacy", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: null },
];

/** The ledger: one row per (campaign, workflow slug) — what runs and email-gateway each hold. */
const LEDGER = [
  { campaignId: "c-conv-own", orgId: ORG, brandId: BRAND, slug: "wf-cer", cents: 10000, contacted: 400, clicks: 1, replies: 2 },
  { campaignId: "c-conv-other", orgId: "org-2", brandId: OTHER_BRAND, slug: "wf-cer", cents: 20000, contacted: 600, clicks: 1, replies: 1 },
  { campaignId: "c-visit-own", orgId: ORG, brandId: BRAND, slug: "wf-lyo", cents: 3000, contacted: 300, clicks: 15, replies: 0 },
  { campaignId: "c-visit-other", orgId: "org-2", brandId: OTHER_BRAND, slug: "wf-lyo", cents: 4000, contacted: 300, clicks: 20, replies: 0 },
  // Cerulean TRIED the visit leg once: discovery + enrichment spend, nobody contacted. That is not a
  // measurement on the leg — without the contact rule it would floor to $0.47 and top the leg.
  { campaignId: "c-visit-other", orgId: "org-2", brandId: OTHER_BRAND, slug: "wf-cer", cents: 47, contacted: 0, clicks: 0, replies: 0 },
  // A legacy leg-less campaign: counted by a leg-less read, by no leg.
  { campaignId: "c-legacy", orgId: ORG, brandId: BRAND, slug: "wf-lyo", cents: 50000, contacted: 100, clicks: 0, replies: 0 },
];

const requested: string[] = [];
/** Versioned slugs whose rows have NO known vendor cost on the vendor read. */
let unpricedSlugs = new Set<string>();

function select(u: URL, headers: Record<string, string>, isPublic: boolean) {
  const one = u.searchParams.get("campaignId");
  const many = u.searchParams.get("campaignIds");
  const ids = one ? new Set([one]) : many ? new Set(many.split(",")) : null;
  const brand = u.searchParams.get("brandId");
  if (u.searchParams.get("audienceId") || (u.searchParams.get("groupBy") ?? "").startsWith("audienceId")) return [];
  return LEDGER.filter(
    (r) => (!ids || ids.has(r.campaignId)) && (isPublic || r.orgId === headers["x-org-id"]) && (!brand || r.brandId === brand),
  );
}

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requested.push(url);
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/campaigns/list")) return json({ campaigns: CAMPAIGNS });
    if (url.includes("/internal/stats/costs/vendor")) {
      if (u.searchParams.get("campaignId")) throw new Error("the vendor read takes campaignIds only");
      // No x-org-id = the whole fleet, like the producer.
      const rows = select(u, headers, !headers["x-org-id"]);
      const byCampaign = (u.searchParams.get("groupBy") ?? "").includes("campaignId");
      const groups = new Map<string, any>();
      for (const r of rows) {
        const key = byCampaign ? `${r.slug}|${r.campaignId}` : r.slug;
        const g = groups.get(key) ?? {
          dimensions: byCampaign ? { workflowSlug: r.slug, campaignId: r.campaignId } : { workflowSlug: r.slug },
          totalCostInUsdCents: 0, vendorTotalCostInUsdCents: 0, vendorRefundedCostInUsdCents: 0,
          unpricedTotalCostInUsdCents: 0, unpricedRefundedCostInUsdCents: 0, unpricedCostNames: [],
        };
        g.totalCostInUsdCents += r.cents;
        if (unpricedSlugs.has(r.slug)) g.unpricedTotalCostInUsdCents += r.cents;
        else g.vendorTotalCostInUsdCents += r.cents / 5;
        groups.set(key, g);
      }
      return json({
        groups: [...groups.values()].map((g) => ({
          ...g,
          totalCostInUsdCents: String(g.totalCostInUsdCents),
          vendorTotalCostInUsdCents: String(g.vendorTotalCostInUsdCents),
          vendorRefundedCostInUsdCents: "0",
          unpricedTotalCostInUsdCents: String(g.unpricedTotalCostInUsdCents),
          unpricedRefundedCostInUsdCents: "0",
        })),
      });
    }
    if (url.includes("/v1/stats/public/costs") || url.includes("/v1/stats/costs")) {
      const rows = select(u, headers, url.includes("/public/"));
      const byCampaign = (u.searchParams.get("groupBy") ?? "").includes("campaignId");
      const groups = new Map<string, any>();
      for (const r of rows) {
        const key = byCampaign ? `${r.slug}|${r.campaignId}` : r.slug;
        const g = groups.get(key) ?? {
          dimensions: byCampaign ? { workflowSlug: r.slug, campaignId: r.campaignId } : { workflowSlug: r.slug },
          totalCostInUsdCents: "0", netTotalCostInUsdCents: "0", runCount: 0, minStartedAt: null, maxStartedAt: null,
        };
        g.totalCostInUsdCents = String(Number(g.totalCostInUsdCents) + r.cents);
        g.netTotalCostInUsdCents = g.totalCostInUsdCents;
        g.runCount += 1;
        groups.set(key, g);
      }
      return json({ groups: [...groups.values()] });
    }
    if (url.includes("/orgs/stats") || url.includes("/public/stats")) {
      const rows = select(u, headers, url.includes("/public/"));
      const groups = new Map<string, any>();
      for (const r of rows) {
        const g = groups.get(r.slug) ?? { key: r.slug, broadcast: { recipientStats: { contacted: 0, clicked: 0, repliesPositive: 0 } } };
        g.broadcast.recipientStats.contacted += r.contacted;
        g.broadcast.recipientStats.clicked += r.clicks;
        g.broadcast.recipientStats.repliesPositive += r.replies;
        groups.set(r.slug, g);
      }
      return json({ groups: [...groups.values()] });
    }
    if (url.includes("/offer-economics")) return json(offerEconomicsFromDeclared(FUNNELS));
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    // One active audience: the brand can be served, so an unproven workflow is enumerated (explore).
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: "aud-1", name: "A", status: "active", filters: {}, availableToContactCount: 10 }] });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
const getActual = (query: string) => request(app).get(`${ACTUAL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
const brandRow = (body: any, dynasty: string) =>
  body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === dynasty);

describe("GET /internal/features/:slug/workflow-projection/actual-cost — the ladder at vendor cost", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    __resetLegFleetEvidence();
    requested.length = 0;
    unpricedSlugs = new Set();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("every money figure reads a FIFTH of the billed one, at every grain, and the ORDER is the billed one", async () => {
    const billed = await get(`leg=${VISIT}`);
    const actual = await getActual(`leg=${VISIT}`);
    expect(billed.status).toBe(200);
    expect(actual.status).toBe(200);
    expect(actual.body.costBasis).toBe("actual");

    const b = brandRow(billed.body, "dyn-lyo");
    const a = brandRow(actual.body, "dyn-lyo");
    // Brand grain on the visit leg: $30 billed → $6 at vendor cost.
    expect(b.estimatesByGrain.brand.evidence.spentUsd).toBeCloseTo(30, 6);
    expect(a.estimatesByGrain.brand.evidence.spentUsd).toBeCloseTo(6, 6);
    expect(a.estimatesByGrain.crossOrg.evidence.spentUsd).toBeCloseTo(b.estimatesByGrain.crossOrg.evidence.spentUsd / 5, 6);
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(b.resolved.costPerOutcomeUsd / 5, 6);
    expect(a.resolved.costPerClickUsd).toBeCloseTo(b.resolved.costPerClickUsd / 5, 6);
    expect(a.resolved.vendorCostKnown).toBe(true);
    expect(a.estimatesByGrain.brand.vendorCost).toEqual({ pricedVendorCostUsd: 6, unpricedBilledCostUsd: 0, vendorCostKnown: true });
    // Counts are the billed ones: same rows, same outcomes.
    expect(a.estimatesByGrain.brand.evidence.observedClicks).toBe(b.estimatesByGrain.brand.evidence.observedClicks);
    // The held prices ride the vendor read too: the brand's own price at a fifth, provenance kept.
    expect(a.priceByGrain.brand.flash).toMatchObject({ source: "own", fromGrain: "brand", vendorCostKnown: true });
    expect(a.priceByGrain.brand.flash.costPerOutcomeUsd).toBeCloseTo(b.priceByGrain.brand.flash.costPerOutcomeUsd / 5, 6);
    expect(a.priceByGrain.crossOrg.flash.costPerOutcomeUsd).toBeCloseTo(b.priceByGrain.crossOrg.flash.costPerOutcomeUsd / 5, 6);

    // The ORDER is what campaign-service acts on: byte the billed one.
    const order = (body: any) => body.rows.map((r: any) => [r.audienceId, r.workflow.workflowDynastySlug, r.rank, r.scopeRank]);
    expect(order(actual.body)).toEqual(order(billed.body));
    expect(actual.body.recommendedWorkflowDynastySlug).toBe(billed.body.recommendedWorkflowDynastySlug);
    // A budget recommendation is a billed, customer-facing figure.
    expect(actual.body.recommendedBudgetUsd).toBeNull();
    expect(actual.body.unpricedBilledCostUsd).toBe(0);
    // The vendor evidence came from the service-auth aggregation, fleet AND brand, never the public one.
    const vendorCalls = requested.filter((r) => r.includes("/internal/stats/costs/vendor"));
    expect(vendorCalls.length).toBeGreaterThan(0);
  });

  it("a workflow whose spend has no known vendor cost reads NULL money and names what it could not price", async () => {
    unpricedSlugs = new Set(["wf-lyo"]);
    const res = await getActual(`leg=${VISIT}`);
    expect(res.status).toBe(200);
    const lyo = brandRow(res.body, "dyn-lyo");
    expect(lyo.resolved.costPerOutcomeUsd).toBeNull();
    expect(lyo.resolved.costPerClickUsd).toBeNull();
    expect(lyo.resolved.roiMultiple).toBeNull();
    expect(lyo.resolved.vendorCostKnown).toBe(false);
    expect(lyo.estimatesByGrain.brand.evidence.spentUsd).toBeNull();
    expect(lyo.estimatesByGrain.brand.vendorCost).toEqual({ pricedVendorCostUsd: 0, unpricedBilledCostUsd: 30, vendorCostKnown: false });
    // Its counts are still stated.
    expect(lyo.estimatesByGrain.brand.evidence.observedClicks).toBe(15);
    // Its held price names where it would come from and why it reads null — never the billed figure.
    expect(lyo.priceByGrain.brand.flash).toEqual({
      costPerOutcomeUsd: null, source: "own", fromGrain: "brand", unpricedReason: "vendor_cost_unknown", vendorCostKnown: false,
    });
    expect(res.body.unpricedBilledCostUsd).toBeGreaterThan(0);
  });

  it("reads its three evidence versions as ONE cell, so the billed counts and the vendor money are one age", async () => {
    cellViews.length = 0;
    const res = await getActual(`leg=${VISIT}`);
    expect(res.status).toBe(200);
    const evidenceCells = cellViews.filter((v) => v.startsWith("workflow-projection-evidence"));
    expect(evidenceCells).toEqual(["workflow-projection-evidence-actual"]);
    // The billed read keeps its own single cell.
    cellViews.length = 0;
    await get(`leg=${VISIT}`);
    expect(cellViews.filter((v) => v.startsWith("workflow-projection-evidence"))).toEqual(["workflow-projection-evidence"]);
  });

  it("refuses a pricing selector on this basis", async () => {
    const res = await getActual(`leg=${VISIT}&pricing=net`);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("not_on_actual_cost_basis");
  });
});

describe("the CUSTOMER ladder can never answer on the actual basis", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    __resetLegFleetEvidence();
    requested.length = 0;
    unpricedSlugs = new Set();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("is byte-identical with or without an actual-basis parameter, and never reads the vendor aggregation", async () => {
    const plain = await get(`leg=${VISIT}`);
    const probing = await get(`leg=${VISIT}&costBasis=actual&basis=actual&actualCost=true`);
    expect(probing.status).toBe(200);
    expect(probing.body).toEqual(plain.body);
    expect(JSON.stringify(plain.body)).not.toContain("vendorCost");
    expect(requested.some((r) => r.includes("/internal/stats/costs/vendor"))).toBe(false);
    const vendorPricing = await get(`leg=${VISIT}&pricing=vendor`);
    expect(vendorPricing.status).toBe(400);
  });
});
