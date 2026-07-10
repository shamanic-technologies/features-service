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

// Send-forecast: the two email-gateway reads + the fleet series-3 aggregation are unit-tested at
// their own boundaries (send-forecast-client / -aggregate / -compute). Mock them here so the public
// route test targets the WIRING (route → handler → buildSendForecast → response shape + cache).
const { mockEmailsSent, mockSendingForecast, mockAggregate } = vi.hoisted(() => ({
  mockEmailsSent: vi.fn(),
  mockSendingForecast: vi.fn(),
  mockAggregate: vi.fn(),
}));
vi.mock("../lib/send-forecast-client.js", () => ({
  fetchFleetEmailsSentByDay: (...a: unknown[]) => mockEmailsSent(...a),
  fetchFleetSendingForecast: (...a: unknown[]) => mockSendingForecast(...a),
}));
vi.mock("../lib/send-forecast-aggregate.js", () => ({
  aggregateFleetNewSequences: (...a: unknown[]) => mockAggregate(...a),
}));

const app = (await import("../index.js")).default;
const { __resetPublicRevenueCache, __resetPublicCostProjectionCache, __resetPublicStatsCache, __resetSendForecastCache, __resetCostPerOutcomeTrendCache, __resetWorkflowCostPerOutcomeCache, __awaitWorkflowRecentWarm, __resetCostPerOutcomeLifetimeCache, __resetCostPerOutcomeDistributionCache, __resetGoalBucketDatasetCache } = await import("./public.js");
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
        costEconomics: { actualCostUsd: v.costUsd, costOfAcquisitionPct: null, roiMultiple: null },
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
    expect(b1.costEconomics.actualCostUsd).toBe(15); // 10 + 5
    expect(b1.costEconomics.roiMultiple).toBeCloseTo(140 / 15, 5);
    expect(b1.costEconomics.costOfAcquisitionPct).toBeCloseTo((15 / 140) * 100, 5);

    const b2 = res.body.results[1];
    expect(b2.brand.id).toBe("brand-2");
    expect(b2.headline.totalPipelineUsd).toBe(30);
    expect(b2.costEconomics.actualCostUsd).toBe(8);

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
    expect(res.body.results[0].costEconomics.actualCostUsd).toBe(12);
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
        costEconomics: { actualCostUsd: 5, costOfAcquisitionPct: null, roiMultiple: null },
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
    // Gap #1: all-objective averages; legacy top-level fields are byte-equal aliases + CPC/CPPR = min unit cost.
    expect(res.body.avgCostPerOutcomeByObjective.meetingBooked).toBe(res.body.avgCostPerMeetingBooked);
    expect(res.body.avgCostPerOutcomeByObjective.purchase).toBe(res.body.avgCostPerPurchase);
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(1, 5); // cheapest clickUsd = $10/10
    expect(res.body.avgCostPerOutcomeByObjective.positiveReply).toBeCloseTo(2, 5); // cheapest replyUsd = $10/5
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

// ── GET /public/stats/cost-per-outcome-trend + /workflow-cost-per-outcome ──────

describe("GET /public/stats/cost-per-outcome-trend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetCostPerOutcomeTrendCache();
  });

  it("400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/cost-per-outcome-trend?objective=signup");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("400 when objective is missing or unknown", async () => {
    const missing = await request(app).get("/public/stats/cost-per-outcome-trend?featureSlug=sales-cold-email-outreach");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/objective/i);
    const bad = await request(app).get("/public/stats/cost-per-outcome-trend?featureSlug=sales-cold-email-outreach&objective=nope");
    expect(bad.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/cost-per-outcome-trend?featureSlug=nope&objective=signup");
    expect(res.status).toBe(404);
  });
});

describe("GET /public/stats/workflow-cost-per-outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetWorkflowCostPerOutcomeCache();
  });

  it("400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/workflow-cost-per-outcome?objective=websiteVisit");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("400 when objective is missing or unknown", async () => {
    const missing = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/objective/i);
  });

  it("404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=nope&objective=websiteVisit");
    expect(res.status).toBe(404);
  });

  it("serves the lifetime rate immediately, then warms the recent trailing-window rate off the request path", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    const today = new Date().toISOString().slice(0, 10);
    const mkJson = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
        return mkJson({ memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }] });
      }
      if (url.startsWith("http://workflow:3000/public/workflows")) {
        return mkJson({ workflows: [{ id: "w1", workflowSlug: "wf-1", workflowName: "WF One", workflowDynastyName: "WF One", workflowDynastySlug: "wf-1", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null }] });
      }
      // Per-dynasty RECENT dated spend: $10 today (route matches /timeseries BEFORE the lifetime /costs branch).
      if (url.startsWith("http://runs:3000/v1/stats/public/costs/timeseries")) {
        return mkJson({ buckets: [{ period: today, totalCostInUsdCents: "1000", actualCostInUsdCents: "1000", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", runCount: 1 }] });
      }
      // Lifetime spend by workflowSlug: $200.
      if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
        return mkJson({ groups: [{ dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: "20000", runCount: 5, minStartedAt: null, maxStartedAt: null }] });
      }
      if (url.startsWith("http://email:3000/public/stats")) {
        const groupBy = new URL(url).searchParams.get("groupBy");
        if (groupBy === "day") {
          // RECENT dated outcomes for this dynasty: 10 clicks today → recent CPC = $10 / 10 = $1.
          return mkJson({ groups: [{ key: today, broadcast: { recipientStats: { clicked: 10, repliesPositive: 0 } } }] });
        }
        // Lifetime by workflowSlug: 100 clicks → lifetime CPC = $200 / 100 = $2.
        return mkJson({ groups: [{ key: "wf-1", broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 100, bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } }] });
      }
      if (/\/orgs\/brands\/[^/]+\/sales-economics-effective/.test(url)) {
        return mkJson({ economics: ECON_FULL, source: "user" });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    const res = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(res.status).toBe(200);
    expect(res.body.windowOutcomes).toBe(100);
    expect(res.body.workflows).toHaveLength(1);
    const row = res.body.workflows[0];
    expect(row.workflowDynastySlug).toBe("wf-1");
    // Lifetime pooled rate (all-history) is served IMMEDIATELY: $200 / 100 clicks = $2 — UNCHANGED.
    expect(row.costPerOutcomeUsd).toBeCloseTo(2, 6);
    // The recent rate's per-dynasty dated fan-out is warmed OFF the request path (so it can't 500/timeout
    // the response), so the FIRST read carries recent=null — never a false $0.
    expect(row.recentCostPerOutcomeUsd).toBeNull();

    // After the background warm settles, a follow-up read (cache hit) carries the populated trailing-window
    // rate: today's window $10 / 10 clicks = $1 — the NEW field, distinct from the lifetime $2.
    await __awaitWorkflowRecentWarm();
    const warmed = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(warmed.status).toBe(200);
    expect(warmed.body.workflows[0].costPerOutcomeUsd).toBeCloseTo(2, 6);
    expect(warmed.body.workflows[0].recentCostPerOutcomeUsd).toBeCloseTo(1, 6);
  });

  it("recentCostPerOutcomeUsd is null (never a false $0) when the dynasty has no recent window", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    const mkJson = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
        return mkJson({ memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }] });
      }
      if (url.startsWith("http://workflow:3000/public/workflows")) {
        return mkJson({ workflows: [{ id: "w1", workflowSlug: "wf-1", workflowName: "WF One", workflowDynastyName: "WF One", workflowDynastySlug: "wf-1", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null }] });
      }
      // No recent dated spend/outcomes at all → unbacked recent window.
      if (url.startsWith("http://runs:3000/v1/stats/public/costs/timeseries")) {
        return mkJson({ buckets: [] });
      }
      if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
        return mkJson({ groups: [{ dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: "20000", runCount: 5, minStartedAt: null, maxStartedAt: null }] });
      }
      if (url.startsWith("http://email:3000/public/stats")) {
        const groupBy = new URL(url).searchParams.get("groupBy");
        if (groupBy === "day") return mkJson({ groups: [] });
        return mkJson({ groups: [{ key: "wf-1", broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 100, bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } }] });
      }
      if (/\/orgs\/brands\/[^/]+\/sales-economics-effective/.test(url)) {
        return mkJson({ economics: ECON_FULL, source: "user" });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    const res = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(res.status).toBe(200);
    const row = res.body.workflows[0];
    expect(row.costPerOutcomeUsd).toBeCloseTo(2, 6); // lifetime still populated
    expect(row.recentCostPerOutcomeUsd).toBeNull();   // recent unbacked → null, not $0

    // Settle the background warm (empty buckets → still null) so teardown doesn't restore mocks mid-fan-out.
    await __awaitWorkflowRecentWarm();
    const warmed = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(warmed.body.workflows[0].recentCostPerOutcomeUsd).toBeNull(); // unbacked stays null after warm
  });

  it("one dynasty's recent fan-out failing does NOT null the OTHER dynasty's recent rate (per-dynasty resilient warm)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    const today = new Date().toISOString().slice(0, 10);
    const mkJson = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
        return mkJson({ memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }] });
      }
      if (url.startsWith("http://workflow:3000/public/workflows")) {
        return mkJson({ workflows: [
          { id: "w1", workflowSlug: "wf-1", workflowName: "WF One", workflowDynastyName: "WF One", workflowDynastySlug: "wf-1", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
          { id: "w2", workflowSlug: "wf-2", workflowName: "WF Two", workflowDynastyName: "WF Two", workflowDynastySlug: "wf-2", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
        ] });
      }
      // Per-dynasty RECENT dated spend: wf-1 succeeds ($10 today); wf-2's timeseries fan-out 500s (transient
      // cold-Neon failure) — it must NOT null wf-1's recent rate.
      if (url.startsWith("http://runs:3000/v1/stats/public/costs/timeseries")) {
        const dyn = new URL(url).searchParams.get("workflowDynastySlug");
        if (dyn === "wf-2") return new Response("boom", { status: 500 });
        return mkJson({ buckets: [{ period: today, totalCostInUsdCents: "1000", actualCostInUsdCents: "1000", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", runCount: 1 }] });
      }
      // Lifetime spend by workflowSlug: $200 each → lifetime CPC = $2 for both.
      if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
        return mkJson({ groups: [
          { dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: "20000", runCount: 5, minStartedAt: null, maxStartedAt: null },
          { dimensions: { workflowSlug: "wf-2" }, totalCostInUsdCents: "20000", runCount: 5, minStartedAt: null, maxStartedAt: null },
        ] });
      }
      if (url.startsWith("http://email:3000/public/stats")) {
        const groupBy = new URL(url).searchParams.get("groupBy");
        if (groupBy === "day") {
          // RECENT dated outcomes: 10 clicks today for either dynasty → recent CPC = $10 / 10 = $1.
          return mkJson({ groups: [{ key: today, broadcast: { recipientStats: { clicked: 10, repliesPositive: 0 } } }] });
        }
        return mkJson({ groups: [
          { key: "wf-1", broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 100, bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } },
          { key: "wf-2", broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 100, bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } },
        ] });
      }
      if (/\/orgs\/brands\/[^/]+\/sales-economics-effective/.test(url)) {
        return mkJson({ economics: ECON_FULL, source: "user" });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    const first = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(first.status).toBe(200);
    expect(first.body.workflows).toHaveLength(2);

    await __awaitWorkflowRecentWarm();
    const warmed = await request(app).get("/public/stats/workflow-cost-per-outcome?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(warmed.status).toBe(200);
    const byDynasty = Object.fromEntries(warmed.body.workflows.map((w: { workflowDynastySlug: string; recentCostPerOutcomeUsd: number | null }) => [w.workflowDynastySlug, w.recentCostPerOutcomeUsd]));
    // wf-1 populated despite wf-2's fan-out failing — the batch is NOT all-null.
    expect(byDynasty["wf-1"]).toBeCloseTo(1, 6);
    // wf-2 degrades to null (its transient failure), retried next cycle — never a false $0.
    expect(byDynasty["wf-2"]).toBeNull();
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

// ── Goal-bucketed cost surfaces (trend + lifetime) shared fetch mock ───────────

interface MockBrandData {
  /** brand-service stored optimizationGoal spelling, or null when the brand has no saved economics. */
  goal: string | null;
  econ: MockEconomics & { visitToSignupPct?: number };
  /** This brand's dated spend (runs timeseries, brandId-filtered). */
  spendBuckets: Array<{ period: string; totalCostInUsdCents: string }>;
  /** This brand's dated clicks / positive replies (email day stats, brandId-filtered). */
  dayOutcomes: Array<{ key: string; clicked: number; repliesPositive: number }>;
}

/** Mocks the goal-bucketed data path: memberships, per-brand saved economics + goal (brand-service
 * INTERNAL sales-economics), per-brand dated spend (runs timeseries, brandId-filtered) + per-brand
 * dated outcomes (email day stats, brandId-filtered). Both the trend + lifetime surfaces read this. */
function mockBucketedFetch(opts: {
  memberships: Array<{ orgId: string; brandId: string; workflowSlug: string }>;
  brands: Record<string, MockBrandData>;
}): ReturnType<typeof vi.fn> {
  const brandOf = (url: string): string | null => new URL(url).searchParams.get("brandId");
  const spy = vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
      return new Response(JSON.stringify({ memberships: opts.memberships }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const savedMatch = url.match(/http:\/\/brand:3000\/internal\/brands\/([^/]+)\/sales-economics/);
    if (savedMatch) {
      const b = opts.brands[savedMatch[1]];
      if (!b || b.goal == null) {
        return new Response(JSON.stringify({ salesEconomics: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ salesEconomics: { ...b.econ, optimizationGoal: b.goal } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://runs:3000/v1/stats/public/costs/timeseries")) {
      const b = brandOf(url) ? opts.brands[brandOf(url)!] : undefined;
      return new Response(JSON.stringify({ buckets: b?.spendBuckets ?? [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://email:3000/public/stats")) {
      const b = brandOf(url) ? opts.brands[brandOf(url)!] : undefined;
      const groups = (b?.dayOutcomes ?? []).map((d) => ({ key: d.key, broadcast: { recipientStats: { clicked: d.clicked, repliesPositive: d.repliesPositive } } }));
      return new Response(JSON.stringify({ groups }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  return spy as unknown as ReturnType<typeof vi.fn>;
}

const ECON_FULL = { lifetimeRevenueUsd: 1000, replyToMeetingPct: 40, visitToMeetingPct: 5, meetingToClosePct: 30, visitToClosePct: 2, visitToSignupPct: 20 };

describe("GET /public/stats/cost-per-outcome-trend (goal-bucketed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetCostPerOutcomeTrendCache();
    __resetGoalBucketDatasetCache();
  });

  it("CPC window sums ONLY click-driven brands — a positiveReply brand's spend/clicks are excluded", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-visit", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-reply", workflowSlug: "wf-2" },
      ],
      brands: {
        // click-driven brand: $200 for 100 clicks → CPC 2
        "brand-visit": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
        // reply-driven brand: heavy spend, MUST NOT dilute CPC
        "brand-reply": { goal: "positive_replies", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "999900" }], dayOutcomes: [{ key: "2026-07-08", clicked: 0, repliesPositive: 40 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-trend?featureSlug=sales-cold-email-outreach&objective=websiteVisit&windowOutcomes=50");
    expect(res.status).toBe(200);
    const latest = res.body.points.at(-1);
    expect(latest.windowSpentUsd).toBeCloseTo(200, 6); // reply brand's $9999 excluded
    expect(latest.windowOutcomeCount).toBe(100);
    expect(latest.costPerOutcomeUsd).toBeCloseTo(2, 6);
  });
});

describe("GET /public/stats/cost-per-outcome-lifetime (goal-bucketed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetCostPerOutcomeLifetimeCache();
    __resetGoalBucketDatasetCache();
  });

  it("each objective pools ONLY its bucket's brands — CPC excludes the reply brand's spend", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-visit", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-reply", workflowSlug: "wf-2" },
      ],
      brands: {
        "brand-visit": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "40000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 200, repliesPositive: 0 }] },
        "brand-reply": { goal: "positive_replies", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "90000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 0, repliesPositive: 30 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(2);
    expect(res.body.totalSpentUsd).toBeCloseTo(1300, 6); // 400 + 900 (all bucketable brands)
    // CPC pools the visit brand ONLY: 400/200 = 2 (the reply brand's $900 is NOT in the CPC bucket)
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(2, 6);
    // CPPR pools the reply brand ONLY: 900/30 = 30
    expect(res.body.avgCostPerOutcomeByObjective.positiveReply).toBeCloseTo(30, 6);
    // no signup/meeting brand → those buckets are empty → null (never a false $0)
    expect(res.body.avgCostPerOutcomeByObjective.signup).toBeNull();
    expect(res.body.avgCostPerOutcomeByObjective.meetingBooked).toBeNull();
  });

  it("projected objective populated when its bucket has a backed brand (signup)", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [{ orgId: "org-A", brandId: "brand-signup", workflowSlug: "wf-1" }],
      brands: {
        "brand-signup": { goal: "signups", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(200);
    // signup goal is in the CPC bucket AND the signup bucket
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(2, 6); // 200/100
    expect(res.body.avgCostPerOutcomeByObjective.signup).toBeGreaterThan(0);
    expect(res.body.avgCostPerOutcomeByObjective.positiveReply).toBeNull(); // no reply brand
  });

  it("null (never a false $0) per objective when there are zero outcomes", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [{ orgId: "org-A", brandId: "brand-visit", workflowSlug: "wf-1" }],
      brands: {
        "brand-visit": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 0, repliesPositive: 0 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(200);
    expect(res.body.totalSpentUsd).toBeCloseTo(200, 6);
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeNull();
    expect(res.body.avgCostPerOutcomeByObjective.positiveReply).toBeNull();
    expect(res.body.avgCostPerOutcomeByObjective.signup).toBeNull();
  });

  it("a brand with no saved goal/economics is omitted from every bucket", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [
        { orgId: "org-A", brandId: "brand-visit", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "brand-nogoal", workflowSlug: "wf-2" },
      ],
      brands: {
        "brand-visit": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
        "brand-nogoal": { goal: null, econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "500000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 999, repliesPositive: 0 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(1); // brand-nogoal dropped
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(2, 6); // 200/100, unaffected by the dropped brand
  });

  it("400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/cost-per-outcome-lifetime?featureSlug=nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /public/stats/cost-per-outcome-distribution (goal-bucketed, per-brand)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetCostPerOutcomeDistributionCache();
    __resetGoalBucketDatasetCache();
  });

  it("histogram + stats over per-brand CPCs, only click-driven brands contribute", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [
        { orgId: "org-A", brandId: "b-visit-1", workflowSlug: "wf-1" },
        { orgId: "org-B", brandId: "b-visit-2", workflowSlug: "wf-2" },
        { orgId: "org-C", brandId: "b-reply", workflowSlug: "wf-3" },
      ],
      brands: {
        // CPC 2 (200/100) and CPC 6 (600/100)
        "b-visit-1": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
        "b-visit-2": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "60000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
        // reply-driven brand — excluded from the CPC distribution
        "b-reply": { goal: "positive_replies", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "999900" }], dayOutcomes: [{ key: "2026-07-08", clicked: 0, repliesPositive: 40 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-distribution?featureSlug=sales-cold-email-outreach&objective=websiteVisit&buckets=4");
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe("brand");
    expect(res.body.objective).toBe("websiteVisit");
    expect(res.body.brandCount).toBe(2); // reply brand excluded
    expect(res.body.min).toBeCloseTo(2, 6);
    expect(res.body.max).toBeCloseTo(6, 6);
    expect(res.body.mean).toBeCloseTo(4, 6);
    expect(res.body.buckets).toHaveLength(4);
    expect(res.body.buckets.reduce((a: number, b: { count: number }) => a + b.count, 0)).toBe(2);
    // no per-brand id/value leaks on the public payload
    expect(JSON.stringify(res.body)).not.toContain("b-visit-1");
  });

  it("empty/soft when fewer than 2 brands have a usable cost — buckets [], scalars null, never a false $0", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    mockBucketedFetch({
      memberships: [{ orgId: "org-A", brandId: "b-visit-1", workflowSlug: "wf-1" }],
      brands: {
        "b-visit-1": { goal: "website_visits", econ: ECON_FULL, spendBuckets: [{ period: "2026-07-08", totalCostInUsdCents: "20000" }], dayOutcomes: [{ key: "2026-07-08", clicked: 100, repliesPositive: 0 }] },
      },
    });

    const res = await request(app).get("/public/stats/cost-per-outcome-distribution?featureSlug=sales-cold-email-outreach&objective=websiteVisit");
    expect(res.status).toBe(200);
    expect(res.body.brandCount).toBe(1);
    expect(res.body.buckets).toEqual([]);
    expect(res.body.mean).toBeNull();
    expect(res.body.median).toBeNull();
    expect(res.body.min).toBeNull();
  });

  it("400 when objective is missing/invalid", async () => {
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
    const res = await request(app).get("/public/stats/cost-per-outcome-distribution?featureSlug=sales-cold-email-outreach");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objective/i);
  });

  it("400 when featureSlug is missing", async () => {
    const res = await request(app).get("/public/stats/cost-per-outcome-distribution?objective=websiteVisit");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug/i);
  });

  it("404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get("/public/stats/cost-per-outcome-distribution?featureSlug=nope&objective=websiteVisit");
    expect(res.status).toBe(404);
  });
});

describe("GET /internal/stats/send-forecast", () => {
  const KEY = { "x-api-key": "test-key" };
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSendForecastCache();
    mockFindMany.mockResolvedValue([
      { slug: "sales-cold-email-outreach" },
      { slug: "outlet-database-discovery" }, // non-cold-email → filtered out
    ]);
    mockEmailsSent.mockResolvedValue(new Map<string, number>());
    mockSendingForecast.mockResolvedValue(new Map<string, number>());
    mockAggregate.mockResolvedValue({
      totalNewPerDay: 100,
      todayNewOverride: 40,
      totalDailyBudgetUsd: 500,
      remainingTodayUsd: 200,
      activeBrandCount: 3,
    });
  });

  it("returns the three-series forecast + summary with the D0/D3/D10 model", async () => {
    const res = await request(app).get("/internal/stats/send-forecast?days=14").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      totalDailyBudgetUsd: 500,
      remainingTodayUsd: 200,
      followupModel: "D0/D3/D10",
      activeBrandCount: 3,
      totalNewSequencesPerDay: 100,
    });
    // window = 7 past + today + 14 future = 22 days
    expect(res.body.days).toHaveLength(22);
    const today = res.body.days.find((d: { isToday: boolean }) => d.isToday);
    expect(today.forecastNew).toBe(40); // today cohort = remaining-scaled override
    // every day carries all four series keys (null-safe shape)
    for (const d of res.body.days) {
      expect(d).toHaveProperty("actualSent");
      expect(d).toHaveProperty("inFlightSent");
      expect(d).toHaveProperty("forecastNew");
      expect(d).toHaveProperty("total");
    }
  });

  it("passes ONLY the cold-email outreach slugs to the fleet aggregation", async () => {
    await request(app).get("/internal/stats/send-forecast").set(KEY);
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    expect(mockAggregate.mock.calls[0][0]).toEqual(["sales-cold-email-outreach"]);
  });

  it("overlays past actual sends and future in-flight scheduled sends", async () => {
    // pick relative dates so the test never rots
    const iso = (delta: number) => {
      const t = new Date();
      t.setUTCDate(t.getUTCDate() + delta);
      return t.toISOString().slice(0, 10);
    };
    mockEmailsSent.mockResolvedValue(new Map([[iso(-2), 33]]));
    mockSendingForecast.mockResolvedValue(new Map([[iso(4), 21]]));
    const res = await request(app).get("/internal/stats/send-forecast").set(KEY);
    const past = res.body.days.find((d: { date: string }) => d.date === iso(-2));
    expect(past).toMatchObject({ actualSent: 33, inFlightSent: null, forecastNew: null, total: 33 });
    const future = res.body.days.find((d: { date: string }) => d.date === iso(4));
    expect(future.inFlightSent).toBe(21);
    expect(future.forecastNew).toBeGreaterThan(0);
    expect(future.total).toBe(future.inFlightSent + future.forecastNew);
  });

  it("401s without the service api-key (internal, not public)", async () => {
    const res = await request(app).get("/internal/stats/send-forecast");
    expect(res.status).toBe(401);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it("no longer exposes an unauthenticated PUBLIC route (fleet financials must not be public)", async () => {
    const res = await request(app).get("/public/stats/send-forecast");
    expect(res.status).toBe(404);
    expect(mockAggregate).not.toHaveBeenCalled();
  });
});
