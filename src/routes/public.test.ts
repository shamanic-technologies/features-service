import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
  sql: {},
}));

// Mock env validation
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

// Mock brand-client
vi.mock("../lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
}));

// Set required env vars before importing app
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
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;

// ── GET /public/features ──────────────────────────────────────────────────

describe("GET /public/features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active features with display-safe fields only, no auth required", async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        dynastyName: "Sales Cold Email",
        dynastySlug: "sales-cold-email",
        description: "Cold outreach",
        icon: "mail",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        displayOrder: 1,
      },
      {
        dynastyName: "PR Journalist Outreach",
        dynastySlug: "pr-journalist-outreach",
        description: "PR outreach",
        icon: "newspaper",
        category: "pr",
        channel: "email",
        audienceType: "journalists",
        displayOrder: 0,
      },
    ]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(2);
    // Sorted by displayOrder
    expect(res.body.features[0].dynastySlug).toBe("pr-journalist-outreach");
    expect(res.body.features[1].dynastySlug).toBe("sales-cold-email");
    // No internal fields exposed
    expect(res.body.features[0]).not.toHaveProperty("id");
    expect(res.body.features[0]).not.toHaveProperty("inputs");
    expect(res.body.features[0]).not.toHaveProperty("outputs");
    expect(res.body.features[0]).not.toHaveProperty("signature");
    expect(res.body.features[0]).not.toHaveProperty("baseName");
    expect(res.body.features[0]).not.toHaveProperty("forkName");
  });

  it("returns empty array when no active features", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toEqual([]);
  });
});

// ── GET /public/features/dynasty/slugs ────────────────────────────────────

describe("GET /public/features/dynasty/slugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns versioned slugs sorted by version, no auth required", async () => {
    mockFindMany.mockResolvedValueOnce([
      { slug: "sales-cold-email-v2", version: 2 },
      { slug: "sales-cold-email", version: 1 },
    ]);

    const res = await request(app)
      .get("/public/features/dynasty/slugs?dynastySlug=sales-cold-email");

    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual([
      "sales-cold-email",
      "sales-cold-email-v2",
    ]);
  });

  it("returns 404 when no features match", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/public/features/dynasty/slugs?dynastySlug=nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns 400 when dynastySlug is missing", async () => {
    const res = await request(app)
      .get("/public/features/dynasty/slugs");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/i);
  });
});

// ── Helpers for ranked/best tests ─────────────────────────────────────────

const MOCK_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email",
  name: "Sales Cold Email",
  dynastyName: "Sales Cold Email",
  dynastySlug: "sales-cold-email",
  baseName: "Sales Cold Email",
  forkName: null,
  version: 1,
  status: "active",
  description: "Cold outreach",
  icon: "mail",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  implemented: true,
  displayOrder: 0,
  signature: "abc123",
  inputs: [],
  outputs: [
    { key: "emailsReplied", displayOrder: 0, defaultSort: true, sortDirection: "desc" as const },
    { key: "emailsSent", displayOrder: 1 },
    { key: "replyRate", displayOrder: 2 },
  ],
  charts: [],
  entities: [],
  forkedFrom: null,
  upgradedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockFetchResponses(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    // workflow-service: GET /public/workflows
    "http://workflow:3000/public/workflows": {
      workflows: [
        {
          id: "wf-1",
          slug: "sales-outreach-alpha",
          name: "Sales Outreach Alpha",
          dynastyName: "Sales Outreach Alpha",
          dynastySlug: "sales-outreach-alpha",
          version: 1,
          status: "active",
          featureSlug: "sales-cold-email",
          createdForBrandId: null,
          upgradedTo: null,
        },
        {
          id: "wf-2",
          slug: "sales-outreach-beta",
          name: "Sales Outreach Beta",
          dynastyName: "Sales Outreach Beta",
          dynastySlug: "sales-outreach-beta",
          version: 1,
          status: "active",
          featureSlug: "sales-cold-email",
          createdForBrandId: "brand-1",
          upgradedTo: null,
        },
      ],
    },
    // runs-service: GET /v1/stats/public/costs
    "http://runs:3000/v1/stats/public/costs": {
      groups: [
        { dimensions: { workflowSlug: "sales-outreach-alpha" }, totalCostInUsdCents: "1000", runCount: 5, minStartedAt: null, maxStartedAt: null },
        { dimensions: { workflowSlug: "sales-outreach-beta" }, totalCostInUsdCents: "2000", runCount: 8, minStartedAt: null, maxStartedAt: null },
      ],
    },
    // email-gateway: GET /public/stats
    "http://email:3000/public/stats": {
      groups: [
        { key: "sales-outreach-alpha", broadcast: { emailsReplied: 10, emailsSent: 100, emailsOpened: 50 } },
        { key: "sales-outreach-beta", broadcast: { emailsReplied: 20, emailsSent: 80, emailsOpened: 40 } },
      ],
    },
    // brand-service: GET /brands/{id}
    "http://brand:3000/internal/brands/brand-1": {
      brand: { id: "brand-1", name: "Acme Corp", domain: "acme.com" },
    },
    "http://brand:3000/internal/brands/brand-2": {
      brand: { id: "brand-2", name: "Beta Inc", domain: "beta.io" },
    },
    ...overrides,
  };

  vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [prefix, body] of Object.entries(defaults)) {
      if (url.startsWith(prefix)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}

// ── GET /public/stats/ranked ──────────────────────────────────────────────

describe("GET /public/stats/ranked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns workflows ranked by objective value descending, with full stats", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("emailsReplied");
    expect(res.body.sortDirection).toBe("desc");
    expect(res.body.results).toHaveLength(2);
    // Beta: 20 replies, Alpha: 10 replies → Beta first (desc)
    expect(res.body.results[0].workflow.slug).toBe("sales-outreach-beta");
    expect(res.body.results[0].stats.emailsReplied).toBe(20);
    expect(res.body.results[0].stats.emailsSent).toBe(80);
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(2000);
    expect(res.body.results[0].stats.completedRuns).toBe(8);
    // Derived: replyRate = emailsReplied / emailsSent = 20/80 = 0.25
    expect(res.body.results[0].stats.replyRate).toBeCloseTo(0.25);
    expect(res.body.results[1].workflow.slug).toBe("sales-outreach-alpha");
    expect(res.body.results[1].stats.emailsReplied).toBe(10);
  });

  it("uses defaultSort output when objective is not provided", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&groupBy=workflow");

    expect(res.status).toBe(200);
    // Should default to emailsReplied (the output with defaultSort: true)
    expect(res.body.objective).toBe("emailsReplied");
    expect(res.body.results).toHaveLength(2);
    // Still sorted desc by emailsReplied: Beta(20) > Alpha(10)
    expect(res.body.results[0].workflow.slug).toBe("sales-outreach-beta");
  });

  it("returns 400 when featureDynastySlug is missing", async () => {
    const res = await request(app)
      .get("/public/stats/ranked?objective=emailsReplied&groupBy=workflow");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureDynastySlug/i);
  });

  it("returns 400 when groupBy is missing", async () => {
    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groupBy/i);
  });

  it("returns 404 when no features in dynasty", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=nonexistent&objective=emailsReplied&groupBy=workflow");

    expect(res.status).toBe(404);
  });

  it("handles zero outcomes (null stats ranked last)", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats": {
        groups: [
          { key: "sales-outreach-alpha", broadcast: { emailsReplied: 10, emailsSent: 100, emailsOpened: 50 } },
          { key: "sales-outreach-beta", broadcast: { emailsReplied: 0, emailsSent: 80, emailsOpened: 0 } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=workflow");

    expect(res.status).toBe(200);
    // Alpha has 10, Beta has 0 → Alpha first
    expect(res.body.results[0].stats.emailsReplied).toBe(10);
    expect(res.body.results[1].stats.emailsReplied).toBe(0);
  });

  it("respects limit parameter (default is 3)", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=workflow&limit=1");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].workflow.slug).toBe("sales-outreach-beta");
  });

  it("supports groupBy=brand with enriched brand info", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://runs:3000/v1/stats/public/costs": {
        groups: [
          { dimensions: { brandId: "brand-1" }, totalCostInUsdCents: "500", runCount: 3, minStartedAt: null, maxStartedAt: null },
          { dimensions: { brandId: "brand-2" }, totalCostInUsdCents: "1500", runCount: 7, minStartedAt: null, maxStartedAt: null },
        ],
      },
      "http://email:3000/public/stats": {
        groups: [
          { key: "brand-1", broadcast: { emailsReplied: 5, emailsSent: 50, emailsOpened: 25 } },
          { key: "brand-2", broadcast: { emailsReplied: 15, emailsSent: 60, emailsOpened: 30 } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    // brand-2: 15 replies, brand-1: 5 replies → brand-2 first (desc)
    expect(res.body.results[0].brand.id).toBe("brand-2");
    expect(res.body.results[0].brand.name).toBe("Beta Inc");
    expect(res.body.results[0].brand.domain).toBe("beta.io");
    expect(res.body.results[0].stats.emailsReplied).toBe(15);
    expect(res.body.results[0].stats.emailsSent).toBe(60);
    expect(res.body.results[1].brand.id).toBe("brand-1");
    expect(res.body.results[1].brand.name).toBe("Acme Corp");
    expect(res.body.results[1].brand.domain).toBe("acme.com");
    expect(res.body.results[1].stats.emailsReplied).toBe(5);
  });

  it("returns null brand name/domain when brand-service fails", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://runs:3000/v1/stats/public/costs": {
        groups: [
          { dimensions: { brandId: "brand-unknown" }, totalCostInUsdCents: "500", runCount: 3, minStartedAt: null, maxStartedAt: null },
        ],
      },
      "http://email:3000/public/stats": {
        groups: [
          { key: "brand-unknown", broadcast: { emailsReplied: 5, emailsSent: 50, emailsOpened: 25 } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    // brand-unknown doesn't match any mock → null name/domain
    expect(res.body.results[0].brand.id).toBe("brand-unknown");
    expect(res.body.results[0].brand.name).toBeNull();
    expect(res.body.results[0].brand.domain).toBeNull();
  });
});

// ── GET /public/stats/best ────────────────────────────────────────────────

describe("GET /public/stats/best", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns best workflow per count-type metric", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/best?featureDynastySlug=sales-cold-email&groupBy=workflow");

    expect(res.status).toBe(200);
    // emailsReplied: Alpha 1000/10=100, Beta 2000/20=100 → tied, either wins
    expect(res.body.best.emailsReplied).not.toBeNull();
    expect(res.body.best.emailsReplied.value).toBe(100);
  });

  it("returns 400 when featureDynastySlug is missing", async () => {
    const res = await request(app).get("/public/stats/best?groupBy=workflow");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureDynastySlug/i);
  });

  it("returns 400 when groupBy is missing", async () => {
    const res = await request(app).get("/public/stats/best?featureDynastySlug=sales-cold-email");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groupBy/i);
  });

  it("returns null for metrics with no data", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats": {
        groups: [
          { key: "sales-outreach-alpha", broadcast: { emailsReplied: 0, emailsSent: 0, emailsOpened: 0 } },
          { key: "sales-outreach-beta", broadcast: { emailsReplied: 0, emailsSent: 0, emailsOpened: 0 } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/best?featureDynastySlug=sales-cold-email&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("supports groupBy=brand", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://runs:3000/v1/stats/public/costs": {
        groups: [
          { dimensions: { brandId: "brand-1" }, totalCostInUsdCents: "500", runCount: 3, minStartedAt: null, maxStartedAt: null },
          { dimensions: { brandId: "brand-2" }, totalCostInUsdCents: "1500", runCount: 7, minStartedAt: null, maxStartedAt: null },
        ],
      },
      "http://email:3000/public/stats": {
        groups: [
          { key: "brand-1", broadcast: { emailsReplied: 5, emailsSent: 50, emailsOpened: 25 } },
          { key: "brand-2", broadcast: { emailsReplied: 3, emailsSent: 60, emailsOpened: 30 } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/best?featureDynastySlug=sales-cold-email&groupBy=brand");

    expect(res.status).toBe(200);
    // brand-1: 500/5=100, brand-2: 1500/3=500 → brand-1 wins
    expect(res.body.best.emailsReplied.brandId).toBe("brand-1");
    expect(res.body.best.emailsReplied.value).toBe(100);
  });
});

// ── Authenticated /stats/ranked and /stats/best ───────────────────────────

describe("GET /stats/ranked (authenticated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires auth headers", async () => {
    const res = await request(app)
      .get("/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=workflow");

    expect(res.status).toBe(401);
  });

  it("works with auth headers", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/stats/ranked?featureDynastySlug=sales-cold-email&objective=emailsReplied&groupBy=workflow")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });
});

describe("GET /stats/best (authenticated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires auth headers", async () => {
    const res = await request(app)
      .get("/stats/best?featureDynastySlug=sales-cold-email&groupBy=workflow");

    expect(res.status).toBe(401);
  });

  it("works with auth headers", async () => {
    mockFindMany.mockResolvedValueOnce([{ slug: "sales-cold-email", version: 1 }]);
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/stats/best?featureDynastySlug=sales-cold-email&groupBy=workflow")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body.best).toBeDefined();
  });
});
