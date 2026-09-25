import { describe, it, expect } from "vitest";
import {
  ALL_OUTCOME_CAUSES,
  DEFAULT_PRICED_CAUSES,
  OUTCOME_CAUSES,
  causeByDeliveryRule,
  causeOf,
  causeScopeKeyPart,
  parseOutcomeCauses,
} from "./outcome-cause.js";

/**
 * THE VOCABULARY OF WHOSE WIN AN OUTCOME WAS.
 *
 * Three states; `?cause=` names which of them are PRICED, and silence prices `outreach` alone — what
 * the dashboard's lead panel calls "Ours". A word this service does not know is a REFUSAL rather than a
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

  it("reads an undecided outcome as its own state and never as either answer", () => {
    expect(causeOf(null)).toBe("unstated");
    expect(causeOf(undefined)).toBe("unstated");
  });

  it("prices OUR wins alone when the caller names none", () => {
    expect(DEFAULT_PRICED_CAUSES).toEqual(["outreach"]);
    expect(parseOutcomeCauses(undefined)).toEqual(["outreach"]);
    expect(parseOutcomeCauses("")).toEqual(["outreach"]);
    expect(parseOutcomeCauses("   ")).toEqual(["outreach"]);
  });

  it("prices exactly the states the caller names, in canonical order whatever order they arrive in", () => {
    expect(parseOutcomeCauses("outreach")).toEqual(["outreach"]);
    expect(parseOutcomeCauses("unstated,outreach")).toEqual(["outreach", "unstated"]);
    expect(parseOutcomeCauses(" OUTREACH , Unstated ")).toEqual(["outreach", "unstated"]);
    expect(parseOutcomeCauses("other,other")).toEqual(["other"]);
  });

  it("REFUSES a word it does not know, and a list that names no state at all", () => {
    expect(parseOutcomeCauses("ours")).toBeNull();
    expect(parseOutcomeCauses("outreach,attributed")).toBeNull();
    expect(parseOutcomeCauses("needs_review")).toBeNull();
    expect(parseOutcomeCauses(",,")).toBeNull();
    expect(parseOutcomeCauses(42)).toBeNull();
  });

  it("keys EVERY set, the default included, so no snapshot priced on the old default is ever served", () => {
    expect(causeScopeKeyPart(DEFAULT_PRICED_CAUSES)).toBe("priced:outreach");
    expect(causeScopeKeyPart(ALL_OUTCOME_CAUSES)).toBe("priced:outreach+other+unstated");
    expect(causeScopeKeyPart(parseOutcomeCauses("unstated,outreach")!)).toBe(
      causeScopeKeyPart(parseOutcomeCauses("outreach,unstated")!),
    );
  });

  it("judges an outcome with no cause by lead-service's delivery date rule", () => {
    const delivered = "2026-09-01T10:00:00Z";
    expect(causeByDeliveryRule("2026-09-02T00:00:00Z", delivered)).toBe("outreach");
    expect(causeByDeliveryRule("2026-08-31T00:00:00Z", delivered)).toBe("other");
    // Undated, or nothing of ours ever delivered: undecided, never ours.
    expect(causeByDeliveryRule(null, delivered)).toBe("unstated");
    expect(causeByDeliveryRule("2026-09-02T00:00:00Z", null)).toBe("unstated");
  });
});
