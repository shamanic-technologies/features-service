import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stateful drizzle-funnel mock for `db` ────────────────────────────────────
// Faithfully models the three call shapes view-cache.ts uses:
//   select().from().where().limit()              → [row] | []
//   insert().values(v).onConflictDoUpdate()      → persists v as the row
//   update().set(s).where().returning()          → claim (returns [{id}] | [])
//   update().set(s).where()                      → release (awaited, no returning)
let storedRow: Record<string, unknown> | undefined;
/** The newest row of the requested cell's FAMILY (another fingerprint of the same key), for the rotation read. */
let familyRow: Record<string, unknown> | undefined;
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
        orderBy: () => ({
          limit: async () => (familyRow ? [familyRow] : []),
        }),
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

const {
  servedCached,
  buildScopeKey,
  PLATFORM_SCOPE_ORG_ID,
  viewCacheRetentionMs,
  __resetViewCachePruneState,
  familyKeyOf,
  encodeSnapshotBody,
  decodeSnapshotBody,
} = await import("./view-cache.js");
const PLATFORM = PLATFORM_SCOPE_ORG_ID;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  storedRow = undefined;
  familyRow = undefined;
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

  it("the DEFAULT serves ANY retained snapshot — a day-old cell is served instantly and refreshed behind the response", async () => {
    // Guards the fix for the dashboard's 40-70s first paint (2026-09-24): a dashboard is visited about once
    // a day, so under the old 30-minute cap 94% of stored cells were past it and the FIRST page of every
    // session recomputed every view on the request path (24-44s each, measured in prod). The caller must
    // get the snapshot; the refresh belongs in the background.
    storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 24 * 60 * 60_000), refreshingAt: null };
    let resolveCompute!: (value: { pipeline: number }) => void;
    const compute = vi.fn(() => new Promise<{ pipeline: number }>((resolve) => { resolveCompute = resolve; }));
    const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 }); // served while the recompute is still PENDING — the caller never waited on it
    await flush();
    expect(compute).toHaveBeenCalledTimes(1); // and refreshed in the BACKGROUND
    resolveCompute({ pipeline: 42 });
    await flush();
    expect(storedRow?.body).toEqual({ pipeline: 42 });
  });

  it("a cell older than the RETENTION window is recomputed synchronously (it is about to be pruned, i.e. a miss)", async () => {
    process.env.FEATURE_VIEW_SNAPSHOT_RETENTION_MS = String(60 * 60_000);
    try {
      storedRow = { view: "revenue", scopeKey: "k", orgId: "o", body: { pipeline: 7 }, computedAt: new Date(Date.now() - 2 * 60 * 60_000), refreshingAt: null };
      const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
      const body = await servedCached({ view: "revenue", scopeKey: "k", orgId: "o", compute });
      expect(body).toEqual({ pipeline: 42 });
      expect(compute).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.FEATURE_VIEW_SNAPSHOT_RETENTION_MS;
    }
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

// ── A body jsonb refuses must still be cached, byte for byte ─────────────────────────────────────────
// Prod 2026-09-26: `brand-revenue` had ZERO stored cells because a lead's text carried a NUL, jsonb
// rejected the persist ("unsupported Unicode escape sequence"), and every read recomputed cold (3-13s).
describe("a body carrying text jsonb refuses", () => {
  const nulBody = { leads: [{ name: "Ada\u0000Lovelace", value: 12.5 }], total: 3 };
  const surrogateBody = { orgs: [{ name: "broken \ud83d emoji" }], n: null };

  it("round-trips byte for byte through the stored shape", () => {
    for (const body of [nulBody, surrogateBody]) {
      const stored = encodeSnapshotBody(body);
      expect(stored).not.toEqual(body); // wrapped: the raw body is what jsonb refused
      expect(JSON.stringify(stored)).not.toMatch(/(^|[^\\])\\u0000/); // no raw NUL escape reaches jsonb
      expect(JSON.stringify(decodeSnapshotBody(stored))).toBe(JSON.stringify(body));
    }
  });

  it("leaves every ordinary body exactly as it was", () => {
    const body = { pipeline: 100, name: "Zoë — ok", nested: [{ a: 1 }] };
    expect(encodeSnapshotBody(body)).toBe(body);
    expect(decodeSnapshotBody(body)).toBe(body);
  });

  it("is persisted, and the next read serves the SAME body without recomputing", async () => {
    const compute = vi.fn().mockResolvedValue(nulBody);
    const first = await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    expect(storedRow).toBeDefined();
    const second = await servedCached({ view: "brand-revenue", scopeKey: "k", orgId: "o", compute });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(second)).toBe(JSON.stringify(nulBody));
  });
});

// ── A fingerprint rotation serves the previous cell instead of blocking ──────────────────────────────
describe("familyKeyOf", () => {
  it("drops ONLY the fingerprint parts", () => {
    const key = buildScopeKey("b1", { orgId: "o", econ: "abc", decl: "x+y", pricing: "net", cause: "priced:outreach" });
    expect(familyKeyOf(key)).toBe(buildScopeKey("b1", { orgId: "o", pricing: "net", cause: "priced:outreach" }));
  });

  it("is the key itself when there is no fingerprint to drop", () => {
    const key = buildScopeKey("b1", { orgId: "o", pricing: "net" });
    expect(familyKeyOf(key)).toBe(key);
  });
});

describe("servedCached on a fingerprint rotation", () => {
  const newKey = buildScopeKey("b1", { orgId: "o", econ: "new", pricing: "net" });

  it("serves the family's previous cell NOW and computes the new cell behind the response", async () => {
    familyRow = { body: { pipeline: 7 } };
    let resolveCompute!: (value: { pipeline: number }) => void;
    const compute = vi.fn(() => new Promise<{ pipeline: number }>((resolve) => { resolveCompute = resolve; }));
    const body = await servedCached({ view: "brand-revenue", scopeKey: newKey, orgId: "o", compute });
    expect(body).toEqual({ pipeline: 7 }); // answered while the new compute is still pending
    expect(compute).toHaveBeenCalledTimes(1);
    resolveCompute({ pipeline: 42 });
    await flush();
    await flush();
    expect(storedRow?.body).toEqual({ pipeline: 42 });
    expect(storedRow?.scopeKey).toBe(newKey);
    expect(storedRow?.familyKey).toBe(familyKeyOf(newKey));
  });

  it("decodes an encoded previous cell", async () => {
    familyRow = { body: encodeSnapshotBody({ name: "a\u0000b" }) };
    const body = await servedCached({ view: "brand-revenue", scopeKey: newKey, orgId: "o", compute: vi.fn().mockResolvedValue({}) });
    expect(JSON.stringify(body)).toBe(JSON.stringify({ name: "a\u0000b" }));
  });

  it("with no previous cell, computes on the request path exactly as a miss always did", async () => {
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "brand-revenue", scopeKey: newKey, orgId: "o", compute });
    expect(body).toEqual({ pipeline: 42 });
  });

  it("never looks for a family when the key carries no fingerprint", async () => {
    familyRow = { body: { pipeline: 7 } };
    const compute = vi.fn().mockResolvedValue({ pipeline: 42 });
    const body = await servedCached({ view: "revenue", scopeKey: "plain|a=1", orgId: "o", compute });
    expect(body).toEqual({ pipeline: 42 });
  });
});
