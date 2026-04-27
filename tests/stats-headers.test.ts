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
  outputs: [{ key: "emailsSent", displayOrder: 1 }],
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

describe("stats routes forward identity headers to downstream services", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("campaign-service")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [] }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GET /features/:slug/stats forwards x-user-id and x-run-id", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-456")
      .set("x-run-id", "run-789")
      .expect(200);

    // Verify all downstream fetch calls include identity headers
    for (const [url, opts] of fetchSpy.mock.calls) {
      const headers = opts?.headers ?? {};
      expect(headers["x-org-id"]).toBe("org-123");
      expect(headers["x-user-id"]).toBe("user-456");
      expect(headers["x-run-id"]).toBe("run-789");
    }
  });

  it("GET /stats forwards x-user-id and x-run-id", async () => {
    const app = createApp();

    await request(app)
      .get("/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-456")
      .set("x-run-id", "run-789")
      .expect(200);

    for (const [url, opts] of fetchSpy.mock.calls) {
      const headers = opts?.headers ?? {};
      expect(headers["x-org-id"]).toBe("org-123");
      expect(headers["x-user-id"]).toBe("user-456");
      expect(headers["x-run-id"]).toBe("run-789");
    }
  });

  it("GET /features/:slug/stats forwards x-campaign-id and x-feature-slug when present", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-456")
      .set("x-run-id", "run-789")
      .set("x-campaign-id", "camp-42")
      .set("x-feature-slug", "sales-cold-email-outreach")
      .expect(200);

    for (const [_url, opts] of fetchSpy.mock.calls) {
      const headers = opts?.headers ?? {};
      expect(headers["x-campaign-id"]).toBe("camp-42");
      expect(headers["x-feature-slug"]).toBe("sales-cold-email-outreach");
    }
  });

  it("omits x-campaign-id and x-feature-slug from downstream calls when not in request", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .set("x-user-id", "user-456")
      .set("x-run-id", "run-789")
      .expect(200);

    for (const [_url, opts] of fetchSpy.mock.calls) {
      const headers = opts?.headers ?? {};
      expect(headers["x-campaign-id"]).toBeUndefined();
      expect(headers["x-feature-slug"]).toBeUndefined();
    }
  });

  it("rejects requests missing required identity headers with 400", async () => {
    const app = createApp();

    // Missing x-user-id and x-run-id
    const res1 = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .expect(400);

    expect(res1.body.error).toMatch(/x-user-id/);
    expect(res1.body.error).toMatch(/x-run-id/);

    // Missing all three
    const res2 = await request(app)
      .get("/stats")
      .set("x-api-key", "test-key")
      .expect(400);

    expect(res2.body.error).toMatch(/x-org-id/);
    expect(res2.body.error).toMatch(/x-user-id/);
    expect(res2.body.error).toMatch(/x-run-id/);

    // No downstream calls should have been made
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
