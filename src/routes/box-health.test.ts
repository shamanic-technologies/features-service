import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { BoxHealthSample, StoredBoxSample } from "../lib/box-health.js";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// In-memory store with the real store's contract: a sample's identity is its instant (upsert).
const mem = vi.hoisted(() => ({ rows: new Map<number, StoredBoxSample>() }));
vi.mock("../lib/box-health-store.js", () => ({
  upsertBoxHealthSamples: vi.fn(async (samples: BoxHealthSample[]) => {
    for (const s of samples) {
      const at = new Date(s.sampledAt);
      mem.rows.set(at.getTime(), { ...s, sampledAt: at, oomKills: s.oomKills ?? null, containers: s.containers ?? null });
    }
    return { pruned: 0 };
  }),
  readBoxHealthInputs: vi.fn(async (since: Date, now: Date) => {
    const all = [...mem.rows.values()].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
    return {
      windowSamples: all.filter((s) => s.sampledAt >= since),
      latest: all.at(-1) ?? null,
      lastHourAgentSamples: all.filter((s) => s.source === "agent" && s.sampledAt.getTime() > now.getTime() - 3_600_000),
    };
  }),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: router } = await import("./box-health.js");
// Mounted before a 100 kB global parser, as in index.ts.
const app = express().use(router).use(express.json());
const KEY = { "x-api-key": "test-key" };

function liveSample(at: Date, over: Partial<BoxHealthSample> = {}): BoxHealthSample {
  return {
    sampledAt: at.toISOString(),
    source: "agent",
    load1: 5,
    load5: 6,
    load15: 6,
    cores: 8,
    memTotalMb: 15974,
    memAvailableMb: 6000,
    swapTotalMb: 8192,
    swapUsedMb: 1000,
    oomKills: 0,
    containers: [{ name: "distribute-postgres-1", cpuCores: 2.5, memMb: 3000 }],
    ...over,
  };
}

beforeEach(() => {
  mem.rows.clear();
});

describe("box health routes", () => {
  it("refuses a call without the service key", async () => {
    expect((await request(app).get("/internal/box-health")).status).toBe(401);
    expect((await request(app).post("/internal/box-health/samples").send({ samples: [] })).status).toBe(401);
  });

  it("400s an invalid body or window", async () => {
    expect((await request(app).post("/internal/box-health/samples").set(KEY).send({ samples: [{ load5: 1 }] })).status).toBe(400);
    expect((await request(app).get("/internal/box-health?days=0").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-health?days=91").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-health?days=abc").set(KEY)).status).toBe(400);
  });

  it("is red before any sample arrives", async () => {
    const res = await request(app).get("/internal/box-health").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("red");
    expect(res.body.windowDays).toBe(30);
  });

  it("stores a batch, serves it, and a re-send of the same instant replaces it", async () => {
    const at = new Date(Date.now() - 2 * 60_000);
    const first = await request(app).post("/internal/box-health/samples").set(KEY).send({ samples: [liveSample(at, { load5: 30 })] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ stored: 1, pruned: 0, newestSampledAt: at.toISOString() });
    let res = await request(app).get("/internal/box-health?days=7").set(KEY);
    expect(res.body.status).toBe("red");
    expect(res.body.topContainers.byCpu).toEqual([{ name: "distribute-postgres-1", cpuCores: 2.5 }]);

    await request(app).post("/internal/box-health/samples").set(KEY).send({ samples: [liveSample(at)] });
    res = await request(app).get("/internal/box-health?days=7").set(KEY);
    expect(res.body.status).toBe("green");
    expect(mem.rows.size).toBe(1);
    expect(res.body.latest.containers).toHaveLength(1);
  });

  it("accepts a backfill chunk well above the 100 kB default body limit", async () => {
    const start = Date.now() - 9 * 86_400_000;
    const samples = Array.from({ length: 1300 }, (_, i) =>
      liveSample(new Date(start + i * 600_000), { source: "sysstat", containers: undefined, oomKills: undefined }),
    );
    expect(JSON.stringify({ samples }).length).toBeGreaterThan(100_000);
    const res = await request(app).post("/internal/box-health/samples").set(KEY).send({ samples });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(1300);
  });
});
