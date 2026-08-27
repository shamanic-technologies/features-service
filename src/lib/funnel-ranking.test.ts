import { describe, it, expect, vi } from "vitest";

// `funnel-ranking` imports the workflow-projection route module, which transitively imports the DB
// module (it throws at import time without FEATURES_SERVICE_DATABASE_URL). Mock it so this pure-logic
// suite runs in CI, where no DB env is set.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { rankDeclaredFunnels } = await import("./funnel-ranking.js");
const { SALES_FUNNEL_KEYS } = await import("./sales-funnels.js");
type Evidence = Awaited<ReturnType<typeof import("../routes/workflow-projection.js")["fetchWorkflowProjectionEvidence"]>>;

// ── Fixture ──────────────────────────────────────────────────────────────────
// Two active dynasties, crossOrg grain only (no brand/audience spend unless a test adds it):
//   dyn-a  $1000 / 100 clicks / 50 replies / 200 contacted  → click $10,  reply $20
//   dyn-b  $1000 /  10 clicks / 100 replies / 200 contacted → click $100, reply $10
// So the cheapest CLICK workflow (dyn-a) and the cheapest REPLY workflow (dyn-b) are DIFFERENT — the
// best workflow genuinely depends on which funnel is being priced.

function wf(slug: string, dynasty: string, name: string) {
  return {
    id: `id-${slug}`,
    workflowSlug: slug,
    workflowName: name,
    workflowDynastyName: name,
    workflowDynastySlug: dynasty,
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
  };
}

const cost = (slug: string, cents: number) => ({
  dimensions: { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 10,
  minStartedAt: null,
  maxStartedAt: null,
});

const stats = (contacted: number, clicked: number, replies: number): Record<string, number> => ({
  recipientsContacted: contacted,
  recipientsClicked: clicked,
  recipientsRepliesPositive: replies,
});

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    workflows: [wf("wf-a", "dyn-a", "Dynasty A"), wf("wf-b", "dyn-b", "Dynasty B")],
    crossOrgCostGroups: [cost("wf-a", 100_000), cost("wf-b", 100_000)],
    crossOrgEmailStats: [
      ["wf-a", stats(200, 100, 50)],
      ["wf-b", stats(200, 10, 100)],
    ],
    brandGrain: [],
    audienceEvidence: [],
    ...over,
  } as Evidence;
}

// LTR $1000. Against the fixture above, each funnel prices on ITS OWN funnel:
//   website_purchases                 click $10 / 10%         = $100 per signup  → /20%  = $500  → return 2
//   form_magnet                       click $10 / 10%         = $100 per form    → /20%  = $500  → return 2
//   sales_meetings_from_website       click $10 / 5%          = $200 per meeting → /30%  = $666.67 → return 1.5
//   sales_meetings_from_conversation  reply $10 / 40% (dyn-b) = $25  per meeting → /30%  = $83.33  → return 12
// The last two share the `meetingBooked` goal echo and are eight times apart — the whole point.
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 10,
  signupToPaidClientPct: 20,
  visitToPaidClientPct: 5,
  replyToPaidClientPct: 25,
  visitToFormSubmissionPct: 10,
  formSubmissionToPaidClientPct: 20,
};

type FunnelKey = (typeof SALES_FUNNEL_KEYS)[number];

/** One declared funnel to rank, named the way brand-service names it. */
const f = (funnelKey: FunnelKey, over: { name?: string; economics?: Record<string, number> } = {}) => ({
  funnelKey,
  name: over.name ?? funnelKey,
  economics: over.economics ?? null,
});

const CONVERSATION = "sales_meetings_from_conversation" as const;
const WEBSITE_MEETING = "sales_meetings_from_website" as const;
const PURCHASES = "website_purchases" as const;
const FORM = "form_magnet" as const;

const run = (
  funnels: ReturnType<typeof f>[],
  over: Partial<Evidence> = {},
  economics: unknown = ECONOMICS,
) =>
  rankDeclaredFunnels({
    featureSlug: "sales-cold-email-outreach",
    funnels: funnels as never,
    evidence: evidence(over),
    economics: economics as never,
  });

const entry = (res: ReturnType<typeof run>, funnelKey: string) =>
  res.ranking.find((r) => r.funnelKey === funnelKey)!;

describe("rankDeclaredFunnels — which declared funnel returns the most per dollar", () => {
  it("prices the TWO MEETING FUNNELS APART — same evidence, same economics, different channel", () => {
    // This is the retirement's whole reason for existing. Both funnels end in a booked meeting and both
    // echo the `meetingBooked` goal, so a goal-keyed score gave them ONE blended both-channel price and
    // the customer could not see which of the two to fund. Priced on their own channel:
    //   conversation → reply $10 (dyn-b) / 40% = $25 per meeting
    //   website      → click $10 (dyn-a) /  5% = $200 per meeting
    const res = run([f(CONVERSATION), f(WEBSITE_MEETING)]);

    const conversation = entry(res, CONVERSATION);
    const website = entry(res, WEBSITE_MEETING);
    expect(conversation.costPerOutcomeUsd).toBeCloseTo(25, 6);
    expect(website.costPerOutcomeUsd).toBeCloseTo(200, 6);
    expect(conversation.costPerOutcomeUsd).not.toBe(website.costPerOutcomeUsd);
    // ...and they are bought from DIFFERENT workflows, which a blended price could never have shown:
    // dyn-b is the cheapest-reply dynasty, dyn-a the cheapest-click one.
    expect(conversation.workflow?.workflowDynastySlug).toBe("dyn-b");
    expect(website.workflow?.workflowDynastySlug).toBe("dyn-a");
    // The goal ECHO is identical on both rows — proof the echo cannot be read as the row's identity.
    expect(conversation.goal).toBe("meetingBooked");
    expect(website.goal).toBe("meetingBooked");
    // Return per dollar: 1000 / (25 / 30%) = 12 vs 1000 / (200 / 30%) = 1.5.
    expect(conversation.returnPerDollar).toBeCloseTo(12, 6);
    expect(website.returnPerDollar).toBeCloseTo(1.5, 6);
    expect(res.recommendation?.funnelKey).toBe(CONVERSATION);
  });

  it("a channel-scoped funnel counts outcomes on ITS channel only — cost and count stay one basis", () => {
    // dyn-b observed 10 clicks and 100 replies. The conversation funnel must not read the clicks.
    const res = run([f(CONVERSATION)]);
    const row = res.rows.find((r) => r.audienceId === null)!;
    const grain = row.estimatesByGrain.crossOrg!;
    // expected meetings = replies × replyToMeeting = 100 × 40% = 40; $1000 spend / 40 = $25 = the cost.
    expect(grain.resolvedOutcomeCount).toBeCloseTo(40, 6);
    expect(row.resolved.costPerOutcomeUsd).toBeCloseTo(25, 6);
    expect(grain.evidence.spentUsd / grain.resolvedOutcomeCount!).toBeCloseTo(row.resolved.costPerOutcomeUsd!, 6);
  });

  it("a funnel whose OWN channel produced nothing is not laundered by the other one's evidence", () => {
    // dyn-a alone, with every reply stripped: the conversation funnel has observed nothing about itself.
    // A both-channel blend would have quietly priced it off the 100 clicks; on its own channel it floors
    // to the grain's spend, and is LABELLED a benchmark rather than "this brand's own results".
    const noReplies = {
      workflows: [wf("wf-a", "dyn-a", "Dynasty A")],
      crossOrgCostGroups: [cost("wf-a", 100_000)],
      crossOrgEmailStats: [["wf-a", stats(200, 100, 0)]],
    } as Partial<Evidence>;
    const res = run([f(CONVERSATION)], noReplies);
    const row = res.rows.find((r) => r.audienceId === null) ?? null;
    expect(entry(res, CONVERSATION).grain).toBe("crossOrg");
    expect(row?.estimatesByGrain.crossOrg?.resolvedOutcomeCount).toBe(0);
    // $1000 spend floored, then divided by the 40% reply→meeting rate — never a click-derived number.
    expect(entry(res, CONVERSATION).costPerOutcomeUsd).toBeCloseTo(2500, 6);
  });

  it("RANKS every declared funnel, best return first, and names the head as a recommendation", () => {
    const res = run([f(PURCHASES), f(CONVERSATION)]);

    // The ranking IS the answer: an ordered comparison, not just a winner.
    expect(res.ranking.map((r) => r.funnelKey)).toEqual([CONVERSATION, PURCHASES]);
    expect(res.ranking.map((r) => r.rank)).toEqual([1, 2]);
    expect(res.ranking[0].returnPerDollar).toBeCloseTo(12, 6);
    // The runner-up is scored on ITS OWN best workflow — the cheapest-click one, not dyn-b.
    expect(res.ranking[1].returnPerDollar).toBeCloseTo(2, 6);
    expect(res.ranking[1].workflow?.workflowDynastySlug).toBe("dyn-a");

    expect(res.recommendation?.funnelKey).toBe(CONVERSATION);
    expect(res.recommendation?.goal).toBe("meetingBooked");
    expect(res.recommendation?.returnPerDollar).toBeCloseTo(12, 6);
    expect(res.recommendation?.workflow.workflowDynastySlug).toBe("dyn-b");
    expect(res.recommendedBudgetUsd).toBeCloseTo(250, 6); // 10 target outcomes × $25
  });

  it("the compatibility `arbitration` view can never name a funnel other than the head of the ranking", () => {
    const res = run([f(PURCHASES), f(CONVERSATION)]);

    expect(res.arbitration.status).toBe("resolved");
    // The unambiguous half — a consumer reading only `goal` cannot tell the two meeting funnels apart.
    expect(res.arbitration.funnelKey).toBe(res.ranking[0].funnelKey);
    expect(res.arbitration.goal).toBe(res.ranking[0].goal);
    expect(res.arbitration.objective).toBe(res.ranking[0].objective);
    expect(res.arbitration.reason).toBeNull();
    expect(res.arbitration.returnPerDollar).toBe(res.ranking[0].returnPerDollar);
    expect(res.arbitration.costPerOutcomeUsd).toBe(res.ranking[0].costPerOutcomeUsd);
    expect(res.arbitration.costPerPaidClientUsd).toBe(res.ranking[0].costPerPaidClientUsd);
    expect(res.arbitration.grain).toBe(res.ranking[0].grain);
    expect(res.workflow).toEqual(res.ranking[0].workflow);
  });

  it("each funnel's own economics decide it: a per-funnel lifetime revenue can flip the head", () => {
    const res = run([
      // The brand states this funnel sells a $100k contract; the meeting funnel keeps the $1000 base.
      f(PURCHASES, { economics: { lifetimeRevenueUsd: 100_000 } }),
      f(CONVERSATION),
    ]);

    expect(res.recommendation?.funnelKey).toBe(PURCHASES);
    expect(res.recommendation?.returnPerDollar).toBeCloseTo(200, 6); // 100000 / 500
    expect(res.recommendation?.workflow.workflowDynastySlug).toBe("dyn-a");
    expect(entry(res, PURCHASES).usesFunnelEconomics).toBe(true);
    expect(entry(res, CONVERSATION).usesFunnelEconomics).toBe(false);
    expect(entry(res, CONVERSATION).returnPerDollar).toBeCloseTo(12, 6);
  });

  it("a funnel with NO defined return is listed with its reason, ranked last, never dropped", () => {
    // A funnel the brand priced at a 0% close: there is no path to a paying client through it, which is
    // not the same as it being free. Note the goal-keyed score used to hide exactly this behind the
    // other channel's contribution to the same blended figure.
    const res = run([f(CONVERSATION, { economics: { meetingToClosePct: 0 } }), f(PURCHASES)]);

    // Both funnels are present — a customer comparing their funnels never sees a short list.
    expect(res.ranking).toHaveLength(2);
    const dead = entry(res, CONVERSATION);
    expect(res.ranking[res.ranking.length - 1]).toBe(dead);
    expect(dead.rank).toBeNull();
    expect(dead.rankable).toBe(false);
    expect(dead.unrankableReason).toBe("no_paid_client_path");
    expect(dead.returnPerDollar).toBeNull();
    // It still reports what IS known (its own outcome cost + workflow) — the return is what is undefined.
    expect(dead.costPerOutcomeUsd).toBeCloseTo(25, 6);
    expect(dead.costPerPaidClientUsd).toBeNull();

    expect(res.recommendation?.funnelKey).toBe(PURCHASES);
  });

  it("a funnel with no history yet is listed too — 'nothing to compare on' is an answer, not a hole", () => {
    // No workflow evidence at all: every funnel is unrankable for that reason, and each says so.
    const res = run([f(CONVERSATION), f(PURCHASES)], { crossOrgCostGroups: [], crossOrgEmailStats: [] });

    expect(res.ranking.map((r) => r.funnelKey)).toEqual([CONVERSATION, PURCHASES]);
    expect(res.ranking.every((r) => r.unrankableReason === "no_workflow_evidence")).toBe(true);
    expect(res.ranking.every((r) => r.rank === null)).toBe(true);
    expect(res.recommendation).toBeNull();
    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_rankable_funnel");
  });

  it("a brand whose ONLY funnel has no return reports unrankable, distinguishably, not a winner", () => {
    const res = run([f(CONVERSATION, { economics: { meetingToClosePct: 0 } })]);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.funnelKey).toBeNull();
    expect(res.arbitration.goal).toBeNull();
    expect(res.arbitration.reason).toBe("no_rankable_funnel");
    expect(res.recommendation).toBeNull();
    expect(res.workflow).toBeNull();
    expect(res.rows).toEqual([]);
    expect(res.recommendedBudgetUsd).toBeNull();
    // The reason is not hidden: the per-funnel verdict says WHY.
    expect(res.ranking[0].unrankableReason).toBe("no_paid_client_path");
  });

  it("NO declared funnel is its own verdict, distinct from 'nothing ranked'", () => {
    const res = run([]);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_declared_funnels");
    expect(res.ranking).toEqual([]);
    expect(res.recommendation).toBeNull();
    expect(res.rows).toEqual([]);
  });

  it("no economics → every funnel is unrankable for that reason (never a fabricated return)", () => {
    const res = run([f(PURCHASES), f(CONVERSATION)], {}, null);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_rankable_funnel");
    expect(res.ranking.map((r) => r.unrankableReason)).toEqual(["no_economics", "no_economics"]);
    expect(res.economics).toBeNull();
  });

  it("is stable: the declared ORDER cannot change the ranking, and a tie breaks canonically", () => {
    const forward = run([f(PURCHASES), f(CONVERSATION)]);
    const reversed = run([f(CONVERSATION), f(PURCHASES)]);
    expect(reversed.ranking.map((r) => r.funnelKey)).toEqual(forward.ranking.map((r) => r.funnelKey));
    expect(reversed.recommendation?.returnPerDollar).toBe(forward.recommendation?.returnPerDollar);

    // website_purchases and form_magnet both cost $10/leg¹ ÷ leg² = $500 per paid client on this
    // fixture, so both return exactly 2× and the tie must be settled by the catalogue order rather
    // than by input order.
    const tieA = run([f(PURCHASES), f(FORM)]);
    const tieB = run([f(FORM), f(PURCHASES)]);
    expect(tieA.recommendation?.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieB.recommendation?.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieA.ranking.map((r) => r.funnelKey)).toEqual([PURCHASES, FORM]);
    expect(tieB.ranking.map((r) => r.funnelKey)).toEqual([PURCHASES, FORM]);
    expect(SALES_FUNNEL_KEYS.indexOf(PURCHASES)).toBeLessThan(SALES_FUNNEL_KEYS.indexOf(FORM));
  });

  it("returns the recommended PAIRING's rows only — the brand row plus every audience row for it", () => {
    const res = run([f(CONVERSATION)], {
      audienceEvidence: [
        {
          audienceId: "aud-1",
          byDynasty: [["dyn-b", { totalCostInUsdCents: 20_000, completedRuns: 2, contacted: 40, clicks: 4, replies: 20 }]],
        },
        { audienceId: "aud-2", byDynasty: [] },
      ],
    });

    expect(res.recommendation?.funnelKey).toBe(CONVERSATION);
    expect(res.workflow?.workflowDynastySlug).toBe("dyn-b");
    // Every returned row belongs to the recommended dynasty — no dyn-a noise for the consumer to filter.
    expect(res.rows.every((r) => r.workflow.workflowDynastySlug === "dyn-b")).toBe(true);
    expect(res.rows.filter((r) => r.audienceId === null)).toHaveLength(1);

    // BOTH active audiences are present (the one with attributed evidence and the one without), which is
    // what lets the audience bandit see every arm rather than only the ones that already ran.
    const audienceIds = res.rows.filter((r) => r.audienceId !== null).map((r) => r.audienceId).sort();
    expect(audienceIds).toEqual(["aud-1", "aud-2"]);

    // The bandit's inputs ride the existing row shape: trials, successes, cost.
    const withEvidence = res.rows.find((r) => r.audienceId === "aud-1")!;
    expect(withEvidence.estimatesByGrain.audience?.evidence.observedContacted).toBe(40);
    expect(withEvidence.estimatesByGrain.audience?.evidence.spentUsd).toBeCloseTo(200, 6);
    // The conversation funnel's resolved count is replies × replyToMeeting = 20 × 40% = 8.
    expect(withEvidence.estimatesByGrain.audience?.resolvedOutcomeCount).toBeCloseTo(8, 6);
    // A never-run audience has no audience grain (a cold arm) but still resolves via the cascade.
    const coldArm = res.rows.find((r) => r.audienceId === "aud-2")!;
    expect(coldArm.estimatesByGrain.audience).toBeUndefined();
    expect(coldArm.resolved.costPerOutcomeUsd).toBeCloseTo(25, 6);
  });

  it("ranks on HISTORY alone — it takes no funding input and offers no way to pass one", () => {
    // Being unfunded is a decision the customer just made, not a reason to hide how a funnel
    // performed. The signature carries funnels + evidence + economics and nothing else, so there is
    // no place a budget or a funded-flag could enter this computation.
    const res = run([f(PURCHASES), f(CONVERSATION)]);
    expect(res.ranking).toHaveLength(2);
    expect(res.ranking.every((r) => r.rankable)).toBe(true);
    expect(Object.keys(res.ranking[0])).not.toContain("funded");
    expect(Object.keys(res.ranking[0])).not.toContain("budget");
    expect(Object.keys(res.ranking[0])).not.toContain("ceilingCents");
  });
});
