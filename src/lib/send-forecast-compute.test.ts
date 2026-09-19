import { describe, it, expect } from "vitest";
import {
  buildSendForecast,
  coldEmailOutreachSlugs,
  isSendingDay,
  observedDailyThroughput,
  THROUGHPUT_WINDOW_DAYS,
  utcDateRange,
  addUtcDays,
  FOLLOWUP_MODEL_LABEL,
  SENDING_WEEKDAYS_UTC,
} from "./send-forecast-compute.js";

// 2026-07-01 is a WEDNESDAY. The window below therefore spans two weekends, which is what the
// sending-day and spill assertions key on.
const TODAY = "2026-07-01";
const SAT = "2026-07-04";
const SUN = "2026-07-05";
const MON = "2026-07-06";

/** Capacity far above anything any fixture makes due — isolates the convolution from the drain. */
const AMPLE = 1_000_000;

function baseInput(overrides: Partial<Parameters<typeof buildSendForecast>[0]> = {}) {
  // window: 2 past days + today + 13 future days
  const dates = utcDateRange(addUtcDays(TODAY, -2), addUtcDays(TODAY, 13));
  return buildSendForecast({
    dates,
    todayIso: TODAY,
    dailyCapacity: AMPLE,
    // null = nothing measured yet, so the ceiling stands in for the rate. The capacity tests below
    // key on that; the throughput tests pass a real one.
    observedThroughput: null,
    totalNewPerDay: 100,
    todayNewOverride: 100,
    actualByDay: new Map(),
    inFlightByDay: new Map(),
    summary: {
      totalDailyBudgetUsd: 500,
      remainingTodayUsd: 500,
      activeBrandCount: 3,
      totalNewSequencesPerDay: 100,
    },
    ...overrides,
  });
}

const dayOf = (days: ReturnType<typeof baseInput>["days"], date: string) => days.find((d) => d.date === date)!;

describe("isSendingDay", () => {
  it("is true Monday through Friday and false at the weekend", () => {
    expect(SENDING_WEEKDAYS_UTC).toEqual([1, 2, 3, 4, 5]);
    expect(isSendingDay("2026-06-29")).toBe(true); // Mon
    expect(isSendingDay("2026-07-03")).toBe(true); // Fri
    expect(isSendingDay(SAT)).toBe(false);
    expect(isSendingDay(SUN)).toBe(false);
  });
});

describe("buildSendForecast — sending days", () => {
  it("projects no volume on a Saturday or a Sunday", () => {
    const { days } = baseInput();
    for (const weekend of [SAT, SUN, "2026-07-11", "2026-07-12"]) {
      const d = dayOf(days, weekend);
      expect(d.inFlightSent).toBe(0);
      expect(d.forecastNew).toBe(0);
      expect(d.total).toBe(0);
    }
  });

  it("launches no new cohort on a non-sending day, so the weekend's volume is the WEEK's follow-ups", () => {
    const { days } = baseInput();
    // Sat 07-04 would otherwise carry cohort(07-04) D0 + cohort(07-01) D+3; only the second exists,
    // and neither goes out — both roll forward.
    expect(dayOf(days, SAT).forecastNew).toBe(0);
  });

  it("rolls the weekend's due volume into Monday rather than losing it", () => {
    const { days } = baseInput();
    // Due but unsent: Sat = cohort(07-01) D+3 = 100; Sun = cohort(07-02) D+3 = 100.
    // Monday's own due: cohort(07-06) D0 = 100 + cohort(07-03) D+3 = 100.
    expect(dayOf(days, MON).forecastNew).toBe(400);
  });
});

describe("buildSendForecast — convolution D0/D3/D10", () => {
  it("ramps up: today emits only its own initial cohort", () => {
    const { days } = baseInput();
    expect(dayOf(days, TODAY).forecastNew).toBe(100);
  });

  it("scales today's cohort to the remaining budget (todayNewOverride), not the full rate", () => {
    const { days } = baseInput({ todayNewOverride: 40 });
    expect(dayOf(days, TODAY).forecastNew).toBe(40);
    // Thu 07-02 = cohort(07-02) D0 only (cohort(06-29) is before today).
    expect(dayOf(days, "2026-07-02").forecastNew).toBe(100);
    // Sat carries cohort(today)=40 as a D+3, unsent; Monday absorbs it with the rest of the weekend.
    expect(dayOf(days, SAT).forecastNew).toBe(0);
    expect(dayOf(days, MON).forecastNew).toBe(340); // 40 (Sat's D+3) + 100 (Sun's) + 100 + 100
  });

  it("conserves every launched email across the horizon when capacity never binds", () => {
    const dates = utcDateRange(addUtcDays(TODAY, -2), addUtcDays(TODAY, 13));
    const { days } = baseInput({ dates });
    const sent = days
      .filter((d) => d.date >= TODAY)
      .reduce((a, d) => a + (d.forecastNew ?? 0), 0);

    // Independently: every cohort launched on a sending day in-window, times each offset that also
    // lands in-window. Nothing may be dropped and nothing counted twice.
    const last = dates[dates.length - 1];
    let due = 0;
    for (const start of dates) {
      if (start < TODAY || !isSendingDay(start)) continue;
      const size = start === TODAY ? 100 : 100;
      for (const off of [0, 3, 10]) if (addUtcDays(start, off) <= last) due += size;
    }
    expect(sent).toBe(due);
  });
});

describe("buildSendForecast — capacity", () => {
  it("never projects a day above the fleet's daily capacity", () => {
    const { days } = baseInput({ dailyCapacity: 150 });
    for (const d of days.filter((x) => x.date >= TODAY)) {
      expect(d.total!).toBeLessThanOrEqual(150);
    }
  });

  it("drains a backlog at capacity over the following sending days, losing nothing", () => {
    // 1000 in-flight emails fall DUE on a Saturday. Capacity 300/day, no new cohorts.
    const dates = utcDateRange(addUtcDays(TODAY, -1), addUtcDays(TODAY, 9));
    const { days } = baseInput({
      dates,
      dailyCapacity: 300,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[SAT, 1000]]),
    });

    expect(dayOf(days, SAT).inFlightSent).toBe(0);
    expect(dayOf(days, SUN).inFlightSent).toBe(0);
    expect(dayOf(days, MON).inFlightSent).toBe(300);
    expect(dayOf(days, "2026-07-07").inFlightSent).toBe(300);
    expect(dayOf(days, "2026-07-08").inFlightSent).toBe(300);
    expect(dayOf(days, "2026-07-09").inFlightSent).toBe(100);
    expect(dayOf(days, "2026-07-10").inFlightSent).toBe(0);

    const drained = days.filter((d) => d.date >= TODAY).reduce((a, d) => a + (d.inFlightSent ?? 0), 0);
    expect(drained).toBe(1000);
  });

  it("drains the already-provisioned in-flight queue before launching new cohorts", () => {
    const { days } = baseInput({
      dailyCapacity: 120,
      inFlightByDay: new Map([[TODAY, 100]]),
    });
    const today = dayOf(days, TODAY);
    expect(today.inFlightSent).toBe(100); // provisioned work goes first
    expect(today.forecastNew).toBe(20); // only the room left launches new sequences
    expect(today.total).toBe(120);
  });

  it("counts what already went out today against today's remaining room", () => {
    const { days } = baseInput({
      dailyCapacity: 120,
      actualByDay: new Map([[TODAY, 90]]),
    });
    const today = dayOf(days, TODAY);
    expect(today.actualSent).toBe(90);
    expect(today.forecastNew).toBe(30); // 120 − 90 already sent
    expect(today.total).toBe(120);
  });

  it("is identical to the unbounded projection on a horizon where capacity never binds", () => {
    const tight = baseInput({ dailyCapacity: 10_000 }).days.map((d) => d.total);
    const ample = baseInput({ dailyCapacity: AMPLE }).days.map((d) => d.total);
    expect(tight).toEqual(ample);
  });
});

describe("buildSendForecast — series stacking + null-safety", () => {
  it("past days carry only actualSent; forecast + inFlight are null", () => {
    const past = addUtcDays(TODAY, -1);
    const { days } = baseInput({ actualByDay: new Map([[past, 57]]) });
    expect(dayOf(days, past)).toMatchObject({
      actualSent: 57,
      inFlightSent: null,
      forecastNew: null,
      total: 57,
    });
  });

  it("today's total sums actualSent-so-far + inFlight + forecastNew", () => {
    const { days } = baseInput({
      todayNewOverride: 40,
      actualByDay: new Map([[TODAY, 12]]),
      inFlightByDay: new Map([[TODAY, 8]]),
    });
    const today = dayOf(days, TODAY);
    expect(today.actualSent).toBe(12);
    expect(today.inFlightSent).toBe(8);
    expect(today.forecastNew).toBe(40);
    expect(today.total).toBe(60);
  });

  it("a future sending day with nothing in flight still reports a measured 0, never null", () => {
    const { days } = baseInput();
    const d = dayOf(days, "2026-07-02");
    expect(d.actualSent).toBeNull();
    expect(d.inFlightSent).toBe(0);
    expect(d.forecastNew).toBe(100);
    expect(d.total).toBe(100);
  });

  it("stamps the follow-up model label on the summary", () => {
    const { summary } = baseInput();
    expect(summary.followupModel).toBe(FOLLOWUP_MODEL_LABEL);
    expect(summary.activeBrandCount).toBe(3);
    expect(summary.totalNewSequencesPerDay).toBe(100);
  });
});

describe("observedDailyThroughput", () => {
  it("takes the median of past days that actually sent", () => {
    const m = new Map([
      [addUtcDays(TODAY, -5), 1238],
      [addUtcDays(TODAY, -4), 1771],
      [addUtcDays(TODAY, -3), 1859],
      [addUtcDays(TODAY, -2), 2024],
      [addUtcDays(TODAY, -1), 2489],
    ]);
    expect(observedDailyThroughput(m, TODAY)).toBe(1859);
  });

  it("averages the middle two on an even count", () => {
    const m = new Map([
      [addUtcDays(TODAY, -2), 1000],
      [addUtcDays(TODAY, -1), 2000],
    ]);
    expect(observedDailyThroughput(m, TODAY)).toBe(1500);
  });

  it("ignores today and anything after it — only settled days measure a rate", () => {
    const m = new Map([
      [addUtcDays(TODAY, -1), 1800],
      [TODAY, 12],
      [addUtcDays(TODAY, 1), 99],
    ]);
    expect(observedDailyThroughput(m, TODAY)).toBe(1800);
  });

  it("is null when the fleet has never been seen sending", () => {
    expect(observedDailyThroughput(new Map(), TODAY)).toBeNull();
  });

  it("takes only the MOST RECENT window, never the whole history the producer hands back", () => {
    // `actualByDay` carries the fleet's entire history (204 days in prod), not this forecast's
    // 7-day render window. An all-time median is a median over months the fleet spent far smaller.
    const m = new Map<string, number>();
    for (let i = 60; i > 10; i--) m.set(addUtcDays(TODAY, -i), 100); // the fleet's small early life
    for (let i = 10; i > 0; i--) m.set(addUtcDays(TODAY, -i), 1900); // what it does now
    expect(observedDailyThroughput(m, TODAY)).toBe(1900);
  });

  it("is a median of at most THROUGHPUT_WINDOW_DAYS entries", () => {
    const m = new Map<string, number>();
    for (let i = 40; i > 0; i--) m.set(addUtcDays(TODAY, -i), i); // older days carry smaller values
    // Newest 10 are the days -1..-10, i.e. values 1..10 → median 5.5.
    expect(THROUGHPUT_WINDOW_DAYS).toBe(10);
    expect(observedDailyThroughput(m, TODAY)).toBe(5.5);
  });

  it("is not dragged down by a day with no send — those are absent, not zero", () => {
    // A weekend or an outage never reaches actualByDay at all (the client drops sent=0).
    const m = new Map([
      [addUtcDays(TODAY, -3), 1800],
      [addUtcDays(TODAY, -1), 1900],
    ]);
    expect(observedDailyThroughput(m, TODAY)).toBe(1850);
  });
});

describe("buildSendForecast — throughput is the rate, capacity is the ceiling", () => {
  it("drains at what the fleet ACTUALLY sends, not at what it could", () => {
    const { days } = baseInput({
      dailyCapacity: 4105,
      observedThroughput: 1859,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[TODAY, 10_000]]),
    });
    // The bug this replaced pinned every day flat on the 4,105 ceiling.
    expect(dayOf(days, TODAY).total).toBe(1859);
    expect(dayOf(days, "2026-07-02").total).toBe(1859);
    expect(days.filter((d) => d.date >= TODAY).every((d) => (d.total ?? 0) <= 4105)).toBe(true);
  });

  it("never drains above the ceiling even when the measured rate exceeds it", () => {
    // A measured rate above capacity means the fleet grew smaller, not that it can send more.
    const { days } = baseInput({
      dailyCapacity: 500,
      observedThroughput: 9999,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[TODAY, 10_000]]),
    });
    expect(dayOf(days, TODAY).total).toBe(500);
  });

  it("falls back to the ceiling when nothing has been measured", () => {
    const measured = baseInput({
      dailyCapacity: 700,
      observedThroughput: 700,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[TODAY, 5000]]),
    }).days.map((d) => d.total);
    const unmeasured = baseInput({
      dailyCapacity: 700,
      observedThroughput: null,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[TODAY, 5000]]),
    }).days.map((d) => d.total);
    expect(unmeasured).toEqual(measured);
  });

  it("still loses nothing — a slower drain queues longer, it does not drop volume", () => {
    const dates = utcDateRange(addUtcDays(TODAY, -1), addUtcDays(TODAY, 20));
    const { days } = baseInput({
      dates,
      dailyCapacity: 4105,
      observedThroughput: 300,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      inFlightByDay: new Map([[TODAY, 1500]]),
    });
    const drained = days.filter((d) => d.date >= TODAY).reduce((a, d) => a + (d.inFlightSent ?? 0), 0);
    expect(drained).toBe(1500);
  });

  it("counts what already went out today against the measured rate, not the ceiling", () => {
    const { days } = baseInput({
      dailyCapacity: 4105,
      observedThroughput: 1000,
      totalNewPerDay: 0,
      todayNewOverride: 0,
      actualByDay: new Map([[TODAY, 900]]),
      inFlightByDay: new Map([[TODAY, 5000]]),
    });
    const today = dayOf(days, TODAY);
    expect(today.actualSent).toBe(900);
    expect(today.inFlightSent).toBe(100); // 1000 measured rate − 900 already sent
    expect(today.total).toBe(1000);
  });
});

describe("coldEmailOutreachSlugs", () => {
  it("keeps only *-cold-email-outreach slugs", () => {
    const kept = coldEmailOutreachSlugs([
      "sales-cold-email-outreach",
      "pr-cold-email-outreach",
      "hiring-cold-email-outreach",
      "vc-cold-email-outreach",
      "accelerators-cold-email-outreach",
      "pr-expert-quote-outreach",
      "outlet-database-discovery",
      "ai-visibility-scoring",
    ]);
    expect(kept).toEqual([
      "sales-cold-email-outreach",
      "pr-cold-email-outreach",
      "hiring-cold-email-outreach",
      "vc-cold-email-outreach",
      "accelerators-cold-email-outreach",
    ]);
  });
});

describe("utcDateRange / addUtcDays", () => {
  it("builds a contiguous inclusive range", () => {
    expect(utcDateRange("2026-07-01", "2026-07-04")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
  });
  it("crosses month boundaries", () => {
    expect(addUtcDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addUtcDays("2026-08-01", -1)).toBe("2026-07-31");
  });
});
