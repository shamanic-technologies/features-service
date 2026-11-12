import { describe, expect, it } from "vitest";
import { SCRIPT_POOL, ledgerAudienceEvidence, offCampaignUnitCost, pipeScriptCost, pipeScriptCosts, pipeWorkflowCosts, scriptDynastyOfSlug, type LedgerPipeBook } from "./ledger-pipe-costs.js";

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

describe("a pipe's scripts, pooled (MON-SCRIPT-PRICES-1111)", () => {
  // c1 = the pipe's campaign. Before: a workflow (keel) sent, and its replies were judged under c1 with no workflow.
  // Since the scripts: every run in c1 carries no workflow.
  const scripts: LedgerPipeBook = {
    produced: [
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", occurrences: 100, costUsd: 10, runStartDay: "2026-10-20" },
      // the reply judge under c1, no workflow: 2 answer keel (workflow era), 3 answer the scripts
      { outcomeKey: "conversation", campaignId: "c1", workflowSlug: null, occurrences: 5, costUsd: 0.5, runStartDay: "2026-11-08" },
      // the scripts: leads checked, emails written and sent
      { outcomeKey: "email_checked", campaignId: "c1", workflowSlug: null, occurrences: 300, costUsd: 3, runStartDay: "2026-11-06" },
      { outcomeKey: "message_written", campaignId: "c1", workflowSlug: null, occurrences: 300, costUsd: 6, runStartDay: "2026-11-06" },
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, occurrences: 300, costUsd: 3, runStartDay: "2026-11-06" },
      // a reply judged off any campaign: $0.10 each over every no-workflow judge
      { outcomeKey: "conversation", campaignId: null, workflowSlug: null, occurrences: 5, costUsd: 0.5, runStartDay: "2026-11-09" },
      // another pipe's campaign (the sourcing): never in this pool
      { outcomeKey: "lead_found", campaignId: "s1", workflowSlug: null, occurrences: 300, costUsd: 30, runStartDay: "2026-11-05" },
    ],
    noOutput: [{ campaignId: "c1", workflowSlug: null, costUsd: 1, runStartDay: "2026-11-07" }],
    consumed: [
      { consumerKey: "message_written", consumedKey: "lead_found", campaignId: "c1", workflowSlug: null, sourceCampaignId: "s1", sourceWorkflowSlug: null, count: 300, runStartDay: "2026-11-06", sourceRunStartDay: "2026-11-05" },
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "keel-v2", count: 2, runStartDay: "2026-11-08", sourceRunStartDay: "2026-10-20" },
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: null, count: 3, runStartDay: "2026-11-08", sourceRunStartDay: "2026-11-06" },
      // judged off campaign: one answers our scripts' send, four another pipe's
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: null, count: 1, runStartDay: "2026-11-09", sourceRunStartDay: "2026-11-06" },
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "x9", sourceWorkflowSlug: null, count: 4, runStartDay: "2026-11-09", sourceRunStartDay: "2026-11-06" },
    ],
  };

  it("the pool = every no-workflow row in the pipe's campaigns + its loss + its replies judged outside; a workflow's reply goes back to it", () => {
    const unit = offCampaignUnitCost("conversation", scripts);
    expect(unit).toBeCloseTo(0.1, 10);
    const pool = pipeScriptCost("conversation", new Set(["c1"]), scripts)!;
    // $0.5 judged + $3 checked + $6 written + $3 sent + $1 loss − keel's 2 replies at $0.10 + 1 reply judged outside at $0.10
    expect(pool.costUsd).toBeCloseTo(0.5 + 3 + 6 + 3 + 1 - 0.2 + 0.1, 10);
    expect(pool).toMatchObject({ workflowSlug: SCRIPT_POOL, outcomes: 5 - 2 + 1, inputs: 300 });
    // keel keeps its 2 replies (the workflow rule, unchanged): together they count every reply once
    expect(pipeWorkflowCosts("conversation", new Set(["c1"]), scripts).get("keel-v2")!.outcomes).toBe(2);
  });

  it("the mature cohort: runs started on or before the cut, an outcome by the day its input was made", () => {
    const mature = pipeScriptCost("conversation", new Set(["c1"]), scripts, "2026-11-06")!;
    // runs started by 11-06: checked + written + sent; the 3 + 1 replies answer sends of 11-06
    expect(mature.costUsd).toBeCloseTo(3 + 6 + 3 + 0.1, 10);
    expect(mature).toMatchObject({ outcomes: 4, inputs: 300 });
    expect(pipeScriptCost("conversation", new Set(["c1"]), scripts, "2026-11-01")).toBeNull();
  });

  it("a pipe whose campaigns ran no script has no pool; another pipe's campaign is never in it", () => {
    expect(pipeScriptCost("conversation", new Set(["c2"]), scripts)).toBeNull();
    expect(pipeScriptCost("lead_found", new Set(["s1"]), scripts)).toMatchObject({ costUsd: 30, outcomes: 300, inputs: 0 });
  });
});

describe("each script of a pipe, measured apart (MON-SCRIPT-PRICES-2-1111)", () => {
  // c1 = the pipe's campaign. Two cold email scripts send (A v1+v2, B v1); the inbound decision script (I) judges
  // replies under the campaign; one reply is judged off any campaign; one run of the history names no script.
  const A1 = "email_sent/dy_a/v1";
  const A2 = "email_sent/dy_a/v2";
  const B1 = "email_sent/dy_b/v1";
  const I1 = "email_reply_received/dy_inbound/v1";
  const book: LedgerPipeBook = {
    produced: [
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: A1, occurrences: 100, costUsd: 10, runStartDay: "2026-11-05" },
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: A2, occurrences: 100, costUsd: 8, runStartDay: "2026-11-08" },
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: B1, occurrences: 50, costUsd: 15, runStartDay: "2026-11-06" },
      // the inbound script judged 4 replies under c1: 3 answer A, 1 answers B
      { outcomeKey: "conversation", campaignId: "c1", workflowSlug: null, scriptSlug: I1, occurrences: 4, costUsd: 0.4, runStartDay: "2026-11-09" },
      { outcomeKey: "conversation", campaignId: null, workflowSlug: null, scriptSlug: null, occurrences: 1, costUsd: 0.1, runStartDay: "2026-11-09" },
      // history before runs named scripts
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: null, occurrences: 10, costUsd: 2, runStartDay: "2026-11-01" },
    ],
    noOutput: [{ campaignId: "c1", workflowSlug: null, scriptSlug: B1, costUsd: 5, runStartDay: "2026-11-06" }],
    consumed: [
      { consumerKey: "message_sent", consumedKey: "lead_found", campaignId: "c1", workflowSlug: null, scriptSlug: A1, sourceCampaignId: "s1", sourceWorkflowSlug: null, sourceScriptSlug: null, count: 100, runStartDay: "2026-11-05", sourceRunStartDay: "2026-11-04" },
      { consumerKey: "message_sent", consumedKey: "lead_found", campaignId: "c1", workflowSlug: null, scriptSlug: B1, sourceCampaignId: "s1", sourceWorkflowSlug: null, sourceScriptSlug: null, count: 50, runStartDay: "2026-11-06", sourceRunStartDay: "2026-11-04" },
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: I1, sourceCampaignId: "c1", sourceWorkflowSlug: null, sourceScriptSlug: A1, count: 3, runStartDay: "2026-11-09", sourceRunStartDay: "2026-11-05" },
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, scriptSlug: I1, sourceCampaignId: "c1", sourceWorkflowSlug: null, sourceScriptSlug: B1, count: 1, runStartDay: "2026-11-09", sourceRunStartDay: "2026-11-06" },
      // judged off campaign, answering A v2's send
      { consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, workflowSlug: null, scriptSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: null, sourceScriptSlug: A2, count: 1, runStartDay: "2026-11-09", sourceRunStartDay: "2026-11-08" },
    ],
  };
  const ids = new Set(["c1"]);

  it("a reply belongs to the script whose send it answers; versions pool in their dynasty", () => {
    const unit = offCampaignUnitCost("conversation", book);
    expect(unit).toBeCloseTo(0.1, 10);
    const m = pipeScriptCosts("conversation", ids, book);
    expect([...m.keys()]).toEqual(["email_reply_received/dy_inbound", "email_sent/dy_a", "email_sent/dy_b", SCRIPT_POOL]);
    // A: v1 + v2 sends, its 3 replies judged under c1 + 1 judged outside, each at the stage's unit cost
    expect(m.get("email_sent/dy_a")).toMatchObject({ outcomes: 4, inputs: 100 });
    expect(m.get("email_sent/dy_a")!.costUsd).toBeCloseTo(10 + 8 + 4 * 0.1, 10);
    // B: its send + its loss + 1 reply
    expect(m.get("email_sent/dy_b")).toMatchObject({ outcomes: 1, inputs: 50 });
    expect(m.get("email_sent/dy_b")!.costUsd).toBeCloseTo(15 + 5 + 0.1, 10);
    // the inbound script handed every reply it judged to the senders: no outcome, its judging cost gone with them
    expect(m.get("email_reply_received/dy_inbound")).toMatchObject({ outcomes: 0 });
    expect(m.get("email_reply_received/dy_inbound")!.costUsd).toBeCloseTo(0, 10);
    // the history naming no script stays one pool
    expect(m.get(SCRIPT_POOL)).toMatchObject({ outcomes: 0, costUsd: 2 });
  });

  it("every dollar and outcome once: the scripts sum to the pipe's one pool", () => {
    const pool = pipeScriptCost("conversation", ids, book)!;
    const parts = [...pipeScriptCosts("conversation", ids, book).values()];
    expect(parts.reduce((a, p) => a + p.costUsd, 0)).toBeCloseTo(pool.costUsd, 10);
    expect(parts.reduce((a, p) => a + p.outcomes, 0)).toBe(pool.outcomes);
  });

  it("per VERSION on demand; the mature cohort reads replies by the day the send ran", () => {
    const byVersion = pipeScriptCosts("conversation", ids, book, undefined, (s) => s ?? SCRIPT_POOL);
    expect(byVersion.get(A1)).toMatchObject({ outcomes: 3 });
    expect(byVersion.get(A2)).toMatchObject({ outcomes: 1 });
    const mature = pipeScriptCosts("conversation", ids, book, "2026-11-06");
    // sends of 11-05 (A v1) and 11-06 (B) only; A v2 ran 11-08
    expect(mature.get("email_sent/dy_a")).toMatchObject({ outcomes: 3 });
    expect(mature.get("email_sent/dy_a")!.costUsd).toBeCloseTo(10 + 3 * 0.1, 10);
    expect(mature.get("email_sent/dy_b")).toMatchObject({ outcomes: 1 });
  });

  it("a version name maps to its dynasty, no script to the pool", () => {
    expect(scriptDynastyOfSlug("email_sent/dy_cold_email/v12")).toBe("email_sent/dy_cold_email");
    expect(scriptDynastyOfSlug(null)).toBe(SCRIPT_POOL);
  });
});
