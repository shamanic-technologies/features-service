/**
 * ONE FIXTURE, SHAPED LIKE THE CAMPAIGN THAT REPORTED IT, and every case asserts a DIVERGENCE.
 *
 * Brand `a179bbd9…` / campaign `3922c8e1…` / leg `start_to_conversation`, measured in prod 2026-09-13:
 * `azalea` produced **4 conversations on $310.73**, `tango` — the workflow the campaign currently
 * runs — produced **none on $127.27**, and `alioth` sits at the **$21.22** cross-org explore floor
 * with nothing observed at all. Total committed **$438.00**, ceiling **$8/day**.
 *
 * The browser priced the target off `alioth`: $21.22 × 10 = $212.20, a target $438 of spend passed
 * weeks ago, so it rendered a finished countdown on a campaign 4 outcomes into 10. The honest price
 * is `azalea`'s $310.73 / 4 = **$77.6825**, a $776.83 target, $338.83 left, **43 days** at $8/day.
 *
 * So a suite that only checked "a number came back" would pass on the implementation this replaces.
 * Every case below asserts what the two answers DISAGREE about.
 */
import { describe, it, expect } from "vitest";
import {
  buildLearningPhase,
  CEILING_MULTIPLES,
  LEARNING_OUTCOMES_REQUIRED,
  OUTCOME_LAG_DAYS,
  type LearningCampaignInput,
  type LearningCell,
  type LearningPhaseInput,
} from "./learning-phase.js";
import type { SalesEconomics } from "./funnel-registry.js";

const ECONOMICS: SalesEconomics = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

const CONVERSATION_LEG = "start_to_conversation";
const MEETING_LEG = "conversation_to_meeting_booked";
const FUNNEL = "sales_meetings_from_conversation";

function campaign(over: Partial<LearningCampaignInput> = {}): LearningCampaignInput {
  return {
    campaignId: "c-live",
    campaignIds: ["c-live"],
    campaignIdentityKey: "org-1|b1|sales_meetings_from_conversation|cold_email",
    legKey: CONVERSATION_LEG,
    funnelKey: FUNNEL,
    live: true,
    observed: { clicks: 0, replies: 4 },
    ...over,
  };
}

/** The three workflows the campaign has run, exactly as prod holds them. */
const PROD_CELLS: LearningCell[] = [
  { spentUsd: 310.73, clicks: 0, replies: 4 }, // azalea — the only one that produced anything
  { spentUsd: 127.27, clicks: 0, replies: 0 }, // tango  — the workflow it currently runs
  { spentUsd: 0, clicks: 0, replies: 0 }, //       alioth — never run here; $21.22 is a FLEET floor
];

/** What the browser computed: the cheapest per-workflow figure × the ten outcomes it needs. */
const BROWSER_TARGET_USD = 21.22 * LEARNING_OUTCOMES_REQUIRED;

function build(over: Partial<LearningPhaseInput> = {}) {
  return buildLearningPhase({
    campaigns: [campaign()],
    economics: ECONOMICS,
    leadingCells: PROD_CELLS,
    leadingCommittedSpentUsd: 438,
    dailyCeilingUsd: 8,
    ...over,
  });
}

describe("the countdown rests on a measured price, never on an explore floor", () => {
  it("prices the prod campaign at azalea's $77.6825 and leaves 43 days — where the browser read 0", () => {
    const phase = build();

    expect(phase.status).toBe("learning");
    expect(phase.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825, 4);
    expect(phase.spendTargetUsd).toBeCloseTo(776.825, 3);
    expect(phase.spendRemainingUsd).toBeCloseTo(338.825, 3);
    expect(phase.daysRemaining).toBe(43);
    expect(phase.outcomesObserved).toBe(4);
    expect(phase.outcomesRequired).toBe(10);
    expect(phase.progressPct).toBe(40);

    // THE DIVERGENCE. The cheapest workflow's figure is a floor: its target is BELOW what the
    // campaign already spent, so the browser's countdown had expired. Ours has not.
    expect(BROWSER_TARGET_USD).toBeLessThan(phase.committedSpentUsd!);
    expect(phase.spendTargetUsd!).toBeGreaterThan(phase.committedSpentUsd!);
    expect(phase.expectedCostPerOutcomeUsd).not.toBeCloseTo(21.22, 2);
  });

  it("pools only the cells that OBSERVED an outcome — never the campaign's whole spend", () => {
    // $438 / 4 = $109.50 is what pricing in the barren workflows' exploration would read.
    expect(build().expectedCostPerOutcomeUsd).not.toBeCloseTo(438 / 4, 2);
    expect(build().expectedCostPerOutcomeUsd).toBeCloseTo(310.73 / 4, 6);
  });

  it("a scope whose every cell observed nothing has a FLOOR, not a price, and says so", () => {
    const phase = build({
      leadingCells: [{ spentUsd: 127.27, clicks: 0, replies: 0 }],
      campaigns: [campaign({ observed: { clicks: 0, replies: 0 } })],
    });
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_expected_price");
    expect(phase.expectedCostPerOutcomeUsd).toBeNull();
    expect(phase.daysRemaining).toBeNull();
    // The count is a MEASUREMENT — it reached people and none of them answered.
    expect(phase.outcomesObserved).toBe(0);
  });

  it("states what raising the ceiling buys, in the same unit as the countdown", () => {
    const phase = build();
    expect(phase.ceilingScenarios.map((s) => s.dailyCeilingUsd)).toEqual(CEILING_MULTIPLES.map((m) => 8 * m));
    expect(phase.ceilingScenarios.map((s) => s.daysRemaining)).toEqual([22, 15, 9]);
    // Every scenario is strictly shorter than the countdown it is offered against.
    for (const s of phase.ceilingScenarios) expect(s.daysRemaining).toBeLessThan(phase.daysRemaining!);
  });
});

describe("the three states a browser collapsed into one are three states", () => {
  it("SPEND IN, OUTCOMES NOT — its own verdict, told apart from still-spending and from priced", () => {
    const limited = build({ leadingCommittedSpentUsd: 900 });
    expect(limited.status).toBe("learning_limited");
    expect(limited.spendRemainingUsd).toBe(0);
    expect(limited.daysRemaining).toBeNull();
    expect(limited.ceilingScenarios).toEqual([]);
    // It is not `priced`: the outcomes did not arrive.
    expect(limited.outcomesObserved).toBeLessThan(LEARNING_OUTCOMES_REQUIRED);
    // ...and it is why the verdict is not terminal.
    expect(limited.outcomeLagDays).toBe(OUTCOME_LAG_DAYS);

    // The SAME fixture one dollar of spend earlier is still gathering.
    expect(build({ leadingCommittedSpentUsd: 776 }).status).toBe("learning");
    // ...and with the outcomes in, it is priced.
    expect(build({ campaigns: [campaign({ observed: { clicks: 0, replies: 10 } })] }).status).toBe("priced");
  });

  it("a scope whose campaigns are all stopped carries NO countdown", () => {
    const phase = build({ campaigns: [campaign({ live: false })] });
    expect(phase.status).toBe("paused");
    expect(phase.daysRemaining).toBeNull();
    expect(phase.spendTargetUsd).toBeNull();
    // Its counts survive: what was gathered is still true.
    expect(phase.campaigns[0]!.outcomesObserved).toBe(4);
  });

  it("a scope with NO campaigns is unmeasured, never gathering", () => {
    const phase = build({ campaigns: [] });
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_campaigns");
    expect(phase.campaigns).toEqual([]);
    expect(phase.daysRemaining).toBeNull();
  });

  it("campaign-service unreadable is its own reason, distinct from having no campaigns", () => {
    const phase = build({ campaigns: null });
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("campaigns_unreadable");
  });

  it("no ceiling is unmeasured — and the price figures it DID resolve are still stated", () => {
    const phase = build({ dailyCeilingUsd: null });
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_daily_ceiling");
    expect(phase.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825, 4);
    expect(phase.spendRemainingUsd).toBeCloseTo(338.825, 3);
    expect(phase.daysRemaining).toBeNull();
  });
});

describe("a campaign is measured on its OWN leg's step", () => {
  // Eight, deliberately short of the ten that would make the scope `priced` and end the countdown.
  const REPLIES = { clicks: 0, replies: 8 };

  it("a campaign converting a reply into a meeting is not measured on the replies it does not produce", () => {
    const entry = build({ campaigns: [campaign({ observed: REPLIES })] });
    const deeper = build({
      campaigns: [campaign({ legKey: MEETING_LEG, observed: REPLIES })],
      leadingCells: [{ spentUsd: 310.73, clicks: 0, replies: 4 }],
    });

    // THE DIVERGENCE: the same 8 replies, two legs, two counts and two prices.
    expect(entry.outcomesObserved).toBe(8);
    expect(entry.outcomeStep!.key).toBe("conversation");
    expect(entry.outcomeObserved).toBe(true);

    expect(deeper.outcomesObserved).toBeCloseTo(8 * 0.2, 6);
    expect(deeper.outcomeStep!.key).toBe("meeting_booked");
    expect(deeper.outcomeObserved).toBe(false);
    // A meeting costs the reply's price divided by the rate that reaches it — five times more here.
    expect(deeper.expectedCostPerOutcomeUsd).toBeCloseTo((310.73 / 4) / 0.2, 4);
    expect(deeper.expectedCostPerOutcomeUsd! / entry.expectedCostPerOutcomeUsd!).toBeCloseTo(5, 6);
  });

  it("an ENTRY leg is counted and priced for a brand that has declared no rate at all", () => {
    // Its outcome IS the driver signal, so the ladder is empty and nothing has to be declared. A
    // DEEPER leg on the same brand is unpriceable — the divergence that makes the rule a rule.
    const entry = build({ economics: null });
    expect(entry.status).toBe("learning");
    expect(entry.outcomesObserved).toBe(4);
    expect(entry.outcomeObserved).toBe(true);
    expect(entry.expectedCostPerOutcomeUsd).toBeCloseTo(310.73 / 4, 6);

    const deeper = build({ economics: null, campaigns: [campaign({ legKey: MEETING_LEG })] });
    expect(deeper.status).toBe("unmeasured");
    expect(deeper.unmeasuredReason).toBe("leg_unpriceable");
    expect(deeper.outcomesObserved).toBeNull();
  });

  it("a leg whose rate the brand never declared is unpriceable, never 0", () => {
    // The ENTRY leg of the form funnel is observable whatever the brand declared — rate 1, its count
    // is the driver itself — so it is the DEEPER leg alone that goes unpriceable.
    const entry = build({
      campaigns: [campaign({ legKey: "start_to_website_visit", funnelKey: "form_magnet", observed: { clicks: 4, replies: 0 } })],
      leadingCells: [{ spentUsd: 310.73, clicks: 4, replies: 0 }],
      economics: { ...ECONOMICS, visitToFormSubmissionPct: undefined },
    });
    const deeper = build({
      campaigns: [campaign({ legKey: "website_visit_to_form_filled", funnelKey: "form_magnet", observed: { clicks: 4, replies: 0 } })],
      leadingCells: [{ spentUsd: 310.73, clicks: 4, replies: 0 }],
      economics: { ...ECONOMICS, visitToFormSubmissionPct: undefined },
    });
    expect(entry.outcomeStep!.key).toBe("website_visit");
    expect(entry.outcomesObserved).toBe(4);
    expect(entry.expectedCostPerOutcomeUsd).toBeCloseTo(310.73 / 4, 6);

    expect(deeper.outcomeStep!.key).toBe("form_filled");
    expect(deeper.status).toBe("unmeasured");
    expect(deeper.unmeasuredReason).toBe("leg_unpriceable");
    expect(deeper.outcomesObserved).toBeNull();
    expect(deeper.expectedCostPerOutcomeUsd).toBeNull();
  });

  it("a campaign stating no leg has no outcome to be counted in", () => {
    const phase = build({ campaigns: [campaign({ legKey: null })] });
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_leg_stated");
    expect(phase.outcomesObserved).toBeNull();
  });
});

describe("a scope finishes when its FIRST campaign does", () => {
  const gathering = campaign({ campaignId: "c-slow", campaignIds: ["c-slow"], observed: { clicks: 0, replies: 1 } });
  const finished = campaign({ campaignId: "c-fast", campaignIds: ["c-fast"], observed: { clicks: 0, replies: 11 } });

  it("one campaign priced makes the scope priced, whatever its siblings are doing", () => {
    const phase = build({ campaigns: [gathering, finished] });
    expect(phase.status).toBe("priced");
    expect(phase.campaignId).toBe("c-fast");
    expect(phase.progressPct).toBe(100);
    // The scope with ONLY the slow campaign is still gathering — the divergence the rule creates.
    expect(build({ campaigns: [gathering] }).status).toBe("learning");
    // Both campaigns are listed with their own counts, so a consumer can SEE why it reads priced.
    expect(phase.campaigns.map((c) => c.outcomesObserved)).toEqual([1, 11]);
  });

  it("a campaign that already crossed keeps the scope priced after it stops", () => {
    const stopped = { ...finished, live: false };
    expect(build({ campaigns: [gathering, stopped] }).status).toBe("priced");
  });

  it("the countdown is the LEADING LIVE campaign's — a stopped sibling is never its subject", () => {
    const stoppedAhead = campaign({ campaignId: "c-dead", campaignIds: ["c-dead"], live: false, observed: { clicks: 0, replies: 9 } });
    const liveBehind = campaign({ campaignId: "c-live-2", campaignIds: ["c-live-2"], observed: { clicks: 0, replies: 2 } });
    const phase = build({ campaigns: [stoppedAhead, liveBehind] });
    expect(phase.status).toBe("learning");
    expect(phase.campaignId).toBe("c-live-2");
    expect(phase.outcomesObserved).toBe(2);
  });

  it("names the same leader on the same evidence however the producer ordered it", () => {
    const a = campaign({ campaignId: "c-a", campaignIds: ["c-a"], observed: { clicks: 0, replies: 3 } });
    const b = campaign({ campaignId: "c-b", campaignIds: ["c-b"], observed: { clicks: 0, replies: 3 } });
    expect(build({ campaigns: [a, b] }).campaignId).toBe("c-a");
    expect(build({ campaigns: [b, a] }).campaignId).toBe("c-a");
  });
});
