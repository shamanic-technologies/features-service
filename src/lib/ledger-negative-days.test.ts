/**
 * LEDGER-NEGATIVE-DAYS-1110: every reader of our ledger Units nets a WITHDRAWN Unit (a negative day, runs-service
 * `run_outcome_reversals`) by THE one rule, `standingUnitsByDay`, so two surfaces never disagree on how many a brand made.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.unmock("./ledger-counts.js");
import { scopeOutcomeLedgerRowOf, standingUnitsByDay, standingUnits, type ScopeOutcomeLedgerInput, type OtherFactory } from "./scope-outcome-ledger.js";
import { ledgerCountOfStep, ledgerOurUnitDays, ledgerTotalUnitCount, ledgerSeriesOf, withLedgerRawStats, withLedgerDayChart, ledgerScopeOf } from "./ledger-counts.js";
import { parseCampaignLedgerUnits } from "./campaign-ledger-units-client.js";
import { parseOutcomeLedgerTotals } from "./outcome-cost-totals-client.js";
import { parseLedgerBook } from "./ledger-book.js";

// Prod 2026-11-10, Distribute.you Signup: 484 made, lead-service withdrew 222 then 398 (sum -136; skipping read 484).
const SIGNUP = new Map([["2026-06-01", 300], ["2026-07-01", 184], ["2026-11-09", -222], ["2026-11-10", -398]]);

const input = (over: Partial<ScopeOutcomeLedgerInput> = {}): ScopeOutcomeLedgerInput => ({
  producedByDay: new Map([
    ["signup", SIGNUP],
    ["backlink_earned", new Map([["2026-11-01", 5], ["2026-11-03", 2], ["2026-11-04", -3]])],
  ]),
  ownCostUsd: new Map(),
  unitCosts: new Map(),
  undeclaredConsumptions: new Map(),
  fleetProducers: new Map([["signup", ["lead-service"]], ["backlink_earned", ["outlets-service"]]]),
  daysMissing: [],
  today: "2026-11-10",
  ...over,
});

describe("standingUnitsByDay: THE rule", () => {
  it("a negative day takes back the LATEST Units before it", () => {
    expect([...standingUnitsByDay(new Map([["d1", 5], ["d3", 2], ["d4", -3]]))]).toEqual([["d1", 4]]);
  });
  it("never below zero, and Units made after a withdrawal stand", () => {
    expect([...standingUnitsByDay(SIGNUP)]).toEqual([]);
    expect([...standingUnitsByDay(new Map([["d1", 2], ["d2", -5], ["d3", 1]]))]).toEqual([["d3", 1]]);
  });
  it("days are read in order whatever the input order, the same day merged", () => {
    expect([...standingUnitsByDay([["d2", -1], ["d1", 3], ["d1", 1]])]).toEqual([["d1", 3]]);
  });
  it("no negative day: unchanged; a read with no day floors at zero", () => {
    expect([...standingUnitsByDay(new Map([["d1", 2], ["d2", 1]]))]).toEqual([["d1", 2], ["d2", 1]]);
    expect([standingUnits(-136), standingUnits(7)]).toEqual([0, 7]);
  });
});

describe("scopeOutcomeLedgerRowOf: every count, day and curve from the standing Units", () => {
  it("withdrawn signups: 0 Units, never 484 nor -136, no negative day or cumulative", () => {
    const r = scopeOutcomeLedgerRowOf(["signup"], input());
    expect(r.units).toBe(0);
    expect(r.ourUnits).toBe(0);
    expect(r.past.every((p) => p.units >= 0 && p.cumulativeUnits >= 0 && p.cumulativeOurUnits >= 0)).toBe(true);
  });
  it("partly withdrawn: the latest Units go, the curve ends on the count", () => {
    const r = scopeOutcomeLedgerRowOf(["backlink_earned"], input());
    expect(r.units).toBe(4);
    expect(r.past.find((p) => p.date === "2026-11-01")!.units).toBe(4);
    expect(r.past.find((p) => p.date === "2026-11-03")!.units).toBe(0);
    expect(r.past.at(-1)!.cumulativeUnits).toBe(4);
  });
  it("another factory's Units netted by the same rule, per factory", () => {
    const elsewhere = new Map([["meeting_booked", new Map<string, Map<OtherFactory, number>>([["2026-11-01", new Map([["no_proof", 3], ["another_factory", 2]])], ["2026-11-02", new Map([["no_proof", -5]])]])]]);
    const r = scopeOutcomeLedgerRowOf(["meeting_booked"], input({ elsewhereByDay: elsewhere }));
    expect(r.otherFactoryUnits).toEqual({ total: 2, anotherFactory: 2, noProof: 0 });
    expect(r.units).toBe(2);
  });
});

describe("every reader of the row agrees with the Outcomes overview row (`ledgerOurUnitDays` / `ledgerTotalUnitCount`)", () => {
  const scope = ledgerScopeOf(input());
  const c = ledgerCountOfStep(scope, "backlink_earned");
  it("count, series total, day list and total agree", () => {
    expect(c.units).toBe(4);
    expect(ledgerSeriesOf(c)!.total).toBe(4);
    expect(ledgerSeriesOf(c)!.daily.reduce((a, d) => a + d.count, 0)).toBe(4);
    expect(ledgerOurUnitDays(c)).toHaveLength(4);
    expect(ledgerTotalUnitCount(c)).toBe(4);
  });
  it("the raw stats and the day chart print the same", () => {
    const sig = ledgerCountOfStep(scope, "signup");
    expect(ledgerOurUnitDays(sig)).toHaveLength(0);
    const day = withLedgerDayChart({ days: [{ date: "2026-11-10", metrics: { signups: { actual: 1, expected: 1 } } }] }, scope) as { days: Array<{ metrics: { signups: { actual: number } } }> };
    expect(day.days[0]!.metrics.signups.actual).toBe(0);
    const stats = withLedgerRawStats({ leadsServed: 1 }, new Set(["leadsServed"]), ledgerScopeOf(input({ producedByDay: new Map([["lead_found", new Map([["d1", 3], ["d2", -5]])]]) })), "brand");
    expect(stats.raw.leadsServed).toBeUndefined(); // 0 Units, no producer known for lead_found here: null, never -2
  });
});

describe("readers off the scope row use the same rule", () => {
  it("campaign milestones (by-day units)", () => {
    const u = parseCampaignLedgerUnits({ produced: [["2026-11-01", 5], ["2026-11-03", 2], ["2026-11-04", -3]].map(([day, occurrences]) => ({ dimensions: { outcomeKey: "backlink_earned", day: day as string }, occurrences: occurrences as number })) });
    expect([...u.byOutcome.get("backlink_earned")!]).toEqual([["2026-11-01", 4]]);
  });
  it("the cost roll-up totals (no day): never a negative divisor", () => {
    const t = parseOutcomeLedgerTotals({ produced: [{ dimensions: { outcomeKey: "signup", campaignId: null, orgId: "o" }, occurrences: -136, cost: { grossCents: "0", netCents: "0", vendorCents: "0" } }] } as never, "gross");
    expect(t.produced[0]!.produced).toBe(0);
  });
  it("the ledger book: each group netted over its run-start days", () => {
    const row = (day: string, n: number) => ({ dimensions: { outcomeKey: "signup", campaignId: null, workflowSlug: null, audienceId: null, runStartDay: day }, occurrences: n, cost: { grossCents: "0" } });
    const b = parseLedgerBook({ produced: [row("d1", 5), row("d2", 2), row("d3", -3)] }, {}, {}, "gross");
    expect(b.book.produced.map((r) => [r.runStartDay, r.occurrences])).toEqual([["d1", 4], ["d2", 0], ["d3", 0]]);
  });
});
