import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the brand-client module by mocking global fetch
// to verify it correctly converts the array response from brand-service
// into a keyed Record for features-service consumption.

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

  it("calls POST /brands/extract-fields with x-brand-id header", async () => {
    const arrayResponse = {
      results: [
        {
          key: "biography",
          value: "A leading AI company",
          cached: true,
          extractedAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-04-01T00:00:00Z",
          sourceUrls: ["https://example.com"],
        },
        {
          key: "keyProjects",
          value: ["Project A", "Project B"],
          cached: false,
          extractedAt: "2026-03-26T00:00:00Z",
          expiresAt: null,
          sourceUrls: null,
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(arrayResponse),
    });
    globalThis.fetch = mockFetch;

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    const results = await extractBrandFields(
      [
        { key: "biography", description: "Company biography" },
        { key: "keyProjects", description: "Key projects" },
      ],
      { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-123" },
    );

    // Verify URL uses /brands/extract-fields (no brandId in path)
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BRAND_SERVICE_URL}/brands/extract-fields`);

    // Verify x-brand-id header is forwarded
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-brand-id"]).toBe("brand-123");

    expect(results).toHaveProperty("biography");
    expect(results).toHaveProperty("keyProjects");
    expect(results.biography.value).toBe("A leading AI company");
    expect(results.biography.cached).toBe(true);
    expect(results.keyProjects.value).toEqual(["Project A", "Project B"]);
    expect(results.keyProjects.cached).toBe(false);
  });

  it("supports CSV brand IDs in x-brand-id header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    globalThis.fetch = mockFetch;

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    await extractBrandFields(
      [{ key: "bio", description: "Bio" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "uuid1,uuid2,uuid3" },
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-brand-id"]).toBe("uuid1,uuid2,uuid3");
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
        [{ key: "bio", description: "Bio" }],
        { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-123" },
      ),
    ).rejects.toThrow("brand-service extract-fields failed (500)");
  });

  it("throws when brandId header is missing", async () => {
    const { extractBrandFields } = await import("../src/lib/brand-client.js");

    await expect(
      extractBrandFields(
        [{ key: "bio", description: "Bio" }],
        { orgId: "org-1", userId: "user-1", runId: "run-1" },
      ),
    ).rejects.toThrow("x-brand-id header is required");
  });

  it("handles empty results array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    const results = await extractBrandFields(
      [{ key: "biography", description: "Bio" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-123" },
    );

    expect(Object.keys(results)).toHaveLength(0);
    expect(results.biography).toBeUndefined();
  });

  it("forwards x-campaign-id and x-feature-slug when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    globalThis.fetch = mockFetch;

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    await extractBrandFields(
      [{ key: "bio", description: "Bio" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-123", campaignId: "camp-42", featureSlug: "pr-outreach" },
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-campaign-id"]).toBe("camp-42");
    expect(opts.headers["x-feature-slug"]).toBe("pr-outreach");
  });

  it("omits x-campaign-id and x-feature-slug when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    globalThis.fetch = mockFetch;

    const { extractBrandFields } = await import("../src/lib/brand-client.js");
    await extractBrandFields(
      [{ key: "bio", description: "Bio" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-123" },
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-campaign-id"]).toBeUndefined();
    expect(opts.headers["x-feature-slug"]).toBeUndefined();
  });
});
