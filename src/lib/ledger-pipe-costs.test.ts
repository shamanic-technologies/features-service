import { describe, expect, it } from "vitest";
import { ledgerReconciliation, offCampaignUnitCost, pipeWorkflowCosts, type LedgerPipeBook } from "./ledger-pipe-costs.js";

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

  it("the books reconcile when undeclared spend and unplaced consumptions are each at most 0.5%, every day computed", () => {
    const scope = [
      { campaignId: "c1", spendUsd: 100, supportUsd: 1, producedUsd: 90, noOutputUsd: 10 },
      { campaignId: null, spendUsd: 100, supportUsd: 99.8, producedUsd: 0, noOutputUsd: 100 },
    ];
    expect(ledgerReconciliation({ scope, consumptions: 1000, unknownProvenance: 5, daysMissing: 0 })).toMatchObject({ reconciled: true, campaignLossUsd: 9 });
    expect(ledgerReconciliation({ scope, consumptions: 1000, unknownProvenance: 6, daysMissing: 0 }).reconciled).toBe(false);
    expect(ledgerReconciliation({ scope, consumptions: 1000, unknownProvenance: 0, daysMissing: 1 }).reconciled).toBe(false);
    // prod 2026-10-24 order of magnitude: $541 declared on $9,965
    const today = ledgerReconciliation({ scope: [{ campaignId: "c", spendUsd: 9965, supportUsd: 0, producedUsd: 541, noOutputUsd: 0 }], consumptions: 19, unknownProvenance: 16, daysMissing: 0 });
    expect(today.reconciled).toBe(false);
    expect(today.undeclaredPct).toBeGreaterThan(90);
  });
});
