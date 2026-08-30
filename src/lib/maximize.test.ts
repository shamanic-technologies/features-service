/**
 * THE VOCABULARY OF WHAT IS BEING MAXIMISED — two words, one default, and no third option.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_MAXIMIZE, MAXIMIZE_VALUES, matchMaximize, parseMaximize } from "./maximize.js";

describe("maximize", () => {
  it("names exactly two things, and there is no third", () => {
    expect(MAXIMIZE_VALUES).toEqual(["return", "conversionRate"]);
  });

  it("the default is the behaviour that already existed", () => {
    expect(DEFAULT_MAXIMIZE).toBe("return");
    expect(parseMaximize({})).toEqual({ ok: true, maximize: "return" });
    expect(parseMaximize({ maximize: "" })).toEqual({ ok: true, maximize: "return" });
  });

  it("tolerates the case and separator variance every other vocabulary here tolerates", () => {
    for (const spelling of ["conversionRate", "conversion_rate", "conversion-rate", " CONVERSION RATE "]) {
      expect(matchMaximize(spelling)).toBe("conversionRate");
    }
    expect(matchMaximize("RETURN")).toBe("return");
    expect(matchMaximize("returnPerDollar")).toBe("return");
  });

  it("accepts either spelling of the KEY, because the value is what carries the meaning", () => {
    expect(parseMaximize({ maximise: "conversionRate" })).toEqual({ ok: true, maximize: "conversionRate" });
    expect(parseMaximize({ maximize: "conversionRate" })).toEqual({ ok: true, maximize: "conversionRate" });
  });

  it("a word naming NEITHER fails loud — it never falls back to the default", () => {
    expect(matchMaximize("cheapest")).toBeNull();
    expect(matchMaximize("volume")).toBeNull();
    expect(parseMaximize({ maximize: "cheapest" })).toEqual({ ok: false });
  });
});
