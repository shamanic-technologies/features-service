import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A brand deleted after its feature membership was recorded answers 404 from brand-service.
 * Every fleet fan-out skips a BrandOwnershipError; a plain Error takes the whole read down.
 * Pinned because one deleted brand 500'd the public workflow-cost-per-outcome read for every
 * caller on 2026-09-18.
 */
describe("sales-economics-client: a deleted brand is a stale membership", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function load() {
    vi.resetModules();
    process.env.BRAND_SERVICE_URL = "http://brand";
    process.env.BRAND_SERVICE_API_KEY = "k";
    return import("./sales-economics-client.js");
  }

  for (const status of [403, 404]) {
    it(`throws BrandOwnershipError on ${status} for the effective read`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "Brand not found" }), { status })),
      );
      const { fetchEffectiveEconomics, BrandOwnershipError } = await load();
      await expect(
        fetchEffectiveEconomics("b1", { orgId: "o1", featureSlug: "sales-cold-email-outreach" }),
      ).rejects.toBeInstanceOf(BrandOwnershipError);
    });

    it(`throws BrandOwnershipError on ${status} for the org-scoped read`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));
      const { fetchSalesEconomics, BrandOwnershipError } = await load();
      await expect(fetchSalesEconomics("b1", { orgId: "o1" })).rejects.toBeInstanceOf(
        BrandOwnershipError,
      );
    });
  }

  it("still fails loud on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { fetchEffectiveEconomics, BrandOwnershipError } = await load();
    const err = await fetchEffectiveEconomics("b1", { orgId: "o1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BrandOwnershipError);
  });
});
