import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { internalPipeCountsByDynasty, STEP_REACHED } from "./meeting-leg-fleet.js";
import { CHANNEL_STEP_KEYS } from "./acquisition-channels.js";
import type { EnginePerson } from "./revenue-engine.js";
import { withInternalPipeCounts, type WorkflowProjectionEvidence } from "../routes/workflow-projection.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";

const fleet = {
  perCampaign: [
    { campaignId: "c1", orgId: "o1", brandId: "b1", dynasty: "rhodium", acted: ["b1:l1", "b1:l2", "b1:l3"], reached: ["b1:l2"] },
    { campaignId: "c2", orgId: "o1", brandId: "b1", dynasty: "rhodium", acted: ["b1:l3", "b1:l4"], reached: [] },
    { campaignId: "c3", orgId: "o2", brandId: "b2", dynasty: "rhodium", acted: ["b2:x"], reached: ["b2:x"] },
    { campaignId: "c4", orgId: "o2", brandId: "b2", dynasty: "avior", acted: ["b2:y"], reached: [] },
  ],
};

describe("an internal pipe is measured on the people its campaigns acted on, at every grain", () => {
  it("counts a person once per scope and dynasty", () => {
    expect(internalPipeCountsByDynasty(fleet, () => true)).toEqual(
      new Map([
        ["rhodium", { contacted: 5, reached: 2 }],
        ["avior", { contacted: 1, reached: 0 }],
      ]),
    );
    expect(internalPipeCountsByDynasty(fleet, (c) => c.brandId === "b1").get("rhodium")).toEqual({ contacted: 4, reached: 1 });
  });

  it("replaces the sends (which count nobody) with the ledger's people and outcomes, spend untouched", () => {
    const workflows = [
      { workflowSlug: "rhodium-v16", workflowDynastySlug: "rhodium", status: "active" },
      { workflowSlug: "rhodium", workflowDynastySlug: "rhodium", status: "deprecated" },
      { workflowSlug: "avior", workflowDynastySlug: "avior", status: "active" },
    ] as WorkflowMetadata[];
    const zeroSends = { totalCostInUsdCents: 411, completedRuns: 40, contacted: 0, clicks: 0, replies: 0 };
    const ev: WorkflowProjectionEvidence = {
      workflows,
      crossOrgCostGroups: [],
      crossOrgEmailStats: [
        ["rhodium", { recipientsContacted: 0, recipientsRepliesPositive: 0 }],
        ["rhodium-v16", { recipientsContacted: 0 }],
      ],
      brandGrain: [["rhodium-v16", zeroSends]],
      retiredBrandGrain: [],
      audienceEvidence: [],
      campaignGrain: [["rhodium-v16", zeroSends]],
      retiredCampaignGrain: [],
    } as unknown as WorkflowProjectionEvidence;
    const out = withInternalPipeCounts(ev, fleet, {
      brand: (c) => c.brandId === "b1",
      campaign: (c) => c.campaignId === "c1",
      offer: null,
    });
    const stats = new Map(out.crossOrgEmailStats);
    expect(stats.get("rhodium-v16")).toMatchObject({ recipientsContacted: 5, recipientsRepliesPositive: 2 });
    expect(stats.get("rhodium")).toMatchObject({ recipientsContacted: 0, recipientsRepliesPositive: 0 });
    expect(stats.get("avior")).toMatchObject({ recipientsContacted: 1, recipientsRepliesPositive: 0 });
    expect(out.brandGrain[0][1]).toEqual({ ...zeroSends, contacted: 4, replies: 1, clicks: 0 });
    expect(out.campaignGrain![0][1]).toEqual({ ...zeroSends, contacted: 3, replies: 1, clicks: 0 });
  });
});

describe("every step a pipe can end on has a reading on a person (2026-10-13: Meeting attended / Purchase pipes 502'd)", () => {
  const person = (signals: Record<string, boolean>) => ({ leadId: "l", signals }) as unknown as EnginePerson;
  const read = (step: string, signals: Record<string, boolean>) => {
    const r = (STEP_REACHED as Record<string, ((p: EnginePerson) => boolean) | "acted">)[step];
    return r === "acted" ? "acted" : r(person(signals));
  };

  it("covers every catalogue step but Lead found", () => {
    expect(Object.keys(STEP_REACHED).sort()).toEqual(CHANNEL_STEP_KEYS.filter((k) => k !== "lead_found").sort());
  });

  it("reads Meeting attended on the attended rung, never on a booked meeting", () => {
    expect(read("meeting_attended", { meetingAttended: true })).toBe(true);
    expect(read("meeting_attended", { meeting: true })).toBe(false);
  });

  it("reads Purchase on lead-service's sale, the paid client's signal", () => {
    expect(read("purchase", { closeWin: true })).toBe(true);
    expect(read("purchase", { clicked: true })).toBe(false);
    expect(read("paid_client", { closeWin: true })).toBe(true);
  });
});
