import { describe, expect, it } from "vitest";
import { assignmentsOn, meetingPipeOn, type MeetingHistoryInputs } from "./meeting-pipe-history.js";

// MEETING-COST-METHODS-1024: the AI Meeting Booking pipe rebuilt as of a past day, nothing dated after it counted.

const inputs: MeetingHistoryInputs = {
  campaigns: [{ campaignId: "c1", orgId: "o1", brandId: "b1" } as never],
  workflows: [{ workflowSlug: "mb-avior", workflowDynastySlug: "mb-avior", workflowDynastyName: "Avior", createdAt: "2026-09-01T00:00:00.000Z", executableUntil: null }],
  spend: [
    { campaignId: "c1", workflowSlug: "mb-avior", day: "2026-10-01", spentCents: 300 },
    { campaignId: "c1", workflowSlug: "mb-avior", day: "2026-10-10", spentCents: 200 },
  ],
  acts: [
    { brandId: "b1", campaignId: "c1", leadId: "A", firstActedAt: "2026-10-02T09:00:00.000Z" },
    { brandId: "b1", campaignId: "c1", leadId: "B", firstActedAt: "2026-10-11T09:00:00.000Z" },
    { brandId: "b1", campaignId: "c1", leadId: "C", firstActedAt: null },
  ],
  meetings: [
    { brandId: "b1", source: "crm", leadId: "A", event: "meeting_booked", occurredAt: "2026-10-05T15:00:00.000Z" },
    { brandId: "b1", source: "acted_person", leadId: "A", event: "acted_person_meeting", occurredAt: "2026-10-05T15:00:00.000Z" },
  ],
  assignmentChanges: [],
};

describe("meetingPipeOn", () => {
  it("counts a brand only once it reported a meeting, and every figure as of the end of the day", () => {
    expect(meetingPipeOn(inputs, "2026-10-03").fleet.pooled).toMatchObject({ spentUsd: 0, contacted: 0, outcomes: 0 });
    expect(meetingPipeOn(inputs, "2026-10-06").fleet.pooled).toMatchObject({ spentUsd: 3, contacted: 1, outcomes: 1 });
    const later = meetingPipeOn(inputs, "2026-10-12");
    expect(later.fleet.pooled).toMatchObject({ spentUsd: 5, contacted: 2, outcomes: 1 });
    expect(later.rows.map((r) => [r.workflowDynastySlug, r.outcomes, r.selectable])).toEqual([["mb-avior", 1, true]]);
  });

  it("reads the stated assignments as of the day, every dynasty active before the first change", () => {
    const changes = [{ legKey: "L", workflowDynastySlug: "x", toState: "deprecated", decidedAt: "2026-10-05T00:00:00.000Z" }];
    expect([...assignmentsOn(changes, "L", "2026-10-04", ["x", "y"])]).toEqual([["x", "active"], ["y", "active"]]);
    expect([...assignmentsOn(changes, "L", "2026-10-05", ["x", "y"])]).toEqual([["x", "deprecated"]]);
  });
});

describe("assignmentsOn with merges", () => {
  it("pools an absorbed dynasty's row onto its survivor, the survivor's own row standing", () => {
    const changes = [
      { legKey: "L", workflowDynastySlug: "absorbed", toState: "deprecated", decidedAt: "2026-10-01T00:00:00.000Z" },
      { legKey: "L", workflowDynastySlug: "other", toState: "active", decidedAt: "2026-10-01T00:00:00.000Z" },
    ];
    const merges = new Map([["absorbed", "survivor"]]);
    expect([...assignmentsOn(changes, "L", "2026-10-02", [], merges)]).toEqual([["other", "active"], ["survivor", "deprecated"]]);
  });
});
