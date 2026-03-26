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
    { key: "emailsSent", displayOrder: 1 },
    { key: "emailsOpened", displayOrder: 2 },
    { key: "emailsReplied", displayOrder: 3 },
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
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              broadcast: { emailsSent: 100, emailsOpened: 40, emailsReplied: 10 },
              transactional: { emailsSent: 500, emailsOpened: 200, emailsReplied: 50 },
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
    expect(res.body.stats.emailsSent).toBe(100);
    expect(res.body.stats.emailsOpened).toBe(40);
    expect(res.body.stats.emailsReplied).toBe(10);
  });

  it("returns zero when only transactional stats exist", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              transactional: { emailsSent: 500, emailsOpened: 200, emailsReplied: 50 },
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

    // No broadcast data → all zeros
    expect(res.body.stats.emailsSent).toBe(0);
    expect(res.body.stats.emailsOpened).toBe(0);
    expect(res.body.stats.emailsReplied).toBe(0);
  });

  it("works with grouped response — only broadcast per group", async () => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (!url.includes("/v1/stats/costs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              groups: [
                {
                  key: "brand-1",
                  broadcast: { emailsSent: 50, emailsOpened: 20, emailsReplied: 5 },
                  transactional: { emailsSent: 300, emailsOpened: 150, emailsReplied: 30 },
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
    expect(group.stats.emailsSent).toBe(50);
    expect(group.stats.emailsOpened).toBe(20);
    expect(group.stats.emailsReplied).toBe(5);
  });
});
