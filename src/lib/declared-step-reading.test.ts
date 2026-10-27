import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildMeetingLegFleet, declaredStepReached, internalPipeCountsByDynasty, type PairActed } from "./meeting-leg-fleet.js";
import type { Journey } from "./lived-sales-paths.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";

// CLIENT-SATISFIED-1027 (owner 2026-10-27): « on compte le nombre de sentiments positifs ». A pipe landing on a step
// DECLARED at run time reads lead-service's timeline facts under the step key; an `object` step counts occurrences.
const fact = (label: string, occurredAt: string | null) => ({ label, occurredAt, campaignId: null, attributable: null, valueCents: null });
const journey = (leadId: string, facts: Journey["facts"], acts: Journey["acts"] = [], offerId: string | null = "o1"): Journey => ({ leadId, offerId, facts, acts });
const satisfied = { key: "client_satisfied", subjectKind: "object" };

describe("a declared step reads the timeline facts under its key", () => {
  it("counts every positive client message after the pipe first acted on the person", () => {
    const journeys = [
      journey(
        "l1",
        [fact("client_satisfied", "2026-10-20T10:00:00Z"), fact("client_satisfied", "2026-10-27T10:00:00Z"), fact("client_satisfied", "2026-10-28T10:00:00Z"), fact("paid_client", "2026-10-01T00:00:00Z")],
        [{ campaignId: "pipe-c", firstActedAt: "2026-10-25T00:00:00Z" }],
      ),
      journey("l2", [fact("client_satisfied", null)]),
    ];
    const r = declaredStepReached(journeys, new Set(["l1", "l2"]), new Set(["pipe-c"]), satisfied);
    expect([...r.meetingLeadIds].sort()).toEqual(["l1", "l2"]);
    // l1: the message of 10-20 came before the pipe acted, two after; l2: undated, counted.
    expect(r.occurrencesByLead).toEqual(new Map([["l1", 2], ["l2", 1]]));
  });

  it("a client with no positive message reaches nothing (no fake count)", () => {
    const r = declaredStepReached([journey("l1", [fact("paid_client", "2026-10-01T00:00:00Z")])], new Set(["l1"]), new Set(["pipe-c"]), satisfied);
    expect(r.meetingLeadIds.size).toBe(0);
    expect(r.occurrencesByLead).toEqual(new Map());
  });

  it("a fact served again under a second offer of the same lead counts once", () => {
    const facts = [fact("client_satisfied", "2026-10-27T10:00:00Z")];
    const r = declaredStepReached([journey("l1", facts, [], "o1"), journey("l1", facts, [], "o2")], new Set(["l1"]), new Set(), satisfied);
    expect(r.occurrencesByLead).toEqual(new Map([["l1", 1]]));
  });

  it("a person step counts the person once, whatever the facts", () => {
    const r = declaredStepReached([journey("l1", [fact("x", "2026-10-27T10:00:00Z"), fact("x", "2026-10-28T10:00:00Z")])], new Set(["l1"]), new Set(), { key: "x", subjectKind: "person" });
    expect(r.meetingLeadIds).toEqual(new Set(["l1"]));
    expect(r.occurrencesByLead).toBeUndefined();
  });
});

describe("an occurrence step counts occurrences at every grain of the pipe", () => {
  it("cost per Client Satisfied divides by messages, not by clients", () => {
    const pair: PairActed = {
      actedByCampaign: new Map([["c1", new Set(["l1", "l2"])]]),
      meetingLeadIds: new Set(["l1"]),
      occurrencesByLead: new Map([["l1", 3]]),
    };
    const fleet = buildMeetingLegFleet({
      campaigns: [{ campaignId: "c1", orgId: "org1", brandId: "b1" } as never],
      workflows: [{ slug: "sophie-v1", workflowDynastySlug: "sophie" } as unknown as WorkflowMetadata],
      costGroups: [{ dimensions: { campaignId: "c1", workflowSlug: "sophie-v1" }, totalCostInUsdCents: "300" } as never],
      pairs: new Map([["b1", pair]]),
      legKey: "paid_client_to_client_satisfied",
      reporting: null,
    });
    expect(fleet.pooled).toMatchObject({ spentUsd: 3, contacted: 2, outcomes: 3 });
    expect(fleet.byOrg).toEqual([{ orgId: "org1", spentUsd: 3, contacted: 2, outcomes: 3 }]);
    expect(internalPipeCountsByDynasty(fleet, () => true).get(fleet.perCampaign[0]!.dynasty)).toEqual({ contacted: 2, reached: 3 });
  });
});
