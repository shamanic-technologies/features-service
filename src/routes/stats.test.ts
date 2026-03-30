import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Mock DB before importing app
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

// Mock env validation (no-op in tests)
vi.mock("../lib/env.js", () => ({
  validateRequiredEnv: vi.fn(),
  REQUIRED_ENV: [],
}));

// Mock Sentry
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

// Mock seed registration
vi.mock("../seed/register.js", () => ({
  registerSeedFeatures: vi.fn(),
}));

// Set required env vars before importing app
process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
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
  slug: "cold-email-v1",
  name: "Cold Email v1",
  baseName: "Cold Email",
  forkName: null,
  dynastyName: "Cold Email",
  dynastySlug: "cold-email",
  version: 1,
  description: "test",
  icon: "envelope",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  implemented: true,
  displayOrder: 0,
  status: "active",
  signature: "sig-1",
  inputs: [],
  outputs: [{ key: "emailsSent", displayOrder: 1 }],
  charts: [],
  entities: [],
  forkedFrom: null,
  upgradedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("stats route - network error resilience", () => {
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
      .get("/features/cold-email-v1/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.featureSlug).toBe("cold-email-v1");
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

      // runs-service succeeds
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

      // all other services throw
      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });

    const res = await request(app)
      .get("/features/cold-email-v1/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.systemStats.completedRuns).toBe(10);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(1500);
  });
});

// ── Feature stats scoping — regression test for cross-feature bleed ─────────

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
      .get("/features/cold-email-v1/stats?brandId=brand-1")
      .set(AUTH_HEADERS);

    // Every downstream call should include featureDynastySlug=cold-email
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("featureDynastySlug")).toBe("cold-email");
    }
  });
});

// ── Dynasty stats endpoint ──────────────────────────────────────────────────

describe("GET /stats/dynasty", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("returns 400 when dynastySlug query param is missing", async () => {
    const res = await request(app)
      .get("/stats/dynasty")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/i);
  });

  it("returns 404 when no features match the dynasty slug", async () => {
    vi.mocked(db.query.features.findMany).mockResolvedValue([]);

    const res = await request(app)
      .get("/stats/dynasty?dynastySlug=nonexistent")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });

  it("returns 200 with zeroed stats when downstream services fail", async () => {
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(null as any);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );

    const res = await request(app)
      .get("/stats/dynasty?dynastySlug=cold-email")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.dynastySlug).toBe("cold-email");
    expect(res.body.systemStats.completedRuns).toBe(0);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .get("/stats/dynasty?dynastySlug=cold-email");

    expect(res.status).toBe(401);
  });
});
