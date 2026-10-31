/**
 * The funnel PATH the Campaigns table draws (owner 2026-10-11), served structured: never parsed from an id. From
 * Start (a proactive funnel) or its trigger step (a reactive one) to Paid client, a channel between EVERY two steps.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { funnelPathView } = await import("./agent-catalogue.js");
const { buildCatalogueModel, funnelById, funnelsOfPath, addTriggerHeadedPathsOf } = await import("../lib/agent-catalogue.js");
const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("../lib/funnel-legs.js");

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const model = buildCatalogueModel({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map(),
  lifetimeRevenueUsd: null,
});
const read = (v: ReturnType<typeof funnelPathView>) => v.items.map((i) => (i.kind === "step" ? i.label : i.kind === "trigger" ? `⚡${i.name}` : `[${i.name}]`));

describe("funnelPathView", () => {
  const BLISS = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
  const MOTIVATE = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
  const MOVING = "conversation_to_booking_call@ai-instant-call+booking_call_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

  it("Bliss (its stored id) reads Start -> [Lead Sourcing] -> Lead found -> [Sales Cold Email Outreach] -> ... -> Paid client: one channel per leg", () => {
    const v = funnelPathView(model, funnelById(model, BLISS)!);
    expect(read(v)).toEqual([
      "Start", "[Lead Sourcing]",
      "Lead", "[Sales Cold Email Outreach]", "Positive reply",
      "[Your Team Meeting Booking]", "Meeting booked",
      "[Your Team Meeting Attendance]", "Meeting attended",
      "[Your Team Closing Calls]", "Paid client",
    ]);
    expect(v.legs.map((l) => [l.fromStep, l.toStep, l.runByUs, l.channelSlug])).toEqual([
      ["start", "lead_found", true, "lead-sourcing"], ["lead_found", "conversation", true, "sales-cold-email-outreach"], ["conversation", "meeting_booked", false, "your-team-meeting-booking"], ["meeting_booked", "meeting_attended", false, "your-team-meeting-attendance"], ["meeting_attended", "paid_client", false, "your-team-closing-calls"],
    ]);
    // Each channel names the PIPE working the leg (P5.1): the dashboard draws its served name and mark off the public catalogue.
    expect(v.legs[3].channels).toEqual([{ slug: "your-team-meeting-attendance", name: "Your Team Meeting Attendance", runByUs: false, pipeId: "your-team-meeting-attendance|meeting_booked_to_meeting_attended" }]);
  });

  it("a single-source funnel reads its one source on the sourcing leg", () => {
    const v = funnelPathView(model, funnelById(model, `start_to_lead_found@sourcing-apollo-cold-filters+${BLISS}`)!);
    expect(read(v).slice(0, 3)).toEqual(["Start", "[Apollo Cold Filters]", "Lead"]);
  });

  it("Moving and Motivate, reactive funnels, start with their TRIGGER (owner 2026-10-11); Moving's booking call leg is the customer's team's", () => {
    const moving = funnelPathView(model, funnelById(model, MOVING)!);
    expect(moving.items[0]).toEqual({ kind: "trigger", slug: "positive_reply_received", name: "Positive reply" });
    expect(read(moving)).toEqual([
      "⚡Positive reply", "[AI Instant Call]", "Booking call", "[Your Team Booking Calls]", "Meeting booked",
      "[Your Team Meeting Attendance]", "Meeting attended", "[Your Team Closing Calls]", "Paid client",
    ]);
    expect(read(funnelPathView(model, funnelById(model, MOTIVATE)!))).toEqual([
      "⚡Positive reply", "[AI Meeting Booking]", "Meeting booked", "[Your Team Meeting Attendance]", "Meeting attended", "[Your Team Closing Calls]", "Paid client",
    ]);
  });

  it("every catalogue funnel shows a channel between every two steps; a proactive one starts at Start, a reactive one with its trigger", () => {
    let funnels = 0;
    for (const path of model.paths.values()) {
      for (const f of funnelsOfPath(model, path)) {
        funnels += 1;
        const v = funnelPathView(model, f);
        const kinds = v.items.map((i) => i.kind);
        expect(kinds[0], f.id).toBe(path.type === "reactive" ? "trigger" : "step");
        expect(kinds[kinds.length - 1], f.id).toBe("step");
        // Exactly one channel between every two steps (owner 2026-10-11: a straight line).
        for (let i = 1; i < kinds.length; i += 1) expect(kinds[i], `${f.id} @${i}`).toBe(kinds[i - 1] === "channel" ? "step" : "channel");
        if (path.type === "proactive") expect(v.items[0], f.id).toMatchObject({ key: "start", label: "Start" });
      }
    }
    expect(funnels).toBeGreaterThan(20);
  });

  it("a trigger-headed funnel a campaign runs, never stated through the creates, still resolves its path (P5.1)", () => {
    const fresh = buildCatalogueModel({
      channels,
      publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
      declaredSteps: [],
      measurements: new Map(),
      lifetimeRevenueUsd: null,
    });
    // Prod: `trigger:lead_event+start_to_paid_client@ai-follow-up-email` (Lead Follow-up); the seed carries the signup leg.
    const ID = "trigger:lead_event+signup_to_paid_client@ai-follow-up-email";
    expect(funnelById(fresh, ID)).toBeNull();
    expect(addTriggerHeadedPathsOf(fresh, [ID, ID, "start_to_lead_found@lead-sourcing", "trigger:nope+signup_to_paid_client@ai-follow-up-email"])).toEqual(["trigger:lead_event+signup_to_paid_client"]);
    const v = funnelPathView(fresh, funnelById(fresh, ID)!);
    expect(read(v)).toEqual(["⚡Lead event", "[AI Follow-up Email]", "Paid client"]);
  });
});
