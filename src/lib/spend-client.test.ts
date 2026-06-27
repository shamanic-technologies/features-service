import { describe, it, expect, vi, afterEach } from "vitest";

process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";

const { fetchSpendBreakdown } = await import("./spend-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1", featureSlug: "sales-cold-email-outreach" };

function group(costName: string | null, actual: number, total = actual): Record<string, unknown> {
  return { dimensions: costName === null ? {} : { costName }, totalCostInUsdCents: String(total), actualCostInUsdCents: String(actual), runCount: 0, minStartedAt: null, maxStartedAt: null };
}

describe("fetchSpendBreakdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives committed/actual/provisioned, sums sources, computes committed share-of-total (desc), drops zero rows, queries today via startedAfter", async () => {
    const seenUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenUrls.push(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("startedAfter")) {
        // today: committed 1500 = 1000 billed + 500 hold.
        return json({ groups: [group("apollo people-search", 1000, 1500)] });
      }
      // email: committed 8000 (6000 billed + 2000 hold); apollo: committed 2000 (all billed); zero dropped.
      return json({ groups: [group("email-send-step-1", 6000, 8000), group("apollo people-search", 2000), group("zero", 0)] });
    });

    const res = await fetchSpendBreakdown("brand-1", undefined, "sales-cold-email-outreach", HEADERS);

    // total = COMMITTED (= actual + provisioned); actual = billed; provisioned = total − actual.
    expect(res.totalSpentCents).toBe(10000); // 8000 + 2000
    expect(res.actualSpentCents).toBe(8000); // 6000 + 2000
    expect(res.provisionedSpentCents).toBe(2000); // 10000 − 8000
    expect(res.totalSpentTodayCents).toBe(1500);
    expect(res.actualSpentTodayCents).toBe(1000);
    expect(res.provisionedSpentTodayCents).toBe(500);
    // sources: descending by committed spend, zero dropped, share is of the COMMITTED total (10000).
    expect(res.sources).toEqual([
      { source: "email-send-step-1", totalSpentCents: 8000, actualSpentCents: 6000, provisionedSpentCents: 2000, sharePct: 80 },
      { source: "apollo people-search", totalSpentCents: 2000, actualSpentCents: 2000, provisionedSpentCents: 0, sharePct: 20 },
    ]);
    // invariant: each top-level total == Σ over sources.
    expect(res.sources.reduce((n, s) => n + s.totalSpentCents, 0)).toBe(res.totalSpentCents);
    expect(res.sources.reduce((n, s) => n + s.actualSpentCents, 0)).toBe(res.actualSpentCents);
    expect(res.sources.reduce((n, s) => n + s.provisionedSpentCents, 0)).toBe(res.provisionedSpentCents);
    // Two runs calls: groupBy=costName (sources) + a startedAfter-filtered call (today).
    expect(seenUrls.filter((u) => u.includes("groupBy=costName")).length).toBe(2);
    expect(seenUrls.some((u) => u.includes("startedAfter"))).toBe(true);
  });

  it("fails loud (throws) on a non-OK runs response — never fakes $0 spend", async () => {
    // Fresh Response per call (the two breakdown fetches run in parallel; a shared body errors).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(fetchSpendBreakdown("brand-1", undefined, "f", HEADERS)).rejects.toThrow(/runs-service/);
  });

  it("zero spend → empty sources, all-zero totals (no false rows)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const res = await fetchSpendBreakdown("brand-1", "camp-1", "f", HEADERS);
    expect(res).toEqual({
      totalSpentCents: 0,
      actualSpentCents: 0,
      provisionedSpentCents: 0,
      totalSpentTodayCents: 0,
      actualSpentTodayCents: 0,
      provisionedSpentTodayCents: 0,
      sources: [],
    });
  });
});
