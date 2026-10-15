import { describe, expect, it } from "vitest";
import { CHANNEL_STEPS, CHANNEL_STEP_KEYS } from "./acquisition-channels.js";
import { CHANNEL_TRIGGER_TYPES } from "./channel-triggers.js";
import {
  isTriggerCallable,
  outcomeTriggerLabel,
  pluralLabelOf,
  triggerOutcomeKeyOf,
  triggerTypeOf,
  withOutcomeTriggers,
  type OutcomeTriggerSource,
} from "./outcome-vocabulary.js";

const source = (over: Partial<OutcomeTriggerSource>): OutcomeTriggerSource => ({
  id: "x",
  label: "X",
  description: "",
  icon: "circle",
  fromStep: null,
  firedBy: "campaign-service",
  coded: false,
  origin: "code",
  kind: "event",
  params: null,
  displayOrder: 0,
  createdBy: null,
  requestedByOrgId: null,
  ...over,
});

describe("outcome vocabulary (owner 2026-10-15)", () => {
  it("names the outcome Lead, the key unchanged", () => {
    expect(CHANNEL_STEPS.lead_found.label).toBe("Lead");
  });

  it("serves a plural for every coded outcome", () => {
    const plurals = Object.fromEntries(CHANNEL_STEP_KEYS.map((k) => [k, pluralLabelOf(CHANNEL_STEPS[k].label)]));
    expect(plurals).toEqual({
      conversation: "Positive replies",
      website_visit: "Website visits",
      booking_call: "Booking calls",
      meeting_booked: "Meetings booked",
      meeting_attended: "Meetings attended",
      signup: "Signups",
      form_submitted: "Forms submitted",
      purchase: "Direct purchases",
      paid_client: "Paid clients",
      lead_found: "Leads",
    });
    expect(pluralLabelOf("Email sent")).toBe("Emails sent");
    expect(pluralLabelOf("Industry update video")).toBe("Industry update videos");
  });

  it("gives every coded outcome exactly one outcome trigger, named by the outcome's label", () => {
    for (const key of CHANNEL_STEP_KEYS) {
      const own = CHANNEL_TRIGGER_TYPES.filter((t) => triggerOutcomeKeyOf(t) === key);
      expect(own.map((t) => t.label), key).toEqual([outcomeTriggerLabel(CHANNEL_STEPS[key].label)]);
    }
  });

  it("types triggers: an event on a step is an outcome trigger, the rest are conditions", () => {
    expect(triggerTypeOf(source({ kind: "event", fromStep: "conversation" }))).toBe("outcome");
    expect(triggerTypeOf(source({ kind: "delay", fromStep: "signup" }))).toBe("condition");
    expect(triggerTypeOf(source({ kind: "event", fromStep: null }))).toBe("condition");
    expect(triggerTypeOf(source({ kind: "reported", fromStep: null }))).toBe("condition");
    expect(triggerOutcomeKeyOf(source({ kind: "delay", fromStep: "signup" }))).toBeNull();
  });

  it("keeps every trigger a caller reports today callable, and refuses only what we compute", () => {
    const byId = new Map(CHANNEL_TRIGGER_TYPES.map((t) => [t.id, t]));
    for (const id of ["positive_reply_received", "form_submitted", "lead_found", "lead_requested", "follow_up_due"]) {
      expect(isTriggerCallable(byId.get(id)!), id).toBe(true);
    }
    expect(isTriggerCallable(byId.get("github_issue_in_prod")!)).toBe(false);
    expect(isTriggerCallable(source({ kind: "delay" }))).toBe(false);
    expect(isTriggerCallable(source({ kind: "poll" }))).toBe(false);
    expect(isTriggerCallable(source({ kind: "reported" }))).toBe(true);
  });

  it("generates the outcome trigger of a declared outcome that has none, and only then", () => {
    const stored = [
      source({ id: "positive_reply_received", label: "Positive reply", fromStep: "conversation", displayOrder: 3 }),
      source({ id: "signup_not_paid_30_min", label: "Signup Not Paid In 30 Min", kind: "delay", fromStep: "signup", displayOrder: 7 }),
    ];
    const out = withOutcomeTriggers(
      stored,
      [
        { key: "conversation", label: "Positive reply", description: "d", icon: "i" },
        { key: "signup", label: "Signup", description: "A buyer signs up.", icon: "user-plus" },
      ],
      (g) => g,
    );
    expect(out.slice(0, 2)).toEqual(stored);
    // Signup only had a CONDITION trigger anchored on it: it gets its own outcome trigger.
    expect(out.slice(2)).toEqual([
      expect.objectContaining({ id: "signup", label: "Signup", fromStep: "signup", kind: "event", coded: false, displayOrder: 8 }),
    ]);
    expect(out.map(triggerTypeOf)).toEqual(["outcome", "condition", "outcome"]);
  });
});
