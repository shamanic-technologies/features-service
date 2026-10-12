import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const loadChannelCatalogue = vi.fn();
vi.mock("./channel-declarations-store.js", () => ({ loadChannelCatalogue: (...a: unknown[]) => loadChannelCatalogue(...a) }));

import { publishedPipeLeg, unpricedPipeLeg } from "./unpriced-pipes.js";
import { funnelLegCatalogue } from "./channel-catalogue.js";

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

// Owner 2026-10-12, FORM-SUBMITTED-TRIGGER-1012: AI Meeting Booking's declared form leg was published on its
// channel yet absent from `legs[]` and refused by the leg-keyed projection, so campaign-service could not pick
// its workflow nor find its predecessor.
const formLeg = {
  legKey: "form_submitted_to_meeting_booked",
  from: { key: "form_submitted" },
  to: { key: "meeting_booked" },
  reactive: true,
};

describe("publishedPipeLeg: a published leg no sales funnel walks", () => {
  it("names a leg the channel publishes, in any spelling, and nothing else", async () => {
    loadChannelCatalogue.mockResolvedValue({ channels: [{ slug: "ai-meeting-booking", stepTransitions: [formLeg] }] });
    expect(await publishedPipeLeg("ai-meeting-booking", "Form-Submitted-To-Meeting-Booked")).toBe("form_submitted_to_meeting_booked");
    expect(await publishedPipeLeg("ai-meeting-booking", "signup_to_meeting_booked")).toBeNull();
    expect(await publishedPipeLeg("sales-cold-email-outreach", "form_submitted_to_meeting_booked")).toBeNull();
    expect(loadChannelCatalogue).toHaveBeenCalledWith({ publishedOnly: true });
  });
});

describe("funnelLegCatalogue: every leg a published channel performs is listed", () => {
  it("appends a channel leg no funnel walks, once, after every funnel and outbound leg", () => {
    const before = funnelLegCatalogue();
    const legs = funnelLegCatalogue([
      { stepTransitions: [formLeg] as never },
      { stepTransitions: [formLeg, { ...formLeg, legKey: before[0].legKey }] as never },
    ]);
    expect(legs.slice(0, before.length)).toEqual(before);
    expect(legs).toHaveLength(before.length + 1);
    expect(legs[legs.length - 1]).toMatchObject({
      legKey: "form_submitted_to_meeting_booked",
      fromStep: { key: "form_submitted" },
      toStep: { key: "meeting_booked" },
      funnelKeys: [],
      reactive: true,
    });
  });
});
