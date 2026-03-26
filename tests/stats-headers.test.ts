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
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ groups: [] }),
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

  it("omits identity headers when not provided by caller", async () => {
    const app = createApp();

    await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-123")
      .expect(200);

    for (const [url, opts] of fetchSpy.mock.calls) {
      const headers = opts?.headers ?? {};
      expect(headers["x-org-id"]).toBe("org-123");
      // Should not have undefined string values
      expect(headers["x-user-id"]).toBeUndefined();
      expect(headers["x-run-id"]).toBeUndefined();
    }
  });
});
