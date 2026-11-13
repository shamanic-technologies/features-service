import { describe, expect, it } from "vitest";
import { campaignEngineScripts, seededRng } from "./campaign-engine-scripts.js";
import { outcomeValues, scriptRatings, type ReachGroup } from "./script-value-rating.js";
import { writerSubjectKey, type Strategy, type Tactic } from "./plays.js";

/** CAMPAIGN-SCRIPTS-1113: a campaign's own Engines in scripts, through the real strategy and Rating rules. */
const g = (scriptDynasty: string, day: string, runs: number, reached: string[], spentUsd: number | null, produced = ["message_written"]): ReachGroup => ({
  scriptDynasty,
  day,
  producedOutcomes: produced,
  reachedOutcomes: reached,
  runs,
  spentUsd,
});
const fleet = [
  g("message_written/cheap", "2026-11-10", 496, ["message_sent"], 0.992),
  g("message_written/cheap", "2026-11-12", 4, ["message_sent", "conversation"], 0.008),
  g("message_written/dear", "2026-11-12", 488, ["message_sent"], 1.952),
  g("message_written/dear", "2026-11-13", 12, ["message_sent", "conversation"], 0.048),
  g("message_written/named", "2026-11-13", 300, ["message_sent"], 0.6),
  g("paid_client/closer", "2026-11-13", 5, [], 1, ["paid_client"]),
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
  { id: "1", outcome: "message_written", dynasty: "cheap", version: 3, description: "Blind email", code: "", tactics: { llm: { provider: "google", model: "flash-lite" } } },
  { id: "2", outcome: "message_written", dynasty: "dear", version: 1, description: "Blind email, careful", code: "", tactics: {} },
  { id: "3", outcome: "message_written", dynasty: "named", version: 2, description: "Names the brand", code: "", tactics: {} },
  { id: "4", outcome: "paid_client", dynasty: "closer", version: 1, description: "", code: "", tactics: {} },
];
const tactic = (id: string, name: string, clientLine: string | null): Tactic => ({ id, name, description: name, createdBy: "t", createdAt: "2026-11-01", clientLine, appliesTo: "script" });
const blindOnly: Strategy = { id: "blind-only", name: "Blind emails only", description: "Never name the brand", requiresTacticIds: [], excludesTacticIds: ["names-brand"], createdBy: "t", createdAt: "2026-11-01" };
const catalogue = {
  tactics: new Map([["names-brand", tactic("names-brand", "Names the brand", "Says who the email is for")]]),
  strategies: new Map([["blind-only", blindOnly]]),
  tacticsByWriter: new Map([
    [writerSubjectKey("script", "message_written/cheap"), new Map([["names-brand", false]])],
    [writerSubjectKey("script", "message_written/dear"), new Map([["names-brand", false]])],
    [writerSubjectKey("script", "message_written/named"), new Map([["names-brand", true]])],
  ]),
};
const campaign = [
  g("message_written/cheap", "2026-11-11", 40, ["message_sent"], 0.08),
  g("message_written/cheap", "2026-11-12", 2, ["message_sent", "conversation"], 0.004),
  g("message_written/named", "2026-11-01", 10, ["message_sent"], 0.02),
  g("message_written/gone", "2026-10-01", 7, [], 0.07),
];
const labelOf = (o: string) => o.replace(/_/g, " ");
const run = (stored: Array<{ outcome: string; strategyId: string | null }>, target: string | null = "paid_client") =>
  campaignEngineScripts({
    target,
    stored: stored.map((s) => ({ ...s, campaignId: "c1" })),
    runnable,
    catalogue,
    fleetRatings: scriptRatings({ groups: fleet, values }),
    values,
    campaignGroups: campaign,
    labelOf,
    rng: seededRng("c1|build"),
  });

describe("campaignEngineScripts", () => {
  const engines = run([{ outcome: "message_written", strategyId: "blind-only" }]);
  const mw = engines.find((e) => e.outcome === "message_written")!;

  it("lists the Target's Engine first, then the Engines the campaign keeps a strategy on or ran", () => {
    expect(engines.map((e) => e.outcome)).toEqual(["paid_client", "message_written"]);
    expect(engines[0]!.isTarget).toBe(true);
    expect(engines[0]!.strategyState).toBe("not_judged_yet");
  });

  it("draws only among the scripts the brief keeps: shares add to 100, the ruled-out one named with its reason", () => {
    expect(mw.strategyState).toBe("kept");
    expect(mw.strategy?.name).toBe("Blind emails only");
    expect(mw.rules).toEqual([{ kind: "excludes", tacticId: "names-brand", name: "Names the brand", clientLine: "Says who the email is for" }]);
    expect(mw.scripts.map((s) => s.script).sort()).toEqual(["message_written/cheap", "message_written/dear"]);
    expect(mw.scripts.reduce((n, s) => n + s.shareOfDrawsPct!, 0)).toBeCloseTo(100, 0);
    expect(mw.scripts[0]!.drawnMost).toBe(true);
    expect(mw.runsNow).toBe(mw.scripts[0]!.script);
    expect(mw.ruledOut.map((s) => s.script)).toEqual(["message_written/named"]);
    expect(mw.ruledOut[0]!.ruledOutReason).toContain("Names the brand");
    expect(mw.ruledOut[0]!.shareOfDrawsPct).toBeNull();
  });

  it("serves this campaign's own runs per script, never the fleet's, and no decision score", () => {
    const cheap = mw.scripts.find((s) => s.script === "message_written/cheap")!;
    expect(cheap.campaign.runs).toBe(42);
    expect(cheap.campaign.lastRunDay).toBe("2026-11-12");
    expect(cheap.campaign.spentUsd).toBeCloseTo(0.084, 6);
    expect(cheap.campaign.costPerRunUsd).toBeCloseTo(0.002, 6);
    expect(cheap.campaign.reached.map((r) => [r.outcome, r.runs])).toEqual([["message_sent", 40], ["conversation", 2]]);
    expect(cheap.llms).toEqual([{ place: null, provider: "google", model: "flash-lite" }]);
    expect(mw.scripts.find((s) => s.script === "message_written/dear")!.campaign.runs).toBe(0);
    expect(mw.ruledOut[0]!.campaign.runs).toBe(10);
    expect(mw.past.map((s) => [s.script, s.campaign.runs])).toEqual([["message_written/gone", 7]]);
    expect(mw.campaign.runs).toBe(59);
    expect(JSON.stringify(engines)).not.toMatch(/valuePerDollar|valueUsd|creditUsd|roi/i);
  });

  it("no condition keeps every runnable script of the Engine", () => {
    const open = run([{ outcome: "message_written", strategyId: null }]).find((e) => e.outcome === "message_written")!;
    expect(open.strategyState).toBe("no_condition");
    expect(open.rules).toEqual([]);
    expect(open.scripts).toHaveLength(3);
    expect(open.ruledOut).toEqual([]);
  });

  it("the same build reads the same shares on every read", () => {
    expect(run([{ outcome: "message_written", strategyId: "blind-only" }])).toEqual(engines);
  });

  it("a strategy the catalogue lost fails loud", () => {
    expect(() => run([{ outcome: "message_written", strategyId: "gone" }])).toThrow(/does not hold/);
  });
});
