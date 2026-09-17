/**
 * WHAT ONE OUTCOME HAS COST, DAY BY DAY — the pure builder, driven from ONE fixture shaped like the
 * campaign that reported it.
 *
 * Prod 2026-09-17, brand `9546c4b2…` / campaign `31df7683…` / leg `start_to_website_visit`: **31
 * clicks across five days** against **$247.193125** of dated committed spend, i.e. **$7.9740** a
 * website visit. Every case asserts a DIVERGENCE — between the cumulative curve and the per-day
 * ratio it must not be, between an entry leg and a deeper one on the SAME evidence, and between a
 * null and a zero — so a suite that only checked "points came back" would pass on an implementation
 * that charted a day-grain ratio or priced an outcome-less day at $0.
 */
import { describe, it, expect } from "vitest";
import { buildCostPerOutcomeHistory, type CostPerOutcomeTerms } from "./cost-per-outcome-history.js";
import type { SignalSeries } from "./revenue-engine.js";

const VISIT_STEP = { key: "website_visit", label: "Website visit", description: "A buyer lands on the brand's own website." } as const;
const MEETING_STEP = { key: "meeting_booked", label: "Meeting booked", description: "A meeting is on the calendar." } as const;

/** The reported campaign's entry leg: the click IS the outcome, so the rate is 1. */
const ENTRY: CostPerOutcomeTerms = {
  legKey: "start_to_website_visit",
  outcomeStep: VISIT_STEP,
  driver: "click",
  rateFromDriver: 1,
  outcomeObserved: true,
};

/** The SAME driver signal, one rung deeper: 20% of visits book, so the count is a fifth and the price five times. */
const DEEPER: CostPerOutcomeTerms = {
  legKey: "website_visit_to_meeting_booked",
  outcomeStep: MEETING_STEP,
  driver: "click",
  rateFromDriver: 0.2,
  outcomeObserved: false,
};

/** Prod's own five dated days of clicks. 31 total, none undated. */
const CLICKS: SignalSeries = {
  total: 31,
  undatedCount: 0,
  daily: [
    { date: "2026-09-11", count: 4 },
    { date: "2026-09-14", count: 6 },
    { date: "2026-09-15", count: 9 },
    { date: "2026-09-16", count: 9 },
    { date: "2026-09-17", count: 3 },
  ],
};

/** Prod's own dated committed buckets, summing to $247.193125. */
const SPEND = new Map<string, number>([
  ["2026-09-11", 49.054782573438],
  ["2026-09-12", 49.18461450119999],
  ["2026-09-13", 49.054732183199],
  ["2026-09-14", 49.2177288312],
  ["2026-09-15", 49.1472668796],
  ["2026-09-16", 1.534],
  ["2026-09-17", 0],
]);

const TOTAL_SPEND = [...SPEND.values()].reduce((a, b) => a + b, 0);

describe("the dated cost per outcome a browser could not compute", () => {
  it("terminates on the scope's OWN cost per outcome — $7.9740, not a per-day ratio", () => {
    const history = buildCostPerOutcomeHistory(SPEND, CLICKS, ENTRY);
    const last = history.daily.at(-1)!;

    expect(last.date).toBe("2026-09-17");
    expect(last.cumulativeOutcomes).toBe(31);
    expect(last.cumulativeSpendUsd).toBeCloseTo(TOTAL_SPEND, 9);
    expect(last.costPerOutcomeUsd).toBeCloseTo(TOTAL_SPEND / 31, 9);
    expect(last.costPerOutcomeUsd).toBeCloseTo(7.974, 3);

    // THE DIVERGENCE: the last day spent NOTHING and saw 3 clicks, so a period-grain point would
    // read $0.00 there — the statistic this curve exists not to be.
    expect(SPEND.get("2026-09-17")).toBe(0);
    expect(last.costPerOutcomeUsd).toBeGreaterThan(7);
  });

  it("spans the same days the spend does, and carries a day with spend and no outcome forward", () => {
    const history = buildCostPerOutcomeHistory(SPEND, CLICKS, ENTRY);
    expect(history.daily.map((p) => p.date)).toEqual([
      "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
    ]);

    // 12 and 13 have spend and no new click, so the price RISES across them — the honest shape of
    // paying for outcomes that have not arrived yet.
    const [d11, d12, d13] = history.daily;
    expect(d12!.cumulativeOutcomes).toBe(4);
    expect(d12!.costPerOutcomeUsd!).toBeGreaterThan(d11!.costPerOutcomeUsd!);
    expect(d13!.costPerOutcomeUsd!).toBeGreaterThan(d12!.costPerOutcomeUsd!);
  });

  it("prices a DEEPER leg five times dearer on identical evidence, and counts a fifth as many", () => {
    const entry = buildCostPerOutcomeHistory(SPEND, CLICKS, ENTRY);
    const deeper = buildCostPerOutcomeHistory(SPEND, CLICKS, DEEPER);

    expect(deeper.outcomeStep.key).toBe("meeting_booked");
    expect(deeper.outcomeObserved).toBe(false);
    expect(deeper.datedOutcomes).toBeCloseTo(6.2, 9);
    expect(entry.datedOutcomes).toBe(31);

    const e = entry.daily.at(-1)!.costPerOutcomeUsd!;
    const d = deeper.daily.at(-1)!.costPerOutcomeUsd!;
    // THE DIVERGENCE: same spend, same clicks, five times the price — an implementation that ignored
    // the rate would report one number for two different things.
    expect(d).toBeCloseTo(e * 5, 6);
    expect(deeper.daily.map((p) => p.date)).toEqual(entry.daily.map((p) => p.date));
  });

  it("answers NULL, never 0, on a day with spend and nothing to show for it", () => {
    const history = buildCostPerOutcomeHistory(
      new Map([["2026-09-11", 49.05], ["2026-09-12", 49.18]]),
      { total: 0, undatedCount: 0, daily: [] },
      ENTRY,
    );
    expect(history.daily).toHaveLength(2);
    // Every point answers — the series is all-null rather than absent, which is what a consumer
    // renders as "still learning" instead of as a broken chart.
    expect(history.daily.every((p) => p.costPerOutcomeUsd === null)).toBe(true);
    expect(history.daily.every((p) => p.cumulativeOutcomes === 0)).toBe(true);
    expect(history.datedOutcomes).toBe(0);
    expect(history.undatedOutcomes).toBe(0);
  });

  it("answers NULL, never 0, on an outcome with no attributed spend behind it", () => {
    const history = buildCostPerOutcomeHistory(new Map(), CLICKS, ENTRY);
    // Outcomes with no dated spend did not arrive for free — a $0 would say they did.
    expect(history.daily.every((p) => p.costPerOutcomeUsd === null)).toBe(true);
    expect(history.daily.at(-1)!.cumulativeOutcomes).toBe(31);
  });

  it("states the UNDATED share rather than dating it or dropping it", () => {
    const withUndated: SignalSeries = { ...CLICKS, total: 36, undatedCount: 5 };
    const history = buildCostPerOutcomeHistory(SPEND, withUndated, ENTRY);

    expect(history.datedOutcomes).toBe(31);
    expect(history.undatedOutcomes).toBe(5);
    // THE DIVERGENCE: the curve describes 31 of the scope's 36, and says so — a consumer reading the
    // final point as the whole scope's price would be off by the undated share, which is exactly why
    // it is on the wire. No fabricated day appears for them.
    expect(history.datedOutcomes + history.undatedOutcomes).toBe(withUndated.total);
    expect(history.daily.map((p) => p.date)).not.toContain(null);

    // A deeper leg's undated share is walked through the same rate as its dated one.
    expect(buildCostPerOutcomeHistory(SPEND, withUndated, DEEPER).undatedOutcomes).toBeCloseTo(1, 9);
  });

  it("is empty — never throwing, never fabricated — for a scope with neither spend nor an outcome", () => {
    const history = buildCostPerOutcomeHistory(new Map(), { total: 0, undatedCount: 0, daily: [] }, ENTRY);
    expect(history.daily).toEqual([]);
    expect(history.datedOutcomes).toBe(0);
    expect(history.undatedOutcomes).toBe(0);
    expect(history.outcomeStep.key).toBe("website_visit");
    expect(history.legKey).toBe("start_to_website_visit");
  });

  it("names the step it is denominated in, so a consumer labels the chart without deriving it", () => {
    const history = buildCostPerOutcomeHistory(SPEND, CLICKS, ENTRY);
    expect(history.outcomeStep).toEqual(VISIT_STEP);
    expect(history.legKey).toBe("start_to_website_visit");
    expect(history.outcomeObserved).toBe(true);
  });
});
