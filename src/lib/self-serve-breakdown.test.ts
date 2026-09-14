/**
 * Guards for THE ROWS BEHIND THE SaaS RUN-RATE — `selfServeBreakdown`.
 *
 * ONE fixture, carrying the whole self-serve side as production read it on 2026-09-14: seven brands,
 * $102/day configured between them, of which $54/day qualified — $1,620/month — with each of the five
 * excluded brands stopped by a DIFFERENT one of the four conditions. Every case asserts the
 * DIVERGENCE between what a brand has configured and what it contributes, so a suite that only
 * checked "rows came back" would pass on an implementation that listed every brand at its configured
 * amount, which is the answer this exists to avoid giving.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildMrrSplit,
  campaignAxesOf,
  evaluatePairDay,
  pairKey,
  recordedEarningOf,
  sumSideOn,
  type DayFacts,
  type MrrSplitInputs,
} from "./agency-self-serve-compute.js";
import type { CampaignDayAnswer, PaymentStoppedFacts } from "./mrr-day-facts-clients.js";
import type { StatedAmountRow } from "./stated-monthly-amounts-store.js";

const TODAY = "2026-09-14";
const NOW = new Date(`${TODAY}T12:00:00Z`);
const WINDOWS = { weeks: 8, months: 4 };

// The production self-serve side, brand for brand.
const COUNTED_BIG = "9546c4b2-c4c8-4a0e-a4e6-cf486d5bcf22"; // $49/day — counted
const NO_CAMPAIGN_A = "b97440f6-5822-43de-ad1d-9886723536d6"; // $15/day — no active campaign
const PAYMENT_STOPPED = "c992c378-caa8-49fa-b914-3628ee99c404"; // $10/day — payment stopped 2026-07-21
const NO_CAMPAIGN_B = "7604c385-1f02-4016-b42f-344565bcd36d"; // $10/day — no active campaign
const EXHAUSTED = "a179bbd9-8eed-4dba-9338-78125922b0c6"; // $8/day — every audience exhausted
const NO_CAMPAIGN_C = "51aa330c-583a-45cc-8f4f-b840822beafd"; // $5/day — no active campaign
const COUNTED_SMALL = "6e21bb6c-67bc-45f3-8a6d-52230338d7e4"; // $5/day — counted

const AGENCY_ORG = "org-agency";
const AGENCY_BRAND = "brand-agency";

/** One org per brand, as production has them — the pair is what everything keys on. */
const ORG_OF: Record<string, string> = {
  [COUNTED_BIG]: "org-1",
  [NO_CAMPAIGN_A]: "org-2",
  [PAYMENT_STOPPED]: "org-3",
  [NO_CAMPAIGN_B]: "org-4",
  [EXHAUSTED]: "org-5",
  [NO_CAMPAIGN_C]: "org-6",
  [COUNTED_SMALL]: "org-7",
};

const SELF_BRANDS = [COUNTED_BIG, NO_CAMPAIGN_A, PAYMENT_STOPPED, NO_CAMPAIGN_B, EXHAUSTED, NO_CAMPAIGN_C, COUNTED_SMALL];

const CONFIGURED_USD: Record<string, number> = {
  [COUNTED_BIG]: 49,
  [NO_CAMPAIGN_A]: 15,
  [PAYMENT_STOPPED]: 10,
  [NO_CAMPAIGN_B]: 10,
  [EXHAUSTED]: 8,
  [NO_CAMPAIGN_C]: 5,
  [COUNTED_SMALL]: 5,
};

const K = Object.fromEntries(SELF_BRANDS.map((b) => [b, pairKey(ORG_OF[b], b)])) as Record<string, string>;
const AGENCY_KEY = pairKey(AGENCY_ORG, AGENCY_BRAND);

const ALL_PAIRS = [
  ...SELF_BRANDS.map((b) => ({ orgId: ORG_OF[b], brandId: b })),
  { orgId: AGENCY_ORG, brandId: AGENCY_BRAND },
];

function answer(id: string, status: CampaignDayAnswer["status"], audience: CampaignDayAnswer["audience"]): CampaignDayAnswer {
  return { campaignId: id, status, audience, earning: null, statusRecordedSince: "2026-09-12T00:00:00Z", audienceRecordedSince: "2026-09-12T00:00:00Z" };
}

/** What campaign-service recorded about each brand's campaigns TODAY. */
const ANSWERS_TODAY: Record<string, CampaignDayAnswer[]> = {
  [K[COUNTED_BIG]]: [answer("c-big", "ongoing", "available")],
  // Three brands whose only campaigns are stopped — the "no active campaign" shape.
  [K[NO_CAMPAIGN_A]]: [answer("c-a1", "stopped", "not_recorded"), answer("c-a2", "stopped", "not_recorded")],
  [K[NO_CAMPAIGN_B]]: [answer("c-b1", "stopped", "not_recorded")],
  [K[NO_CAMPAIGN_C]]: [answer("c-c1", "stopped", "not_recorded")],
  // Paying is what stops this one — its campaign is perfectly healthy, which is the point.
  [K[PAYMENT_STOPPED]]: [answer("c-p1", "ongoing", "available")],
  // Running, and nobody left to contact: the exhaustions are open on every ONGOING campaign, beside
  // a stopped ancestor that says nothing either way.
  [K[EXHAUSTED]]: [answer("c-e0", "stopped", "not_recorded"), answer("c-e1", "ongoing", "exhausted"), answer("c-e2", "ongoing", "exhausted")],
  [K[COUNTED_SMALL]]: [answer("c-small", "ongoing", "available")],
  [AGENCY_KEY]: [answer("c-agency", "ongoing", "available")],
};

function campaignAnswers(): Map<string, Map<string, CampaignDayAnswer[]>> {
  return new Map(Object.entries(ANSWERS_TODAY).map(([key, list]) => [key, new Map([[TODAY, list]])]));
}

/**
 * The RECORDED verdict, derived from the very answers above by the same collapse the caller applies —
 * one source, so the row's "which condition said no" can never describe a different set of campaigns
 * than the verdict the arithmetic took.
 */
function recordedEarning(): Map<string, Map<string, boolean | null>> {
  return new Map(Object.entries(ANSWERS_TODAY).map(([key, list]) => [key, new Map([[TODAY, recordedEarningOf(list)]])]));
}

function budgets(): Map<string, Map<string, number>> {
  const entries: Array<[string, Map<string, number>]> = SELF_BRANDS.map((b) => [K[b], new Map([[TODAY, CONFIGURED_USD[b]]])]);
  entries.push([AGENCY_KEY, new Map([[TODAY, 100]])]);
  return new Map(entries);
}

function payments(): Map<string, PaymentStoppedFacts> {
  const clear: PaymentStoppedFacts = { recordBeginsOn: "2026-06-01", periods: [] };
  const map = new Map<string, PaymentStoppedFacts>(Object.values(ORG_OF).map((o) => [o, clear]));
  map.set(AGENCY_ORG, clear);
  map.set(ORG_OF[PAYMENT_STOPPED], { recordBeginsOn: "2026-06-01", periods: [{ startedOn: "2026-07-21", endedOn: null }] });
  return map;
}

function facts(over: Partial<DayFacts> = {}): DayFacts {
  const base: DayFacts = {
    budgetByDay: budgets(),
    activityDays: new Map(SELF_BRANDS.map((b) => [K[b], new Set([TODAY])])),
    recordedEarning: recordedEarning(),
    paymentByOrg: payments(),
    campaignAnswers: campaignAnswers(),
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

const BRAND_NAMES = new Map<string, { name: string | null; domain: string | null }>([
  [K[COUNTED_BIG], { name: "Opsfolio", domain: "opsfolio.example" }],
  [K[NO_CAMPAIGN_A], { name: "Shockwave Centers", domain: "shockwave.example" }],
  [K[PAYMENT_STOPPED], { name: "Doc Dinners", domain: "docdinners.example" }],
  [K[NO_CAMPAIGN_B], { name: "Fourth Brand", domain: "fourth.example" }],
  [K[EXHAUSTED], { name: "Fifth Brand", domain: "fifth.example" }],
  [K[NO_CAMPAIGN_C], { name: "Sixth Brand", domain: "sixth.example" }],
  // COUNTED_SMALL is deliberately absent: an unnamed brand is reported null, never guessed.
]);

const STATED: StatedAmountRow[] = [
  {
    id: "row-agency",
    orgId: AGENCY_ORG,
    brandId: AGENCY_BRAND,
    amountUsd: 4000,
    startDate: "2026-01-01",
    endDate: null,
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function inputs(over: Partial<MrrSplitInputs> = {}): MrrSplitInputs {
  return {
    statedRows: STATED,
    allPairs: ALL_PAIRS,
    facts: facts(),
    firstBilledDayByPair: new Map(),
    snapshots: [{ date: "2026-09-13", mrrUsd: 6000 }],
    currentMrrUsd: 6060,
    earningRecordBeginsOn: "2026-09-12",
    brandNamesByPair: BRAND_NAMES,
    ...over,
  };
}

const rowOf = (split: ReturnType<typeof buildMrrSplit>, brandId: string) =>
  split.selfServeBreakdown.rows.find((r) => r.brandId === brandId)!;

describe("the SaaS run-rate is served WITH its terms", () => {
  it("states every self-serve brand, and the rows SUM to the figure beside them", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    const bd = split.selfServeBreakdown;

    expect(bd.rows).toHaveLength(7);
    expect(bd.referenceDate).toBe(TODAY);

    // $49 + $5 of $102 configured qualified — the production figure, to the dollar.
    expect(bd.configuredMrrUsd).toBe(102 * 30);
    expect(bd.countedMrrUsd).toBe(54 * 30);
    expect(bd.countedMrrUsd).toBe(1620);
    expect(bd.countedMrrUsd).toBe(split.currentSelfServeMrrUsd);

    const summed = bd.rows.reduce((a, r) => a + r.countedMrrUsd, 0);
    expect(Math.round(summed * 100) / 100).toBe(split.currentSelfServeMrrUsd);

    // The divergence a row-set that merely echoed the configured amounts would not show.
    expect(bd.countedMrrUsd).toBeLessThan(bd.configuredMrrUsd);
    expect(bd.configuredMrrUsd - bd.countedMrrUsd!).toBe(48 * 30);
  });

  it("names EACH excluded brand's own condition, and never the same one twice by accident", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    expect(rowOf(split, COUNTED_BIG).excludedBy).toBeNull();
    expect(rowOf(split, COUNTED_SMALL).excludedBy).toBeNull();
    expect(rowOf(split, NO_CAMPAIGN_A).excludedBy).toBe("campaign_not_running");
    expect(rowOf(split, NO_CAMPAIGN_B).excludedBy).toBe("campaign_not_running");
    expect(rowOf(split, NO_CAMPAIGN_C).excludedBy).toBe("campaign_not_running");
    expect(rowOf(split, PAYMENT_STOPPED).excludedBy).toBe("payment_stopped");
    expect(rowOf(split, EXHAUSTED).excludedBy).toBe("audience_exhausted");
  });

  it("states all four conditions on every row, INCLUDING the ones the evaluation short-circuited past", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    // The payment-stopped brand has a perfectly healthy campaign and a real configured amount. A row
    // that reported only the condition that stopped it would read as a brand with nothing set up.
    const stopped = rowOf(split, PAYMENT_STOPPED);
    expect(stopped.paymentActive).toBe(false);
    expect(stopped.campaignRunning).toBe(true);
    expect(stopped.audienceAvailable).toBe(true);
    expect(stopped.amountInForce).toBe(true);
    expect(stopped.configuredDailyBudgetUsd).toBe(10);
    expect(stopped.countedMrrUsd).toBe(0);

    // The exhausted brand is running — the audience axis alone is what stops it.
    const exhausted = rowOf(split, EXHAUSTED);
    expect(exhausted.campaignRunning).toBe(true);
    expect(exhausted.audienceAvailable).toBe(false);
    expect(exhausted.configuredDailyBudgetUsd).toBe(8);

    // A brand whose campaigns are all stopped has NO audience answer — a stopped campaign's audience
    // says nothing about whether the brand was earning, so `null` is the honest reading.
    const idle = rowOf(split, NO_CAMPAIGN_A);
    expect(idle.campaignRunning).toBe(false);
    expect(idle.audienceAvailable).toBeNull();
    expect(idle.configuredDailyBudgetUsd).toBe(15);
    expect(idle.paymentActive).toBe(true);

    const counted = rowOf(split, COUNTED_BIG);
    expect(counted).toMatchObject({ paymentActive: true, campaignRunning: true, audienceAvailable: true, amountInForce: true, basis: "recorded" });
    expect(counted.countedMrrUsd).toBe(1470);
  });

  it("carries a human-readable name, and reports an unnamed brand as null rather than guessing", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    expect(rowOf(split, COUNTED_BIG).brandName).toBe("Opsfolio");
    expect(rowOf(split, COUNTED_BIG).brandDomain).toBe("opsfolio.example");
    expect(rowOf(split, COUNTED_SMALL).brandName).toBeNull();
    expect(rowOf(split, COUNTED_SMALL).brandDomain).toBeNull();
    // A brand with no name is still a row: the identifier answers even when the name does not.
    expect(rowOf(split, COUNTED_SMALL).countedMrrUsd).toBe(150);
  });

  it("orders the rows richest first, on a stable tie-break", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    const order = split.selfServeBreakdown.rows.map((r) => r.brandId);
    expect(order.slice(0, 2)).toEqual([COUNTED_BIG, COUNTED_SMALL]); // the only two that counted
    // Then the excluded ones by what they have configured, largest first.
    expect(order[2]).toBe(NO_CAMPAIGN_A); // $15
    // $10 twice: the brand id breaks it, so the same evidence always comes back in the same order.
    expect(order.slice(3, 5)).toEqual([NO_CAMPAIGN_B, PAYMENT_STOPPED]); // 7604… before c992…
    expect(order.slice(5)).toEqual([EXHAUSTED, NO_CAMPAIGN_C]); // $8 then $5
    expect(buildMrrSplit(inputs(), NOW, WINDOWS).selfServeBreakdown.rows.map((r) => r.brandId)).toEqual(order);
  });

  it("leaves the AGENCY side out of the breakdown entirely, and both halves unmoved", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);
    expect(split.selfServeBreakdown.rows.some((r) => r.brandId === AGENCY_BRAND)).toBe(false);
    expect(split.currentAgencyMrrUsd).toBe(4000);
    expect(split.currentTotalMrrUsd).toBe(4000 + 1620);
  });
});

describe("each row says WHICH of billing's records its amount came from", () => {
  it("prices today off the LIVE budget when it disagrees with the replay, and says `live`", () => {
    // The prod divergence: billing's change log still carries $49/day for the biggest brand while
    // its live ceiling is $75 — the run-rate under-stated it by $780/month.
    const live = { day: TODAY, byPair: new Map([[K[COUNTED_BIG], 75], [K[COUNTED_SMALL], 5]]) };
    const split = buildMrrSplit(inputs({ facts: facts({ liveBudget: live }) }), NOW, WINDOWS);
    const bd = split.selfServeBreakdown;

    const big = rowOf(split, COUNTED_BIG);
    expect([big.configuredDailyBudgetUsd, big.amountSource, big.countedMrrUsd]).toEqual([75, "live", 2250]);
    expect(big.countedMrrUsd).not.toBe(49 * 30); // what the replay-for-both-eras implementation said

    // The rows are still the terms of the sum, so they still add to it exactly.
    expect(bd.countedMrrUsd).toBe(80 * 30);
    expect(bd.countedMrrUsd).toBe(split.currentSelfServeMrrUsd);
    expect(bd.rows.reduce((a, r) => a + r.countedMrrUsd, 0)).toBe(bd.countedMrrUsd);
    // And `configuredMrrUsd` is read off the same amounts, so it moves with them.
    expect(bd.configuredMrrUsd).toBe(80 * 30);
  });

  it("reports a row billing holds no live amount for as unrecorded, with a null source", () => {
    const split = buildMrrSplit(
      inputs({ facts: facts({ liveBudget: { day: TODAY, byPair: new Map([[K[COUNTED_SMALL], 5]]) } }) }),
      NOW,
      WINDOWS,
    );
    const big = rowOf(split, COUNTED_BIG);
    expect(big.configuredDailyBudgetUsd).toBeNull();
    expect(big.amountSource).toBeNull();
    expect(big.excludedBy).toBe("no_recorded_amount");
    expect(split.selfServeBreakdown.countedMrrUsd).toBe(5 * 30);
  });
});

describe("the rows EXPLAIN the total and can never move it", () => {
  it("answers the identical figures with the display-only campaign answers absent", () => {
    const withAnswers = buildMrrSplit(inputs(), NOW, WINDOWS);
    const without = buildMrrSplit(inputs({ facts: facts({ campaignAnswers: undefined }) }), NOW, WINDOWS);

    expect(without.currentSelfServeMrrUsd).toBe(withAnswers.currentSelfServeMrrUsd);
    expect(without.currentTotalMrrUsd).toBe(withAnswers.currentTotalMrrUsd);
    expect(without.monthly).toEqual(withAnswers.monthly);
    expect(without.weekly).toEqual(withAnswers.weekly);
    expect(without.selfServeBreakdown.countedMrrUsd).toBe(withAnswers.selfServeBreakdown.countedMrrUsd);
  });

  it("says `not_earning_recorded` rather than guessing which axis said no when it cannot tell", () => {
    // Without the per-campaign answers the verdict is still a recorded NO — it just cannot be
    // attributed to one of the two axes, and inventing one would be the fabrication this refuses.
    const split = buildMrrSplit(inputs({ facts: facts({ campaignAnswers: undefined }) }), NOW, WINDOWS);
    const row = rowOf(split, NO_CAMPAIGN_A);
    expect(row.excludedBy).toBe("not_earning_recorded");
    expect(row.campaignRunning).toBeNull();
    expect(row.audienceAvailable).toBeNull();
    expect(row.configuredDailyBudgetUsd).toBe(15); // the amount still answers
  });

  it("the rest of the split is byte-identical with the breakdown stripped off", () => {
    const { selfServeBreakdown: _a, ...bare } = buildMrrSplit(inputs(), NOW, WINDOWS);
    const { selfServeBreakdown: _b, ...bareNoNames } = buildMrrSplit(inputs({ brandNamesByPair: undefined }), NOW, WINDOWS);
    expect(bareNoNames).toEqual(bare);
  });
});

describe("the gaps are visible rather than filled in", () => {
  it("reports a pair billing holds NO amount for as `no_recorded_amount`, contributing nothing", () => {
    const noBudget = budgets();
    noBudget.delete(K[COUNTED_BIG]);
    const split = buildMrrSplit(inputs({ facts: facts({ budgetByDay: noBudget }) }), NOW, WINDOWS);
    const row = rowOf(split, COUNTED_BIG);

    expect(row.configuredDailyBudgetUsd).toBeNull(); // never a 0 standing in for "we hold none"
    expect(row.amountInForce).toBe(false);
    expect(row.excludedBy).toBe("no_recorded_amount");
    expect(row.countedMrrUsd).toBe(0);
    // The under-statement is counted beside the figure, exactly as it is on the buckets.
    expect(split.selfServeBreakdown.countedMrrUsd).toBe(150);
    expect(split.selfServeBreakdown.configuredMrrUsd).toBe((102 - 49) * 30);
  });

  it("tells a recorded ZERO apart from an absent record", () => {
    const zeroed = budgets();
    zeroed.set(K[COUNTED_BIG], new Map([[TODAY, 0]]));
    const row = rowOf(buildMrrSplit(inputs({ facts: facts({ budgetByDay: zeroed }) }), NOW, WINDOWS), COUNTED_BIG);
    expect(row.configuredDailyBudgetUsd).toBe(0);
    expect(row.excludedBy).toBe("zero_amount");
  });

  it("marks a row decided by the ACTIVITY fallback approximated, and says so as its reason", () => {
    // campaign-service records nothing about this brand, and it has not billed a day nearby.
    const silent = facts({
      recordedEarning: new Map(),
      campaignAnswers: new Map(),
      activityDays: new Map(),
    });
    const row = rowOf(buildMrrSplit(inputs({ facts: silent }), NOW, WINDOWS), COUNTED_BIG);
    expect(row.excludedBy).toBe("no_recent_activity");
    expect(row.basis).toBe("approximated");
    expect(row.countedMrrUsd).toBe(0);
  });

  it("reports an unrecorded PAYMENT axis as null, never as a yes", () => {
    const young = payments();
    young.set(ORG_OF[COUNTED_BIG], { recordBeginsOn: "2026-09-20", periods: [] });
    const row = rowOf(buildMrrSplit(inputs({ facts: facts({ paymentByOrg: young }) }), NOW, WINDOWS), COUNTED_BIG);
    expect(row.paymentActive).toBeNull();
    expect(row.basis).toBe("approximated"); // an unrecorded axis is a fallback, not a yes
    expect(row.countedMrrUsd).toBe(1470); // still counted — the other three conditions held
  });
});

describe("the two campaign axes are split under the verdict's own doctrine", () => {
  it("lets an UNKNOWN campaign beat a recorded stop, on both axes", () => {
    expect(campaignAxesOf([answer("a", "stopped", "not_recorded"), answer("b", "not_recorded", "not_recorded")])).toEqual({
      running: null,
      audienceAvailable: null,
    });
    expect(campaignAxesOf([answer("a", "ongoing", "exhausted"), answer("b", "ongoing", "not_recorded")])).toEqual({
      running: true,
      audienceAvailable: null,
    });
  });

  it("reads the audience over the ONGOING campaigns only", () => {
    // A stopped ancestor's audience is not evidence about the live campaign beside it.
    expect(campaignAxesOf([answer("old", "stopped", "exhausted"), answer("live", "ongoing", "available")])).toEqual({
      running: true,
      audienceAvailable: true,
    });
    // Nothing running ⇒ nothing to ask about.
    expect(campaignAxesOf([answer("old", "stopped", "exhausted")])).toEqual({ running: false, audienceAvailable: null });
    expect(campaignAxesOf([])).toEqual({ running: null, audienceAvailable: null });
    expect(campaignAxesOf(undefined)).toEqual({ running: null, audienceAvailable: null });
  });

  it("agrees with the collapsed verdict the arithmetic takes, on the whole fixture", () => {
    for (const [key, list] of Object.entries(ANSWERS_TODAY)) {
      const axes = campaignAxesOf(list);
      const verdict = recordedEarningOf(list);
      if (verdict === true) expect(axes).toEqual({ running: true, audienceAvailable: true });
      if (verdict === false) expect(axes.running === false || axes.audienceAvailable === false).toBe(true);
      if (verdict === null) expect(axes.running === null || axes.audienceAvailable === null).toBe(true);
      expect(key).toBeTruthy();
    }
  });
});

describe("the sum emits its own terms", () => {
  it("returns one row per pair, in the order it was given them, adding to the figure", () => {
    const keys = SELF_BRANDS.map((b) => K[b]);
    const side = sumSideOn(keys, TODAY, facts());
    expect(side.rows.map((r) => r.brandId)).toEqual(SELF_BRANDS);
    expect(Math.round(side.rows.reduce((a, r) => a + r.countedMrrUsd, 0) * 100) / 100).toBe(side.mrrUsd);
    expect(side.pairCount).toBe(side.rows.filter((r) => r.countedMrrUsd > 0).length);
  });

  it("carries the same verdict the evaluator returned, field for field", () => {
    const f = facts();
    const key = K[EXHAUSTED];
    const verdict = evaluatePairDay(key, ORG_OF[EXHAUSTED], TODAY, f);
    const row = sumSideOn([key], TODAY, f).rows[0];
    expect(row.countedMrrUsd).toBe(verdict.mrrUsd);
    expect(row.excludedBy).toBe(verdict.excludedBy);
    expect(row.campaignRunning).toBe(verdict.campaignRunning);
    expect(row.audienceAvailable).toBe(verdict.audienceAvailable);
    expect(row.configuredDailyBudgetUsd).toBe(verdict.configuredDailyBudgetUsd);
  });
});
