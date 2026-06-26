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

  it("reads ACTUAL spend, sums sources, computes share-of-total (desc), drops zero rows, and queries today via startedAfter", async () => {
    const seenUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenUrls.push(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("startedAfter")) {
        return json({ groups: [group("apollo people-search", 1500)] });
      }
      // total: actual 6000 ignoring a 2000-provisioned (we only read actual) + a 0 row that's dropped.
      return json({ groups: [group("email-send-step-1", 6000, 8000), group("apollo people-search", 2000), group("zero", 0)] });
    });

    const res = await fetchSpendBreakdown("brand-1", undefined, "sales-cold-email-outreach", HEADERS);

    // Total = Σ ACTUAL (8000 not used — that's the provisioned-inflated total field).
    expect(res.totalSpentCents).toBe(8000); // 6000 + 2000
    expect(res.todaySpentCents).toBe(1500);
    expect(res.sources).toEqual([
      { source: "email-send-step-1", spentCents: 6000, sharePct: 75 },
      { source: "apollo people-search", spentCents: 2000, sharePct: 25 },
    ]);
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
    expect(res).toEqual({ totalSpentCents: 0, todaySpentCents: 0, sources: [] });
  });
});
