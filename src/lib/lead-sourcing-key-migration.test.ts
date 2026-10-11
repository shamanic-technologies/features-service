import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { respellDeclaredSalesPath } = await import("./lead-sourcing-key-migration.js");
const { planNames } = await import("./outbound-leg-key-migration.js");
const { servedNameKeyOf } = await import("./funnel-legs.js");

const BLISS = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const LS_BLISS = `start_to_lead_found@lead-sourcing+${BLISS}`;
const at = (iso: string) => new Date(iso);

describe("the Lead Sourcing funnel re-key (owner 2026-10-11: one channel per leg)", () => {
  it("a name key from before the sourcing leg was named is STORED under its Lead Sourcing spelling; nothing else moves", () => {
    expect(servedNameKeyOf(BLISS)).toBe(LS_BLISS);
    expect(servedNameKeyOf(LS_BLISS)).toBe(LS_BLISS);
    // The outbound legacy spelling and the Lead Sourcing one compose.
    expect(servedNameKeyOf("start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client")).toBe(
      "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
    );
    const motivate = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    expect(servedNameKeyOf(motivate)).toBe(motivate);
    expect(servedNameKeyOf("campaign:sales-cold-email-outreach|lead_found_to_conversation")).toBe("campaign:sales-cold-email-outreach|lead_found_to_conversation");
    expect(servedNameKeyOf("path:lead_found_to_conversation+conversation_to_paid_client")).toBe("path:lead_found_to_conversation+conversation_to_paid_client");
  });

  it("Bliss keeps its name on its new key at boot; idempotent; a collision keeps the OLDER name", () => {
    expect(planNames([{ combinationKey: BLISS, name: "Bliss", assignedAt: at("2026-10-01") }])).toEqual({ deletes: [], rekeys: [{ from: BLISS, to: LS_BLISS, name: "Bliss" }] });
    expect(planNames([{ combinationKey: LS_BLISS, name: "Bliss", assignedAt: at("2026-10-01") }])).toEqual({ deletes: [], rekeys: [] });
    const collision = planNames([
      { combinationKey: BLISS, name: "Bliss", assignedAt: at("2026-10-01") },
      { combinationKey: LS_BLISS, name: "Newer", assignedAt: at("2026-10-11") },
    ]);
    expect(collision).toEqual({ deletes: [LS_BLISS], rekeys: [{ from: BLISS, to: LS_BLISS, name: "Bliss" }] });
  });

  it("a declared sales path under a legacy key gets its Lead Sourcing leg first", () => {
    const legs = [{ channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" }];
    expect(respellDeclaredSalesPath({ combinationKey: "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", legs })).toEqual({
      combinationKey: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
      legs: [{ channelSlug: "lead-sourcing", legKey: "start_to_lead_found" }, ...legs],
    });
    expect(respellDeclaredSalesPath({ combinationKey: "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended", legs })).toBeNull();
  });
});
