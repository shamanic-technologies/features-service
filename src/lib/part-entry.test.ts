/**
 * PART-ENTRY-1116 (prod 2026-11-16, campaign Wide Email b255706c, brand 33211c62):
 *  1. its cold email part b93006ef (lead_found -> conversation) read entered 0 beside 2 positive replies: the part finds
 *     nobody (sourcing part 9fcb1a51 does), it TAKES IN the Leads found it consumes. Entered = those, never blank.
 *  2. the offer / brand "% to Paid client" counted from Meeting booked because Reply Booking (reactive) is newer than
 *     Wide Email (proactive, from Lead found): a group counts from its EARLIEST entry.
 * Fixture figures mirror the prod ledger read of part b93006ef on 2026-11-16 (runs-service outcome-costs by campaign).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseScopeLedgerByDay } from "./scope-outcome-ledger-io.js";
import { ledgerCountOfStep, ledgerEntryCountOfStep, ledgerScopeOf } from "./ledger-counts.js";
import { scopeOutcomeLedgerRowOf, type ScopeOutcomeLedgerInput } from "./scope-outcome-ledger.js";
import { rebaseSpendChartOnLedger } from "./spend-charts-ledger.js";
import { groupChartTarget, type ChartTarget } from "./spend-chart-target.js";
import { ROUTE_COMPUTE_RULES } from "./response-shape.js";

const cost = { grossCents: "0", netCents: "0", vendorCents: "0" };
const consumed = (consumingOutcomeKey: string, consumedOutcomeKey: string, day: string, consumptions: number, reuses = 0) => ({
  dimensions: { consumingOutcomeKey, consumedOutcomeKey, day },
  consumptions: String(consumptions),
  reuses: String(reuses),
  unknownProvenance: "0",
});

// The cold email part's own ledger: it makes messages and 2 positive replies, no Lead found; it consumes Leads found
// (one consumption split across the consuming run's outcomes: here 0.75 + 0.25 the same day).
const PART_WIRE = {
  produced: [
    { dimensions: { outcomeKey: "message_sent", day: "2026-10-27" }, occurrences: 40, cost },
    { dimensions: { outcomeKey: "conversation", day: "2026-11-01" }, occurrences: 1, cost },
    { dimensions: { outcomeKey: "conversation", day: "2026-11-02" }, occurrences: 1, cost },
  ],
  consumed: [
    consumed("lead_interested", "lead_found", "2026-10-27", 37),
    consumed("message_written", "lead_found", "2026-10-27", 3),
    consumed("lead_interested", "lead_found", "2026-11-01", 686.75),
    consumed("message_written", "lead_found", "2026-11-01", 0.25),
    // A Lead found consumed again (a reuse) is not taken in twice.
    consumed("message_written", "lead_found", "2026-11-02", 5, 5),
    consumed("message_sent", "message_written", "2026-11-01", 900),
  ],
};

const scopeOf = (wire: object): ScopeOutcomeLedgerInput => ({
  ...parseScopeLedgerByDay(wire as never, "net"),
  unitCosts: new Map(),
  fleetProducers: new Map([["lead_found", ["lead-service"]], ["lead_interested", ["lead-service"]]]),
  today: "2026-11-02",
});

describe("PART-ENTRY-1116: a part that finds nobody counts from the Units it took in", () => {
  it("the ledger wire's first consumptions per day are the Units taken in (reuses out, split parts summed back)", () => {
    const p = parseScopeLedgerByDay(PART_WIRE as never, "net");
    expect([...p.takenInByDay.get("lead_found")!]).toEqual([["2026-10-27", 40], ["2026-11-01", 687]]);
    expect(p.takenInByDay.get("message_written")?.get("2026-11-01")).toBe(900);
  });

  it("entered = Leads found taken in, converted = its positive replies: 2 of 727, never 0 nor blank", () => {
    const scope = ledgerScopeOf(scopeOf(PART_WIRE));
    expect(ledgerCountOfStep(scope, "lead_found").units).toBe(0);
    const entry = ledgerEntryCountOfStep(scope, "lead_found");
    expect(entry.units).toBe(727);
    const chart = {
      leg: { channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", fromStep: "lead_found", toStep: "conversation", maturityDays: 0, learningOutcomesRequired: 10 },
      target: null,
      outcomeStep: "conversation",
      outcomeUnavailableReason: null,
      conversionUnavailableReason: null,
      spendByActionUnavailableReason: null,
      daily: ["2026-10-27", "2026-11-01", "2026-11-02"].map((date, i) => ({
        date, spendUsd: 10, cumulativeSpendUsd: 10 * (i + 1), cumulativeOutcomes: 0, costPerOutcomeUsd: null, entered: 0, cohortOutcomes: 0, cohortConversionPct: null, cohortMature: false,
        cumulativeEntered: 0, cumulativeConverted: 0, conversionRatePct: null, matureConversionRatePct: null, matureOutcomes: 0, learning: true, byAction: [], byActionGapUsd: 0,
      })),
      totals: { spendUsd: 30, outcomes: 0, costPerOutcomeUsd: null, entered: 0, converted: 0, conversionRatePct: null, learning: true },
      expected: { costPerOutcomeUsd: null, costPerOutcomeBasis: null, costPerOutcomeUnavailableReason: null, conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: null },
    };
    const r = rebaseSpendChartOnLedger(chart as never, ledgerCountOfStep(scope, "conversation").row, entry.row, 10, "pipe");
    expect(r.conversionUnavailableReason).toBeNull();
    expect(r.totals).toMatchObject({ entered: 727, converted: 2 });
    expect(r.totals.conversionRatePct).toBeCloseTo((2 / 727) * 100, 6);
    expect(r.daily.map((p) => [p.cumulativeEntered, p.cumulativeConverted])).toEqual([[40, 0], [727, 1], [727, 2]]);
  });

  it("a scope that makes its entry step reads what it made (a campaign / brand finding its own people: unchanged)", () => {
    const wire = {
      ...PART_WIRE,
      produced: [...PART_WIRE.produced, { dimensions: { outcomeKey: "lead_found", day: "2026-10-26" }, occurrences: 4157, cost }],
    };
    const scope = ledgerScopeOf(scopeOf(wire));
    expect(ledgerEntryCountOfStep(scope, "lead_found").units).toBe(4157);
    // Nothing made and nothing taken in: the made row (0) as before.
    const empty = ledgerScopeOf({ ...scopeOf({ produced: [] }), fleetProducers: new Map([["lead_found", ["lead-service"]]]) });
    expect(ledgerEntryCountOfStep(empty, "lead_found")).toEqual(ledgerCountOfStep(empty, "lead_found"));
    // A ledger input with no taken-in read at all (the brand-only shape) is untouched.
    const input: ScopeOutcomeLedgerInput = { ...scopeOf({ produced: [] }), takenInByDay: undefined };
    expect(ledgerEntryCountOfStep(ledgerScopeOf(input), "lead_found").row).toEqual(scopeOutcomeLedgerRowOf(["lead_found"], input));
  });
});

describe("PART-ENTRY-1116: an offer / brand counts from its earliest entry, never the newer campaign's", () => {
  const PAID = (fromStep: string | null): ChartTarget => ({ step: "paid_client", fromStep, source: "campaign_target" });
  it("Wide Email (from Lead found) beside the newer Reply Booking (from Meeting booked): from Lead found", () => {
    expect(groupChartTarget([{ target: PAID("lead_found"), createdAt: "2026-10-20" }, { target: PAID("meeting_booked"), createdAt: "2026-11-10" }])?.fromStep).toBe("lead_found");
    // Whatever the order, whatever the count of later-entry campaigns.
    expect(
      groupChartTarget([
        { target: PAID("meeting_booked"), createdAt: "2026-11-10" },
        { target: PAID("meeting_booked"), createdAt: "2026-11-11" },
        { target: PAID("lead_found"), createdAt: "2026-10-20" },
      ])?.fromStep,
    ).toBe("lead_found");
    // Lower rung of the ladder first: a positive reply entry comes before Meeting booked.
    expect(groupChartTarget([{ target: PAID("conversation"), createdAt: "2026-10-01" }, { target: PAID("meeting_booked"), createdAt: "2026-11-01" }])?.fromStep).toBe("conversation");
    // A member with nobody to convert still never voids it.
    expect(groupChartTarget([{ target: PAID(null), createdAt: "2026-11-12" }, { target: PAID("meeting_booked"), createdAt: "2026-11-01" }])?.fromStep).toBe("meeting_booked");
  });
});

describe("PART-ENTRY-1116: the fix retires every cell computed before it", () => {
  it("the three spend-charts routes and campaign-targets state this ship's compute rule", () => {
    // EXPECTED-FLEET-RATE-1116, then ROI-ROUNDING-1116, retire every cell again (a later fix supersedes the rule).
    expect(ROUTE_COMPUTE_RULES["/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/spend-charts"]).toBe("roi-rounding-1116");
    for (const path of [
      "/offers/{offerId}/spend-charts",
      "/brands/{brandId}/spend-charts",
    ])
      expect(ROUTE_COMPUTE_RULES[path]).toBe("roi-rounding-1116");
    expect(ROUTE_COMPUTE_RULES["/brands/{brandId}/campaign-targets"]).toBe("roi-rounding-1116");
  });
});
