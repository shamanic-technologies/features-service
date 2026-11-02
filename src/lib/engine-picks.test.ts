import { describe, expect, it } from "vitest";
import { enginePicksOf } from "./engine-picks.js";
import type { EngineDriveRow } from "./engine-drive-store.js";

const plan = (campaignId: string, computedAt: string) => ({
  campaignId,
  computedAt,
  body: {
    salesFunnelName: `Funnel ${campaignId}`,
    engine: {
      places: [
        {
          outcome: "conversation",
          outcomeName: "Positive reply",
          candidates: [
            { candidateId: "cold|lead_found_to_conversation::keel", channelName: "Cold Email", workflowDynastySlug: "keel", workflowDynastyName: "Keel", pickSharePct: 75 },
            { candidateId: "cold|lead_found_to_conversation::ballad", channelName: "Cold Email", workflowDynastySlug: "ballad", workflowDynastyName: "Ballad", pickSharePct: 25 },
          ],
        },
      ],
    },
  },
});
const drive = (campaignId: string, over: Partial<EngineDriveRow> = {}): EngineDriveRow => ({
  unitCampaignId: `u-${campaignId}`,
  funnelCampaignId: campaignId,
  orgId: "o",
  brandId: "b",
  outcome: "conversation",
  pipeId: "cold|lead_found_to_conversation",
  workflowDynastySlug: "keel",
  serviceDynastySlug: "ballad",
  state: "driving",
  switchedAt: "2026-11-02T05:00:00.000Z",
  rolledBackAt: null,
  guard: { decisions: 0, outcomes: 0, spentUsd: 0, costPerOutcomeUsd: null, serviceCostPerOutcomeUsd: null, serviceBasis: null, verdict: "measuring", outcomeName: "Positive reply", source: "engine_tick_pick" },
  updatedAt: "2026-11-02T08:00:00.000Z",
  ...over,
});

describe("why each one was picked (FACTORY-USER-DASHBOARD-1102)", () => {
  it("names the running workflow, its share of draws and why, newest pick first", () => {
    const picks = enginePicksOf([plan("a", "2026-11-02T06:00:00.000Z"), plan("b", "2026-11-02T08:00:00.000Z")], [drive("a"), drive("b")]);
    expect(picks.map((p) => p.campaignId)).toEqual(["b", "a"]);
    expect(picks[0]).toMatchObject({ campaignName: "Funnel b", outcomeName: "Positive reply", workflowName: "Keel", channelName: "Cold Email", sharePct: 75, state: "running" });
    expect(picks[0]!.why).toBe("Keel took 75% of the Engine's draws: the best expected value per dollar for Positive reply.");
    expect(picks[0]!.why).not.toMatch(/[—–]/);
  });

  it("a rolled-back campaign says the previous choice runs again, until when", () => {
    const [p] = enginePicksOf([plan("a", "2026-11-02T06:00:00.000Z")], [
      drive("a", { state: "rolled_back", guard: { decisions: 60, outcomes: 0, spentUsd: 6, costPerOutcomeUsd: null, serviceCostPerOutcomeUsd: 2, serviceBasis: "unit_before_switch", verdict: "worse", outcomeName: "Positive reply", source: "engine_tick_pick", rollBacks: 1, retryAt: "2026-11-16T07:00:00.000Z" } }),
    ]);
    expect(p).toMatchObject({ state: "rolled_back", retryAt: "2026-11-16T07:00:00.000Z" });
    expect(p!.why).toBe("Keel did worse than the previous choice for Positive reply, so the previous choice runs again until Nov 16.");
  });

  it("lists only campaigns of the given live plans", () => {
    expect(enginePicksOf([plan("a", "2026-11-02T06:00:00.000Z")], [drive("a"), drive("other")]).map((p) => p.campaignId)).toEqual(["a"]);
  });
});
