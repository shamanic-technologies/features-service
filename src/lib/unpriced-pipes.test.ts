import { describe, it, expect } from "vitest";
import { unpricedPipeLeg } from "./unpriced-pipes.js";

describe("unpricedPipeLeg: a pipe whose channel sells no reading sales funnel is unpriced", () => {
  it("recognises every sourcing origin's leg and AI Instant Call's, in any spelling", () => {
    expect(unpricedPipeLeg("sourcing-apollo-cold-filters", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(unpricedPipeLeg("sourcing-apollo-buying-signals", "Start-To-Lead-Found")).toBe("start_to_lead_found");
    expect(unpricedPipeLeg("sourcing-linkedin-engagement-signals", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(unpricedPipeLeg("ai-instant-call", "conversation_to_booking_call")).toBe("conversation_to_booking_call");
  });

  it("never claims a channel that sells a reading funnel, nor a leg the channel does not perform", () => {
    expect(unpricedPipeLeg("ai-meeting-booking", "conversation_to_meeting_booked")).toBeNull();
    expect(unpricedPipeLeg("sales-cold-email-outreach", "lead_found_to_conversation")).toBeNull();
    expect(unpricedPipeLeg("sourcing-apollo-cold-filters", "conversation_to_booking_call")).toBeNull();
    expect(unpricedPipeLeg("no-such-channel", "start_to_lead_found")).toBeNull();
  });
});
