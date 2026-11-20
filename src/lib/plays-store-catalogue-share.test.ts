// MON-PAGE-SPEED-FLOOR-1120: the shared play catalogue is rebuilt only when its tables' fingerprint moved (or a write
// of this process dropped it), never on every 30-s expiry nor on every verdict a sweep writes.
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fp: "a", fingerprintReads: 0, tableReads: 0 }));

vi.unmock("./plays-store.js");

vi.mock("../db/index.js", () => ({
  db: {
    execute: async () => {
      state.fingerprintReads += 1;
      return [{ fp: state.fp }];
    },
    select: () => ({
      from: async () => {
        state.tableReads += 1;
        return [];
      },
    }),
  },
  sql: {},
}));

const { loadPlayCatalogue, invalidatePlayCatalogue } = await import("./plays-store.js");

afterEach(() => {
  vi.useRealTimers();
  invalidatePlayCatalogue();
  state.fp = "a";
  state.fingerprintReads = 0;
  state.tableReads = 0;
});

describe("loadPlayCatalogue shared copy", () => {
  it("reads the six tables once, then serves the copy for 30 s without asking Postgres", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const first = await loadPlayCatalogue();
    expect(state.tableReads).toBe(6);
    vi.setSystemTime(1_000_000 + 29_000);
    expect(await loadPlayCatalogue()).toBe(first);
    expect(state.tableReads).toBe(6);
    expect(state.fingerprintReads).toBe(1);
  });

  it("after 30 s keeps the copy when the fingerprint did not move", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const first = await loadPlayCatalogue();
    vi.setSystemTime(1_000_000 + 31_000);
    expect(await loadPlayCatalogue()).toBe(first);
    expect(state.fingerprintReads).toBe(2);
    expect(state.tableReads).toBe(6);
  });

  it("rebuilds when the fingerprint moved", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const first = await loadPlayCatalogue();
    state.fp = "b";
    vi.setSystemTime(1_000_000 + 31_000);
    const second = await loadPlayCatalogue();
    expect(second).not.toBe(first);
    expect(state.tableReads).toBe(12);
  });

  it("rebuilds at once after a write of this process, whatever the fingerprint", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    await loadPlayCatalogue();
    invalidatePlayCatalogue();
    await loadPlayCatalogue();
    expect(state.tableReads).toBe(12);
  });
});
