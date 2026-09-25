/**
 * THE SPEND LEG NARROWS BY THE SAME CAMPAIGNS EVERY OTHER MONEY FIGURE NARROWS BY.
 *
 * runs' cost TIMESERIES takes ONE `campaignId` and offers no `groupBy`, so the untimed read's trick
 * of co-grouping and summing locally is unavailable — and until 2026-09-17 a multi-member campaign
 * IDENTITY silently fell back to the BRAND's curve. Every case below asserts the DIVERGENCE between
 * the family's own spend and the brand's: a suite that only checked "a map came back" would pass on
 * the implementation this replaces, which returned a real map about the wrong scope.
 *
 * The fixture is the reported campaign's shape (prod, brand `f4d73dab…` / org `f0420eb5…`): a
 * three-member identity worth $369.32 sitting inside a brand worth $1,342.38 on the same channel.
 *
 * (features-service#983.)
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";

const { fetchBrandCommittedSpendByDay, SPEND_BY_DAY_MEMBER_CONCURRENCY, RUNS_CAMPAIGN_IDS_PER_REQUEST } = await import(
  "./brand-spend-by-day-client.js"
);

const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const HEADERS = { orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" };
const CHANNEL = "sales-cold-email-outreach";

/** The identity's three stored rows, and the fourth campaign on the brand that is NOT one of them. */
const MEMBERS = ["c-live", "c-stopped-1", "c-stopped-2"];
const OUTSIDER = "c-other-funnel";

/** Per campaign, per UTC day, in CENTS — exactly what runs' buckets carry. */
const SPEND: Record<string, Array<[string, number]>> = {
  "c-live": [["2026-09-11", 10_000], ["2026-09-12", 6_932]],
  "c-stopped-1": [["2026-09-11", 10_000]],
  "c-stopped-2": [["2026-09-13", 10_000]],
  [OUTSIDER]: [["2026-09-12", 97_306]],
};
/** $369.32 — what the identity spent, and what every other money figure on its body already states. */
const FAMILY_USD = 369.32;
/** $1,342.38 — what the BRAND spent, i.e. the number the curve used to terminate on. */
const BRAND_USD = 1342.38;

interface Options {
  /** Members whose read should fail, to drive the fail-loud case. */
  failing?: string[];
  /** Members that recorded no spend at all. */
  silent?: string[];
}

interface Call {
  campaignId: string | null;
  /** The family list, when the read named one (`campaignIds`). */
  campaignIds: string[] | null;
  params: URLSearchParams;
}

function mockRuns(options: Options = {}): { calls: Call[]; inFlightPeak: () => number } {
  const calls: Call[] = [];
  let inFlight = 0;
  let peak = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const params = new URL(url).searchParams;
    const campaignId = params.get("campaignId");
    const campaignIds = params.get("campaignIds")?.split(",") ?? null;
    calls.push({ campaignId, campaignIds, params });

    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;

    const named = campaignIds ?? (campaignId ? [campaignId] : null);
    // The producer fails the WHOLE read when any row of a family fails (runs-service#239).
    if (named && named.some((id) => options.failing?.includes(id))) {
      return new Response("boom", { status: 503 });
    }

    // A brand-wide read (no campaign filter) is every campaign on the brand — the curve the bug served.
    const rows = named
      ? named.flatMap((id) => (options.silent?.includes(id) ? [] : (SPEND[id] ?? [])))
      : Object.values(SPEND).flat();

    const byDay = new Map<string, number>();
    for (const [day, cents] of rows) byDay.set(day, (byDay.get(day) ?? 0) + cents);

    return new Response(
      JSON.stringify({
        buckets: [...byDay].map(([period, cents]) => ({
          period,
          totalCostInUsdCents: String(cents),
          netTotalCostInUsdCents: String(cents / 2),
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  return { calls, inFlightPeak: () => peak };
}

const total = (byDay: Map<string, number>): number =>
  [...byDay.values()].reduce((sum, usd) => sum + usd, 0);

describe("a campaign-scoped dated-spend read answers for the CAMPAIGN, not its brand", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sums the identity's members and DIVERGES from the brand's curve", async () => {
    const { calls } = mockRuns();

    const family = await fetchBrandCommittedSpendByDay(BRAND, MEMBERS, CHANNEL, HEADERS);
    const brand = await fetchBrandCommittedSpendByDay(BRAND, undefined, CHANNEL, HEADERS);

    expect(total(family)).toBeCloseTo(FAMILY_USD, 6);
    expect(total(brand)).toBeCloseTo(BRAND_USD, 6);
    // THE DIVERGENCE the bug erased: the brand's curve is 3.6x the campaign's, and it was the one
    // being served under the campaign's name.
    expect(total(brand)).toBeGreaterThan(total(family) * 3);

    // Merged day by day, not just in total — the curve is dated, so a wrong day is a wrong chart.
    expect(family.get("2026-09-11")).toBeCloseTo(200, 6);
    expect(family.get("2026-09-12")).toBeCloseTo(69.32, 6);
    expect(family.get("2026-09-13")).toBeCloseTo(100, 6);
    // The outsider's $973.06 lands on a day the family also spent on, so a day-level check is the
    // only one that catches a fall-back that happens to total correctly.
    expect(brand.get("2026-09-12")).toBeCloseTo(69.32 + 973.06, 6);

    // ONE request for the whole family (runs-service `campaignIds`, features-service#1045), naming
    // exactly its members — NEVER an unfiltered brand-wide one, never the outsider.
    const familyCall = calls[0]!;
    expect(familyCall.campaignId).toBeNull();
    expect(familyCall.campaignIds).toEqual(MEMBERS);
    expect(familyCall.campaignIds).not.toContain(OUTSIDER);
    expect(calls).toHaveLength(2);
  });

  it("issues the ORIGINAL single request for a one-member scope and for the whole brand", async () => {
    const { calls } = mockRuns();

    const single = await fetchBrandCommittedSpendByDay(BRAND, ["c-live"], CHANNEL, HEADERS);
    const bare = await fetchBrandCommittedSpendByDay(BRAND, "c-live", CHANNEL, HEADERS);
    const brand = await fetchBrandCommittedSpendByDay(BRAND, undefined, CHANNEL, HEADERS);

    expect(calls).toHaveLength(3);
    expect(calls[0]!.campaignId).toBe("c-live");
    expect(calls[1]!.campaignId).toBe("c-live");
    // A brand-wide read still sends NO campaign filter — byte-unchanged.
    expect(calls[2]!.campaignId).toBeNull();
    expect(total(single)).toBeCloseTo(169.32, 6);
    expect(total(bare)).toBeCloseTo(169.32, 6);
    expect(total(brand)).toBeCloseTo(BRAND_USD, 6);
  });

  it("carries the pricing basis and the workflow dynasty onto the family request", async () => {
    const { calls } = mockRuns();

    const net = await fetchBrandCommittedSpendByDay(BRAND, MEMBERS, CHANNEL, HEADERS, "net", "azalea");

    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call.params.get("workflowDynastySlug")).toBe("azalea");
      expect(call.params.get("brandId")).toBe(BRAND);
      expect(call.params.get("orgId")).toBe(HEADERS.orgId);
      expect(call.params.get("featureSlugs")).toBe(CHANNEL);
      expect(call.params.get("interval")).toBe("day");
    }
    // NET reads the frozen net twin on every member — a member left on gross would over-state the
    // discounted half of one campaign's curve while the rest of the body reads net.
    expect(total(net)).toBeCloseTo(FAMILY_USD / 2, 6);
  });

  it("answers an EMPTY map for a family that recorded nothing — never the brand's curve", async () => {
    mockRuns({ silent: MEMBERS });
    const family = await fetchBrandCommittedSpendByDay(BRAND, MEMBERS, CHANNEL, HEADERS);
    // A measured "this scope has spent nothing". Falling back would print $1,342.38 here.
    expect(family.size).toBe(0);
  });

  it("FAILS LOUD when one member is unreadable — a partial sum under-states the spend leg", async () => {
    mockRuns({ failing: ["c-stopped-2"] });
    await expect(fetchBrandCommittedSpendByDay(BRAND, MEMBERS, CHANNEL, HEADERS)).rejects.toThrow(
      /costs\/timeseries failed \(503\)/,
    );
  });

  it("asks a 51-member family in ONE request, and chunks only above runs-service's 500-id cap", async () => {
    const { calls, inFlightPeak } = mockRuns();
    const many = Array.from({ length: 51 }, (_, i) => `c-${i}`);
    await fetchBrandCommittedSpendByDay(BRAND, many, CHANNEL, HEADERS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.campaignIds).toHaveLength(51);

    calls.length = 0;
    const huge = Array.from({ length: RUNS_CAMPAIGN_IDS_PER_REQUEST * 2 + 1 }, (_, i) => `h-${i}`);
    await fetchBrandCommittedSpendByDay(BRAND, huge, CHANNEL, HEADERS);
    expect(calls).toHaveLength(3);
    expect(calls.flatMap((c) => c.campaignIds ?? [])).toEqual(huge);
    expect(inFlightPeak()).toBeLessThanOrEqual(SPEND_BY_DAY_MEMBER_CONCURRENCY);
  });
});
