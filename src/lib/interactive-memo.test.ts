import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { memoizeInteractive, __resetInteractiveMemo } from "./interactive-memo.js";
import { withLiveLeadCopy } from "./lead-copy.js";

describe("interactive memo", () => {
  beforeEach(() => {
    __resetInteractiveMemo();
    process.env.DOWNSTREAM_READ_SHARE_MS = "3000";
  });
  afterEach(() => {
    process.env.DOWNSTREAM_READ_SHARE_MS = "0";
  });

  it("reuses a value inside a view compute, and re-reads it behind the answer once it ages", async () => {
    let n = 0;
    const read = () => withLiveLeadCopy(() => memoizeInteractive("k", 20, async () => ++n));
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await read()).toBe(1); // aged: previous value served, re-read started
    await new Promise((r) => setTimeout(r, 1));
    expect(await read()).toBe(2);
  });

  it("is a plain call outside a view compute, and never caches a failure", async () => {
    let n = 0;
    expect(await memoizeInteractive("k", 1000, async () => ++n)).toBe(1);
    expect(await memoizeInteractive("k", 1000, async () => ++n)).toBe(2);
    await expect(withLiveLeadCopy(() => memoizeInteractive("f", 1000, async () => { throw new Error("boom"); }))).rejects.toThrow("boom");
    expect(await withLiveLeadCopy(() => memoizeInteractive("f", 1000, async () => 7))).toBe(7);
  });
});
