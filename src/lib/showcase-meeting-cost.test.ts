/**
 * SHOWCASE-COST-PER-MEETING-1119: the homepage cards' cost per booked meeting = what ONE meeting OUR factory booked cost
 * (the brand ledger's every-path unit cost, our Units only), never the brand's spend over every meeting; a brand whose
 * meetings were all made by another factory states why, never a number nor a silent null. Prod 2026-11-19 (vendor):
 * Doc Dinners 173 meetings = 10 ours ($252) + 163 theirs, served null; Legistai 14 = 0 ours, served $2.53 ($35 ÷ 14);
 * Shockwave 5 = 0 ours, served null.
 */
import { describe, it, expect } from "vitest";
import { showcaseMeetingCostOf, withMeetingFacts } from "./showcase-clients.js";
import { showcaseOutcomesOf } from "./outcome-public-reads.js";
import type { ScopeOutcomeLedgerInput, OtherFactory } from "./scope-outcome-ledger.js";
import type { ShowcaseBrandFunnels } from "./showcase-funnels.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

const ledger = (ours: number, theirs: Array<[OtherFactory, number]>, unitCostUsd: number | null): ScopeOutcomeLedgerInput => ({
  producedByDay: new Map(ours > 0 ? [["meeting_booked", new Map([["2026-10-01", ours]])]] : []),
  elsewhereByDay: new Map(theirs.length > 0 ? [["meeting_booked", new Map([["2025-06-01", new Map(theirs)]])]] : []),
  ownCostUsd: new Map(),
  unitCosts: new Map(unitCostUsd === null ? [] : [["meeting_booked", { unitCostUsd }]]),
  undeclaredConsumptions: new Map(),
  fleetProducers: new Map([["meeting_booked", ["lead-service"]]]),
  fleetProducersKnown: true,
  daysMissing: [],
  today: "2026-11-19",
});

describe("showcaseMeetingCostOf", () => {
  it("Doc Dinners: 10 of 173 meetings ours, priced on ours at the ledger's unit cost", () => {
    expect(showcaseMeetingCostOf(ledger(10, [["another_factory", 11], ["no_proof", 152]], 252.0567), false)).toEqual({
      ourPeopleReached: 10,
      otherFactoryPeopleReached: 163,
      costPerReachUsd: 252.0567,
      costPerReachUnavailableReason: null,
    });
  });

  it("Legistai / Shockwave: every meeting another factory's = no cost of ours, said so", () => {
    expect(showcaseMeetingCostOf(ledger(0, [["no_proof", 14]], null), false)).toEqual({
      ourPeopleReached: 0,
      otherFactoryPeopleReached: 14,
      costPerReachUsd: null,
      costPerReachUnavailableReason: "no_unit_of_ours_yet",
    });
  });

  it("vendor cost unknown withholds the money, counts kept; unreadable ledger names it", () => {
    expect(showcaseMeetingCostOf(ledger(10, [], 252), true)).toMatchObject({ ourPeopleReached: 10, costPerReachUsd: null, costPerReachUnavailableReason: "vendor_cost_unknown" });
    expect(showcaseMeetingCostOf(null, false)).toMatchObject({ costPerReachUsd: null, costPerReachUnavailableReason: "ledger_unreadable" });
    expect(showcaseMeetingCostOf(ledger(0, [], null), false)).toMatchObject({ ourPeopleReached: 0, costPerReachUnavailableReason: "no_unit_yet" });
  });
});

const chain = (meetingCost: number | null) => ({
  funnelKey: "x" as SalesFunnelKey,
  funnelName: "x",
  steps: [
    { key: "contacted", label: "Contacted", peopleReached: 206, costPerReachUsd: 35.39 / 206 },
    { key: "start_to_conversation", label: "Positive reply", peopleReached: 1, costPerReachUsd: 35.39 },
    { key: "conversation_to_meeting_booked", label: "Meeting booked", peopleReached: 0, costPerReachUsd: meetingCost },
  ],
});
const walked = (meetingCost: number | null) => ({
  entry: { brand: { id: "b", name: "B", domain: "b.com" }, funnels: [chain(meetingCost)], measured: true, unmeasuredReason: null } as ShowcaseBrandFunnels,
  heroCounts: { positiveReplies: 1, meetingsBooked: 0, committedSpentCents: 3539 },
});

describe("withMeetingFacts + showcaseOutcomesOf", () => {
  it("Legistai: 14 meetings, none ours: the rung no longer reads $35 ÷ 14 = $2.53", () => {
    const cost = showcaseMeetingCostOf(ledger(0, [["no_proof", 14]], null), false);
    const w = withMeetingFacts(walked(35.39), 14, cost);
    const out = showcaseOutcomesOf(w.entry, w.heroCounts);
    expect(out.outcomes.find((o) => o.key === "meeting_booked")).toMatchObject({
      peopleReached: 14,
      ourPeopleReached: 0,
      otherFactoryPeopleReached: 14,
      costPerReachUsd: null,
      costPerReachUnavailableReason: "no_unit_of_ours_yet",
    });
  });

  it("Doc Dinners: the engine rung had no cost (0 meetings on its pass); the ledger prices our meetings", () => {
    const cost = showcaseMeetingCostOf(ledger(10, [["no_proof", 163]], 252.0567), false);
    const w = withMeetingFacts(walked(null), 173, cost);
    const out = showcaseOutcomesOf(w.entry, w.heroCounts);
    expect(out.outcomes.find((o) => o.key === "meeting_booked")).toMatchObject({ peopleReached: 173, ourPeopleReached: 10, costPerReachUsd: 252.0567 });
    // The funnel-keyed twin states the same figure on its rung.
    expect(w.entry.funnels[0].steps[2]).toMatchObject({ peopleReached: 173, costPerReachUsd: 252.0567, costPerReachUnavailableReason: null });
  });

  it("a meeting rung added from hero counts (no chain walks it) is ledger-priced too, never spend ÷ meetings", () => {
    const w = {
      entry: { brand: { id: "b", name: "B", domain: "b.com" }, funnels: [{ ...chain(null), steps: chain(null).steps.slice(0, 2) }], measured: true, unmeasuredReason: null } as ShowcaseBrandFunnels,
      heroCounts: { positiveReplies: 1, meetingsBooked: 5, committedSpentCents: 300000, meetingCost: showcaseMeetingCostOf(ledger(0, [["another_factory", 5]], null), false) },
    };
    const m = showcaseOutcomesOf(w.entry, w.heroCounts).outcomes.find((o) => o.key === "meeting_booked")!;
    expect(m).toMatchObject({ legKeys: [], peopleReached: 5, costPerReachUsd: null, costPerReachUnavailableReason: "no_unit_of_ours_yet", otherFactoryPeopleReached: 5 });
  });
});
