import { describe, expect, it } from "vitest";
import { CHANNEL_TRIGGER_TYPES, anyOfMemberIds, channelTriggerType, triggerCallable, withAnyOfMembers } from "./channel-triggers.js";
import { triggerTypeOf } from "./outcome-vocabulary.js";

// The trigger catalogue as prod serves it on 2026-10-16 (`/public/channels?includeInline=true`), ids and kinds only.
const PROD: ReadonlyArray<{ id: string; kind: string; params?: Record<string, unknown> | null }> = [
  ["on_demand", "event"],
  ["lead_requested", "event"],
  ["positive_reply_received", "event"],
  ["website_visited", "event"],
  ["booking_call_started", "event"],
  ["meeting_booked", "event"],
  ["meeting_attended", "event"],
  ["signed_up", "event"],
  ["form_submitted", "event"],
  ["purchase_made", "event"],
  ["lead_found", "event"],
  ["paid_client", "event"],
  ["email_pushed_via_api", "reported"],
  ["follow_up_due", "reported"],
  ["github_issue_in_prod", "github_issue_in_prod"],
  ["lead_event", "any_of"],
  ["website_visit_no_signup_30_min", "delay"],
  ["signup_not_paid_30_min", "delay"],
  ["signup_not_paid_24_hours", "delay"],
  ["whatsapp_number_given", "reported"],
  ["industry_update_video", "event"],
  ["email_sent", "event"],
].map(([id, kind]) => ({ id, kind, params: null }));

describe("Lead event: one trigger for any fact about a person (LEAD-EVENT-TRIGGER-1016)", () => {
  it("is a coded any_of condition, fired by campaign-service, never callable from outside, but an entry door", () => {
    const t = channelTriggerType("lead_event")!;
    expect(t).toMatchObject({ label: "Lead event", kind: "any_of", fromStep: null, coded: true, firedBy: "campaign-service" });
    expect(t.inline).toBeUndefined();
    expect(triggerTypeOf(t)).toBe("condition");
    expect(triggerCallable(t)).toBe(false);
    expect(CHANNEL_TRIGGER_TYPES.filter((x) => x.kind === "any_of").map((x) => x.id)).toEqual(["lead_event"]);
  });

  it("names exactly the 14 facts the owner listed, none of our own actions or requests", () => {
    expect(anyOfMemberIds(PROD).sort()).toEqual(
      [
        "positive_reply_received",
        "website_visited",
        "booking_call_started",
        "meeting_booked",
        "meeting_attended",
        "signed_up",
        "form_submitted",
        "purchase_made",
        "paid_client",
        "whatsapp_number_given",
        "industry_update_video",
        "website_visit_no_signup_30_min",
        "signup_not_paid_30_min",
        "signup_not_paid_24_hours",
      ].sort(),
    );
  });

  it("serves its members in params.memberTriggerIds; every other row is unchanged", () => {
    const out = withAnyOfMembers(PROD);
    const lead = out.find((t) => t.id === "lead_event")!;
    expect(lead.params).toEqual({ memberTriggerIds: anyOfMemberIds(PROD) });
    expect(out.filter((t) => t.id !== "lead_event")).toEqual(PROD.filter((t) => t.id !== "lead_event"));
  });

  it("a fact declared later joins by itself; a merged id is never a member (its canonical one is)", () => {
    const later = [...PROD, { id: "demo_requested", kind: "reported", params: null }, { id: "follow_up_date_reached", kind: "reported", params: null }];
    const members = anyOfMemberIds(later);
    expect(members).toContain("demo_requested");
    expect(members).not.toContain("follow_up_date_reached");
  });
});
