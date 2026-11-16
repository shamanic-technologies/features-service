import { describe, expect, it } from "vitest";
import { outcomeValues, scriptRatings, pickScript, strongestOf, creditOf, rehomeGroups, applyReports, applyMerges, askedRatings, MIN_CONSUMED_UNITS, type ReachGroup, type StepRate } from "./script-value-rating.js";

/**
 * SCRIPT-VALUE-RATING-1113 (owner 2026-11-13): a script run is credited the value of the strongest outcome its chain
 * reached; values flow down from the offer's lifetime revenue through the measured one-step rates.
 * Worked example = the owner's: two writers at the same Engine, 500 runs each, 4 against 12 interested leads.
 */
const step = (fromOutcome: string, toOutcome: string, consumedUnits: number, ledUnits: number): StepRate => ({ fromOutcome, toOutcome, consumedUnits, ledUnits });
const STEPS = [
  step("message_written", "email_sent", 1000, 990),
  step("email_sent", "lead_interested", 1000, 15),
  step("lead_interested", "meeting_booked", 100, 30),
  step("meeting_booked", "paid_client", 50, 10),
];
const LTR = 2100;

describe("outcomeValues", () => {
  it("flows down from the lifetime revenue, one measured step at a time", () => {
    const v = outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("paid_client")).toMatchObject({ valueUsd: 2100, source: "anchor", via: null });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 420, source: "measured", via: { toOutcome: "paid_client", share: 0.2 } });
    expect(v.get("lead_interested")!.valueUsd).toBeCloseTo(126, 6);
    expect(v.get("email_sent")!.valueUsd).toBeCloseTo(1.89, 6);
    expect(v.get("message_written")!.valueUsd).toBeCloseTo(1.8711, 6);
  });

  it("takes the best next outcome, not the first", () => {
    const v = outcomeValues({ steps: [...STEPS, step("lead_interested", "paid_client", 100, 10)], anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("lead_interested")).toMatchObject({ valueUsd: 210, via: { toOutcome: "paid_client", share: 0.1 } });
  });

  it("a step the ledger cannot measure takes the declared value; what is above it flows from that", () => {
    const steps = STEPS.filter((s) => s.toOutcome !== "paid_client");
    const v = outcomeValues({ steps, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map([["meeting_booked", 300]]) });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 300, source: "declared", via: null });
    expect(v.get("lead_interested")).toMatchObject({ valueUsd: 90, source: "measured" });
  });

  it("a step measured on too few Units is not a rate", () => {
    const thin = [step("meeting_booked", "paid_client", MIN_CONSUMED_UNITS - 1, MIN_CONSUMED_UNITS - 1)];
    const v = outcomeValues({ steps: thin, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map([["meeting_booked", 300]]) });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 300, source: "declared" });
  });

  it("an outcome nothing links to a valued one is worth nothing, never guessed", () => {
    const v = outcomeValues({ steps: [step("post_drafted", "post_published", 100, 90)], anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("post_drafted")).toBeUndefined();
  });

  it("a loop between two outcomes settles, and no lifetime revenue values nothing", () => {
    const loop = [...STEPS, step("lead_interested", "email_sent", 100, 100), step("email_sent", "email_sent", 100, 100)];
    const v = outcomeValues({ steps: loop, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("lead_interested")!.valueUsd).toBeCloseTo(126, 6);
    expect(outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: null }, declared: new Map() }).size).toBe(0);
  });
});

const VALUES = outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
const g = (scriptDynasty: string, runs: number, reached: string[], spentUsd: number | null, produced = ["message_written"]): ReachGroup => ({ scriptDynasty, day: "2026-11-10", producedOutcomes: produced, reachedOutcomes: reached, runs, spentUsd });
const GROUPS = [
  g("message_written/flash_lite", 496, ["email_sent"], 0.992),
  g("message_written/flash_lite", 4, ["email_sent", "lead_interested"], 0.008),
  g("message_written/haiku", 488, ["email_sent"], 1.952),
  g("message_written/haiku", 12, ["email_sent", "lead_interested"], 0.048),
];

describe("scriptRatings", () => {
  it("the strongest outcome of a run is the most valued one it made or reached", () => {
    expect(strongestOf(g("x/y", 1, ["email_sent", "lead_interested"], 0), VALUES)).toEqual({ outcome: "lead_interested", valueUsd: VALUES.get("lead_interested")!.valueUsd });
    expect(strongestOf(g("x/y", 1, [], 0, []), VALUES)).toEqual({ outcome: null, valueUsd: 0 });
  });

  it("a run is credited what it reached beyond its own Unit; led nowhere further = nothing", () => {
    expect(creditOf(g("x/y", 1, ["email_sent", "lead_interested"], 0), VALUES).creditUsd).toBeCloseTo(126 - 1.8711, 6);
    expect(creditOf(g("x/y", 1, [], 0), VALUES)).toEqual({ outcome: null, creditUsd: 0 });
    expect(creditOf(g("x/y", 1, ["email_sent"], 0, []), VALUES)).toMatchObject({ outcome: "email_sent" });
  });

  it("the owner's example: same Engine, 4 against 12 interested leads, twice the price: the dearer writer wins", () => {
    const rows = scriptRatings({ groups: GROUPS, values: VALUES });
    const cheap = rows.find((r) => r.scriptDynasty === "message_written/flash_lite")!;
    const dear = rows.find((r) => r.scriptDynasty === "message_written/haiku")!;
    expect(cheap).toMatchObject({ outcome: "message_written", runs: 500, spentUsd: 1, costPerRunUsd: 0.002 });
    expect(cheap.reached.map((r) => [r.outcome, r.runs])).toEqual([["lead_interested", 4], ["email_sent", 496]]);
    const own = 1.8711;
    expect(cheap.valuePerRunUsd).toBeCloseTo((4 * (126 - own) + 496 * (1.89 - own)) / 500, 6);
    expect(dear.valuePerRunUsd).toBeCloseTo((12 * (126 - own) + 488 * (1.89 - own)) / 500, 6);
    expect(Math.round(cheap.valuePerDollar!)).toBe(506);
    expect(Math.round(dear.valuePerDollar!)).toBe(749);
    expect(dear.valuePerDollar!).toBeGreaterThan(cheap.valuePerDollar!);
    expect(rows[0]!.scriptDynasty).toBe("message_written/haiku");
  });

  it("a script whose spend is not served has no value per dollar, with the reason", () => {
    const [row] = scriptRatings({ groups: [g("message_written/haiku", 10, ["email_sent"], null)], values: VALUES });
    expect(row).toMatchObject({ spentUsd: null, costPerRunUsd: null, valuePerDollar: null, valuePerDollarUnavailableReason: "spend_not_served" });
  });

  it("a script that ran for free is not infinitely good: no figure", () => {
    const [row] = scriptRatings({ groups: [g("message_written/haiku", 10, ["email_sent"], 0)], values: VALUES });
    expect(row).toMatchObject({ valuePerDollar: null, valuePerDollarUnavailableReason: "no_spend" });
  });
});

describe("pickScript", () => {
  const rng = () => {
    let s = 42;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  const candidates = ["message_written/flash_lite", "message_written/haiku", "message_written/new_one"];

  it("draws the better value per dollar most of the time, and still tries the others", () => {
    const rows = scriptRatings({ groups: GROUPS, values: VALUES });
    const r = rng();
    const tally = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const p = pickScript({ outcome: "message_written", candidates, ratings: rows, values: VALUES, rng: r });
      tally.set(p.scriptDynasty!, (tally.get(p.scriptDynasty!) ?? 0) + 1);
    }
    expect(tally.get("message_written/haiku")!).toBeGreaterThan(tally.get("message_written/flash_lite")!);
    expect(tally.get("message_written/new_one") ?? 0).toBeGreaterThan(0);
  });

  it("a new script is explored against an incumbent with thousands of runs and rare outcomes (prod 2026-11-13: 0 picks in 50)", () => {
    const groups = [g("email_sent/incumbent", 13726, [], 520, ["email_sent"]), g("email_sent/incumbent", 5, ["lead_interested"], 2, ["email_sent"])];
    const rows = scriptRatings({ groups, values: VALUES });
    const r = rng();
    let fork = 0;
    for (let i = 0; i < 1000; i++) if (pickScript({ outcome: "email_sent", candidates: ["email_sent/incumbent", "email_sent/fork"], ratings: rows, values: VALUES, rng: r }).scriptDynasty === "email_sent/fork") fork++;
    expect(fork).toBeGreaterThan(150);
    expect(fork).toBeLessThan(600);
  });

  it("two new scripts start from what the Engine's other scripts showed, and both get picked", () => {
    const rows = scriptRatings({ groups: GROUPS, values: VALUES });
    const r = rng();
    const tally = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const p = pickScript({ outcome: "message_written", candidates: ["message_written/new_a", "message_written/new_b"], ratings: rows, values: VALUES, rng: r });
      expect(p.basis).toBe("value_per_dollar");
      tally.set(p.scriptDynasty!, (tally.get(p.scriptDynasty!) ?? 0) + 1);
    }
    expect(tally.get("message_written/new_a")!).toBeGreaterThan(40);
    expect(tally.get("message_written/new_b")!).toBeGreaterThan(40);
  });

  it("nothing known at the Engine at all: equals are drawn, never the alphabet", () => {
    const r = rng();
    const tally = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const p = pickScript({ outcome: "brand_new", candidates: ["brand_new/a", "brand_new/b"], ratings: [], values: VALUES, rng: r });
      tally.set(p.scriptDynasty!, (tally.get(p.scriptDynasty!) ?? 0) + 1);
    }
    expect(tally.get("brand_new/a")!).toBeGreaterThan(40);
    expect(tally.get("brand_new/b")!).toBeGreaterThan(40);
  });

  it("with no value anywhere the cheapest per run goes first (today's behaviour)", () => {
    const rows = scriptRatings({ groups: GROUPS, values: new Map() });
    const p = pickScript({ outcome: "message_written", candidates: candidates.slice(0, 2), ratings: rows, values: new Map(), rng: rng() });
    expect(p).toMatchObject({ scriptDynasty: "message_written/flash_lite", basis: "cost_only" });
  });

  it("no candidate = no pick, with the reason", () => {
    expect(pickScript({ outcome: "message_written", candidates: [], ratings: [], values: VALUES, rng: rng() })).toMatchObject({ scriptDynasty: null, basis: "no_candidate" });
  });
});

describe("rehomeGroups", () => {
  it("a script re-homed under another outcome keeps its runs; an ambiguous or retired name keeps its own keys", () => {
    const groups = [g("conversation/dy_follow_up_due", 3, [], 1), g("old/dy_twice", 1, [], 1), g("gone/dy_retired", 1, [], 1)];
    const out = rehomeGroups(groups, ["lead_interested/dy_follow_up_due", "a/dy_twice", "b/dy_twice"]);
    expect(out.map((x) => x.scriptDynasty)).toEqual(["lead_interested/dy_follow_up_due", "old/dy_twice", "gone/dy_retired"]);
  });
});

describe("applyReports", () => {
  it("a reported run is worth nothing, its cost kept; the same script loses its lead", () => {
    const groups = [g("message_written/haiku", 12, ["email_sent", "lead_interested"], 0.048), g("message_written/haiku", 488, ["email_sent"], 1.952)];
    const reported = { scriptDynasty: "message_written/haiku", day: "2026-11-10", producedOutcomes: ["message_written"], reachedOutcomes: ["lead_interested", "email_sent"], spentUsd: 0.004 };
    const before = scriptRatings({ groups, values: VALUES })[0]!;
    const after = scriptRatings({ groups: applyReports(groups, [reported, reported, reported]), values: VALUES })[0]!;
    expect(after.runs).toBe(500);
    expect(after.spentUsd).toBeCloseTo(before.spentUsd!, 6);
    expect(after.reached.find((r) => r.outcome === "lead_interested")!.runs).toBe(9);
    expect(after.valueUsd).toBeCloseTo(before.valueUsd - 3 * (126 - 1.8711), 4);
  });

  it("a decision the groups do not hold changes nothing, and the input is left as it was", () => {
    const groups = [g("message_written/haiku", 1, ["email_sent"], 0.004)];
    const out = applyReports(groups, [{ scriptDynasty: "message_written/other", day: "2026-11-10", producedOutcomes: [], reachedOutcomes: [], spentUsd: 1 }, { scriptDynasty: "message_written/haiku", day: "2026-11-10", producedOutcomes: ["message_written"], reachedOutcomes: ["email_sent"], spentUsd: 0.004 }, { scriptDynasty: "message_written/haiku", day: "2026-11-10", producedOutcomes: ["message_written"], reachedOutcomes: ["email_sent"], spentUsd: 0.004 }]);
    expect(out.reduce((n, x) => n + x.runs, 0)).toBe(1);
    expect(groups[0]!.runs).toBe(1);
  });
});

/**
 * ONE-WRITER-N-MODELS-1116 (owner 2026-11-16): the model is picked per asking script, cascading to the asking Engine,
 * then to the model alone. Completions of two models asked by writers of Message written (and of another Engine).
 */
describe("the pick of an asked script (ONE-WRITER-N-MODELS-1116)", () => {
  const seeded = () => {
    let s = 7;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  const HAIKU = "llm_completion/dy_claude_haiku";
  const OPUS = "llm_completion/dy_claude_opus";
  const MODELS = [HAIKU, OPUS];
  // A completion asked by a writer: its own Unit, then the message, the send and sometimes an interested lead.
  const c = (model: string, askedBy: string | null, runs: number, interested: number, costPerRun: number): ReachGroup[] => [
    { scriptDynasty: model, day: "2026-11-15", producedOutcomes: ["llm_completion"], reachedOutcomes: ["message_written", "email_sent"], runs: runs - interested, spentUsd: (runs - interested) * costPerRun, askedBy },
    { scriptDynasty: model, day: "2026-11-15", producedOutcomes: ["llm_completion"], reachedOutcomes: ["message_written", "email_sent", "lead_interested"], runs: interested, spentUsd: interested * costPerRun, askedBy },
  ];
  const FREE_OFFER = "message_written/dy_free_offer";
  const THREE_LINES = "message_written/dy_three_line_reply";
  // Free offer: Haiku leads (10 vs 1 interested in 1,000); three-line reply: Opus leads (12 vs 1). Same cost per run.
  // Another Engine's writer (a post) asks Opus far more often and well: the model alone (fleet) leans to Opus.
  const GROUPS: ReachGroup[] = [
    ...c(HAIKU, FREE_OFFER, 1000, 10, 0.002),
    ...c(OPUS, FREE_OFFER, 1000, 1, 0.002),
    ...c(HAIKU, THREE_LINES, 300, 1, 0.002),
    ...c(OPUS, THREE_LINES, 300, 12, 0.002),
    ...c(HAIKU, "post_written/dy_thread", 5000, 5, 0.002),
    ...c(OPUS, "post_written/dy_thread", 5000, 100, 0.002),
  ];
  const ratings = scriptRatings({ groups: GROUPS, values: VALUES });
  const asked = askedRatings({ groups: GROUPS, values: VALUES });
  const tally = (by: string | null, n = 400): Map<string, number> => {
    const r = seeded();
    const t = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const p = pickScript({ outcome: "llm_completion", candidates: MODELS, ratings, values: VALUES, rng: r, asked: by ? { by, ratings: asked } : null });
      t.set(p.scriptDynasty!, (t.get(p.scriptDynasty!) ?? 0) + 1);
    }
    return t;
  };

  it("two writers of Message written settle on two different models, each on its own history", () => {
    const free = tally(FREE_OFFER);
    const three = tally(THREE_LINES);
    expect(free.get(HAIKU) ?? 0).toBeGreaterThan(free.get(OPUS) ?? 0);
    expect(three.get(OPUS) ?? 0).toBeGreaterThan(three.get(HAIKU) ?? 0);
  });

  it("a writer with no history of its own is served its Engine's ranking, not the model's fleet ranking", () => {
    // Message written's writers together: Haiku 11 interested in 1,300, Opus 13 in 1,300 = near even; make the Engine
    // lean to Haiku by a writer with Haiku far ahead and no fleet weight elsewhere.
    const groups = [...GROUPS, ...c(HAIKU, "message_written/dy_story", 2000, 40, 0.002), ...c(OPUS, "message_written/dy_story", 2000, 2, 0.002)];
    const rows = scriptRatings({ groups, values: VALUES });
    const at = askedRatings({ groups, values: VALUES });
    const fleetHaiku = rows.find((r) => r.scriptDynasty === HAIKU)!.valuePerDollar!;
    const fleetOpus = rows.find((r) => r.scriptDynasty === OPUS)!.valuePerDollar!;
    expect(fleetOpus).toBeGreaterThan(fleetHaiku);
    const r = seeded();
    const t = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const p = pickScript({ outcome: "llm_completion", candidates: MODELS, ratings: rows, values: VALUES, rng: r, asked: { by: "message_written/dy_brand_new", ratings: at } });
      t.set(p.scriptDynasty!, (t.get(p.scriptDynasty!) ?? 0) + 1);
    }
    expect(t.get(HAIKU) ?? 0).toBeGreaterThan(t.get(OPUS) ?? 0);
    expect(t.get(OPUS) ?? 0).toBeGreaterThan(0);
  });

  it("an asking Engine with no history at all is served the model's fleet ranking", () => {
    const t = tally("brand_new_engine/dy_first");
    expect(t.get(OPUS) ?? 0).toBeGreaterThan(t.get(HAIKU) ?? 0);
  });

  it("a pick with no askedBy answers exactly as before (same draws, same scores)", () => {
    const a = pickScript({ outcome: "llm_completion", candidates: MODELS, ratings, values: VALUES, rng: seeded() });
    const b = pickScript({ outcome: "llm_completion", candidates: MODELS, ratings, values: VALUES, rng: seeded(), asked: null });
    expect(b).toEqual(a);
    // The pre-cascade rule, recomputed by hand for the first candidate: alpha = own runs + prior x the Engine's mix.
    expect(a.candidates.map((x) => x.runs).sort()).toEqual([6300, 6300]);
  });
});

describe("applyMerges (ONE-WRITER-N-MODELS-1116)", () => {
  const ABSORBED = "email_sent/dy_cold_email_signed_sender_client_brand__claude_haiku__cresn";
  const WRITER = "message_written/dy_free_offer";
  const SENDER = "email_sent/dy_cold_email_signed_sender_client_brand";
  const MODEL = "llm_completion/dy_claude_haiku";
  const MERGES = [
    { absorbed: ABSORBED, survivor: WRITER, askedBy: SENDER },
    { absorbed: ABSORBED, survivor: MODEL, askedBy: WRITER },
    { absorbed: ABSORBED, survivor: MODEL, askedBy: WRITER },
  ];
  const groups = [g(ABSORBED, 488, ["lead_interested"], 1.952, ["email_sent"]), g("message_written/untouched", 3, [], 0.01)];

  it("a per-model copy's decisions count for each survivor at its place; a repeated merge row counts once", () => {
    const out = applyMerges(groups, MERGES);
    expect(out.map((x) => [x.scriptDynasty, x.askedBy ?? null, x.runs])).toEqual([
      [WRITER, SENDER, 488],
      [MODEL, WRITER, 488],
      ["message_written/untouched", null, 3],
    ]);
    expect(out[0]!.producedOutcomes).toEqual(["email_sent"]);
  });

  it("the merged history rates the writer under its sender and the model under its writer", () => {
    const at = askedRatings({ groups: applyMerges(groups, MERGES), values: VALUES });
    expect(at.byScript.get(SENDER)!.map((r) => [r.scriptDynasty, r.runs])).toEqual([[WRITER, 488]]);
    expect(at.byScript.get(WRITER)!.map((r) => [r.scriptDynasty, r.runs])).toEqual([[MODEL, 488]]);
    expect(at.byEngine.get("message_written")!.map((r) => r.scriptDynasty)).toEqual([MODEL]);
    expect(at.byEngine.get("email_sent")!.map((r) => r.scriptDynasty)).toEqual([WRITER]);
  });

  it("no merge = the groups unchanged", () => {
    expect(applyMerges(groups, [])).toEqual(groups);
  });
});
