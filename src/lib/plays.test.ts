import { describe, it, expect } from "vitest";
import { buildPlayCatalogue, currentTacticsByDynasty, idOfName, resolvePlay, splitPlayId, strategyOfFunnelLeg, strategyVerdict, type Strategy, type TacticVerdictRow } from "./plays.js";

const V = (slug: string, dynasty: string, version: number, active: boolean, verdict: boolean): TacticVerdictRow => ({
  workflowSlug: slug, tacticId: "catch-all", workflowDynastySlug: dynasty, version, versionActive: active, verdict, probability: verdict ? 0.9 : 0.1, model: "m", judgedAt: "",
});
const VALID: Strategy = { id: "valid-only", name: "Valid only", description: "a", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: "" };
const CATCH: Strategy = { id: "valid-catch-all", name: "Valid + Catch-all", description: "b", requiresTacticIds: ["catch-all"], excludesTacticIds: [], createdBy: "t", createdAt: "" };
const name = () => "Catch-all";

describe("plays (owner 2026-10-13)", () => {
  it("ids: names slug, play ids split on ~", () => {
    expect(idOfName("Valid + Catch-all")).toBe("valid-catch-all");
    expect(splitPlayId("sales-cold-email-outreach|lead_found_to_conversation~valid-catch-all")).toEqual({ pipeId: "sales-cold-email-outreach|lead_found_to_conversation", strategyId: "valid-catch-all" });
    expect(splitPlayId("a|b")).toEqual({ pipeId: "a|b", strategyId: null });
  });

  it("reads the strategy a funnel names on one pipe, whatever the leg's spelling", () => {
    const id = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach~valid-catch-all+conversation_to_meeting_booked@ai-meeting-booking";
    const same = (a: string, b: string) => a.replace("lead_found_to_", "start_to_") === b.replace("lead_found_to_", "start_to_");
    expect(strategyOfFunnelLeg(id, "sales-cold-email-outreach", "start_to_conversation", same)).toBe("valid-catch-all");
    expect(strategyOfFunnelLeg(id, "ai-meeting-booking", "conversation_to_meeting_booked", same)).toBeNull();
    expect(strategyOfFunnelLeg(id, "sales-cold-email-outreach", "start_to_website_visit", same)).toBeNull();
  });

  it("a dynasty's tactics are its CURRENT version's (active beats deprecated, then the highest)", () => {
    const m = currentTacticsByDynasty([V("o1", "orion", 1, false, true), V("o2", "orion", 2, true, false), V("o3", "orion", 3, false, true)]);
    expect(m.get("orion")!.get("catch-all")).toBe(false);
  });

  it("requires = judged yes; excludes = judged no; NOT judged = not allowed either way (owner 2026-10-13)", () => {
    expect(strategyVerdict(CATCH, new Map([["catch-all", true]]), name).allowed).toBe(true);
    expect(strategyVerdict(CATCH, new Map([["catch-all", false]]), name)).toMatchObject({ allowed: false });
    expect(strategyVerdict(CATCH, undefined, name).reason).toContain("not been judged");
    expect(strategyVerdict(VALID, undefined, name)).toMatchObject({ allowed: false });
    expect(strategyVerdict(VALID, undefined, name).reason).toContain("not been judged");
    expect(strategyVerdict(VALID, new Map([["catch-all", false]]), name).allowed).toBe(true);
    expect(strategyVerdict(VALID, new Map([["catch-all", true]]), name)).toMatchObject({ allowed: false });
  });

  it("resolves a play: bare / default spelled out = the default play; an uncatalogued strategy is no play", () => {
    const c = buildPlayCatalogue({
      tactics: [],
      strategies: [VALID, CATCH],
      plays: [
        { pipeId: "p|l", strategyId: "valid-catch-all", isDefault: false },
        { pipeId: "p|l", strategyId: "valid-only", isDefault: true },
      ],
      verdicts: [],
    });
    expect(resolvePlay(c, "p|l", null)).toMatchObject({ known: true, isDefault: true, strategy: { id: "valid-only" } });
    expect(resolvePlay(c, "p|l", "valid-only")).toMatchObject({ known: true, isDefault: true });
    expect(resolvePlay(c, "p|l", "valid-catch-all")).toMatchObject({ known: true, isDefault: false, strategy: { id: "valid-catch-all" } });
    expect(resolvePlay(c, "p|l", "telepathy")).toMatchObject({ known: false });
    expect(resolvePlay(c, "q|l", null)).toMatchObject({ known: true, isDefault: true, strategy: null });
    expect(c.playsByPipe.get("p|l")![0].isDefault).toBe(true);
  });
});
