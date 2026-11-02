import { describe, expect, it } from "vitest";
import { peopleJourneysOf } from "./people-journeys.js";

const label = (s: string) => ({ lead_found: "Lead found", conversation: "Positive reply" })[s] ?? s;
const name = (d: string) => ({ keel: "Keel", ballad: "Ballad" })[d] ?? d;

describe("what its people went through (FACTORY-USER-DASHBOARD-1102)", () => {
  it("per transition: people who made it and each workflow's share of the work, biggest first", () => {
    const [t] = peopleJourneysOf([{ pipeId: "cold|lead_found_to_conversation", fromStep: "lead_found", toStep: "conversation", people: 23, spendByDynasty: new Map([["ballad", 14], ["keel", 86]]) }], label, name);
    expect(t).toMatchObject({ fromLabel: "Lead found", toLabel: "Positive reply", people: 23, shareBasis: "spend", scriptsUnavailableReason: null });
    expect(t!.scripts).toEqual([
      { workflowDynastySlug: "keel", workflowName: "Keel", sharePct: 86 },
      { workflowDynastySlug: "ballad", workflowName: "Ballad", sharePct: 14 },
    ]);
  });

  it("a transition from nothing reads from Start; a pipe that spent nothing yet says so", () => {
    const [t] = peopleJourneysOf([{ pipeId: "src|start_to_lead_found", fromStep: null, toStep: "lead_found", people: 0, spendByDynasty: new Map() }], label, name);
    expect(t).toMatchObject({ fromStep: "start", fromLabel: "Start", scripts: [], scriptsUnavailableReason: "no_spend_yet" });
  });
});
