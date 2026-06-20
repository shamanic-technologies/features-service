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
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const SALES_FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

// v2s 0.04, signupToPaidClient 0.50 → v2c 0.02 (consistent: visitToClose = v2s × signupToPaidClient)
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40, // r2m 0.4
  visitToMeetingPct: 5,  // v2m 0.05
  meetingToClosePct: 30, // m2c 0.3
  visitToClosePct: 2,    // v2c 0.02
  visitToSignupPct: 4,   // v2s 0.04
  signupToPaidClientPct: 50,
};

function wf(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "id", workflowSlug: "wf", workflowName: "WF", workflowDynastyName: "Dyn", workflowDynastySlug: "dyn", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null, ...over };
}
const WORKFLOWS = [
  wf({ id: "ida", workflowSlug: "wf-a", workflowDynastySlug: "dyn-a", workflowDynastyName: "Dynasty A" }),
  wf({ id: "idb", workflowSlug: "wf-b", workflowDynastySlug: "dyn-b", workflowDynastyName: "Dynasty B" }),
];
function costGroup(slug: string, cents: number, runCount = 10): Record<string, unknown> {
  return { dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
const COST_GROUPS = [costGroup("wf-a", 100000), costGroup("wf-b", 100000)];
function emailGroup(slug: string, clicked: number, repliesPositive: number, contacted = 200): Record<string, unknown> {
  return { key: slug, broadcast: { recipientStats: { contacted, sent: 200, delivered: 200, opened: 150, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } };
}
const EMAIL_GROUPS = [emailGroup("wf-a", 100, 50), emailGroup("wf-b", 50, 10)];

function mockFetch(opts: { workflows?: unknown[]; costGroups?: unknown[]; emailGroups?: unknown[]; economics?: unknown; source?: unknown } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("stats/public/costs")) {
      return new Response(JSON.stringify({ groups: opts.costGroups ?? COST_GROUPS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/public/workflows")) {
      return new Response(JSON.stringify({ workflows: opts.workflows ?? WORKFLOWS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/public/stats")) {
      return new Response(JSON.stringify({ groups: opts.emailGroups ?? EMAIL_GROUPS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS;
      const source = "source" in opts ? opts.source : economics == null ? null : "user";
      return new Response(JSON.stringify({ economics, source }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

const URL_BASE = "/features/sales-cold-email-outreach/candidates";
const byDynasty = (body: any, slug: string) => body.candidates.find((c: any) => c.workflow.workflowDynastySlug === slug);

describe("GET /features/:featureSlug/candidates", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing", async () => {
    const res = await request(app).get(`${URL_BASE}?goal=signup`).set(AUTH);
    expect(res.status).toBe(400);
  });

  it("400 when goal missing or invalid", async () => {
    mockFetch();
    const missing = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);
    expect(missing.status).toBe(400);
    const invalid = await request(app).get(`${URL_BASE}?brandId=b1&goal=growth`).set(AUTH);
    expect(invalid.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    mockFetch();
    const res = await request(app).get(`/features/unknown/candidates?brandId=b1&goal=signup`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it("returns the candidate SET (one per active workflow), NOT a collapsed winner", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.goal).toBe("purchase");
    expect(res.body.brandId).toBe("b1");
    expect(res.body.brandProfileId).toBeNull();
    expect(res.body.candidates).toHaveLength(2);
    // no pre-collapsed best
    expect(res.body.recommendedWorkflowDynastySlug).toBeUndefined();
    expect(res.body.best).toBeUndefined();
  });

  it("audience dimension is inert — every candidate carries audienceId null", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    expect(res.body.candidates.every((c: any) => c.audienceId === null)).toBe(true);
  });

  it("each candidate exposes its sample size (runs + outcome counts)", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.sampleSize).toEqual({ runs: 10, contacted: 200, clicks: 100, replies: 50 });
  });

  it("conversion and cost evidence are separate blocks", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    // cost = measured workflow unit costs (cross-org), conversion = brand economics — distinct
    expect(a.cost.clickUsd).toBeCloseTo(10, 6);
    expect(a.cost.replyUsd).toBeCloseTo(20, 6);
    expect(a.cost.costPerLeadUsd).toBeCloseTo(5, 6); // $1000 / 200 contacted
    expect(a.cost.grain).toBe("goal-global");
    expect(typeof a.conversion.rate).toBe("number");
  });

  it("goal=signup → cost per signup from the click route; conversion.rate = v2s", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=signup`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.costPerOutcomeUsd).toBeCloseTo(250, 3); // 1 / ((1/10)·0.04)
    expect(a.conversion.rate).toBeCloseTo(0.04, 6);
  });

  it("goal=purchase → cost per close matches the revenue engine (orP click route + reply route)", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.costPerOutcomeUsd).toBeCloseTo(105.5966, 3);
    expect(a.conversion.rate).toBeCloseTo(0.0347, 4); // orP(0.02, 0.05·0.30)
  });

  it("goal=meetingBooked → cost per meeting; conversion.rate = v2m", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.costPerOutcomeUsd).toBeCloseTo(40, 3); // 1 / ((1/10)·0.05 + (1/20)·0.40)
    expect(a.conversion.rate).toBeCloseTo(0.05, 6);
  });

  it("economics source 'user' → grain brand-goal", async () => {
    mockFetch({ economics: ECONOMICS, source: "user" });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.grain).toBe("brand-goal");
    expect(a.conversion.grain).toBe("brand-goal");
  });

  it("economics source 'cross-brand-average' → grain goal-global", async () => {
    mockFetch({ economics: ECONOMICS, source: "cross-brand-average" });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.grain).toBe("goal-global");
    expect(a.conversion.grain).toBe("goal-global");
  });

  it("cold start (economics null) → costPerOutcome + conversion.rate null, grain goal-global, cost evidence still present", async () => {
    mockFetch({ economics: null, source: null });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.costPerOutcomeUsd).toBeNull();
    expect(a.conversion.rate).toBeNull();
    expect(a.conversion.grain).toBeNull();
    expect(a.grain).toBe("goal-global");
    // measured cost evidence + sample size still present (no economics needed for those)
    expect(a.cost.clickUsd).toBeCloseTo(10, 6);
    expect(a.sampleSize.runs).toBe(10);
  });

  it("502 when a downstream source fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("stats/public/costs")) return new Response("boom", { status: 500 });
      if (url.includes("/public/workflows")) return new Response(JSON.stringify({ workflows: WORKFLOWS }), { status: 200 });
      if (url.includes("/public/stats")) return new Response(JSON.stringify({ groups: EMAIL_GROUPS }), { status: 200 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    expect(res.status).toBe(502);
  });
});
