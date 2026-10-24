import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { researchFreshness } from "./research.js";
import { fetchOutcomeLedgerTotals } from "../lib/outcome-cost-totals-client.js";

// RESEARCH-STALE-1024: the first read after a quiet night served an 8-hour-old build with nothing saying so.
describe("researchFreshness", () => {
  const at = "2026-10-23T20:30:40.000Z";
  const t = Date.parse(at);
  it("a build within twice its cadence is fresh", () => {
    expect(researchFreshness(at, 15 * 60_000, t + 30 * 60_000, false)).toEqual({ computedAt: at, refreshEveryMinutes: 15, staleAfterMinutes: 30, ageMinutes: 30, stale: false, rebuilding: false });
  });
  it("a build older than twice its cadence is stale, with its age", () => {
    const f = researchFreshness(at, 15 * 60_000, t + 8 * 60 * 60_000 + 27 * 60_000, true);
    expect(f).toMatchObject({ stale: true, ageMinutes: 507, rebuilding: true });
  });
  it("the vendor-cost twin is stale only past 12 hours", () => {
    expect(researchFreshness(at, 6 * 60 * 60_000, t + 11 * 60 * 60_000, false).stale).toBe(false);
    expect(researchFreshness(at, 6 * 60 * 60_000, t + 13 * 60 * 60_000, false).stale).toBe(true);
  });
});

describe("the outcome ledger read asks since runs-service's own inception", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never sends a `since` (a day before the ledger exists reads missing forever)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ daysMissing: [], produced: [], consumed: [], scope: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.RUNS_SERVICE_URL = "http://runs";
    const t = await fetchOutcomeLedgerTotals("gross");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://runs/internal/stats/outcome-costs?groupBy=outcomeKey,campaignId,orgId");
    expect(t.daysMissing).toBe(0);
  });
});
