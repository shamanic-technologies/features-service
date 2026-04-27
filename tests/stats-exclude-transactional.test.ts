import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock environment variables before importing the stats module
vi.stubEnv("FEATURES_SERVICE_API_KEY", "test-key");
vi.stubEnv("RUNS_SERVICE_URL", "http://runs-service");
vi.stubEnv("RUNS_SERVICE_API_KEY", "runs-key");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_URL", "http://email-gateway");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_API_KEY", "email-gw-key");
vi.stubEnv("OUTLETS_SERVICE_URL", "http://outlets-service");
vi.stubEnv("OUTLETS_SERVICE_API_KEY", "outlets-key");
vi.stubEnv("JOURNALISTS_SERVICE_URL", "http://journalists-service");
vi.stubEnv("JOURNALISTS_SERVICE_API_KEY", "journalists-key");
vi.stubEnv("CAMPAIGN_SERVICE_URL", "http://campaign-service");
vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "campaign-key");

// Mock the database before importing the router
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

const MOCK_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [
    { key: "recipientsSent", displayOrder: 1 },
    { key: "recipientsOpened", displayOrder: 2 },
    { key: "recipientsRepliesPositive", displayOrder: 3 },
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

describe("stats exclude transactional emails", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses only broadcast counts, ignores transactional", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 95, opened: 40, clicked: 10, bounced: 5, repliesPositive: 10, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
              transactional: { recipientStats: { contacted: 500, sent: 500, delivered: 480, opened: 200, clicked: 50, bounced: 20, repliesPositive: 50, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
            }),
        });
      }
      // runs-service
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            groups: [
              {
                dimensions: { workflowName: "wf-1" },
                totalCostInUsdCents: "0",
                runCount: 0,
              },
            ],
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    // Should only include broadcast numbers, not broadcast + transactional
    expect(res.body.stats.recipientsSent).toBe(100);
    expect(res.body.stats.recipientsOpened).toBe(40);
    expect(res.body.stats.recipientsRepliesPositive).toBe(10);
  });

  it("returns zero when only transactional stats exist", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              // broadcast is empty — no broadcast emails sent
              broadcast: {},
              transactional: { recipientStats: { contacted: 500, sent: 500, delivered: 480, opened: 200, clicked: 50, bounced: 20, repliesPositive: 50, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            groups: [
              {
                dimensions: { workflowName: "wf-1" },
                totalCostInUsdCents: "0",
                runCount: 0,
              },
            ],
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    // No broadcast data → all null (transactional values not included)
    expect(res.body.stats.recipientsSent).toBeNull();
    expect(res.body.stats.recipientsOpened).toBeNull();
    expect(res.body.stats.recipientsRepliesPositive).toBeNull();
  });

  it("works with grouped response — only broadcast per group", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              groups: [
                {
                  key: "brand-1",
                  broadcast: { recipientStats: { contacted: 50, sent: 50, delivered: 48, opened: 20, clicked: 10, bounced: 2, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
                  transactional: { recipientStats: { contacted: 300, sent: 300, delivered: 290, opened: 150, clicked: 30, bounced: 10, repliesPositive: 30, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            groups: [
              {
                dimensions: { brandId: "brand-1" },
                totalCostInUsdCents: "0",
                runCount: 0,
              },
            ],
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats?groupBy=brandId")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const group = res.body.groups[0];
    expect(group.stats.recipientsSent).toBe(50);
    expect(group.stats.recipientsOpened).toBe(20);
    expect(group.stats.recipientsRepliesPositive).toBe(5);
  });

  it("does not crash when broadcast field is absent from response", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (!url.includes("/v1/stats/costs")) {
        // email-gateway returns only transactional, no broadcast key at all
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              transactional: { emailsSent: 500, emailsOpened: 200, repliesPositive: 50 },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            groups: [
              {
                dimensions: { workflowName: "wf-1" },
                totalCostInUsdCents: "0",
                runCount: 0,
              },
            ],
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    // broadcast absent → all recipient stats should be null
    expect(res.body.stats.recipientsSent).toBeNull();
    expect(res.body.stats.recipientsOpened).toBeNull();
    expect(res.body.stats.recipientsRepliesPositive).toBeNull();
  });

  it("does not crash when broadcast field is absent in grouped response", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              groups: [
                {
                  key: "brand-1",
                  transactional: { recipientStats: { contacted: 300, sent: 300, delivered: 290, opened: 150, clicked: 30, bounced: 10, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
                  // no broadcast key
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            groups: [
              {
                dimensions: { brandId: "brand-1" },
                totalCostInUsdCents: "0",
                runCount: 0,
              },
            ],
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = createApp();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats?groupBy=brandId")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    const group = res.body.groups[0];
    // No broadcast data → recipient stats are null
    expect(group.stats.recipientsSent).toBeNull();
    expect(group.stats.recipientsOpened).toBeNull();
  });
});
