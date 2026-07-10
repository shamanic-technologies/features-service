import { describe, it, expect, vi, afterEach } from "vitest";

process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";

const { parsePricing, resolveDiscountFactor, discountCents } = await import("./pricing.js");

const OK = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

describe("parsePricing", () => {
  it("defaults to gross when omitted / empty", () => {
    expect(parsePricing(undefined)).toBe("gross");
    expect(parsePricing(null)).toBe("gross");
    expect(parsePricing("")).toBe("gross");
  });
  it("accepts the two literals", () => {
    expect(parsePricing("gross")).toBe("gross");
    expect(parsePricing("net")).toBe("net");
  });
  it("returns null for anything else (caller 400s — no silent coercion)", () => {
    expect(parsePricing("NET")).toBeNull();
    expect(parsePricing("discounted")).toBeNull();
    expect(parsePricing("true")).toBeNull();
  });
});

describe("discountCents", () => {
  it("scales + rounds to whole cents", () => {
    expect(discountCents(1000, 1)).toBe(1000);
    expect(discountCents(1000, 0.5)).toBe(500);
    expect(discountCents(999, 0.5)).toBe(500); // round(499.5) = 500
    expect(discountCents(0, 0.5)).toBe(0);
  });
});

describe("resolveDiscountFactor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gross → 1 WITHOUT any billing call (default path has zero billing dependency)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await resolveDiscountFactor("gross", "org-1")).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("net → 1 − pct/100 from billing (50% → 0.5)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => OK({ discount_percent: 50 }));
    expect(await resolveDiscountFactor("net", "org-1")).toBe(0.5);
  });

  it("net for a non-discounted org (0%) → factor 1 → NET == GROSS", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => OK({ discount_percent: 0 }));
    expect(await resolveDiscountFactor("net", "org-1")).toBe(1);
  });

  it("net fails loud when the discount is unresolvable — NEVER falls back to gross", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(resolveDiscountFactor("net", "org-1")).rejects.toThrow(/usage-discount failed/);
  });
});
