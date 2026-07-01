import { describe, it, expect } from "vitest";
import {
  buildSendForecast,
  coldEmailOutreachSlugs,
  utcDateRange,
  addUtcDays,
  FOLLOWUP_MODEL_LABEL,
} from "./send-forecast-compute.js";

const TODAY = "2026-07-01";

function baseInput(overrides: Partial<Parameters<typeof buildSendForecast>[0]> = {}) {
  // window: 2 past days + today + 13 future days
  const dates = utcDateRange(addUtcDays(TODAY, -2), addUtcDays(TODAY, 13));
  return buildSendForecast({
    dates,
    todayIso: TODAY,
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

describe("buildSendForecast — convolution D0/D3/D10", () => {
  it("reaches steady state 3× the daily new rate once all three offsets are in-window", () => {
    const { days } = baseInput();
    // day today+10 is the first day that receives all three offsets (0 from itself, 3 from -3, 10 from -10),
    // and every cohort involved is today-or-later.
    const d10 = days.find((d) => d.date === addUtcDays(TODAY, 10))!;
    expect(d10.forecastNew).toBe(300); // 100 (initial) + 100 (D+3 cohort) + 100 (D+10 cohort)
  });

  it("ramps up: today emits only its own initial cohort", () => {
    const { days } = baseInput();
    const today = days.find((d) => d.isToday)!;
    expect(today.forecastNew).toBe(100); // only the today cohort's D0 email
  });

  it("today+3 emits the today cohort's D+3 email plus the day+3 cohort's initial", () => {
    const { days } = baseInput();
    const d3 = days.find((d) => d.date === addUtcDays(TODAY, 3))!;
    expect(d3.forecastNew).toBe(200); // cohort(today) D+3 + cohort(today+3) D0
  });

  it("scales today's cohort to the remaining budget (todayNewOverride), not the full rate", () => {
    const { days } = baseInput({ todayNewOverride: 40 });
    const today = days.find((d) => d.isToday)!;
    expect(today.forecastNew).toBe(40);
    // today+3 = cohort(today)=40 (D+3) + cohort(today+3)=100 (D0) = 140
    const d3 = days.find((d) => d.date === addUtcDays(TODAY, 3))!;
    expect(d3.forecastNew).toBe(140);
  });
});

describe("buildSendForecast — series stacking + null-safety", () => {
  it("past days carry only actualSent; forecast + inFlight are null", () => {
    const past = addUtcDays(TODAY, -1);
    const { days } = baseInput({ actualByDay: new Map([[past, 57]]) });
    const d = days.find((x) => x.date === past)!;
    expect(d).toMatchObject({ actualSent: 57, inFlightSent: null, forecastNew: null, total: 57 });
  });

  it("today's total sums actualSent-so-far + inFlight + forecastNew", () => {
    const { days } = baseInput({
      todayNewOverride: 40,
      actualByDay: new Map([[TODAY, 12]]),
      inFlightByDay: new Map([[TODAY, 8]]),
    });
    const today = days.find((d) => d.isToday)!;
    expect(today.actualSent).toBe(12);
    expect(today.inFlightSent).toBe(8);
    expect(today.forecastNew).toBe(40);
    expect(today.total).toBe(60);
  });

  it("future day total sums inFlight + forecastNew (no actual)", () => {
    const future = addUtcDays(TODAY, 5);
    const { days } = baseInput({ inFlightByDay: new Map([[future, 25]]) });
    const d = days.find((x) => x.date === future)!;
    expect(d.actualSent).toBeNull();
    expect(d.inFlightSent).toBe(25);
    // day+5 forecast = cohort(today+5) D0 + cohort(today+2) D+3 = 100 + 100 = 200
    expect(d.forecastNew).toBe(200);
    expect(d.total).toBe(225);
  });

  it("a fully-empty future day still reports forecastNew (never a spurious null when a cohort exists)", () => {
    const { days } = baseInput();
    const future = days.find((d) => d.date === addUtcDays(TODAY, 1))!;
    expect(future.forecastNew).toBe(100); // only its own initial cohort
    expect(future.inFlightSent).toBeNull();
    expect(future.total).toBe(100);
  });

  it("stamps the follow-up model label on the summary", () => {
    const { summary } = baseInput();
    expect(summary.followupModel).toBe(FOLLOWUP_MODEL_LABEL);
    expect(summary.activeBrandCount).toBe(3);
    expect(summary.totalNewSequencesPerDay).toBe(100);
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
