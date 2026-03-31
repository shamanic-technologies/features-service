import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock DB before importing app
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockReturning = vi.fn();
const mockWhere = vi.fn();
const mockSet = vi.fn();
const mockValues = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
    insert: () => ({ values: (...args: unknown[]) => {
      mockValues(...args);
      return { returning: () => mockReturning() };
    }}),
    update: () => ({ set: (...args: unknown[]) => {
      mockSet(...args);
      return {
        where: (...wArgs: unknown[]) => {
          mockWhere(...wArgs);
          return { returning: () => mockReturning() };
        },
      };
    }}),
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

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

// ── Dynasty resolution endpoint ─────────────────────────────────────────────

describe("GET /features/dynasty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns dynasty identity for a valid slug", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "feat-1",
      slug: "sales-cold-email-sophia-v2",
      dynastyName: "Sales Cold Email Sophia",
      dynastySlug: "sales-cold-email-sophia",
    });

    const res = await request(app)
      .get("/features/dynasty?slug=sales-cold-email-sophia-v2")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      feature_dynasty_name: "Sales Cold Email Sophia",
      feature_dynasty_slug: "sales-cold-email-sophia",
    });
  });

  it("returns 404 for unknown slug", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/features/dynasty?slug=nonexistent")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });

  it("returns 400 when slug query param is missing", async () => {
    const res = await request(app)
      .get("/features/dynasty")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slug/i);
  });

  it("works for deprecated features", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "feat-old",
      slug: "sales-cold-email-v1",
      status: "deprecated",
      dynastyName: "Sales Cold Email",
      dynastySlug: "sales-cold-email",
    });

    const res = await request(app)
      .get("/features/dynasty?slug=sales-cold-email-v1")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.feature_dynasty_name).toBe("Sales Cold Email");
    expect(res.body.feature_dynasty_slug).toBe("sales-cold-email");
  });
});

// ── Dynasty slugs endpoint ─────────────────────────────────────────────────

describe("GET /features/dynasty/slugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all versioned slugs sorted by version", async () => {
    mockFindMany.mockResolvedValueOnce([
      { slug: "sales-cold-email-sophia-v2", version: 2 },
      { slug: "sales-cold-email-sophia", version: 1 },
      { slug: "sales-cold-email-sophia-v3", version: 3 },
    ]);

    const res = await request(app)
      .get("/features/dynasty/slugs?dynastySlug=sales-cold-email-sophia")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      slugs: [
        "sales-cold-email-sophia",
        "sales-cold-email-sophia-v2",
        "sales-cold-email-sophia-v3",
      ],
    });
  });

  it("returns 404 when no features match the dynasty slug", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/features/dynasty/slugs?dynastySlug=nonexistent-dynasty")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no features found/i);
  });

  it("returns 400 when dynastySlug query param is missing", async () => {
    const res = await request(app)
      .get("/features/dynasty/slugs")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/i);
  });

  it("returns a single slug for a dynasty with one version", async () => {
    mockFindMany.mockResolvedValueOnce([
      { slug: "pr-journalist-outreach", version: 1 },
    ]);

    const res = await request(app)
      .get("/features/dynasty/slugs?dynastySlug=pr-journalist-outreach")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual(["pr-journalist-outreach"]);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .get("/features/dynasty/slugs?dynastySlug=sales-cold-email");

    expect(res.status).toBe(401);
  });
});

// ── List dynasties endpoint ────────────────────────────────────────────────

describe("GET /features/dynasties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all dynasties grouped and sorted", async () => {
    mockFindMany.mockResolvedValueOnce([
      { dynastySlug: "sales-cold-email", slug: "sales-cold-email-v2", version: 2 },
      { dynastySlug: "lead-scoring", slug: "lead-scoring", version: 1 },
      { dynastySlug: "sales-cold-email", slug: "sales-cold-email", version: 1 },
    ]);

    const res = await request(app)
      .get("/features/dynasties")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.dynasties).toEqual([
      { dynastySlug: "lead-scoring", slugs: ["lead-scoring"] },
      { dynastySlug: "sales-cold-email", slugs: ["sales-cold-email", "sales-cold-email-v2"] },
    ]);
  });

  it("returns empty array when no features exist", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/features/dynasties")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.dynasties).toEqual([]);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .get("/features/dynasties");

    expect(res.status).toBe(401);
  });
});

// ── Signature helpers ───────────────────────────────────────────────────────

describe("signature helpers", () => {
  it("composeDynastyName without fork name", async () => {
    const { composeDynastyName } = await import("../lib/signature.js");
    expect(composeDynastyName("Sales Cold Email", null)).toBe("Sales Cold Email");
  });

  it("composeDynastyName with fork name", async () => {
    const { composeDynastyName } = await import("../lib/signature.js");
    expect(composeDynastyName("Sales Cold Email", "Sophia")).toBe("Sales Cold Email Sophia");
  });

  it("versionedName v1 has no suffix", async () => {
    const { versionedName } = await import("../lib/signature.js");
    expect(versionedName("Sales Cold Email", 1)).toBe("Sales Cold Email");
  });

  it("versionedName v2+ has suffix", async () => {
    const { versionedName } = await import("../lib/signature.js");
    expect(versionedName("Sales Cold Email Sophia", 3)).toBe("Sales Cold Email Sophia v3");
  });

  it("versionedSlug v1 has no suffix", async () => {
    const { versionedSlug } = await import("../lib/signature.js");
    expect(versionedSlug("sales-cold-email", 1)).toBe("sales-cold-email");
  });

  it("versionedSlug v2+ has suffix", async () => {
    const { versionedSlug } = await import("../lib/signature.js");
    expect(versionedSlug("sales-cold-email-sophia", 2)).toBe("sales-cold-email-sophia-v2");
  });

  it("pickForkName picks first available codename", async () => {
    const { pickForkName, CODENAMES } = await import("../lib/signature.js");
    const used = new Set<string>();
    expect(pickForkName(used)).toBe(CODENAMES[0]);
  });

  it("pickForkName skips used names", async () => {
    const { pickForkName, CODENAMES } = await import("../lib/signature.js");
    const used = new Set([CODENAMES[0], CODENAMES[1]]);
    expect(pickForkName(used)).toBe(CODENAMES[2]);
  });

  it("pickForkName falls back when all exhausted", async () => {
    const { pickForkName, CODENAMES } = await import("../lib/signature.js");
    const used = new Set(CODENAMES);
    const result = pickForkName(used);
    // Should be first codename + random suffix
    expect(result).toMatch(new RegExp(`^${CODENAMES[0]}-[a-f0-9]{4}$`));
  });
});

// ── GET /features/by-dynasty/:dynastySlug — active feature by dynasty slug ──

describe("GET /features/by-dynasty/:dynastySlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active feature for a dynasty slug", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "feat-v2",
      slug: "sales-cold-email-v2",
      dynastyName: "Sales Cold Email",
      dynastySlug: "sales-cold-email",
      version: 2,
      status: "active",
    });

    const res = await request(app)
      .get("/features/by-dynasty/sales-cold-email")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.feature.slug).toBe("sales-cold-email-v2");
    expect(res.body.feature.dynastySlug).toBe("sales-cold-email");
  });

  it("returns 404 when no active feature exists for dynasty slug", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/features/by-dynasty/nonexistent-dynasty")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/dynasty slug/i);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .get("/features/by-dynasty/sales-cold-email");

    expect(res.status).toBe(401);
  });
});

// ── GET /features/:slug — exact versioned slug only ──────────────────────

describe("GET /features/:slug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns feature by exact versioned slug", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "feat-v2",
      slug: "sales-cold-email-v2",
      dynastySlug: "sales-cold-email",
      status: "active",
    });

    const res = await request(app)
      .get("/features/sales-cold-email-v2")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.feature.slug).toBe("sales-cold-email-v2");
  });

  it("returns 404 when slug does not match (no fallback to dynasty)", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/features/sales-cold-email")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });
});

// ── GET /features/:dynastySlug/inputs — dynasty slug only ────────────────

const MOCK_FEATURE_V2 = {
  id: "feat-v2",
  slug: "sales-cold-email-v2",
  name: "Sales Cold Email v2",
  dynastyName: "Sales Cold Email",
  dynastySlug: "sales-cold-email",
  version: 2,
  status: "active",
  inputs: [{ key: "target", label: "Target", type: "text", placeholder: "...", description: "desc", extractKey: "target" }],
  outputs: [{ key: "emailsSent", displayOrder: 1 }],
  charts: [],
  entities: [],
};

describe("GET /features/:dynastySlug/inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves dynasty slug to active version and returns inputs", async () => {
    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE_V2);

    const res = await request(app)
      .get("/features/sales-cold-email/inputs")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("sales-cold-email-v2");
    expect(res.body.dynastySlug).toBe("sales-cold-email");
    expect(res.body.name).toBe("Sales Cold Email");
    expect(res.body.inputs).toEqual(MOCK_FEATURE_V2.inputs);
  });

  it("returns 404 when no active feature exists for dynasty slug", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/features/nonexistent-dynasty/inputs")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/dynasty slug/i);
  });
});

// ── POST /features/:dynastySlug/prefill — dynasty slug only ──────────────

describe("POST /features/:dynastySlug/prefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves dynasty slug to active version and prefills using x-brand-id header", async () => {
    const { extractBrandFields } = await import("../lib/brand-client.js");
    const mockExtract = vi.mocked(extractBrandFields);
    mockExtract.mockResolvedValueOnce({
      target: { value: "Enterprise", cached: false, sourceUrls: [], extractedAt: "2026-03-01T00:00:00Z", expiresAt: "2026-04-01T00:00:00Z" },
    });

    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE_V2);

    const res = await request(app)
      .post("/features/sales-cold-email/prefill")
      .set({ ...AUTH_HEADERS, "x-brand-id": "00000000-0000-0000-0000-000000000001" })
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("sales-cold-email-v2");
    expect(res.body.brandId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("supports CSV brand IDs in x-brand-id header", async () => {
    const { extractBrandFields } = await import("../lib/brand-client.js");
    const mockExtract = vi.mocked(extractBrandFields);
    mockExtract.mockResolvedValueOnce({
      target: { value: "Enterprise", cached: false, sourceUrls: [], extractedAt: "2026-03-01T00:00:00Z", expiresAt: "2026-04-01T00:00:00Z" },
    });

    mockFindFirst.mockResolvedValueOnce(MOCK_FEATURE_V2);

    const res = await request(app)
      .post("/features/sales-cold-email/prefill")
      .set({ ...AUTH_HEADERS, "x-brand-id": "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002" })
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe("00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002");
  });

  it("returns 400 when x-brand-id header is missing", async () => {
    const res = await request(app)
      .post("/features/sales-cold-email/prefill")
      .set(AUTH_HEADERS)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/i);
  });

  it("returns 404 when no active feature exists for dynasty slug", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/features/nonexistent-dynasty/prefill")
      .set({ ...AUTH_HEADERS, "x-brand-id": "00000000-0000-0000-0000-000000000001" })
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/dynasty slug/i);
  });
});
