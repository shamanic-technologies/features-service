import { describe, expect, it } from "vitest";
import {
  isOutboundLegKeySpelling,
  matchChannelLegKey,
  matchFunnelLegKey,
  OUTBOUND_LEG_KEY_CORRESPONDENCE,
  storedCombinationKeyOf,
  storedLegKeyOf,
} from "./funnel-legs.js";
import { isProactiveTransition } from "./acquisition-channels.js";

describe("the LOCKED outbound leg rename: both spellings are one identity on input, computed on the funnel leg", () => {
  it("publishes the correspondence", () => {
    expect(OUTBOUND_LEG_KEY_CORRESPONDENCE.map((c) => [c.channelType, c.legacyLegKey, c.legKey, c.fromStep.key, c.toStep.key])).toEqual([
      ["outbound", "start_to_conversation", "lead_found_to_conversation", "lead_found", "conversation"],
      ["outbound", "start_to_website_visit", "lead_found_to_website_visit", "lead_found", "website_visit"],
    ]);
  });

  it("resolves the new spelling to the stored one, leaves every other key alone", () => {
    expect(matchFunnelLegKey("lead_found_to_conversation")).toBe("start_to_conversation");
    expect(matchFunnelLegKey("lead_found_to_website_visit")).toBe("start_to_website_visit");
    expect(matchFunnelLegKey("start_to_conversation")).toBe("start_to_conversation");
    expect(matchFunnelLegKey("start_to_lead_found")).toBeNull();
    expect(storedLegKeyOf("lead_found_to_conversation")).toBe("start_to_conversation");
    expect(storedLegKeyOf("start_to_website_visit")).toBe("start_to_website_visit");
    expect(storedLegKeyOf("website_visit_to_form_filled")).toBe("website_visit_to_form_filled");
    expect(storedLegKeyOf("start_to_lead_found")).toBe("start_to_lead_found");
    expect(isOutboundLegKeySpelling("start_to_conversation")).toBe(false);
  });

  it("per channel: the new spelling names a leg of an outbound channel only; a non-outbound legacy key is unaffected", () => {
    expect(matchChannelLegKey("sales-cold-email-outreach", "lead_found_to_conversation")).toBe("start_to_conversation");
    expect(matchChannelLegKey("cold-call-outreach", "lead_found_to_website_visit")).toBe("start_to_website_visit");
    expect(matchChannelLegKey("google-ads", "lead_found_to_website_visit")).toBeNull();
    expect(matchChannelLegKey("google-ads", "start_to_website_visit")).toBe("start_to_website_visit");
    expect(matchChannelLegKey("sales-cold-email-outreach", "start_to_conversation")).toBe("start_to_conversation");
    expect(matchChannelLegKey("ai-meeting-booking", "conversation_to_meeting_booked")).toBe("conversation_to_meeting_booked");
  });

  it("a combination key spelled with the new outbound keys names the stored combination", () => {
    const legacy = "start_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking";
    expect(storedCombinationKeyOf("lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking")).toBe(legacy);
    expect(storedCombinationKeyOf(legacy)).toBe(legacy);
    expect(storedCombinationKeyOf("lead_found_to_website_visit@google-ads")).toBe("lead_found_to_website_visit@google-ads");
    expect(storedCombinationKeyOf("start_to_website_visit@google-ads+website_visit_to_signup")).toBe("start_to_website_visit@google-ads+website_visit_to_signup");
  });

  it("proactive is never 'from nothing' alone: a leg out of lead_found stays proactive", () => {
    expect(isProactiveTransition({ from: null })).toBe(true);
    expect(isProactiveTransition({ from: "lead_found" })).toBe(true);
    expect(isProactiveTransition({ from: "conversation" })).toBe(false);
  });
});
