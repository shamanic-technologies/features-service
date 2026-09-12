/**
 * Guards for the two write rules of the stated-monthly-amounts store: a coherent range, and NO two
 * ranges in force on the same day for one (org, brand). The overlap rule is what stops the read side
 * ever having to choose between two answers for one brand on one day.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  assertNoOverlap,
  describeRange,
  rangesOverlap,
  StatedAmountConflictError,
  type StatedAmountRow,
} from "./stated-monthly-amounts-store.js";

function row(id: string, startDate: string | null, endDate: string | null): StatedAmountRow {
  return {
    id,
    orgId: "org",
    brandId: "brand",
    amountUsd: 5000,
    startDate,
    endDate,
    note: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("range overlap", () => {
  it("treats an absent bound as open, so two open-ended rows always collide", () => {
    expect(rangesOverlap({ startDate: null, endDate: null }, { startDate: "2026-08-01", endDate: null })).toBe(true);
    expect(rangesOverlap({ startDate: "2026-01-01", endDate: null }, { startDate: null, endDate: "2020-01-01" })).toBe(false);
  });

  it("is INCLUSIVE at both ends — sharing a single day is an overlap", () => {
    expect(rangesOverlap({ startDate: "2026-08-01", endDate: "2026-08-31" }, { startDate: "2026-08-31", endDate: "2026-09-30" })).toBe(true);
    expect(rangesOverlap({ startDate: "2026-08-01", endDate: "2026-08-31" }, { startDate: "2026-09-01", endDate: null })).toBe(false);
  });
});

describe("assertNoOverlap", () => {
  it("accepts back-to-back ranges that share no day", () => {
    expect(() => assertNoOverlap({ startDate: "2026-09-01", endDate: null }, [row("a", "2026-07-01", "2026-08-31")])).not.toThrow();
  });

  it("REFUSES an overlap with a message naming the colliding row and its range", () => {
    let caught: unknown;
    try {
      assertNoOverlap({ startDate: "2026-08-15", endDate: null }, [row("existing-id", "2026-07-01", null)]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StatedAmountConflictError);
    const message = (caught as Error).message;
    expect(message).toContain("existing-id");
    expect(message).toContain("2026-08-15");
    expect(message).toContain("2026-07-01");
    expect(message).toContain("only be worth one amount on a given day");
  });

  it("lets a row be edited without colliding with itself", () => {
    expect(() => assertNoOverlap({ startDate: "2026-07-01", endDate: null }, [row("same", "2026-07-01", null)], "same")).not.toThrow();
  });

  it("refuses a range that ends before it begins", () => {
    expect(() => assertNoOverlap({ startDate: "2026-09-01", endDate: "2026-08-01" }, [])).toThrow(/cannot end before it begins/);
  });
});

describe("describeRange", () => {
  it("says what an absent bound MEANS rather than printing a blank", () => {
    expect(describeRange(null, null)).toBe("the brand's first billed day → today");
    expect(describeRange("2026-08-01", "2026-08-31")).toBe("2026-08-01 → 2026-08-31");
  });
});
