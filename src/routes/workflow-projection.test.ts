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

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40, // r2m 0.4
  visitToMeetingPct: 5,  // v2m 0.05
  meetingToClosePct: 30, // m2c 0.3
  visitToClosePct: 2,    // v2c 0.02
};

// Two dynasties. wf-a: $1000 cost / 100 clicks / 50 replies → clickUsd 10, replyUsd 20.
//                wf-b: $1000 cost / 50 clicks / 10 replies  → clickUsd 20, replyUsd 100.
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
function emailGroup(slug: string, clicked: number, repliesPositive: number): Record<string, unknown> {
  return { key: slug, broadcast: { recipientStats: { contacted: 200, sent: 200, delivered: 200, opened: 150, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } };
}
const EMAIL_GROUPS = [emailGroup("wf-a", 100, 50), emailGroup("wf-b", 50, 10)];

function mockFetch(opts: { workflows?: unknown[]; costGroups?: unknown[]; emailGroups?: unknown[]; economics?: unknown } = {}): void {
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
    if (url.includes("/sales-economics")) {
      const salesEconomics = "economics" in opts ? opts.economics : ECONOMICS; // distinguish explicit null
      return new Response(JSON.stringify({ salesEconomics }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";
const byDynasty = (body: any, slug: string) => body.workflows.find((w: any) => w.workflowDynastySlug === slug);

describe("GET /features/:featureSlug/workflow-projection", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing", async () => {
    const res = await request(app).get(`${URL_BASE}?objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(400);
  });

  it("400 when objective missing or invalid", async () => {
    mockFetch();
    const missing = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);
    expect(missing.status).toBe(400);
    const invalid = await request(app).get(`${URL_BASE}?brandId=b1&objective=growth`).set(AUTH);
    expect(invalid.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    mockFetch();
    const res = await request(app).get(`/features/unknown/workflow-projection?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it("meeting-booked, no budget → per-workflow unit costs + cost-per-close, projection null, recommends cheapest", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("meeting-booked");
    expect(res.body.workflows).toHaveLength(2);

    const a = byDynasty(res.body, "dyn-a");
    expect(a.workflowDynastyName).toBe("Dynasty A");
    expect(a.replyUsd).toBeCloseTo(20, 6);  // $1000 / 50 replies
    expect(a.clickUsd).toBeCloseTo(10, 6);  // $1000 / 100 clicks
    // closesPerBudget = 0.3·((1/20)·0.4 + (1/10)·0.05) = 0.3·0.025 = 0.0075 → cpc = 133.33
    expect(a.costPerCloseUsd).toBeCloseTo(133.3333, 3);
    expect(a.projection).toBeNull(); // no budget

    const b = byDynasty(res.body, "dyn-b");
    expect(b.costPerCloseUsd).toBeCloseTo(512.8205, 3); // 1/(0.3·0.0065)

    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a"); // lower cpc
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(1333.333, 2); // 10 × 133.33
  });

  it("meeting-booked with budget → full projection block", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.projection.replies).toBeCloseTo(50, 6);   // 1000/20
    expect(a.projection.visits).toBeCloseTo(100, 6);   // 1000/10
    expect(a.projection.meetings).toBeCloseTo(25, 6);  // 50·0.4 + 100·0.05
    expect(a.projection.closes).toBeCloseTo(7.5, 6);   // 1000·0.0075
    expect(a.projection.revenue).toBeCloseTo(7500, 4); // 7.5·1000
    expect(a.projection.cacPct).toBeCloseTo(13.3333, 3); // 1000/7500·100
    expect(a.projection.cacAbs).toBeCloseTo(133.3333, 3); // 1000/7.5
  });

  it("self-serve → replies/meetings null, click→v2c path, recommends cheapest", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=self-serve&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    // closesPerBudget = (1/10)·0.02 = 0.002 → cpc 500
    expect(a.costPerCloseUsd).toBeCloseTo(500, 6);
    expect(a.projection.replies).toBeNull();
    expect(a.projection.meetings).toBeNull();
    expect(a.projection.visits).toBeCloseTo(100, 6); // 1000/10
    expect(a.projection.closes).toBeCloseTo(2, 6);   // 1000·0.002
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a");
  });

  it("no brand economics → unit costs present, cost-per-close + projection + recommendation null", async () => {
    mockFetch({ economics: null });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.replyUsd).toBeCloseTo(20, 6);   // unit costs still computed
    expect(a.clickUsd).toBeCloseTo(10, 6);
    expect(a.costPerCloseUsd).toBeNull();
    expect(a.projection).toBeNull();
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendedBudgetUsd).toBeNull();
  });

  it("workflow with no replies → replyUsd null, click route still funds closes", async () => {
    mockFetch({ emailGroups: [emailGroup("wf-a", 100, 0)] }); // 0 positive replies
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.replyUsd).toBeNull();
    expect(a.clickUsd).toBeCloseTo(10, 6);
    // closesPerBudget = 0.3·((1/10)·0.05) = 0.0015 → cpc ≈ 666.67 (reply route contributes 0)
    expect(a.costPerCloseUsd).toBeCloseTo(666.6667, 3);
  });

  it("502 when a downstream source fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("stats/public/costs")) return new Response("boom", { status: 500 });
      if (url.includes("/public/workflows")) return new Response(JSON.stringify({ workflows: WORKFLOWS }), { status: 200 });
      if (url.includes("/public/stats")) return new Response(JSON.stringify({ groups: EMAIL_GROUPS }), { status: 200 });
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(502);
  });
});
