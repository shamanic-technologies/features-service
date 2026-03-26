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
    { key: "journalistsContacted", displayOrder: 1 },
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

  it("fetches leadsServed from runs-service with serviceName=lead-service&taskName=lead-serve", async () => {
    mockFetch("_never_match_", { groups: [] });
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    // Find the pipeline call for lead-service
    const pipelineCalls = fetchSpy.mock.calls.filter(
      ([url]: [string]) =>
        url.includes("serviceName=lead-service") &&
        url.includes("taskName=lead-serve"),
    );
    expect(pipelineCalls.length).toBeGreaterThan(0);
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
        match: "serviceName=lead-service",
        response: {
          groups: [{ dimensions: { workflowName: null }, runCount: 42, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" }],
        },
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


  it("fetches journalistsContacted for PR feature via lead-service/lead-serve", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(PR_FEATURE as any);

    mockFetchMulti([
      {
        match: "serviceName=lead-service",
        response: {
          groups: [{ dimensions: { workflowName: null }, runCount: 25, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" }],
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

    expect(res.body.stats.journalistsContacted).toBe(25);
    expect(res.body.stats.emailsGenerated).toBe(20);
  });

  it("pipeline stats work with groupBy=campaignId", async () => {
    mockFetchMulti([
      {
        match: "serviceName=lead-service",
        response: {
          groups: [
            { dimensions: { campaignId: "camp-a" }, runCount: 15, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" },
            { dimensions: { campaignId: "camp-b" }, runCount: 27, totalCostInUsdCents: "0", actualCostInUsdCents: "0", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0" },
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
