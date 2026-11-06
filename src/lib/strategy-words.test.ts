import { describe, expect, it } from "vitest";
import { parseStrategyId, strategyNameWords, strategySentenceWho } from "./strategy-words.js";

describe("strategy words", () => {
  it("reads the -n-months window as before (FUNNEL-NAMES-NO-NUMBERS-1027)", () => {
    expect(parseStrategyId("valid-catch-all-2-months")).toEqual({ base: "valid-catch-all", recontactMonths: 2, neverEmailed: false });
    expect(parseStrategyId("valid-catch-all")).toEqual({ base: "valid-catch-all", recontactMonths: null, neverEmailed: false });
    expect(strategyNameWords("valid-catch-all-2-months")).toEqual({ who: "Wide", window: "Frequent" });
    expect(strategyNameWords("valid-only-6-months")).toEqual({ who: null, window: "Patient" });
    expect(strategyNameWords("valid-only-3-months")).toEqual({ who: null, window: null });
    expect(strategySentenceWho("valid-catch-all-2-months", "new buyers")).toBe("new buyers, unconfirmed addresses included, every 2 months");
    expect(strategySentenceWho("valid-only-3-months", "new buyers")).toBe("new buyers");
  });

  it("a -never-emailed id keeps its base's who and names the never-emailed window (FRESH-NEVER-1106)", () => {
    expect(parseStrategyId("valid-catch-all-never-emailed")).toEqual({ base: "valid-catch-all", recontactMonths: null, neverEmailed: true });
    expect(strategyNameWords("valid-catch-all-never-emailed")).toEqual({ who: "Wide", window: "Fresh" });
    expect(strategySentenceWho("valid-catch-all-never-emailed", "new buyers")).toBe("new buyers, unconfirmed addresses included, never emailed before");
    // Generic: any base, a base the table does not know reads like the default who.
    expect(strategyNameWords("valid-only-never-emailed")).toEqual({ who: null, window: "Fresh" });
    expect(strategySentenceWho("some-future-base-never-emailed", "new buyers")).toBe("new buyers, never emailed before");
  });

  it("the never-emailed words carry no digit and no dash", () => {
    const { window } = strategyNameWords("valid-catch-all-never-emailed");
    expect(window).toMatch(/^[A-Z][a-z]+$/);
    expect(strategySentenceWho("valid-catch-all-never-emailed", "new buyers")).not.toMatch(/[\d—–]/);
  });
});
