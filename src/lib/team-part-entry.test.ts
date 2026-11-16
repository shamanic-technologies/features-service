/**
 * TEAM-PART-ENTRY-1116 (prod 2026-11-16, campaign Wide Email b255706c, brand 33211c62): its part a456d7ff, the client's
 * own team closing replies (Positive reply -> Paid client, `your-team-reply-closing`), has no run, so its own ledger
 * neither made nor took in a positive reply: entered 0, "% to Paid client" blank, beside the 2 positive replies the cold
 * email part b93006ef made. Entered = what the rest of its campaign made of its entry step (handed to it): 0 of 2.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseScopeLedgerByDay } from "./scope-outcome-ledger-io.js";
import { ledgerCountOfStep, ledgerEntryCountOfStep, ledgerScopeOf } from "./ledger-counts.js";
import { rebaseSpendChartOnLedger } from "./spend-charts-ledger.js";
import type { ScopeOutcomeLedgerInput } from "./scope-outcome-ledger.js";

const cost = { grossCents: "0", netCents: "0", vendorCents: "0" };
const scopeOf = (wire: object): ScopeOutcomeLedgerInput => ({
  ...parseScopeLedgerByDay(wire as never, "net"),
  unitCosts: new Map(),
  fleetProducers: new Map([
    ["lead_found", ["lead-service"]],
    ["conversation", ["lead-service"]],
    ["paid_client", ["lead-service"]],
  ]),
  today: "2026-11-16",
});

// The campaign's ledger (every part): Leads found, messages, 2 positive replies.
const CAMPAIGN_WIRE = {
  produced: [
    { dimensions: { outcomeKey: "lead_found", day: "2026-10-26" }, occurrences: 4157, cost },
    { dimensions: { outcomeKey: "message_sent", day: "2026-10-27" }, occurrences: 40, cost },
    { dimensions: { outcomeKey: "conversation", day: "2026-11-01" }, occurrences: 1, cost },
    { dimensions: { outcomeKey: "conversation", day: "2026-11-02" }, occurrences: 1, cost },
  ],
  consumed: [{ dimensions: { consumingOutcomeKey: "message_written", consumedOutcomeKey: "lead_found", day: "2026-10-27" }, consumptions: "40", reuses: "0", unknownProvenance: "0" }],
};
// The team part's own ledger: no run, nothing made, nothing consumed.
const TEAM_PART_WIRE = { produced: [], consumed: [] };

const teamChart = {
  leg: { channelSlug: "your-team-reply-closing", legKey: "conversation_to_paid_client", fromStep: "conversation", toStep: "paid_client", maturityDays: 0, learningOutcomesRequired: 10 },
  target: null,
  outcomeStep: "paid_client",
  outcomeUnavailableReason: null,
  conversionUnavailableReason: null,
  spendByActionUnavailableReason: null,
  daily: [],
  totals: { spendUsd: 0, outcomes: 0, costPerOutcomeUsd: null, entered: 0, converted: 0, conversionRatePct: null, learning: true },
  expected: { costPerOutcomeUsd: null, costPerOutcomeBasis: null, costPerOutcomeUnavailableReason: "expected_prices_another_step", conversionRatePct: 5, conversionBasis: "default", conversionSource: "default", conversionUnavailableReason: null },
};

describe("TEAM-PART-ENTRY-1116: a part with no intake of its own counts what the rest of its campaign handed it", () => {
  const campaign = ledgerScopeOf(scopeOf(CAMPAIGN_WIRE));
  const part = ledgerScopeOf(scopeOf(TEAM_PART_WIRE));

  it("entered = the campaign's 2 positive replies; converted 0; 0 %, never blank", () => {
    expect(ledgerCountOfStep(part, "conversation").units).toBe(0);
    const entry = ledgerEntryCountOfStep(part, "conversation", campaign);
    expect(entry.units).toBe(2);
    const r = rebaseSpendChartOnLedger(teamChart as never, ledgerCountOfStep(part, "paid_client").row, entry.row, 10, "pipe");
    expect(r.conversionUnavailableReason).toBeNull();
    expect(r.totals).toMatchObject({ entered: 2, converted: 0, conversionRatePct: 0 });
    expect(r.expected.conversionRatePct).toBe(5);
  });

  it("a part that made or took in its entry Units reads those, never the campaign's", () => {
    const sourcing = ledgerScopeOf(scopeOf({ produced: [{ dimensions: { outcomeKey: "lead_found", day: "2026-10-26" }, occurrences: 4157, cost }], consumed: [] }));
    expect(ledgerEntryCountOfStep(sourcing, "lead_found", campaign).units).toBe(4157);
    const coldEmail = ledgerScopeOf(scopeOf({ produced: [], consumed: CAMPAIGN_WIRE.consumed }));
    expect(ledgerEntryCountOfStep(coldEmail, "lead_found", campaign).units).toBe(40);
  });

  it("nothing handed either = the made row (0); no campaign ledger = unchanged", () => {
    const empty = ledgerScopeOf(scopeOf({ produced: [] }));
    expect(ledgerEntryCountOfStep(part, "conversation", empty)).toEqual(ledgerCountOfStep(part, "conversation"));
    expect(ledgerEntryCountOfStep(part, "conversation")).toEqual(ledgerCountOfStep(part, "conversation"));
    expect(ledgerEntryCountOfStep(part, "conversation", ledgerScopeOf(null))).toEqual(ledgerCountOfStep(part, "conversation"));
  });
});
