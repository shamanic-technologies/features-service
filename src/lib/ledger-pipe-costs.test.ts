import { describe, expect, it } from "vitest";
import { ledgerAudienceEvidence, offCampaignUnitCost, pipeWorkflowCosts, type LedgerPipeBook } from "./ledger-pipe-costs.js";

// a reply pipe (campaigns c1, c2) and a sourcing pipe (s1) that found its leads
const book: LedgerPipeBook = {
  produced: [
    { outcomeKey: "lead_found", campaignId: "s1", workflowSlug: "src-v1", occurrences: 1000, costUsd: 50 },
    { outcomeKey: "message_written", campaignId: "c1", workflowSlug: "keel-v2", occurrences: 900, costUsd: 18 },
    { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", occurrences: 900, costUsd: 9 },
    { outcomeKey: "message_sent", campaignId: "c2", workflowSlug: "ballad-v4", occurrences: 400, costUsd: 4 },
    // replies judged off any campaign, $2 for 20
    { outcomeKey: "conversation", campaignId: null, workflowSlug: null, occurrences: 20, costUsd: 2 },
    // an internal pipe (meeting booking on m1) produces its outcome itself
    { outcomeKey: "meeting_booked", campaignId: "m1", workflowSlug: "mb-v1", occurrences: 2, costUsd: 6 },
  ],
  noOutput: [{ campaignId: "c1", workflowSlug: "keel-v2", costUsd: 3 }],
  consumed: [
    { consumerKey: "message_written", consumedKey: "lead_found", campaignId: "c1", workflowSlug: "keel-v2", sourceCampaignId: "s1", sourceWorkflowSlug: "src-v1", count: 900 },
    { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "keel-v2", count: 6 },
    { consumerKey: "conversation", consumedKey: "message_written", campaignId: null, workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "keel-v2", count: 6 },
    { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "c2", sourceWorkflowSlug: "ballad-v4", count: 4 },
    { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "x9", sourceWorkflowSlug: "other", count: 10 },
  ],
};

describe("one regime for every pipe (LEDGER-HISTORY-1024)", () => {
  it("a workflow's price = its own production on the pipe + its loss + its outcomes' off-campaign stage; never another pipe's inputs", () => {
    const m = pipeWorkflowCosts("conversation", new Set(["c1", "c2"]), book);
    expect(offCampaignUnitCost("conversation", book)).toBeCloseTo(0.1, 10);
    // keel: $18 written + $9 sent + $3 runs with no output + 6 replies (counted once over two inputs) x $0.10; the $50 of leads found is the sourcing pipe's
    expect(m.get("keel-v2")).toEqual({ workflowSlug: "keel-v2", costUsd: 18 + 9 + 3 + 0.6, outcomes: 6, inputs: 900 });
    expect(m.get("ballad-v4")!.outcomes).toBe(4);
    expect(m.get("ballad-v4")!.costUsd).toBeCloseTo(4.4, 10);
    expect(m.has("other")).toBe(false);
    expect(m.has("src-v1")).toBe(false);
  });

  it("the same function prices an internal pipe and any grain: the campaign set is the grain", () => {
    expect(pipeWorkflowCosts("meeting_booked", new Set(["m1"]), book).get("mb-v1")).toEqual({ workflowSlug: "mb-v1", costUsd: 6, outcomes: 2, inputs: 0 });
    expect(pipeWorkflowCosts("conversation", new Set(["c2"]), book).has("keel-v2")).toBe(false);
  });

  it("the audience is one more grain: the runs and the sends of that audience only", () => {
    const aud: LedgerPipeBook = {
      produced: [
        { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", audienceId: "a1", occurrences: 100, costUsd: 10 },
        { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", audienceId: "a2", occurrences: 100, costUsd: 30 },
      ],
      noOutput: [],
      consumed: [
        { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, audienceId: null, sourceCampaignId: "c1", sourceWorkflowSlug: "keel-v2", sourceAudienceId: "a2", count: 3 },
      ],
    };
    const [a1, a2] = ledgerAudienceEvidence("conversation", new Set(["c1"]), ["a1", "a2"], aud, new Map([["keel-v2", "keel"]]), "recipientsRepliesPositive");
    expect(a1!.byDynasty.get("keel")).toMatchObject({ totalCostInUsdCents: 1000, replies: 0 });
    expect(a2!.byDynasty.get("keel")).toMatchObject({ totalCostInUsdCents: 3000, replies: 3 });
    // the brand grain is the sum of its audiences
    expect(pipeWorkflowCosts("conversation", new Set(["c1"]), aud).get("keel-v2")).toMatchObject({ costUsd: 40, outcomes: 3 });
  });
});

describe("a reply judged UNDER the campaign it answers, by a run of no workflow (since 2026-10-23)", () => {
  it("is credited to the send it answers, at its own unit cost, like an off-campaign one (it was dropped)", () => {
    const inCampaign: LedgerPipeBook = {
      produced: [
        { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "ballad-v4", occurrences: 100, costUsd: 10 },
        { outcomeKey: "conversation", campaignId: "c1", workflowSlug: null, occurrences: 3, costUsd: 0.3 },
      ],
      noOutput: [],
      consumed: [
        { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "ballad-v4", count: 3 },
      ],
    };
    expect(offCampaignUnitCost("conversation", inCampaign)).toBeCloseTo(0.1, 10);
    expect(pipeWorkflowCosts("conversation", new Set(["c1"]), inCampaign).get("ballad-v4")).toMatchObject({ outcomes: 3 });
    expect(pipeWorkflowCosts("conversation", new Set(["c1"]), inCampaign).get("ballad-v4")!.costUsd).toBeCloseTo(10.3, 10);
  });
});
