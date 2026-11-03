import { describe, it, expect } from "vitest";
import { marksFor } from "./catalogue-marks-store.js";
import { withEnginePickMarks, withFactoryEngineMarks, withJourneyScriptMarks, withResearchPlaceMarks, withScriptMark } from "./catalogue-mark-serving.js";

// SCRIPT-MARKS-1103: every script an Engine read names carries its dynasty's served mark, the very one Research serves
// for it (same family, same key: the workflow dynasty slug). The suite's mark store is the in-memory twin (vitest.setup).

const ref = (slug: string) => ({ candidateId: `cold|lead_found_to_conversation::${slug}`, pipeId: "cold|lead_found_to_conversation", channelName: "Cold Email", workflowDynastySlug: slug, workflowDynastyName: slug });

describe("script marks", () => {
  it("engine picks carry the workflow dynasty's mark, the one Research serves", async () => {
    const picks = await withEnginePickMarks([{ workflowDynastySlug: "ballad", workflowName: "Ballad" }, { workflowDynastySlug: "mebsuta", workflowName: "Mebsuta" }]);
    const research = await marksFor("workflow", ["ballad", "mebsuta"]);
    expect(picks[0]).toMatchObject({ workflowDynastySlug: "ballad", icon: research.get("ballad")!.icon, color: research.get("ballad")!.color });
    expect(picks[1]).toMatchObject({ icon: research.get("mebsuta")!.icon, color: research.get("mebsuta")!.color });
    expect(`${picks[0]!.icon}|${picks[0]!.color}`).not.toBe(`${picks[1]!.icon}|${picks[1]!.color}`);
  });

  it("a script with no mark reads null, never a substitute", () => {
    expect(withScriptMark({ workflowDynastySlug: "x" }, undefined)).toEqual({ workflowDynastySlug: "x", icon: null, color: null });
  });

  it("the factory body marks today, engine, engineModal and every candidate; other fields untouched", async () => {
    const body = {
      campaignId: "sfc-1",
      plan: { x: 1 },
      engine: { status: "ok", places: [{ outcome: "conversation", today: ref("keel"), engine: ref("ballad"), engineModal: null, candidates: [{ ...ref("ballad"), pickSharePct: 70 }, { ...ref("keel"), pickSharePct: 30 }] }] },
    };
    const marked = await withFactoryEngineMarks(body);
    const m = await marksFor("workflow", ["keel", "ballad"]);
    const place = marked.engine.places[0]!;
    expect(place.today).toMatchObject({ icon: m.get("keel")!.icon, color: m.get("keel")!.color });
    expect(place.engine).toMatchObject({ icon: m.get("ballad")!.icon });
    expect(place.engineModal).toBeNull();
    expect(place.candidates.map((c) => (c as { icon?: string }).icon)).toEqual([m.get("ballad")!.icon, m.get("keel")!.icon]);
    expect(place.candidates[0]!.pickSharePct).toBe(70);
    expect(marked.plan).toEqual({ x: 1 });
    expect(await withFactoryEngineMarks({ campaignId: "sfc-2", engine: null })).toEqual({ campaignId: "sfc-2", engine: null });
  });

  it("research places mark the favourite and every candidate; journeys mark every script", async () => {
    const c = { candidateId: "a::avior", workflowDynastySlug: "avior", workflowName: "Avior" };
    const [p] = await withResearchPlaceMarks([{ key: "k", favourite: { ...c, chancePct: 90 }, candidates: [c] }]);
    const m = await marksFor("workflow", ["avior"]);
    expect(p!.favourite).toMatchObject({ chancePct: 90, icon: m.get("avior")!.icon, color: m.get("avior")!.color });
    expect(p!.candidates[0]).toMatchObject({ icon: m.get("avior")!.icon });
    const [t] = await withJourneyScriptMarks([{ pipeId: "p", scripts: [{ workflowDynastySlug: "avior", workflowName: "Avior", sharePct: 100 }] }]);
    expect(t!.scripts[0]).toMatchObject({ sharePct: 100, icon: m.get("avior")!.icon });
  });
});
