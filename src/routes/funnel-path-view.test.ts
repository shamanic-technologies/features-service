/** The funnel PATH the Campaigns table draws (owner 2026-10-11), served structured: never parsed from an id. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { funnelPathView } = await import("./agent-catalogue.js");

const LABELS: Record<string, string> = { lead_found: "Lead found", conversation: "Positive reply", meeting_booked: "Meeting booked", meeting_attended: "Meeting attended", paid_client: "Paid client" };
const model = (steps: string[]) =>
  ({ steps: new Map(Object.entries(LABELS).map(([key, label]) => [key, { key, label }])), paths: new Map([["p", { id: "p", steps }]]) }) as never;
const pipe = (slug: string, name: string, operatedBy: "platform" | "customer") => ({ channelSlug: slug, channelName: name, operatedBy });

describe("funnelPathView", () => {
  it("Bliss: our channel between the two steps of the leg we run, the team's legs show only their next step, ends at Paid client", () => {
    const v = funnelPathView(model(["lead_found", "conversation", "meeting_booked", "meeting_attended", "paid_client"]), {
      pathId: "p",
      legs: [
        { legKey: "lead_found_to_conversation", pipe: pipe("sales-cold-email-outreach", "Sales Cold Email Outreach", "platform") },
        { legKey: "conversation_to_meeting_booked", pipe: null },
        { legKey: "meeting_booked_to_meeting_attended", pipe: pipe("your-team-meeting-attendance", "Your Team Meeting Attendance", "customer") },
        { legKey: "meeting_attended_to_paid_client", pipe: null },
      ],
    } as never);
    expect(v.items.map((i) => (i.kind === "step" ? i.label : `[${i.name}]`))).toEqual([
      "Lead found", "[Sales Cold Email Outreach]", "Positive reply", "Meeting booked", "Meeting attended", "Paid client",
    ]);
    expect(v.legs.map((l) => [l.fromStep, l.toStep, l.runByUs])).toEqual([
      ["lead_found", "conversation", true], ["conversation", "meeting_booked", false], ["meeting_booked", "meeting_attended", false], ["meeting_attended", "paid_client", false],
    ]);
    expect(v.legs[2].channelName).toBe("Your Team Meeting Attendance");
  });
});
