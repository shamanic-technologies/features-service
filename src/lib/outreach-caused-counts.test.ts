import { describe, it, expect } from "vitest";
import { withOutreachCausedSignalsOnly } from "./outreach-caused-counts.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";

const person = (leadId: string, signals: Record<string, boolean>, unpriced?: string[]): EnginePerson =>
  ({
    leadId,
    email: `${leadId}@x.com`,
    signals,
    signalDates: Object.fromEntries(Object.keys(signals).map((s) => [s, "2026-05-01T00:00:00.000Z"])),
    unpricedSignals: unpriced,
  }) as unknown as EnginePerson;

describe("withOutreachCausedSignalsOnly (SHOWCASE-OUR-WINS-1029)", () => {
  it("drops every rung reached only through an outcome not ours, keeps the rest, never mutates", () => {
    const crm = person("a", { contacted: true, positiveReply: true, meeting: true }, ["meeting"]);
    const [out] = withOutreachCausedSignalsOnly([crm]);
    expect(out.signals).toEqual({ contacted: true, positiveReply: true, meeting: false });
    expect(out.signalDates?.meeting).toBeUndefined();
    expect(out.unpricedSignals).toBeUndefined();
    expect(crm.signals.meeting).toBe(true);
    expect(crm.unpricedSignals).toEqual(["meeting"]);
  });

  it("a person with every rung ours is returned as is", () => {
    const ours = person("b", { contacted: true, meeting: true });
    expect(withOutreachCausedSignalsOnly([ours])[0]).toBe(ours);
  });

  it("one row of a lead saying the meeting was ours is enough after the merge", () => {
    const merged = dedupPersonsByLead(
      withOutreachCausedSignalsOnly([person("c", { meeting: true }, ["meeting"]), person("c", { meeting: true })]),
    );
    expect(merged[0].signals.meeting).toBe(true);
  });
});
