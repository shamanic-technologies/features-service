import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {} }));

import { scriptWorksPipe } from "./script-catalogue-client.js";
import { engineOutcomeLookup } from "./channel-declarations-store.js";

// MIGRATE-1105 S5: a pipe names the outcome its Engine makes; its scripts are that outcome's.
describe("scriptWorksPipe", () => {
  const stated = { channelSlug: "email-sending", outcome: "email_sent", outcomeStated: true };
  const unstated = { channelSlug: "email-sending", outcome: "conversation", outcomeStated: false };

  it("a re-homed script (no channel) works the pipe naming its outcome", () => {
    expect(scriptWorksPipe({ outcome: "email_sent", tactics: { recorded_by: "instantly" } }, stated)).toBe(true);
  });

  it("a script of another outcome never works it", () => {
    expect(scriptWorksPipe({ outcome: "conversation", tactics: { channel: "email-sending" } }, stated)).toBe(false);
    expect(scriptWorksPipe({ outcome: "whatsapp_message_sent", tactics: {} }, stated)).toBe(false);
  });

  it("a script not yet re-homed works the pipe of its channel and outcome, as before", () => {
    expect(scriptWorksPipe({ outcome: "conversation", tactics: { channel: "email-sending" } }, unstated)).toBe(true);
    expect(scriptWorksPipe({ outcome: "conversation", tactics: { channel: "founder-hello" } }, unstated)).toBe(false);
  });

  it("a script stating no channel never works a pipe naming no outcome (it is asked by other scripts)", () => {
    expect(scriptWorksPipe({ outcome: "conversation", tactics: {} }, unstated)).toBe(false);
  });
});

// ONE-CAMPAIGN-VOLUME-1122: a pipe may NAME its own `to` step as its Engine outcome (the staff PUT no longer refuses it):
// a script stating no channel then works it (AI Meeting Booking's leg to Meeting booked + the Book a meeting script).
describe("a pipe naming its own to step", () => {
  it("is worked by that Engine's scripts stating no channel, unnamed it is not", () => {
    const named = { channelSlug: "ai-meeting-booking", outcome: "meeting_booked", outcomeStated: true };
    const unnamed = { ...named, outcomeStated: false };
    const script = { outcome: "meeting_booked", tactics: { asks: ["message_sent"], relationships: "pure_prospect" } };
    expect(scriptWorksPipe(script, named)).toBe(true);
    expect(scriptWorksPipe(script, unnamed)).toBe(false);
    const of = engineOutcomeLookup([{ channelSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", outcome: "meeting_booked" }]);
    expect(of("ai-meeting-booking", "conversation_to_meeting_booked")).toBe("meeting_booked");
  });
});

describe("engineOutcomeLookup", () => {
  it("reads a stated outcome under either outbound leg spelling, null elsewhere", () => {
    const of = engineOutcomeLookup([{ channelSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", outcome: "email_sequence_sent" }]);
    expect(of("sales-cold-email-outreach", "start_to_conversation")).toBe("email_sequence_sent");
    expect(of("sales-cold-email-outreach", "lead_found_to_conversation")).toBe("email_sequence_sent");
    expect(of("ai-follow-up-email", "start_to_conversation")).toBeNull();
  });
});
