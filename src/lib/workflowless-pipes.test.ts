import { describe, it, expect } from "vitest";
import { workflowlessPipeLeg } from "./workflowless-pipes.js";

describe("workflowlessPipeLeg: a pipe whose channel sells no reading sales funnel runs no workflow", () => {
  it("recognises every sourcing origin's leg and AI Instant Call's, in any spelling", () => {
    expect(workflowlessPipeLeg("sourcing-apollo-cold-filters", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(workflowlessPipeLeg("sourcing-apollo-buying-signals", "Start-To-Lead-Found")).toBe("start_to_lead_found");
    expect(workflowlessPipeLeg("sourcing-linkedin-engagement-signals", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(workflowlessPipeLeg("ai-instant-call", "conversation_to_booking_call")).toBe("conversation_to_booking_call");
  });

  it("never claims a channel that sells a reading funnel, nor a leg the channel does not perform", () => {
    expect(workflowlessPipeLeg("ai-meeting-booking", "conversation_to_meeting_booked")).toBeNull();
    expect(workflowlessPipeLeg("sales-cold-email-outreach", "lead_found_to_conversation")).toBeNull();
    expect(workflowlessPipeLeg("sourcing-apollo-cold-filters", "conversation_to_booking_call")).toBeNull();
    expect(workflowlessPipeLeg("no-such-channel", "start_to_lead_found")).toBeNull();
  });
});
