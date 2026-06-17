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

const FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales",
  description: "x",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function costGroup(customerProfileId: string | null, cents: number, runCount = 1): Record<string, unknown> {
  return {
    dimensions: { customerProfileId },
    totalCostInUsdCents: String(cents),
    runCount,
    minStartedAt: "2026-01-01T00:00:00Z",
    maxStartedAt: "2026-01-02T00:00:00Z",
  };
}

function emailGroup(customerProfileId: string | null, clicked: number, repliesPositive: number): Record<string, unknown> {
  return {
    key: customerProfileId,
    broadcast: {
      recipientStats: {
        contacted: clicked + repliesPositive,
        sent: clicked + repliesPositive,
        delivered: clicked + repliesPositive,
        opened: clicked + repliesPositive,
        clicked,
        bounced: 0,
        unsubscribed: 0,
        repliesPositive,
        repliesNegative: 0,
        repliesNeutral: 0,
        repliesAutoReply: 0,
      },
    },
  };
}

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("brand:3000/orgs/brands/brand-1/personas")) {
      return new Response(JSON.stringify({
        personas: [
          { id: "persona-a", brandId: "brand-1", name: "CFOs", filters: { seniority: ["executive"] }, status: "active", createdAt: "2026-01-01T00:00:00Z" },
          { id: "persona-b", brandId: "brand-1", name: "Founders", filters: { title: ["founder"] }, status: "paused", createdAt: "2026-01-01T00:00:00Z" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
      return new Response(JSON.stringify({
        current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" },
        versions: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("runs:3000/v1/stats/costs")) {
      return new Response(JSON.stringify({
        groups: [
          costGroup("persona-a", 3000, 3),
          costGroup("persona-b", 1000, 2),
          costGroup("unknown-persona", 200, 1),
          costGroup(null, 9000, 9),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("email:3000/orgs/stats")) {
      return new Response(JSON.stringify({
        groups: [
          emailGroup("persona-a", 10, 2),
          emailGroup("persona-b", 20, 5),
          emailGroup("unknown-persona", 50, 50),
          emailGroup(null, 99, 99),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/persona-stats", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("400 when brandId or goal is missing", async () => {
    let res = await request(app).get("/features/sales-cold-email-outreach/persona-stats?goal=signup").set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app).get("/features/sales-cold-email-outreach/persona-stats?brandId=brand-1").set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app).get("/features/sales-cold-email-outreach/persona-stats?brandId=brand-1&goal=signup&limit=1abc").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("sorts signup personas by CPC and omits unattributed or unknown groups", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/persona-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sortMetric).toBe("cpc");
    expect(res.body.brandProfileId).toBe("brand-profile-1");
    expect(res.body.personas.map((p: any) => p.customerProfileId)).toEqual(["persona-b", "persona-a"]);
    expect(res.body.personas).toHaveLength(2);
    expect(res.body.personas[0].persona.name).toBe("Founders");
    expect(res.body.personas[0].evidence).toMatchObject({
      totalCostInUsdCents: 1000,
      completedRuns: 2,
      websiteClicks: 20,
      positiveReplies: 5,
    });
    expect(res.body.personas[0].metrics.cpcCents).toBe(50);
    expect(res.body.personas[1].metrics.cpcCents).toBe(300);
  });

  it("sorts sales-meeting personas by CPPR using the same real evidence", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/persona-stats?brandId=brand-1&goal=meetingBooked")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sortMetric).toBe("cppr");
    expect(res.body.personas.map((p: any) => p.customerProfileId)).toEqual(["persona-b", "persona-a"]);
    expect(res.body.personas[0].metrics.cpprCents).toBe(200);
    expect(res.body.personas[1].metrics.cpprCents).toBe(1500);
  });

  it("uses explicit brandProfileId and does not fetch the current profile", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/persona-stats?brandId=brand-1&goal=signup&brandProfileId=brand-profile-explicit&limit=1")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.brandProfileId).toBe("brand-profile-explicit");
    expect(res.body.personas).toHaveLength(1);
    const urls: string[] = fetchSpy.mock.calls.map((call: any[]) => {
      const input = call[0];
      return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    });
    expect(urls.some((url: string) => url.includes("/brand-profile"))).toBe(false);
    expect(urls.find((url: string) => url.includes("runs:3000"))).toContain("brandProfileId=brand-profile-explicit");
    expect(urls.find((url: string) => url.includes("email:3000"))).toContain("brandProfileId=brand-profile-explicit");
  });
});
