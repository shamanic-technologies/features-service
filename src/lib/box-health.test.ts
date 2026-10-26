import { describe, it, expect } from "vitest";
import { BoxHealthBatchSchema, buildBoxHealthView, type BoxHealthInputs, type StoredBoxSample } from "./box-health.js";

const NOW = new Date("2026-10-26T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function sample(at: Date, over: Partial<StoredBoxSample> = {}): StoredBoxSample {
  return {
    sampledAt: at,
    source: "agent",
    load1: 5,
    load5: 6,
    load15: 6,
    cores: 8,
    memTotalMb: 15_974,
    memAvailableMb: 6_000,
    swapTotalMb: 8_192,
    swapUsedMb: 1_000,
    oomKills: 0,
    containers: null,
    ...over,
  };
}

function inputsOf(samples: StoredBoxSample[], lastHour: StoredBoxSample[] = []): BoxHealthInputs {
  const latest = samples.reduce<StoredBoxSample | null>((m, s) => (m == null || s.sampledAt > m.sampledAt ? s : m), null);
  return { windowSamples: samples, latest, lastHourAgentSamples: lastHour };
}

const view = (samples: StoredBoxSample[], lastHour: StoredBoxSample[] = [], days = 30) =>
  buildBoxHealthView(inputsOf(samples, lastHour), NOW, days);

describe("box health verdict", () => {
  it("is green on a healthy fresh sample and serves the thresholds", () => {
    const v = view([sample(minsAgo(3))]);
    expect(v.status).toBe("green");
    expect(v.reasons).toHaveLength(1);
    expect(v.reason).toMatch(/^Box healthy/);
    expect(v.thresholds).toEqual({
      loadPerCoreMax: 1.5,
      load5Max: 12,
      memAvailableMinMb: 1024,
      swapUsedPctMax: 50,
      oomWindowHours: 24,
      staleAfterMinutes: 20,
    });
    expect(v.stale).toBe(false);
    expect(v.minutesSinceLastSample).toBe(3);
  });

  it("is red when nothing was ever sampled", () => {
    const v = view([]);
    expect(v.status).toBe("red");
    expect(v.stale).toBe(true);
    expect(v.latest).toBeNull();
    expect(v.thresholds.load5Max).toBeNull();
    expect(v.reason).toMatch(/not running/);
  });

  it("is red when the latest sample is older than 20 minutes, green at exactly 20", () => {
    expect(view([sample(minsAgo(21))]).status).toBe("red");
    expect(view([sample(minsAgo(21))]).reason).toMatch(/blind/);
    expect(view([sample(minsAgo(20))]).status).toBe("green");
  });

  it("load5 above 1.5 x cores is red; at the limit is green", () => {
    expect(view([sample(minsAgo(1), { load5: 12.01 })]).status).toBe("red");
    expect(view([sample(minsAgo(1), { load5: 12 })]).status).toBe("green");
    // the limit follows the core count
    const v = view([sample(minsAgo(1), { load5: 7, cores: 4 })]);
    expect(v.status).toBe("red");
    expect(v.thresholds.load5Max).toBe(6);
  });

  it("MemAvailable below 1024 MB is red; at 1024 is green", () => {
    expect(view([sample(minsAgo(1), { memAvailableMb: 1023 })]).status).toBe("red");
    expect(view([sample(minsAgo(1), { memAvailableMb: 1024 })]).status).toBe("green");
  });

  it("swap above 50% is red; at 50% green; no swap configured is red", () => {
    expect(view([sample(minsAgo(1), { swapUsedMb: 4097 })]).status).toBe("red");
    expect(view([sample(minsAgo(1), { swapUsedMb: 4096 })]).status).toBe("green");
    const none = view([sample(minsAgo(1), { swapTotalMb: 0, swapUsedMb: 0 })]);
    expect(none.status).toBe("red");
    expect(none.reason).toMatch(/No swap/);
    expect(none.latest!.swapUsedPct).toBeNull();
  });

  it("an OOM kill in the last 24 h is red even when the latest sample is clean; older is not", () => {
    const red = view([sample(minsAgo(23 * 60), { oomKills: 2 }), sample(minsAgo(2))]);
    expect(red.status).toBe("red");
    expect(red.latest!.oomKillsLast24h).toBe(2);
    expect(red.reason).toMatch(/2 processes were killed/);
    const old = view([sample(minsAgo(25 * 60), { oomKills: 2 }), sample(minsAgo(2))]);
    expect(old.status).toBe("green");
    expect(old.latest!.oomKillsLast24h).toBe(0);
  });

  it("unknown OOM counts are null, never 0", () => {
    const v = view([sample(minsAgo(2), { oomKills: null })]);
    expect(v.latest!.oomKillsLast24h).toBeNull();
    expect(v.daily[0].oomKills).toBeNull();
  });

  it("collects every failing reason at once", () => {
    const v = view([sample(minsAgo(30), { load5: 30, memAvailableMb: 200, swapUsedMb: 8000, oomKills: 1 })]);
    expect(v.status).toBe("red");
    expect(v.reasons).toHaveLength(5);
  });
});

describe("box health series", () => {
  it("daily: one point per UTC day with samples, a day without samples is absent (gap)", () => {
    const v = view([
      sample(new Date("2026-10-20T01:00:00Z"), { load5: 4, memAvailableMb: 5000, swapUsedMb: 0, oomKills: 0 }),
      sample(new Date("2026-10-20T13:00:00Z"), { load5: 10, memAvailableMb: 3000, swapUsedMb: 4096, oomKills: 3 }),
      sample(new Date("2026-10-22T05:00:00Z"), { load5: 7 }),
      sample(minsAgo(5)),
    ]);
    expect(v.daily.map((d) => d.day)).toEqual(["2026-10-20", "2026-10-22", "2026-10-26"]);
    expect(v.daily[0]).toEqual({
      day: "2026-10-20",
      sampleCount: 2,
      load5Mean: 7,
      load5Max: 10,
      memAvailableMinMb: 3000,
      swapUsedPctMax: 50,
      oomKills: 3,
    });
  });

  it("daily drops samples older than the window", () => {
    const v = view([sample(new Date("2026-10-24T10:00:00Z")), sample(minsAgo(5))], [], 2);
    expect(v.daily.map((d) => d.day)).toEqual(["2026-10-26"]);
    expect(v.windowDays).toBe(2);
  });

  it("recent: every sample of the last 48 h, oldest first", () => {
    const v = view([sample(minsAgo(5)), sample(minsAgo(49 * 60)), sample(minsAgo(47 * 60), { swapUsedMb: 2048 })]);
    expect(v.recent).toHaveLength(2);
    expect(v.recent[0]).toEqual({
      sampledAt: minsAgo(47 * 60).toISOString(),
      load1: 5,
      load5: 6,
      load15: 6,
      memAvailableMb: 6000,
      swapUsedPct: 25,
    });
  });

  it("top containers: mean over the last hour's agent samples, top 10 each, sorted", () => {
    const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const hour = [minsAgo(10), minsAgo(5)].map((at, k) =>
      sample(at, { containers: names.map((name, i) => ({ name, cpuCores: i + k, memMb: 1000 - i * 10 })) }),
    );
    const stale = sample(minsAgo(90), { containers: [{ name: "old", cpuCores: 99, memMb: 99_999 }] });
    const v = view(hour, [...hour, stale]);
    expect(v.topContainers.windowMinutes).toBe(60);
    expect(v.topContainers.sampleCount).toBe(2);
    expect(v.topContainers.byCpu).toHaveLength(10);
    expect(v.topContainers.byCpu[0]).toEqual({ name: "c11", cpuCores: 11.5 });
    expect(v.topContainers.byMemory[0]).toEqual({ name: "c0", memMb: 1000 });
    expect(v.topContainers.byMemory.map((c) => c.name)).not.toContain("old");
  });
});

describe("box health batch schema", () => {
  const ok = {
    sampledAt: "2026-10-26T11:55:00Z",
    source: "agent",
    load1: 1,
    load5: 1,
    load15: 1,
    cores: 8,
    memTotalMb: 16000,
    memAvailableMb: 8000,
    swapTotalMb: 8192,
    swapUsedMb: 0,
  };
  it("accepts a minimal backfill sample (no oomKills, no containers)", () => {
    expect(BoxHealthBatchSchema.safeParse({ samples: [{ ...ok, source: "sysstat" }] }).success).toBe(true);
  });
  it("refuses a duplicate instant, a bad source, an empty batch", () => {
    expect(BoxHealthBatchSchema.safeParse({ samples: [ok, ok] }).success).toBe(false);
    expect(BoxHealthBatchSchema.safeParse({ samples: [{ ...ok, source: "x" }] }).success).toBe(false);
    expect(BoxHealthBatchSchema.safeParse({ samples: [] }).success).toBe(false);
    expect(BoxHealthBatchSchema.safeParse({ samples: [{ ...ok, sampledAt: "yesterday" }] }).success).toBe(false);
  });
});
