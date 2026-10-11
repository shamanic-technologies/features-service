/**
 * The funnel PATH the Campaigns table draws (owner 2026-10-11), served structured: never parsed from an id. From
 * Start (a proactive funnel) or its trigger step (a reactive one) to Paid client, a channel between EVERY two steps.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { funnelPathView } = await import("./agent-catalogue.js");
const { buildCatalogueModel, funnelById, funnelsOfPath } = await import("../lib/agent-catalogue.js");
const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("../lib/funnel-legs.js");

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const model = buildCatalogueModel({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map(),
  fleetMedians: new Map(),
  lifetimeRevenueUsd: null,
});
const read = (v: ReturnType<typeof funnelPathView>) => v.items.map((i) => (i.kind === "step" ? i.label : i.kind === "trigger" ? `⚡${i.name}` : `[${i.name}]`));

describe("funnelPathView", () => {
  const BLISS = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
  const MOTIVATE = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
  const MOVING = "conversation_to_booking_call@ai-instant-call+booking_call_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

  it("Bliss reads Start -> [its sources] -> Lead found -> [Sales Cold Email Outreach] -> Positive reply -> [Your Team ...] -> ... -> Paid client", () => {
    const sources = ["sourcing-apollo-cold-filters", "sourcing-apollo-buying-signals", "sourcing-linkedin-engagement-signals"];
    // The campaign's units: its three sources and its cold email (the sourcing leg shows the sources it runs).
    const v = funnelPathView(model, funnelById(model, BLISS)!, [...sources, "sales-cold-email-outreach"]);
    const items = read(v);
    expect(items[0]).toBe("Start");
    expect(items.slice(1, 4).sort()).toEqual(["[Apollo Buying Signals]", "[Apollo Cold Filters]", "[LinkedIn Engagement Signals]"].sort());
    expect(items.slice(4)).toEqual([
      "Lead found", "[Sales Cold Email Outreach]", "Positive reply",
      "[Your Team Meeting Booking]", "Meeting booked",
      "[Your Team Meeting Attendance]", "Meeting attended",
      "[Your Team Closing Calls]", "Paid client",
    ]);
    expect(v.legs.map((l) => [l.fromStep, l.toStep, l.runByUs])).toEqual([
      ["start", "lead_found", true], ["lead_found", "conversation", true], ["conversation", "meeting_booked", false], ["meeting_booked", "meeting_attended", false], ["meeting_attended", "paid_client", false],
    ]);
    expect(v.legs[3].channels).toEqual([{ slug: "your-team-meeting-attendance", name: "Your Team Meeting Attendance", runByUs: false }]);
  });

  it("Moving and Motivate, reactive funnels, start with their TRIGGER (owner 2026-10-11); Moving's booking call leg is the customer's team's", () => {
    const moving = funnelPathView(model, funnelById(model, MOVING)!);
    expect(moving.items[0]).toEqual({ kind: "trigger", slug: "positive_reply_received", name: "Positive Reply" });
    expect(read(moving)).toEqual([
      "⚡Positive Reply", "[AI Instant Call]", "Booking call", "[Your Team Booking Calls]", "Meeting booked",
      "[Your Team Meeting Attendance]", "Meeting attended", "[Your Team Closing Calls]", "Paid client",
    ]);
    expect(read(funnelPathView(model, funnelById(model, MOTIVATE)!))).toEqual([
      "⚡Positive Reply", "[AI Meeting Booking]", "Meeting booked", "[Your Team Meeting Attendance]", "Meeting attended", "[Your Team Closing Calls]", "Paid client",
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
        for (let i = 1; i < kinds.length; i += 1) if (kinds[i] !== "channel") expect(kinds[i - 1], `${f.id} @${i}`).toBe("channel");
        if (path.type === "proactive") expect(v.items[0], f.id).toMatchObject({ key: "start", label: "Start" });
      }
    }
    expect(funnels).toBeGreaterThan(20);
  });
});
