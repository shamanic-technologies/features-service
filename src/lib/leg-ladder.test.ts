import { describe, it, expect } from "vitest";
import { dynastyPriceFromLadder } from "./leg-ladder.js";

const row = (measured: boolean | undefined, cost: number | null) => ({
  audienceId: null,
  workflow: { workflowDynastySlug: "wf" },
  ...(measured === undefined ? {} : { measured }),
  resolved: { grain: "crossOrg", costPerOutcomeUsd: cost },
});

describe("dynastyPriceFromLadder", () => {
  it("reads the dynasty's brand row price", () => {
    expect(dynastyPriceFromLadder(200, { rows: [row(true, 44.72)] }, "wf")).toEqual({ costPerOutcomeUsd: 44.72, unpricedReason: null });
  });
  it("a workflow with no evidence on the leg holds an explore allowance, never a price", () => {
    // 2026-10-05: reply-campaign workflows read $0.155 per visit on the website-visit ladder.
    expect(dynastyPriceFromLadder(200, { rows: [row(false, 0.155)] }, "wf")).toEqual({
      costPerOutcomeUsd: null,
      unpricedReason: "workflow_unmeasured_on_leg",
    });
  });
  it("absent dynasty or refused ladder is a named reason", () => {
    expect(dynastyPriceFromLadder(200, { rows: [] }, "wf").unpricedReason).toBe("workflow_not_on_ladder");
    expect(dynastyPriceFromLadder(409, { reason: "several_offers" }, "wf").unpricedReason).toBe("several_offers");
  });
});
