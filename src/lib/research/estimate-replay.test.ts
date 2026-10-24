import { describe, expect, it } from "vitest";
import { estimateReplayStudy, replayDimension, type ReplayBucket } from "./estimate-replay.js";
import { lagCurveOf } from "../outcome-estimates.js";

// half the replies on day 1, the rest by day 5 (22 bins: Day 1..21 + 21+)
const dayBins = [50, 20, 10, 10, 10, ...Array(17).fill(0)].map((count) => ({ count }));
const now = new Date("2026-10-24T08:00:00Z");
// the replay stands 60 days back: 2026-08-25
const b = (key: string, servedDay: string, contacted: number, positiveReplies = 0, positiveReplyDay: string | null = null): ReplayBucket => ({ key, label: key, servedDay, contacted, positiveReplies, positiveReplyDay });

describe("estimate replay (PERF-ESTIMATE-DISCUSS-1024)", () => {
  it("keeps only the people emailed before the cutoff and the replies dated before it; today = all their replies", () => {
    const r = replayDimension(
      {
        label: "Workflows",
        buckets: [
          b("a", "2026-08-01", 1000),
          b("a", "2026-08-01", 2, 2, "2026-08-03"), // known then
          b("a", "2026-08-20", 1, 1, "2026-09-02"), // replied after the cutoff: not known then, counted today
          b("a", "2026-09-10", 500, 3, "2026-09-11"), // emailed after the cutoff: out
        ],
      },
      "2026-08-25",
      lagCurveOf(dayBins),
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ key: "a", contacted: 1003 });
    expect(r.groups[0]!.measuredThenPer1000).toBeCloseTo((1000 * 2) / 1003, 6);
    expect(r.groups[0]!.todayPer1000).toBeCloseTo((1000 * 3) / 1003, 6);
    expect(r.repliesToday).toBe(3);
  });

  it("a small group with no reply known then: the estimate (drawn to the pipe) misses less than its measured 0", () => {
    // Every group truly converts at 2 per 1,000. The small one had no reply yet at the cutoff; the big one did.
    const r = replayDimension(
      {
        label: "Templates",
        buckets: [
          b("big", "2026-07-01", 9980),
          b("big", "2026-07-01", 20, 20, "2026-07-02"),
          b("small", "2026-08-24", 499), // emailed the day before the cutoff: young
          b("small", "2026-08-24", 1, 1, "2026-08-30"),
        ],
      },
      "2026-08-25",
      lagCurveOf(dayBins),
    );
    const small = r.groups.find((g) => g.key === "small")!;
    expect(small.measuredThenPer1000).toBe(0);
    expect(Math.abs(small.estimatePer1000 - small.todayPer1000)).toBeLessThan(Math.abs(small.measuredThenPer1000 - small.todayPer1000));
    expect(r.estimateMissPer1000).toBeLessThan(r.measuredMissPer1000);
  });

  it("the study: one bar pair per part, lower is better, the cutoff named, never crowned", () => {
    const st = estimateReplayStudy({
      pipe: "cold-email-positive-reply",
      outcomesRequired: 1,
      dayBins,
      now,
      dims: [
        { label: "Workflows", buckets: [b("w", "2026-07-01", 5000), b("w", "2026-07-01", 10, 10, "2026-07-03")] },
        { label: "Templates", buckets: [b("t", "2026-07-01", 5000), b("t", "2026-07-01", 10, 10, "2026-07-03")] },
        { label: "LLMs", buckets: [] },
      ],
    });
    expect(st).toMatchObject({ id: "cold-email-positive-reply-estimate-replay", pipe: "cold-email-positive-reply", topic: "workflow", status: "measured", crowned: false, winner: null });
    expect(st.charts[0]!.lowerIsBetter).toBe(true);
    expect(st.charts[0]!.points.map((p) => p.label)).toEqual(["Workflows: estimate then", "Workflows: measured then", "Templates: estimate then", "Templates: measured then"]);
    expect(st.charts[0]!.title).toMatch(/2026-08-25/);
  });

  it("not readable without the delay curve, nor while no reply carries its date", () => {
    expect(estimateReplayStudy({ pipe: "p", outcomesRequired: 1, dayBins: null, now, dims: [] }).headline).toBe("Not readable right now.");
    const undated = estimateReplayStudy({ pipe: "p", outcomesRequired: 1, dayBins, now, dims: [{ label: "Workflows", buckets: [b("w", "2026-07-01", 100, 2, null)] }] });
    expect(undated.headline).toBe("Reply dates not on record yet.");
    expect(estimateReplayStudy({ pipe: "p", outcomesRequired: 1, dayBins, now, dims: [{ label: "Workflows", buckets: [b("w", "2026-10-01", 100)] }] }).headline).toBe("Nobody emailed two months ago.");
  });
});
