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

  it("objective optional — missing or invalid → 200, echoed objective defaults to meeting-booked", async () => {
    mockFetch();
    const missing = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);
    expect(missing.status).toBe(200);
    expect(missing.body.objective).toBe("meeting-booked");
    const invalid = await request(app).get(`${URL_BASE}?brandId=b1&objective=growth`).set(AUTH);
    expect(invalid.status).toBe(200);
    expect(invalid.body.objective).toBe("meeting-booked");
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    mockFetch();
    const res = await request(app).get(`/features/unknown/workflow-projection?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it("no budget → per-workflow unit costs + cost-per-close, projection null, recommends cheapest", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("meeting-booked");
    expect(res.body.workflows).toHaveLength(2);

    const a = byDynasty(res.body, "dyn-a");
    expect(a.workflowDynastyName).toBe("Dynasty A");
    expect(a.replyUsd).toBeCloseTo(20, 6);  // $1000 / 50 replies
    expect(a.clickUsd).toBeCloseTo(10, 6);  // $1000 / 100 clicks
    // pCloseClick=orP(0.02,0.05·0.30)=0.0347, pCloseReply=0.40·0.30=0.12
    // closesPerBudget = (1/10)·0.0347 + (1/20)·0.12 = 0.00347 + 0.006 = 0.00947 → cpc = 105.5966
    expect(a.costPerCloseUsd).toBeCloseTo(105.5966, 3);
    expect(a.projection).toBeNull(); // no budget

    const b = byDynasty(res.body, "dyn-b");
    // closesPerBudget = (1/20)·0.0347 + (1/100)·0.12 = 0.001735 + 0.0012 = 0.002935 → cpc = 340.7155
    expect(b.costPerCloseUsd).toBeCloseTo(340.7155, 3);

    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a"); // lower cpc
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(1055.966, 2); // 10 × 105.5966
  });

  it("with budget → full projection block", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.projection.replies).toBeCloseTo(50, 6);    // 1000/20
    expect(a.projection.visits).toBeCloseTo(100, 6);    // 1000/10
    expect(a.projection.meetings).toBeCloseTo(25, 6);   // 50·0.4 + 100·0.05 (both routes)
    expect(a.projection.closes).toBeCloseTo(9.47, 6);   // 1000·0.00947
    expect(a.projection.revenue).toBeCloseTo(9470, 4);  // 9.47·1000
    expect(a.projection.cacPct).toBeCloseTo(10.5597, 3); // 1000/9470·100
    expect(a.projection.cacAbs).toBeCloseTo(105.5966, 3); // 1000/9.47
  });

  it("objective-agnostic — missing / meeting-booked / self-serve give the SAME ranking + projection", async () => {
    mockFetch();
    const none = await request(app).get(`${URL_BASE}?brandId=b1&budgetUsd=1000`).set(AUTH);
    const meeting = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    const self = await request(app).get(`${URL_BASE}?brandId=b1&objective=self-serve&budgetUsd=1000`).set(AUTH);
    expect(none.status).toBe(200);
    expect(meeting.status).toBe(200);
    expect(self.status).toBe(200);
    // objective no longer gates the math → identical workflows + recommendation regardless of objective
    expect(none.body.workflows).toEqual(meeting.body.workflows);
    expect(self.body.workflows).toEqual(meeting.body.workflows);
    expect(self.body.recommendedWorkflowDynastySlug).toBe(meeting.body.recommendedWorkflowDynastySlug);
    // both routes (click + reply) feed meetings now — non-null even under the former "self-serve"
    const selfA = byDynasty(self.body, "dyn-a");
    expect(selfA.projection.replies).toBeCloseTo(50, 6);
    expect(selfA.projection.meetings).toBeCloseTo(25, 6);
    // objective is still echoed for back-compat: default meeting-booked when absent/invalid
    expect(none.body.objective).toBe("meeting-booked");
    expect(self.body.objective).toBe("self-serve");
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
    // closesPerBudget = (1/10)·0.0347 = 0.00347 → cpc ≈ 288.18 (reply route contributes 0)
    expect(a.costPerCloseUsd).toBeCloseTo(288.1844, 3);
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
