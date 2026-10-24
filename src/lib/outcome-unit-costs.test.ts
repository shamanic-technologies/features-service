import { describe, expect, it } from "vitest";
import { rollUpOutcomeUnitCosts } from "./outcome-unit-costs.js";

// Campaign c1 = a reply pipe (leg ends on conversation), c2 = a visit pipe, c3 = a meeting booking pipe.
const outputOf = (c: string) => ({ c1: "conversation", c2: "website_visit", c3: "meeting_booked" })[c] ?? null;
const pipeOutputs = new Set(["conversation", "website_visit", "meeting_booked", "meeting_attended", "paid_client"]);

describe("outcome unit costs, every path (COST-ACCOUNTING-1023-P2)", () => {
  // c1: 1,000 emails checked $50, 2,000 sends $40 (1,996 never answered), 4 replies (judging $0.40 off any campaign)
  // c2: 1,000 sends $20, 10 visits, and 1 reply its sends caused (a by-product)
  const produced = [
    { outcomeKey: "email_checked", campaignId: "c1", produced: 1000, ownCostUsd: 50 },
    { outcomeKey: "message_sent", campaignId: "c1", produced: 2000, ownCostUsd: 40 },
    { outcomeKey: "conversation", campaignId: null, produced: 4, ownCostUsd: 0.4 },
    { outcomeKey: "message_sent", campaignId: "c2", produced: 1000, ownCostUsd: 20 },
    { outcomeKey: "website_visit", campaignId: "c2", produced: 10, ownCostUsd: 0 },
    { outcomeKey: "conversation", campaignId: "c2", produced: 1, ownCostUsd: 0 },
    // newsletter sends: no campaign, no one's output
    { outcomeKey: "message_sent", campaignId: null, produced: 500, ownCostUsd: 3 },
    // c3: the meeting pipe's own messages, 2 meetings
    { outcomeKey: "message_sent", campaignId: "c3", produced: 10, ownCostUsd: 1 },
    { outcomeKey: "meeting_booked", campaignId: "c3", produced: 2, ownCostUsd: 0 },
  ];
  const consumed = [
    { consumerKey: "message_sent", consumedKey: "email_checked", campaignId: "c1", count: 2000 },
    { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, count: 4 },
    { consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: "c3", count: 2 },
  ];
  const { units, unattributedCostUsd } = rollUpOutcomeUnitCosts(produced, consumed, outputOf, pipeOutputs);

  it("a reply carries its whole pipe: every send, answered or not (normal loss), every email checked", () => {
    // ($50 + $40 + $0.40) / 4 replies
    expect(units.get("conversation")!.unitCostUsd).toBeCloseTo(90.4 / 4, 8);
    expect(units.get("conversation")!.produced).toBe(4);
    const sends = units.get("conversation")!.stages.find((s) => s.outcomeKey === "message_sent")!;
    expect(sends.requirementPerUnit).toBeCloseTo(500, 8);
  });

  it("a visit pipe's sends stay the visits' cost; the reply it caused is a $0 by-product", () => {
    expect(units.get("website_visit")!.unitCostUsd).toBeCloseTo(2, 8);
    expect(units.get("conversation")!.byProducts).toBe(1);
  });

  it("a booked meeting buys its replies from the reply pipe at their unit cost, the replies that never booked included", () => {
    // own $1 / 2 meetings + (4 replies in the brand where meetings happened / 2 meetings) x $22.60
    expect(units.get("meeting_booked")!.unitCostUsd).toBeCloseTo(0.5 + 2 * (90.4 / 4), 8);
    const s = units.get("meeting_booked")!.stages;
    expect(s.reduce((a, x) => a + x.costPerUnitUsd, 0)).toBeCloseTo(units.get("meeting_booked")!.unitCostUsd!, 8);
    expect(s.find((x) => x.outcomeKey === "email_checked")!.source).toBe("input");
  });

  it("an org where the outcome never happened is left out of the input's pool (the meeting-population rule)", () => {
    const r = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "conversation", campaignId: null, orgId: "o1", produced: 10, ownCostUsd: 10 },
        { outcomeKey: "conversation", campaignId: null, orgId: "o2", produced: 90, ownCostUsd: 90 },
        { outcomeKey: "meeting_booked", campaignId: null, orgId: "o1", produced: 2, ownCostUsd: 0 },
      ],
      [{ consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: null, orgId: "o1", count: 2 }],
      outputOf,
      pipeOutputs,
    );
    // o2 reports no meeting: its 90 replies are not the meetings' loss. 10 replies / 2 meetings x $1
    expect(r.units.get("meeting_booked")!.unitCostUsd).toBeCloseTo(5, 8);
  });

  it("the newsletter's sends ride nobody: unattributed, stated", () => {
    expect(unattributedCostUsd).toBeCloseTo(3, 8);
  });

  it("an input nobody produced in the scope is named, never priced at 0 silently", () => {
    const r = rollUpOutcomeUnitCosts(
      [{ outcomeKey: "meeting_booked", campaignId: "c3", produced: 2, ownCostUsd: 1 }],
      [{ consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: "c3", count: 2 }],
      outputOf,
      pipeOutputs,
    );
    expect(r.units.get("meeting_booked")).toMatchObject({ unpricedInputs: ["conversation"] });
  });

  it("a cross-pipe cycle that diverges is named, never thrown; nothing produced = null", () => {
    const r = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "meeting_attended", campaignId: null, produced: 3, ownCostUsd: 1 },
        { outcomeKey: "meeting_booked", campaignId: null, produced: 3, ownCostUsd: 1 },
      ],
      [
        { consumerKey: "meeting_attended", consumedKey: "meeting_booked", campaignId: null, count: 3 },
        { consumerKey: "meeting_booked", consumedKey: "meeting_attended", campaignId: null, count: 3 },
      ],
      outputOf,
      pipeOutputs,
    );
    expect(r.units.get("meeting_attended")).toMatchObject({ unitCostUsd: null, unpricedReason: "consumption_cycle_diverges" });
    const none = rollUpOutcomeUnitCosts([{ outcomeKey: "conversation", campaignId: null, produced: 0, ownCostUsd: 0 }], [], outputOf, pipeOutputs);
    expect(none.units.get("conversation")).toMatchObject({ unitCostUsd: null, produced: 0 });
  });
});

describe("normal loss on the prod shape (cairo-v15, 2026-10-24)", () => {
  it("169k sends, 87 replies, 8 meetings: a reply carries ~1,942 sends, a meeting ~10.9 replies", () => {
    // every send on reply pipes; replies judged off any campaign; meetings by the client's team (no campaign)
    const r = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "message_sent", campaignId: "c1", orgId: "o1", produced: 168_933, ownCostUsd: 7_325 },
        { outcomeKey: "conversation", campaignId: null, orgId: "o1", produced: 87, ownCostUsd: 0 },
        { outcomeKey: "meeting_booked", campaignId: null, orgId: "o1", produced: 8, ownCostUsd: 0 },
      ],
      [
        { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, orgId: "o1", count: 86 },
        { consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: null, orgId: "o1", count: 8 },
      ],
      (c) => (c === "c1" ? "conversation" : null),
      new Set(["conversation", "meeting_booked"]),
    );
    const reply = r.units.get("conversation")!;
    expect(reply.unitCostUsd).toBeCloseTo(7_325 / 87, 6);
    expect(reply.stages.find((s) => s.outcomeKey === "message_sent")!.requirementPerUnit).toBeCloseTo(168_933 / 87, 6);
    const meeting = r.units.get("meeting_booked")!;
    expect(meeting.unitCostUsd).toBeCloseTo((87 / 8) * (7_325 / 87), 6);
    expect(meeting.stages.find((s) => s.outcomeKey === "message_sent")!.requirementPerUnit).toBeCloseTo(168_933 / 8, 6);
  });
});

describe("per client (COST-ACCOUNTING-1023-P4)", () => {
  it("each org is priced on its own pipes; an input bought from another org's run enters at the fleet unit cost", async () => {
    const { rollUpByOrg } = await import("./outcome-unit-costs.js");
    const by = rollUpByOrg(
      [
        { outcomeKey: "message_sent", campaignId: "c1", orgId: "o1", produced: 1000, ownCostUsd: 100 },
        { outcomeKey: "conversation", campaignId: null, orgId: "o1", produced: 10, ownCostUsd: 0 },
        { outcomeKey: "message_sent", campaignId: "c2", orgId: "o2", produced: 1000, ownCostUsd: 20 },
        { outcomeKey: "conversation", campaignId: null, orgId: "o2", produced: 10, ownCostUsd: 0 },
        // o3 books a meeting off a reply o3 never produced (its replies came from o1's pipe): fleet reply price
        { outcomeKey: "meeting_booked", campaignId: null, orgId: "o3", produced: 1, ownCostUsd: 0 },
      ],
      [{ consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: null, orgId: "o3", count: 1 }],
      (c) => (c === "c1" || c === "c2" ? "conversation" : null),
      new Set(["conversation", "meeting_booked"]),
    );
    expect(by.get("o1")!.units.get("conversation")!.unitCostUsd).toBeCloseTo(10, 8);
    expect(by.get("o2")!.units.get("conversation")!.unitCostUsd).toBeCloseTo(2, 8);
    // fleet reply = $120 / 20 = $6
    expect(by.get("o3")!.units.get("meeting_booked")).toMatchObject({ unpricedInputs: [] });
    expect(by.get("o3")!.units.get("meeting_booked")!.unitCostUsd).toBeCloseTo(6, 8);
  });
});

describe("per workflow (COST-ACCOUNTING-1023-P4)", () => {
  it("a workflow's replies carry its whole production on the reply pipes, plus the shared stage per reply", async () => {
    const { workflowUnitCosts } = await import("./outcome-unit-costs.js");
    // fleet: $120 of sends by two workflows, $2 of judging off any campaign, 20 replies
    const fleet = { outcomeKey: "conversation", produced: 20, byProducts: 0, unitCostUsd: 122 / 20, ownUnitCostUsd: 122 / 20, stages: [], unpricedInputs: [] };
    const rows = workflowUnitCosts(
      "conversation",
      [
        { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", ownCostUsd: 100 },
        { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "ballad-v4", ownCostUsd: 20 },
        { outcomeKey: "message_sent", campaignId: "v1", workflowSlug: "visit-wf", ownCostUsd: 50 },
      ],
      [
        { consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: "keel-v2", count: 5 },
        { consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: "ballad-v4", count: 10 },
        { consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: null, count: 5 },
      ],
      (c) => (c === "c1" ? "conversation" : c === "v1" ? "website_visit" : null),
      fleet,
    );
    // shared = 122/20 - 120/20 = $0.10 per reply
    expect(rows.find((r) => r.workflowSlug === "keel-v2")!.unitCostUsd).toBeCloseTo(100 / 5 + 0.1, 8);
    expect(rows.find((r) => r.workflowSlug === "ballad-v4")!.unitCostUsd).toBeCloseTo(20 / 10 + 0.1, 8);
    // a visit pipe's workflow is no reply workflow
    expect(rows.some((r) => r.workflowSlug === "visit-wf")).toBe(false);
    expect(rows[0]!.workflowSlug).toBe("ballad-v4");
  });

  it("a workflow that spent and got no reply has no unit cost (null), never 0", async () => {
    const { workflowUnitCosts } = await import("./outcome-unit-costs.js");
    const fleet = { outcomeKey: "conversation", produced: 1, byProducts: 0, unitCostUsd: 10, ownUnitCostUsd: 10, stages: [], unpricedInputs: [] };
    const rows = workflowUnitCosts("conversation", [{ outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "w", ownCostUsd: 5 }], [], (c) => (c === "c1" ? "conversation" : null), fleet);
    expect(rows[0]).toMatchObject({ workflowSlug: "w", outcomes: 0, unitCostUsd: null, ownCostUsd: 5 });
  });
});
