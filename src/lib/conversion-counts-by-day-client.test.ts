import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchConversionCountsByDay } = await import("./conversion-counts-by-day-client.js");

describe("fetchConversionCountsByDay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads byDay + undated verbatim; service-auth headers (x-api-key + x-service-name), brand in path, org-less", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          byDay: {
            signup: { "2026-07-08": 2, "2026-07-09": 1 },
            meeting_booked: {},
            form_submission: { "2026-07-09": 3 },
            purchase: {},
          },
          undated: { signup: 0, meeting_booked: 0, form_submission: 0, purchase: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await fetchConversionCountsByDay("brand-1");

    expect(res.byDay.signup).toEqual({ "2026-07-08": 2, "2026-07-09": 1 });
    expect(res.byDay.form_submission).toEqual({ "2026-07-09": 3 });
    expect(res.byDay.meeting_booked).toEqual({});
    expect(res.undated).toEqual({ signup: 0, meeting_booked: 0, form_submission: 0, purchase: 0 });
    expect(seenUrl).toBe("http://lead:3000/internal/brands/brand-1/conversion-counts-by-day");
    expect(seenHeaders["x-api-key"]).toBe("lead-key");
    expect(seenHeaders["x-service-name"]).toBe("features-service");
    // Org-less internal read — no x-org-id / user identity forwarded.
    expect(seenHeaders["x-org-id"]).toBeUndefined();
    expect(seenHeaders["x-user-id"]).toBeUndefined();
  });

  it("returns all-empty byDay + all-zero undated (not absent) for a brand with zero conversions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          byDay: { signup: {}, meeting_booked: {}, form_submission: {}, purchase: {} },
          undated: { signup: 0, meeting_booked: 0, form_submission: 0, purchase: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const res = await fetchConversionCountsByDay("brand-1");
    expect(res.byDay.form_submission).toEqual({});
    expect(res.undated.form_submission).toBe(0);
  });

  it("fails loud on a non-OK response (no silent fallback — a swallowed error would fake a count)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchConversionCountsByDay("brand-1")).rejects.toThrow(/conversion-counts-by-day failed \(500\)/);
  });

  it("fails loud when byDay/undated are absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchConversionCountsByDay("brand-1")).rejects.toThrow(/malformed byDay\/undated/);
  });

  it("fails loud when a byDay day value is not a finite number (not a fabricated 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          byDay: { signup: { "2026-07-09": "x" }, meeting_booked: {}, form_submission: {}, purchase: {} },
          undated: { signup: 0, meeting_booked: 0, form_submission: 0, purchase: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(fetchConversionCountsByDay("brand-1")).rejects.toThrow(/byDay\.signup\.2026-07-09 is not a finite number/);
  });

  it("fails loud when an undated value is missing (not a fabricated 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          byDay: { signup: {}, meeting_booked: {}, form_submission: {}, purchase: {} },
          undated: { signup: 0, meeting_booked: 0, form_submission: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(fetchConversionCountsByDay("brand-1")).rejects.toThrow(/undated\.purchase is not a finite number/);
  });
});
