import { describe, it, expect, vi, afterEach } from "vitest";
import { __resetFactsFingerprints, brandIdOfRequest, factsFingerprint, fingerprintOf } from "./view-facts.js";

describe("fingerprintOf", () => {
  it("ignores the answers' timestamps and their key order", () => {
    const a = fingerprintOf([{ org_id: "o", total_expected_cents: "12.5", as_of: "2026-09-26T10:00:00Z" }, { total: 3, counts: { a: 1, b: 2 } }]);
    const b = fingerprintOf([{ as_of: "2026-09-26T11:00:00Z", total_expected_cents: "12.5", org_id: "o" }, { counts: { b: 2, a: 1 }, total: 3 }]);
    expect(a).toBe(b);
  });

  it("moves when any fact moves", () => {
    const base = fingerprintOf([{ total_expected_cents: "12.5" }, { counts: { contacted: 10 } }]);
    expect(fingerprintOf([{ total_expected_cents: "12.6" }, { counts: { contacted: 10 } }])).not.toBe(base);
    expect(fingerprintOf([{ total_expected_cents: "12.5" }, { counts: { contacted: 11 } }])).not.toBe(base);
  });
});

describe("brandIdOfRequest", () => {
  const brand = "75d7e3e8-6926-4f85-a557-976895400666";
  it("reads the brand from the path first", () => {
    expect(brandIdOfRequest(`/brands/${brand}/revenue?pricing=net`, {})).toBe(brand);
  });
  it("then from the query", () => {
    expect(brandIdOfRequest(`/offers/x/revenue?brandId=${brand}`, {})).toBe(brand);
  });
  it("then from the header", () => {
    expect(brandIdOfRequest(`/features/s/stats`, { "x-brand-id": brand })).toBe(brand);
  });
  it("names no brand when none is a uuid", () => {
    expect(brandIdOfRequest(`/features/s/stats?brandId=nope`, {})).toBeNull();
  });
});

describe("factsFingerprint lead reads (MON-DB-HOT-1112)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFactsFingerprints();
  });

  it("tells lead-service a fingerprint is not a read that keeps its model warm", async () => {
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "rk";
    process.env.LEAD_SERVICE_URL = "http://lead";
    process.env.LEAD_SERVICE_API_KEY = "lk";
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = url instanceof Request ? url.url : String(url);
      seen.push({ url: u, headers: new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined)) });
      return new Response(JSON.stringify({ total: 1 }), { status: 200 });
    });
    expect(await factsFingerprint({ orgId: "o", brandId: "b" })).not.toBeNull();
    const leadReads = seen.filter((r) => r.url.startsWith("http://lead/"));
    expect(leadReads).toHaveLength(2);
    for (const r of leadReads) expect(r.headers.get("x-lead-read-keep-warm")).toBe("false");
  });
});
