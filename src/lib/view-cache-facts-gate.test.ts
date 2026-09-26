import { describe, it, expect, vi, beforeEach } from "vitest";

// A stale cell whose brand's FACTS did not move is served without a whole-population recompute
// (lib/view-facts.ts); one whose facts moved, whose fingerprint is unknown, or that is past the gate's
// ceiling recomputes exactly as before.

let storedRow: Record<string, unknown> | undefined;
const updates: Record<string, unknown>[] = [];

const makeThenable = (value: unknown, extra: Record<string, unknown> = {}) => ({
  then: (resolve: (v: unknown) => void) => resolve(value),
  ...extra,
});

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (storedRow ? [storedRow] : []),
        orderBy: () => ({ limit: async () => [] }),
      }),
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        storedRow = { ...v };
      },
    }),
  }),
  update: () => ({
    set: (s: Record<string, unknown>) => ({
      where: () => {
        updates.push(s);
        return makeThenable(undefined, {
          returning: async () => {
            if (storedRow) storedRow.refreshingAt = s.refreshingAt;
            return [{ id: "snap-1" }];
          },
        });
      },
    }),
  }),
  delete: () => ({ where: () => ({ returning: async () => [] }) }),
};

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));

let fingerprintNow: string | null = "fp-1";
vi.mock("./view-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./view-facts.js")>()),
  factsFingerprint: vi.fn(async () => fingerprintNow),
}));

const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
vi.mock("./view-refresher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./view-refresher.js")>()),
  currentRequestReplay: () => ({ url: `/brands/${BRAND}/revenue?pricing=net`, headers: { "x-user-id": "u", "x-run-id": "r" }, precompute: false }),
  refresherDelegation: () => null,
}));

const { servedCached, factsGateStats, __resetReadTouches } = await import("./view-cache.js");

const flush = () => new Promise((r) => setTimeout(r, 5));

function staleRow(ageMs: number, factsFingerprint: string | null) {
  storedRow = {
    view: "brand-revenue",
    scopeKey: "k",
    orgId: "o",
    body: { pipeline: 7 },
    computedAt: new Date(Date.now() - ageMs),
    refreshingAt: null,
    factsFingerprint,
  };
}

beforeEach(() => {
  storedRow = undefined;
  updates.length = 0;
  fingerprintNow = "fp-1";
  factsGateStats.skipped = 0;
  factsGateStats.recomputed = 0;
  factsGateStats.noFingerprint = 0;
  __resetReadTouches();
  delete process.env.VIEW_FACTS_GATE_ENABLED;
});

describe("the facts gate on a stale cell", () => {
  it("serves the stale body and SKIPS the recompute when the brand's facts did not move", async () => {
    staleRow(60_000, "fp-1");
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    const body = await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(body).toEqual({ pipeline: 7 });
    expect(compute).not.toHaveBeenCalled();
    expect(factsGateStats.skipped).toBe(1);
    // the claim was released so a later read can refresh
    expect(updates.some((u) => "refreshingAt" in u && u.refreshingAt === null)).toBe(true);
  });

  it("recomputes and stores the new fingerprint when the facts moved", async () => {
    staleRow(60_000, "fp-0");
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(storedRow?.body).toEqual({ pipeline: 9 });
    expect(storedRow?.factsFingerprint).toBe("fp-1");
    expect(storedRow?.replayUrl).toBe(`/brands/${BRAND}/revenue?pricing=net`);
    expect(storedRow?.brandId).toBe(BRAND);
  });

  it("recomputes when the fingerprint cannot be read", async () => {
    staleRow(60_000, "fp-1");
    fingerprintNow = null;
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(storedRow?.factsFingerprint).toBeNull();
  });

  it("recomputes past the gate's ceiling even when the facts did not move", async () => {
    staleRow(6 * 60_000, "fp-1");
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes a cell that never stored a fingerprint", async () => {
    staleRow(60_000, null);
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("is switched off by VIEW_FACTS_GATE_ENABLED=false", async () => {
    process.env.VIEW_FACTS_GATE_ENABLED = "false";
    staleRow(60_000, "fp-1");
    const compute = vi.fn(async () => ({ pipeline: 9 }));
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("records a customer read (the keeper's template) on the served cell", async () => {
    staleRow(1_000, "fp-1");
    await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute: async () => ({ pipeline: 9 }) });
    await flush();
    const touch = updates.find((u) => u.lastReadAt);
    expect(touch?.replayUrl).toBe(`/brands/${BRAND}/revenue?pricing=net`);
    expect(touch?.brandId).toBe(BRAND);
    expect(touch?.replayHeaders).toEqual({ "x-user-id": "u", "x-run-id": "r" });
  });
});
