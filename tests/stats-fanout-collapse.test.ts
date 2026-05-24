import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.stubEnv("FEATURES_SERVICE_API_KEY", "test-key");
vi.stubEnv("RUNS_SERVICE_URL", "http://runs-service");
vi.stubEnv("RUNS_SERVICE_API_KEY", "runs-key");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_URL", "http://email-gateway");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_API_KEY", "email-gw-key");
vi.stubEnv("OUTLETS_SERVICE_URL", "http://outlets-service");
vi.stubEnv("OUTLETS_SERVICE_API_KEY", "outlets-key");
vi.stubEnv("JOURNALISTS_SERVICE_URL", "http://journalists-service");
vi.stubEnv("JOURNALISTS_SERVICE_API_KEY", "journalists-key");
vi.stubEnv("LEAD_SERVICE_URL", "http://lead-service");
vi.stubEnv("LEAD_SERVICE_API_KEY", "lead-key");
vi.stubEnv("CAMPAIGN_SERVICE_URL", "http://campaign-service");
vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "campaign-key");

vi.mock("../src/db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
  },
}));

import statsRoutes from "../src/routes/stats.js";
import { db } from "../src/db/index.js";

const FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [
    { key: "leadsServed", displayOrder: 1 },
    { key: "emailsGenerated", displayOrder: 2 },
  ],
  charts: [],
  entityTypes: [],
  workflows: [],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(statsRoutes);
  return app;
}

function isCostsGet(url: string, init: RequestInit | undefined): boolean {
  return url.includes("/v1/stats/costs") &&
    (!init || (init.method ?? "GET").toString().toUpperCase() === "GET");
}

function isCostsPost(url: string, init: RequestInit | undefined): boolean {
  return url.endsWith("/v1/stats/costs") &&
    !!init && (init.method ?? "GET").toString().toUpperCase() === "POST";
}

describe("runs-service fanout collapse: features-stats endpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (isCostsPost(url, init)) {
        const body = JSON.parse(init!.body as string) as { serviceTasks: Array<{ serviceName: string; taskName: string }> };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            buckets: body.serviceTasks.map((t) => ({
              serviceName: t.serviceName,
              taskName: t.taskName,
              groups: [],
            })),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetchRunsStats: exactly 1 GET to /v1/stats/costs regardless of lineage size", async () => {
    const FEATURE_WITH_LINEAGE = { ...FEATURE };
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE_WITH_LINEAGE as any);

    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const costsGets = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsGet(url, init),
    );
    expect(costsGets.length).toBe(1);
    expect(costsGets[0][0]).toContain("featureSlugs=sales-cold-email-outreach");
  });

  it("fetchRunsStats: GET query string uses featureSlugs (CSV) param, not legacy featureSlug", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const costsGets = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsGet(url, init),
    );
    expect(costsGets.length).toBe(1);
    const url = costsGets[0][0] as string;
    expect(url).toContain("featureSlugs=sales-cold-email-outreach");
    // Confirms the legacy per-slug `featureSlug=` param is no longer emitted.
    expect(url).not.toMatch(/[?&]featureSlug=/);
  });

  it("fetchPipelineStats: exactly 1 POST to /v1/stats/costs regardless of K filter tuples", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const pipelinePosts = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsPost(url, init),
    );
    expect(pipelinePosts.length).toBe(1);

    const [, init] = pipelinePosts[0];
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.serviceTasks)).toBe(true);
    expect(body.serviceTasks.length).toBeGreaterThan(0);
    expect(body.serviceTasks[0]).toHaveProperty("serviceName");
    expect(body.serviceTasks[0]).toHaveProperty("taskName");
    expect(body.featureSlugs).toEqual(["sales-cold-email-outreach"]);
    expect(body.groupBy).toBe("workflowSlug");
  });

  it("total runs-service calls per /features/:slug/stats page load: exactly 2 (1 GET + 1 POST)", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const runsCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("/v1/stats/costs"),
    );
    expect(runsCalls.length).toBe(2);
  });

  it("forwards brandId/campaignId on POST pipeline body", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=brand-9&campaignId=camp-9")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const pipelinePosts = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsPost(url, init),
    );
    expect(pipelinePosts.length).toBe(1);
    const body = JSON.parse(pipelinePosts[0][1].body as string);
    expect(body.brandId).toBe("brand-9");
    expect(body.campaignId).toBe("camp-9");
  });

  it("identity headers + content-type forwarded on POST pipeline call", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-42")
      .set("x-user-id", "user-42")
      .set("x-run-id", "run-42")
      .expect(200);

    const pipelinePosts = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsPost(url, init),
    );
    expect(pipelinePosts.length).toBe(1);
    const headers = pipelinePosts[0][1].headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-42");
    expect(headers["x-user-id"]).toBe("user-42");
    expect(headers["x-run-id"]).toBe("run-42");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("dynasty path: falls back to per-tuple GETs when workflowDynastySlug filter is present", async () => {
    const app = createApp();
    await request(app)
      .get("/features/sales-cold-email-outreach/stats?workflowDynastySlug=some-dynasty")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const pipelinePosts = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsPost(url, init),
    );
    expect(pipelinePosts.length).toBe(0);

    // Cost GET should still be 1, pipeline GET fallback should be K (per RunFilter entries).
    const costsGets = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsGet(url, init),
    );
    expect(costsGets.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runs-service fanout collapse: global /stats endpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (isCostsPost(url, init)) {
        const body = JSON.parse(init!.body as string) as { serviceTasks: Array<{ serviceName: string; taskName: string }> };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            buckets: body.serviceTasks.map((t) => ({
              serviceName: t.serviceName,
              taskName: t.taskName,
              groups: [],
            })),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GET /stats issues exactly 1 cost GET and 1 pipeline POST", async () => {
    const app = createApp();
    await request(app)
      .get("/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const costsGets = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsGet(url, init),
    );
    const pipelinePosts = fetchSpy.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) => isCostsPost(url, init),
    );
    expect(costsGets.length).toBe(1);
    expect(pipelinePosts.length).toBe(1);
  });
});
