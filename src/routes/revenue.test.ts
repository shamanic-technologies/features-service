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
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.JOURNALISTS_SERVICE_URL = "http://journalists:3000";
process.env.JOURNALISTS_SERVICE_API_KEY = "journalists-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
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
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
};

function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    leadId: "l1",
    email: "l1@x.com",
    clicked: false,
    replied: false,
    replyClassification: null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } },
    ...over,
  };
}

/** email → first*At, mapped onto the email-gateway /orgs/status brand-scope shape. */
type Timestamps = Record<string, { firstClickedAt?: string | null; firstRepliedAt?: string | null }>;

/** Route fetch mock keyed by URL substring. economics + leads + status timestamps overridable. */
function mockFetch(opts: { economics?: unknown; leads?: unknown[]; timestamps?: Timestamps } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("/sales-economics")) {
      return new Response(JSON.stringify({ salesEconomics: opts.economics ?? null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/leads")) {
      return new Response(JSON.stringify({ leads: opts.leads ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/status")) {
      const ts = opts.timestamps ?? {};
      const results = Object.entries(ts).map(([email, scope]) => ({
        email,
        broadcast: { byCampaign: null, campaign: null, brand: { contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true, replyClassification: "positive", bounced: false, unsubscribed: false, lastDeliveredAt: null, ...scope }, global: { email: { bounced: false, unsubscribed: false } } },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // runs-service trace events etc. — ignore
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/revenue", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing", async () => {
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    const res = await request(app).get("/features/unknown/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(404);
  });

  it("null pipeline when feature has no funnel wired", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue({ ...SALES_FEATURE, slug: "pr-cold-email-outreach" } as any);
    mockFetch();
    const res = await request(app).get("/features/pr-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.organizations).toEqual([]);
  });

  it("null pipeline when brand has no saved economics", async () => {
    mockFetch({ economics: null });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.leads).toEqual([]);
  });

  const HAPPY_LEADS = [
    leadRow({ leadId: "l1", email: "click@x.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } }),
    leadRow({ leadId: "l2", email: "reply@y.com", replied: true, replyClassification: "positive", lead: { firstName: "Reply", lastName: "Y", photoUrl: null, organization: { id: "o2", name: "Org2", logoUrl: null } } }),
  ];

  it("happy path with per-event timestamps — headline + tables + timeSeries + events", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: HAPPY_LEADS,
      timestamps: {
        "click@x.com": { firstClickedAt: "2026-01-01T00:00:00Z" },
        "reply@y.com": { firstRepliedAt: "2026-02-01T00:00:00Z" },
      },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    // o1: visit EV 20, o2: reply EV 120 → total 140
    expect(res.body.headline.totalPipelineUsd).toBe(140);
    expect(res.body.organizations).toHaveLength(2);
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.organizations[0].expectedRevenueUsd).toBe(120); // sorted EV desc
    expect(res.body.timeSeries).toEqual([
      { date: "2026-01-01T00:00:00Z", cumulativePipelineUsd: 20 },
      { date: "2026-02-01T00:00:00Z", cumulativePipelineUsd: 140 },
    ]);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.find((e: any) => e.eventType === "reply").eventDate).toBe("2026-02-01T00:00:00Z");
  });

  it("degrades to dateless (still 200, pipeline correct) when email-gateway /orgs/status fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      if (url.includes("/orgs/status")) return new Response("boom", { status: 502 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(140); // pipeline still exact
    expect(res.body.timeSeries).toEqual([]); // enrichment absent
    expect(res.body.events).toEqual([]);
    expect(res.body.leads[0].date).toBeNull();
  });

  it("502 when lead-service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });
});
