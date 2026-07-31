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
let pruneThrows: boolean;
const pruneCalls: Date[] = [];

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
  delete: () => ({
    where: (condition: unknown) => ({
      returning: async () => {
        if (pruneThrows) throw new Error("prune failed");
        // The cutoff is the only Date bound into `lt(computedAt, cutoff)`; digging it out of the drizzle
        // condition is what lets the test assert WHICH rows the sweep targets, not merely that it ran.
        const cutoff = findDate(condition);
        if (!cutoff) throw new Error("prune ran without a date cutoff");
        pruneCalls.push(cutoff);
        // Model the table: only rows older than the cutoff go.
        if (storedRow && new Date(storedRow.computedAt as string | Date).getTime() < cutoff.getTime()) {
          storedRow = undefined;
          return [{ id: "snap-1" }];
        }
        return [];
      },
    }),
  }),
};

/** Depth-first hunt for the single Date bound into a drizzle condition (the prune cutoff). */
function findDate(node: unknown, depth = 0): Date | undefined {
  if (node instanceof Date) return node;
  if (depth > 6 || node === null || typeof node !== "object") return undefined;
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = findDate(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));

const { servedCached, buildScopeKey, PLATFORM_SCOPE_ORG_ID, viewCacheRetentionMs, __resetViewCachePruneState } =
  await import("./view-cache.js");
const PLATFORM = PLATFORM_SCOPE_ORG_ID;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  storedRow = undefined;
  claimSucceeds = true;
  readThrows = false;
  pruneThrows = false;
  pruneCalls.length = 0;
  __resetViewCachePruneState();
  delete process.env.FEATURE_VIEW_SNAPSHOT_RETENTION_MS;
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
    // The age is pinned against an EXPLICIT maxStaleMs rather than the global default, so this test
    // asserts the blocking branch itself and cannot silently flip to the stale-serve branch the next time
    // the default cap moves (it did: 60s → 30min, which is exactly what made a 120s-old fixture stop
    // exercising this path).
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 120_000), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", maxStaleMs: 60_000, compute });
    expect(body).toEqual({ pipeline: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(storedRow?.body).toEqual({ pipeline: 42 });
  });

  it("the DEFAULT hard cap is minutes-scale, so a revisit after a few minutes is served, never blocked", async () => {
    // Guards the fix for the dashboard's cold-load: the dashboard pauses polling on an idle tab, so any
    // revisit used to land past the old 60s cap and block on a full cross-service recompute (~5.8s).
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 5 * 60_000), refreshingAt: null };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 }); // served from the snapshot, caller never waits
    await flush();
    expect(compute).toHaveBeenCalledTimes(1); // and refreshed in the BACKGROUND
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

  // ── Retention sweep — the Gold table must not grow forever as scope keys churn ─────────────────────
  describe("stale-snapshot pruning", () => {
    it("a persist sweeps snapshots older than the retention window, and targets ONLY those", async () => {
      const before = Date.now();
      await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute: async () => ({ pipeline: 1 }) });
      await flush();

      expect(pruneCalls).toHaveLength(1);
      const cutoff = pruneCalls[0].getTime();
      // Cutoff sits one retention window in the past — so a cell read yesterday survives and a cell
      // nobody has opened in over a week goes.
      expect(cutoff).toBeLessThanOrEqual(Date.now() - viewCacheRetentionMs());
      expect(cutoff).toBeGreaterThanOrEqual(before - viewCacheRetentionMs() - 5_000);
    });

    it("actually removes a cell nobody has read since the window, and keeps the one just written", async () => {
      process.env.FEATURE_VIEW_SNAPSHOT_RETENTION_MS = "1000";
      // An orphan from a scope key that no longer exists (a superseded economics fingerprint, a retired view).
      storedRow = { view: "workflow-projection", scopeKey: "old", orgId: "o", body: { stale: true }, computedAt: new Date(Date.now() - 60_000), refreshingAt: null };

      // Drive the sweep off a persist that does NOT overwrite that row.
      await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute: async () => ({ pipeline: 1 }) });
      await flush();

      expect(pruneCalls).toHaveLength(1);
      // The freshly written row (computedAt = now) survives its own sweep.
      expect(storedRow?.body).toEqual({ pipeline: 1 });
    });

    it("sweeps at most once per interval — a second persist right after does NOT re-sweep", async () => {
      await servedCached({ view: "revenue", scopeKey: "a", orgId: "o", compute: async () => ({ pipeline: 1 }) });
      await flush();
      storedRow = undefined;
      await servedCached({ view: "revenue", scopeKey: "b", orgId: "o", compute: async () => ({ pipeline: 2 }) });
      await flush();

      expect(pruneCalls).toHaveLength(1);
    });

    it("a prune failure never reaches the caller — the body is served, the housekeeping is logged", async () => {
      pruneThrows = true;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute: async () => ({ pipeline: 9 }) });
      await flush();

      expect(body).toEqual({ pipeline: 9 });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("view-cache prune failed"));
      errors.mockRestore();
    });

    it("cache disabled → nothing is persisted and nothing is swept", async () => {
      process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
      await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute: async () => ({ pipeline: 1 }) });
      await flush();
      expect(pruneCalls).toHaveLength(0);
    });

    it("the retention window is days-scale, far beyond the hard staleness cap it must never fight", async () => {
      // A cell inside the max-stale cap is still SERVED; retention only reclaims cells long past any read.
      expect(viewCacheRetentionMs()).toBeGreaterThan(24 * 60 * 60_000);
    });
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
