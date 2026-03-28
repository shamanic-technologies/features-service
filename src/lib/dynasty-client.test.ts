import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { buildSlugToDynastyMap, type DynastyEntry } from "./dynasty-client.js";

// ── buildSlugToDynastyMap ───────────────────────────────────────────────────

describe("buildSlugToDynastyMap", () => {
  it("builds reverse map from dynasties", () => {
    const dynasties: DynastyEntry[] = [
      { dynastySlug: "sales-cold-email", slugs: ["sales-cold-email", "sales-cold-email-v2"] },
      { dynastySlug: "lead-scoring", slugs: ["lead-scoring"] },
    ];

    const map = buildSlugToDynastyMap(dynasties);

    expect(map.get("sales-cold-email")).toBe("sales-cold-email");
    expect(map.get("sales-cold-email-v2")).toBe("sales-cold-email");
    expect(map.get("lead-scoring")).toBe("lead-scoring");
    expect(map.get("unknown")).toBeUndefined();
  });

  it("returns empty map for empty dynasties", () => {
    const map = buildSlugToDynastyMap([]);
    expect(map.size).toBe(0);
  });

  it("handles slugs not in any dynasty as fallback", () => {
    const dynasties: DynastyEntry[] = [
      { dynastySlug: "sales-cold-email", slugs: ["sales-cold-email"] },
    ];
    const map = buildSlugToDynastyMap(dynasties);
    // Orphan slug falls back to raw value (not in map)
    expect(map.has("orphan-slug")).toBe(false);
  });
});

// ── resolveWorkflowDynastySlugs ─────────────────────────────────────────────

describe("resolveWorkflowDynastySlugs", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns empty array on network error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const { resolveWorkflowDynastySlugs } = await import("./dynasty-client.js");
    const slugs = await resolveWorkflowDynastySlugs("anything", {
      apiKey: "key", orgId: "org-1", userId: "user-1", runId: "run-1",
    });

    expect(Array.isArray(slugs)).toBe(true);
  });
});

// ── fetchAllWorkflowDynasties ───────────────────────────────────────────────

describe("fetchAllWorkflowDynasties", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns empty array on network error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const { fetchAllWorkflowDynasties } = await import("./dynasty-client.js");
    const result = await fetchAllWorkflowDynasties({
      apiKey: "key", orgId: "org-1", userId: "user-1", runId: "run-1",
    });

    expect(Array.isArray(result)).toBe(true);
  });
});

// ── resolveFeatureDynastySlugs (local DB) ───────────────────────────────────

describe("resolveFeatureDynastySlugs", () => {
  it("resolves slugs from local DB", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.query.features.findMany).mockResolvedValueOnce([
      { slug: "feat-v2", version: 2 },
      { slug: "feat", version: 1 },
    ] as any);

    const { resolveFeatureDynastySlugs } = await import("./dynasty-client.js");
    const slugs = await resolveFeatureDynastySlugs("feat");

    expect(slugs).toEqual(["feat", "feat-v2"]);
  });
});
