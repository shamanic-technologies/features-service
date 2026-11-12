import { describe, expect, it } from "vitest";
import { engineLlmBody, llmBeliefs, llmEvidence, pickLlm, universeOf, FLEET_UNIVERSE, UNPLACED, type LlmCall, type LlmLine, type UniverseRule } from "./engine-llm-rating.js";

const LINES: LlmLine[] = [
  { slug: "claude-fable", name: "Claude Fable", provider: "anthropic", servedToday: true },
  { slug: "claude-opus", name: "Claude Opus", provider: "anthropic", servedToday: true },
  { slug: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", servedToday: true },
  { slug: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek", servedToday: true },
  { slug: "kimi-k2", name: "Kimi K2", provider: "moonshot", servedToday: true },
  { slug: "deepseek-pro", name: "DeepSeek Pro", provider: "deepseek", servedToday: false },
];
const FLEET: UniverseRule = { outcome: FLEET_UNIVERSE, allowed: null, excluded: ["claude-fable", "claude-opus"], decidedBy: "owner", note: null, decidedAt: "2026-11-12T00:00:00Z" };
const TODAY = "2026-11-12";

/** X post history as prod held it: Fable wrote every post since Nov 7, Sonnet researched the angles of the same runs. */
function xPostHistory(): LlmCall[] {
  const calls: LlmCall[] = [];
  for (let i = 0; i < 26; i++) {
    const day = `2026-11-${String(7 + (i % 5)).padStart(2, "0")}`;
    const root = `root-${i}`;
    calls.push({ callRunId: `w-${i}`, rootRunId: root, day, outcome: "x_post_published", llmDynastySlug: "claude-fable", spentUsd: 0.07, support: false });
    calls.push({ callRunId: `a-${i}`, rootRunId: root, day, outcome: "x_post_published", llmDynastySlug: "claude-sonnet", spentUsd: 0.03, support: false });
  }
  calls.push({ callRunId: "staff", rootRunId: "staff-root", day: "2026-11-08", outcome: "x_post_published", llmDynastySlug: "claude-opus", spentUsd: 5, support: true });
  return calls;
}
const published = (root: string, outcome: string) => (outcome === "x_post_published" && root.startsWith("root-") && Number(root.slice(5)) % 2 === 0 ? 1 : 0);

describe("universeOf", () => {
  it("default = every LLM served today except Claude Fable and Claude Opus", () => {
    const u = universeOf("x_post_published", [FLEET], LINES);
    expect(u.source).toBe("fleet");
    expect(u.allowed).toEqual(["claude-sonnet", "deepseek-flash", "kimi-k2"]);
  });
  it("an Engine's own row replaces the fleet row", () => {
    const own: UniverseRule = { ...FLEET, outcome: "backlink_earned", allowed: ["claude-sonnet", "deepseek-pro"], excluded: [] };
    expect(universeOf("backlink_earned", [FLEET, own], LINES).allowed).toEqual(["claude-sonnet"]);
    expect(universeOf("x_post_published", [FLEET, own], LINES).source).toBe("fleet");
  });
});

describe("history seeding", () => {
  it("files every past call under its Engine and LLM, support runs out, Units credited per decision", () => {
    const ev = llmEvidence(xPostHistory(), published, []);
    const fable = ev.get("x_post_published|claude-fable")!;
    const sonnet = ev.get("x_post_published|claude-sonnet")!;
    expect(ev.has("x_post_published|claude-opus")).toBe(false);
    const sum = (e: typeof fable, f: (d: (typeof fable.days)[number]) => number) => e.days.reduce((s, d) => s + f(d), 0);
    expect(sum(fable, (d) => d.calls)).toBe(26);
    expect(sum(fable, (d) => d.decisions)).toBe(26);
    expect(sum(fable, (d) => d.outcomes)).toBe(13);
    expect(sum(fable, (d) => d.spentUsd)).toBeCloseTo(1.82, 6);
    expect(sum(sonnet, (d) => d.spentUsd)).toBeCloseTo(0.78, 6);
    expect(fable.firstCallDay).toBe("2026-11-07");
    expect([...fable.byPlace.keys()]).toEqual([UNPLACED]);
  });

  it("a recorded pick places its run's calls; the history still seeds every place", () => {
    const ev = llmEvidence(xPostHistory(), published, [{ outcome: "x_post_published", place: "writer", llmDynastySlug: "claude-sonnet", runId: "root-0", day: "2026-11-07" }]);
    expect(ev.get("x_post_published|claude-sonnet")!.byPlace.get("writer")!.reduce((s, d) => s + d.decisions, 0)).toBe(1);
    const b = llmBeliefs(["claude-sonnet", "kimi-k2"], [...ev.values()], "angles", TODAY);
    // Sonnet's measured cost per decision ($0.03) carries to a place it was never picked at; Kimi, never run, sits on the Engine's.
    expect(b.get("claude-sonnet")!.costMeanUsd).toBeLessThan(0.05);
    expect(b.get("kimi-k2")!.costMeanUsd).toBeCloseTo(0.05, 6);
  });

  it("the staff read shows past LLMs outside the universe with their calls and $, the allowed ones ranked", () => {
    const ev = [...llmEvidence(xPostHistory(), published, []).values()];
    const body = engineLlmBody({ outcome: "x_post_published", rules: [FLEET], lines: LINES, evidence: ev, picks: [], outOfCreditProviders: new Set(), today: TODAY });
    expect(body.llms.map((r) => r.llmDynastySlug).sort()).toEqual(["claude-sonnet", "deepseek-flash", "kimi-k2"]);
    expect(body.llms.every((r) => r.rank !== null)).toBe(true);
    expect(body.favourite).not.toBeNull();
    expect(["claude-fable", "claude-opus"]).not.toContain(body.favourite!.llmDynastySlug);
    const fable = body.outsideUniverse.find((r) => r.llmDynastySlug === "claude-fable")!;
    expect(fable).toMatchObject({ allowed: false, rank: null, notPickableReason: "not_in_engine_universe", calls: 26, outcomes: 13 });
    expect(fable.spentUsdToDate).toBeCloseTo(1.82, 6);
    expect(fable.costPerOutcomeUsd).toBeCloseTo(0.14, 6);
    expect(fable.dailySpend).toHaveLength(30);
    const sonnet = body.llms.find((r) => r.llmDynastySlug === "claude-sonnet")!;
    expect(sonnet.calls).toBe(26);
    expect(body.llms.find((r) => r.llmDynastySlug === "kimi-k2")!.costPerOutcomeUnavailableReason).toBe("never_used");
  });
});

describe("pickLlm", () => {
  it("never returns an LLM outside the Engine's universe, whatever the history", () => {
    const ev = [...llmEvidence(xPostHistory(), () => 1, []).values()];
    for (let i = 0; i < 200; i++) {
      const p = pickLlm({ outcome: "x_post_published", place: "writer", rules: [FLEET], lines: LINES, evidence: ev, outOfCreditProviders: new Set(), today: TODAY, seed: `run-${i}` });
      expect(["claude-sonnet", "deepseek-flash", "kimi-k2"]).toContain(p.llmDynastySlug);
    }
  });
  it("skips a vendor out of credit; nothing left = named refusal", () => {
    const p = pickLlm({ outcome: "x", place: "writer", rules: [{ ...FLEET, allowed: ["kimi-k2"] }], lines: LINES, evidence: [], outOfCreditProviders: new Set(["moonshot"]), today: TODAY, seed: "s" });
    expect(p).toMatchObject({ llmDynastySlug: null, reason: "no_llm_in_engine_universe" });
  });
});
