/**
 * A LEG-KEYED LADDER COUNTS ONLY THE LEG'S CAMPAIGNS, AT EVERY GRAIN.
 *
 * Owner rule (2026-09-27): a workflow's figure is never its figure in the absolute, it is always its
 * figure on ONE LEG × ONE CHANNEL. Prod before the fix: `cerulean` read ~$167 per website visit on the
 * visit leg although every dollar and every click behind it came from conversation-leg campaigns.
 *
 * ONE fixture, shaped like that: two workflows on one channel, each run on ONE leg only —
 *   - `wf-cer` (cerulean) : conversation-leg campaigns only ($300 spent, 2 incidental clicks, 3 replies)
 *   - `wf-lyo` (lyonesse) : visit-leg campaigns only ($70 spent, 35 clicks)
 * across two orgs, plus a legacy leg-less campaign that belongs to no leg. Every case asserts the
 * DIVERGENCE between the leg-scoped answer and the channel-wide one, so a suite that only checked
 * "a number came back" would pass on the leaking implementation.
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
const brandRow = (body: any, dynasty: string) =>
  body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === dynasty);

describe("a leg-keyed ladder counts only the campaigns performing that leg", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    __resetLegFleetEvidence();
    requested.length = 0;
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("on the VISIT leg, a workflow that never REACHED anybody on it is NOT MEASURED — no borrowed price, no husk floor", async () => {
    const res = await get(`leg=${VISIT}`);
    expect(res.status).toBe(200);
    const cer = brandRow(res.body, "dyn-cer");
    expect(cer.measured).toBe(false);
    expect(cer.estimatesByGrain).toEqual({});
    expect(cer.resolved.grain).toBeNull();
    // Never recommended on evidence it does not have.
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-lyo");
  });

  it("on the VISIT leg, a visit workflow is priced from visit campaigns only — every org's, no legacy row", async () => {
    const res = await get(`leg=${VISIT}`);
    const lyo = brandRow(res.body, "dyn-lyo");
    // Fleet: $30 + $40 over 15 + 20 clicks — the $500 legacy leg-less campaign is in no leg.
    expect(lyo.estimatesByGrain.crossOrg.evidence.spentUsd).toBeCloseTo(70, 6);
    expect(lyo.estimatesByGrain.crossOrg.evidence.observedClicks).toBe(35);
    // Brand: its own visit campaign only.
    expect(lyo.estimatesByGrain.brand.evidence.spentUsd).toBeCloseTo(30, 6);
    expect(lyo.estimatesByGrain.brand.evidence.observedClicks).toBe(15);
  });

  it("on the CONVERSATION leg, the mirror image: cerulean priced on conversation campaigns, lyonesse unmeasured", async () => {
    const res = await get(`leg=${CONVERSATION}`);
    expect(res.status).toBe(200);
    const cer = brandRow(res.body, "dyn-cer");
    expect(cer.estimatesByGrain.crossOrg.evidence.spentUsd).toBeCloseTo(300, 6);
    expect(cer.estimatesByGrain.crossOrg.evidence.observedPositiveReplies).toBe(3);
    expect(cer.estimatesByGrain.brand.evidence.spentUsd).toBeCloseTo(100, 6);
    expect(brandRow(res.body, "dyn-lyo").measured).toBe(false);
  });

  it("the fleet reads are narrowed by the leg's campaign ids, never asked unfiltered", async () => {
    await get(`leg=${VISIT}`);
    const fleet = requested.filter((u) => u.includes("/v1/stats/public/costs") || u.includes("/public/stats?"));
    expect(fleet.length).toBeGreaterThan(0);
    for (const u of fleet) {
      const ids = new URL(u).searchParams.get("campaignIds") ?? new URL(u).searchParams.get("campaignId");
      expect(ids?.split(",").sort()).toEqual(["c-visit-other", "c-visit-own"]);
    }
  });

  it("a LEG-LESS read is unchanged: the channel's whole spend, legacy row and every leg included", async () => {
    const res = await get("goal=meetingBooked");
    expect(res.status).toBe(200);
    const cer = brandRow(res.body, "dyn-cer");
    const lyo = brandRow(res.body, "dyn-lyo");
    // Every leg's spend, the visit-leg husk's $0.47 included — the contact rule is a LEG rule only.
    expect(cer.estimatesByGrain.crossOrg.evidence.spentUsd).toBeCloseTo(300.47, 6);
    expect(cer.estimatesByGrain.crossOrg.evidence.observedClicks).toBe(2);
    expect(lyo.estimatesByGrain.crossOrg.evidence.spentUsd).toBeCloseTo(570, 6);
    expect(requested.some((u) => u.includes("/campaigns/list"))).toBe(false);
  });
});
