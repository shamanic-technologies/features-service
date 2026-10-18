import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { spendWindows } from "./research.js";

describe("research dated spend windows", () => {
  it("covers every month to now, the cutoff's month split exactly at the cutoff", () => {
    const w = spendWindows(new Date("2026-10-18T15:00:00Z"), "2026-09-27T00:00:00.000Z");
    expect(w[0]!.from).toBe("2026-01-01T00:00:00.000Z");
    const sep = w.filter((x) => x.month === "2026-09");
    expect(sep).toEqual([
      { month: "2026-09", from: "2026-09-01T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z", beforeCutoff: true },
      { month: "2026-09", from: "2026-09-27T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", beforeCutoff: false },
    ]);
    expect(w.find((x) => x.month === "2026-08")!.beforeCutoff).toBe(true);
    expect(w.find((x) => x.month === "2026-10")!.beforeCutoff).toBe(false);
    // contiguous, no gap, no overlap
    for (let i = 1; i < w.length; i++) expect(w[i]!.from).toBe(w[i - 1]!.to);
  });
  it("a leg that waits for nothing puts every window in the mature cohort", () => {
    expect(spendWindows(new Date("2026-03-05T00:00:00Z"), null).every((x) => x.beforeCutoff)).toBe(true);
  });
});
