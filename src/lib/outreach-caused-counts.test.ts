import { describe, it, expect } from "vitest";
import { withOutreachCausedSignalsOnly } from "./outreach-caused-counts.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import type { ObservedLeadFacts } from "./observed-steps.js";

const person = (leadId: string, signals: Record<string, boolean>, unpriced?: string[]): EnginePerson =>
  ({
    leadId,
    email: `${leadId}@x.com`,
    signals,
    signalDates: Object.fromEntries(Object.keys(signals).map((s) => [s, "2026-05-01T00:00:00.000Z"])),
    unpricedSignals: unpriced,
  }) as unknown as EnginePerson;

const stated = (reached: string[], unpriced: string[] = []): ObservedLeadFacts => ({
  reached: Object.fromEntries(reached.map((s) => [s, "2026-05-02T00:00:00.000Z"])),
  valueUsd: null,
  deadStepSignals: [],
  unpricedSignals: unpriced,
});

describe("withOutreachCausedSignalsOnly (SHOWCASE-OUR-WINS-1029)", () => {
  it("drops every rung reached only through an outcome not ours, keeps the rest, never mutates", () => {
    const crm = person("a", { contacted: true, positiveReply: true, meeting: true }, ["meeting"]);
    const [out] = withOutreachCausedSignalsOnly([crm], new Map([["a@x.com", stated(["meeting"], ["meeting"])]]));
    expect(out.signals).toEqual({ contacted: true, positiveReply: true, meeting: false });
    expect(out.signalDates?.meeting).toBeUndefined();
    expect(out.unpricedSignals).toBeUndefined();
    expect(crm.signals.meeting).toBe(true);
    expect(crm.unpricedSignals).toEqual(["meeting"]);
  });

  it("a rung lead-service stated AND priced to our outreach is kept; the person is returned as is", () => {
    const ours = person("b", { contacted: true, meeting: true, meetingAttended: true });
    const observed = new Map([["b@x.com", stated(["meeting", "meetingAttended"])]]);
    expect(withOutreachCausedSignalsOnly([ours], observed)[0]).toBe(ours);
  });

  it("ONE source of truth: a booked meeting no lead-service statement priced (legacy Instantly mark judged by our own rule) is dropped", () => {
    // Prod 2026-10-29, Doc Dinners: an Instantly "meeting booked" 2 h after our first email, priced by
    // this service's copy of the delivery rule, while lead-service holds no standing statement for it.
    const legacy = person("c", { contacted: true, positiveReply: true, meeting: true, closeWin: true });
    const [out] = withOutreachCausedSignalsOnly([legacy], new Map());
    expect(out.signals).toEqual({ contacted: true, positiveReply: true, meeting: false, closeWin: false });
  });

  it("one row of a lead saying the meeting was ours is enough after the merge", () => {
    const observed = new Map([["c@x.com", stated(["meeting"])]]);
    const merged = dedupPersonsByLead(
      withOutreachCausedSignalsOnly([person("c", { meeting: true }, ["meeting"]), person("c", { meeting: true })], observed),
    );
    expect(merged[0].signals.meeting).toBe(true);
  });
});
