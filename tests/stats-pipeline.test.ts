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

const SALES_FEATURE = {
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
    { key: "emailsSent", displayOrder: 3 },
  ],
  charts: [],
  entityTypes: [],
  workflows: [],
};

const PR_FEATURE = {
  id: "feat-2",
  slug: "pr-cold-email-outreach",
  name: "PR Cold Email Outreach",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [
    { key: "journalistsFound", displayOrder: 1 },
    { key: "emailsGenerated", displayOrder: 2 },
    { key: "journalistsContacted", displayOrder: 3 },
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

describe("pipeline stats (leadsServed, emailsGenerated, journalistsContacted)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([SALES_FEATURE, PR_FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockFetch(urlPattern: string, response: unknown) {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes(urlPattern)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        });
      }
      // Default: empty groups
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });
  }

  function mockFetchMulti(handlers: Array<{ match: string; response: unknown }>) {
    fetchSpy.mockImplementation((url: string) => {
      for (const { match, response } of handlers) {
        if (url.includes(match)) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(response),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });
  }

  it("fetches leadsServed from lead-service /stats", async () => {
    mockFetch("_never_match_", { groups: [] });
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const leadCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("lead-service/stats"),
    );
    expect(leadCalls.length).toBeGreaterThan(0);
  });

  it("fetches emailsGenerated from runs-service with serviceName=content-generation-service", async () => {
    mockFetch("_never_match_", { groups: [] });
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const pipelineCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) =>
        url.includes("serviceName=content-generation-service") &&
        url.includes("taskName=single-generation"),
    );
    expect(pipelineCalls.length).toBeGreaterThan(0);
  });

  it("returns pipeline counts in stats response", async () => {
    mockFetchMulti([
      {
        match: "lead-service/stats",
        response: { served: 42, contacted: 10, buffered: 0, skipped: 0, apollo: { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 } },
      },
      {
        match: "serviceName=content-generation-service",
        response: {
          groups: [{ dimensions: { workflowName: null }, runCount: 37, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" }],
        },
      },
    ]);
    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.leadsServed).toBe(42);
    expect(res.body.stats.emailsGenerated).toBe(37);
  });


  it("fetches journalistsFound and journalistsContacted from journalists-service /stats", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(PR_FEATURE as any);

    mockFetchMulti([
      {
        match: "journalists-service/orgs/stats",
        response: {
          totalJournalists: 25,
          byStatus: { contacted: 20, served: 3, buffered: 2 },
        },
      },
      {
        match: "serviceName=content-generation-service",
        response: {
          groups: [{ dimensions: { workflowName: null }, runCount: 20, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" }],
        },
      },
    ]);

    const app = createApp();

    const res = await request(app)
      .get("/features/pr-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.journalistsFound).toBe(25);
    expect(res.body.stats.journalistsContacted).toBe(20);
    expect(res.body.stats.emailsGenerated).toBe(20);
  });

  it("calls journalists-service /stats with correct filters", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(PR_FEATURE as any);

    mockFetchMulti([
      {
        match: "journalists-service/orgs/stats",
        response: { totalJournalists: 10, byStatus: {} },
      },
    ]);

    const app = createApp();

    await request(app)
      .get("/features/pr-cold-email-outreach/stats?brandId=brand-1&campaignId=camp-1")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const journalistsCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("journalists-service/orgs/stats"),
    );
    expect(journalistsCalls.length).toBe(1);
    const calledUrl = journalistsCalls[0][0] as string;
    expect(calledUrl).toContain("brandId=brand-1");
    expect(calledUrl).toContain("campaignId=camp-1");
  });

  it("pipeline stats work with groupBy=campaignId", async () => {
    mockFetchMulti([
      {
        match: "lead-service/stats",
        response: {
          groups: [
            { key: "camp-a", served: 15, contacted: 0, buffered: 0, skipped: 0 },
            { key: "camp-b", served: 27, contacted: 0, buffered: 0, skipped: 0 },
          ],
        },
      },
      {
        match: "serviceName=content-generation-service",
        response: {
          groups: [
            { dimensions: { campaignId: "camp-a" }, runCount: 12, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" },
          ],
        },
      },
    ]);

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats?groupBy=campaignId")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const campA = res.body.groups.find((g: any) => g.campaignId === "camp-a");
    const campB = res.body.groups.find((g: any) => g.campaignId === "camp-b");

    expect(campA.stats.leadsServed).toBe(15);
    expect(campA.stats.emailsGenerated).toBe(12);
    expect(campB.stats.leadsServed).toBe(27);
    expect(campB.stats.emailsGenerated).toBeNull(); // no data for camp-b
  });
});

describe("Bug fix: campaignId filter forwarded to runs-service", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([SALES_FEATURE] as any);

    fetchSpy.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("forwards campaignId to runs-service /v1/stats/costs", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats?campaignId=camp-123")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const costsCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("/v1/stats/costs"),
    );
    expect(costsCalls.length).toBeGreaterThan(0);
    for (const [url] of costsCalls) {
      expect(url).toContain("campaignId=camp-123");
    }
  });

  it("forwards campaignId to lead-service /stats and runs-service pipeline stats calls", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats?campaignId=camp-456")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    // lead-service /stats should receive campaignId
    const leadCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("lead-service/stats"),
    );
    expect(leadCalls.length).toBeGreaterThan(0);
    for (const [url] of leadCalls) {
      expect(url).toContain("campaignId=camp-456");
    }

    // pipeline calls (emailsGenerated) should also receive campaignId
    const pipelineCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("serviceName="),
    );
    expect(pipelineCalls.length).toBeGreaterThan(0);
    for (const [url] of pipelineCalls) {
      expect(url).toContain("campaignId=camp-456");
    }
  });
});

describe("Bug fix: pipeline stats aggregate to __total__ when no groupBy", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([SALES_FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns non-zero pipeline stats when no groupBy is specified", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("lead-service/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ served: 3, contacted: 0, buffered: 0, skipped: 0, apollo: { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 } }),
        });
      }
      if (url.includes("serviceName=content-generation-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            groups: [
              { dimensions: { workflowName: "sales-email-cold-outreach-herald" }, runCount: 3, totalCostInUsdCents: "0" },
            ],
          }),
        });
      }
      if (url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            groups: [
              { dimensions: { workflowName: "sales-email-cold-outreach-herald" }, runCount: 3, totalCostInUsdCents: "100", minStartedAt: null, maxStartedAt: null },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.leadsServed).toBe(3);
    expect(res.body.stats.emailsGenerated).toBe(3);
    expect(res.body.systemStats.completedRuns).toBe(3);
  });

  it("aggregates lead-service stats into __total__ when no groupBy", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("lead-service/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ served: 12, contacted: 0, buffered: 0, skipped: 0, apollo: { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 } }),
        });
      }
      if (url.includes("/v1/stats/costs") && !url.includes("serviceName=")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            groups: [
              { dimensions: { workflowName: "wf-a" }, runCount: 10, totalCostInUsdCents: "200", minStartedAt: "2026-01-01T00:00:00Z", maxStartedAt: "2026-02-01T00:00:00Z" },
              { dimensions: { workflowName: "wf-b" }, runCount: 20, totalCostInUsdCents: "300", minStartedAt: "2026-01-15T00:00:00Z", maxStartedAt: "2026-03-01T00:00:00Z" },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.leadsServed).toBe(12);
    expect(res.body.systemStats.completedRuns).toBe(30); // 10 + 20
    expect(res.body.systemStats.totalCostInUsdCents).toBe(500); // 200 + 300
    expect(res.body.systemStats.firstRunAt).toBe("2026-01-01T00:00:00Z");
    expect(res.body.systemStats.lastRunAt).toBe("2026-03-01T00:00:00Z");
  });
});

describe("repliesMoreInfo and repliesWrongContact extraction", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const PR_FEATURE_WITH_REPLIES = {
    id: "feat-2",
    slug: "pr-cold-email-outreach",
    name: "PR Cold Email Outreach",
    status: "active",
    forkedFrom: null,
    upgradedTo: null,
    inputs: [],
    outputs: [
      { key: "emailsSent", displayOrder: 1 },
    ],
    charts: [
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 1,
        segments: [
          { key: "repliesMoreInfo", color: "blue", sentiment: "positive" },
          { key: "repliesWrongContact", color: "orange", sentiment: "negative" },
        ],
      },
    ],
    entityTypes: [],
    workflows: [],
  };

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(PR_FEATURE_WITH_REPLIES as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([PR_FEATURE_WITH_REPLIES] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts repliesMoreInfo and repliesWrongContact from email-gateway broadcast stats", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/stats?")) {
        // email-gateway response
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            broadcast: {
              emailsSent: 100,
              repliesMoreInfo: 8,
              repliesWrongContact: 3,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });

    const app = express();
    app.use(express.json());
    app.use(statsRoutes);

    const res = await request(app)
      .get("/features/pr-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.repliesMoreInfo).toBe(8);
    expect(res.body.stats.repliesWrongContact).toBe(3);
  });
});

describe("activeCampaigns in systemStats", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("CAMPAIGN_SERVICE_URL", "http://campaign-service");
    vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "campaign-key");

    const feature = {
      id: "feat-1",
      slug: "sales-cold-email-outreach",
      name: "Sales Cold Email Outreach",
      status: "active",
      forkedFrom: null,
      upgradedTo: null,
      inputs: [],
      outputs: [{ key: "emailsSent", displayOrder: 1 }],
      charts: [],
      entityTypes: [],
      workflows: [],
    };
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([feature] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches active campaign count from campaign-service and includes in systemStats", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("campaign-service/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            stats: {
              totalCampaigns: 10,
              byStatus: { active: 5, paused: 3, completed: 2 },
              budgetTotalUsd: null,
              maxLeadsTotal: null,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.systemStats.activeCampaigns).toBe(5);
  });
});

describe("firstRunAt / lastRunAt in systemStats", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("CAMPAIGN_SERVICE_URL", "http://campaign-service");
    vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "campaign-key");

    const feature = {
      id: "feat-1",
      slug: "sales-cold-email-outreach",
      name: "Sales Cold Email Outreach",
      status: "active",
      forkedFrom: null,
      upgradedTo: null,
      inputs: [],
      outputs: [{ key: "emailsSent", displayOrder: 1 }],
      charts: [],
      entityTypes: [],
      workflows: [],
    };
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([feature] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps minStartedAt/maxStartedAt from costs-service to firstRunAt/lastRunAt", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            groups: [{
              dimensions: {},
              totalCostInUsdCents: "1500",
              runCount: 3,
              minStartedAt: "2026-01-10T08:00:00.000Z",
              maxStartedAt: "2026-03-25T14:30:00.000Z",
            }],
          }),
        });
      }
      if (url.includes("campaign-service/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            stats: { totalCampaigns: 0, byStatus: {}, budgetTotalUsd: null, maxLeadsTotal: null },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.systemStats.firstRunAt).toBe("2026-01-10T08:00:00.000Z");
    expect(res.body.systemStats.lastRunAt).toBe("2026-03-25T14:30:00.000Z");
  });

  it("returns null for firstRunAt/lastRunAt when costs-service returns no timestamps", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            groups: [{
              dimensions: {},
              totalCostInUsdCents: "500",
              runCount: 1,
              minStartedAt: null,
              maxStartedAt: null,
            }],
          }),
        });
      }
      if (url.includes("campaign-service/stats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            stats: { totalCampaigns: 0, byStatus: {}, budgetTotalUsd: null, maxLeadsTotal: null },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });

    const app = createApp();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.systemStats.firstRunAt).toBeNull();
    expect(res.body.systemStats.lastRunAt).toBeNull();
  });
});
