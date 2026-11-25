import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DIGITS, MOST_UNITS_RULE, briefMostUnitsNeed, briefMostUnitsQuestions, briefMostUnitsState, mostUnitsByEngine, mostUnitsOf, mostUnitsOfAnswers } from "./brief-most-units.js";

// BRIEF-DAILY-CAP-1125: the most Units a campaign's brief allows at one Engine, read off Jev's choices.
const digit = (d: number, confidence = 0.97) => ({ type: "choice", choice: `n${d}`, confidence });
const answers = (states: number, per: string, n: number, confidence = 0.97) => ({
  states: { type: "noul", noul: states },
  per: { type: "choice", choice: per, confidence: 1 },
  ...Object.fromEntries(Array.from({ length: DIGITS }, (_, place) => [`d${place}`, digit(Math.floor(n / 10 ** place) % 10, confidence)])),
});

describe("the most Units a brief allows at an Engine (BRIEF-DAILY-CAP-1125)", () => {
  it("« at most one a day » reads 1 per day; the number comes from one choice per digit, never from the brief's text", () => {
    expect(mostUnitsOfAnswers(answers(0.97, "day", 1))).toEqual({ units: 1, per: "day", probability: 0.97, confidence: 0.97 });
    expect(mostUnitsOfAnswers(answers(0.95, "month", 1200, 0.67))).toEqual({ units: 1200, per: "month", probability: 0.95, confidence: 0.67 });
    expect(mostUnitsOfAnswers(answers(0.9, "week", 2))).toMatchObject({ units: 2, per: "week" });
  });

  it("a brief silent on this Engine = no cap, whatever the other answers say; a stated limit of zero is no cap either", () => {
    expect(mostUnitsOfAnswers(answers(0.13, "day", 1))).toEqual({ units: null, per: null, probability: 0.13, confidence: null });
    expect(mostUnitsOfAnswers(answers(0.8, "day", 0))).toMatchObject({ units: null, per: null });
    expect(mostUnitsOf({ units: null, per: null })).toBeNull();
    expect(mostUnitsOf(null)).toBeNull();
  });

  it("an unreadable answer throws (the caller fails closed), never a silent no cap", () => {
    expect(() => mostUnitsOfAnswers(undefined)).toThrow(/readable probability/);
    expect(() => mostUnitsOfAnswers({ ...answers(0.9, "day", 3), per: { type: "choice", choice: "year", confidence: 1 } })).toThrow(/period/);
    expect(() => mostUnitsOfAnswers({ ...answers(0.9, "day", 3), d2: { type: "choice", choice: "eleven", confidence: 1 } })).toThrow(/hundreds digit/);
    const missing: Record<string, unknown> = { ...answers(0.9, "day", 3) };
    delete missing.d0;
    expect(() => mostUnitsOfAnswers(missing as never)).toThrow(/units digit/);
  });

  it("the period is kept as stated and served with its length in days", () => {
    expect(mostUnitsOf({ units: 1, per: "day" })).toEqual({ units: 1, per: "day", days: 1 });
    expect(mostUnitsOf({ units: 3, per: "week" })).toEqual({ units: 3, per: "week", days: 7 });
    expect(mostUnitsOf({ units: 1200, per: "month" })).toEqual({ units: 1200, per: "month", days: 30 });
    const byEngine = mostUnitsByEngine([
      { outcome: "post_made", units: 1, per: "day" },
      { outcome: "signup_made", units: null, per: null },
    ]);
    expect([...byEngine]).toEqual([["post_made", { units: 1, per: "day", days: 1 }]]);
  });

  it("stored with the brief: stands while the brief and the rule are unchanged, re-asked when either moves; no brief = nothing asked", () => {
    expect(briefMostUnitsNeed(null, null)).toBe("none");
    expect(briefMostUnitsNeed(null, "h1")).toBe("ask");
    expect(briefMostUnitsNeed({ briefHash: "h1", rule: MOST_UNITS_RULE }, "h1")).toBe("stored");
    expect(briefMostUnitsNeed({ briefHash: "h1", rule: MOST_UNITS_RULE }, "h2")).toBe("ask");
    expect(briefMostUnitsNeed({ briefHash: "h1", rule: "older" }, "h1")).toBe("ask");
    // A brief emptied after an answer keeps that answer (as a strategy verdict does).
    expect(briefMostUnitsNeed({ briefHash: "h1", rule: MOST_UNITS_RULE }, null)).toBe("stored");
  });

  it("one call: a yes/no, the period, one ten-option choice per digit; the judge sees the brief, the Engine in words and its scripts", () => {
    const q = briefMostUnitsQuestions();
    expect(Object.keys(q)).toEqual(["states", "per", "d4", "d3", "d2", "d1", "d0"]);
    expect(q.states.type).toBe("noul");
    expect(Object.keys(q.per.criteria)).toEqual(["day", "week", "month"]);
    expect(Object.keys((q as unknown as Record<string, { criteria: Record<string, string> }>).d0!.criteria)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"]);
    const s = (outcome: string, dynasty: string) => ({ id: dynasty, outcome, dynasty, version: 1, description: `${dynasty} does`, tactics: {}, code: "" });
    expect(briefMostUnitsState("Publish at most one a day.", { outcome: "post_made", label: "Post made" }, [s("post_made", "dy_b"), s("other_made", "dy_x"), s("post_made", "dy_a")])).toEqual({
      brief: "Publish at most one a day.",
      engine: { outcome: "post_made", makes: "Post made", scripts: [{ script: "dy_a", does: "dy_a does" }, { script: "dy_b", does: "dy_b does" }] },
    });
  });

  it("no outcome, channel, brand or Engine is named in the rule, its IO or its store", () => {
    for (const f of ["brief-most-units.ts", "brief-most-units-io.ts", "brief-most-units-store.ts"]) {
      const src = readFileSync(`src/lib/${f}`, "utf8").toLowerCase();
      for (const word of ["threads", "linkedin", "email", "signup", "lead_", "message_", "_published", "_sent", "whatsapp", "distribute"]) expect([f, word, src.includes(word)]).toEqual([f, word, false]);
    }
  });
});
