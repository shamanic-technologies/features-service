import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { monthWindows } from "./fleet-index-history-io.js";

// MEETING-COST-METHODS-1024: a dated read runs-service cannot answer in one go is asked month by month.
describe("monthWindows", () => {
  it("covers every month from the first through the current one, disjoint and contiguous", () => {
    expect(monthWindows("2026-11", new Date("2027-01-15T10:00:00Z"))).toEqual([
      ["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"],
      ["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
      ["2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z"],
    ]);
  });
});
