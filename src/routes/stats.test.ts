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

// ── Press-kits stats integration ────────────────────────────────────────────

const MOCK_PRESS_KIT_FEATURE = {
  ...MOCK_FEATURE,
  id: "feat-pk-1",
  slug: "press-kit-page-generation",
  name: "Press Kit Page Generation",
  baseName: "Press Kit Page Generation",
  dynastyName: "Press Kit Page Generation",
  dynastySlug: "press-kit-page-generation",
  category: "pr",
  channel: "page",
  outputs: [
    { key: "pressKitsGenerated", displayOrder: 1 },
    { key: "pressKitViews", displayOrder: 2 },
    { key: "pressKitUniqueVisitors", displayOrder: 3 },
    { key: "costPerPressKitCents", displayOrder: 4 },
  ],
  charts: [
    {
      key: "pressKitFunnel",
      type: "funnel-bar" as const,
      title: "Press Kit Funnel",
      displayOrder: 1,
      steps: [
        { key: "pressKitsGenerated" },
        { key: "pressKitViews" },
        { key: "pressKitUniqueVisitors" },
      ],
    },
    {
      key: "viewsBreakdown",
      type: "breakdown-bar" as const,
      title: "Views Breakdown",
      displayOrder: 2,
      segments: [
        { key: "pressKitViews", color: "blue", sentiment: "neutral" },
        { key: "pressKitUniqueVisitors", color: "green", sentiment: "positive" },
      ],
    },
  ],
};

describe("GET /features/:featureSlug/stats — press-kits source", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_PRESS_KIT_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_PRESS_KIT_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("fetches press-kits stats and returns pressKitsGenerated, pressKitViews, pressKitUniqueVisitors", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: { workflowSlug: "__total__" },
            totalCostInUsdCents: "5000",
            runCount: 5,
            minStartedAt: "2026-01-01T00:00:00Z",
            maxStartedAt: "2026-03-01T00:00:00Z",
          }],
        }), { status: 200 });
      }

      if (url.includes("press-kits:3000") && url.includes("/stats/views")) {
        return new Response(JSON.stringify({
          totalViews: 1250,
          uniqueVisitors: 843,
          lastViewedAt: "2026-03-29T14:32:00.000Z",
          firstViewedAt: "2026-03-01T09:15:00.000Z",
        }), { status: 200 });
      }

      if (url.includes("press-kits:3000") && url.includes("/stats/costs")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: {},
            totalCostInUsdCents: 2050,
            actualCostInUsdCents: 2050,
            provisionedCostInUsdCents: 0,
            runCount: 3,
          }],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const res = await request(app)
      .get("/features/press-kit-page-generation/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.stats.pressKitsGenerated).toBe(3);
    expect(res.body.stats.pressKitViews).toBe(1250);
    expect(res.body.stats.pressKitUniqueVisitors).toBe(843);
    // costPerPressKitCents = totalCostInUsdCents (5000) / pressKitsGenerated (3)
    expect(res.body.stats.costPerPressKitCents).toBeCloseTo(5000 / 3);
  });

  it("passes featureDynastySlug filter to press-kits-service", async () => {
    const capturedUrls: string[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      capturedUrls.push(url);

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{ dimensions: { workflowSlug: "__total__" }, totalCostInUsdCents: "0", runCount: 0, minStartedAt: null, maxStartedAt: null }],
        }), { status: 200 });
      }
      if (url.includes("press-kits:3000") && url.includes("/stats/views")) {
        return new Response(JSON.stringify({ totalViews: 0, uniqueVisitors: 0, lastViewedAt: null, firstViewedAt: null }), { status: 200 });
      }
      if (url.includes("press-kits:3000") && url.includes("/stats/costs")) {
        return new Response(JSON.stringify({ groups: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await request(app)
      .get("/features/press-kit-page-generation/stats?brandId=brand-1")
      .set(AUTH_HEADERS);

    const pressKitUrls = capturedUrls.filter((u) => u.includes("press-kits:3000"));
    expect(pressKitUrls.length).toBe(2);
    for (const u of pressKitUrls) {
      const parsed = new URL(u);
      expect(parsed.searchParams.get("featureDynastySlug")).toBe("press-kit-page-generation");
      expect(parsed.searchParams.get("brandId")).toBe("brand-1");
    }
  });

  it("supports groupBy=brandId with grouped press-kits responses", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [
            { dimensions: { brandId: "brand-a" }, totalCostInUsdCents: "1000", runCount: 2, minStartedAt: "2026-01-01T00:00:00Z", maxStartedAt: "2026-03-01T00:00:00Z" },
            { dimensions: { brandId: "brand-b" }, totalCostInUsdCents: "2000", runCount: 3, minStartedAt: "2026-02-01T00:00:00Z", maxStartedAt: "2026-03-15T00:00:00Z" },
          ],
        }), { status: 200 });
      }

      if (url.includes("press-kits:3000") && url.includes("/stats/views")) {
        return new Response(JSON.stringify({
          groups: [
            { key: "brand-a", totalViews: 500, uniqueVisitors: 300, lastViewedAt: "2026-03-29T00:00:00Z" },
            { key: "brand-b", totalViews: 800, uniqueVisitors: 550, lastViewedAt: "2026-03-28T00:00:00Z" },
          ],
        }), { status: 200 });
      }

      if (url.includes("press-kits:3000") && url.includes("/stats/costs")) {
        return new Response(JSON.stringify({
          groups: [
            { dimensions: { brandId: "brand-a" }, runCount: 2, totalCostInUsdCents: 500, actualCostInUsdCents: 500, provisionedCostInUsdCents: 0 },
            { dimensions: { brandId: "brand-b" }, runCount: 4, totalCostInUsdCents: 800, actualCostInUsdCents: 800, provisionedCostInUsdCents: 0 },
          ],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const res = await request(app)
      .get("/features/press-kit-page-generation/stats?groupBy=brandId")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.groups).toBeDefined();
    expect(res.body.groups.length).toBe(2);

    const brandA = res.body.groups.find((g: any) => g.brandId === "brand-a");
    const brandB = res.body.groups.find((g: any) => g.brandId === "brand-b");
    expect(brandA.stats.pressKitViews).toBe(500);
    expect(brandA.stats.pressKitUniqueVisitors).toBe(300);
    expect(brandA.stats.pressKitsGenerated).toBe(2);
    expect(brandB.stats.pressKitViews).toBe(800);
    expect(brandB.stats.pressKitsGenerated).toBe(4);
  });

  it("returns null press-kits stats when press-kits-service is down", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

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

      if (url.includes("press-kits:3000")) {
        throw new TypeError("fetch failed");
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const res = await request(app)
      .get("/features/press-kit-page-generation/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.stats.pressKitsGenerated).toBeNull();
    expect(res.body.stats.pressKitViews).toBeNull();
    expect(res.body.stats.pressKitUniqueVisitors).toBeNull();
  });
});

// ── GET /entities/registry ──────────────────────────────────────────────────

describe("GET /entities/registry", () => {
  it("returns the entity type registry with metadata for each type", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.registry).toBeDefined();

    // Verify known entity types are present
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
    expect(reg.journalists).toEqual({
      label: "Journalists",
      icon: "pen-tool",
      pathSuffix: "journalists",
      description: expect.any(String),
    });
    expect(reg["press-kits"]).toEqual({
      label: "Press Kits",
      icon: "file-text",
      pathSuffix: "press-kits",
      description: expect.any(String),
    });

    // Every entry must have all four fields
    for (const [key, def] of Object.entries(reg) as [string, Record<string, string>][]) {
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
