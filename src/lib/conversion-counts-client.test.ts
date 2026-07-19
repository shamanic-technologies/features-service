import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchConversionCounts } = await import("./conversion-counts-client.js");

describe("fetchConversionCounts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the four attributed counts verbatim; service-auth headers (x-api-key + x-service-name), brand in path, org-less", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ counts: { signup: 4, meeting_booked: 2, form_submission: 7, sale: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await fetchConversionCounts("brand-1");

    expect(res).toEqual({ signup: 4, meeting_booked: 2, form_submission: 7, sale: 1 });
    expect(seenUrl).toBe("http://lead:3000/internal/brands/brand-1/conversion-counts");
    expect(seenHeaders["x-api-key"]).toBe("lead-key");
    expect(seenHeaders["x-service-name"]).toBe("features-service");
    // Org-less internal read — no x-org-id / user identity forwarded.
    expect(seenHeaders["x-org-id"]).toBeUndefined();
    expect(seenHeaders["x-user-id"]).toBeUndefined();
  });

  it("returns zeros (not absent) when the brand has no conversions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const res = await fetchConversionCounts("brand-1");
    expect(res).toEqual({ signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 });
  });

  it("fails loud on a non-OK response (no silent fallback — a swallowed error would fake a count)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchConversionCounts("brand-1")).rejects.toThrow(/conversion-counts failed \(500\)/);
  });

  it("fails loud on a malformed body (missing a key → not a fabricated 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ counts: { signup: 4, meeting_booked: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchConversionCounts("brand-1")).rejects.toThrow(/malformed counts/);
  });

  it("fails loud when the counts envelope is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchConversionCounts("brand-1")).rejects.toThrow(/malformed counts/);
  });
});
