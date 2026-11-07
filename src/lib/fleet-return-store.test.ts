import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseRow } from "./fleet-return-store.js";

describe("fleet snapshot rows (only the showcase pick's fields)", () => {
  it("keeps the furthest rung and the hero counts; a stored return ingredient or start day is ignored", () => {
    const stored = { brandId: "b1", committedSpendUsd: 120, expectedPipelineUsd: 300, isMature: true, startedOn: "2026-08-01", outcomeCount: 4, meetingsBooked: 3, positiveReplies: 20, vendorSpend: { flashUsd: 80 } };
    expect(parseRow(stored)).toEqual({ brandId: "b1", outcomeCount: 4, meetingsBooked: 3, positiveReplies: 20 });
  });

  it("absent fields read as null, never 0", () => {
    expect(parseRow({ brandId: "b1" })).toEqual({ brandId: "b1", outcomeCount: null, meetingsBooked: null, positiveReplies: null });
  });

  it("a present-but-wrong-typed field makes the row malformed", () => {
    expect(parseRow({ brandId: "b1", outcomeCount: "4" })).toBeNull();
    expect(parseRow({ brandId: "b1", meetingsBooked: "3" })).toBeNull();
    expect(parseRow({ outcomeCount: 4 })).toBeNull();
  });
});
