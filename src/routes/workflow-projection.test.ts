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
  visitToSignupPct: 4,   // v2s 0.04
  signupToPaidClientPct: 50,
};

// Two dynasties. wf-a: $1000 cost / 200 contacted / 100 clicks / 50 replies
//                wf-b: $1000 cost / 200 contacted / 50 clicks / 10 replies
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
    // Effective economics — brand-service owns saved-vs-average; the route reads { economics, source }.
    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS; // distinguish explicit null (cold start)
      const source = "source" in opts ? opts.source : economics == null ? null : "user";
      return new Response(JSON.stringify({ economics, source }), { status: 200, headers: { "Content-Type": "application/json" } });
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

  it("no budget → per-workflow unit costs + costs per outcome, projection null, recommends cheapest meeting objective", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("meeting-booked");
    expect(res.body.workflows).toHaveLength(2);

    const a = byDynasty(res.body, "dyn-a");
    expect(a.workflowDynastyName).toBe("Dynasty A");
    expect(a.contactedUsd).toBeCloseTo(5, 6); // $1000 / 200 contacted leads
    expect(a.replyUsd).toBeCloseTo(20, 6);  // $1000 / 50 replies
    expect(a.clickUsd).toBeCloseTo(10, 6);  // $1000 / 100 clicks
    expect(a.costPerSignupUsd).toBeCloseTo(250, 3); // 1 / ((1/10)·0.04)
    // pCloseClick=orP(0.02,0.05·0.30)=0.0347, pCloseReply=0.40·0.30=0.12
    // closesPerBudget = (1/10)·0.0347 + (1/20)·0.12 = 0.00347 + 0.006 = 0.00947 → cpc = 105.5966
    expect(a.costPerCloseUsd).toBeCloseTo(105.5966, 3);
    // meetingsPerBudget = (1/10)·0.05 + (1/20)·0.40 = 0.005 + 0.02 = 0.025 → cpm = 40
    expect(a.costPerMeetingBookedUsd).toBeCloseTo(40, 3);
    // ROI multiple = LTR / costPerClose = 1000 / 105.5966 (budget-independent, = 100/cacPct).
    expect(a.roiMultiple).toBeCloseTo(1000 / 105.5966, 3);
    expect(a.projection).toBeNull(); // no budget

    const b = byDynasty(res.body, "dyn-b");
    // closesPerBudget = (1/20)·0.0347 + (1/100)·0.12 = 0.001735 + 0.0012 = 0.002935 → cpc = 340.7155
    expect(b.costPerSignupUsd).toBeCloseTo(500, 3);
    expect(b.costPerCloseUsd).toBeCloseTo(340.7155, 3);
    expect(b.costPerMeetingBookedUsd).toBeCloseTo(153.846, 3);
    expect(b.roiMultiple).toBeCloseTo(1000 / 340.7155, 3);

    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a"); // lower cost per meeting
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(400, 2); // 10 × $40/meeting
  });

  it("with budget → full projection block", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.projection.contactedLeads).toBeCloseTo(200, 6); // 1000/5
    expect(a.projection.replies).toBeCloseTo(50, 6);    // 1000/20
    expect(a.projection.visits).toBeCloseTo(100, 6);    // 1000/10
    expect(a.projection.signups).toBeCloseTo(4, 6);      // 100·0.04
    expect(a.projection.meetings).toBeCloseTo(25, 6);   // 50·0.4 + 100·0.05 (both routes)
    expect(a.projection.closes).toBeCloseTo(9.47, 6);   // 1000·0.00947
    expect(a.projection.revenue).toBeCloseTo(9470, 4);  // 9.47·1000
    expect(a.projection.cacPct).toBeCloseTo(10.5597, 3); // 1000/9470·100
    expect(a.projection.cacAbs).toBeCloseTo(105.5966, 3); // 1000/9.47
  });

  it("objective controls only the recommendation metric; projection details remain the same", async () => {
    mockFetch();
    const none = await request(app).get(`${URL_BASE}?brandId=b1&budgetUsd=1000`).set(AUTH);
    const meeting = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    const self = await request(app).get(`${URL_BASE}?brandId=b1&objective=self-serve&budgetUsd=1000`).set(AUTH);
    expect(none.status).toBe(200);
    expect(meeting.status).toBe(200);
    expect(self.status).toBe(200);
    // Per-workflow facts are objective-independent.
    expect(none.body.workflows).toEqual(meeting.body.workflows);
    expect(self.body.workflows).toEqual(meeting.body.workflows);
    // The recommended budget uses the objective's cost: meeting-booked → costPerMeetingBookedUsd,
    // self-serve → costPerSignupUsd.
    expect(meeting.body.recommendedBudgetUsd).toBeCloseTo(400, 2);
    expect(none.body.recommendedBudgetUsd).toBeCloseTo(400, 2);
    expect(self.body.recommendedBudgetUsd).toBeCloseTo(2500, 2);
    // both routes (click + reply) feed meetings now — non-null even under the former "self-serve"
    const selfA = byDynasty(self.body, "dyn-a");
    expect(selfA.projection.signups).toBeCloseTo(4, 6);
    expect(selfA.projection.replies).toBeCloseTo(50, 6);
    expect(selfA.projection.meetings).toBeCloseTo(25, 6);
    // objective is still echoed for back-compat: default meeting-booked when absent/invalid
    expect(none.body.objective).toBe("meeting-booked");
    expect(self.body.objective).toBe("self-serve");
  });

  it("cold start (effective economics null) → unit costs present, cost-per-close + projection + recommendation null", async () => {
    mockFetch({ economics: null, source: null }); // no brand on the platform has saved economics yet
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.replyUsd).toBeCloseTo(20, 6);   // unit costs still computed
    expect(a.clickUsd).toBeCloseTo(10, 6);
    expect(a.costPerSignupUsd).toBeNull();
    expect(a.costPerCloseUsd).toBeNull();
    expect(a.roiMultiple).toBeNull(); // no economics → no costPerClose → no ROI
    expect(a.projection).toBeNull();
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendedBudgetUsd).toBeNull();
  });

  it("no SAVED set but effective returns the cross-brand-average → non-null cost-per-close + budget", async () => {
    // Brand hasn't saved economics; brand-service serves the org-wide average (source "cross-brand-average").
    // features-service consumes it identically to a user-saved set — non-null budget, no averaging here.
    mockFetch({ economics: ECONOMICS, source: "cross-brand-average" });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.costPerSignupUsd).toBeCloseTo(250, 3);
    expect(a.costPerCloseUsd).toBeCloseTo(105.5966, 3); // same math as a saved set
    expect(a.costPerMeetingBookedUsd).toBeCloseTo(40, 3);
    expect(a.projection.closes).toBeCloseTo(9.47, 6);
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a");
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(400, 2);
  });

  it("workflow with no replies → replyUsd null, click route still funds closes", async () => {
    mockFetch({ emailGroups: [emailGroup("wf-a", 100, 0)] }); // 0 positive replies
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.replyUsd).toBeNull();
    expect(a.clickUsd).toBeCloseTo(10, 6);
    expect(a.costPerSignupUsd).toBeCloseTo(250, 3);
    // closesPerBudget = (1/10)·0.0347 = 0.00347 → cpc ≈ 288.18 (reply route contributes 0)
    expect(a.costPerCloseUsd).toBeCloseTo(288.1844, 3);
    expect(a.costPerMeetingBookedUsd).toBeCloseTo(200, 3);
  });

  it("meeting-booked recommendation does not multiply by meeting→close", async () => {
    mockFetch({
      emailGroups: [emailGroup("wf-a", 0, 10, 100)],
      costGroups: [costGroup("wf-a", 70000)],
      economics: {
        ...ECONOMICS,
        replyToMeetingPct: 30,
        visitToMeetingPct: 0.3,
        meetingToClosePct: 30,
        visitToClosePct: 0,
      },
    });

    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.replyUsd).toBeCloseTo(70, 6);
    expect(a.costPerMeetingBookedUsd).toBeCloseTo(233.333, 3); // $70 / 0.30
    expect(a.costPerCloseUsd).toBeCloseTo(777.778, 3); // $70 / (0.30 × 0.30)
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(2333.333, 2); // 10 × costPerMeetingBookedUsd
  });

  it("self-serve recommendation uses signup cost, not paid-close cost", async () => {
    mockFetch({
      emailGroups: [emailGroup("wf-a", 100, 0, 100)],
      costGroups: [costGroup("wf-a", 30000)],
      economics: {
        ...ECONOMICS,
        visitToSignupPct: 3,
        signupToPaidClientPct: 10,
        visitToClosePct: 0.3,
        visitToMeetingPct: 0,
        meetingToClosePct: 0,
      },
    });

    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=self-serve`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("self-serve");
    const a = byDynasty(res.body, "dyn-a");
    expect(a.clickUsd).toBeCloseTo(3, 6);
    expect(a.costPerSignupUsd).toBeCloseTo(100, 3); // $3 / 0.03
    expect(a.costPerCloseUsd).toBeCloseTo(1000, 3); // $3 / 0.003
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(1000, 2); // 10 × costPerSignupUsd
  });

  it("signup objective aliases self-serve for explicit consumers", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=signup`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("signup");
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(2500, 2);
  });

  it("purchase objective keeps the paid-close recommendation available", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=purchase`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("purchase");
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(1055.966, 2);
  });

  it("workflow with no contacted-lead denominator → projection carries explicit contactedLeads null", async () => {
    mockFetch({ emailGroups: [emailGroup("wf-a", 100, 50, 0)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked&budgetUsd=1000`).set(AUTH);
    expect(res.status).toBe(200);
    const a = byDynasty(res.body, "dyn-a");
    expect(a.contactedUsd).toBeNull();
    expect(a.projection.contactedLeads).toBeNull();
    expect(a.projection.replies).toBeCloseTo(50, 6);
    expect(a.projection.visits).toBeCloseTo(100, 6);
    expect(a.projection.signups).toBeCloseTo(4, 6);
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
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=meeting-booked`).set(AUTH);
    expect(res.status).toBe(502);
  });
});
