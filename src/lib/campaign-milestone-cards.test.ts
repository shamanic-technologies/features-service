import { describe, expect, it } from "vitest";
import { milestoneChainOf, milestoneCardsOf, cumulativeFromDaily, withProducedMilestones, type MilestoneCardInput } from "./campaign-milestone-cards.js";
import { unconstrainedSchedule } from "./spend-capacity.js";
import { parseCampaignLedgerUnits, sumLedgerUnits } from "./campaign-ledger-units-client.js";

const NOW = "2026-11-06T12:00:00.000Z";

describe("campaign milestone cards (OUTCOME-RUNG-AND-TARGET-1106 follow-up)", () => {
  it("the chain of the campaign's units from Start to its Target (Threads post: post published -> website visit -> signup)", () => {
    const units = [
      { campaignId: "threads", fromStep: null, toStep: "threads_post_published" },
      { campaignId: "closing", fromStep: "threads_post_published", toStep: "paid_client" },
      { campaignId: "organic", fromStep: "threads_post_published", toStep: "website_visit" },
      { campaignId: "site", fromStep: "website_visit", toStep: "signup" },
      { campaignId: "conv", fromStep: "signup", toStep: "paid_client" },
    ];
    expect(milestoneChainOf(units, "signup")).toEqual([
      { step: "threads_post_published", unitCampaignIds: ["threads"] },
      { step: "website_visit", unitCampaignIds: ["organic"] },
      { step: "signup", unitCampaignIds: ["site"] },
    ]);
    // A Target no unit reaches: the walk, then the Target.
    expect(milestoneChainOf(units.slice(0, 1), "signup").map((m) => m.step)).toEqual(["threads_post_published", "signup"]);
  });

  // CAMPAIGN-CONVERSION-1116 (prod 2026-11-16, Wide Email): a follow-up writer on start_to_paid_client beside the chain.
  it("a unit jumping Start -> Target is no chain of its own: the walk reads the others, it lands on the Target's card", () => {
    const units = [
      { campaignId: "fu", fromStep: null, toStep: "paid_client" },
      { campaignId: "src", fromStep: null, toStep: "lead_found" },
      { campaignId: "ce", fromStep: "lead_found", toStep: "conversation" },
      { campaignId: "team", fromStep: "conversation", toStep: "paid_client" },
    ];
    expect(milestoneChainOf(units, "paid_client")).toEqual([
      { step: "lead_found", unitCampaignIds: ["src"] },
      { step: "conversation", unitCampaignIds: ["ce"] },
      { step: "paid_client", unitCampaignIds: ["team", "fu"] },
    ]);
    // A chain missing a link: the walk, then the Target, its jumping unit on it.
    expect(milestoneChainOf(units.slice(0, 2), "paid_client")).toEqual([
      { step: "lead_found", unitCampaignIds: ["src"] },
      { step: "paid_client", unitCampaignIds: ["fu"] },
    ]);
    // Only jumping units: the one-step chain (unchanged).
    expect(milestoneChainOf(units.slice(0, 1), "paid_client")).toEqual([{ step: "paid_client", unitCampaignIds: ["fu"] }]);
  });

  it("counts the Units the runs produced (posts), per day; $ per Unit, % to next, projection off the Target's pace", () => {
    const ms: MilestoneCardInput[] = [
      { step: "threads_post_published", label: "Threads post published", lifecycleRung: "none", ledgerByDay: new Map([["2026-11-04", 2], ["2026-11-06", 3]]), ledgerUnavailableReason: null, ownSpendUsd: 21.31, spendUpToUsd: 21.31, neededPerTarget: 10 },
      { step: "signup", label: "Signup", lifecycleRung: "signup_or_form", ledgerByDay: new Map(), ledgerUnavailableReason: "outcome_not_declared_in_ledger", ownSpendUsd: 0, spendUpToUsd: 21.31, neededPerTarget: 1 },
    ];
    const [post, signup] = milestoneCardsOf({ milestones: ms, targetSchedule: unconstrainedSchedule(0.5, NOW), targetProjectionUnavailableReason: null, projectionDays: 3, now: NOW });
    expect(post).toMatchObject({ count: 5, countSource: "ledger", costPerUnitUsd: 4.262, conversionToNextPct: null, isTarget: false });
    expect(post!.past.map((p) => [p.date, p.outcomes, p.cumulativeOutcomes])).toEqual([["2026-11-04", 2, 2], ["2026-11-05", 0, 2], ["2026-11-06", 3, 5]]);
    expect(post!.projection).toMatchObject({ outcomesPerDay: 5, nextExpectedInHours: 4.8 });
    // LEDGER-ONLY-1107: a signup no run declares is null with the ledger's reason, never the campaign's people count.
    expect(signup).toMatchObject({ isTarget: true, count: null, countSource: null, countUnavailableReason: "outcome_not_declared_in_ledger", costPerUnitUsd: null, costFromStartUsd: null });
    expect(signup!.projection.outcomesPerDay).toBe(0.5);
  });

  it("the past never moves with the Plan: only the projection follows the pace", () => {
    const ms: MilestoneCardInput[] = [{ step: "threads_post_published", label: "Threads post published", lifecycleRung: "none", ledgerByDay: new Map([["2026-11-06", 4]]), ledgerUnavailableReason: null, ownSpendUsd: 8, spendUpToUsd: 8, neededPerTarget: null }];
    const a = milestoneCardsOf({ milestones: ms, targetSchedule: unconstrainedSchedule(1, NOW), targetProjectionUnavailableReason: null, projectionDays: 2, now: NOW });
    const b = milestoneCardsOf({ milestones: ms, targetSchedule: null, targetProjectionUnavailableReason: "plan_not_computed_yet", projectionDays: 2, now: NOW });
    expect(b[0]!.past).toEqual(a[0]!.past);
    expect(b[0]!.count).toBe(a[0]!.count);
    expect(b[0]!.projection).toMatchObject({ outcomesPerDay: null, unavailableReason: "plan_not_computed_yet" });
  });

  it("a milestone nothing counts: null with a reason; a unit that spent and produced none: a measured 0", () => {
    const none = milestoneCardsOf({ milestones: [{ step: "x", label: "X", lifecycleRung: null, ledgerByDay: new Map(), ledgerUnavailableReason: null, ownSpendUsd: 0, spendUpToUsd: 0, neededPerTarget: null }], targetSchedule: null, targetProjectionUnavailableReason: null, projectionDays: 1, now: NOW });
    expect(none[0]).toMatchObject({ count: null, countUnavailableReason: "no_unit_makes_it" });
    const zero = milestoneCardsOf({ milestones: [{ step: "x", label: "X", lifecycleRung: null, ledgerByDay: new Map(), ledgerUnavailableReason: null, ownSpendUsd: 3, spendUpToUsd: 3, neededPerTarget: null }], targetSchedule: null, targetProjectionUnavailableReason: null, projectionDays: 1, now: NOW });
    expect(zero[0]).toMatchObject({ count: 0, countSource: "ledger", costPerUnitUnavailableReason: "no_unit_yet" });
  });

  it("parses runs-service's per-campaign ledger and sums units", () => {
    const a = parseCampaignLedgerUnits({ daysMissing: ["2026-11-06"], produced: [{ dimensions: { outcomeKey: "threads_post_published", day: "2026-11-05" }, occurrences: 2 }] });
    const b = parseCampaignLedgerUnits({ produced: [{ dimensions: { outcomeKey: "threads_post_published", day: "2026-11-05" }, occurrences: 1 }] });
    const s = sumLedgerUnits([a, b]);
    expect(s.byOutcome.get("threads_post_published")?.get("2026-11-05")).toBe(3);
    expect(s.daysMissing).toEqual(["2026-11-06"]);
    expect(cumulativeFromDaily(new Map([["2026-11-06", 1]]), "2026-11-05")).toEqual([]);
  });
});

// MILESTONES-CONTACTED-1117: one rule for every campaign, read off the ledger and the outcome rung catalogue.
describe("withProducedMilestones", () => {
  const rank: Record<string, number> = { lead_found: 1, message_sent: 2, email_sent: 2, conversation: 3, meeting_booked: 5, paid_client: 7 };
  const rankOf = (k: string) => rank[k] ?? null;
  const chain = [
    { step: "lead_found", unitCampaignIds: ["src"] },
    { step: "conversation", unitCampaignIds: ["mail"] },
    { step: "paid_client", unitCampaignIds: ["team", "follow"] },
  ];
  it("inserts every produced outcome ranked strictly between two milestones, lowest rung first, before the later one", () => {
    const produced = new Map([
      ["src", new Set(["email_checked", "lead_found"])],
      ["mail", new Set(["message_written", "message_sent", "email_sent", "conversation"])],
      ["follow", new Set(["message_sent", "meeting_booked"])],
    ]);
    const out = withProducedMilestones(chain, produced, rankOf, new Set(["conversation"]));
    expect(out.map((m) => [m.step, m.producedBy])).toEqual([
      ["lead_found", null],
      ["email_sent", ["mail"]],
      ["message_sent", ["mail"]],
      ["conversation", null],
      // message_sent (rung 2) is below Positive reply (3): never placed between it and the Target.
      ["meeting_booked", ["team", "follow"]],
      ["paid_client", null],
    ]);
  });
  it("an outcome already counted by a milestone, or a milestone with no rung, adds nothing", () => {
    const produced = new Map([["mail", new Set(["message_sent"])]]);
    expect(withProducedMilestones(chain, produced, rankOf, new Set(["message_sent"])).map((m) => m.step)).toEqual(["lead_found", "conversation", "paid_client"]);
    expect(withProducedMilestones(chain, produced, (k) => (k === "lead_found" ? null : rankOf(k)), new Set()).map((m) => m.step)).toEqual(["lead_found", "conversation", "paid_client"]);
  });
});
