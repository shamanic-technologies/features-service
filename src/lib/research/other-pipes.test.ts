import { describe, expect, it } from "vitest";
import { otherPipesOf, otherPipeTerms, pluralOf } from "./other-pipes.js";
import { STUDIED_PIPES } from "./assemble.js";

const channel = (slug: string, legs: Array<[string, string]>) => ({
  slug,
  shortDescription: `${slug} caption`,
  stepTransitions: legs.map(([legKey, label]) => ({ legKey, to: { label } })),
});

describe("every pipe on the Research page (WA-PIPE-RESEARCH-1023)", () => {
  const channels = [
    channel("sales-cold-email-outreach", [["lead_found_to_conversation", "Positive reply"], ["lead_found_to_website_visit", "Website visit"]]),
    channel("ai-meeting-booking", [["conversation_to_meeting_booked", "Meeting booked"]]),
    channel("cold-whatsapp-outreach", [["start_to_signup", "Signup"], ["lead_found_to_conversation", "Positive reply"], ["signup_to_paid_client", "Paid client"]]),
    channel("your-team-closing-calls", [["meeting_booked_to_paid_client", "Paid client"]]),
  ];
  const assignments = [
    { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" },
    { featureSlug: "cold-whatsapp-outreach", legKey: "start_to_signup" },
    { featureSlug: "cold-whatsapp-outreach", legKey: "lead_found_to_conversation" },
    { featureSlug: "cold-whatsapp-outreach", legKey: "signup_to_paid_client" },
  ];

  it("lists every catalogue pipe holding a workflow, after the studied ones, never a pipe with no workflow", () => {
    const out = otherPipesOf(channels, assignments, STUDIED_PIPES);
    expect(out.map((p) => p.entry.id)).toEqual([
      "cold-whatsapp-outreach|start_to_signup",
      "cold-whatsapp-outreach|lead_found_to_conversation",
      "cold-whatsapp-outreach|signup_to_paid_client",
    ]);
    expect(out[0]).toMatchObject({ featureSlug: "cold-whatsapp-outreach", legKey: "start_to_signup", entry: { channel: "cold-whatsapp-outreach", leg: "start_to_signup", outcome: "Signup", description: "cold-whatsapp-outreach caption" } });
  });

  it("speaks the pipe's own outcome", () => {
    expect(pluralOf("signup")).toBe("signups");
    expect(pluralOf("positive reply")).toBe("positive replies");
    expect(pluralOf("meeting booked")).toBe("meetings booked");
    expect(pluralOf("lead found")).toBe("leads found");
    const t = otherPipeTerms({ id: "x|start_to_signup", channel: "x", leg: "start_to_signup", outcome: "Signup", description: "" }, { durationDays: 0, outcomesRequired: 10 }, null);
    expect(t).toMatchObject({ pipe: "x|start_to_signup", noun: "signup", nounPlural: "signups", outcomesRequired: 10, partialMonth: null });
    expect(t.note).toContain("10 signups behind it");
  });
});
