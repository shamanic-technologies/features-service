import { describe, it, expect, vi, afterEach } from "vitest";

vi.unmock("./contacted-value-unavailable.js");
const { readOrUnavailable, ContactedValueUnavailableError, contactedValueUnavailableBody } = await import("./contacted-value-unavailable.js");

describe("readOrUnavailable: retry once, then loud (never a silent $0)", () => {
  it("answers on the first try", async () => {
    const read = vi.fn(async () => 7);
    expect(await readOrUnavailable("b1", "send_dates_unreadable", "x", read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a read failing once then answering is served", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("504")).mockResolvedValueOnce(9);
    expect(await readOrUnavailable("b1", "send_dates_unreadable", "x", read)).toBe(9);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("failing twice throws the named reason, and the route body says it", async () => {
    const read = vi.fn(async () => {
      throw new Error("email-gateway down");
    });
    const err = await readOrUnavailable("b1", "contacted_pricing_unreadable", "x", read).catch((e) => e);
    expect(err).toBeInstanceOf(ContactedValueUnavailableError);
    expect(err.reason).toBe("contacted_pricing_unreadable");
    expect(read).toHaveBeenCalledTimes(2);
    expect(contactedValueUnavailableBody(err)).toMatchObject({
      reason: "contacted_value_unavailable",
      detail: "contacted_pricing_unreadable",
      brandId: "b1",
    });
  });
});

/**
 * CONTACTED-PRICING-403-1025. The contacted-lead pricing cell's read runs brand-service's ownership check
 * (`assertBrandHeld`, `/orgs/brands/:id/leg-rates`). A fleet sweep walks lead-service feature memberships, some of
 * whose orgs no longer hold the brand: brand-service answers 403 to that identity, correctly. That answer is an
 * OWNERSHIP verdict, not an unreadable read: it must surface as itself (so the sweep skips the stale pair and a
 * dashboard route refuses the foreign brand), never be retried nor relabelled "contacted value unavailable".
 */
describe("readOrUnavailable around the brand ownership check", () => {
  afterEach(() => vi.restoreAllMocks());

  process.env.BRAND_SERVICE_URL = "http://brand:3000";
  process.env.BRAND_SERVICE_API_KEY = "brand-key";

  /** brand-service: brand-1 is held by org-A only. */
  function brandServiceHoldingFor(owner: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const org = (init?.headers as Record<string, string>)["x-org-id"];
      return org === owner
        ? new Response(JSON.stringify({ legRates: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "Brand does not belong to the caller's org" }), { status: 403 });
    });
  }

  it("a stale membership's org (not the owner) gets the ownership verdict once: no retry, no 'unavailable' relabel", async () => {
    const { assertBrandHeld, BrandOwnershipError } = await import("./brand-ownership.js");
    const fetchSpy = brandServiceHoldingFor("org-A");
    const read = vi.fn(async () => {
      await assertBrandHeld("brand-1", { orgId: "org-STALE" });
      return "cell";
    });
    const err = await readOrUnavailable("brand-1", "contacted_pricing_unreadable", "contacted-lead pricing cell", read).catch((e) => e);
    expect(err).toBeInstanceOf(BrandOwnershipError);
    expect(err).not.toBeInstanceOf(ContactedValueUnavailableError);
    expect(err.message).toContain("(403)");
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the owning org computes the cell", async () => {
    const { assertBrandHeld } = await import("./brand-ownership.js");
    brandServiceHoldingFor("org-A");
    const read = vi.fn(async () => {
      await assertBrandHeld("brand-1", { orgId: "org-A" });
      return "cell";
    });
    expect(await readOrUnavailable("brand-1", "contacted_pricing_unreadable", "contacted-lead pricing cell", read)).toBe("cell");
  });

  it("a verdict arriving on the retry (first try transient) is also rethrown as itself", async () => {
    const { BrandOwnershipError } = await import("./brand-ownership.js");
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new BrandOwnershipError("brand-1", "org-B", "brand-service leg-rates ownership check failed (403)"));
    const err = await readOrUnavailable("brand-1", "contacted_pricing_unreadable", "x", read).catch((e) => e);
    expect(err).toBeInstanceOf(BrandOwnershipError);
  });
});
