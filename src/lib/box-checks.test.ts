import { describe, it, expect } from "vitest";
import { BoxCheckBatchSchema, buildBoxChecksView, type BoxChecksInputs, type StoredCheckRun } from "./box-checks.js";

const NOW = new Date("2026-10-30T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function run(check: string, at: Date, over: Partial<StoredCheckRun> = {}): StoredCheckRun {
  return { check, ranAt: at, ok: true, value: 0, cadenceMinutes: 5, reason: null, label: null, unit: null, details: null, ...over };
}

function inputsOf(runs: StoredCheckRun[]): BoxChecksInputs {
  const latest = new Map<string, StoredCheckRun>();
  for (const r of runs) {
    const cur = latest.get(r.check);
    if (cur == null || r.ranAt > cur.ranAt) latest.set(r.check, r);
  }
  return { windowRuns: runs, latestPerCheck: [...latest.values()] };
}

const view = (runs: StoredCheckRun[], expected: string[] = [], days = 30) => buildBoxChecksView(inputsOf(runs), NOW, days, expected);

describe("box checks verdict", () => {
  it("is green with no check at all (nothing ran yet is not broken)", () => {
    const v = view([]);
    expect(v.status).toBe("green");
    expect(v.checks).toEqual([]);
    expect(v.reason).toBe("No check has reported yet.");
  });

  it("serves an expected but never-seen check as not_yet, never red", () => {
    const v = view([], ["jev-chain"]);
    expect(v.status).toBe("green");
    expect(v.checks).toHaveLength(1);
    expect(v.checks[0]).toMatchObject({ check: "jev-chain", verdict: "not_yet", lastRunAt: null, daily: [], recent: [] });
  });

  it("is ok on a fresh ok run, serving its own reason", () => {
    const v = view([run("workflow-queue", minsAgo(2), { reason: "0 jobs overdue.", label: "Workflow queue", unit: "jobs" })]);
    expect(v.status).toBe("green");
    expect(v.checks[0]).toMatchObject({
      verdict: "ok",
      reason: "0 jobs overdue.",
      label: "Workflow queue",
      unit: "jobs",
      stale: false,
      cadenceMinutes: 5,
      staleAfterMinutes: 15,
      brokenSince: null,
    });
  });

  it("is broken when the latest run failed, with its reason and since when", () => {
    const v = view([
      run("service-health", minsAgo(20)),
      run("service-health", minsAgo(10), { ok: false, reason: "lead-service down." }),
      run("service-health", minsAgo(5), { ok: false, reason: "lead-service down (502).", value: 1, details: { failing: ["lead-service"] } }),
    ]);
    expect(v.status).toBe("red");
    expect(v.brokenCount).toBe(1);
    const c = v.checks[0];
    expect(c.verdict).toBe("broken");
    expect(c.reason).toBe("lead-service down (502).");
    expect(c.brokenSince).toBe(minsAgo(10).toISOString());
    expect(c.latestDetails).toEqual({ failing: ["lead-service"] });
    expect(v.reason).toBe("service-health: lead-service down (502).");
  });

  it("recovers to ok once the latest run is ok again", () => {
    const v = view([run("service-health", minsAgo(10), { ok: false, reason: "down" }), run("service-health", minsAgo(5))]);
    expect(v.checks[0].verdict).toBe("ok");
  });

  it("reads a silent check broken past 3 x its cadence, even if its last run was ok", () => {
    const fresh = view([run("deploy-pipeline", minsAgo(44), { cadenceMinutes: 15 })]);
    expect(fresh.checks[0].verdict).toBe("ok");
    const silent = view([run("deploy-pipeline", minsAgo(46), { cadenceMinutes: 15 })]);
    expect(silent.status).toBe("red");
    expect(silent.checks[0]).toMatchObject({ verdict: "broken", stale: true, staleAfterMinutes: 45 });
    expect(silent.checks[0].reason).toMatch(/^No report for 46 minutes \(it runs every 15 minutes\): the check has stopped running\.$/);
  });

  it("uses each check's own cadence (a 6-hourly check is not stale after 6 hours)", () => {
    const v = view([run("jev-chain", minsAgo(7 * 60), { cadenceMinutes: 360 })]);
    expect(v.checks[0].verdict).toBe("ok");
    const late = view([run("jev-chain", minsAgo(19 * 60), { cadenceMinutes: 360 })]);
    expect(late.checks[0].reason).toMatch(/^No report for 19 hours \(it runs every 6 hours\)/);
  });

  it("orders broken first, then by name, and keeps checks apart", () => {
    const v = view(
      [run("b-check", minsAgo(1)), run("a-check", minsAgo(1)), run("z-check", minsAgo(1), { ok: false, reason: "x" })],
      ["m-check"],
    );
    expect(v.checks.map((c) => [c.check, c.verdict])).toEqual([
      ["z-check", "broken"],
      ["a-check", "ok"],
      ["b-check", "ok"],
      ["m-check", "not_yet"],
    ]);
    expect(v.checks[1].recent).toHaveLength(1);
  });

  it("builds a daily series of the value (days without runs absent) and a 48 h recent series", () => {
    const runs = [
      run("own-org-balance", new Date("2026-10-27T10:00:00Z"), { value: 40, cadenceMinutes: 60 }),
      run("own-org-balance", new Date("2026-10-27T11:00:00Z"), { value: 30, cadenceMinutes: 60, ok: false, reason: "low" }),
      run("own-org-balance", new Date("2026-10-29T11:00:00Z"), { value: null, cadenceMinutes: 60 }),
      run("own-org-balance", new Date("2026-10-30T11:00:00Z"), { value: 55, cadenceMinutes: 60 }),
    ];
    const v = view(runs);
    const c = v.checks[0];
    expect(c.daily).toEqual([
      { day: "2026-10-27", runs: 2, failedRuns: 1, valueMin: 30, valueMax: 40, valueMean: 35, valueLast: 30 },
      { day: "2026-10-29", runs: 1, failedRuns: 0, valueMin: null, valueMax: null, valueMean: null, valueLast: null },
      { day: "2026-10-30", runs: 1, failedRuns: 0, valueMin: 55, valueMax: 55, valueMean: 55, valueLast: 55 },
    ]);
    expect(c.recent).toEqual([
      { ranAt: "2026-10-29T11:00:00.000Z", ok: true, value: null },
      { ranAt: "2026-10-30T11:00:00.000Z", ok: true, value: 55 },
    ]);
    expect(c.latestValue).toBe(55);
    // A 2-day window drops the 27th from the daily series.
    expect(view(runs, [], 2).checks[0].daily.map((d) => d.day)).toEqual(["2026-10-29", "2026-10-30"]);
  });
});

describe("box checks ingest schema", () => {
  const base = { check: "deploy-pipeline", ranAt: "2026-10-30T11:00:00Z", ok: true, cadenceMinutes: 15 };
  it("accepts a minimal run and any check name of the pattern", () => {
    expect(BoxCheckBatchSchema.safeParse({ runs: [base] }).success).toBe(true);
    expect(BoxCheckBatchSchema.safeParse({ runs: [{ ...base, check: "a-new-check-2" }] }).success).toBe(true);
  });
  it("refuses a failed run without a reason, a bad name, a duplicate run, oversized details", () => {
    expect(BoxCheckBatchSchema.safeParse({ runs: [{ ...base, ok: false }] }).success).toBe(false);
    expect(BoxCheckBatchSchema.safeParse({ runs: [{ ...base, ok: false, reason: "  " }] }).success).toBe(false);
    expect(BoxCheckBatchSchema.safeParse({ runs: [{ ...base, check: "Deploy Pipeline" }] }).success).toBe(false);
    expect(BoxCheckBatchSchema.safeParse({ runs: [base, { ...base, ranAt: "2026-10-30T11:00:00.000Z" }] }).success).toBe(false);
    expect(BoxCheckBatchSchema.safeParse({ runs: [base, { ...base, check: "other" }] }).success).toBe(true);
    expect(BoxCheckBatchSchema.safeParse({ runs: [{ ...base, details: { body: "x".repeat(20_001) } }] }).success).toBe(false);
    expect(BoxCheckBatchSchema.safeParse({ runs: [] }).success).toBe(false);
  });
});
