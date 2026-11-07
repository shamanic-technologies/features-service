/**
 * LEDGER-LOAD-1107-FEATURES: one runs-service read per ledger URL, process-wide, and the SAME figures from the same wire
 * bodies whether reads are shared or not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./fleet-leg-campaigns.js", () => ({ fetchFleetCampaignRows: vi.fn(async () => []) }));
vi.mock("./channel-declarations-store.js", () => ({ loadChannelCatalogue: vi.fn(async () => ({ channels: [] })) }));

import { readRunsLedger, __resetRunsLedgerReads, runsLedgerReadCounts } from "./runs-ledger-read.js";
import { fetchCampaignLedgerUnits } from "./campaign-ledger-units-client.js";
import { fetchOutcomeLedgerTotals, fetchOutcomeLedgerByWorkflow } from "./outcome-cost-totals-client.js";

type Io = typeof import("./scope-outcome-ledger-io.js");
// vitest.setup mocks the brand / campaign ledger reads for route suites: this suite drives the real module.
const io = await vi.importActual<Io>("./scope-outcome-ledger-io.js");

const cost = (g: number) => ({ grossCents: String(g), netCents: String(g * 0.8), vendorCents: String(g * 0.5) });
const byDayWire = (scope: string) => ({
  daysMissing: ["2026-11-06"],
  produced: [
    { dimensions: { outcomeKey: "message_sent", day: "2026-11-01" }, occurrences: 40, cost: cost(120) },
    { dimensions: { outcomeKey: "message_sent", day: "2026-11-02" }, occurrences: 35, cost: cost(101.5) },
    { dimensions: { outcomeKey: "lead_interested", day: "2026-11-02" }, occurrences: scope.length % 3, cost: cost(0) },
  ],
  consumed: [{ dimensions: { consumedOutcomeKey: "lead_found" }, unknownProvenance: "3" }],
  producedElsewhere: [{ dimensions: { outcomeKey: "paid_client", day: "2026-11-03", factory: "no_proof" }, occurrences: 1 }],
});
const totalsWire = () => ({
  produced: [
    { dimensions: { outcomeKey: "message_sent", campaignId: "c1", orgId: "o1" }, occurrences: 75, cost: cost(221.5) },
    { dimensions: { outcomeKey: "lead_interested", campaignId: "c1", orgId: "o1" }, occurrences: 2, cost: cost(3) },
  ],
  consumed: [{ dimensions: { consumingOutcomeKey: "lead_interested", consumedOutcomeKey: "message_sent", campaignId: "c1", orgId: "o1" }, consumptions: "2" }],
  scope: [{ dimensions: { orgId: "o1" }, spend: cost(300), producedCost: cost(224.5), support: cost(10), supportByFunction: { payment_fees: cost(10) } }],
  daysMissing: [],
});

let calls: string[] = [];
let failPerformers = true;

function wireFor(url: string): unknown {
  if (url.includes("outcome-performers")) return { groups: [{ outcomeKey: "message_sent", serviceName: "instantly-service", count: 3 }] };
  if (url.includes("groupBy=outcomeKey,day&")) return byDayWire(url);
  return totalsWire();
}

/** Maps -> sorted entries, so two results compare as the bytes a route would serve from them. */
function bytes(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : x));
}

beforeEach(() => {
  process.env.RUNS_SERVICE_URL = "http://runs";
  process.env.RUNS_LEDGER_SHARE = "true";
  __resetRunsLedgerReads();
  io.__resetScopeLedgerHolds();
  calls = [];
  failPerformers = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url.replace("http://runs", ""));
    await new Promise((r) => setTimeout(r, 5));
    if (url.includes("outcome-performers") && failPerformers) return new Response("statement timeout", { status: 500 });
    return new Response(JSON.stringify(wireFor(url)), { status: 200 });
  });
});
afterEach(() => {
  process.env.RUNS_LEDGER_SHARE = "false";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readRunsLedger", () => {
  it("asks a URL once for concurrent and later askers inside the hold, then again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a, b] = await Promise.all([readRunsLedger("/x?a=1", 60_000), readRunsLedger("/x?a=1", 60_000)]);
    await readRunsLedger("/x?a=1", 60_000);
    expect(calls).toEqual(["/x?a=1"]);
    expect(a).toBe(b);
    vi.setSystemTime(Date.now() + 60_001);
    await readRunsLedger("/x?a=1", 60_000);
    expect(calls).toHaveLength(2);
    expect(runsLedgerReadCounts()).toEqual([{ path: "/x", asked: 4, sent: 2 }]);
  });

  it("never holds a failed answer, and a zero hold shares only the read in flight", async () => {
    const f1 = await readRunsLedger("/internal/stats/outcome-performers?g=1", 60_000);
    expect(f1.ok).toBe(false);
    await readRunsLedger("/internal/stats/outcome-performers?g=1", 60_000);
    expect(calls).toHaveLength(2);
    await Promise.all([readRunsLedger("/y", 0), readRunsLedger("/y", 0)]);
    await readRunsLedger("/y", 0);
    expect(calls.filter((c) => c === "/y")).toHaveLength(2);
  });

  it("the kill switch sends every ask", async () => {
    process.env.RUNS_LEDGER_SHARE = "false";
    await Promise.all([readRunsLedger("/z", 60_000), readRunsLedger("/z", 60_000)]);
    expect(calls).toHaveLength(2);
  });
});

/**
 * One minute of the dashboard's ledger traffic for one brand, as the routes issue it (gross AND net reads of the brand,
 * the funnel campaign activity + spend charts on 3 units, Today's milestone cards on the same units, Research's mature
 * and flash builds, the index recorder's gross + vendor meeting cost, the per-workflow study).
 */
async function replayMinute() {
  const units = ["u1", "u2", "u3"];
  return Promise.all([
    io.fetchBrandOutcomeLedger("b1", "gross"),
    io.fetchBrandOutcomeLedger("b1", "net"),
    io.fetchBrandOutcomeLedger("b1", "net"),
    io.fetchCampaignSetOutcomeLedger(units, "b1", "net"),
    ...units.map((u) => io.fetchCampaignSetOutcomeLedger([u], "b1", "net")),
    io.fetchCampaignSetOutcomeLedger(units, "b1", "gross"),
    ...units.map((u) => fetchCampaignLedgerUnits(u)),
    fetchOutcomeLedgerTotals("gross"),
    fetchOutcomeLedgerTotals("gross"),
    fetchOutcomeLedgerTotals("vendor"),
    fetchOutcomeLedgerByWorkflow("gross"),
  ]);
}

describe("one minute of ledger traffic", () => {
  it("serves byte-identical figures shared or not: 9 runs-service reads (34 with every ask sent; 19 on the pre-1107 per-reader holds)", async () => {
    process.env.RUNS_LEDGER_SHARE = "false";
    const unshared = await replayMinute();
    const unsharedCalls = calls.length;
    calls = [];
    __resetRunsLedgerReads();
    io.__resetScopeLedgerHolds();
    process.env.RUNS_LEDGER_SHARE = "true";
    const shared = await replayMinute();
    expect(bytes(shared)).toBe(bytes(unshared));
    // every ask sent: 8 brand reads x 2 bodies, 12 campaign by-day, 3 fleet totals, 2 per-workflow, 1 performers (its
    // in-flight read is shared, its failure held). Shared: brand by-day + totals, 3 campaign by-day, performers, fleet
    // totals, the two per-workflow bodies. (origin/main's per-reader holds, replayed on the same mock: 19.)
    expect(unsharedCalls).toBe(34);
    expect(calls.length).toBe(9);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("a failed fleet performers read is not re-sent behind every brand read for 5 min (figures: no producer gap named, as on a failure)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await io.fetchBrandOutcomeLedger("b1", "gross");
    __resetRunsLedgerReads();
    await io.fetchBrandOutcomeLedger("b2", "gross");
    expect(calls.filter((c) => c.includes("outcome-performers"))).toHaveLength(1);
    expect(first.fleetProducersKnown).toBe(false);
    failPerformers = false;
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const later = await io.fetchBrandOutcomeLedger("b3", "gross");
    expect(calls.filter((c) => c.includes("outcome-performers"))).toHaveLength(2);
    expect(later.fleetProducersKnown).toBe(true);
  });
});
