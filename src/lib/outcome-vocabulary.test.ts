import { describe, expect, it } from "vitest";
import { CHANNEL_STEPS, CHANNEL_STEP_KEYS } from "./acquisition-channels.js";
import { CHANNEL_TRIGGER_TYPES, triggerCallable } from "./channel-triggers.js";
import {
  isTriggerCallable,
  LEGACY_CALLABLE_CONDITION_IDS,
  outcomeTriggerLabel,
  pluralLabelOf,
  triggerOutcomeKeyOf,
  triggerTypeOf,
  triggerValueOf,
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
    // Irregular participles (declared steps): the noun takes the plural, never the participle.
    expect(pluralLabelOf("Ad shown")).toBe("Ads shown");
    expect(pluralLabelOf("Audience built")).toBe("Audiences built");
    expect(pluralLabelOf("Email found")).toBe("Emails found");
    expect(pluralLabelOf("Message written")).toBe("Messages written");
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

  it("keeps every trigger a caller reports today callable, and refuses what we compute and our inline requests", () => {
    const byId = new Map(CHANNEL_TRIGGER_TYPES.map((t) => [t.id, t]));
    for (const id of ["positive_reply_received", "form_submitted", "lead_found", "follow_up_due"]) {
      expect(triggerCallable(byId.get(id)!), id).toBe(true);
    }
    expect(triggerCallable(byId.get("github_issue_in_prod")!)).toBe(false);
    // An INLINE trigger is one of our services asking another inside a run, never a fact a client holds.
    expect(triggerCallable(byId.get("lead_requested")!)).toBe(false);
    expect(triggerCallable(byId.get("on_demand")!)).toBe(false);
    expect(isTriggerCallable(source({ kind: "delay", fromStep: "signup" }))).toBe(false);
    expect(isTriggerCallable(source({ kind: "poll" }))).toBe(false);
    expect(isTriggerCallable(source({ id: "email_pushed_via_api", kind: "reported" }))).toBe(true);
    expect(isTriggerCallable(source({ id: "follow_up_date_reached", kind: "reported" }))).toBe(true);
  });

  it("calls no condition trigger callable outside the closed legacy list (MUST-HAVE 3, TRIGGER-CATALOGUE-GAPS-1016)", () => {
    expect([...LEGACY_CALLABLE_CONDITION_IDS].sort()).toEqual(["email_pushed_via_api", "follow_up_date_reached", "follow_up_due", "lead_requested"]);
    // The prod catalogue's declared triggers (2026-10-16) beside the coded ones.
    const declared = [
      source({ id: "email_pushed_via_api", kind: "reported", origin: "declared" }),
      source({ id: "follow_up_date_reached", kind: "reported", origin: "declared" }),
      source({ id: "whatsapp_number_given", kind: "reported", fromStep: "lead_found", origin: "declared" }),
      source({ id: "signup_not_paid_30_min", kind: "delay", fromStep: "signup", origin: "declared" }),
      source({ id: "industry_update_video", kind: "event", fromStep: "industry_update_video", origin: "declared" }),
    ];
    const all = [...CHANNEL_TRIGGER_TYPES, ...declared];
    const callableConditions = all.filter((t) => triggerTypeOf(t) === "condition" && triggerCallable(t)).map((t) => t.id);
    for (const id of callableConditions) expect(LEGACY_CALLABLE_CONDITION_IDS.has(id), id).toBe(true);
    // crm-service reports it through the INTERNAL door (still accepted there); no outside caller may push it.
    expect(triggerCallable(declared[2])).toBe(false);
    // Every outcome trigger stays callable.
    for (const t of all.filter((x) => triggerTypeOf(x) === "outcome")) expect(triggerCallable(t), t.id).toBe(true);
  });

  it("serves every trigger a value or a reason, never a bare null (MUST-HAVE 5)", () => {
    // The fleet values served in prod 2026-10-16; `email_sent` unvalued here to pin the reason.
    const values: Record<string, number | null> = { conversation: 125, paid_client: 2500, lead_found: 0.22, industry_update_video: 25, email_sent: null };
    const valueOf = (k: string) => (Object.hasOwn(values, k) ? values[k] : undefined);
    expect(triggerValueOf(source({ fromStep: "paid_client" }), valueOf)).toEqual({ valueUsd: 2500, valueUnavailableReason: null });
    expect(triggerValueOf(source({ fromStep: "lead_found" }), valueOf)).toEqual({ valueUsd: 0.22, valueUnavailableReason: null });
    expect(triggerValueOf(source({ fromStep: "industry_update_video" }), valueOf)).toEqual({ valueUsd: 25, valueUnavailableReason: null });
    expect(triggerValueOf(source({ fromStep: "email_sent" }), valueOf)).toEqual({ valueUsd: null, valueUnavailableReason: "no_route_to_paid_client" });
    expect(triggerValueOf(source({ fromStep: "meeting_booked" }), valueOf)).toEqual({ valueUsd: null, valueUnavailableReason: "outcome_not_in_catalogue" });
    expect(triggerValueOf(source({ kind: "delay", fromStep: "signup" }), valueOf)).toEqual({ valueUsd: null, valueUnavailableReason: "condition_trigger" });
    for (const t of CHANNEL_TRIGGER_TYPES) {
      const v = triggerValueOf(t, valueOf);
      expect(v.valueUsd === null, t.id).toBe(v.valueUnavailableReason !== null);
    }
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
