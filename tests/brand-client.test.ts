import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the brand-client module by mocking global fetch
// to verify it correctly handles the new keyed-object response format.

describe("extractBrandFields", () => {
  const originalFetch = globalThis.fetch;
  const BRAND_SERVICE_URL = "https://brand.test";
  const BRAND_SERVICE_API_KEY = "test-key";

  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = BRAND_SERVICE_URL;
    process.env.BRAND_SERVICE_API_KEY = BRAND_SERVICE_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.BRAND_SERVICE_URL;
    delete process.env.BRAND_SERVICE_API_KEY;
  });

  it("parses keyed-object response format (new format)", async () => {
    const keyedResponse = {
      brandId: "brand-123",
      results: {
        biography: {
          value: "A leading AI company",
          cached: true,
          extractedAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-04-01T00:00:00Z",
          sourceUrls: ["https://example.com"],
        },
        keyProjects: {
          value: ["Project A", "Project B"],
          cached: false,
          extractedAt: "2026-03-26T00:00:00Z",
          expiresAt: null,
          sourceUrls: null,
        },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(keyedResponse),
    });

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    const results = await extractBrandFields(
      "brand-123",
      [
        { key: "biography", description: "Company biography" },
        { key: "keyProjects", description: "Key projects" },
      ],
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    // Results should be a keyed object, not an array
    expect(results).toHaveProperty("biography");
    expect(results).toHaveProperty("keyProjects");
    expect(results.biography.value).toBe("A leading AI company");
    expect(results.biography.cached).toBe(true);
    expect(results.keyProjects.value).toEqual(["Project A", "Project B"]);
    expect(results.keyProjects.cached).toBe(false);

    // Access by key — no .key field on items
    expect((results.biography as any).key).toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal server error"),
    });

    const { extractBrandFields } = await import("../src/lib/brand-client.js");

    await expect(
      extractBrandFields(
        "brand-123",
        [{ key: "bio", description: "Bio" }],
        { orgId: "org-1", userId: "user-1", runId: "run-1" },
      ),
    ).rejects.toThrow("brand-service extract-fields failed (500)");
  });

  it("handles empty results object", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brandId: "brand-123", results: {} }),
    });

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    const results = await extractBrandFields(
      "brand-123",
      [{ key: "biography", description: "Bio" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(Object.keys(results)).toHaveLength(0);
    expect(results.biography).toBeUndefined();
  });
});
