import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";

const { fetchOfferServeCosts, __resetOfferServeHold, __offerServeWalkStats } = await import("./offer-sourcing.js");

/**
 * BOX-DB-LOAD-1027-FEATURES-SERVES: the offer sourcing serve walk is held per campaign and only the serves
 * started within the settle window are re-read. A fake runs-service `/v1/runs` (newest first, OFFSET pages,
 * inclusive `startedAfter`) holds the owner campaign's ~9.9k serves; new serves land between reads.
 */

const BRAND = "brand-1";
const IDENTITY = { orgId: "org-1", userId: "u1", runId: "r1" };
const T0 = Date.parse("2026-10-27T20:00:00.000Z");

interface FakeServe {
  id: string;
  campaignId: string;
  audienceId: string | null;
  startedAt: string;
  totalCostInUsdCents: string;
  netTotalCostInUsdCents: string;
}

let serves: FakeServe[] = [];
let pageCalls = 0;
let seq = 0;

function addServe(campaignId: string, startedAtMs: number): FakeServe {
  seq += 1;
  const s: FakeServe = {
    id: `run-${String(seq).padStart(6, "0")}`,
    campaignId,
    audienceId: seq % 3 === 0 ? null : `aud-${seq % 4}`,
    startedAt: new Date(startedAtMs).toISOString(),
    totalCostInUsdCents: `${(seq % 17) + 0.1234567891}`.padEnd(12, "0"),
    netTotalCostInUsdCents: `${(seq % 13) + 0.5}`,
  };
  serves.push(s);
  return s;
}

function fakeRuns(input: string | URL): Response {
  const url = new URL(String(input));
  expect(url.pathname).toBe("/v1/runs");
  expect(url.searchParams.get("taskName")).toBe("lead-serve");
  pageCalls += 1;
  const campaignId = url.searchParams.get("campaignId");
  const after = url.searchParams.get("startedAfter");
  const limit = Number(url.searchParams.get("limit"));
  const offset = Number(url.searchParams.get("offset"));
  const rows = serves
    .filter((s) => s.campaignId === campaignId && (!after || Date.parse(s.startedAt) >= Date.parse(after)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    .slice(offset, offset + limit)
    .map((s) => ({ ...s, featureSlug: "lead-sourcing", serviceName: "lead-service", taskName: "lead-serve" }));
  return new Response(JSON.stringify({ runs: rows, limit, offset }), { status: 200 });
}

async function read(holdOn: boolean, campaignIds: string[], pricing: "gross" | "net") {
  process.env.OFFER_SERVE_HOLD_ENABLED = holdOn ? "true" : "false";
  return fetchOfferServeCosts(BRAND, campaignIds, IDENTITY, pricing);
}

describe("offer sourcing serve walk hold (BOX-DB-LOAD-1027-FEATURES-SERVES)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    serves = [];
    pageCalls = 0;
    seq = 0;
    __resetOfferServeHold();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => fakeRuns(input)));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.OFFER_SERVE_HOLD_ENABLED = "false";
    __resetOfferServeHold();
  });

  it("serves the SAME figures as a whole walk, and reads >= 10x fewer /v1/runs pages an hour", async () => {
    // Owner campaign a2b35c84: ~9.9k serves over 40 days; a smaller sibling.
    for (let i = 0; i < 9_900; i += 1) addServe("camp-owner", T0 - 40 * 86_400_000 + i * 349_000);
    for (let i = 0; i < 700; i += 1) addServe("camp-small", T0 - 10 * 86_400_000 + i * 1_234_000);
    const campaigns = ["camp-owner", "camp-small"];

    // One full-walk cycle (6 h) of refreshes, one every 5 min (the facts gate's ceiling), 15 new serves in
    // between, each read on both pricings (the sales-paths sidebar reads net, the route gross).
    let pagesWithout = 0;
    let pagesWith = 0;
    for (let tick = 0; tick < 72; tick += 1) {
      vi.setSystemTime(T0 + tick * 5 * 60_000);
      for (let k = 0; k < 15; k += 1) addServe(k % 5 === 0 ? "camp-small" : "camp-owner", Date.now() - k * 1_000);
      for (const pricing of ["gross", "net"] as const) {
        pageCalls = 0;
        const whole = await read(false, campaigns, pricing);
        pagesWithout += pageCalls;
        pageCalls = 0;
        const held = await read(true, campaigns, pricing);
        pagesWith += pageCalls;
        expect(held).toEqual(whole);
        expect(held.length).toBe(serves.length);
      }
    }
    const stats = __offerServeWalkStats();
    console.log(
      `[offer-serve-hold] /v1/runs lead-serve pages per hour: whole walk ${Math.round(pagesWithout / 6)}, held ${Math.round(pagesWith / 6)}`,
    );
    // After: ONE whole walk per campaign per 6 h (22 pages), then one recent page per campaign per read.
    expect(stats.fullWalks).toBe(2 + 144 * 2); // 2 held whole walks + the 288 hold-off comparison walks
    expect(pagesWith).toBe(22 + 143 * 2);
    expect(pagesWithout / pagesWith).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it("re-walks the whole campaign once the full-walk bound passed, so a late cost on an old serve lands", async () => {
    for (let i = 0; i < 1_200; i += 1) addServe("camp-owner", T0 - 5 * 86_400_000 + i * 300_000);
    const first = await read(true, ["camp-owner"], "gross");
    const old = serves[0]!;
    old.totalCostInUsdCents = "999.0000000000";
    vi.setSystemTime(T0 + 60 * 60_000);
    const stillHeld = await read(true, ["camp-owner"], "gross");
    expect(stillHeld.find((s) => s.runId === old.id)!.cents).toBe(first.find((s) => s.runId === old.id)!.cents);
    vi.setSystemTime(T0 + 6 * 60 * 60_000 + 1);
    const rewalked = await read(true, ["camp-owner"], "gross");
    expect(rewalked.find((s) => s.runId === old.id)!.cents).toBe("999.0000000000");
    expect(rewalked).toEqual(await read(false, ["camp-owner"], "gross"));
  });

  it("re-reads every serve inside the settle window, so a recent serve's moving cost is current", async () => {
    for (let i = 0; i < 600; i += 1) addServe("camp-owner", T0 - 3 * 86_400_000 + i * 400_000);
    const recent = addServe("camp-owner", T0 - 30 * 60_000);
    await read(true, ["camp-owner"], "net");
    recent.netTotalCostInUsdCents = "42.5";
    vi.setSystemTime(T0 + 5 * 60_000);
    const next = await read(true, ["camp-owner"], "net");
    expect(next.find((s) => s.runId === recent.id)!.cents).toBe("42.5");
    expect(next).toEqual(await read(false, ["camp-owner"], "net"));
  });

  it("shares one walk between concurrent reads of a campaign and keeps orgs apart", async () => {
    for (let i = 0; i < 1_100; i += 1) addServe("camp-owner", T0 - 86_400_000 + i * 60_000);
    process.env.OFFER_SERVE_HOLD_ENABLED = "true";
    const [a, b] = await Promise.all([
      fetchOfferServeCosts(BRAND, ["camp-owner"], IDENTITY, "gross"),
      fetchOfferServeCosts(BRAND, ["camp-owner"], IDENTITY, "net"),
    ]);
    expect(pageCalls).toBe(3);
    expect(a.map((s) => s.runId)).toEqual(b.map((s) => s.runId));
    await fetchOfferServeCosts(BRAND, ["camp-owner"], { ...IDENTITY, orgId: "org-2" }, "gross");
    expect(pageCalls).toBe(6);
  });

  it("fails loud on a missing net figure, held or not", async () => {
    addServe("camp-owner", T0 - 86_400_000);
    serves[0]!.netTotalCostInUsdCents = undefined as unknown as string;
    await expect(read(true, ["camp-owner"], "net")).rejects.toThrow(/NET/);
    await expect(read(true, ["camp-owner"], "net")).rejects.toThrow(/NET/);
  });
});
