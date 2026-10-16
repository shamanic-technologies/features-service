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
      reusedByCampaign: new Map(),
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
      reusedByCampaign: new Map(),
    });
    expect(byDynasty.get("lead-sourcing-scheat")!.isMature).toBe(false);
  });

  // Owner 2026-10-17 (REUSED-ACQUISITION-COST-1017): a lead keeps the price paid to find it. lead-sourcing-aldhanab
  // served 367 leads an earlier run of the same org had bought ($32.56 of Apollo reveals) for $1.31 of its own spend.
  it("adds what earlier runs paid to find the leads a unit served: the lead keeps its price", () => {
    const { byDynasty, unpricedCampaignIds } = onDemandPipeFigures({
      legKey: "start_to_lead_found",
      dynastyOfSlug: new Map([["lead-sourcing-aldhanab", "lead-sourcing-aldhanab"]]),
      dynasties: ["lead-sourcing-aldhanab"],
      centsByCampaign: new Map([["a41c", 131]]),
      ranCounts: [{ campaignId: "a41c", ran: 367 }],
      workflowOfCampaign: new Map([["a41c", "lead-sourcing-aldhanab"]]),
      reusedByCampaign: new Map([["a41c", { earlierCents: 3256.15, unavailableReason: null }]]),
    });
    const f = byDynasty.get("lead-sourcing-aldhanab")!;
    expect(f.flash!.spentUsd).toBeCloseTo(33.8715, 6);
    expect(f.flash!.costPerOutcomeUsd).toBeCloseTo(33.8715 / 367, 6);
    expect(unpricedCampaignIds).toEqual([]);
  });

  it("a unit whose earlier acquisition cost could not be read prices nothing (never its own spend alone)", () => {
    const { byDynasty, unpricedCampaignIds } = onDemandPipeFigures({
      legKey: "start_to_lead_found",
      dynastyOfSlug,
      dynasties: ["lead-sourcing-scheat"],
      centsByCampaign: new Map([["u1", 600], ["u2", 5]]),
      ranCounts: [
        { campaignId: "u1", ran: 12 },
        { campaignId: "u2", ran: 300 },
      ],
      workflowOfCampaign: new Map([
        ["u1", "lead-sourcing-scheat"],
        ["u2", "lead-sourcing-scheat"],
      ]),
      reusedByCampaign: new Map([["u2", { earlierCents: null, unavailableReason: "apollo_service_unavailable" }]]),
    });
    expect(byDynasty.get("lead-sourcing-scheat")!.flash).toMatchObject({ spentUsd: 6, outcomes: 12, costPerOutcomeUsd: 0.5 });
    expect(unpricedCampaignIds).toEqual(["u2"]);
  });
});
