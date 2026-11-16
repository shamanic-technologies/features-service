import { describe, expect, it } from "vitest";
import { isOwnCombination, servedByScript, servedLlmsOf, splitByServedModel, statedLlmsOf } from "./served-model.js";
import { scriptRatings, type OutcomeValue, type ReachGroup } from "./script-value-rating.js";
import { scriptEngineBoard } from "./script-engine-board.js";

// chat-service's cost-name catalogue, as served (exact names, never parsed).
const COST_NAMES = new Map([
  ["moonshot-kimi-k2.6-tokens-output", "kimi-k2"],
  ["moonshot-kimi-k2.6-tokens-input", "kimi-k2"],
  ["openai-gpt-6.1-terra-tokens-output", "gpt-terra"],
  ["openai-gpt-6.1-terra-tokens-input", "gpt-terra"],
  ["zai-glm-5.3-flash-tokens-output", "glm-flash"],
  ["google-flash-lite-3.5-tokens-output", "gemini-flash-lite"],
  ["anthropic-haiku-5.5-tokens-output", "claude-haiku"],
]);

const KIMI = "email_sent/dy_cold__kimi_k2__crion";
const BASE = "email_sent/dy_cold";
const values: Map<string, OutcomeValue> = new Map([
  ["paid_client", { outcome: "paid_client", valueUsd: 1000, source: "anchor", via: null }],
  ["conversation", { outcome: "conversation", valueUsd: 50, source: "measured", via: null }],
]);
const g = (scriptDynasty: string, day: string, runs: number, writerCostNames: string[] | null, reached: string[] = [], spentUsd = runs * 0.01): ReachGroup => ({
  scriptDynasty,
  day,
  producedOutcomes: ["email_sent"],
  reachedOutcomes: reached,
  runs,
  spentUsd,
  writerCostNames,
});

const stated = statedLlmsOf(
  [
    { key: KIMI, llms: [{ model: "kimi-k2" }] },
    { key: BASE, llms: [{ model: "glm-flash" }] },
  ],
  (name) => name,
);

describe("SERVED-MODEL-1116: the model that actually wrote is the one credited", () => {
  it("a run whose ledger names Terra while its script states Kimi is credited to Terra-written output, never to the Kimi combination", () => {
    const groups = [
      g(KIMI, "2026-11-14", 100, ["moonshot-kimi-k2.6-tokens-input", "moonshot-kimi-k2.6-tokens-output"]),
      // Kimi out of credit since 2026-11-14 15:35: chat-service fell back to GPT Terra; a Flash-Lite helper call billed too.
      g(KIMI, "2026-11-15", 400, ["openai-gpt-6.1-terra-tokens-output", "google-flash-lite-3.5-tokens-output"], ["conversation"]),
    ];
    const { own, otherModels } = splitByServedModel({ groups, stated, llmOfCostName: COST_NAMES });
    expect(own).toEqual([groups[0]]);
    expect(otherModels).toEqual([
      { scriptDynasty: KIMI, servedLlms: ["gemini-flash-lite", "gpt-terra"], runs: 400, spentUsd: 4, producedOutcomes: ["email_sent"], reachedOutcomes: ["conversation"] },
    ]);
    const kimi = scriptRatings({ groups: own, values }).find((r) => r.scriptDynasty === KIMI)!;
    expect(kimi.runs).toBe(100);
    // The positive reply Terra's email got is never Kimi's.
    expect(kimi.valueUsd).toBe(0);
    expect(kimi.reached).toEqual([{ outcome: null, runs: 100, creditUsd: 0 }]);
  });

  it("runs of a dynasty written by another LLM before its re-point do not count in its score", () => {
    const groups = [
      // Before 2026-11-13 the base dynasty's writer was picked at run time: Flash-Lite and Haiku wrote it.
      g(BASE, "2026-11-08", 200, ["google-flash-lite-3.5-tokens-output"], ["conversation"]),
      g(BASE, "2026-11-10", 110, ["anthropic-haiku-5.5-tokens-output"]),
      // Since its re-point onto GLM Flash.
      g(BASE, "2026-11-14", 50, ["zai-glm-5.3-flash-tokens-output"]),
    ];
    const { own, otherModels } = splitByServedModel({ groups, stated, llmOfCostName: COST_NAMES });
    expect(own.map((x) => x.day)).toEqual(["2026-11-14"]);
    expect(otherModels.map((o) => [o.servedLlms, o.runs])).toEqual([
      [["gemini-flash-lite"], 200],
      [["claude-haiku"], 110],
    ]);
    const base = scriptRatings({ groups: own, values }).find((r) => r.scriptDynasty === BASE)!;
    expect(base.runs).toBe(50);
    expect(base.valueUsd).toBe(0);
  });

  it("the stated LLM billed beside a helper is the script's own; a ledger naming no model or no LLM is read as its own", () => {
    expect(isOwnCombination(new Set(["kimi-k2"]), ["gemini-flash-lite", "kimi-k2"])).toBe(true);
    expect(isOwnCombination(new Set(["kimi-k2"]), null)).toBe(true);
    expect(isOwnCombination(new Set(["kimi-k2"]), [])).toBe(true);
    expect(isOwnCombination(undefined, ["gpt-terra"])).toBe(true);
    expect(isOwnCombination(new Set(["kimi-k2"]), ["gpt-terra"])).toBe(false);
    // A cost name the catalogue does not list (a vendor that is not an LLM) names no model.
    expect(servedLlmsOf({ writerCostNames: ["instantly-account-email-sent"] }, COST_NAMES)).toEqual([]);
    expect(servedLlmsOf({ writerCostNames: undefined }, COST_NAMES)).toBeNull();
  });

  it("a ledger that names no writer leaves every group in place (byte for byte)", () => {
    const groups = [g(KIMI, "2026-11-15", 3, null), { ...g(BASE, "2026-11-15", 2, null), writerCostNames: undefined }];
    const { own, otherModels } = splitByServedModel({ groups, stated, llmOfCostName: COST_NAMES });
    expect(own).toEqual(groups);
    expect(otherModels).toEqual([]);
  });

  it("Monitoring names the model that served each script's runs, and the row's figures are its own runs only", () => {
    const groups = [g(KIMI, "2026-11-14", 10, ["moonshot-kimi-k2.6-tokens-output"]), g(KIMI, "2026-11-15", 30, ["openai-gpt-6.1-terra-tokens-output"])];
    const servedBy = servedByScript({ groups, stated, llmOfCostName: COST_NAMES });
    expect(servedBy.get(KIMI)).toEqual([
      { servedLlms: ["kimi-k2"], own: true, runs: 10 },
      { servedLlms: ["gpt-terra"], own: false, runs: 30 },
    ]);
    const { own } = splitByServedModel({ groups, stated, llmOfCostName: COST_NAMES });
    const board = scriptEngineBoard({
      ratings: scriptRatings({ groups: own, values }),
      values,
      runnable: [{ id: "s1", outcome: "email_sent", dynasty: "dy_cold__kimi_k2__crion", version: 2, description: "", tactics: { llm: { model: "kimi-k2", provider: "moonshot" } }, code: "" }],
      groups: own,
      servedBy,
      today: "2026-11-16",
      rng: () => 0.5,
      draws: 4,
    });
    const row = board[0]!.scripts[0]!;
    expect(row.runs).toBe(10);
    expect(row.runsByDay.reduce((n, d) => n + d.runs, 0)).toBe(10);
    expect(row.runsByOtherModels).toBe(30);
    expect(row.servedBy[1]).toEqual({ servedLlms: ["gpt-terra"], own: false, runs: 30 });
  });
});

describe("chat-service cost-name catalogue", () => {
  it("reads exact names to dynasties, fails loud on a malformed body", async () => {
    const { parseLlmCostNames } = await import("./llm-cost-names-client.js");
    expect(parseLlmCostNames({ costNames: [{ costName: "a-tokens-input", dynasty: "kimi-k2", provider: "moonshot", modelIds: ["k"] }] })).toEqual(new Map([["a-tokens-input", "kimi-k2"]]));
    expect(() => parseLlmCostNames({})).toThrow(/no costNames/);
    expect(() => parseLlmCostNames({ costNames: [{ costName: "x" }] })).toThrow(/without costName or dynasty/);
  });
});

describe("runs-service script reach with cost names", () => {
  it("a send that billed no model carries the writing behind it; a read that did not ask names nothing", async () => {
    const { parseScriptReach } = await import("./script-value-rating-io.js");
    const row = { scriptDynasty: KIMI, day: "2026-11-15", producedOutcomes: ["email_sent"], reachedOutcomes: [], runs: 2, costInUsdCents: "4", costNames: ["instantly-account-email-sent"], sourceCostNames: ["openai-gpt-6.1-terra-tokens-output"] };
    const asked = parseScriptReach({ builtAt: "t", include: ["costNames"], groups: [row] }).groups[0]!;
    expect(asked.writerCostNames).toEqual(["instantly-account-email-sent", "openai-gpt-6.1-terra-tokens-output"]);
    expect(splitByServedModel({ groups: [asked], stated, llmOfCostName: COST_NAMES }).otherModels[0]!.servedLlms).toEqual(["gpt-terra"]);
    const plain = parseScriptReach({ builtAt: "t", groups: [row] }).groups[0]!;
    expect(plain.writerCostNames).toBeUndefined();
    expect(() => parseScriptReach({ builtAt: "t", include: ["costNames"], groups: [{ ...row, costNames: undefined }] })).toThrow(/costNames is not a list/);
  });
});
