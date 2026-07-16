import { describe, it, expect } from "vitest";

import { selectBucketActualCents } from "./revenue-history-client.js";

describe("selectBucketActualCents — realized revenue prefers the frozen-NET twin", () => {
  it("uses netActualCostInUsdCents when present (NET = what we collect after the usage discount)", () => {
    const r = selectBucketActualCents({
      period: "2026-07-01",
      actualCostInUsdCents: "10000.0000000000",
      netActualCostInUsdCents: "7500.0000000000",
    });
    expect(r).toEqual({ cents: 7500, net: true });
  });

  it("falls back to GROSS actualCostInUsdCents (net:false) when the net twin is absent (runs deploy not yet live)", () => {
    const r = selectBucketActualCents({
      period: "2026-07-01",
      actualCostInUsdCents: "10000.0000000000",
    });
    expect(r).toEqual({ cents: 10000, net: false });
  });

  it("treats an empty / non-numeric net twin as absent → gross fallback", () => {
    expect(selectBucketActualCents({ actualCostInUsdCents: "42", netActualCostInUsdCents: "" })).toEqual({ cents: 42, net: false });
    expect(selectBucketActualCents({ actualCostInUsdCents: "42", netActualCostInUsdCents: "not-a-number" })).toEqual({ cents: 42, net: false });
  });

  it("throws when BOTH the net and gross fields are absent / non-numeric (corruption, fail loud)", () => {
    expect(() => selectBucketActualCents({ period: "2026-07-01" })).toThrow(/missing both/);
    expect(() => selectBucketActualCents({ actualCostInUsdCents: "" })).toThrow(/missing both/);
  });
});
