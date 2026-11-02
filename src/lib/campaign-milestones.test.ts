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
  const rows = milestonesOf({ legs, steps, pipes: [{ toStep: "lead_found", spendUsd: 40, outcomes: 1000 }, { toStep: "conversation", spendUsd: 360, outcomes: 4 }] });

  it("one row per milestone from Start to the Target, in line order", () => {
    expect(rows.map((r) => r.step)).toEqual(["start", "lead_found", "conversation", "paid_client"]);
    expect(rows.map((r) => r.isTarget)).toEqual([false, false, false, true]);
    expect(rows[0]).toMatchObject({ outcomes: null, costFromStartUsd: { value: 0, basis: "measured" } });
  });

  it("measured where the campaign has it: outcomes, the pipe's own cost per outcome, cost from Start, conversion", () => {
    expect(rows[1]).toMatchObject({ outcomes: 1000, costPerOutcomeUsd: { value: 0.04, basis: "measured" }, costFromStartUsd: { value: 0.04, basis: "measured" } });
    expect(rows[2]).toMatchObject({
      outcomes: 4,
      costPerOutcomeUsd: { value: 90, basis: "measured" },
      costFromStartUsd: { value: 100, basis: "measured" }, // ($40 + $360) / 4
      conversionFromAbovePct: { value: 0.4, basis: "measured" },
    });
  });

  it("expected (and said so) where it has not happened yet", () => {
    // Nobody paid yet: cost from Start = the plan's spend up to here per paying client.
    expect(rows[3]!.costFromStartUsd).toEqual({ value: 0.04 * 11000 + 150 * 20, basis: "expected", unavailableReason: null });
    expect(rows[3]!.costPerOutcomeUsd).toMatchObject({ value: 0, basis: "expected" });
    // 0 of 4 is measured: a conversion of 0% is a fact, never an expectation.
    expect(rows[3]!.conversionFromAbovePct).toMatchObject({ value: 0, basis: "measured" });
    expect(rows.map((r) => r.attemptsPerTarget.value)).toEqual([null, 11000, 20, 1]);
  });
});
