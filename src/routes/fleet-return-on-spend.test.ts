import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

/**
 * Guard suite for `GET /public/stats/return-on-spend` (the public landing's third live figure).
 *
 * The properties under test are the ones the CONSUMER depends on, and each one is a way this could
 * silently fail:
 *   • it answers with NO identity of any kind — the page is public and statically rendered;
 *   • it NEVER awaits the heavy compute, cold or stale, because the consumer's whole budget is 8s and
 *     its fallback is to drop the stat (a read that can take minutes is the same as no read);
 *   • an unmeasurable answer says WHICH kind it is and never substitutes a 0 or a wider population;
 *   • the spend floor is a parameter of the QUESTION, so one snapshot answers at any floor;
 *   • a bad floor is a 400, never a silent fall back to the default.
 */

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: { findFirst: (...a: unknown[]) => mockFindFirst(...a), findMany: (...a: unknown[]) => mockFindMany(...a) },
    },
  },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

const mockReadSnapshot = vi.fn();
const mockWriteSnapshot = vi.fn(async () => {});
vi.mock("../lib/fleet-return-store.js", () => ({
  readFleetReturnSnapshotSoft: (...a: unknown[]) => mockReadSnapshot(...a),
  writeFleetReturnSnapshotSoft: (...a: unknown[]) => mockWriteSnapshot(...(a as [])),
}));

/** The warm's only downstream on this path — an empty membership set keeps the engine out of the test. */
const mockFetchMemberships = vi.fn(async () => [] as unknown[]);
vi.mock("../lib/feature-memberships-client.js", () => ({
  fetchFeatureMemberships: (...a: unknown[]) => mockFetchMemberships(...(a as [])),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const { __awaitFleetReturnWarm } = await import("./public.js");

const FEATURE_SLUG = "sales-cold-email-outreach";
const PATH = `/public/stats/return-on-spend?featureSlug=${FEATURE_SLUG}`;
const MOCK_FEATURE = { id: "feat-1", slug: FEATURE_SLUG, name: "Sales", description: "t", status: "active" };

/** A brand that spent `spend` and is expected to return `spend * multiple`. */
const at = (brandId: string, spend: number, multiple: number | null) => ({
  brandId,
  committedSpendUsd: spend,
  expectedPipelineUsd: multiple === null ? null : spend * multiple,
});

/** Five real brands at 1x / 2x / 3x / 40x / 57x, plus one that never got past a few dollars. */
const BRANDS = [
  at("b1", 5000, 1),
  at("b2", 5000, 2),
  at("b3", 5000, 3),
  at("b4", 5000, 40),
  at("b5", 5000, 57),
  at("barely-started", 12, 900),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(MOCK_FEATURE);
  mockFetchMemberships.mockResolvedValue([]);
});

afterEach(async () => {
  await __awaitFleetReturnWarm();
});

describe("GET /public/stats/return-on-spend", () => {
  it("answers with NO identity headers at all — the consumer is a public, statically-rendered page", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: new Date() });
    const res = await request(app).get(PATH); // no x-api-key, no x-org-id, no x-user-id, no x-run-id
    expect(res.status).toBe(200);
    expect(res.body.measured).toBe(true);
  });

  it("states the MEDIAN and the number of brands it was taken over", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: new Date("2026-09-08T10:00:00Z") });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      costBasis: "charged",
      featureSlug: FEATURE_SLUG,
      unit: "brand",
      measured: true,
      reason: null,
      minSpendUsd: 100,
      brandCount: 5, // the $12 brand is out
    });
    expect(res.body.medianReturnPerDollar).toBeCloseTo(3, 10);
    expect(res.body.computedAt).toBe("2026-09-08T10:00:00.000Z");
    // Never a mean: the mean of 1/2/3/40/57 is 20.6, which describes nobody in the population.
    expect(res.body.medianReturnPerDollar).not.toBeCloseTo(20.6, 1);
  });

  it("answers at ANY floor from the SAME snapshot, without recomputing anything", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: new Date() });
    const wide = await request(app).get(`${PATH}&minSpendUsd=0`);
    expect(wide.body.brandCount).toBe(6);
    expect(wide.body.minSpendUsd).toBe(0);
    const narrow = await request(app).get(`${PATH}&minSpendUsd=100`);
    expect(narrow.body.brandCount).toBe(5);
    expect(wide.body.medianReturnPerDollar).not.toBeCloseTo(narrow.body.medianReturnPerDollar, 6);
    // Two questions, one stored snapshot — the store was read, never rebuilt.
    expect(mockWriteSnapshot).not.toHaveBeenCalled();
  });

  it("says NO SNAPSHOT YET rather than blocking on the compute, and kicks the warm behind the answer", async () => {
    mockReadSnapshot.mockResolvedValue(null);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ measured: false, reason: "no_snapshot_yet", brandCount: 0, computedAt: null });
    expect(res.body.medianReturnPerDollar).toBeNull();
    // The answer did not wait for it, but a refresh IS on its way.
    await __awaitFleetReturnWarm();
    expect(mockFetchMemberships).toHaveBeenCalled();
  });

  it("SERVES a stale snapshot and refreshes behind the response — it never recomputes on the request path", async () => {
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000);
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: old });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.measured).toBe(true);
    expect(res.body.medianReturnPerDollar).toBeCloseTo(3, 10);
    expect(res.body.computedAt).toBe(old.toISOString());
    await __awaitFleetReturnWarm();
    expect(mockFetchMemberships).toHaveBeenCalled();
  });

  it("does NOT refresh a fresh snapshot", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: new Date() });
    await request(app).get(PATH);
    await __awaitFleetReturnWarm();
    expect(mockFetchMemberships).not.toHaveBeenCalled();
  });

  it("says NOT ENOUGH BRANDS instead of widening the population to make a number appear", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS.slice(0, 2), computedAt: new Date() });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ measured: false, reason: "not_enough_brands", brandCount: 2 });
    expect(res.body.medianReturnPerDollar).toBeNull();
    expect(res.body.p25ReturnPerDollar).toBeNull();
    expect(res.body.maxReturnPerDollar).toBeNull();
  });

  it("400s a floor it cannot read, rather than quietly using the default", async () => {
    mockReadSnapshot.mockResolvedValue({ brands: BRANDS, computedAt: new Date() });
    for (const bad of ["lots", "-1", "NaN"]) {
      const res = await request(app).get(`${PATH}&minSpendUsd=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/minSpendUsd/);
    }
  });

  it("400s a missing featureSlug and 404s a feature that does not exist", async () => {
    const missing = await request(app).get("/public/stats/return-on-spend");
    expect(missing.status).toBe(400);

    mockFindFirst.mockResolvedValue(undefined);
    const unknown = await request(app).get("/public/stats/return-on-spend?featureSlug=nope");
    expect(unknown.status).toBe(404);
  });

  it("degrades to 'no snapshot' when the store read fails — a blip never 502s the landing", async () => {
    // The store is fail-soft by contract: an unreadable snapshot reads as absent.
    mockReadSnapshot.mockResolvedValue(null);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("no_snapshot_yet");
  });
});
