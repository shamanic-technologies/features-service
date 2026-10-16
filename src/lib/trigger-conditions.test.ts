import { afterEach, describe, expect, it } from "vitest";
import { canonicalTriggerId, TRIGGER_ALIASES } from "./channel-triggers.js";
import { checkLegRun, parseTriggerInput } from "./channel-declarations.js";
import { funnelNameCandidates } from "./funnel-names.js";
import { funnelShortDescription } from "./funnel-short-descriptions.js";
import { conditionAudience, conditionOfTrigger, registerTriggerConditions, triggerCondition } from "./trigger-conditions.js";

// The three condition instances live in prod (features_service.channel_trigger_types, 2026-10-16), verbatim.
const PROD_CONDITIONS = [
  { id: "signup_not_paid_30_min", kind: "delay", params: { minutes: 30, afterStep: "signup", unlessStep: "paid_client" } },
  { id: "signup_not_paid_24_hours", kind: "delay", params: { minutes: 1440, afterStep: "signup", unlessStep: "paid_client" } },
  { id: "website_visit_no_signup_30_min", kind: "delay", params: { minutes: 30, afterStep: "website_visit", unlessStep: "signup" } },
];

const aiFollowUp = { slug: "ai-follow-up-email", name: "AI Follow-up Email", channelType: "conversion", performedBy: "software", operatedBy: "platform" } as const;

afterEach(() => registerTriggerConditions([]));

describe("one generic condition trigger, many instances (STD-VOCAB-CONDITION-1016)", () => {
  it("reads an instance's condition from its parameters, nothing else", () => {
    expect(conditionOfTrigger(PROD_CONDITIONS[0])).toEqual({ afterStep: "signup", unlessStep: "paid_client" });
    expect(conditionOfTrigger({ kind: "delay", params: { afterStep: "lead_found", days: 3 } })).toEqual({ afterStep: "lead_found", unlessStep: null });
    expect(conditionOfTrigger({ kind: "reported", params: { reportedBy: "chat-service" } })).toBeNull();
    expect(conditionOfTrigger({ kind: "delay", params: null })).toBeNull();
  });

  it("composes the live instances' audiences byte-identical to the per-id wording they replace", () => {
    expect(conditionAudience({ afterStep: "signup", unlessStep: "paid_client" })).toBe("signups who have not paid yet");
    expect(conditionAudience({ afterStep: "website_visit", unlessStep: "signup" })).toBe("site visitors who did not sign up");
    expect(conditionAudience({ afterStep: "conversation", unlessStep: "meeting_booked" })).toBe("buyers who replied with interest but have not booked a meeting");
    expect(conditionAudience({ afterStep: "trial_started", unlessStep: "upgraded" })).toBe("people who reached trial started but did not reach upgraded");
    expect(conditionAudience({ afterStep: "lead_found", unlessStep: null })).toBeNull();
  });

  it("a NEW instance declared as data names its funnel and its sentence with no code", () => {
    registerTriggerConditions([...PROD_CONDITIONS, { id: "meeting_booked_not_paid_7_days", kind: "delay", params: { days: 7, afterStep: "meeting_booked", unlessStep: "paid_client" } }]);
    expect(triggerCondition("meeting_booked_not_paid_7_days")).toEqual({ afterStep: "meeting_booked", unlessStep: "paid_client" });
    const legs = [{ fromStep: null, toStep: "paid_client", channel: aiFollowUp, runByUs: true }];
    expect(funnelShortDescription({ reactive: true, triggerId: "meeting_booked_not_paid_7_days", legs }).shortDescription).toBe("Our AI emails buyers who booked a meeting but have not paid yet.");
    expect(funnelNameCandidates("signup_to_paid_client@cold-whatsapp-outreach", () => "meeting_booked_not_paid_7_days")[0]).toBe("Meeting WhatsApp");
  });

  it("names the three live funnels exactly as before (names are unique ids fleet-wide)", () => {
    registerTriggerConditions(PROD_CONDITIONS);
    // Recorded from origin/main (per-id tables) before the change.
    expect(funnelNameCandidates("start_to_paid_client@ai-follow-up-email", () => "signup_not_paid_30_min")).toEqual(["Follow-up Deals"]);
    expect(funnelNameCandidates("signup_to_paid_client@cold-whatsapp-outreach", () => "signup_not_paid_24_hours")).toEqual(["Signup WhatsApp", "Signup WhatsApp Deals", "Signup Deals"]);
    expect(funnelNameCandidates("website_visit_to_signup@ai-follow-up-email+signup_to_paid_client", () => "website_visit_no_signup_30_min")).toEqual(["Visitor Follow-up", "Visitor Follow-up Signups", "Visitor Signups"]);
    const legs = [{ fromStep: null, toStep: "paid_client", channel: aiFollowUp, runByUs: true }];
    expect(funnelShortDescription({ reactive: true, triggerId: "signup_not_paid_30_min", legs }).shortDescription).toBe("Our AI emails signups who have not paid yet until they buy.");
  });
});

describe("one trigger per fact: follow_up_date_reached is merged into follow_up_due", () => {
  it("resolves the merged id and publishes the table", () => {
    expect(canonicalTriggerId("follow_up_date_reached")).toBe("follow_up_due");
    expect(canonicalTriggerId("follow_up_due")).toBe("follow_up_due");
    expect(canonicalTriggerId("signup_not_paid_30_min")).toBe("signup_not_paid_30_min");
    expect(TRIGGER_ALIASES).toEqual([{ id: "follow_up_date_reached", mergedInto: "follow_up_due" }]);
  });

  it("a merged id is never declared again", () => {
    expect(() => parseTriggerInput({ id: "follow_up_date_reached", label: "Again", description: "x", icon: "bell", kind: "reported", params: { reportedBy: "workflow-service" } }, []))
      .toThrow(/merged into follow_up_due/);
  });

  it("a leg naming the merged id is stored on the one trigger", () => {
    expect(checkLegRun("reactive", "follow_up_date_reached", [])).toEqual({ mode: "reactive", triggerId: "follow_up_due" });
  });

  it("a funnel on the merged id keeps its sentence", () => {
    const legs = [{ fromStep: null, toStep: "conversation", channel: aiFollowUp, runByUs: true }];
    const before = funnelShortDescription({ reactive: true, triggerId: "follow_up_date_reached", legs }).shortDescription;
    expect(before).toBe(funnelShortDescription({ reactive: true, triggerId: "follow_up_due", legs }).shortDescription);
    expect(before).toContain("leads due a follow-up");
  });
});
