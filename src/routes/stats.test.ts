import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
  },
  sql: {},
}));

vi.mock("../lib/env.js", () => ({
  validateRequiredEnv: vi.fn(),
  REQUIRED_ENV: [],
}));

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
process.env.PRESS_KITS_SERVICE_URL = "http://press-kits:3000";
process.env.PRESS_KITS_SERVICE_API_KEY = "press-kits-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const MOCK_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  description: "test",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("GET /features/:featureSlug/stats — network error resilience", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("returns 200 with zeroed stats when all downstream services throw ECONNRESET", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    );

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.systemStats.completedRuns).toBe(0);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(0);
  });

  it("returns 200 on global /stats when downstream services throw network errors", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    );

    const res = await request(app)
      .get("/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.systemStats.completedRuns).toBe(0);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(0);
  });

  it("returns partial data when only some downstream services fail", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: { workflowSlug: "__total__" },
            totalCostInUsdCents: "1500",
            runCount: 10,
            minStartedAt: "2026-01-01T00:00:00Z",
            maxStartedAt: "2026-03-01T00:00:00Z",
          }],
        }), { status: 200 });
      }

      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.systemStats.completedRuns).toBe(10);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(1500);
  });
});

describe("GET /features/:featureSlug/stats — feature scoping", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("passes featureDynastySlug to all downstream services", async () => {
    const urls: string[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      urls.push(url);

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: { workflowSlug: "__total__" },
            totalCostInUsdCents: "0",
            runCount: 0,
            minStartedAt: null,
            maxStartedAt: null,
          }],
        }), { status: 200 });
      }
      if (url.includes("email:3000")) {
        return new Response(JSON.stringify({ broadcast: {}, transactional: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=brand-1")
      .set(AUTH_HEADERS);

    const httpUrls = urls.filter((u) => u.startsWith("http"));
    expect(httpUrls.length).toBeGreaterThan(0);
    for (const url of httpUrls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("featureDynastySlug")).toBe("sales-cold-email-outreach");
    }
  });
});

describe("GET /entities/registry", () => {
  it("returns the entity type registry", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.registry).toBeDefined();

    const reg = res.body.registry;
    expect(reg.leads).toEqual({
      label: "Leads",
      icon: "users",
      pathSuffix: "leads",
      description: expect.any(String),
    });
    expect(reg.outlets).toEqual({
      label: "Outlets",
      icon: "newspaper",
      pathSuffix: "outlets",
      description: expect.any(String),
    });

    for (const [, def] of Object.entries(reg) as [string, Record<string, string>][]) {
      expect(def.label).toBeTruthy();
      expect(def.icon).toBeTruthy();
      expect(def.pathSuffix).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("rejects requests without API key", async () => {
    const res = await request(app).get("/entities/registry");
    expect(res.status).toBe(401);
  });
});
