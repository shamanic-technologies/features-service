import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();

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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

describe("GET /features", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns active features by default", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "1", slug: "sales-cold-email-outreach", name: "Sales Cold Email Outreach", description: "test", status: "active" },
    ]);

    const res = await request(app).get("/features").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].slug).toBe("sales-cold-email-outreach");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/features");
    expect(res.status).toBe(401);
  });
});

describe("GET /features/:slug", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns feature by exact slug", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "1",
      slug: "sales-cold-email-outreach",
      name: "Sales Cold Email Outreach",
      description: "test",
      status: "active",
    });

    const res = await request(app).get("/features/sales-cold-email-outreach").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.feature.slug).toBe("sales-cold-email-outreach");
  });

  it("returns 404 when slug not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).get("/features/nonexistent").set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/features/sales-cold-email-outreach");
    expect(res.status).toBe(401);
  });
});
