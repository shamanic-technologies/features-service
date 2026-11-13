import { describe, expect, it } from "vitest";
import { llmTacticsOf, scriptEngineBoard, templateTacticsOf } from "./script-engine-board.js";
import { outcomeValues, scriptRatings, type ReachGroup } from "./script-value-rating.js";

/** SCRIPT-VALUE-RATING-1113-MON: Monitoring's board, per Engine, through the real Rating rule. */
const g = (scriptDynasty: string, day: string, runs: number, reached: string[], spentUsd: number): ReachGroup => ({ scriptDynasty, day, producedOutcomes: ["message_written"], reachedOutcomes: reached, runs, spentUsd });
const groups = [
  g("message_written/cheap", "2026-11-10", 496, ["message_sent"], 0.992),
  g("message_written/cheap", "2026-11-12", 4, ["message_sent", "conversation"], 0.008),
  g("message_written/dear", "2026-11-12", 488, ["message_sent"], 1.952),
  g("message_written/dear", "2026-11-13", 12, ["message_sent", "conversation"], 0.048),
  g("message_written/retired", "2026-09-01", 50, ["message_sent"], 0.1),
  g("post_published/x", "2026-11-13", 10, [], 1),
];
const values = outcomeValues({
  steps: [
    { fromOutcome: "message_written", toOutcome: "message_sent", consumedUnits: 1000, ledUnits: 990 },
    { fromOutcome: "message_sent", toOutcome: "conversation", consumedUnits: 1000, ledUnits: 15 },
  ],
  anchor: { outcome: "paid_client", valueUsd: 2100 },
  declared: new Map([["conversation", 50]]),
});
const runnable = [
  { id: "1", outcome: "message_written", dynasty: "cheap", version: 3, description: "", code: "", tactics: { llm: { provider: "google", model: "gemini-flash-lite" }, template: "blind-v4" } },
  { id: "2", outcome: "message_written", dynasty: "dear", version: 1, description: "", code: "", tactics: { llms: { writer: { provider: "anthropic", model: "haiku" } }, templates: { writer: "named-v2" } } },
  { id: "3", outcome: "post_published", dynasty: "x", version: 1, description: "", code: "", tactics: {} },
];
let seed = 7;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe("scriptEngineBoard", () => {
  const ratings = scriptRatings({ groups, values });
  const board = scriptEngineBoard({ ratings, values, runnable, groups, today: "2026-11-13", rng, draws: 400 });

  it("groups scripts per Engine, the most-run Engine first, runnable scripts ranked by share of draws", () => {
    expect(board.map((e) => e.outcome)).toEqual(["message_written", "post_published"]);
    const mw = board[0]!;
    expect(mw.runnableScripts).toBe(2);
    expect(mw.scripts.map((s) => s.scriptDynasty)).toEqual([mw.favourite, ...["message_written/cheap", "message_written/dear"].filter((k) => k !== mw.favourite), "message_written/retired"]);
    const shares = mw.scripts.filter((s) => s.runnable).map((s) => s.shareOfDrawsPct!);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    expect(shares[0]).toBeGreaterThanOrEqual(shares[1]!);
  });

  it("keeps the Rating's figures byte for byte (runs, cost per run, score) and a retired script draws nothing", () => {
    const mw = board[0]!;
    for (const row of mw.scripts) {
      const r = ratings.find((x) => x.scriptDynasty === row.scriptDynasty)!;
      expect([row.runs, row.costPerRunUsd, row.valuePerDollar]).toEqual([r.runs, r.costPerRunUsd, r.valuePerDollar]);
    }
    const retired = mw.scripts.find((s) => s.scriptDynasty === "message_written/retired")!;
    expect([retired.runnable, retired.shareOfDrawsPct, retired.runsByDay]).toEqual([false, null, []]);
  });

  it("serves the LLM / template tactics and runs per day of the last 30 days", () => {
    const dear = board[0]!.scripts.find((s) => s.scriptDynasty === "message_written/dear")!;
    expect(dear.llms).toEqual([{ place: "writer", provider: "anthropic", model: "haiku" }]);
    expect(dear.templates).toEqual([{ place: "writer", templateDynastySlug: "named-v2" }]);
    expect(dear.runsByDay).toEqual([{ day: "2026-11-12", runs: 488, spentUsd: 1.952 }, { day: "2026-11-13", runs: 12, spentUsd: 0.048 }]);
  });

  it("an Engine with no runnable script draws nothing and names no favourite", () => {
    const b = scriptEngineBoard({ ratings, values, runnable: [], groups, today: "2026-11-13", rng, draws: 10 });
    expect(b.every((e) => e.favourite === null && e.basis === "no_candidate")).toBe(true);
  });
});

describe("tactics parsing", () => {
  it("reads a single and per-place LLM / template", () => {
    expect(llmTacticsOf({ llm: "deepseek-flash" })).toEqual([{ place: null, provider: null, model: "deepseek-flash" }]);
    expect(templateTacticsOf({ template: "a", templates: { angles: "b" } })).toEqual([{ place: null, templateDynastySlug: "a" }, { place: "angles", templateDynastySlug: "b" }]);
    expect(llmTacticsOf({})).toEqual([]);
  });
});
