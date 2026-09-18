/**
 * WHAT SHARE OF THE OUTREACH CONVERTS, DAY BY DAY — the pure builder, driven from ONE fixture shaped
 * like the campaign that reported it.
 *
 * Prod 2026-09-17, brand `6e21bb6c…` / campaign `9e28ba26…` / leg `start_to_website_visit`: **143
 * website visits against 2,808 people reached**, both fully dated, i.e. **5.0925925925%** — which is
 * to the digit what `funnelSteps` states for that same leg's rung, and what
 * `outcomes.recipientsClicked / recipientsContacted` divides to. The slices below are that campaign's
 * own days.
 *
 * Every case asserts a DIVERGENCE — the cumulative curve against the per-day rate it must not be, an
 * entry leg against a deeper one on IDENTICAL evidence, a measured 0 against a null, and the whole
 * scope's rate against the dated curve's last point when part of the population is undated. A suite
 * that only checked "points came back" would pass on an implementation charting a day-grain ratio, or
 * one nulling the days nobody converted on — which is the period a customer is asking about.
 */
import { describe, it, expect } from "vitest";
import { buildConversionRateHistory } from "./conversion-rate-history.js";
import type { ScopeOutcomeTerms } from "./cost-per-outcome-history.js";
import type { SignalSeries } from "./revenue-engine.js";

const VISIT_STEP = { key: "website_visit", label: "Website visit", description: "A buyer lands on the brand's own website." } as const;
const FORM_STEP = { key: "form_filled", label: "Form submitted", description: "A buyer hands over their details on a form." } as const;

/** The reported campaign's entry leg: the click IS the outcome, so the rate is 1 and the count raw. */
const ENTRY: ScopeOutcomeTerms = {
  legKey: "start_to_website_visit",
  outcomeStep: VISIT_STEP,
  driver: "click",
  rateFromDriver: 1,
  outcomeObserved: true,
};

/** The SAME driver signal one rung deeper: 20% of visits fill the form, so the rate is a fifth. */
const DEEPER: ScopeOutcomeTerms = {
  legKey: "website_visit_to_form_filled",
  outcomeStep: FORM_STEP,
  driver: "click",
  rateFromDriver: 0.2,
  outcomeObserved: false,
};

const series = (daily: Array<[string, number]>, undatedCount = 0): SignalSeries => ({
  total: daily.reduce((s, [, c]) => s + c, 0) + undatedCount,
  undatedCount,
  daily: daily.map(([date, count]) => ({ date, count })),
});

/** Seven of the reported campaign's own reach days. */
const CONTACTED: Array<[string, number]> = [
  ["2026-09-11", 63],
  ["2026-09-12", 52],
  ["2026-09-13", 60],
  ["2026-09-14", 59],
  ["2026-09-15", 50],
  ["2026-09-16", 73],
  ["2026-09-17", 72],
];
/** Its own clicks over the same week — note 09-12, 09-13 and 09-17 converted NOBODY. */
const CLICKS: Array<[string, number]> = [
  ["2026-09-11", 5],
  ["2026-09-14", 10],
  ["2026-09-15", 5],
  ["2026-09-16", 7],
];

describe("the dated conversion rate", () => {
  it("is CUMULATIVE — never the day's own rate, which describes nothing", () => {
    const h = buildConversionRateHistory(series(CONTACTED), series(CLICKS), ENTRY);

    // 09-14 on its own is 10/59 = 16.9%; cumulatively it is 15/234 = 6.41%. THE DIVERGENCE: an
    // implementation charting the per-day ratio prints the first number, and it oscillates with
    // whichever day a click happened to land on rather than describing the campaign.
    const day14 = h.daily.find((p) => p.date === "2026-09-14")!;
    expect((10 / 59) * 100).toBeCloseTo(16.949, 3);
    expect(day14.cumulativeContacted).toBe(63 + 52 + 60 + 59);
    expect(day14.cumulativeOutcomes).toBe(15);
    expect(day14.conversionRatePct).toBeCloseTo((15 / 234) * 100, 9);

    const last = h.daily.at(-1)!;
    expect(last.cumulativeContacted).toBe(429);
    expect(last.cumulativeOutcomes).toBe(27);
    expect(last.conversionRatePct).toBeCloseTo((27 / 429) * 100, 9);
  });

  it("states a MEASURED 0 on a day nobody converted — the opposite of the cost curve's null rule", () => {
    // Nobody had converted by 09-12 or 09-13 in this fixture's opening... except they had on 09-11,
    // so drive the case that matters: reach with no conversion at all.
    const h = buildConversionRateHistory(series(CONTACTED), series([]), ENTRY);

    expect(h.daily).toHaveLength(CONTACTED.length);
    // 0 is a MEASUREMENT: we reached 63 people on 09-11 and none of them converted. Nulling it would
    // hide exactly the period a customer asking "is this working" needs to see.
    expect(h.daily.every((p) => p.conversionRatePct === 0)).toBe(true);
    expect(h.scopeConversionRatePct).toBe(0);
    expect(h.datedOutcomes).toBe(0);
  });

  it("is NULL only where there is no denominator — a scope that has reached nobody", () => {
    // An outcome dated before the scope reached anybody is the only shape that produces a null point.
    const h = buildConversionRateHistory(series([["2026-09-14", 59]]), series([["2026-09-11", 2]]), ENTRY);

    expect(h.daily.map((p) => p.date)).toEqual(["2026-09-11", "2026-09-14"]);
    expect(h.daily[0]!.conversionRatePct).toBeNull();
    expect(h.daily[1]!.conversionRatePct).toBeCloseTo((2 / 59) * 100, 9);

    const empty = buildConversionRateHistory(series([]), series([]), ENTRY);
    expect(empty.daily).toEqual([]);
    expect(empty.scopeConversionRatePct).toBeNull();
  });

  it("reads a DEEPER leg a fifth as often on identical evidence", () => {
    const entry = buildConversionRateHistory(series(CONTACTED), series(CLICKS), ENTRY);
    const deeper = buildConversionRateHistory(series(CONTACTED), series(CLICKS), DEEPER);

    expect(deeper.outcomeStep).toEqual(FORM_STEP);
    expect(deeper.outcomeObserved).toBe(false);
    expect(deeper.datedOutcomes).toBeCloseTo(27 * 0.2, 9);
    // THE DIVERGENCE: same people, same clicks, a fifth the rate. An implementation charting the
    // driver signal under the outcome's name would report one number for both.
    expect(deeper.scopeConversionRatePct!).toBeCloseTo(entry.scopeConversionRatePct! / 5, 9);
    expect(deeper.daily.map((p) => p.date)).toEqual(entry.daily.map((p) => p.date));
  });

  it("states the UNDATED share rather than folding it in or dropping it", () => {
    // 6 of the clicks carry no timestamp, and 29 of the people reached carry no outreach date.
    const h = buildConversionRateHistory(series(CONTACTED, 29), series(CLICKS, 6), ENTRY);

    expect(h.datedContacted).toBe(429);
    expect(h.undatedContacted).toBe(29);
    expect(h.datedOutcomes).toBe(27);
    expect(h.undatedOutcomes).toBe(6);

    // THE DIVERGENCE this field exists for: the curve covers 27/429 while the scope is 33/458, so the
    // last point and the served scalar legitimately differ and only the undated counts explain it. A
    // browser summing the dated series would have had no way to know either number was partial.
    expect(h.daily.at(-1)!.conversionRatePct).toBeCloseTo((27 / 429) * 100, 9);
    expect(h.scopeConversionRatePct).toBeCloseTo((33 / 458) * 100, 9);
    expect(h.scopeConversionRatePct).not.toBeCloseTo(h.daily.at(-1)!.conversionRatePct!, 6);
  });

  it("names the step, the leg and the basis — the consumer picks no noun", () => {
    const h = buildConversionRateHistory(series(CONTACTED), series(CLICKS), ENTRY);
    expect(h.outcomeStep).toEqual(VISIT_STEP);
    expect(h.legKey).toBe("start_to_website_visit");
    expect(h.outcomeObserved).toBe(true);
  });

  it("is PURE — the same inputs answer identically, whatever day it is read on", () => {
    const a = buildConversionRateHistory(series(CONTACTED), series(CLICKS), ENTRY);
    const b = buildConversionRateHistory(series(CONTACTED), series(CLICKS), ENTRY);
    expect(a).toEqual(b);
    expect(a.daily.map((p) => p.date)).toEqual([...a.daily.map((p) => p.date)].sort());
  });
});
