import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseRow } from "./fleet-return-store.js";

describe("fleet snapshot rows (ROI-CONSISTENCY-1103: only the showcase pick's fields)", () => {
  it("keeps when the brand began and how far its funnel reached; a stored return ingredient is ignored", () => {
    const stored = { brandId: "b1", committedSpendUsd: 120, expectedPipelineUsd: 300, isMature: true, startedOn: "2026-08-01", outcomeCount: 4, vendorSpend: { flashUsd: 80 } };
    expect(parseRow(stored)).toEqual({ brandId: "b1", startedOn: "2026-08-01", outcomeCount: 4 });
  });

  it("absent fields read as null, never 0", () => {
    expect(parseRow({ brandId: "b1" })).toEqual({ brandId: "b1", startedOn: null, outcomeCount: null });
  });

  it("a present-but-wrong-typed field makes the row malformed", () => {
    expect(parseRow({ brandId: "b1", outcomeCount: "4" })).toBeNull();
    expect(parseRow({ brandId: "b1", startedOn: 20260801 })).toBeNull();
    expect(parseRow({ outcomeCount: 4 })).toBeNull();
  });
});
