/**
 * Guards for the AGENCY / SELF-SERVE split of the fleet monthly run-rate.
 *
 * ONE fixture, shaped like the production account that motivated it — an AGENCY org whose brands'
 * CONFIGURED budget on the August reference date ($110/day → $3,300) EXCEEDS the fleet run-rate
 * recorded that day ($87/day → $2,610). That is the exact shape that made the old subtraction come
 * out at −$720/month and forced the period to be published as unmeasurable, so every case here
 * asserts the DIVERGENCE between what a sum says and what that subtraction said: a suite that only
 * checked "a number came back" would pass on the implementation this replaces.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  activeNear,
  agencyOrgIdsOf,
  agencyPairKeysOf,
  agencyStatedMrrOn,
  buildMrrSplit,
  evaluatePairDay,
  pairKey,
  paymentStoppedOn,
  recordedEarningOf,
  referenceDatesOf,
  selfServePairKeysOf,
  statedAmountInForce,
  sumSideOn,
  type DayFacts,
  type MrrSplitInputs,
} from "./agency-self-serve-compute.js";
import type { CampaignDayAnswer, PaymentStoppedFacts } from "./mrr-day-facts-clients.js";
import type { StatedAmountRow } from "./stated-monthly-amounts-store.js";

const AGENCY_ORG = "org-agency";
const SAAS_A = "org-saas-a";
const SAAS_B = "org-saas-b";
const SAAS_C = "org-saas-c";
const SAAS_D = "org-saas-d";

const BRAND_BIG = "brand-big"; // the agency's funded brand
const BRAND_SMALL = "brand-small"; // the agency's other funded brand
const BRAND_IDLE = "brand-idle"; // an agency brand nobody has stated an amount for
const BRAND_A = "brand-saas-a"; // self-serve, $100/day, working
const BRAND_B = "brand-saas-b"; // self-serve, $2/day, audience EXHAUSTED on the reference date
const BRAND_C = "brand-saas-c"; // self-serve, demonstrably active, NO budget on record
const BRAND_D = "brand-saas-d"; // self-serve, $50/day, but its org's PAYMENT had stopped

const AUG = "2026-08-29"; // the August reference date — the period that used to read unmeasurable
const JUL = "2026-07-31";
const TODAY = "2026-09-12";
const NOW = new Date(`${TODAY}T12:00:00Z`);

const K = {
  big: pairKey(AGENCY_ORG, BRAND_BIG),
  small: pairKey(AGENCY_ORG, BRAND_SMALL),
  idle: pairKey(AGENCY_ORG, BRAND_IDLE),
  a: pairKey(SAAS_A, BRAND_A),
  b: pairKey(SAAS_B, BRAND_B),
  c: pairKey(SAAS_C, BRAND_C),
  d: pairKey(SAAS_D, BRAND_D),
};

const ALL_PAIRS = [
  { orgId: AGENCY_ORG, brandId: BRAND_BIG },
  { orgId: AGENCY_ORG, brandId: BRAND_SMALL },
  { orgId: AGENCY_ORG, brandId: BRAND_IDLE },
  { orgId: SAAS_A, brandId: BRAND_A },
  { orgId: SAAS_B, brandId: BRAND_B },
  { orgId: SAAS_C, brandId: BRAND_C },
  { orgId: SAAS_D, brandId: BRAND_D },
];

/** billing's recorded CONFIGURED brand daily budget per day. An absent day is NOT RECORDED. */
function budgets(): Map<string, Map<string, number>> {
  const days = [JUL, AUG, TODAY];
  const of = (usd: number) => new Map(days.map((d) => [d, usd]));
  return new Map([
    [K.big, of(110)],
    [K.small, of(1)],
    [K.idle, of(0)], // an agency brand recorded at zero — a real answer, not a gap
    [K.a, of(100)],
    [K.b, of(2)],
    // K.c: billing holds NO amount for this pair, on any day
    [K.d, of(50)],
  ]);
}

/** Days each pair billed cold-email spend — the activity evidence for the pre-record era. */
function activity(): Map<string, Set<string>> {
  return new Map([
    [K.big, new Set([JUL, "2026-08-28", TODAY])],
    [K.small, new Set([JUL, AUG, TODAY])],
    [K.a, new Set(["2026-07-30", "2026-08-25", "2026-09-10"])],
    [K.b, new Set([AUG])],
    [K.c, new Set(["2026-08-27", "2026-09-11"])],
    [K.d, new Set([AUG])],
    // K.idle has never billed a day
  ]);
}

/** campaign-service's RECORDED verdict, which only reaches back to 2026-09-01 in this fixture. */
function recordedEarning(): Map<string, Map<string, boolean | null>> {
  return new Map([
    [K.big, new Map([[TODAY, true]])],
    [K.small, new Map([[TODAY, true]])],
    [K.idle, new Map([[TODAY, false]])],
    [K.a, new Map([[TODAY, true]])],
    // B's audience is recorded EXHAUSTED on the August reference date AND today
    [K.b, new Map([[AUG, false], [TODAY, false]])],
    [K.c, new Map([[TODAY, true]])],
    [K.d, new Map([[TODAY, true]])],
  ]);
}

function payments(): Map<string, PaymentStoppedFacts> {
  const clear: PaymentStoppedFacts = { recordBeginsOn: "2026-06-12", periods: [] };
  return new Map([
    [AGENCY_ORG, clear],
    [SAAS_A, clear],
    [SAAS_B, clear],
    [SAAS_C, clear],
    // D stopped paying across the whole window
    [SAAS_D, { recordBeginsOn: "2026-06-12", periods: [{ startedOn: "2026-08-01", endedOn: null }] }],
  ]);
}

function facts(over: Partial<DayFacts> = {}): DayFacts {
  const base: DayFacts = {
    budgetByDay: budgets(),
    activityDays: activity(),
    recordedEarning: recordedEarning(),
    paymentByOrg: payments(),
    ...over,
  };
  // TODAY's amount comes from billing's LIVE budget now, so the fixture states it there. Unless a
  // case overrides it, it agrees with the replay — the DIVERGENCE is what the dedicated cases drive.
  return {
    ...base,
    liveBudget:
      over.liveBudget ?? {
        day: TODAY,
        byPair: new Map(
          [...base.budgetByDay].flatMap(([k, v]) => (v.has(TODAY) ? [[k, v.get(TODAY)!] as [string, number]] : [])),
        ),
      },
  };
}

/** The fleet run-rate this service RECORDED. August's is SMALLER than the agency's configured budget. */
const SNAPSHOTS = [
  { date: "2026-07-15", mrrUsd: 3000 },
  { date: JUL, mrrUsd: 4080 },
  { date: AUG, mrrUsd: 2610 }, // $87/day — the production figure the old code subtracted $3,300 from
];

const STATED: StatedAmountRow[] = [
  {
    id: "row-big",
    orgId: AGENCY_ORG,
    brandId: BRAND_BIG,
    amountUsd: 1500,
    startDate: null, // in force since this brand's FIRST DAY OF BILLED SPEND
    endDate: "2026-08-31",
    note: "what they actually hand us",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "row-big-2",
    orgId: AGENCY_ORG,
    brandId: BRAND_BIG,
    amountUsd: 2000,
    startDate: "2026-09-01",
    endDate: null,
    note: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

const FIRST_BILLED = new Map<string, string | null>([[K.big, "2026-07-20"]]);

function inputs(over: Partial<MrrSplitInputs> = {}): MrrSplitInputs {
  return {
    statedRows: STATED,
    allPairs: ALL_PAIRS,
    facts: facts(),
    firstBilledDayByPair: FIRST_BILLED,
    snapshots: SNAPSHOTS,
    currentMrrUsd: 5820,
    earningRecordBeginsOn: "2026-09-01",
    ...over,
  };
}

const WINDOWS = { weeks: 12, months: 6 };

const SELF_KEYS = [K.a, K.b, K.c, K.d].sort();
const AGENCY_KEYS = [K.big, K.small, K.idle].sort();

describe("the self-serve half is a SUM, so it can never be negative", () => {
  it("answers a POSITIVE figure for the month whose subtraction came out at −$720", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    const aug = split.monthly.find((b) => b.period === "2026-08")!;

    // The shape that broke the old code is intact in the fixture: the agency's replayed budget is
    // LARGER than the fleet figure it used to be subtracted from.
    expect(aug.referenceDate).toBe(AUG);
    expect(aug.committedMrrUsd).toBe(2610);
    expect(aug.agencyBudgetMrrUsd).toBe(3330); // (110 + 1) × 30
    expect(aug.agencyBudgetMrrUsd).toBeGreaterThan(aug.committedMrrUsd);
    expect(aug.committedMrrUsd - aug.agencyBudgetMrrUsd).toBeLessThan(0); // what the old code computed

    // …and the sum answers a real figure instead: only BRAND_A qualifies ($100/day × 30).
    expect(aug.selfServeMrrUsd).toBe(3000);
    expect(aug.selfServeUnmeasurableReason).toBeNull();
    expect(aug.totalMrrUsd).toBe(1500 + 3000);
  });

  it("counts a pair ONLY when all four conditions held, and each exclusion is for its own reason", () => {
    const f = facts();
    // A: working, budgeted, paying → counted
    expect(evaluatePairDay(K.a, SAAS_A, AUG, f).mrrUsd).toBe(3000);
    // B: budgeted and paying, but its AUDIENCE was recorded exhausted → nothing
    expect(evaluatePairDay(K.b, SAAS_B, AUG, f).mrrUsd).toBe(0);
    // C: demonstrably active, but billing holds NO amount → nothing, and the gap is flagged
    const c = evaluatePairDay(K.c, SAAS_C, AUG, f);
    expect(c.mrrUsd).toBe(0);
    expect(c.budgetUnrecordedWhileActive).toBe(true);
    // D: budgeted and active, but its org's PAYMENT had stopped → nothing
    expect(evaluatePairDay(K.d, SAAS_D, AUG, f).mrrUsd).toBe(0);
  });

  it("never fabricates the AMOUNT for a pair billing holds no record of — it counts the gap instead", () => {
    const aug = buildMrrSplit(inputs(), NOW, WINDOWS).monthly.find((b) => b.period === "2026-08")!;
    expect(aug.selfServeUnrecordedBudgetPairCount).toBe(1); // BRAND_C
    // Its activity is real and it still contributes nothing: an invented amount is the one thing
    // that would put a number on the wire no service ever recorded.
    expect(aug.selfServeMrrUsd).toBe(3000);
  });

  it("a stated ZERO budget is a real answer and is not confused with an absent record", () => {
    const f = facts();
    expect(evaluatePairDay(K.idle, AGENCY_ORG, TODAY, f).budgetUnrecordedWhileActive).toBe(false);
    expect(evaluatePairDay(K.c, SAAS_C, TODAY, f).budgetUnrecordedWhileActive).toBe(true);
  });
});

describe("the two eras are marked, never blended", () => {
  it("marks a pre-record period APPROXIMATED and a covered one RECORDED, on the same fixture", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    const sep = split.monthly.find((b) => b.period === "2026-09")!;

    expect(aug.selfServeBasis).toBe("approximated"); // campaign-service records nothing back then
    expect(aug.selfServeApproximatedPairCount).toBe(1);
    expect(sep.selfServeBasis).toBe("recorded"); // every pair answered from the record
    expect(sep.selfServeApproximatedPairCount).toBe(0);
    expect(split.earningRecordBeginsOn).toBe("2026-09-01");
  });

  it("treats run PRESENCE and run SILENCE asymmetrically — one billed day covers a window either side", () => {
    const days = new Set(["2026-08-25"]);
    expect(activeNear(days, "2026-08-25")).toBe(true);
    expect(activeNear(days, "2026-08-31")).toBe(true); // six days later, still evidence
    expect(activeNear(days, "2026-08-19")).toBe(true); // six days earlier, still evidence
    expect(activeNear(days, "2026-09-02")).toBe(false); // a full window of silence either side
    expect(activeNear(new Set(), "2026-08-25")).toBe(false);
  });

  it("a RECORDED answer beats the activity evidence, in both directions", () => {
    // B billed spend ON the August reference date, yet the record says its audience was exhausted.
    expect(activeNear(activity().get(K.b), AUG)).toBe(true);
    expect(evaluatePairDay(K.b, SAAS_B, AUG, facts()).mrrUsd).toBe(0);
    // C has no activity anywhere near today, yet the record says it was earning.
    expect(activeNear(activity().get(K.c), TODAY)).toBe(true);
    const noActivity = facts({ activityDays: new Map() });
    expect(evaluatePairDay(K.a, SAAS_A, TODAY, noActivity).mrrUsd).toBe(3000);
  });

  it("a campaign RECORDED as stopped is a recorded NO, even while its audience axis is still empty", () => {
    const answers: CampaignDayAnswer[] = [
      { campaignId: "c1", status: "stopped", audience: "not_recorded", earning: null, statusRecordedSince: "2026-09-01T00:00:00Z", audienceRecordedSince: null },
    ];
    expect(recordedEarningOf(answers)).toBe(false);
    // …while an ONGOING campaign with no audience record says nothing at all.
    expect(
      recordedEarningOf([{ campaignId: "c2", status: "ongoing", audience: "not_recorded", earning: null, statusRecordedSince: "2026-09-01T00:00:00Z", audienceRecordedSince: null }]),
    ).toBeNull();
    // A brand is earning if ANY of its campaigns was.
    expect(
      recordedEarningOf([
        { campaignId: "c1", status: "stopped", audience: "not_recorded", earning: null, statusRecordedSince: null, audienceRecordedSince: null },
        { campaignId: "c2", status: "ongoing", audience: "available", earning: true, statusRecordedSince: null, audienceRecordedSince: null },
      ]),
    ).toBe(true);
    expect(recordedEarningOf([])).toBeNull();
  });

  it("an UNKNOWN campaign beats every recorded NO beside it — the prod shape that vanished a customer", () => {
    // One ongoing campaign whose audience is not yet recorded, beside a stopped ancestor. The
    // ancestor says nothing about the live campaign, so the brand's day is UNKNOWN and falls to the
    // activity evidence. Reading it as a recorded NO dropped the brand from the run-rate outright,
    // and out of the unrecorded-budget gap too, so it disappeared with nothing saying why.
    expect(
      recordedEarningOf([
        { campaignId: "stopped-ancestor", status: "stopped", audience: "not_recorded", earning: null, statusRecordedSince: "2026-09-12T00:00:00Z", audienceRecordedSince: null },
        { campaignId: "live", status: "ongoing", audience: "not_recorded", earning: null, statusRecordedSince: "2026-09-12T00:00:00Z", audienceRecordedSince: null },
      ]),
    ).toBeNull();
    // Same for a campaign whose STATUS is not recorded at all.
    expect(
      recordedEarningOf([
        { campaignId: "stopped-ancestor", status: "stopped", audience: "not_recorded", earning: null, statusRecordedSince: null, audienceRecordedSince: null },
        { campaignId: "unknown", status: "not_recorded", audience: "not_recorded", earning: null, statusRecordedSince: null, audienceRecordedSince: null },
      ]),
    ).toBeNull();
    // A recorded NO still wins when EVERY campaign answered.
    expect(
      recordedEarningOf([
        { campaignId: "stopped-ancestor", status: "stopped", audience: "not_recorded", earning: null, statusRecordedSince: null, audienceRecordedSince: null },
        { campaignId: "exhausted", status: "ongoing", audience: "exhausted", earning: false, statusRecordedSince: null, audienceRecordedSince: null },
      ]),
    ).toBe(false);
  });

  it("the unknown-beats-no rule reaches the FIGURE: the customer keeps its budget and its gap is counted", () => {
    // BRAND_C is active and has no recorded amount; give it a live campaign whose audience is
    // unrecorded beside a stopped ancestor, exactly the prod shape.
    const unresolved = new Map(recordedEarning());
    unresolved.set(K.c, new Map<string, boolean | null>([[TODAY, null]]));
    const f = facts({ recordedEarning: unresolved });
    const verdict = evaluatePairDay(K.c, SAAS_C, TODAY, f);
    expect(verdict.mrrUsd).toBe(0);
    expect(verdict.budgetUnrecordedWhileActive).toBe(true); // the gap is VISIBLE, not a silent drop
    expect(verdict.basis).toBe("approximated");
  });

  it("an unrecorded PAYMENT axis is a fallback, not a yes — it marks the day approximated", () => {
    const noRecord: PaymentStoppedFacts = { recordBeginsOn: null, periods: [] };
    expect(paymentStoppedOn(noRecord, AUG)).toBeNull();
    expect(paymentStoppedOn(undefined, AUG)).toBeNull();
    expect(paymentStoppedOn({ recordBeginsOn: "2026-09-01", periods: [] }, AUG)).toBeNull();
    expect(paymentStoppedOn({ recordBeginsOn: "2026-06-12", periods: [] }, AUG)).toBe(false);
    expect(paymentStoppedOn({ recordBeginsOn: "2026-06-12", periods: [{ startedOn: "2026-08-01", endedOn: "2026-08-15" }] }, AUG)).toBe(false);
    expect(
      paymentStoppedOn({ recordBeginsOn: "2026-06-12", periods: [{ startedOn: "2026-08-01", endedOn: null }] }, AUG),
    ).toBe(true);

    const f = facts({ paymentByOrg: new Map([[SAAS_A, noRecord]]) });
    expect(evaluatePairDay(K.a, SAAS_A, TODAY, f).basis).toBe("approximated");
  });

  it("answers UNMEASURABLE, never 0, when nothing about the day is on record for any pair", () => {
    const empty = facts({ budgetByDay: new Map(), recordedEarning: new Map(), paymentByOrg: new Map(), activityDays: new Map() });
    const sum = sumSideOn(SELF_KEYS, AUG, empty);
    expect(sum.nothingRecorded).toBe(true);

    const split = buildMrrSplit(inputs({ facts: empty }), NOW, WINDOWS);
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    expect(aug.selfServeMrrUsd).toBeNull();
    expect(aug.selfServeUnmeasurableReason).toBe("no_records_for_period");
    expect(aug.totalMrrUsd).toBeNull();
    expect(aug.selfServeBasis).toBeNull();
  });
});

describe("the agency half is untouched, and the two halves stay disjoint", () => {
  it("states the agency at what a human STATED, never at its budget × 30 — and the two DIVERGE", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    expect(split.currentAgencyMrrUsd).toBe(2000); // the September stated row
    expect(split.currentAgencyBudgetMrrUsd).toBe(3330); // (110 + 1) × 30, the substitution this removes
    expect(split.currentAgencyMrrUsd).not.toBe(split.currentAgencyBudgetMrrUsd);
  });

  it("derives the agency orgs from the stated rows and excludes their WHOLE brand set", () => {
    expect(agencyOrgIdsOf(STATED)).toEqual([AGENCY_ORG]);
    expect(agencyPairKeysOf(STATED, ALL_PAIRS)).toEqual(AGENCY_KEYS);
    // BRAND_IDLE carries no stated amount and is still excluded from the SaaS figure.
    expect(agencyPairKeysOf(STATED, ALL_PAIRS)).toContain(K.idle);
    expect(selfServePairKeysOf(STATED, ALL_PAIRS)).toEqual(SELF_KEYS);
  });

  it("the two sides partition the pair universe, so nothing is counted twice or dropped", () => {
    const agency = agencyPairKeysOf(STATED, ALL_PAIRS);
    const self = selfServePairKeysOf(STATED, ALL_PAIRS);
    expect([...agency, ...self].sort()).toEqual(ALL_PAIRS.map((p) => pairKey(p.orgId, p.brandId)).sort());
    expect(agency.filter((k) => self.includes(k))).toEqual([]);
  });

  it("totals agency + self-serve, and reconciles with the total served beside them", () => {
    for (const b of buildMrrSplit(inputs(), NOW, WINDOWS).monthly) {
      if (b.totalMrrUsd === null) continue;
      expect(b.totalMrrUsd).toBe(Math.round((b.agencyMrrUsd + b.selfServeMrrUsd!) * 100) / 100);
      expect(b.totalArrUsd).toBe(Math.round(b.totalMrrUsd * 12 * 100) / 100);
    }
  });

  it("honours both inclusive bounds, and a null start means the brand's first BILLED day", () => {
    const row = STATED[0];
    expect(statedAmountInForce(row, "2026-07-19", "2026-07-20")).toBe(false);
    expect(statedAmountInForce(row, "2026-07-20", "2026-07-20")).toBe(true);
    expect(statedAmountInForce(row, "2026-08-31", "2026-07-20")).toBe(true);
    expect(statedAmountInForce(row, "2026-09-01", "2026-07-20")).toBe(false);
    // Exactly one of the two rows is ever in force, so the sum never doubles.
    expect(agencyStatedMrrOn(STATED, AUG, FIRST_BILLED)).toBe(1500);
    expect(agencyStatedMrrOn(STATED, TODAY, FIRST_BILLED)).toBe(2000);
  });

  it("reports NO agency and the whole fleet as self-serve when nothing is stated", () => {
    const split = buildMrrSplit(inputs({ statedRows: [] }), NOW, WINDOWS);
    expect(split.currentAgencyMrrUsd).toBe(0);
    expect(split.agencyOrgIds).toEqual([]);
    expect(split.agencyPairKeys).toEqual([]);
    expect(split.currentAgencyBudgetMrrUsd).toBe(0);
    // …and the agency's brands now sit on the SaaS side, so the self-serve figure GROWS.
    const withStated = buildMrrSplit(inputs(), NOW, WINDOWS);
    expect(split.currentSelfServeMrrUsd!).toBeGreaterThan(withStated.currentSelfServeMrrUsd!);
  });
});

describe("the live figures and the current bucket are ONE number", () => {
  it("the live scalar equals the current monthly bucket, computed the same way", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    const sep = split.monthly.find((b) => b.period === "2026-09")!;
    expect(sep.referenceDate).toBe(TODAY);
    expect(split.currentSelfServeMrrUsd).toBe(sep.selfServeMrrUsd);
    expect(split.currentAgencyMrrUsd).toBe(sep.agencyMrrUsd);
    expect(split.currentTotalMrrUsd).toBe(sep.totalMrrUsd);
    expect(split.currentSelfServeBasis).toBe(sep.selfServeBasis);
  });

  it("today's self-serve figure reflects AUDIENCE EXHAUSTION, which the fleet run-rate beside it does not", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    // A ($100) counts; B ($2) is exhausted, C has no amount, D stopped paying.
    expect(split.currentSelfServeMrrUsd).toBe(3000);
    // The recorded fleet figure still carries B's money, so the two legitimately differ.
    expect(split.currentSelfServeMrrUsd! + split.currentAgencyBudgetMrrUsd).not.toBe(5820);
  });

  it("emits the same periods as the committed series, against the same dates", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    expect(split.monthly.map((b) => b.period)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(referenceDatesOf(SNAPSHOTS, TODAY, WINDOWS, 5820)).toContain(TODAY);
    expect(referenceDatesOf(SNAPSHOTS, TODAY, WINDOWS, 5820)).toContain(AUG);
    // A month with no recorded snapshot is OMITTED, never fabricated.
    expect(split.monthly.map((b) => b.period)).not.toContain("2026-06");
  });

  it("skips growth across an unmeasurable period rather than comparing over the gap", () => {
    const f = facts();
    f.budgetByDay = new Map([...f.budgetByDay].map(([k, v]) => [k, new Map([...v].filter(([d]) => d !== AUG))]));
    f.recordedEarning = new Map();
    f.paymentByOrg = new Map();
    f.activityDays = new Map();
    const split = buildMrrSplit(inputs({ facts: f }), NOW, WINDOWS);
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    const sep = split.monthly.find((b) => b.period === "2026-09")!;
    const jul = split.monthly.find((b) => b.period === "2026-07")!;
    expect(aug.totalMrrUsd).toBeNull();
    expect(aug.growthPct).toBeNull();
    // September's growth is measured against JULY, the previous MEASURED point.
    expect(sep.growthPct).toBe(Math.round(((sep.totalMrrUsd! - jul.totalMrrUsd!) / jul.totalMrrUsd!) * 1000) / 10);
  });
});

/**
 * TWO SOURCES FOR ONE QUANTITY, NEVER BLENDED — today's amount is billing's LIVE budget, every
 * earlier day's is its replay.
 *
 * The production shape these reproduce, measured 2026-09-14 against billing's own database: brand
 * `b97440f6…` (Steady Recruitment) held a LIVE $15/day while the newest row in the change log said
 * $1 — the run-rate counted $30/month where it should have counted $450 — and brand `a179bbd9…`
 * (Shockwavecenters) held a live $8/day against ZERO change rows, so it was dropped from the figure
 * entirely and reported as having no recorded amount while it was plainly funded and running.
 *
 * Every case asserts the DIVERGENCE between the two records: a suite that only checked "an amount
 * came back" would pass on the implementation this replaces, which read the replay for both eras.
 */
describe("the amount in force — LIVE for today, REPLAYED for every earlier day", () => {
  /** The prod shape: A's live budget is a fifteenth of its replay; C is funded live and absent from the log. */
  const DIVERGENT: DayFacts["liveBudget"] = { day: TODAY, byPair: new Map([[K.a, 15], [K.c, 8]]) };

  it("counts TODAY at billing's LIVE amount, never the replay's stale one", () => {
    const v = evaluatePairDay(K.a, SAAS_A, TODAY, facts({ liveBudget: DIVERGENT }));
    // The replay still says $100/day for today; the live budget says $15, and the live budget wins.
    expect(v.configuredDailyBudgetUsd).toBe(15);
    expect(v.mrrUsd).toBe(450);
    expect(v.mrrUsd).not.toBe(3000); // what the replay-for-both-eras implementation answered
    expect(v.amountSource).toBe("live");
    expect(v.excludedBy).toBeNull();
  });

  it("counts a brand billing's change log has NEVER recorded, on its live amount alone", () => {
    // Shockwavecenters: funded, running, and invisible to the replay — the brand this dropped.
    const v = evaluatePairDay(K.c, SAAS_C, TODAY, facts({ liveBudget: DIVERGENT }));
    expect(v.configuredDailyBudgetUsd).toBe(8);
    expect(v.mrrUsd).toBe(240);
    expect(v.amountSource).toBe("live");
    expect(v.excludedBy).toBeNull();
    // It is no longer an under-statement to report: it is counted.
    expect(v.budgetUnrecordedWhileActive).toBe(false);

    const sum = sumSideOn(SELF_KEYS, TODAY, facts({ liveBudget: DIVERGENT }));
    expect(sum.unrecordedBudgetPairCount).toBe(0);
    expect(sum.mrrUsd).toBe(450 + 240); // A and C; B is exhausted and D's payment stopped
  });

  it("never back-casts the live amount onto a PAST day — the replay still answers there", () => {
    const f = facts({ liveBudget: DIVERGENT });
    const aug = evaluatePairDay(K.a, SAAS_A, AUG, f);
    expect(aug.configuredDailyBudgetUsd).toBe(100); // the replay, not today's $15
    expect(aug.amountSource).toBe("replayed");

    // And a brand the log never recorded stays unrecorded in the past, however funded it is now.
    const augC = evaluatePairDay(K.c, SAAS_C, AUG, f);
    expect(augC.configuredDailyBudgetUsd).toBeNull();
    expect(augC.amountSource).toBeNull();
    expect(augC.excludedBy).toBe("no_recorded_amount");
  });

  it("leaves a pair billing holds NO live amount for unrecorded — absent is never a zero", () => {
    // C is active today, and billing answers with nothing: the gap stays visible rather than filled.
    const v = evaluatePairDay(K.c, SAAS_C, TODAY, facts({ liveBudget: { day: TODAY, byPair: new Map() } }));
    expect(v.configuredDailyBudgetUsd).toBeNull();
    expect(v.amountSource).toBeNull();
    expect(v.mrrUsd).toBe(0);
    expect(v.excludedBy).toBe("no_recorded_amount");
    expect(v.budgetUnrecordedWhileActive).toBe(true);
  });

  it("does not let the live amount move an exclusion the EARLIER conditions already made", () => {
    // B was recorded as not earning and D's payment stopped; a live amount for either changes
    // nothing, and the reason stays the condition the arithmetic actually stopped at — never the
    // amount, which the short-circuit never reached.
    const f = facts({ liveBudget: { day: TODAY, byPair: new Map([[K.b, 99], [K.d, 99]]) } });
    expect(evaluatePairDay(K.b, SAAS_B, TODAY, f).excludedBy).toBe("not_earning_recorded");
    expect(evaluatePairDay(K.d, SAAS_D, TODAY, f).excludedBy).toBe("payment_stopped");
    // Both still state what billing holds for them — a reader asking "what is this customer
    // configured at" is asking a different question from "did it count".
    expect(evaluatePairDay(K.b, SAAS_B, TODAY, f).configuredDailyBudgetUsd).toBe(99);
  });

  it("makes a day MEASURABLE on a live amount alone, with nothing else on record", () => {
    const onlyLive = facts({
      budgetByDay: new Map(),
      recordedEarning: new Map(),
      paymentByOrg: new Map(),
      activityDays: new Map([[K.a, new Set([TODAY])]]),
      liveBudget: { day: TODAY, byPair: new Map([[K.a, 20]]) },
    });
    const sum = sumSideOn(SELF_KEYS, TODAY, onlyLive);
    expect(sum.nothingRecorded).toBe(false);
    expect(sum.mrrUsd).toBe(600);

    // With no live amount either, the day genuinely has nothing on it and says so.
    const nothing = facts({
      budgetByDay: new Map(),
      recordedEarning: new Map(),
      paymentByOrg: new Map(),
      activityDays: new Map(),
      liveBudget: { day: TODAY, byPair: new Map() },
    });
    expect(sumSideOn(SELF_KEYS, TODAY, nothing).nothingRecorded).toBe(true);
  });

  it("carries the live amount through the whole split, live figure and breakdown alike", () => {
    const split = buildMrrSplit(inputs({ facts: facts({ liveBudget: DIVERGENT }) }), NOW, WINDOWS);
    expect(split.currentSelfServeMrrUsd).toBe(450 + 240);

    const rows = split.selfServeBreakdown.rows;
    const a = rows.find((r) => r.brandId === BRAND_A)!;
    const c = rows.find((r) => r.brandId === BRAND_C)!;
    expect([a.configuredDailyBudgetUsd, a.amountSource, a.countedMrrUsd]).toEqual([15, "live", 450]);
    expect([c.configuredDailyBudgetUsd, c.amountSource, c.countedMrrUsd]).toEqual([8, "live", 240]);
    // The rows are still the terms of the sum, so they still add up to it.
    expect(rows.reduce((t, r) => t + r.countedMrrUsd, 0)).toBe(split.currentSelfServeMrrUsd);

    // The HISTORY is untouched: August is still read off the replay.
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    const augReplay = buildMrrSplit(inputs(), NOW, WINDOWS).monthly.find((b) => b.period === "2026-08")!;
    expect(aug.selfServeMrrUsd).toBe(augReplay.selfServeMrrUsd);
  });
});
