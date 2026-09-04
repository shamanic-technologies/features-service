import { describe, it, expect } from "vitest";
import {
  ALL_OUTCOME_CAUSES,
  OUTCOME_CAUSES,
  causeOf,
  causeScopeKeyPart,
  parseOutcomeCauses,
} from "./outcome-cause.js";

/**
 * THE VOCABULARY OF WHOSE WIN AN OUTCOME WAS.
 *
 * Three states and the third is not a missing answer — see the module. These cases pin the two
 * properties every consumer of the parameter relies on: silence is every state (so an unchanged
 * caller reads an unchanged body), and a word this service does not know is a REFUSAL rather than a
 * quiet pick of some set the caller never asked for.
 */
describe("whose win an outcome was — the three states and the parameter", () => {
  it("keeps the producer's three words, in the producer's order", () => {
    expect(OUTCOME_CAUSES).toEqual(["outreach", "other", "unstated"]);
    expect(ALL_OUTCOME_CAUSES).toEqual(["outreach", "other", "unstated"]);
  });

  it("reads a stated cause as the state the customer named", () => {
    expect(causeOf(true)).toBe("outreach");
    expect(causeOf(false)).toBe("other");
  });

  it("reads NOBODY WAS ASKED as its own state and never as either answer", () => {
    expect(causeOf(null)).toBe("unstated");
    // A producer predating the field omits it entirely: the same honest answer, never a `false`.
    expect(causeOf(undefined)).toBe("unstated");
  });

  it("counts every state when the caller names none — today's answer", () => {
    expect(parseOutcomeCauses(undefined)).toEqual(["outreach", "other", "unstated"]);
    expect(parseOutcomeCauses("")).toEqual(["outreach", "other", "unstated"]);
    expect(parseOutcomeCauses("   ")).toEqual(["outreach", "other", "unstated"]);
  });

  it("counts exactly the states the caller names, in canonical order whatever order they arrive in", () => {
    expect(parseOutcomeCauses("outreach")).toEqual(["outreach"]);
    expect(parseOutcomeCauses("unstated,outreach")).toEqual(["outreach", "unstated"]);
    expect(parseOutcomeCauses(" OUTREACH , Unstated ")).toEqual(["outreach", "unstated"]);
    // A repeat is not a second state.
    expect(parseOutcomeCauses("other,other")).toEqual(["other"]);
  });

  it("REFUSES a word it does not know, and a list that names no state at all", () => {
    // Silently counting some other set is the whole misunderstanding the parameter exists to remove.
    expect(parseOutcomeCauses("ours")).toBeNull();
    expect(parseOutcomeCauses("outreach,attributed")).toBeNull();
    // The tracker's vocabulary answers a different question and is not accepted here.
    expect(parseOutcomeCauses("needs_review")).toBeNull();
    expect(parseOutcomeCauses(",,")).toBeNull();
    expect(parseOutcomeCauses(42)).toBeNull();
  });

  it("leaves today's cache keys unmoved for the default set, and separates any narrower one", () => {
    expect(causeScopeKeyPart(ALL_OUTCOME_CAUSES)).toBeUndefined();
    expect(causeScopeKeyPart(["outreach", "unstated"])).toBe("outreach+unstated");
    // Canonical order at parse time is what makes the two spellings ONE cell rather than two.
    expect(causeScopeKeyPart(parseOutcomeCauses("unstated,outreach")!)).toBe(
      causeScopeKeyPart(parseOutcomeCauses("outreach,unstated")!),
    );
  });
});
