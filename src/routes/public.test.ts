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
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

// Mock the per-(org,brand) revenue engine so the public-revenue tests target the AGGREGATION
// (enumerate pairs, cross-org sum, null handling, sort, cache) — the engine itself is covered by
// revenue-engine.test.ts. buildCostEconomics + the default router stay real (importOriginal spread).
const { mockComputeFeatureRevenue } = vi.hoisted(() => ({ mockComputeFeatureRevenue: vi.fn() }));
vi.mock("./revenue.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  computeFeatureRevenue: (...args: unknown[]) => mockComputeFeatureRevenue(...args),
}));

const app = (await import("../index.js")).default;
const { __resetPublicRevenueCache } = await import("./public.js");

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
          workflowSlug: "sales-outreach-alpha",
          workflowName: "Sales Outreach Alpha",
          workflowDynastyName: "Sales Outreach Alpha",
          workflowDynastySlug: "sales-outreach-alpha",
          version: 1,
          status: "active",
          featureSlug: "sales-cold-email-outreach",
          createdForBrandId: null,
          upgradedTo: null,
        },
        {
          id: "wf-2",
          workflowSlug: "sales-outreach-beta",
          workflowName: "Sales Outreach Beta",
          workflowDynastyName: "Sales Outreach Beta",
          workflowDynastySlug: "sales-outreach-beta",
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
    "http://brand:3000/internal/brands?ids=": {
      brands: [
        { id: "brand-1", name: "Acme Corp", domain: "acme.com" },
        { id: "brand-2", name: "Beta Inc", domain: "beta.io" },
      ],
    },
    "http://journalists:3000/public/stats": {
      totalJournalists: 0,
      byOutreachStatus: {},
    },
    ...overrides,
  };

  vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [prefix, body] of Object.entries(defaults).sort((a, b) => b[0].length - a[0].length)) {
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
    expect(res.body.results[0].workflow.workflowSlug).toBe("sales-outreach-beta");
    expect(res.body.results[0].workflow.workflowName).toBe("Sales Outreach Beta");
    expect(res.body.results[0].workflow.workflowDynastySlug).toBe("sales-outreach-beta");
    expect(res.body.results[0].workflow.workflowDynastyName).toBe("Sales Outreach Beta");
    expect(res.body.results[0].workflow.version).toBe(1);
    expect(res.body.results[0].workflow.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.results[0].workflow.createdForBrandId).toBe("brand-1");
    expect(res.body.results[0].stats.recipientsRepliesPositive).toBe(20);
    expect(res.body.results[1].workflow.workflowSlug).toBe("sales-outreach-alpha");
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

  it("aggregates stats across upgrade chains using workflowSlug", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://workflow:3000/public/workflows": {
        workflows: [
          {
            id: "wf-old",
            workflowSlug: "sales-outreach-alpha",
            workflowName: "Sales Outreach Alpha",
            workflowDynastyName: "Sales Outreach Alpha",
            workflowDynastySlug: "sales-outreach-alpha",
            version: 1,
            status: "deprecated",
            featureSlug: "sales-cold-email-outreach",
            createdForBrandId: null,
            upgradedTo: "wf-new",
          },
          {
            id: "wf-new",
            workflowSlug: "sales-outreach-alpha-v2",
            workflowName: "Sales Outreach Alpha v2",
            workflowDynastyName: "Sales Outreach Alpha",
            workflowDynastySlug: "sales-outreach-alpha",
            version: 2,
            status: "active",
            featureSlug: "sales-cold-email-outreach",
            createdForBrandId: null,
            upgradedTo: null,
          },
        ],
      },
      "http://runs:3000/v1/stats/public/costs": {
        groups: [
          { dimensions: { workflowSlug: "sales-outreach-alpha" }, totalCostInUsdCents: "1000", runCount: 5, minStartedAt: null, maxStartedAt: null },
          { dimensions: { workflowSlug: "sales-outreach-alpha-v2" }, totalCostInUsdCents: "2000", runCount: 8, minStartedAt: null, maxStartedAt: null },
        ],
      },
      "http://email:3000/public/stats": {
        groups: [
          { key: "sales-outreach-alpha", broadcast: { recipientStats: { repliesPositive: 10, sent: 100 } } },
          { key: "sales-outreach-alpha-v2", broadcast: { recipientStats: { repliesPositive: 20, sent: 200 } } },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].workflow.workflowSlug).toBe("sales-outreach-alpha-v2");
    expect(res.body.results[0].stats.recipientsRepliesPositive).toBe(30);
    expect(res.body.results[0].stats.recipientsSent).toBe(300);
    expect(res.body.results[0].stats.completedRuns).toBe(13);
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(3000);
  });

  it("populates recipient/email + cost stats even when the journalists family fails (one family reject does not zero the others)", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // Independent journalists family is DOWN (mirrors the prod incident: instantly-service
      // outage → journalists-service 500). The email/recipient + cost families are healthy.
      if (url.startsWith("http://journalists:3000/public/stats")) {
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
      }
      if (url.startsWith("http://workflow:3000/public/workflows")) {
        return new Response(JSON.stringify({ workflows: [
          { id: "wf-1", workflowSlug: "sales-outreach-alpha", workflowName: "Sales Outreach Alpha", workflowDynastyName: "Sales Outreach Alpha", workflowDynastySlug: "sales-outreach-alpha", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
        return new Response(JSON.stringify({ groups: [
          { dimensions: { workflowSlug: "sales-outreach-alpha" }, totalCostInUsdCents: "1000", runCount: 5, minStartedAt: null, maxStartedAt: null },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("http://email:3000/public/stats")) {
        return new Response(JSON.stringify({ groups: [
          { key: "sales-outreach-alpha", broadcast: { recipientStats: { repliesPositive: 10, sent: 100, delivered: 90, opened: 50, clicked: 12 } } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    const res = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    // Sales recipient/email stats STILL populate despite the journalists 500 — the bug fixed.
    expect(res.body.results[0].stats.recipientsRepliesPositive).toBe(10);
    expect(res.body.results[0].stats.recipientsSent).toBe(100);
    expect(res.body.results[0].stats.recipientsDelivered).toBe(90);
    expect(res.body.results[0].stats.recipientsOpened).toBe(50);
    expect(res.body.results[0].stats.recipientsClicked).toBe(12);
    // Cost path survives too.
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(1000);
    expect(res.body.results[0].stats.completedRuns).toBe(5);
    // The failed family is logged loudly with context (fail loud, not silently swallowed).
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('outcome stat family "journalists" failed'),
      expect.anything(),
    );

    errSpy.mockRestore();
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

    const brandCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("http://brand:3000/"),
    );
    expect(brandCalls).toHaveLength(1);
    expect(brandCalls[0][0]).toBe("http://brand:3000/internal/brands?ids=brand-2,brand-1");
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

// ── GET /public/stats/workflow-engagement-latency ─────────────────────────

describe("GET /public/stats/workflow-engagement-latency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns public per-workflow average and median time to click and positive reply", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats/engagement-latency": {
        groups: [
          {
            key: "sales-outreach-alpha",
            timeToFirstLinkClick: { averageMs: 86_400_000, medianMs: 43_200_000, sampleSize: 4 },
            timeToFirstPositiveReply: { averageMs: 172_800_000, medianMs: 129_600_000, sampleSize: 3 },
          },
          {
            key: "sales-outreach-beta",
            timeToFirstLinkClick: { averageMs: null, medianMs: null, sampleSize: 0 },
            timeToFirstPositiveReply: { averageMs: 259_200_000, medianMs: 259_200_000, sampleSize: 1 },
          },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/workflow-engagement-latency?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.groupBy).toBe("workflow");
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].workflow.workflowSlug).toBe("sales-outreach-alpha");
    expect(res.body.results[0].workflow.workflowName).toBe("Sales Outreach Alpha");
    expect(res.body.results[0].timeToFirstLinkClick).toEqual({ averageMs: 86_400_000, medianMs: 43_200_000, sampleSize: 4 });
    expect(res.body.results[0].timeToFirstPositiveReply).toEqual({ averageMs: 172_800_000, medianMs: 129_600_000, sampleSize: 3 });
    expect(res.body.results[1].timeToFirstLinkClick).toEqual({ averageMs: null, medianMs: null, sampleSize: 0 });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0] as string);
    expect(calls).toContain("http://email:3000/public/stats/engagement-latency?featureSlugs=sales-cold-email-outreach&groupBy=workflowSlug");
  });

  it("filters unknown producer keys so public output only contains workflow identity", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats/engagement-latency": {
        groups: [
          {
            key: "sales-outreach-alpha",
            timeToFirstLinkClick: { averageMs: 10, medianMs: 10, sampleSize: 1 },
            timeToFirstPositiveReply: { averageMs: 20, medianMs: 20, sampleSize: 1 },
          },
          {
            key: "lead@example.com",
            timeToFirstLinkClick: { averageMs: 1, medianMs: 1, sampleSize: 1 },
            timeToFirstPositiveReply: { averageMs: 1, medianMs: 1, sampleSize: 1 },
          },
        ],
      },
    });

    const res = await request(app)
      .get("/public/stats/workflow-engagement-latency?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("lead@example.com");
  });

  it("returns 400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/workflow-engagement-latency?groupBy=workflow");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("returns 400 when groupBy is not workflow", async () => {
    const res = await request(app).get("/public/stats/workflow-engagement-latency?featureSlug=sales-cold-email-outreach&groupBy=brand");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workflow/i);
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/workflow-engagement-latency?featureSlug=nonexistent&groupBy=workflow");
    expect(res.status).toBe(404);
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

// ── GET /public/stats/revenue ─────────────────────────────────────────────

interface PairResult { pipeline: number | null; costUsd: number }

/** Drive the mocked engine: one deterministic result per `${orgId}::${brandId}`. */
function setPairResults(pairs: Record<string, PairResult>): void {
  mockComputeFeatureRevenue.mockImplementation(
    async (...args: unknown[]) => {
      const brandId = args[1] as string;
      const headers = args[4] as { orgId: string };
      const v = pairs[`${headers.orgId}::${brandId}`] ?? { pipeline: 0, costUsd: 0 };
      return {
        headline: { totalPipelineUsd: v.pipeline },
        costEconomics: { totalCostUsd: v.costUsd, costOfAcquisitionPct: null, roiMultiple: null },
        timeSeries: [], organizations: [], leads: [], events: [],
      };
    },
  );
}

function mockRevenueFetch(
  memberships: Array<{ orgId: string; brandId: string; workflowSlug: string }>,
  brands: Array<{ id: string; name: string | null; domain: string | null }>,
): void {
  vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
      return new Response(JSON.stringify({ memberships }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://brand:3000/internal/brands")) {
      return new Response(JSON.stringify({ brands }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}

describe("GET /public/stats/revenue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicRevenueCache();
  });

  it("returns per-brand cross-org pipeline + CAC + ROI, sorted by pipeline desc", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    setPairResults({
      "org-A::brand-1": { pipeline: 100, costUsd: 10 },
      "org-B::brand-1": { pipeline: 40, costUsd: 5 },
      "org-A::brand-2": { pipeline: 30, costUsd: 8 },
    });
    mockRevenueFetch(
      [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-2" }, // same pair → one compute
        { orgId: "org-B", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-A", brandId: "brand-2", workflowSlug: "wf-1" },
      ],
      [
        { id: "brand-1", name: "Acme", domain: "acme.com" },
        { id: "brand-2", name: "Beta", domain: "beta.io" },
      ],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe("brand");
    expect(res.body.results).toHaveLength(2);

    // brand-1 = 100 + 40 across its two orgs (no double-count), highest → first
    const b1 = res.body.results[0];
    expect(b1.brand.id).toBe("brand-1");
    expect(b1.brand.name).toBe("Acme");
    expect(b1.headline.totalPipelineUsd).toBe(140);
    expect(b1.costEconomics.totalCostUsd).toBe(15); // 10 + 5
    expect(b1.costEconomics.roiMultiple).toBeCloseTo(140 / 15, 5);
    expect(b1.costEconomics.costOfAcquisitionPct).toBeCloseTo((15 / 140) * 100, 5);

    const b2 = res.body.results[1];
    expect(b2.brand.id).toBe("brand-2");
    expect(b2.headline.totalPipelineUsd).toBe(30);
    expect(b2.costEconomics.totalCostUsd).toBe(8);

    // 3 distinct (org, brand) pairs → engine called exactly 3 times (not 4 — wf rows deduped)
    expect(mockComputeFeatureRevenue).toHaveBeenCalledTimes(3);
    for (const call of mockComputeFeatureRevenue.mock.calls) {
      const headers = call[4] as Record<string, unknown>;
      expect(headers).toMatchObject({ featureSlug: "sales-cold-email-outreach" });
      expect(headers).not.toHaveProperty("userId");
      expect(headers).not.toHaveProperty("runId");
    }
  });

  it("null pipeline when a brand has no economics; cost present, ratios null", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    setPairResults({ "org-A::brand-9": { pipeline: null, costUsd: 12 } });
    mockRevenueFetch(
      [{ orgId: "org-A", brandId: "brand-9", workflowSlug: "wf-1" }],
      [{ id: "brand-9", name: "NoEcon", domain: null }],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].headline.totalPipelineUsd).toBeNull();
    expect(res.body.results[0].costEconomics.totalCostUsd).toBe(12);
    expect(res.body.results[0].costEconomics.roiMultiple).toBeNull();
    expect(res.body.results[0].costEconomics.costOfAcquisitionPct).toBeNull();
  });

  it("returns 400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/revenue?groupBy=brand");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("returns 400 when groupBy is not 'brand'", async () => {
    // groupBy is validated before the feature lookup — no findFirst mock (a queued Once would
    // leak into the next test, since clearAllMocks does not drain the mockResolvedValueOnce queue).
    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=workflow");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand/i);
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/revenue?featureSlug=nonexistent&groupBy=brand");
    expect(res.status).toBe(404);
  });

  it("serves the second call within TTL from cache (engine not re-run)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    setPairResults({ "org-A::brand-1": { pipeline: 50, costUsd: 4 } });
    mockRevenueFetch(
      [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }],
      [{ id: "brand-1", name: "Acme", domain: "acme.com" }],
    );

    const r1 = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");
    const r2 = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(mockComputeFeatureRevenue).toHaveBeenCalledTimes(1); // second served from cache
  });
});
