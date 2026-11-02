import { describe, expect, it } from "vitest";
import { enginesOf, researchPlacesOf, strategySplitsOf } from "./engine-places.js";

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

describe("Research: proposed strategies, a split on the workflows' tactics", () => {
  it("compares the place's workflows following a tactic with those that do not, and proposes only on a conclusion", () => {
    const big = (id: string, outcomes: number) => ({ ...cand(id, 50), fleetDecisions: 1000, fleetOutcomes: outcomes });
    const places = researchPlacesOf([[place("campaign", [big("keel", 40), big("ballad", 5)])]]);
    const tactics = [{ id: "blind", name: "Blind angle", description: "Never names the client." }];
    const [s] = strategySplitsOf(places, new Map([["keel", new Map([["blind", true]])], ["ballad", new Map([["blind", false]])]]), tactics);
    expect(s).toMatchObject({ tacticName: "Blind angle", better: "inside", inside: { workflows: 1, outcomes: 40, ratePct: 4 }, outside: { outcomes: 5, ratePct: 0.5 } });
    // No per-client strata on this read: a strong gap reads signal, never a conclusion, so nothing is proposed.
    expect(s).toMatchObject({ verdict: "signal", proposed: false });
  });

  it("a tactic every candidate follows, or nobody judged, splits nothing", () => {
    const places = researchPlacesOf([[place("campaign", [cand("keel", 50), cand("ballad", 50)])]]);
    expect(strategySplitsOf(places, new Map([["keel", new Map([["x", true]])], ["ballad", new Map([["x", true]])]]), [{ id: "x", name: "X", description: "x" }])).toEqual([]);
  });
});
