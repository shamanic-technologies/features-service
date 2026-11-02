import { describe, expect, it } from "vitest";
import { enginesOf, researchPlacesOf } from "./engine-places.js";

const cand = (id: string, share: number | null, rate = 1) => ({
  candidateId: `cold|lead_found_to_conversation::${id}`, channelName: "Cold Email", workflowDynastySlug: id, workflowDynastyName: id.toUpperCase(),
  pickSharePct: share, rateMeanPct: rate, costPerDecisionMeanUsd: 0.1, fleetDecisions: 100, fleetOutcomes: 2,
});
const place = (consumer: string, cands: ReturnType<typeof cand>[]) => ({ outcome: "conversation", outcomeName: "Positive reply", consumer, consumerName: consumer, candidates: cands });

describe("Research: the Engines' places fleet-wide (FACTORY-USER-DASHBOARD-1102)", () => {
  it("averages each candidate's share over every campaign holding the place, a missing candidate counting 0", () => {
    const [p] = researchPlacesOf([[place("campaign", [cand("keel", 100)])], [place("campaign", [cand("keel", 90), cand("ballad", 10)])]]);
    expect(p).toMatchObject({ campaigns: 2, clearWinner: true, favourite: { workflowName: "KEEL", chancePct: 95 } });
    expect(p!.candidates.map((c) => [c.workflowDynastySlug, c.sharePct])).toEqual([["keel", 95], ["ballad", 5]]);
  });

  it("no clear winner under 90%; one Engine lists every caller with its favourite", () => {
    const places = researchPlacesOf([[place("campaign", [cand("keel", 60), cand("ballad", 40)]), place("meeting_booked", [cand("ballad", 100)])]]);
    expect(places.find((p) => p.consumer === "campaign")!.clearWinner).toBe(false);
    expect(enginesOf(places)).toEqual([{ outcome: "conversation", outcomeName: "Positive reply", callers: [{ consumer: "campaign", consumerName: "campaign", best: "KEEL" }, { consumer: "meeting_booked", consumerName: "meeting_booked", best: "BALLAD" }] }]);
  });
});
