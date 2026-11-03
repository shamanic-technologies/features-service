import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { recapReturnsOf } = await import("./org-period-recap.js");

// ROI-CONSISTENCY-1103: the monthly recap states only the two returns that exist where a value lands,
// each read off the SAME offer body the dashboard reads (never recomputed): the EXPECTED return
// (`expectedReturn`) and the REALIZED return (`costEconomics.realizedReturn`).
const offer = (over: Record<string, unknown> = {}) => ({
  offerId: "o1",
  pair: null,
  pipelineUsd: 6960,
  committedCostUsd: 233.65,
  expected: { roiMultiple: 18.53, basis: "default", unavailableReason: null },
  realized: { roiMultiple: 0, closedWonCount: 0, closedWonRevenueUsd: 0, spentUsd: 93.56 },
  ...over,
});

describe("recap returns: expected + realized, read off the offer body", () => {
  it("states one sender's expected and realized returns as served (Beyond Logic)", () => {
    const r = recapReturnsOf([{ brandId: "b1", returns: [offer()] }]);
    expect(r.expected).toMatchObject({ roiMultiple: 18.53, basis: "default", nullReason: null });
    expect(r.realized).toMatchObject({ roiMultiple: 0, closedWonCount: 0, closedWonRevenueUsd: 0, spentUsd: 93.56, nullReason: null });
    expect(r.expected.scopes).toHaveLength(1);
  });

  it("nothing sent = both null nothing_sent", () => {
    const r = recapReturnsOf([]);
    expect(r.expected.nullReason).toBe("nothing_sent");
    expect(r.realized.nullReason).toBe("nothing_sent");
  });

  it("two scopes with different expected returns = null, never a blend", () => {
    const r = recapReturnsOf([
      { brandId: "b1", returns: [offer()] },
      { brandId: "b2", returns: [offer({ offerId: "o2", expected: { roiMultiple: 4, basis: "measured", unavailableReason: null } })] },
    ]);
    expect(r.expected.roiMultiple).toBeNull();
    expect(r.expected.nullReason).toBe("return_differs_across_scopes");
  });

  it("several scopes = no single realized figure (brand-level spend joins every offer in full: never summed)", () => {
    const r = recapReturnsOf([{ brandId: "b1", returns: [offer(), offer({ offerId: "o2" })] }]);
    expect(r.realized.roiMultiple).toBeNull();
    expect(r.realized.nullReason).toBe("several_scopes");
    expect(r.realized.scopes).toHaveLength(2);
  });

  it("a scope whose figure is not served = null with that scope's reason", () => {
    const r = recapReturnsOf([{ brandId: "b1", returns: [offer({ expected: { roiMultiple: null, basis: null, unavailableReason: "own_sales_path_unpriced" }, realized: null })] }]);
    expect(r.expected.nullReason).toBe("return_unavailable");
    expect(r.expected.scopes[0].unavailableReason).toBe("own_sales_path_unpriced");
    expect(r.realized.nullReason).toBe("return_unavailable");
  });

  it("a brand whose offers could not be read = return_unavailable", () => {
    const r = recapReturnsOf([{ brandId: "b1", returns: null }]);
    expect(r.expected.nullReason).toBe("return_unavailable");
    expect(r.realized.nullReason).toBe("return_unavailable");
  });
});
