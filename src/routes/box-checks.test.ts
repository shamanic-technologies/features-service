import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { BoxCheckRun, StoredCheckRun } from "../lib/box-checks.js";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// In-memory store with the real store's contract: a run's identity is (check, instant) (upsert).
const mem = vi.hoisted(() => ({ rows: new Map<string, StoredCheckRun>() }));
vi.mock("../lib/box-checks-store.js", () => ({
  upsertBoxCheckRuns: vi.fn(async (runs: BoxCheckRun[]) => {
    for (const r of runs) {
      const at = new Date(r.ranAt);
      mem.rows.set(`${r.check}@${at.getTime()}`, {
        check: r.check,
        ranAt: at,
        ok: r.ok,
        value: r.value ?? null,
        cadenceMinutes: r.cadenceMinutes,
        reason: r.reason ?? null,
        label: r.label ?? null,
        unit: r.unit ?? null,
        details: r.details ?? null,
      });
    }
    return { pruned: 0 };
  }),
  deleteBoxCheck: vi.fn(async (check: string) => {
    let deleted = 0;
    for (const [k, r] of mem.rows) {
      if (r.check === check) {
        mem.rows.delete(k);
        deleted++;
      }
    }
    return { deleted };
  }),
  readBoxChecksInputs: vi.fn(async (since: Date) => {
    const all = [...mem.rows.values()];
    const latest = new Map<string, StoredCheckRun>();
    for (const r of all) {
      const cur = latest.get(r.check);
      if (cur == null || r.ranAt > cur.ranAt) latest.set(r.check, r);
    }
    return { windowRuns: all.filter((r) => r.ranAt >= since), latestPerCheck: [...latest.values()] };
  }),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: router } = await import("./box-checks.js");
// Mounted before a 100 kB global parser, as in index.ts.
const app = express().use(router).use(express.json());
const KEY = { "x-api-key": "test-key" };

const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

beforeEach(() => {
  mem.rows.clear();
});

describe("box checks routes", () => {
  it("refuses a call without the service key", async () => {
    expect((await request(app).get("/internal/box-checks")).status).toBe(401);
    expect((await request(app).post("/internal/box-checks/runs").send({ runs: [] })).status).toBe(401);
    expect((await request(app).delete("/internal/box-checks/checks/page-speed-today")).status).toBe(401);
  });

  it("400s an invalid body, window or expect list", async () => {
    expect((await request(app).post("/internal/box-checks/runs").set(KEY).send({ runs: [{ ok: true }] })).status).toBe(400);
    const failedNoReason = { check: "jev-chain", ranAt: at(1), ok: false, cadenceMinutes: 360 };
    expect((await request(app).post("/internal/box-checks/runs").set(KEY).send({ runs: [failedNoReason] })).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?days=0").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?days=91").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?expect=Bad%20Name").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?prefix=Page").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?excludePrefix=-x").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/box-checks?prefix=a&prefix=b").set(KEY)).status).toBe(400);
    expect((await request(app).delete("/internal/box-checks/checks/Bad_Name").set(KEY)).status).toBe(400);
  });

  it("is green and empty before any run, an expected check reads not_yet", async () => {
    let res = await request(app).get("/internal/box-checks").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "green", brokenCount: 0, windowDays: 30, checks: [] });
    res = await request(app).get("/internal/box-checks?expect=deploy-pipeline,jev-chain").set(KEY);
    expect(res.body.status).toBe("green");
    expect(res.body.checks.map((c: { verdict: string }) => c.verdict)).toEqual(["not_yet", "not_yet"]);
  });

  it("stores any check name, serves it, and a re-send of the same run replaces it", async () => {
    const ranAt = at(2);
    const broken = {
      check: "service-health",
      label: "Service health",
      ranAt,
      ok: false,
      reason: "lead-service failed its health check twice in a row (502).",
      cadenceMinutes: 5,
      value: 1,
      unit: "services",
      details: { failing: [{ service: "lead-service", status: 502 }] },
    };
    const first = await request(app)
      .post("/internal/box-checks/runs")
      .set(KEY)
      .send({ runs: [broken, { check: "some-future-check", ranAt, ok: true, cadenceMinutes: 60 }] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ stored: 2, pruned: 0, checks: ["service-health", "some-future-check"] });

    let res = await request(app).get("/internal/box-checks?days=7").set(KEY);
    expect(res.body.status).toBe("red");
    expect(res.body.checks[0]).toMatchObject({
      check: "service-health",
      verdict: "broken",
      reason: broken.reason,
      lastRunAt: new Date(ranAt).toISOString(),
      latestValue: 1,
      unit: "services",
    });
    expect(res.body.checks[0].recent).toHaveLength(1);
    expect(res.body.checks[0].daily).toHaveLength(1);
    expect(res.body.checks[1]).toMatchObject({ check: "some-future-check", verdict: "ok" });

    await request(app)
      .post("/internal/box-checks/runs")
      .set(KEY)
      .send({ runs: [{ ...broken, ok: true, reason: "All services healthy.", value: 0, details: undefined }] });
    res = await request(app).get("/internal/box-checks").set(KEY);
    expect(res.body.status).toBe("green");
    expect(mem.rows.size).toBe(2);
  });

  it("reads a check that stopped reporting as broken", async () => {
    await request(app)
      .post("/internal/box-checks/runs")
      .set(KEY)
      .send({ runs: [{ check: "deploy-pipeline", ranAt: at(50), ok: true, cadenceMinutes: 15 }] });
    const res = await request(app).get("/internal/box-checks").set(KEY);
    expect(res.body.status).toBe("red");
    expect(res.body.checks[0]).toMatchObject({ verdict: "broken", stale: true });
  });

  it("accepts a batch above the 100 kB default body limit", async () => {
    const runs = Array.from({ length: 300 }, (_, i) => ({
      check: "workflow-queue",
      ranAt: at(i * 5),
      ok: true,
      cadenceMinutes: 5,
      value: 0,
      details: { note: "x".repeat(400) },
    }));
    expect(JSON.stringify({ runs }).length).toBeGreaterThan(100_000);
    const res = await request(app).post("/internal/box-checks/runs").set(KEY).send({ runs });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(300);
  });

  it("serves a family by prefix and everything else by excludePrefix, each with its own verdict", async () => {
    await request(app)
      .post("/internal/box-checks/runs")
      .set(KEY)
      .send({
        runs: [
          { check: "deploy-pipeline", ranAt: at(1), ok: true, cadenceMinutes: 15 },
          { check: "page-speed", ranAt: at(1), ok: true, cadenceMinutes: 1440 },
          { check: "page-speed-today", ranAt: at(1), ok: false, reason: "Today took 9 s.", cadenceMinutes: 1440 },
        ],
      });
    const all = await request(app).get("/internal/box-checks").set(KEY);
    expect(all.body).toMatchObject({ status: "red", brokenCount: 1 });
    expect(all.body.checks).toHaveLength(3);
    const pages = await request(app).get("/internal/box-checks?prefix=page-speed-").set(KEY);
    expect(pages.body).toMatchObject({ status: "red", brokenCount: 1 });
    expect(pages.body.checks.map((c: { check: string }) => c.check)).toEqual(["page-speed-today"]);
    const box = await request(app).get("/internal/box-checks?excludePrefix=page-speed-").set(KEY);
    expect(box.body).toMatchObject({ status: "green", brokenCount: 0, reason: "Every check is OK." });
    expect(box.body.checks.map((c: { check: string }) => c.check)).toEqual(["deploy-pipeline", "page-speed"]);
  });

  it("forgets a check: every run of that name gone, the others untouched", async () => {
    await request(app)
      .post("/internal/box-checks/runs")
      .set(KEY)
      .send({
        runs: [
          { check: "page-speed-old-page", ranAt: at(1), ok: false, reason: "Slow.", cadenceMinutes: 1440 },
          { check: "page-speed-old-page", ranAt: at(1500), ok: true, cadenceMinutes: 1440 },
          { check: "page-speed-old-page-2", ranAt: at(1), ok: true, cadenceMinutes: 1440 },
          { check: "page-speed", ranAt: at(1), ok: true, cadenceMinutes: 1440 },
        ],
      });
    const res = await request(app).delete("/internal/box-checks/checks/page-speed-old-page").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ check: "page-speed-old-page", deleted: 2 });
    expect([...mem.rows.values()].map((r) => r.check).sort()).toEqual(["page-speed", "page-speed-old-page-2"]);
    const again = await request(app).delete("/internal/box-checks/checks/page-speed-old-page").set(KEY);
    expect(again.body).toEqual({ check: "page-speed-old-page", deleted: 0 });
    const view = await request(app).get("/internal/box-checks").set(KEY);
    expect(view.body).toMatchObject({ status: "green", brokenCount: 0 });
  });
});
