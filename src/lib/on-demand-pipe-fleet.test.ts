import { describe, expect, it } from "vitest";
import { onDemandPipeFigures } from "./on-demand-pipe-fleet.js";

describe("an on-demand pipe's figures (owner 2026-10-11: a sourcing pipe is measured on its OWN runs and the leads it found)", () => {
  const dynastyOfSlug = new Map([
    ["lead-sourcing-scheat", "lead-sourcing-scheat"],
    ["lead-sourcing-scheat-v2", "lead-sourcing-scheat"],
  ]);

  it("rolls each unit's own spend and found leads up to the workflow it runs: cost per lead found", () => {
    const { byDynasty, unattributedLeads } = onDemandPipeFigures({
      legKey: "start_to_lead_found",
      dynastyOfSlug,
      dynasties: ["lead-sourcing-scheat"],
      // A campaign that is no unit of the leg (an outreach campaign of a legacy serve) is counted nowhere.
      centsByCampaign: new Map([["u1", 600], ["u2", 400], ["outreach", 9999]]),
      ranCounts: [
        { campaignId: "u1", ran: 12 },
        { campaignId: "u2", ran: 8 },
        { campaignId: "u3", ran: 5 },
        { campaignId: "not-a-unit", ran: 99 },
      ],
      workflowOfCampaign: new Map([
        ["u1", "lead-sourcing-scheat"],
        ["u2", "lead-sourcing-scheat-v2"],
        ["u3", null],
      ]),
    });
    const f = byDynasty.get("lead-sourcing-scheat")!;
    expect(f.flash).toMatchObject({ spentUsd: 10, outcomes: 20, costPerOutcomeUsd: 0.5 });
    // A 0-day leg judged on 10 leads: 20 found is mature, the mature evidence is the evidence.
    expect(f.isMature).toBe(true);
    expect(f.mature).toMatchObject({ costPerOutcomeUsd: 0.5 });
    expect(unattributedLeads).toBe(5);
  });

  it("a workflow with spend and no lead found, or under the leg's count, is not mature: learning, never a guess", () => {
    const { byDynasty } = onDemandPipeFigures({
      legKey: "start_to_lead_found",
      dynastyOfSlug,
      dynasties: ["lead-sourcing-scheat"],
      centsByCampaign: new Map([["u1", 300]]),
      ranCounts: [{ campaignId: "u1", ran: 3 }],
      workflowOfCampaign: new Map([["u1", "lead-sourcing-scheat"]]),
    });
    expect(byDynasty.get("lead-sourcing-scheat")!.isMature).toBe(false);
  });
});
