import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { projectFromEvidence, type WorkflowProjectionEvidence } from "./workflow-projection.js";

// ONE brand: `wf-a` is active; `wf-old` is a RETIRED dynasty the brand still spent on and got replies
// from. The retired lineage must appear with its evidence (so the rows sum to the brand's 3 replies) and
// must never be put forward — it is the cheapest row by far, which is exactly what makes the test bite.
const evidence: WorkflowProjectionEvidence = {
  workflows: [
    { id: "1", workflowSlug: "wf-a", workflowDynastySlug: "wf-a", workflowDynastyName: "A", status: "active" },
    { id: "2", workflowSlug: "wf-old", workflowDynastySlug: "wf-old", workflowDynastyName: "Old", status: "deprecated" },
  ] as never,
  crossOrgCostGroups: [{ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "10000", runCount: 5 }] as never,
  crossOrgEmailStats: [["wf-a", { recipientsContacted: 100, recipientsClicked: 10, recipientsRepliesPositive: 4 }]],
  brandGrain: [["wf-a", { totalCostInUsdCents: 8000, completedRuns: 4, contacted: 80, clicks: 8, replies: 2 }]],
  retiredBrandGrain: [["wf-old", { totalCostInUsdCents: 100, completedRuns: 1, contacted: 10, clicks: 1, replies: 1 }]],
  audienceEvidence: [],
};

const ECON = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 50,
  visitToMeetingPct: 5,
  meetingToClosePct: 25,
  visitToClosePct: 1,
  visitToSignupPct: 10,
  signupToPaidClientPct: 10,
} as never;

function project(e: WorkflowProjectionEvidence) {
  return projectFromEvidence({
    featureSlug: "f",
    objective: "meeting-booked",
    goal: "meetingBooked",
    singleStepGoal: null,
    formSubmissionGoal: false,
    evidence: e,
    economics: ECON,
  });
}

describe("a RETIRED lineage gets a row that adds up and is never put forward", () => {
  it("states the retired evidence, so the brand rows sum to the brand's replies", () => {
    const body = project(evidence);
    const brandRows = body.rows.filter((r) => r.audienceId === null);
    const sum = brandRows.reduce((acc, r) => acc + (r.estimatesByGrain.brand?.evidence.observedPositiveReplies ?? 0), 0);
    expect(sum).toBe(3);
    const retired = brandRows.find((r) => r.workflow.workflowDynastySlug === "wf-old");
    expect(retired?.retired).toBe(true);
    expect(retired?.estimatesByGrain.brand?.evidence.spentUsd).toBe(1);
  });

  it("is unrankable and never recommended, though its evidence is the cheapest on the page", () => {
    const body = project(evidence);
    const retired = body.rows.find((r) => r.workflow.workflowDynastySlug === "wf-old");
    expect(retired?.resolved.costPerOutcomeUsd).toBeNull();
    expect(body.recommendedWorkflowDynastySlug).toBe("wf-a");
  });

  it("a snapshot without retired lineages reads byte-identically to before", () => {
    const { retiredBrandGrain: _drop, ...legacy } = evidence;
    const body = project(legacy);
    expect(body.rows.some((r) => r.retired)).toBe(false);
    expect(body.rows.filter((r) => r.audienceId === null).map((r) => r.workflow.workflowDynastySlug)).toEqual(["wf-a"]);
  });
});
