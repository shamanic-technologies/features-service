import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stateful drizzle-chain mock for `db` ────────────────────────────────────
// Faithfully models the three call shapes view-cache.ts uses:
//   select().from().where().limit()              → [row] | []
//   insert().values(v).onConflictDoUpdate()      → persists v as the row
//   update().set(s).where().returning()          → claim (returns [{id}] | [])
//   update().set(s).where()                      → release (awaited, no returning)
let storedRow: Record<string, unknown> | undefined;
let claimSucceeds: boolean;
let readThrows: boolean;

const makeThenable = (value: unknown, extra: Record<string, unknown> = {}) => ({
  then: (resolve: (v: unknown) => void) => resolve(value),
  ...extra,
});

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          if (readThrows) throw new Error("snapshot table unreachable");
          return storedRow ? [storedRow] : [];
        },
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
      where: () =>
        makeThenable(undefined, {
          returning: async () => {
            if (claimSucceeds) {
              if (storedRow) storedRow.refreshingAt = s.refreshingAt;
              return [{ id: "snap-1" }];
            }
            return [];
          },
        }),
    }),
  }),
};

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));

const { servedCached, buildScopeKey } = await import("./view-cache.js");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  storedRow = undefined;
  claimSucceeds = true;
  readThrows = false;
  process.env.FEATURE_VIEW_CACHE_ENABLED = "true";
  process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS = "5000";
});

describe("buildScopeKey", () => {
  it("is deterministic regardless of query param order", () => {
    const a = buildScopeKey("feat", { brandId: "b", campaignId: "c", orgId: "o" });
    const b = buildScopeKey("feat", { orgId: "o", campaignId: "c", brandId: "b" });
    expect(a).toBe(b);
  });

  it("drops empty/null params and prefixes the slug", () => {
    const key = buildScopeKey("feat", { brandId: "b", campaignId: undefined, lens: "" });
    expect(key).toBe("feat|brandId=b");
  });
});

describe("servedCached", () => {
  it("MISS → computes once, persists, returns the computed body", async () => {
    const compute = vi.fn().mockResolvedValue({ pipeline: 100 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 100 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(storedRow?.body).toEqual({ pipeline: 100 });
  });

  it("FRESH hit → serves snapshot, never computes", async () => {
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 999 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 });
    expect(compute).not.toHaveBeenCalled();
  });

  it("STALE hit → serves stale immediately, refreshes in the background", async () => {
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 10_000), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 }); // stale served instantly
    await flush();
    expect(compute).toHaveBeenCalledTimes(1); // background revalidate ran
    expect(storedRow?.body).toEqual({ pipeline: 42 }); // snapshot updated
  });

  it("STALE hit but claim lost (another refresh in flight) → serves stale, does NOT recompute", async () => {
    claimSucceeds = false;
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 10_000), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 });
    await flush();
    expect(compute).not.toHaveBeenCalled();
  });

  it("read error → falls back to live compute (no throw)", async () => {
    readThrows = true;
    const compute = vi.fn().mockResolvedValue({ pipeline: 5 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 5 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("MISS compute error propagates (fail-loud, no snapshot written)", async () => {
    const compute = vi.fn().mockRejectedValue(new Error("upstream 502"));
    await expect(servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute })).rejects.toThrow("upstream 502");
    expect(storedRow).toBeUndefined();
  });

  it("cache disabled → computes directly, no snapshot persisted", async () => {
    process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
    const compute = vi.fn().mockResolvedValue({ pipeline: 1 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 1 });
    expect(storedRow).toBeUndefined();
  });
});
