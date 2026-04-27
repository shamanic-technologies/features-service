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
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.JOURNALISTS_SERVICE_URL = "http://journalists:3000";
process.env.JOURNALISTS_SERVICE_API_KEY = "journalists-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

// ── GET /public/features ──────────────────────────────────────────────────

describe("GET /public/features", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns active features, no auth required", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "1", slug: "sales-cold-email-outreach", name: "Sales Cold Email Outreach", description: "test", status: "active" },
    ]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].slug).toBe("sales-cold-email-outreach");
  });

  it("returns empty array when no active features", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toEqual([]);
  });
});

// ── Helpers for ranked/best tests ─────────────────────────────────────────

const MOCK_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  description: "test",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockFetchResponses(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
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
          featureSlug: "sales-cold-email-outreach",
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
          featureSlug: "sales-cold-email-outreach",
          createdForBrandId: "brand-1",
          upgradedTo: null,
        },
      ],
    },
    "http://runs:3000/v1/stats/public/costs": {
      groups: [
        { dimensions: { workflowSlug: "sales-outreach-alpha" }, totalCostInUsdCents: "1000", runCount: 5, minStartedAt: null, maxStartedAt: null },
        { dimensions: { workflowSlug: "sales-outreach-beta" }, totalCostInUsdCents: "2000", runCount: 8, minStartedAt: null, maxStartedAt: null },
      ],
    },
    "http://email:3000/public/stats": {
      groups: [
        { key: "sales-outreach-alpha", broadcast: { recipientStats: { repliesPositive: 10, sent: 100, delivered: 90, opened: 50 } } },
        { key: "sales-outreach-beta", broadcast: { recipientStats: { repliesPositive: 20, sent: 80, delivered: 70, opened: 40 } } },
      ],
    },
    "http://brand:3000/internal/brands/brand-1": {
      brand: { id: "brand-1", name: "Acme Corp", domain: "acme.com" },
    },
    "http://brand:3000/internal/brands/brand-2": {
      brand: { id: "brand-2", name: "Beta Inc", domain: "beta.io" },
    },
    "http://journalists:3000/public/stats": {
      totalJournalists: 0,
      byOutreachStatus: {},
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

  it("returns workflows ranked by objective value descending", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("recipientsRepliesPositive");
    expect(res.body.sortDirection).toBe("desc");
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].workflow.slug).toBe("sales-outreach-beta");
    expect(res.body.results[0].stats.recipientsRepliesPositive).toBe(20);
    expect(res.body.results[1].workflow.slug).toBe("sales-outreach-alpha");
  });

  it("defaults objective to costPerRecipientPositiveReplyCents when not provided", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("costPerRecipientPositiveReplyCents");
  });

  it("returns 400 when featureSlug is missing", async () => {
    const res = await request(app)
      .get("/public/stats/ranked?objective=recipientsRepliesPositive&groupBy=workflow");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("returns 400 when groupBy is missing", async () => {
    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groupBy/i);
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=nonexistent&objective=recipientsRepliesPositive&groupBy=workflow");

    expect(res.status).toBe(404);
  });

  it("respects limit parameter", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow&limit=1");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it("does not cap limit at 100 (regression: no hidden upper bound)", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow&limit=200");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it("supports groupBy=brand with enriched brand info", async () => {
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
          { key: "brand-1", broadcast: { recipientStats: { repliesPositive: 5, sent: 50, opened: 25 } } },
          { key: "brand-2", broadcast: { recipientStats: { repliesPositive: 15, sent: 60, opened: 30 } } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].brand.id).toBe("brand-2");
    expect(res.body.results[0].brand.name).toBe("Beta Inc");
    expect(res.body.results[0].stats.recipientsRepliesPositive).toBe(15);
  });
});

// ── GET /public/stats/best ────────────────────────────────────────────────

describe("GET /public/stats/best", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns best workflow per count-type metric", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/public/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.best.recipientsRepliesPositive).not.toBeNull();
    expect(res.body.best.recipientsRepliesPositive.value).toBe(100);
  });

  it("returns 400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/best?groupBy=workflow");
    expect(res.status).toBe(400);
  });

  it("returns 400 when groupBy is missing", async () => {
    const res = await request(app).get("/public/stats/best?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(400);
  });

  it("returns null for metrics with no data", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats": {
        groups: [
          { key: "sales-outreach-alpha", broadcast: { recipientStats: { repliesPositive: 0, sent: 0, opened: 0 } } },
          { key: "sales-outreach-beta", broadcast: { recipientStats: { repliesPositive: 0, sent: 0, opened: 0 } } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.best.recipientsRepliesPositive).toBeNull();
  });
});

// ── Authenticated ranked/best ───────────────────────────────────────────

describe("GET /stats/ranked (authenticated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires auth headers", async () => {
    const res = await request(app)
      .get("/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");
    expect(res.status).toBe(401);
  });

  it("works with auth headers", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow")
      .set(AUTH_HEADERS);

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
      .get("/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow");
    expect(res.status).toBe(401);
  });

  it("works with auth headers", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses();

    const res = await request(app)
      .get("/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.best).toBeDefined();
  });
});
