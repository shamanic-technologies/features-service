import { describe, it, expect, vi } from "vitest";

// Mock DB before importing
vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findMany: vi.fn(),
      },
    },
  },
  sql: {},
}));

process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";

// ── resolveFeatureDynastySlugs (local DB) ───────────────────────────────────

describe("resolveFeatureDynastySlugs", () => {
  it("resolves slugs from local DB sorted by version", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.query.features.findMany).mockResolvedValueOnce([
      { slug: "feat-v2", version: 2 },
      { slug: "feat", version: 1 },
    ] as any);

    const { resolveFeatureDynastySlugs } = await import("./dynasty-client.js");
    const slugs = await resolveFeatureDynastySlugs("feat");

    expect(slugs).toEqual(["feat", "feat-v2"]);
  });

  it("returns empty array for unknown dynasty", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.query.features.findMany).mockResolvedValueOnce([]);

    const { resolveFeatureDynastySlugs } = await import("./dynasty-client.js");
    const slugs = await resolveFeatureDynastySlugs("nonexistent");

    expect(slugs).toEqual([]);
  });
});

// ── buildFeatureSlugToDynastyMap ────────────────────────────────────────────

describe("buildFeatureSlugToDynastyMap", () => {
  it("builds reverse map from DB features", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.query.features.findMany).mockResolvedValueOnce([
      { slug: "sales-cold-email", dynastySlug: "sales-cold-email" },
      { slug: "sales-cold-email-v2", dynastySlug: "sales-cold-email" },
      { slug: "lead-scoring", dynastySlug: "lead-scoring" },
    ] as any);

    const { buildFeatureSlugToDynastyMap } = await import("./dynasty-client.js");
    const map = await buildFeatureSlugToDynastyMap();

    expect(map.get("sales-cold-email")).toBe("sales-cold-email");
    expect(map.get("sales-cold-email-v2")).toBe("sales-cold-email");
    expect(map.get("lead-scoring")).toBe("lead-scoring");
    expect(map.get("unknown")).toBeUndefined();
  });

  it("returns empty map when no features exist", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.query.features.findMany).mockResolvedValueOnce([]);

    const { buildFeatureSlugToDynastyMap } = await import("./dynasty-client.js");
    const map = await buildFeatureSlugToDynastyMap();

    expect(map.size).toBe(0);
  });
});
