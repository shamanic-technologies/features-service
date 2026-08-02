import { describe, it, expect, vi } from "vitest";

// `goal-arbitration` imports the workflow-projection route module, which transitively imports the DB
// module (it throws at import time without FEATURES_SERVICE_DATABASE_URL). Mock it so this pure-logic
// suite runs in CI, where no DB env is set.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { rankDeclaredFunnels } = await import("./goal-arbitration.js");
const { GOALS } = await import("./goals.js");
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

// LTR $1000. signup: click $10 / (4% × 50%) = $500 per paid client → return 2.
// positiveReply: reply / 25% → dyn-a $80 (return 12.5), dyn-b $40 (return 25).
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
  visitToPaidClientPct: 5,
  replyToPaidClientPct: 25,
};

type Goal = (typeof GOALS)[number];

/** One declared funnel to rank; the key defaults to the goal name so tests stay readable. */
const f = (goal: Goal, over: { funnelKey?: string; name?: string; economics?: Record<string, number> } = {}) => ({
  funnelKey: over.funnelKey ?? `${goal}_funnel`,
  name: over.name ?? `${goal} funnel`,
  goal,
  economics: over.economics ?? null,
});

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
  it("RANKS every declared funnel, best return first, and names the head as a recommendation", () => {
    const res = run([f("signup"), f("positiveReply")]);

    // The ranking IS the answer: an ordered comparison, not just a winner.
    expect(res.ranking.map((r) => r.funnelKey)).toEqual(["positiveReply_funnel", "signup_funnel"]);
    expect(res.ranking.map((r) => r.rank)).toEqual([1, 2]);
    // reply cost $10 on dyn-b ÷ 25% = $40 per paid client; $1000 LTR / $40 = 25× per dollar.
    expect(res.ranking[0].returnPerDollar).toBeCloseTo(25, 6);
    // The runner-up is scored on ITS OWN best workflow — the cheapest-click one, not dyn-b.
    expect(res.ranking[1].returnPerDollar).toBeCloseTo(2, 6);
    expect(res.ranking[1].workflow?.workflowDynastySlug).toBe("dyn-a");

    expect(res.recommendation?.funnelKey).toBe("positiveReply_funnel");
    expect(res.recommendation?.goal).toBe("positiveReply");
    expect(res.recommendation?.returnPerDollar).toBeCloseTo(25, 6);
    expect(res.recommendation?.workflow.workflowDynastySlug).toBe("dyn-b");
    expect(res.recommendedBudgetUsd).toBeCloseTo(100, 6); // 10 target outcomes × $10
  });

  it("the compatibility `arbitration` view can never name a funnel other than the head of the ranking", () => {
    const res = run([f("signup"), f("positiveReply")]);

    expect(res.arbitration.status).toBe("resolved");
    expect(res.arbitration.goal).toBe(res.ranking[0].goal);
    expect(res.arbitration.objective).toBe(res.ranking[0].objective);
    expect(res.arbitration.reason).toBeNull();
    expect(res.arbitration.returnPerDollar).toBe(res.ranking[0].returnPerDollar);
    expect(res.arbitration.costPerOutcomeUsd).toBe(res.ranking[0].costPerOutcomeUsd);
    expect(res.arbitration.costPerPaidClientUsd).toBe(res.ranking[0].costPerPaidClientUsd);
    expect(res.arbitration.grain).toBe(res.ranking[0].grain);
    expect(res.workflow).toEqual(res.ranking[0].workflow);
  });

  it("TWO FUNNELS ON ONE GOAL are ranked separately, each on its own declared terms", () => {
    // The two routes to a booked meeting carry their own budgets, so they must compare as two rows.
    const res = run([
      f("meetingBooked", { funnelKey: "reply_meeting", economics: { lifetimeRevenueUsd: 20_000 } }),
      f("meetingBooked", { funnelKey: "visit_meeting", economics: { lifetimeRevenueUsd: 2_000 } }),
    ]);

    expect(res.ranking).toHaveLength(2);
    expect(res.ranking.map((r) => r.funnelKey)).toEqual(["reply_meeting", "visit_meeting"]);
    expect(res.ranking.map((r) => r.rank)).toEqual([1, 2]);
    // Same goal, same evidence, same best workflow — only the funnel's own lifetime revenue differs,
    // so the richer contract returns 10× more per dollar and the customer can see exactly that.
    expect(res.ranking[0].returnPerDollar! / res.ranking[1].returnPerDollar!).toBeCloseTo(10, 6);
    expect(res.recommendation?.funnelKey).toBe("reply_meeting");
  });

  it("each funnel's own economics decide it: a per-funnel lifetime revenue can flip the head", () => {
    const res = run([
      // The brand states this funnel sells a $100k contract; the reply funnel keeps the $1000 base.
      f("signup", { economics: { lifetimeRevenueUsd: 100_000 } }),
      f("positiveReply"),
    ]);

    expect(res.recommendation?.goal).toBe("signup");
    expect(res.recommendation?.returnPerDollar).toBeCloseTo(200, 6); // 100000 / 500
    expect(res.recommendation?.workflow.workflowDynastySlug).toBe("dyn-a");
    expect(entry(res, "signup_funnel").usesFunnelEconomics).toBe(true);
    expect(entry(res, "positiveReply_funnel").usesFunnelEconomics).toBe(false);
    expect(entry(res, "positiveReply_funnel").returnPerDollar).toBeCloseTo(25, 6);
  });

  it("a funnel with NO defined return is listed with its reason, ranked last, never dropped", () => {
    const res = run([f("whatsappConversation"), f("signup")]);

    // Both funnels are present — a customer comparing their funnels never sees a short list.
    expect(res.ranking).toHaveLength(2);
    const whatsapp = entry(res, "whatsappConversation_funnel");
    expect(res.ranking[res.ranking.length - 1]).toBe(whatsapp);
    expect(whatsapp.rank).toBeNull();
    expect(whatsapp.rankable).toBe(false);
    expect(whatsapp.unrankableReason).toBe("no_paid_client_path");
    expect(whatsapp.returnPerDollar).toBeNull();
    // It still reports what IS known (its own outcome cost + workflow) — the return is what is undefined.
    expect(whatsapp.costPerOutcomeUsd).toBeCloseTo(10, 6);
    expect(whatsapp.costPerPaidClientUsd).toBeNull();

    expect(res.recommendation?.goal).toBe("signup");
  });

  it("a funnel with no history yet is listed too — 'nothing to compare on' is an answer, not a hole", () => {
    // No workflow evidence at all: every funnel is unrankable for that reason, and each says so.
    const res = run([f("positiveReply"), f("signup")], { crossOrgCostGroups: [], crossOrgEmailStats: [] });

    expect(res.ranking.map((r) => r.funnelKey)).toEqual(["positiveReply_funnel", "signup_funnel"]);
    expect(res.ranking.every((r) => r.unrankableReason === "no_workflow_evidence")).toBe(true);
    expect(res.ranking.every((r) => r.rank === null)).toBe(true);
    expect(res.recommendation).toBeNull();
    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_rankable_funnel");
  });

  it("a brand whose ONLY funnel has no return reports unrankable, distinguishably, not a winner", () => {
    const res = run([f("whatsappConversation")]);

    expect(res.arbitration.status).toBe("unrankable");
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
    const res = run([f("signup"), f("positiveReply")], {}, null);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_rankable_funnel");
    expect(res.ranking.map((r) => r.unrankableReason)).toEqual(["no_economics", "no_economics"]);
    expect(res.economics).toBeNull();
  });

  it("is stable: the declared ORDER cannot change the ranking, and a tie breaks canonically", () => {
    const forward = run([f("signup"), f("positiveReply")]);
    const reversed = run([f("positiveReply"), f("signup")]);
    expect(reversed.ranking.map((r) => r.funnelKey)).toEqual(forward.ranking.map((r) => r.funnelKey));
    expect(reversed.recommendation?.returnPerDollar).toBe(forward.recommendation?.returnPerDollar);

    // ONE dynasty + a reply→paid rate tuned so both funnels return exactly 2× — the tie must not be
    // decided by input order. GOALS puts signup before positiveReply.
    const single = {
      workflows: [wf("wf-a", "dyn-a", "Dynasty A")],
      crossOrgCostGroups: [cost("wf-a", 100_000)],
      crossOrgEmailStats: [["wf-a", stats(200, 100, 50)]],
    } as Partial<Evidence>;
    const tiedEconomics = { ...ECONOMICS, replyToPaidClientPct: 4 }; // $20 reply / 4% = $500 = signup's
    const tieA = run([f("signup"), f("positiveReply")], single, tiedEconomics);
    const tieB = run([f("positiveReply"), f("signup")], single, tiedEconomics);
    expect(tieA.recommendation?.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieB.recommendation?.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieA.recommendation?.goal).toBe("signup");
    expect(tieB.recommendation?.goal).toBe("signup");
    expect(GOALS.indexOf("signup")).toBeLessThan(GOALS.indexOf("positiveReply"));

    // Two funnels on ONE goal with identical terms tie on return too — funnelKey settles it.
    const twins = run(
      [f("signup", { funnelKey: "z_funnel" }), f("signup", { funnelKey: "a_funnel" })],
      single,
      tiedEconomics,
    );
    expect(twins.ranking.map((r) => r.funnelKey)).toEqual(["a_funnel", "z_funnel"]);
  });

  it("returns the recommended PAIRING's rows only — the brand row plus every audience row for it", () => {
    const res = run([f("positiveReply")], {
      audienceEvidence: [
        {
          audienceId: "aud-1",
          byDynasty: [["dyn-b", { totalCostInUsdCents: 20_000, completedRuns: 2, contacted: 40, clicks: 4, replies: 20 }]],
        },
        { audienceId: "aud-2", byDynasty: [] },
      ],
    });

    expect(res.recommendation?.goal).toBe("positiveReply");
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
    // positiveReply's resolved outcome count IS the observed replies.
    expect(withEvidence.estimatesByGrain.audience?.resolvedOutcomeCount).toBe(20);
    // A never-run audience has no audience grain (a cold arm) but still resolves via the cascade.
    const coldArm = res.rows.find((r) => r.audienceId === "aud-2")!;
    expect(coldArm.estimatesByGrain.audience).toBeUndefined();
    expect(coldArm.resolved.costPerOutcomeUsd).toBeCloseTo(10, 6);
  });

  it("ranks on HISTORY alone — it takes no funding input and offers no way to pass one", () => {
    // Being unfunded is a decision the customer just made, not a reason to hide how a funnel
    // performed. The signature carries funnels + evidence + economics and nothing else, so there is
    // no place a budget or a funded-flag could enter this computation.
    const res = run([f("signup"), f("positiveReply")]);
    expect(res.ranking).toHaveLength(2);
    expect(res.ranking.every((r) => r.rankable)).toBe(true);
    expect(Object.keys(res.ranking[0])).not.toContain("funded");
    expect(Object.keys(res.ranking[0])).not.toContain("budget");
    expect(Object.keys(res.ranking[0])).not.toContain("ceilingCents");
  });
});
