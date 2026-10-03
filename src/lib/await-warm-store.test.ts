import { describe, expect, it } from "vitest";
import { awaitWarmStore, StoreNotComputedError } from "./await-warm-store.js";

describe("awaitWarmStore — a read in the boot warm window never serves 'nothing measured'", () => {
  it("serves a built value at once, without waiting on any build", async () => {
    let warmCalls = 0;
    const value = await awaitWarmStore(() => 1.41, async () => { warmCalls += 1; }, 10, "fleet leg costs");
    expect(value).toBe(1.41);
    expect(warmCalls).toBe(0);
  });

  it("an EMPTY store awaits the in-flight build and serves what it built", async () => {
    let store: number | null = null;
    const warm = () => new Promise<void>((resolve) => setTimeout(() => { store = 1.41; resolve(); }, 20));
    await expect(awaitWarmStore(() => store, warm, 5_000, "fleet leg costs")).resolves.toBe(1.41);
  });

  it("a build slower than the bound fails VISIBLY, never resolves empty", async () => {
    const never = () => new Promise<void>(() => {});
    await expect(awaitWarmStore(() => null, never, 15, "fleet leg costs")).rejects.toBeInstanceOf(StoreNotComputedError);
  });

  it("a FAILED build fails visibly too", async () => {
    const failing = () => Promise.reject(new Error("runs-service down"));
    await expect(awaitWarmStore(() => null, failing, 1_000, "fleet leg costs")).rejects.toThrow(/not computed yet/);
  });
});
