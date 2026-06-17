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
const { __resetPublicRevenueCache, __resetPublicCostProjectionCache, __resetPublicStatsCache } = await import("./public.js");
const { BrandOwnershipError } = await import("../lib/sales-economics-client.js");
const { projectOutcomeCosts } = await import("../lib/funnel-registry.js");

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
    __resetPublicStatsCache();
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

  it("serves the second ranked call within TTL from cache (no second upstream stats fetch)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockFetchResponses();

    const r1 = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const r2 = await request(app)
      .get("/public/stats/ranked?featureSlug=sales-cold-email-outreach&objective=recipientsRepliesPositive&groupBy=workflow");

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });
});

// ── GET /public/stats/best ────────────────────────────────────────────────

describe("GET /public/stats/best", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicStatsCache();
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

  it("serves the second best call within TTL from cache (no second upstream stats fetch)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockFetchResponses();

    const r1 = await request(app).get("/public/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow");
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const r2 = await request(app).get("/public/stats/best?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });
});

// ── GET /public/stats/workflow-engagement-latency ─────────────────────────

describe("GET /public/stats/workflow-engagement-latency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicStatsCache();
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

  it("serves the second workflow-latency call within TTL from cache (no second upstream stats fetch)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockFetchResponses({
      "http://email:3000/public/stats/engagement-latency": {
        groups: [
          {
            key: "sales-outreach-alpha",
            timeToFirstLinkClick: { averageMs: 10, medianMs: 10, sampleSize: 1 },
            timeToFirstPositiveReply: { averageMs: 20, medianMs: 20, sampleSize: 1 },
          },
        ],
      },
    });

    const r1 = await request(app)
      .get("/public/stats/workflow-engagement-latency?featureSlug=sales-cold-email-outreach&groupBy=workflow");
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const r2 = await request(app)
      .get("/public/stats/workflow-engagement-latency?featureSlug=sales-cold-email-outreach&groupBy=workflow");

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
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

interface PairResult {
  pipeline: number | null;
  costUsd: number;
  timeSeries?: Array<{ date: string; cumulativePipelineUsd: number }>;
}

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
        timeSeries: v.timeSeries ?? [], organizations: [], leads: [], events: [],
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

  it("returns a public brand revenue timeline aggregated across orgs", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    setPairResults({
      "org-A::brand-1": {
        pipeline: 100,
        costUsd: 10,
        timeSeries: [
          { date: "2026-01-03T00:00:00.000Z", cumulativePipelineUsd: 30 },
          { date: "2026-01-05T00:00:00.000Z", cumulativePipelineUsd: 60 },
        ],
      },
      "org-B::brand-1": {
        pipeline: 40,
        costUsd: 5,
        timeSeries: [
          { date: "2026-01-04T00:00:00.000Z", cumulativePipelineUsd: 40 },
        ],
      },
    });
    mockRevenueFetch(
      [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-1", workflowSlug: "wf-1" },
      ],
      [{ id: "brand-1", name: "Acme", domain: "acme.com" }],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results[0].timeline).toEqual([
      { date: "2026-01-03T00:00:00.000Z", cumulativePipelineUsd: 30 },
      { date: "2026-01-04T00:00:00.000Z", cumulativePipelineUsd: 70 },
      { date: "2026-01-05T00:00:00.000Z", cumulativePipelineUsd: 100 },
    ]);
  });

  it("skips stale memberships rejected by brand ownership while keeping valid brands", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockComputeFeatureRevenue.mockImplementation(async (...args: unknown[]) => {
      const brandId = args[1] as string;
      const headers = args[4] as { orgId: string };
      if (brandId === "stale-brand") {
        throw new BrandOwnershipError(brandId, headers.orgId, "Brand does not belong to the caller's org");
      }
      return {
        headline: { totalPipelineUsd: 75 },
        costEconomics: { totalCostUsd: 5, costOfAcquisitionPct: null, roiMultiple: null },
        timeSeries: [], organizations: [], leads: [], events: [],
      };
    });
    mockRevenueFetch(
      [
        { orgId: "org-A", brandId: "stale-brand", workflowSlug: "wf-1" },
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
      ],
      [{ id: "brand-1", name: "Acme", domain: "acme.com" }],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].brand.id).toBe("brand-1");
    expect(res.body.results[0].headline.totalPipelineUsd).toBe(75);
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

// ── GET /public/stats/revenue?rollup=true ─────────────────────────────────────

describe("GET /public/stats/revenue?rollup=true", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicRevenueCache();
  });

  it("returns the slim feature-wide totalPipelineUsd, no per-brand results/timelines", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    setPairResults({
      "org-A::brand-1": { pipeline: 100, costUsd: 10 },
      "org-B::brand-1": { pipeline: 40, costUsd: 5 },
      "org-A::brand-2": { pipeline: 30, costUsd: 8 },
    });
    mockRevenueFetch(
      [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-A", brandId: "brand-2", workflowSlug: "wf-1" },
      ],
      [
        { id: "brand-1", name: "Acme", domain: "acme.com" },
        { id: "brand-2", name: "Beta", domain: "beta.io" },
      ],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand&rollup=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ featureSlug: "sales-cold-email-outreach", totalPipelineUsd: 170 }); // 140 + 30
    expect(res.body).not.toHaveProperty("results");
    expect(res.body).not.toHaveProperty("groupBy");
  });

  it("totalPipelineUsd is null when no brand has economics (all pipelines null)", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    setPairResults({ "org-A::brand-9": { pipeline: null, costUsd: 12 } });
    mockRevenueFetch(
      [{ orgId: "org-A", brandId: "brand-9", workflowSlug: "wf-1" }],
      [{ id: "brand-9", name: "NoEcon", domain: null }],
    );

    const res = await request(app).get("/public/stats/revenue?featureSlug=sales-cold-email-outreach&groupBy=brand&rollup=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ featureSlug: "sales-cold-email-outreach", totalPipelineUsd: null });
  });
});

// ── GET /public/stats/cost-projection ─────────────────────────────────────────

describe("GET /public/stats/cost-projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicCostProjectionCache();
  });

  // Brand economics (percentages, as brand-service stores them).
  const ECON_1 = { lifetimeRevenueUsd: 1000, replyToMeetingPct: 40, visitToMeetingPct: 5, meetingToClosePct: 30, visitToClosePct: 2 };
  const ECON_2 = { lifetimeRevenueUsd: 2000, replyToMeetingPct: 20, visitToMeetingPct: 10, meetingToClosePct: 50, visitToClosePct: 5 };
  // decimals for the local expected-value computation
  const e1 = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };
  const e2 = { r2m: 0.2, v2m: 0.1, m2c: 0.5, v2c: 0.05, v2s: 0.1 };
  // wf-1 cheap (clickUsd=$10/10=1, replyUsd=$10/5=2) → always best; wf-2 expensive → never best.
  const WF1 = { clickUsd: 1, replyUsd: 2 };

  it("averages each brand's best-workflow projected cost across brands; cheapest workflow wins per metric", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockCostProjectionFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-2", workflowSlug: "wf-1" },
      ],
      economicsByBrand: { "brand-1": ECON_1, "brand-2": ECON_2 },
    });

    const res = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");

    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(2);

    const p1 = projectOutcomeCosts(e1, WF1);
    const p2 = projectOutcomeCosts(e2, WF1);
    expect(res.body.avgCostPerMeetingBooked).toBeCloseTo((p1.costPerMeetingBookedUsd! + p2.costPerMeetingBookedUsd!) / 2, 5);
    expect(res.body.avgCostPerPurchase).toBeCloseTo((p1.costPerPurchaseUsd! + p2.costPerPurchaseUsd!) / 2, 5);
  });

  it("skips a brand with no economics (excluded from brandCount and the means)", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockCostProjectionFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-2", workflowSlug: "wf-1" },
      ],
      economicsByBrand: { "brand-1": ECON_1, "brand-2": null }, // brand-2 cold-start: economics null
    });

    const res = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");

    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(1);
    const p1 = projectOutcomeCosts(e1, WF1);
    expect(res.body.avgCostPerMeetingBooked).toBeCloseTo(p1.costPerMeetingBookedUsd!, 5);
    expect(res.body.avgCostPerPurchase).toBeCloseTo(p1.costPerPurchaseUsd!, 5);
  });

  it("skips a stale membership (brand-service 403) without failing the batch", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockCostProjectionFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" },
        { orgId: "org-stale", brandId: "stale-brand", workflowSlug: "wf-1" },
      ],
      economicsByBrand: { "brand-1": ECON_1, "stale-brand": "403" },
    });

    const res = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");

    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(1);
  });

  it("returns nulls + brandCount 0 when no brand has usable economics", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE);
    mockCostProjectionFetch({
      memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }],
      economicsByBrand: { "brand-1": null },
    });

    const res = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ avgCostPerMeetingBooked: null, avgCostPerPurchase: null, brandCount: 0 });
  });

  it("returns 400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/cost-projection");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/cost-projection?featureSlug=nonexistent");
    expect(res.status).toBe(404);
  });

  it("serves the second call within TTL from cache (no second economics fetch)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    const fetchSpy = mockCostProjectionFetch({
      memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }],
      economicsByBrand: { "brand-1": ECON_1 },
    });

    const r1 = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");
    const callsAfterFirst = fetchSpy.mock.calls.length;
    const r2 = await request(app).get("/public/stats/cost-projection?featureSlug=sales-cold-email-outreach");

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst); // no extra downstream calls on cache hit
  });
});

/** Drive the cost-projection endpoint's downstream HTTP calls. wf-1 cheap, wf-2 expensive (never best). */
interface MockEconomics {
  lifetimeRevenueUsd: number;
  replyToMeetingPct: number;
  visitToMeetingPct: number;
  meetingToClosePct: number;
  visitToClosePct: number;
}

function mockCostProjectionFetch(opts: {
  memberships: Array<{ orgId: string; brandId: string; workflowSlug: string }>;
  economicsByBrand: Record<string, MockEconomics | null | "403">;
}): ReturnType<typeof vi.fn> {
  const workflows = [
    { id: "w1", workflowSlug: "wf-1", workflowName: "WF One", workflowDynastyName: "WF One", workflowDynastySlug: "wf-1", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
    { id: "w2", workflowSlug: "wf-2", workflowName: "WF Two", workflowDynastyName: "WF Two", workflowDynastySlug: "wf-2", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
  ];
  const costGroups = [
    { dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: "1000", runCount: 5, minStartedAt: null, maxStartedAt: null }, // $10
    { dimensions: { workflowSlug: "wf-2" }, totalCostInUsdCents: "5000", runCount: 3, minStartedAt: null, maxStartedAt: null }, // $50
  ];
  const emailGroups = [
    { key: "wf-1", broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 10, bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } }, // clickUsd=1, replyUsd=2
    { key: "wf-2", broadcast: { recipientStats: { contacted: 20, sent: 20, delivered: 20, opened: 10, clicked: 2, bounced: 0, repliesPositive: 1, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } }, // clickUsd=25, replyUsd=50
  ];

  const spy = vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
      return new Response(JSON.stringify({ memberships: opts.memberships }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://workflow:3000/public/workflows")) {
      return new Response(JSON.stringify({ workflows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
      return new Response(JSON.stringify({ groups: costGroups }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://email:3000/public/stats")) {
      return new Response(JSON.stringify({ groups: emailGroups }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const econMatch = url.match(/http:\/\/brand:3000\/orgs\/brands\/([^/]+)\/sales-economics-effective/);
    if (econMatch) {
      const brandId = econMatch[1];
      const econ = opts.economicsByBrand[brandId];
      if (econ === "403") {
        return new Response(JSON.stringify({ error: "Brand does not belong to org" }), { status: 403 });
      }
      if (econ == null) {
        return new Response(JSON.stringify({ economics: null, source: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ economics: econ, source: "user" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  return spy as unknown as ReturnType<typeof vi.fn>;
}
