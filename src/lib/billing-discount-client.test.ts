import { describe, it, expect, vi, afterEach } from "vitest";

process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";

const { fetchOrgUsageDiscountPct } = await import("./billing-discount-client.js");

const OK = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

describe("fetchOrgUsageDiscountPct", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads discount_percent and hits the user-less internal path with api-key only", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenUrl = typeof input === "string" ? input : (input as URL).toString();
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return OK({ discount_percent: 50 });
    });
    const pct = await fetchOrgUsageDiscountPct("org-1");
    expect(pct).toBe(50);
    expect(seenUrl).toBe("http://billing:3000/internal/accounts/by-org/org-1/usage-discount");
    expect(seenHeaders["x-api-key"]).toBe("billing-key");
    // Never forwards a user/run/org header — this is a platform read.
    expect(seenHeaders["x-user-id"]).toBeUndefined();
    expect(seenHeaders["x-org-id"]).toBeUndefined();
  });

  it("a non-discounted org resolves to 0 (no error) — NET will equal GROSS", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => OK({ discount_percent: 0 }));
    expect(await fetchOrgUsageDiscountPct("org-1")).toBe(0);
  });

  it("fails loud on a non-OK response (404 → unresolvable, never a silent 0 fallback)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
    await expect(fetchOrgUsageDiscountPct("org-1")).rejects.toThrow(/usage-discount failed \(404\)/);
  });

  it("fails loud on a non-numeric discount_percent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => OK({ discount_percent: "half" }));
    await expect(fetchOrgUsageDiscountPct("org-1")).rejects.toThrow(/non-numeric/);
  });

  it("fails loud on an out-of-range discount_percent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => OK({ discount_percent: 150 }));
    await expect(fetchOrgUsageDiscountPct("org-1")).rejects.toThrow(/out of range/);
  });
});
