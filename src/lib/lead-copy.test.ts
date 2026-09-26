/**
 * The live lead copy returns, row for row, what a full read of the scope returns — the snapshot
 * plus every delta applied in order — and never a copy it could not bring current.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readLeadCopy, withLiveLeadCopy, liveLeadCopyRequested, __resetLeadCopies, __leadCopySizes } from "./lead-copy.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, leadId: `L-${id}`, clicked: false, ...extra });

describe("the live lead copy", () => {
  beforeEach(() => __resetLeadCopies());

  it("snapshots once, then applies puts and removals — the result equals a full read", async () => {
    const sinces: Array<string | null> = [];
    const answers = [
      { full: true, cursor: "c1", leads: [row("a"), row("b"), row("c")], removed: [] },
      { full: false, cursor: "c2", leads: [row("b", { clicked: true }), row("d")], removed: ["a"] },
    ];
    const fetchChanges = async (since: string | null) => {
      sinces.push(since);
      return answers.shift()!;
    };
    const first = await readLeadCopy("k", fetchChanges);
    expect(first.map((r) => r.id)).toEqual(["a", "b", "c"]);

    const second = await readLeadCopy("k", fetchChanges);
    // The delta was asked from the cursor the snapshot returned.
    expect(sinces).toEqual([null, "c1"]);
    // Full read after the changes: a removed, b updated IN PLACE, d new.
    expect(second.map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(second.find((r) => r.id === "b")!.clicked).toBe(true);
    // The first caller's array is not mutated by the later sync.
    expect(first.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("REPLACES the copy when the producer answers full (feed dropped or replaced)", async () => {
    const answers = [
      { full: true, cursor: "c1", leads: [row("a"), row("b")], removed: [] },
      { full: true, reason: "feed_replaced", cursor: "x1", leads: [row("z")], removed: [] },
    ];
    await readLeadCopy("k", async () => answers.shift()!);
    const after = await readLeadCopy("k", async () => answers.shift()!);
    expect(after.map((r) => r.id)).toEqual(["z"]);
  });

  it("re-snapshots the scope when lead-service refuses the cursor as another scope's", async () => {
    await readLeadCopy("k", async () => ({ full: true, cursor: "c1", leads: [row("a"), row("b")], removed: [] }));
    const sinces: Array<string | null> = [];
    const after = await readLeadCopy("k", async (since) => {
      sinces.push(since);
      if (since) throw new Error('lead-service /orgs/leads/changes failed (400): {"error":"since belongs to a different scope than this read names"}');
      return { full: false, cursor: "n1", leads: [row("z")], removed: [] };
    });
    expect(sinces).toEqual(["c1", null]);
    // The no-cursor answer IS the whole scope, so nothing of the dead copy survives.
    expect(after.map((r) => r.id)).toEqual(["z"]);
  });

  it("fails loud and keeps the previous cursor when a sync fails", async () => {
    await readLeadCopy("k", async () => ({ full: true, cursor: "c1", leads: [row("a")], removed: [] }));
    await expect(
      readLeadCopy("k", async () => {
        throw new Error("lead-service /orgs/leads/changes failed (502)");
      }),
    ).rejects.toThrow(/502/);
    const sinces: Array<string | null> = [];
    await readLeadCopy("k", async (since) => {
      sinces.push(since);
      return { full: false, cursor: "c2", leads: [], removed: [] };
    });
    expect(sinces).toEqual(["c1"]);
  });

  it("single-flights concurrent readers of one scope", async () => {
    let calls = 0;
    const fetchChanges = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { full: true, cursor: "c", leads: [row("a")], removed: [] };
    };
    const [x, y] = await Promise.all([readLeadCopy("k", fetchChanges), readLeadCopy("k", fetchChanges)]);
    expect(calls).toBe(1);
    expect(x).toEqual(y);
  });

  it("evicts the least-recently-read copy past the row budget, never the one just read", async () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
    await readLeadCopy("old", async () => ({ full: true, cursor: "c", leads: many("o", 70_000), removed: [] }));
    await readLeadCopy("new", async () => ({ full: true, cursor: "c", leads: many("n", 70_000), removed: [] }));
    expect(Object.keys(__leadCopySizes())).toEqual(["new"]);
  });

  it("is requested only inside withLiveLeadCopy, and LEAD_COPY_ENABLED=false switches it off", async () => {
    const saved = process.env.LEAD_COPY_ENABLED;
    try {
      delete process.env.LEAD_COPY_ENABLED;
      expect(liveLeadCopyRequested()).toBe(false);
      expect(await withLiveLeadCopy(async () => liveLeadCopyRequested())).toBe(true);
      process.env.LEAD_COPY_ENABLED = "false";
      expect(await withLiveLeadCopy(async () => liveLeadCopyRequested())).toBe(false);
    } finally {
      process.env.LEAD_COPY_ENABLED = saved;
    }
  });
});
