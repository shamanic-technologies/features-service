import { describe, expect, it } from "vitest";
import { firstOutcomeDayOf } from "./outcome-cost-totals-client.js";

// MEETING-COST-METHODS-1024: the ledger history of an outcome starts on the first day the ledger holds one.
describe("firstOutcomeDayOf", () => {
  it("is the earliest day holding an occurrence of the outcome", () => {
    const body = {
      produced: [
        { dimensions: { outcomeKey: "meeting_booked", day: "2026-10-23" }, occurrences: 8 },
        { dimensions: { outcomeKey: "meeting_booked", day: "2026-10-01" }, occurrences: 0 },
        { dimensions: { outcomeKey: "conversation", day: "2026-09-01" }, occurrences: 3 },
      ],
    };
    expect(firstOutcomeDayOf(body, "meeting_booked")).toBe("2026-10-23");
    expect(firstOutcomeDayOf({ produced: [] }, "meeting_booked")).toBeNull();
    expect(() => firstOutcomeDayOf({ produced: [{ dimensions: { outcomeKey: "meeting_booked" }, occurrences: 1 }] }, "meeting_booked")).toThrow(/names no day/);
  });
});
