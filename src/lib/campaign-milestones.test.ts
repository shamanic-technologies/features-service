import { describe, expect, it } from "vitest";
import { milestonesOf } from "./campaign-milestones.js";

const legs = [
  { legKey: "start_to_lead_found", toStep: "lead_found", costPerOutcomeUsd: 0.04, ratePct: null, outcomesNeededPerPayingClient: 11000, costSource: "workflow" },
  { legKey: "lead_found_to_conversation", toStep: "conversation", costPerOutcomeUsd: 150, ratePct: 0.18, outcomesNeededPerPayingClient: 20, costSource: "same_leg_fleet" },
  { legKey: "conversation_to_paid_client", toStep: "paid_client", costPerOutcomeUsd: 0, ratePct: 5, outcomesNeededPerPayingClient: 1, costSource: "customer_team" },
];
const steps = [
  { key: "lead_found", label: "Lead found", people: 1000 },
  { key: "conversation", label: "Positive reply", people: 4 },
  { key: "paid_client", label: "Paid client", people: 0 },
];

describe("campaign milestones (FACTORY-USER-DASHBOARD-1102)", () => {
  const rows = milestonesOf({ steps, target: "paid_client", planLegs: legs, planUnavailableReason: null, pipes: [{ toStep: "lead_found", spendUsd: 40, outcomes: 1000 }, { toStep: "conversation", spendUsd: 360, outcomes: 4 }] });

  it("one row per milestone from Start to the Target, in line order", () => {
    expect(rows.map((r) => r.step)).toEqual(["start", "lead_found", "conversation", "paid_client"]);
    expect(rows.map((r) => r.isTarget)).toEqual([false, false, false, true]);
    expect(rows[0]).toMatchObject({ outcomes: null, costFromStartUsd: { value: 0, basis: "measured" } });
  });

  it("measured where the campaign has it: outcomes, the pipe's own cost per outcome, cost from Start, conversion", () => {
    expect(rows[1]).toMatchObject({ outcomes: 1000, costPerOutcomeUsd: { value: 0.04, basis: "measured" }, costFromStartUsd: { value: 0.04, basis: "measured" } });
    expect(rows[2]).toMatchObject({
      outcomes: 4,
      costPerOutcomeUsd: { value: 90, basis: "measured" }, // $360 / the row's 4 people
      costFromStartUsd: { value: 100, basis: "measured" }, // ($40 + $360) / 4
      conversionFromAbovePct: { value: 0.4, basis: "measured" },
    });
  });

  it("a pipe's cost per outcome divides the row's own people, the count the cost from Start divides", () => {
    const r = milestonesOf({ steps, target: "paid_client", planLegs: legs, planUnavailableReason: null, pipes: [{ toStep: "lead_found", spendUsd: 40, outcomes: 1000 }, { toStep: "conversation", spendUsd: 360, outcomes: 2 }] });
    expect(r[2]!.costPerOutcomeUsd).toMatchObject({ value: 90, basis: "measured" });
  });

  it("a pipe with outcomes and no spend of its own reads its expected cost, never a measured $0", () => {
    const [, lead] = milestonesOf({ steps, target: "paid_client", planLegs: legs, planUnavailableReason: null, pipes: [{ toStep: "lead_found", spendUsd: 0, outcomes: 1000 }] });
    expect(lead!.costPerOutcomeUsd).toMatchObject({ value: 0.04, basis: "expected" });
  });

  it("expected (and said so) where it has not happened yet", () => {
    // Nobody paid yet: cost from Start = the plan's spend up to here per paying client.
    expect(rows[3]!.costFromStartUsd).toEqual({ value: 0.04 * 11000 + 150 * 20, basis: "expected", unavailableReason: null });
    expect(rows[3]!.costPerOutcomeUsd).toMatchObject({ value: 0, basis: "expected" });
    // 0 of 4 is measured: a conversion of 0% is a fact, never an expectation.
    expect(rows[3]!.conversionFromAbovePct).toMatchObject({ value: 0, basis: "measured" });
    expect(rows.map((r) => r.attemptsPerTarget.value)).toEqual([null, 11000, 20, 1]);
  });

  it("OUTCOME-RUNG-AND-TARGET-1106: rows are the campaign's funnel up to its Target, identical across two plan ticks whose line changed", () => {
    // Tick 1 plans Lead found -> Positive reply -> Paid client; tick 2 moves to Lead found -> Website visit -> Paid client.
    const funnel = [
      { key: "lead_found", label: "Lead found", people: 1000 },
      { key: "conversation", label: "Positive reply", people: 4 },
      { key: "paid_client", label: "Paid client", people: 1 },
    ];
    const pipes = [{ toStep: "lead_found", spendUsd: 40, outcomes: 1000 }, { toStep: "conversation", spendUsd: 360, outcomes: 4 }];
    const tick1 = milestonesOf({ steps: funnel, target: "paid_client", planLegs: legs, planUnavailableReason: null, pipes });
    const tick2 = milestonesOf({
      steps: funnel,
      target: "paid_client",
      planLegs: [legs[0]!, { legKey: "lead_found_to_website_visit", toStep: "website_visit", costPerOutcomeUsd: 3, ratePct: 2, outcomesNeededPerPayingClient: 50, costSource: "workflow" }, { ...legs[2]!, legKey: "website_visit_to_paid_client" }],
      planUnavailableReason: null,
      pipes,
    });
    const shape = (rows: typeof tick1) => rows.map((r) => ({ step: r.step, label: r.label, isTarget: r.isTarget, outcomes: r.outcomes }));
    expect(shape(tick2)).toEqual(shape(tick1));
    expect(shape(tick1).map((r) => r.step)).toEqual(["start", "lead_found", "conversation", "paid_client"]);
    // The past outcomes on the path the plan left stay, measured: never dropped with the plan line.
    expect(tick2[2]).toMatchObject({ outcomes: 4, costPerOutcomeUsd: { value: 90, basis: "measured" } });
    // Only expected figures move with the plan: a step the new plan does not walk reads `not_on_current_plan`.
    expect(tick2[2]!.attemptsPerTarget).toEqual({ value: null, basis: null, unavailableReason: "not_on_current_plan" });
    // No plan at all: rows still served, expected figures say why.
    const none = milestonesOf({ steps: funnel, target: "paid_client", planLegs: [], planUnavailableReason: "plan_not_computed_yet", pipes });
    expect(shape(none)).toEqual(shape(tick1));
    expect(none[3]!.attemptsPerTarget.unavailableReason).toBe("plan_not_computed_yet");
  });

  it("stops at a Target before the funnel's end; appends a Target off the funnel", () => {
    expect(milestonesOf({ steps, target: "conversation", planLegs: legs, planUnavailableReason: null, pipes: [] }).map((r) => [r.step, r.isTarget])).toEqual([["start", false], ["lead_found", false], ["conversation", true]]);
    const off = milestonesOf({ steps, target: "client_satisfied", planLegs: [], planUnavailableReason: "plan_not_computed_yet", pipes: [] });
    expect(off.map((r) => r.step)).toEqual(["start", "lead_found", "conversation", "paid_client", "client_satisfied"]);
    expect(off[4]).toMatchObject({ isTarget: true, outcomes: null, outcomesUnavailableReason: "not_counted_for_this_campaign" });
  });
});
