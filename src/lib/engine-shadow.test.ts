import { describe, expect, it } from "vitest";
import {
  EMPTY_EVIDENCE,
  HALF_LIFE_DAYS,
  UPLIFT_CAP,
  engineDayCountsOf,
  enginePlaceOf,
  engineShadowOf,
  fitStrength,
  minusEvidence,
  pipeDailyEvidence,
  placeBeliefs,
  replayFamily,
  replayTotals,
  thompson,
  upliftOf,
  weighEvidence,
  windowValuePerDollar,
  type DayCounts,
  type EngineCandidate,
  type Evidence,
  type ReplayCandidate,
} from "./engine-shadow.js";

/** Evidence with every decision closed (trials = decisions). */
const ev = (decisions: number, outcomes: number, spentUsd: number, trials = decisions): Evidence => ({ decisions, trials, outcomes, spentUsd });

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
  uplift: 1,
  fleet,
  client: EMPTY_EVIDENCE,
  expectedCostPerOutcomeUsd: null,
  defaultRatePct: 1,
  ...over,
});

const day = (d: string, decisions: number, outcomes: number, spentUsd: number): DayCounts => ({ day: d, decisions, outcomes, spentUsd });

describe("evidence per decision day (v10 §8)", () => {
  it("censors like for like: 100 decisions 7 days old on a 10-day leg count for 70 trials (the worked example)", () => {
    const e = weighEvidence([day("2026-10-24", 100, 2, 10)], "2026-10-25", "2026-10-31", 10, 1e9);
    expect(e.trials).toBeCloseTo(70, 5);
    expect(e.outcomes / e.trials).toBeCloseTo(2 / 70, 5);
  });
  it("counts a closed decision in full", () => {
    expect(weighEvidence([day("2026-09-01", 100, 2, 10)], "2026-11-01", "2026-10-31", 10, 1e9).trials).toBeCloseTo(100, 5);
  });
  it("fades old evidence with a half-life", () => {
    const e = weighEvidence([day("2026-09-16", 100, 4, 10)], "2026-10-31", "2026-10-31", 0);
    expect(HALF_LIFE_DAYS).toBe(45);
    expect(e.decisions).toBeCloseTo(50, 5);
    expect(e.outcomes).toBeCloseTo(2, 5);
  });
  it("reads only decisions taken before its day", () => {
    expect(weighEvidence([day("2026-10-20", 100, 4, 10)], "2026-10-20", "2026-10-31", 0).decisions).toBe(0);
  });
  it("takes the client out of the fleet, never below zero", () => {
    expect(minusEvidence(ev(10, 2, 5), ev(4, 3, 1)).outcomes).toBe(0);
    expect(minusEvidence(ev(10, 2, 5), ev(4, 1, 1)).decisions).toBe(6);
  });
});

describe("the daily ledger split", () => {
  it("puts spend, inputs and outcomes on the day the deciding run started; an off-campaign reply on its send's day", () => {
    const book = {
      produced: [
        { outcomeKey: "email_sent", campaignId: "c1", workflowSlug: "w1", occurrences: 10, costUsd: 5, runStartDay: "2026-10-01" },
        { outcomeKey: "conversation", campaignId: null, workflowSlug: null, occurrences: 4, costUsd: 2, runStartDay: "2026-10-09" },
      ],
      noOutput: [{ campaignId: "c1", workflowSlug: "w1", costUsd: 1, runStartDay: "2026-10-02" }],
      consumed: [
        { consumerKey: "email_sent", consumedKey: "lead_found", campaignId: "c1", workflowSlug: "w1", sourceCampaignId: null, sourceWorkflowSlug: null, count: 10, runStartDay: "2026-10-01" },
        { consumerKey: "conversation", consumedKey: "email_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "w1", count: 1, runStartDay: "2026-10-09", sourceRunStartDay: "2026-10-01" },
      ],
    };
    const m = pipeDailyEvidence("conversation", new Set(["c1"]), book, 0.5);
    expect(m.get("c1|w1|2026-10-01")).toMatchObject({ decisions: 10, outcomes: 1, spentUsd: 5.5 });
    expect(m.get("c1|w1|2026-10-02")).toMatchObject({ decisions: 0, outcomes: 0, spentUsd: 1 });
  });
});

describe("branch uplift", () => {
  it("rates a workflow with its best sub-pick over the mix it ran, capped, never below 1", () => {
    expect(upliftOf([{ outcomes: 10, spentUsd: 100 }, { outcomes: 2, spentUsd: 100 }])).toBeCloseTo(0.1 / (12 / 200), 5);
    expect(upliftOf([{ outcomes: 100, spentUsd: 10 }, { outcomes: 0, spentUsd: 1000 }])).toBe(UPLIFT_CAP);
    expect(upliftOf([{ outcomes: 3, spentUsd: 10 }])).toBe(1);
    expect(upliftOf([])).toBe(1);
  });
  it("multiplies the candidate's value in the pick", () => {
    const a = cand("a", "p", ev(20_000, 400, 1000));
    const b = cand("b", "p", ev(20_000, 300, 1000), { uplift: 2 });
    const p = enginePlaceOf({ outcome: "x", outcomeName: "X", consumer: "campaign", consumerName: "Campaign", targetValued: true, seed: "s" }, [a, b], { candidateId: a.id, ref: null, unavailableReason: null });
    expect(p.engineModal?.candidateId).toBe("p::b");
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
});

describe("Thompson on value per dollar", () => {
  const strong = cand("cheap", "email", ev(20_000, 400, 1000));
  const weak = cand("dear", "email", ev(20_000, 200, 2000));
  it("picks the best value per dollar almost always when both are well measured", () => {
    const t = thompson(placeBeliefs([strong, weak]).beliefs, () => 100, "seed");
    expect(t.modalPick).toBe("email::cheap");
    expect(t.shares.get("email::cheap")!).toBeGreaterThan(0.95);
  });
  it("explores a candidate with little data by construction", () => {
    const t = thompson(placeBeliefs([strong, weak, cand("fresh", "email", ev(30, 1, 2))]).beliefs, () => 100, "seed");
    expect(t.shares.get("email::fresh")!).toBeGreaterThan(0.02);
  });
  it("is deterministic per seed", () => {
    const { beliefs } = placeBeliefs([strong, weak, cand("fresh", "email", ev(30, 1, 2))]);
    expect(thompson(beliefs, () => 100, "x").shares).toEqual(thompson(beliefs, () => 100, "x").shares);
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
    expect(p).toMatchObject({ state: "ok", agrees: true });
    expect(p.todayPickSharePct!).toBeGreaterThan(90);
    const shadow = engineShadowOf([p], "2026-10-31T00:00:00Z", "ledger");
    expect(shadow).toMatchObject({ comparable: 1, agreed: 1, status: "ok", model: { halfLifeDays: 45 } });
    const days = engineDayCountsOf([{ orgId: "o", engine: shadow }, { orgId: "o", engine: { ...shadow, status: "failed", places: [] } }]);
    expect(days.get("o")).toMatchObject({ enginePlaces: 1, engineAgreed: 1, engineFailed: 1 });
  });
});

describe("the replay (regret proxy)", () => {
  const window = { sinceDay: "2026-10-01", countedOnDay: "2026-10-31" };
  const rc = (id: string, days: DayCounts[], over: Partial<ReplayCandidate> = {}): ReplayCandidate => ({
    id,
    basePipeId: "email",
    channelName: "Email",
    dynastySlug: id,
    valueAddedUsd: 100,
    uplift: 1,
    expectedCostPerOutcomeUsd: null,
    defaultRatePct: 1,
    maturityDays: 0,
    days,
    ...over,
  });
  const history = (d: number, o: number, s: number) => [day("2026-08-01", d, o, s)];
  it("grades today's split and the Engine's per decision day against the window's best value per dollar", () => {
    const good = rc("good", [...history(20_000, 400, 1000), day("2026-10-10", 100, 2, 5), day("2026-10-20", 100, 2, 5)]);
    const bad = rc("bad", [...history(20_000, 200, 2000), day("2026-10-10", 900, 9, 90), day("2026-10-20", 900, 9, 90)]);
    const f = replayFamily("positive_reply", "Positive reply", [good, bad], true, window, "s", 200);
    expect(f.checkpoints).toBe(2);
    expect(f.bestCandidateId).toBe("good");
    expect(f.todayRegret!).toBeGreaterThan(0.4);
    expect(f.engineRegret!).toBeLessThan(0.1);
    expect(replayTotals([f])).toMatchObject({ families: 1 });
  });
  it("never counts a draw on an ungradable workflow as value lost: it is reported apart", () => {
    const good = rc("good", [...history(20_000, 400, 1000), day("2026-10-10", 200, 4, 10)]);
    const fresh = rc("fresh", [day("2026-10-10", 5, 0, 1)]);
    const f = replayFamily("positive_reply", "Positive reply", [good, fresh], true, window, "s", 200);
    expect(f.graded).toBe(1);
    expect(f.engineRegret).toBe(0);
    expect(f.engineUngradedPct!).toBeGreaterThan(0);
  });
  it("reads the window like for like: a workflow run late is not graded down for its open decisions", () => {
    const late = rc("late", [day("2026-10-28", 100, 1, 10)], { maturityDays: 10 });
    expect(windowValuePerDollar(late, window.sinceDay, window.countedOnDay, true)).toBeCloseTo((100 * (1 / 30)) / 0.1, 5);
  });
  it("names why a family cannot be graded", () => {
    expect(replayFamily("x", "X", [rc("thin", [day("2026-10-10", 5, 0, 1)])], true, window, "s", 50).reason).toBe("no_candidate_graded");
  });
});
