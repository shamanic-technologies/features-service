import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFindMany = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: vi.fn(),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
  sql: {},
}));

// Mock env validation
vi.mock("../lib/env.js", () => ({
  validateRequiredEnv: vi.fn(),
  REQUIRED_ENV: [],
}));

// Mock Sentry
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

// Mock seed registration
vi.mock("../seed/register.js", () => ({
  registerSeedFeatures: vi.fn(),
}));

// Mock brand-client
vi.mock("../lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
}));

// Set required env vars before importing app
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

// ── GET /public/features ──────────────────────────────────────────────────

describe("GET /public/features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active features with display-safe fields only, no auth required", async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        dynastyName: "Sales Cold Email",
        dynastySlug: "sales-cold-email",
        description: "Cold outreach",
        icon: "mail",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        displayOrder: 1,
      },
      {
        dynastyName: "PR Journalist Outreach",
        dynastySlug: "pr-journalist-outreach",
        description: "PR outreach",
        icon: "newspaper",
        category: "pr",
        channel: "email",
        audienceType: "journalists",
        displayOrder: 0,
      },
    ]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(2);
    // Sorted by displayOrder
    expect(res.body.features[0].dynastySlug).toBe("pr-journalist-outreach");
    expect(res.body.features[1].dynastySlug).toBe("sales-cold-email");
    // No internal fields exposed
    expect(res.body.features[0]).not.toHaveProperty("id");
    expect(res.body.features[0]).not.toHaveProperty("inputs");
    expect(res.body.features[0]).not.toHaveProperty("outputs");
    expect(res.body.features[0]).not.toHaveProperty("signature");
    expect(res.body.features[0]).not.toHaveProperty("baseName");
    expect(res.body.features[0]).not.toHaveProperty("forkName");
  });

  it("returns empty array when no active features", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app).get("/public/features");

    expect(res.status).toBe(200);
    expect(res.body.features).toEqual([]);
  });
});

// ── GET /public/features/dynasty/slugs ────────────────────────────────────

describe("GET /public/features/dynasty/slugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns versioned slugs sorted by version, no auth required", async () => {
    mockFindMany.mockResolvedValueOnce([
      { slug: "sales-cold-email-v2", version: 2 },
      { slug: "sales-cold-email", version: 1 },
    ]);

    const res = await request(app)
      .get("/public/features/dynasty/slugs?dynastySlug=sales-cold-email");

    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual([
      "sales-cold-email",
      "sales-cold-email-v2",
    ]);
  });

  it("returns 404 when no features match", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/public/features/dynasty/slugs?dynastySlug=nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns 400 when dynastySlug is missing", async () => {
    const res = await request(app)
      .get("/public/features/dynasty/slugs");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/i);
  });
});
