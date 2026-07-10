import { describe, it, expect } from "vitest";

const { parsePricing, selectCostCents, selectCostCentsString } = await import("./pricing.js");

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

describe("selectCostCents / selectCostCentsString", () => {
  // A runs-service cost group carrying BOTH gross fields and their frozen-NET twins (runs#179).
  const group = {
    totalCostInUsdCents: "1000",
    actualCostInUsdCents: "800",
    provisionedCostInUsdCents: "200",
    netTotalCostInUsdCents: "500",
    netActualCostInUsdCents: "400",
    netProvisionedCostInUsdCents: "100",
  };

  it("gross → reads the plain field verbatim (byte-identical to today)", () => {
    expect(selectCostCentsString(group, "totalCostInUsdCents", "gross")).toBe("1000");
    expect(selectCostCents(group, "actualCostInUsdCents", "gross")).toBe(800);
    expect(selectCostCents(group, "provisionedCostInUsdCents", "gross")).toBe(200);
  });

  it("net → reads the frozen net twin, NOT a read-time multiply", () => {
    expect(selectCostCentsString(group, "totalCostInUsdCents", "net")).toBe("500");
    expect(selectCostCents(group, "actualCostInUsdCents", "net")).toBe(400);
    expect(selectCostCents(group, "provisionedCostInUsdCents", "net")).toBe(100);
  });

  it("non-discounted org (runs freezes net == gross) → NET == GROSS", () => {
    const undiscounted = {
      totalCostInUsdCents: "1000",
      netTotalCostInUsdCents: "1000",
    };
    expect(selectCostCents(undiscounted, "totalCostInUsdCents", "net")).toBe(
      selectCostCents(undiscounted, "totalCostInUsdCents", "gross"),
    );
  });

  it("net with the frozen net twin ABSENT → THROWS (no silent fallback to gross)", () => {
    const grossOnly = { totalCostInUsdCents: "1000" }; // runs without #179 → no net twin
    expect(() => selectCostCents(grossOnly, "totalCostInUsdCents", "net")).toThrow(
      /missing frozen NET field 'netTotalCostInUsdCents'/,
    );
  });

  it("net with a non-numeric net twin → THROWS", () => {
    const bad = { totalCostInUsdCents: "1000", netTotalCostInUsdCents: "oops" };
    expect(() => selectCostCents(bad, "totalCostInUsdCents", "net")).toThrow(/net pricing requested/);
  });

  it("gross with the field missing → THROWS (fail-loud, never a fake $0)", () => {
    expect(() => selectCostCents({}, "totalCostInUsdCents", "gross")).toThrow(/missing 'totalCostInUsdCents'/);
  });
});
