import { describe, it, expect, vi } from "vitest";

// `goal-arbitration` imports the workflow-projection route module, which transitively imports the DB
// module (it throws at import time without FEATURES_SERVICE_DATABASE_URL). Mock it so this pure-logic
// suite runs in CI, where no DB env is set.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { arbitrateGoals } = await import("./goal-arbitration.js");
const { GOALS } = await import("./goals.js");
type Evidence = Awaited<ReturnType<typeof import("../routes/workflow-projection.js")["fetchWorkflowProjectionEvidence"]>>;

// ── Fixture ──────────────────────────────────────────────────────────────────
// Two active dynasties, crossOrg grain only (no brand/audience spend unless a test adds it):
//   dyn-a  $1000 / 100 clicks / 50 replies / 200 contacted  → click $10,  reply $20
//   dyn-b  $1000 /  10 clicks / 100 replies / 200 contacted → click $100, reply $10
// So the cheapest CLICK workflow (dyn-a) and the cheapest REPLY workflow (dyn-b) are DIFFERENT — the
// best workflow genuinely depends on which goal wins.

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

const goals = (...names: Array<(typeof GOALS)[number]>) => names.map((goal) => ({ goal, economics: null }));

const run = (authorized: ReturnType<typeof goals>, over: Partial<Evidence> = {}, economics: unknown = ECONOMICS) =>
  arbitrateGoals({
    featureSlug: "sales-cold-email-outreach",
    authorizedGoals: authorized,
    evidence: evidence(over),
    economics: economics as never,
  });

const candidate = (res: ReturnType<typeof run>, goal: string) => res.candidates.find((c) => c.goal === goal)!;

describe("arbitrateGoals — which authorized goal returns the most per dollar", () => {
  it("elects the goal with the highest return per dollar, and ITS best workflow (not the other goal's)", () => {
    const res = run(goals("signup", "positiveReply"));

    expect(res.arbitration.status).toBe("resolved");
    expect(res.arbitration.goal).toBe("positiveReply");
    expect(res.arbitration.objective).toBe("positive_replies");
    expect(res.arbitration.reason).toBeNull();
    // reply cost $10 on dyn-b ÷ 25% = $40 per paid client; $1000 LTR / $40 = 25× per dollar.
    expect(res.arbitration.returnPerDollar).toBeCloseTo(25, 6);
    expect(res.arbitration.costPerPaidClientUsd).toBeCloseTo(40, 6);
    // positiveReply's outcome cost IS the reply cost (single-step goal).
    expect(res.arbitration.costPerOutcomeUsd).toBeCloseTo(10, 6);
    expect(res.workflow?.workflowDynastySlug).toBe("dyn-b");
    expect(res.workflow?.workflowDynastyName).toBe("Dynasty B");
    expect(res.recommendedBudgetUsd).toBeCloseTo(100, 6); // 10 target outcomes × $10

    // The loser is still scored, on ITS OWN best workflow — the cheapest-click one, not dyn-b.
    const signup = candidate(res, "signup");
    expect(signup.rankable).toBe(true);
    expect(signup.returnPerDollar).toBeCloseTo(2, 6);
    expect(signup.workflow?.workflowDynastySlug).toBe("dyn-a");
  });

  it("each goal's own economics decide it: a per-funnel lifetime revenue can flip the winner", () => {
    const res = arbitrateGoals({
      featureSlug: "sales-cold-email-outreach",
      authorizedGoals: [
        // The brand states this funnel sells a $100k contract; the reply funnel keeps the $1000 base.
        { goal: "signup", economics: { lifetimeRevenueUsd: 100_000 } },
        { goal: "positiveReply", economics: null },
      ],
      evidence: evidence(),
      economics: ECONOMICS as never,
    });

    expect(res.arbitration.goal).toBe("signup");
    expect(res.arbitration.returnPerDollar).toBeCloseTo(200, 6); // 100000 / 500
    expect(res.workflow?.workflowDynastySlug).toBe("dyn-a");
    expect(candidate(res, "signup").usesFunnelEconomics).toBe(true);
    expect(candidate(res, "positiveReply").usesFunnelEconomics).toBe(false);
    expect(candidate(res, "positiveReply").returnPerDollar).toBeCloseTo(25, 6);
  });

  it("a goal with NO defined return is never elected — it is reported as an unrankable candidate", () => {
    const res = run(goals("whatsappConversation", "signup"));

    const whatsapp = candidate(res, "whatsappConversation");
    expect(whatsapp.rankable).toBe(false);
    expect(whatsapp.unrankableReason).toBe("no_paid_client_path");
    expect(whatsapp.returnPerDollar).toBeNull();
    // It still reports what IS known (its own outcome cost + workflow) — the return is what is undefined.
    expect(whatsapp.costPerOutcomeUsd).toBeCloseTo(10, 6);
    expect(whatsapp.costPerPaidClientUsd).toBeNull();

    expect(res.arbitration.status).toBe("resolved");
    expect(res.arbitration.goal).toBe("signup");
  });

  it("a brand whose ONLY authorized goal has no return reports unrankable, distinguishably, not a winner", () => {
    const res = run(goals("whatsappConversation"));

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.goal).toBeNull();
    expect(res.arbitration.reason).toBe("no_rankable_goal");
    expect(res.arbitration.returnPerDollar).toBeNull();
    expect(res.workflow).toBeNull();
    expect(res.rows).toEqual([]);
    expect(res.recommendedBudgetUsd).toBeNull();
    // The reason is not hidden: the per-goal verdict says WHY.
    expect(candidate(res, "whatsappConversation").unrankableReason).toBe("no_paid_client_path");
  });

  it("an EMPTY authorized set is its own verdict, distinct from 'nothing ranked'", () => {
    const res = run([]);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_authorized_goals");
    expect(res.authorizedGoals).toEqual([]);
    expect(res.candidates).toEqual([]);
    expect(res.rows).toEqual([]);
  });

  it("no economics → every goal is unrankable for that reason (never a fabricated return)", () => {
    const res = run(goals("signup", "positiveReply"), {}, null);

    expect(res.arbitration.status).toBe("unrankable");
    expect(res.arbitration.reason).toBe("no_rankable_goal");
    expect(res.candidates.map((c) => c.unrankableReason)).toEqual(["no_economics", "no_economics"]);
    expect(res.economics).toBeNull();
  });

  it("no workflow evidence at all → unrankable for that reason, not a $0 winner", () => {
    const res = run(goals("positiveReply"), { crossOrgCostGroups: [], crossOrgEmailStats: [] });

    expect(res.arbitration.status).toBe("unrankable");
    expect(candidate(res, "positiveReply").unrankableReason).toBe("no_workflow_evidence");
  });

  it("is stable: the authorized ORDER cannot change the winner, and a tie breaks on the canonical goal order", () => {
    const forward = run(goals("signup", "positiveReply"));
    const reversed = run(goals("positiveReply", "signup"));
    expect(reversed.arbitration.goal).toBe(forward.arbitration.goal);
    expect(reversed.arbitration.returnPerDollar).toBe(forward.arbitration.returnPerDollar);
    // Candidates keep the producer's order (the ranking never reorders the brand's own statement).
    expect(reversed.candidates.map((c) => c.goal)).toEqual(["positiveReply", "signup"]);

    // ONE dynasty + a reply→paid rate tuned so both goals return exactly 2× — the tie must not be
    // decided by input order. GOALS puts signup before positiveReply.
    const single = {
      workflows: [wf("wf-a", "dyn-a", "Dynasty A")],
      crossOrgCostGroups: [cost("wf-a", 100_000)],
      crossOrgEmailStats: [["wf-a", stats(200, 100, 50)]],
    } as Partial<Evidence>;
    const tiedEconomics = { ...ECONOMICS, replyToPaidClientPct: 4 }; // $20 reply / 4% = $500 = signup's
    const tieA = run(goals("signup", "positiveReply"), single, tiedEconomics);
    const tieB = run(goals("positiveReply", "signup"), single, tiedEconomics);
    expect(tieA.arbitration.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieB.arbitration.returnPerDollar).toBeCloseTo(2, 6);
    expect(tieA.arbitration.goal).toBe("signup");
    expect(tieB.arbitration.goal).toBe("signup");
    expect(GOALS.indexOf("signup")).toBeLessThan(GOALS.indexOf("positiveReply"));
  });

  it("returns the winning PAIRING's rows only — the brand row plus every audience row for that dynasty", () => {
    const res = run(goals("positiveReply"), {
      audienceEvidence: [
        {
          audienceId: "aud-1",
          byDynasty: [["dyn-b", { totalCostInUsdCents: 20_000, completedRuns: 2, contacted: 40, clicks: 4, replies: 20 }]],
        },
        { audienceId: "aud-2", byDynasty: [] },
      ],
    });

    expect(res.arbitration.goal).toBe("positiveReply");
    expect(res.workflow?.workflowDynastySlug).toBe("dyn-b");
    // Every returned row belongs to the winning dynasty — no dyn-a noise for the consumer to filter.
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

  it("echoes the authorized set it ranked, canonical camel, in the producer's order", () => {
    const res = run(goals("positiveReply", "signup", "whatsappConversation"));
    expect(res.authorizedGoals).toEqual(["positiveReply", "signup", "whatsappConversation"]);
  });
});
