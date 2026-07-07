import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchConversionEmails } = await import("./conversion-emails-client.js");

describe("fetchConversionEmails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a normalised (lowercase/trim, deduped) Set; service-auth headers, brand in path, event query", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ emails: ["A1@x.com", " a1@x.com ", "b2@x.com"] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await fetchConversionEmails("brand-1", "form_submission");

    // A1@x.com and " a1@x.com " collapse to one normalised entry.
    expect([...res].sort()).toEqual(["a1@x.com", "b2@x.com"]);
    expect(seenUrl).toBe("http://lead:3000/internal/brands/brand-1/conversion-emails?event=form_submission");
    expect(seenHeaders["x-api-key"]).toBe("lead-key");
    expect(seenHeaders["x-service-name"]).toBe("features-service");
    // Org-less internal read — no forwarded user identity.
    expect(seenHeaders["x-org-id"]).toBeUndefined();
    expect(seenHeaders["x-user-id"]).toBeUndefined();
  });

  it("returns an empty Set (not an error) when the brand has no attributed conversions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ emails: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const res = await fetchConversionEmails("brand-1", "form_submission");
    expect(res.size).toBe(0);
  });

  it("fails loud on a non-OK response (a swallowed error would fabricate zero conversions)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchConversionEmails("brand-1", "form_submission")).rejects.toThrow(/conversion-emails failed \(500\)/);
  });

  it("fails loud on a malformed body (no emails array)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchConversionEmails("brand-1", "form_submission")).rejects.toThrow(/no emails array/);
  });

  it("fails loud on a non-string email element", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ emails: ["a1@x.com", 42] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchConversionEmails("brand-1", "form_submission")).rejects.toThrow(/non-string email/);
  });
});
