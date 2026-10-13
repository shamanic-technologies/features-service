import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {} }));
import { executableDynasties } from "./public-stats-clients.js";
import { legAssignmentVerdict } from "./workflow-leg-assignments.js";

const assigned = { state: "active" as const, decidedBy: "workflow-service", decidedAt: "2026-10-10T00:00:00.000Z" };

describe("executableDynasties", () => {
  it("a dynasty runs only when one version is active on BOTH status axes", () => {
    const set = executableDynasties([
      { workflowDynastySlug: "lyonesse", status: "deprecated", workflowDynastyStatus: "active" },
      { workflowDynastySlug: "lyonesse", status: "active", workflowDynastyStatus: "active" },
      // RANKING-RETIRED-SELECTABLE-1013: every version deprecated, lineage still active -> 410 on execute.
      { workflowDynastySlug: "allegro", status: "deprecated", workflowDynastyStatus: "active" },
      { workflowDynastySlug: "allegro", status: "deprecated", workflowDynastyStatus: "active" },
      { workflowDynastySlug: "camellia", status: "active", workflowDynastyStatus: "deprecated" },
    ]);
    expect([...set]).toEqual(["lyonesse"]);
  });
});

describe("legAssignmentVerdict", () => {
  it("assigned active and runnable is selectable", () => {
    expect(legAssignmentVerdict(assigned as never, "Website visit", true)).toMatchObject({ state: "active", selectable: true, reason: null });
  });

  it("assigned active with no runnable version is NOT selectable and says why", () => {
    const v = legAssignmentVerdict(assigned as never, "Website visit", false);
    expect(v).toMatchObject({ state: "active", selectable: false });
    expect(v.reason).toMatch(/no version that can run/);
  });
});
