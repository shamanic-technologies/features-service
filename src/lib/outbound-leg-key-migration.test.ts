/**
 * The outbound leg rename, wave 2, STORED half (`lib/outbound-leg-key-migration.ts`): the planners decide
 * every row's fate; no outbound row stays on the legacy spelling, no identity ends up with two rows, and a
 * name stays on the combination it names.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { planAssignments, planNames } = await import("./outbound-leg-key-migration.js");

const at = (iso: string) => new Date(iso);

describe("workflow leg assignments", () => {
  it("moves every outbound legacy row and leaves every other channel's row alone", () => {
    const plan = planAssignments([
      { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowDynastySlug: "keel", decidedAt: at("2026-09-27") },
      { featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit", workflowDynastySlug: "keel", decidedAt: at("2026-09-27") },
      { featureSlug: "feedback-request-cold-email-outreach", legKey: "start_to_conversation", workflowDynastySlug: "osprey", decidedAt: at("2026-09-27") },
      { featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", workflowDynastySlug: "m", decidedAt: at("2026-09-27") },
      { featureSlug: "google-ads", legKey: "start_to_website_visit", workflowDynastySlug: "g", decidedAt: at("2026-09-27") },
      // Already moved: a re-run touches nothing.
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "azalea", decidedAt: at("2026-09-27") },
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.rekeys).toEqual([
      { featureSlug: "sales-cold-email-outreach", workflowDynastySlug: "keel", from: "start_to_conversation", to: "lead_found_to_conversation" },
      { featureSlug: "sales-cold-email-outreach", workflowDynastySlug: "keel", from: "start_to_website_visit", to: "lead_found_to_website_visit" },
      { featureSlug: "feedback-request-cold-email-outreach", workflowDynastySlug: "osprey", from: "start_to_conversation", to: "lead_found_to_conversation" },
    ]);
  });

  it("one identity under both spellings keeps the most recent decision, never two rows", () => {
    const legacyNewer = planAssignments([
      { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowDynastySlug: "keel", decidedAt: at("2026-10-09T12:00:00Z") },
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "keel", decidedAt: at("2026-10-09T11:00:00Z") },
    ]);
    expect(legacyNewer.deletes).toEqual([{ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "keel" }]);
    expect(legacyNewer.rekeys).toHaveLength(1);

    const newNewer = planAssignments([
      { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowDynastySlug: "keel", decidedAt: at("2026-10-09T11:00:00Z") },
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "keel", decidedAt: at("2026-10-09T12:00:00Z") },
    ]);
    expect(newNewer.deletes).toEqual([{ featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowDynastySlug: "keel" }]);
    expect(newNewer.rekeys).toEqual([]);
  });
});

describe("sales-path combination and campaign names", () => {
  it("a name stays on the combination it names, re-keyed (Victory, Sol, Herald, Jubilation)", () => {
    const plan = planNames([
      { combinationKey: "start_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", name: "Victory", assignedAt: at("2026-10-04") },
      { combinationKey: "start_to_website_visit@sales-cold-email-outreach+website_visit_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", name: "Sol", assignedAt: at("2026-10-04") },
      { combinationKey: "start_to_website_visit@sales-cold-email-outreach+website_visit_to_signup+signup_to_paid_client", name: "Herald", assignedAt: at("2026-10-04") },
      { combinationKey: "campaign:sales-cold-email-outreach|start_to_conversation", name: "Jubilation", assignedAt: at("2026-10-04") },
      { combinationKey: "start_to_website_visit@google-ads+website_visit_to_signup+signup_to_paid_client", name: "Honor", assignedAt: at("2026-10-04") },
      { combinationKey: "campaign:organic-linkedin-publishing|start_to_conversation", name: "Sterling", assignedAt: at("2026-10-04") },
      { combinationKey: "campaign:sourcing-crm-contacts|start_to_lead_found", name: "Spire", assignedAt: at("2026-10-04") },
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.rekeys.map((r) => [r.name, r.to])).toEqual([
      ["Victory", "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client"],
      ["Sol", "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client"],
      ["Herald", "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_signup+signup_to_paid_client"],
      ["Jubilation", "campaign:sales-cold-email-outreach|lead_found_to_conversation"],
    ]);
  });

  it("a key named under both spellings keeps the OLDER name", () => {
    const plan = planNames([
      { combinationKey: "campaign:sales-cold-email-outreach|start_to_conversation", name: "Jubilation", assignedAt: at("2026-10-04") },
      { combinationKey: "campaign:sales-cold-email-outreach|lead_found_to_conversation", name: "Zest", assignedAt: at("2026-10-09") },
    ]);
    expect(plan.deletes).toEqual(["campaign:sales-cold-email-outreach|lead_found_to_conversation"]);
    expect(plan.rekeys).toEqual([{ from: "campaign:sales-cold-email-outreach|start_to_conversation", to: "campaign:sales-cold-email-outreach|lead_found_to_conversation", name: "Jubilation" }]);
  });
});
