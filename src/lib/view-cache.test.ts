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

const { servedCached, buildScopeKey, PLATFORM_SCOPE_ORG_ID } = await import("./view-cache.js");
const PLATFORM = PLATFORM_SCOPE_ORG_ID;

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

  it("concurrent MISS calls for the same cell share one live compute", async () => {
    let resolveCompute!: (value: { pipeline: number }) => void;
    const compute = vi.fn(() => new Promise<{ pipeline: number }>((resolve) => { resolveCompute = resolve; }));

    const calls = [
      servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute }),
      servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute }),
      servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute }),
    ];
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);

    resolveCompute({ pipeline: 123 });
    await expect(Promise.all(calls)).resolves.toEqual([{ pipeline: 123 }, { pipeline: 123 }, { pipeline: 123 }]);
    expect(storedRow?.body).toEqual({ pipeline: 123 });
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

  it("STALE beyond hard max age → recomputes synchronously instead of serving old data", async () => {
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 120_000), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(storedRow?.body).toEqual({ pipeline: 42 });
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

  // ── Per-view TTL / max-stale overrides (the customer-health FLEET-board freshness config) ──────────
  describe("per-view ttlMs / maxStaleMs overrides", () => {
    it("ttlMs override → a snapshot older than the 5s global TTL but younger than the override is FRESH (served, no compute)", async () => {
      // 60s old: STALE under the 5s global TTL, but FRESH under a 2-min customer-health TTL.
      storedRow = { view: "customer-health", scopeKey: "global", orgId: PLATFORM, body: { asOf: "t0", customers: [] }, computedAt: new Date(Date.now() - 60_000), refreshingAt: null };
      const compute = vi.fn().mockResolvedValue({ asOf: "t1", customers: [{ id: "x" }] });
      const body = await servedCached({ view: "customer-health", scopeKey: "global", orgId: PLATFORM, ttlMs: 120_000, maxStaleMs: 600_000, compute });
      expect(body).toEqual({ asOf: "t0", customers: [] }); // last snapshot served instantly
      await flush();
      expect(compute).not.toHaveBeenCalled(); // O(1) read, NO fleet fan-out on the request path
    });

    it("ttlMs override → past the override TTL but within maxStale → serves stale + BACKGROUND refresh", async () => {
      // 3 min old: stale under the 2-min TTL, still within the 10-min hard cap → serve stale now, refresh async.
      storedRow = { view: "customer-health", scopeKey: "global", orgId: PLATFORM, body: { asOf: "t0", customers: [] }, computedAt: new Date(Date.now() - 180_000), refreshingAt: null };
      const compute = vi.fn().mockResolvedValue({ asOf: "t1", customers: [{ id: "x" }] });
      const body = await servedCached({ view: "customer-health", scopeKey: "global", orgId: PLATFORM, ttlMs: 120_000, maxStaleMs: 600_000, compute });
      expect(body).toEqual({ asOf: "t0", customers: [] }); // stale served instantly
      await flush();
      expect(compute).toHaveBeenCalledTimes(1); // single-flight background revalidate ran
      expect(storedRow?.body).toEqual({ asOf: "t1", customers: [{ id: "x" }] }); // snapshot refreshed
    });

    it("maxStaleMs override → only beyond the override does a read recompute synchronously", async () => {
      // 11 min old: past the 10-min hard cap → block once, recompute, persist, serve fresh.
      storedRow = { view: "customer-health", scopeKey: "global", orgId: PLATFORM, body: { asOf: "t0", customers: [] }, computedAt: new Date(Date.now() - 660_000), refreshingAt: null };
      const compute = vi.fn().mockResolvedValue({ asOf: "t1", customers: [{ id: "x" }] });
      const body = await servedCached({ view: "customer-health", scopeKey: "global", orgId: PLATFORM, ttlMs: 120_000, maxStaleMs: 600_000, compute });
      expect(body).toEqual({ asOf: "t1", customers: [{ id: "x" }] });
      expect(compute).toHaveBeenCalledTimes(1);
      expect(storedRow?.body).toEqual({ asOf: "t1", customers: [{ id: "x" }] });
    });

    it("MISS on a global view → computes once, persists under the platform sentinel org", async () => {
      const compute = vi.fn().mockResolvedValue({ asOf: "t1", customers: [] });
      const body = await servedCached({ view: "customer-health", scopeKey: "global", orgId: PLATFORM, ttlMs: 120_000, maxStaleMs: 600_000, compute });
      expect(body).toEqual({ asOf: "t1", customers: [] });
      expect(compute).toHaveBeenCalledTimes(1);
      expect(storedRow?.orgId).toBe(PLATFORM);
    });
  });
});
