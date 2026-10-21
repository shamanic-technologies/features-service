import { describe, expect, it } from "vitest";
import { assertReplyDelayCoherent, delayText, replyDelayStudy, type ReplyDelayBucket, type ReplyDelayDistribution } from "./reply-delay.js";

const H = 3_600_000;
const D = 24 * H;
const BOUNDS: Array<[string, string, number, number | null]> = [
  ["lt_1h", "Under 1 hour", 0, H],
  ["1h_3h", "1 to 3 hours", H, 3 * H],
  ["3h_6h", "3 to 6 hours", 3 * H, 6 * H],
  ["6h_12h", "6 to 12 hours", 6 * H, 12 * H],
  ["12h_1d", "12 to 24 hours", 12 * H, D],
  ["1d_2d", "1 to 2 days", D, 2 * D],
  ["2d_3d", "2 to 3 days", 2 * D, 3 * D],
  ["3d_5d", "3 to 5 days", 3 * D, 5 * D],
  ["5d_7d", "5 to 7 days", 5 * D, 7 * D],
  ["7d_10d", "7 to 10 days", 7 * D, 10 * D],
  ["10d_14d", "10 to 14 days", 10 * D, 14 * D],
  ["14d_21d", "14 to 21 days", 14 * D, 21 * D],
  ["21d_30d", "21 to 30 days", 21 * D, 30 * D],
  ["30d_60d", "30 to 60 days", 30 * D, 60 * D],
  ["60d_plus", "60 days or more", 60 * D, null],
];
const buckets = (counts: Record<string, number>): ReplyDelayBucket[] => {
  let run = 0;
  return BOUNDS.map(([key, label, fromMs, toMs]) => {
    const count = counts[key] ?? 0;
    run += count;
    return { key, label, fromMs, toMs, count, cumulativeCount: run };
  });
};

const dayBins = (counts: Record<number, number>): ReplyDelayBucket[] => {
  let run = 0;
  return Array.from({ length: 22 }, (_, i) => {
    const count = counts[i + 1] ?? 0;
    run += count;
    return i < 21
      ? { key: `day_${i + 1}`, label: `Day ${i + 1}`, fromMs: i * D, toMs: (i + 1) * D, count, cumulativeCount: run }
      : { key: "day_21_plus", label: "21 days or more", fromMs: 21 * D, toMs: null, count, cumulativeCount: run };
  });
};

// 20 replies: 4 within an hour, 2 at 1-3h, 2 at 12-24h (8 in the first day), 6 at 3-5 days, 4 at 7-10 days, 2 at 30-60 days.
const SMALL: ReplyDelayDistribution = {
  sampleSize: 20,
  medianMs: 3.5 * D,
  averageMs: 7.25 * D,
  percentilesMs: { p10: 30 * 60_000, p25: 2 * H, p50: 3.5 * D, p75: 8 * D, p90: 9.5 * D },
  distribution: buckets({ lt_1h: 4, "1h_3h": 2, "12h_1d": 2, "3d_5d": 6, "7d_10d": 4, "30d_60d": 2 }),
  // Same 20 people per day: 8 on day 1, 6 on day 4, 4 on day 8, 2 past 21 days.
  dailyDistribution: dayBins({ 1: 8, 4: 6, 8: 4, 22: 2 }),
};

describe("delayText (human units)", () => {
  it("minutes under an hour, hours under a day, then days", () => {
    expect(delayText(30 * 60_000)).toBe("30 minutes");
    expect(delayText(H)).toBe("1 hour");
    expect(delayText(5.25 * H)).toBe("5.3 hours");
    expect(delayText(D)).toBe("1 day");
    expect(delayText(3.5 * D)).toBe("3.5 days");
    expect(delayText(12.4 * D)).toBe("12 days");
  });
});

describe("replyDelayStudy (TTFPR-RESEARCH-STUDY-1021)", () => {
  it("unreadable lead-service: not_enough_data, named reason, no figure", () => {
    const s = replyDelayStudy(null, 10);
    expect(s.status).toBe("not_enough_data");
    expect(s.result).toBeNull();
    expect(s.verdict.reason).toMatch(/could not be read/);
  });

  it("empty sample: not_enough_data with a reason, no chart, no tiles", () => {
    const empty: ReplyDelayDistribution = { sampleSize: 0, medianMs: null, averageMs: null, percentilesMs: { p10: null, p25: null, p50: null, p75: null, p90: null }, distribution: [], dailyDistribution: [] };
    const s = replyDelayStudy({ metric: empty, campaigns: 150 }, 10);
    expect(s.status).toBe("not_enough_data");
    expect(s.verdict.kind).toBe("noise");
    expect(s.verdict.reason).toBe("No positive reply after a first message is on record yet, over 150 campaigns ending on a positive reply.");
    expect(s.charts).toEqual([]);
    expect(s.delay).toBeUndefined();
  });

  it("a known small sample: exact figures, histogram + curve + tiles + plain conclusions", () => {
    assertReplyDelayCoherent(SMALL);
    const s = replyDelayStudy({ metric: SMALL, campaigns: 3 }, 10);
    expect(s.status).toBe("measured");
    expect(s.outcome).toBe("positive-reply");
    expect(s.pipe).toBeNull();
    expect(s.topic).toBe("delay");
    expect(s.headline).toBe("Half of first positive replies arrive within 3.5 days of the first message. A signal to confirm, not yet a conclusion.");
    expect(s.result).toEqual({ display: "3.5 days", unit: "median time to a first positive reply", sample: "20 positive replies · 3 campaigns · every client, since the first message" });
    const [chart] = s.charts;
    expect(chart!.kind).toBe("bars");
    expect(chart!.points).toHaveLength(15);
    expect(chart!.points.find((p) => p.key === "3d_5d")).toMatchObject({ value: 30, display: "30% (6)", label: "3 to 5 days" });
    expect(chart!.points.reduce((a, p) => a + p.value, 0)).toBeCloseTo(100, 6);
    expect(chart!.curve!.points.find((p) => p.key === "12h_1d")).toMatchObject({ label: "Within 1 day", value: 40, display: "40%" });
    expect(chart!.curve!.points.at(-1)).toMatchObject({ label: "Any time", value: 100 });
    expect(s.delay).toEqual({
      sampleSize: 20,
      stats: [
        { key: "p10", label: "1 in 10 replied within", ms: 30 * 60_000, display: "30 minutes" },
        { key: "p25", label: "1 in 4 replied within", ms: 2 * H, display: "2 hours" },
        { key: "median", label: "Half replied within", ms: 3.5 * D, display: "3.5 days" },
        { key: "p75", label: "3 in 4 replied within", ms: 8 * D, display: "8 days" },
        { key: "p90", label: "9 in 10 replied within", ms: 9.5 * D, display: "9.5 days" },
        { key: "average", label: "Average delay", ms: 7.25 * D, display: "7.3 days" },
      ],
    });
    expect(s.conclusion).toEqual([
      "40% of first positive replies arrive within the first day after the first message (8 of 20).",
      "Half arrive within 3.5 days, 3 in 4 within 8 days, and 1 in 10 takes longer than 9.5 days.",
      "After the first day, the largest group arrives 3 to 5 days after the first message: 6 replies, 30% of all.",
      "The average (7.3 days) sits above the median (3.5 days): a tail of late replies pulls it up, so the median is the typical wait.",
    ]);
  });

  it("per-day histogram (TTFPR-DAY-BINS-1021): charts[1], 22 bars Day 1 .. Day 21 then 21+ days, % of the sample, no curve", () => {
    const s = replyDelayStudy({ metric: SMALL, campaigns: 3 }, 10);
    expect(s.charts).toHaveLength(2);
    const day = s.charts[1]!;
    expect(day.kind).toBe("bars");
    expect(day.title).toBe("First positive replies by day after the first message (% of replies)");
    expect(day.curve).toBeUndefined();
    expect(day.points.map((p) => p.label)).toEqual([...Array.from({ length: 21 }, (_, i) => `Day ${i + 1}`), "21 days or more"]);
    expect(day.points[0]).toMatchObject({ key: "day_1", value: 40, display: "40% (8)", note: "8 of 20 positive replies", thin: false });
    expect(day.points[3]).toMatchObject({ value: 30, display: "30% (6)" });
    expect(day.points.at(-1)).toMatchObject({ key: "day_21_plus", value: 10, display: "10% (2)" });
    expect(day.points.reduce((a, p) => a + p.value, 0)).toBeCloseTo(100, 6);
    expect(s.charts[0]!.curve).toBeDefined();
  });

  it("under the sample bar: figures served marked Learning, never a verdict", () => {
    const s = replyDelayStudy({ metric: SMALL, campaigns: 3 }, 25);
    expect(s.status).toBe("not_enough_data");
    expect(s.verdict.kind).toBe("noise");
    expect(s.headline).toBe("Learning: 20 positive replies so far, the figure needs 25.");
    expect(s.charts[0]!.points.every((p) => p.thin)).toBe(true);
    expect(s.charts[1]!.points.every((p) => p.thin)).toBe(true);
  });
});

describe("assertReplyDelayCoherent", () => {
  it("refuses buckets that do not sum to the sample", () => {
    expect(() => assertReplyDelayCoherent({ ...SMALL, sampleSize: 21 })).toThrow(/sum to 20/);
  });
  it("refuses day bins that do not sum to the sample", () => {
    expect(() => assertReplyDelayCoherent({ ...SMALL, dailyDistribution: dayBins({ 1: 8 }) })).toThrow(/day bins sum to 8/);
  });
  it("refuses unordered percentiles", () => {
    expect(() => assertReplyDelayCoherent({ ...SMALL, percentilesMs: { ...SMALL.percentilesMs, p25: 4 * D } })).toThrow(/not ordered/);
  });
  it("refuses a p50 that is not the median", () => {
    expect(() => assertReplyDelayCoherent({ ...SMALL, medianMs: 3 * D })).toThrow(/p50/);
  });
});
