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
const { __resetPlatformRatesCache } = await import("../lib/platform-rates-client.js");
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

// Platform funnel: sent/contacted=1, delivered/sent=1, clicked/delivered=0.1, posReply/delivered=0.1
//   pClose_click=0.02, pClose_reply=0.12, pClose_deliv=max(0.1·0.02, 0.1·0.12)=0.012
//   → contacted=sent=delivered EV = 1000·0.012 = 12 ; click EV = 20 ; reply EV = 120
const PLATFORM_STATS = {
  broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, clicked: 10, repliesPositive: 10 } },
};

function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    leadId: "l1",
    email: "l1@x.com",
    contacted: true,
    sent: true,
    delivered: true,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    replied: false,
    replyClassification: null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } },
    ...over,
  };
}

/** email → first*At, mapped onto the email-gateway /orgs/status brand-scope shape. */
type Timestamps = Record<string, { firstContactedAt?: string | null; firstSentAt?: string | null; firstDeliveredAt?: string | null; firstOpenedAt?: string | null; firstClickedAt?: string | null; firstRepliedAt?: string | null }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

/** runs-service /v1/stats/costs response carrying a single workflow group of `cents`. */
function costGroups(cents: number): string {
  return JSON.stringify({ groups: [{ dimensions: {}, totalCostInUsdCents: String(cents), runCount: 0, minStartedAt: null, maxStartedAt: null }] });
}

/** Route fetch mock keyed by URL substring. economics + leads + status timestamps + platform stats + cost overridable. */
function mockFetch(opts: { economics?: unknown; leads?: unknown[]; timestamps?: Timestamps; platformStats?: unknown; costCents?: number } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("/stats/costs")) {
      return new Response(costGroups(opts.costCents ?? 0), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/sales-economics")) {
      return new Response(JSON.stringify({ salesEconomics: opts.economics ?? null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/public/stats")) {
      return new Response(JSON.stringify(opts.platformStats ?? PLATFORM_STATS), { status: 200, headers: { "Content-Type": "application/json" } });
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
    __resetPlatformRatesCache();
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

  it("earns stage EV from Contacted/Delivered onward (no click or reply)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l3", email: "cold@z.com", lead: { firstName: "Cold", lastName: "Z", photoUrl: null, organization: { id: "o3", name: "Org3", logoUrl: null } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(12); // delivered-stage EV, no click/reply
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBe(12);
    expect(res.body.leads[0].tags).toContain("delivered");
    expect(res.body.events).toEqual([]); // delivery-stage events are not itemised
  });

  it("bounced lead earns no expected revenue (excluded even if clicked)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l4", email: "bounce@z.com", clicked: true, bounced: true })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.leads).toEqual([]);
  });

  // ── orgDomain (for logo.dev) ──────────────────────────────────────────────────

  it("orgDomain — organization.primaryDomain surfaced on organizations[] and leads[]", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@cascobay.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Casco Bay", logoUrl: null, primaryDomain: "cascobay.com" } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBe("cascobay.com");
    expect(res.body.leads[0].orgDomain).toBe("cascobay.com");
  });

  it("orgDomain — falls back to a domain parsed from websiteUrl when primaryDomain is null", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@cascobay.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Casco Bay", logoUrl: null, primaryDomain: null, websiteUrl: "https://www.cascobay.com/about" } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBe("cascobay.com"); // protocol + www + path stripped
    expect(res.body.leads[0].orgDomain).toBe("cascobay.com");
  });

  it("orgDomain — null when neither primaryDomain nor websiteUrl is known", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@x.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBeNull();
    expect(res.body.leads[0].orgDomain).toBeNull();
  });

  it("502 when platform rates (/public/stats) fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      if (url.includes("/public/stats")) return new Response("boom", { status: 500 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  it("degrades to dateless (still 200, pipeline correct) when email-gateway /orgs/status fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
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
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  // ── costEconomics ───────────────────────────────────────────────────────────

  it("costEconomics — normal: finite cost-of-acquisition % and ROI multiple", async () => {
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS, costCents: 7000 }); // $70 cost, pipeline 140
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(140);
    expect(res.body.costEconomics.totalCostUsd).toBe(70);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeCloseTo(50); // 70/140*100
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(2); // 140/70
  });

  it("costEconomics — null pipeline (no economics): both ratios null, totalCostUsd real", async () => {
    mockFetch({ economics: null, costCents: 5000 });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.costEconomics.totalCostUsd).toBe(50);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("costEconomics — null pipeline (no funnel): present with both ratios null", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue({ ...SALES_FEATURE, slug: "pr-cold-email-outreach" } as any);
    mockFetch({ costCents: 3000 });
    const res = await request(app).get("/features/pr-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.costEconomics.totalCostUsd).toBe(30);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("costEconomics — zero cost: roiMultiple null, costOfAcquisitionPct 0", async () => {
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS, costCents: 0 }); // pipeline 140, no cost
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(140);
    expect(res.body.costEconomics.totalCostUsd).toBe(0);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBe(0);
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("502 (fail-loud) when runs-service /v1/stats/costs fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response("boom", { status: 500 });
      if (url.includes("/sales-economics")) return new Response(JSON.stringify({ salesEconomics: ECONOMICS }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  // ── decay (stall phase-out) ───────────────────────────────────────────────

  it("maps firstOpenedAt → opened stage (alive, tag opened)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "lo", email: "open@x.com", lead: { firstName: "Op", lastName: "En", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } })],
      timestamps: { "open@x.com": { firstDeliveredAt: daysAgo(3), firstOpenedAt: daysAgo(2) } },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(12); // opened carries delivered-stage EV
    expect(res.body.leads[0].tags).toContain("opened");
  });

  it("stalled lead drops off the total but stays in the leads table with a stale tag", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "lc", email: "cold@x.com", sent: false, delivered: false, lead: { firstName: "Co", lastName: "Ld", photoUrl: null, organization: { id: "o9", name: "Org9", logoUrl: null } } })],
      timestamps: { "cold@x.com": { firstContactedAt: daysAgo(20) } }, // contacted 20d ago, window 7d
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.organizations).toEqual([]);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBe(0);
    expect(res.body.leads[0].tags).toContain("stale");
  });
});
