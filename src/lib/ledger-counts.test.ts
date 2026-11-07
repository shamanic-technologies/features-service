import { describe, it, expect, vi } from "vitest";

vi.unmock("./ledger-counts.js");
vi.unmock("./ledger-activity.js");
vi.unmock("./ledger-offer-outcomes.js");
vi.unmock("./ledger-audience-stats.js");
import {
  ledgerKeysOfStep,
  ledgerScopeOf,
  withLedgerCounts,
  withLedgerRawStats,
  withLedgerDayChart,
  withLedgerDealsColumns,
  ledgerUnitsOfRung,
  NOT_A_LEDGER_OUTCOME,
} from "./ledger-counts.js";
import { withLedgerActivity } from "./ledger-activity.js";
import { withLedgerOfferOutcomes } from "./ledger-offer-outcomes.js";
import { withLedgerAudienceStats } from "./ledger-audience-stats.js";
import type { ScopeOutcomeLedgerInput } from "./scope-outcome-ledger.js";

const TODAY = "2026-11-07";
const ledger = (produced: Record<string, Record<string, number>>, undeclared: Record<string, number> = {}, producers: Record<string, string[]> = {}): ScopeOutcomeLedgerInput => ({
  producedByDay: new Map(Object.entries(produced).map(([k, d]) => [k, new Map(Object.entries(d))])),
  ownCostUsd: new Map(),
  unitCosts: new Map(),
  undeclaredConsumptions: new Map(Object.entries(undeclared)),
  fleetProducers: new Map(Object.entries({ ...Object.fromEntries(Object.keys(produced).map((k) => [k, ["runs"]])), ...producers })),
  daysMissing: [],
  today: TODAY,
});

// Prod-shaped fixture (Distribute.you 2026-11-07): replies declared (conversation), visits declared as the lead state,
// signup and paid client consumed with no producer.
const L = ledger(
  {
    conversation: { "2026-11-01": 2, "2026-11-03": 1 },
    lead_visited: { "2026-11-02": 4 },
    message_sent: { "2026-11-01": 100, "2026-11-02": 50 },
    meeting_booked: { "2026-11-05": 1 },
    lead_found: { "2026-10-30": 300 },
  },
  { signup: 5, paid_client: 29 },
  { paid_client: ["lead-service"] },
);
const scope = ledgerScopeOf(L);

describe("ledgerKeysOfStep: one resolver step -> ledger keys", () => {
  it("a click is declared as the visit state (its only evidence); every other step is itself", () => {
    expect(ledgerKeysOfStep("website_visit")).toEqual(["lead_visited"]);
    expect(ledgerKeysOfStep("conversation")).toEqual(["conversation"]);
    expect(ledgerKeysOfStep("signup")).toEqual(["signup"]);
    expect(ledgerKeysOfStep("paid_client")).toEqual(["paid_client"]);
    expect(ledgerKeysOfStep("message_sent")).toEqual(["message_sent"]);
  });
});

describe("withLedgerCounts: revenue body counts are the ledger's Units", () => {
  const body = {
    recipientsContacted: { total: 900, daily: [], undatedCount: 0 },
    recipientsOpened: { total: 40, daily: [], undatedCount: 0 },
    recipientsClicked: { total: 12, daily: [], undatedCount: 0 },
    recipientsRepliesPositive: { total: 7, daily: [], undatedCount: 0 },
    signups: { total: 3, daily: [], undatedCount: 0 },
    sequences: { total: 999, daily: [], undatedCount: 0 },
    spend: { totalSpentCents: 3000, actualSpentCents: 3000, provisionedSpentCents: 0, positiveRepliesCount: 7, cpprCents: 428, totalCpcCents: 250, signupsCount: 3, cpsCents: 1000, maturity: { x: 1 } },
    outcomes: { recipientsContacted: 900, recipientsClicked: 12, recipientsRepliesPositive: 7, committedSpentCents: 3000, cpcCents: 250, cpprCents: 428, sending: { recipientsSent: 900 } },
    leads: [{ id: "a" }],
  };
  const out = withLedgerCounts(body, scope, "brand") as unknown as Record<string, any>;

  it("series = the ledger's Units per day, difference zero with the ledger total", () => {
    expect(out.recipientsRepliesPositive).toEqual({ total: 3, daily: [{ date: "2026-11-01", count: 2 }, { date: "2026-11-03", count: 1 }], undatedCount: 0 });
    expect(out.recipientsClicked.total).toBe(4);
    expect(out.sequences.total).toBe(150);
  });
  it("no ledger twin = null + not_a_ledger_outcome; an outcome the ledger lacks = null + its reason + producer gap", () => {
    expect(out.recipientsContacted).toBeNull();
    expect(out.recipientsOpened).toBeNull();
    expect(out.ledgerCounts.nullFields.recipientsContacted).toBe(NOT_A_LEDGER_OUTCOME);
    expect(out.signups).toBeNull();
    expect(out.ledgerCounts.nullFields.signups).toBe("outcome_not_declared_in_ledger");
    expect(out.ledgerCounts.producerGaps.signup.undeclaredConsumptions).toBe(5);
  });
  it("spend block: counts and $ per outcome = spend ÷ ledger Units; maturity dropped", () => {
    expect(out.spend.positiveRepliesCount).toBe(3);
    expect(out.spend.cpprCents).toBe(1000);
    expect(out.spend.totalCpcCents).toBe(750);
    expect(out.spend.signupsCount).toBeNull();
    expect(out.spend.cpsCents).toBeNull();
    expect(out.spend.maturity).toBeNull();
  });
  it("outcomes block: people counts null, ledger counts and costs", () => {
    expect(out.outcomes.recipientsContacted).toBeNull();
    expect(out.outcomes.recipientsRepliesPositive).toBe(3);
    expect(out.outcomes.cpprCents).toBe(1000);
    expect(out.outcomes.sending).toBeNull();
  });
  it("lists of people are records, untouched", () => {
    expect(out.leads).toEqual([{ id: "a" }]);
  });
  it("no ledger scope = every count null with the scope's reason", () => {
    const o = withLedgerCounts(body, ledgerScopeOf(null, "per_workflow_not_in_ledger"), "brand") as unknown as Record<string, any>;
    expect(o.recipientsRepliesPositive).toBeNull();
    expect(o.ledgerCounts.nullFields.recipientsRepliesPositive).toBe("per_workflow_not_in_ledger");
  });
});

describe("withLedgerRawStats: /stats counts on the ledger, no twin dropped", () => {
  it("re-bases mapped counts and drops the others", () => {
    const keys = new Set(["recipientsContacted", "recipientsRepliesPositive", "leadsServed", "totalCostInUsdCents", "outletsDiscovered"]);
    const r = withLedgerRawStats({ recipientsContacted: 900, recipientsRepliesPositive: 7, leadsServed: 1, totalCostInUsdCents: 3000, outletsDiscovered: 4 }, keys, scope, "brand");
    expect(r.raw).toEqual({ recipientsRepliesPositive: 3, leadsServed: 300, totalCostInUsdCents: 3000 });
    expect(r.ledgerCounts.nullFields.outletsDiscovered).toBe(NOT_A_LEDGER_OUTCOME);
  });
});

describe("withLedgerDayChart: pipeline-activity actual bars", () => {
  it("actual outreach / clicks per day = ledger Units; opens null; expected untouched", () => {
    const r = withLedgerDayChart(
      {
        days: [
          { date: "2026-11-01", metrics: { outreach: { actual: 9, expected: 5 }, opens: { actual: 3, expected: 2 }, clicks: { actual: 1, expected: 1 }, signups: { actual: 0, expected: 0 }, formSubmissions: { actual: 0, expected: 0 } } },
          { date: "2026-11-09", metrics: { outreach: { actual: null, expected: 5 }, opens: { actual: null, expected: 2 }, clicks: { actual: null, expected: 1 }, signups: { actual: null, expected: 0 }, formSubmissions: { actual: null, expected: 0 } } },
        ],
        summary: { openRatePct: 20, undatedSignups: 0 },
      },
      scope,
    ) as unknown as Record<string, any>;
    expect(r.days[0].metrics.outreach).toEqual({ actual: 100, expected: 5 });
    expect(r.days[0].metrics.clicks.actual).toBe(0);
    expect(r.days[0].metrics.signups.actual).toBeNull();
    expect(r.days[0].metrics.opens).toEqual({ actual: null, expected: null });
    expect(r.days[1].metrics.outreach).toEqual({ actual: null, expected: 5 });
    expect(r.summary.openRatePct).toBeNull();
  });
});

describe("deals: the won column is the ledger's Paid client Units x LTR", () => {
  it("ledger lacks Paid client = won null + its reason; counts null", () => {
    expect(ledgerUnitsOfRung(scope, "paid_client")).toEqual({ units: null, reason: "outcome_not_declared_in_ledger" });
    expect(ledgerUnitsOfRung(scope, "engaged")).toEqual({ units: null, reason: NOT_A_LEDGER_OUTCOME });
    const r = withLedgerDealsColumns({ lifetimeRevenueUsd: 500, columns: [{ standing: "customer", basis: "won_value", valueUsd: 6500, leads: [{ valueUsd: 500 }] }, { standing: "sales_interest", basis: "expected_value", valueUsd: 20 }] }, scope) as unknown as Record<string, any>;
    expect(r.columns[0].valueUsd).toBeNull();
    expect(r.columns[0].unitsUnavailableReason).toBe("outcome_not_declared_in_ledger");
    expect(r.columns[0].leads[0].valueUsd).toBeNull();
    expect(r.columns[1].valueUsd).toBe(20);
    expect(r.columns[1].leadCount).toBeNull();
  });
  it("ledger holds Paid client Units = Units x LTR", () => {
    const s = ledgerScopeOf(ledger({ paid_client: { "2026-11-01": 2 } }));
    const r = withLedgerDealsColumns({ lifetimeRevenueUsd: 500, columns: [{ standing: "customer", basis: "won_value", valueUsd: 6500, leads: [] }] }, s) as unknown as Record<string, any>;
    expect(r.columns[0].valueUsd).toBe(1000);
  });
});

describe("withLedgerActivity: funnel steps and pipes on the ledger", () => {
  it("a step's people = the ledger's Units, outreach rungs null, rate = Units ÷ Units", () => {
    const r = withLedgerActivity(
      {
        funnel: {
          mode: "proactive",
          steps: [
            { key: "lead_found", label: "Lead found", kind: "step", people: 999, rateToNextPct: 1, unmeasuredReason: null },
            { key: "contacted", label: "Contacted", kind: "outreach", people: 800, rateToNextPct: 1, unmeasuredReason: null },
            { key: "conversation", label: "Positive reply", kind: "step", people: 7, rateToNextPct: null, unmeasuredReason: null },
          ],
        },
        pipes: [{ campaignId: "c1", toStep: "conversation", people: { found: 1, contacted: 1, sent: 1, delivered: 1, reachedToStep: 7 }, work: null, calls: null }],
      },
      scope,
      () => scope,
    ) as unknown as Record<string, any>;
    expect(r.funnel.steps.map((s: any) => s.people)).toEqual([300, null, 3]);
    expect(r.funnel.steps[0].rateToNextPct).toBeNull();
    expect(r.pipes[0].people.reachedToStep).toBe(3);
    expect(r.pipes[0].people.contacted).toBeNull();
    expect(r.basis).toBe("ledger_units_since_inception");
  });
});

describe("withLedgerOfferOutcomes", () => {
  it("rows and legs count the ledger's Units; people figures null", () => {
    const r = withLedgerOfferOutcomes(
      {
        outcomes: [{ step: { key: "conversation" }, spentUsd: 30, valuePerOutcomeUsd: 10, recipientsReached: 7, legs: [{ toStep: { key: "conversation" }, campaignIds: ["c1"], spentUsd: 30, valuePerOutcomeUsd: 10, recipientsReached: 7 }] }],
        pipeline: { peopleContacted: 900, ladder: [{ step: { key: "meeting_booked" }, recipientsReached: 4, valuePerOutcomeUsd: 100 }], customersWon: { count: 10, leadCount: 10 }, exclusiveLadder: { contacted: {}, rows: [{ pricedPeople: 3 }], total: { people: 9 } } },
      },
      scope,
      () => scope,
    ) as unknown as Record<string, any>;
    expect(r.outcomes[0].recipientsReached).toBe(3);
    expect(r.outcomes[0].costPerOutcomeUsd).toBe(10);
    expect(r.outcomes[0].valueUsd).toBe(30);
    expect(r.outcomes[0].legs[0].recipientsReached).toBe(3);
    expect(r.pipeline.ladder[0].recipientsReached).toBe(1);
    expect(r.pipeline.peopleContacted).toBeNull();
    expect(r.pipeline.customersWon.count).toBeNull();
    expect(r.pipeline.exclusiveLadder.rows[0].pricedPeople).toBeNull();
  });
});

describe("withLedgerAudienceStats", () => {
  it("each audience counts the Units of the runs served under it", () => {
    const r = withLedgerAudienceStats(
      { audiences: [{ audienceId: "a1", evidence: { totalCostInUsdCents: 600, contacted: 50, positiveReplies: 9, websiteClicks: 2 }, metrics: { cpprCents: 66, cpcCents: 300 } }] },
      scope,
      new Map([["a1", new Map([["conversation", 2], ["lead_visited", 3]])]]),
    ) as unknown as Record<string, any>;
    expect(r.audiences[0].evidence.positiveReplies).toBe(2);
    expect(r.audiences[0].evidence.websiteClicks).toBe(3);
    expect(r.audiences[0].evidence.contacted).toBeNull();
    expect(r.audiences[0].evidence.signups).toBeNull();
    expect(r.audiences[0].metrics.cpprCents).toBe(300);
  });
});
