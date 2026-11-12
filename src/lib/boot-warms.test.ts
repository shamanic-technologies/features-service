import { describe, it, expect, vi } from "vitest";
import { runBootWarmsSequentially, storedCopyIsFresh, type BootWarmStep } from "./boot-warms.js";

describe("storedCopyIsFresh", () => {
  it("is fresh inside the window, stale past it, never fresh without a copy", () => {
    const now = 1_000_000;
    expect(storedCopyIsFresh(now - 59_000, 60_000, now)).toBe(true);
    expect(storedCopyIsFresh(now - 60_000, 60_000, now)).toBe(false);
    expect(storedCopyIsFresh(null, 60_000, now)).toBe(false);
    expect(storedCopyIsFresh(undefined, 60_000, now)).toBe(false);
    expect(storedCopyIsFresh(Number.NaN, 60_000, now)).toBe(false);
  });
});

describe("runBootWarmsSequentially (MON-PAGE-SPEED-2-1112: never every fleet rebuild at once)", () => {
  it("runs one step at a time, in order, and a failed step never stops the next", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const step = (name: string, outcome: "built" | "skipped" | "fail"): BootWarmStep => ({
      name,
      run: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        order.push(name);
        running -= 1;
        if (outcome === "fail") throw new Error("boom");
        return outcome;
      },
    });
    const lines: string[] = [];
    await runBootWarmsSequentially([step("a", "built"), step("b", "fail"), step("c", "skipped"), step("d", "built")], (l) => lines.push(l));
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(maxRunning).toBe(1);
    expect(lines.at(-1)).toContain("2 built, 1 skipped (stored copy fresh), 1 failed");
    expect(lines.some((l) => l.includes("boot warm c: stored copy fresh, skipped"))).toBe(true);
  });
});
