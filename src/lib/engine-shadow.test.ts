import { describe, expect, it } from "vitest";
import {
  EMPTY_EVIDENCE,
  YOUNG_DUE_SHARE,
  censoredTrials,
  engineDayCountsOf,
  enginePlaceOf,
  engineShadowOf,
  fitStrength,
  minusEvidence,
  placeBeliefs,
  replayFamily,
  replayTotals,
  thompson,
  type EngineCandidate,
  type Evidence,
  type ReplayCandidate,
} from "./engine-shadow.js";

const ev = (decisions: number, outcomes: number, spentUsd: number, mature?: [number, number]): Evidence => ({
  decisions,
  outcomes,
  spentUsd,
  matureDecisions: mature ? mature[0] : decisions,
  matureOutcomes: mature ? mature[1] : outcomes,
});

const cand = (id: string, pipe: string, fleet: Evidence, over: Partial<EngineCandidate> = {}): EngineCandidate => ({
  id: `${pipe}::${id}`,
  basePipeId: pipe,
  pipeId: pipe,
  channelSlug: pipe,
  channelName: pipe,
  legKey: "lead_found_to_positive_reply",
  fromStep: null,
  dynastySlug: id,
  dynastyName: id,
  valueAddedUsd: 100,
  fleet,
  client: EMPTY_EVIDENCE,
  expectedCostPerOutcomeUsd: null,
  defaultRatePct: 1,
  ...over,
});

describe("censored delays (v10 section 8 worked example)", () => {
  it("counts a young decision for the share already due; a mature one in full", () => {
    expect(censoredTrials(ev(100, 2, 10, [0, 0]))).toBe(100 * YOUNG_DUE_SHARE);
    expect(censoredTrials(ev(100, 2, 10))).toBe(100);
    expect(censoredTrials({ ...ev(100, 2, 10), matureDecisions: null })).toBe(100);
  });
  it("takes the client out of the fleet, never below zero", () => {
    expect(minusEvidence(ev(10, 2, 5), ev(4, 3, 1)).outcomes).toBe(0);
    expect(minusEvidence(ev(10, 2, 5), ev(4, 1, 1)).decisions).toBe(6);
  });
});

describe("pooling", () => {
  it("fits a weak pull when siblings spread, a strong one when they agree", () => {
    const spread = fitStrength([{ successes: 10, trials: 1000 }, { successes: 100, trials: 1000 }]);
    const agree = fitStrength([{ successes: 20, trials: 1000 }, { successes: 21, trials: 1000 }]);
    expect(spread).toBeLessThan(agree);
    expect(fitStrength([{ successes: 1, trials: 3 }])).toBe(200);
  });
  it("a workflow with no data takes its pipe's rate with a WIDE belief; a measured one a narrow belief", () => {
    const { beliefs } = placeBeliefs([cand("old", "p", ev(10_000, 300, 1000)), cand("new", "p", EMPTY_EVIDENCE)]);
    const old = beliefs.get("p::old")!;
    const fresh = beliefs.get("p::new")!;
    const mean = (b: typeof old) => b.alpha / (b.alpha + b.beta);
    expect(mean(fresh)).toBeCloseTo(mean(old), 1);
    expect(fresh.alpha + fresh.beta).toBeLessThan(old.alpha + old.beta);
  });
  it("a place nobody priced leaves its candidates unpriced (never picked)", () => {
    const r = placeBeliefs([cand("a", "p", EMPTY_EVIDENCE)]);
    expect(r.unpriced).toEqual(["p::a"]);
    expect(thompson(r.beliefs, () => 1, "s").tickPick).toBeNull();
  });
  it("a pipe that never spent is priced on its stated cost per outcome", () => {
    const r = placeBeliefs([cand("a", "p", EMPTY_EVIDENCE, { expectedCostPerOutcomeUsd: 50 })]);
    expect(r.beliefs.get("p::a")!.costMeanUsd).toBeCloseTo(0.5, 5);
  });
});

describe("Thompson on value per dollar", () => {
  const strong = cand("cheap", "email", ev(20_000, 400, 1000)); // 2%, $0.05/decision => 40 value/$ x 100
  const weak = cand("dear", "email", ev(20_000, 200, 2000)); // 1%, $0.10/decision
  it("picks the best value per dollar almost always when both are well measured", () => {
    const { beliefs } = placeBeliefs([strong, weak]);
    const t = thompson(beliefs, () => 100, "seed");
    expect(t.modalPick).toBe("email::cheap");
    expect(t.shares.get("email::cheap")!).toBeGreaterThan(0.95);
  });
  it("explores a candidate with little data by construction", () => {
    const fresh = cand("fresh", "email", ev(30, 1, 2));
    const { beliefs } = placeBeliefs([strong, weak, fresh]);
    const t = thompson(beliefs, () => 100, "seed");
    expect(t.shares.get("email::fresh")!).toBeGreaterThan(0.02);
  });
  it("is deterministic per seed (one tick, one pick)", () => {
    const { beliefs } = placeBeliefs([strong, weak, cand("fresh", "email", ev(30, 1, 2))]);
    expect(thompson(beliefs, () => 100, "x").shares).toEqual(thompson(beliefs, () => 100, "x").shares);
  });
  it("weighs the value added: a dearer pipe from a later step can win on value per dollar", () => {
    const later = cand("w", "reply", ev(20_000, 400, 2000), { fromStep: "website_visit", valueAddedUsd: 1000 });
    const place = enginePlaceOf({ outcome: "positive_reply", outcomeName: "Positive reply", consumer: "campaign", consumerName: "Campaign", targetValued: true, seed: "s" }, [strong, later], { candidateId: strong.id, ref: null, unavailableReason: null });
    expect(place.engineModal?.candidateId).toBe("reply::w");
    expect(place.agrees).toBe(false);
  });
});

describe("one place served", () => {
  it("states today's pick, the Engine's, agreement and the expected agreement", () => {
    const a = cand("a", "email", ev(20_000, 400, 1000));
    const b = cand("b", "email", ev(20_000, 200, 2000));
    const p = enginePlaceOf({ outcome: "positive_reply", outcomeName: "Positive reply", consumer: "campaign", consumerName: "Campaign", targetValued: true, seed: "s" }, [a, b], {
      candidateId: a.id,
      ref: { candidateId: a.id, pipeId: "email", channelName: "email", workflowDynastySlug: "a", workflowDynastyName: "a" },
      unavailableReason: null,
    });
    expect(p.state).toBe("ok");
    expect(p.agrees).toBe(true);
    expect(p.todayPickSharePct!).toBeGreaterThan(90);
    expect(p.candidates[0]!.isToday).toBe(true);
    const shadow = engineShadowOf([p], "2026-10-31T00:00:00Z", "ledger");
    expect(shadow).toMatchObject({ comparable: 1, agreed: 1, status: "ok" });
    const days = engineDayCountsOf([{ orgId: "o", engine: shadow }, { orgId: "o", engine: { ...shadow, status: "failed", places: [] } }]);
    expect(days.get("o")).toMatchObject({ enginePlaces: 1, engineAgreed: 1, engineFailed: 1 });
  });
  it("no candidate = a not-yet, never a failure", () => {
    const p = enginePlaceOf({ outcome: "x", outcomeName: "X", consumer: "campaign", consumerName: "Campaign", targetValued: true, seed: "s" }, [], { candidateId: null, ref: null, unavailableReason: "workflow_ranking_not_computed_yet" });
    expect(p.state).toBe("no_candidate");
    expect(p.agrees).toBeNull();
  });
});

describe("the replay (regret proxy)", () => {
  const period = (decisions: number, outcomes: number, spentUsd: number) => ({ decisions, outcomes, spentUsd });
  const rc = (id: string, asOf: Evidence, perPeriod: ReturnType<typeof period>): ReplayCandidate => ({
    id,
    basePipeId: "email",
    channelName: "Email",
    dynastySlug: id,
    valueAddedUsd: 100,
    expectedCostPerOutcomeUsd: null,
    defaultRatePct: 1,
    asOf: [asOf, asOf],
    period: [perPeriod, perPeriod],
  });
  it("grades today's split and the Engine's against the window's best value per dollar", () => {
    // Today ran mostly the weaker one; the evidence already said the other was better.
    const good = rc("good", ev(20_000, 400, 1000), period(100, 4, 5));
    const bad = rc("bad", ev(20_000, 200, 2000), period(900, 9, 90));
    const f = replayFamily("positive_reply", "Positive reply", [good, bad], true, "s", 200);
    expect(f.bestCandidateId).toBe("good");
    expect(f.todayRegret!).toBeGreaterThan(0.5);
    expect(f.engineRegret!).toBeLessThan(0.1);
    expect(f.regretGain!).toBeGreaterThan(0.4);
    expect(replayTotals([f])).toMatchObject({ families: 1 });
  });
  it("names why a family cannot be graded", () => {
    const thin = rc("thin", ev(5, 0, 1), period(5, 0, 1));
    expect(replayFamily("x", "X", [thin], true, "s", 50).reason).toBe("no_candidate_graded");
  });
});
