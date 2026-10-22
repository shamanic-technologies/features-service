import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { runnableLegAssignments, type LegAssignmentRow } from "./workflow-leg-assignments.js";

// PLAY-SEED-LADDER-1022: "Blind emails only" read runnable on 32 assigned-active dynasties while every one was
// retired (alcor) or merged into a survivor (torcular -> alkarab); campaign-service's seed (the leg read) served
// none of them and refused the launch. A runnability verdict counts only what workflow-service can still run.
const row = (workflowDynastySlug: string, state: "active" | "deprecated" = "active", legKey = "lead_found_to_conversation"): LegAssignmentRow => ({
  featureSlug: "sales-cold-email-outreach",
  legKey,
  workflowDynastySlug,
  state,
  decidedBy: "workflow-service",
  decidedAt: "2026-10-21T00:00:00.000Z",
  note: null,
});
const wf = (workflowDynastySlug: string, status: string, mergedIntoDynastySlug: string | null = null) => ({
  workflowDynastySlug,
  status,
  workflowDynastyStatus: "active" as const,
  mergedIntoDynastySlug,
});

describe("runnableLegAssignments", () => {
  const catalogue = new Map([
    [
      "sales-cold-email-outreach",
      [
        wf("alkarab", "active"),
        wf("alkarab", "deprecated"),
        wf("alcor", "deprecated"),
        wf("torcular", "deprecated", "alkarab"),
        wf("keel", "active"),
      ],
    ],
  ]);

  it("drops a dynasty with no runnable version, and pools a merged one into its runnable survivor", () => {
    const out = runnableLegAssignments([row("alcor"), row("torcular"), row("keel")], catalogue);
    expect(out.map((r) => r.workflowDynastySlug).sort()).toEqual(["alkarab", "keel"]);
    expect(out.find((r) => r.workflowDynastySlug === "alkarab")).toMatchObject({ state: "active" });
  });

  it("keeps each pipe's rows apart and keeps a deprecated row's state", () => {
    const out = runnableLegAssignments([row("keel", "deprecated"), row("keel", "active", "lead_found_to_website_visit")], catalogue);
    expect(out.map((r) => `${r.legKey}:${r.state}`).sort()).toEqual(["lead_found_to_conversation:deprecated", "lead_found_to_website_visit:active"]);
  });

  it("never counts a feature whose catalogue was not read", () => {
    expect(runnableLegAssignments([{ ...row("keel"), featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" }], catalogue)).toEqual([]);
  });
});
