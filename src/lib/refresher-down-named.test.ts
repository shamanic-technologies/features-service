import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import express from "express";
import request from "supertest";
import { answerInternalError, refresherDownIn } from "./internal-error.js";
import { RefresherDownError, refresherHeapMb, refresherNodeOptions } from "./view-refresher.js";
import { refresherCrashRun } from "./refresher-crash-monitor.js";

describe("a refresher restarting is a named, retryable answer (REFRESHER-DOWN-NAMED-1126)", () => {
  const app = express();
  app.get("/down", (_req, res) => answerInternalError(res, new RefresherDownError("brand-conversion-step-counts")));
  app.get("/wrapped", (_req, res) => answerInternalError(res, new Error("outer", { cause: new RefresherDownError("x") })));
  app.get("/other", (_req, res) => answerInternalError(res, new Error("boom")));

  it("answers 503 view_refresher_restarting + Retry-After, never a bare 500", async () => {
    const r = await request(app).get("/down");
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("60");
    expect(r.body).toMatchObject({ reason: "view_refresher_restarting", view: "brand-conversion-step-counts", retryAfterSeconds: 60 });
  });
  it("finds it through a cause chain", async () => {
    expect((await request(app).get("/wrapped")).status).toBe(503);
  });
  it("any other error stays a 500", async () => {
    const r = await request(app).get("/other");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal server error" });
    expect(refresherDownIn(new Error("boom"))).toBeNull();
  });
});

describe("the refresher's own heap ceiling", () => {
  it("defaults to 1536 MB, env overrides, nonsense ignored", () => {
    expect(refresherHeapMb({})).toBe(1536);
    expect(refresherHeapMb({ VIEW_REFRESHER_MAX_OLD_SPACE_MB: "2048" })).toBe(2048);
    expect(refresherHeapMb({ VIEW_REFRESHER_MAX_OLD_SPACE_MB: "12" })).toBe(1536);
  });
  it("drops the serving process's ceiling from NODE_OPTIONS, keeps the rest", () => {
    expect(refresherNodeOptions("--max-old-space-size=768 --enable-source-maps")).toBe("--enable-source-maps");
    expect(refresherNodeOptions(undefined)).toBe("");
  });
});

describe("Monitoring: refresher crashes", () => {
  const now = Date.parse("2026-11-26T04:00:00Z");
  it("red while a crash happened in the last hour, counts only crashes", () => {
    const run = refresherCrashRun(
      [
        { at: now - 20 * 60_000, code: null, signal: "SIGABRT", upMs: 7_547_789 },
        { at: now - 2 * 3_600_000, code: null, signal: "SIGABRT", upMs: 60_000 },
        { at: now - 5 * 60_000, code: 0, signal: null, upMs: 1_000 },
      ],
      now,
      1536,
    );
    expect(run.ok).toBe(false);
    expect(run.value).toBe(1);
    expect(run.reason).toContain("03:40 UTC (SIGABRT, up 126 min)");
  });
  it("green with no crash in the hour", () => {
    const run = refresherCrashRun([{ at: now - 2 * 3_600_000, code: null, signal: "SIGABRT", upMs: 1 }], now, 1536);
    expect(run.ok).toBe(true);
    expect(run.value).toBe(0);
  });
});

describe("the per-offer funnel list prices on stated rates while the refresher restarts", () => {
  it("a refresher-down failure inside the budget reads as still computing; any other failure throws", async () => {
    const { withinBudget, OVER_BUDGET } = await import("../routes/agent-catalogue.js");
    await expect(withinBudget(Promise.reject(new RefresherDownError("brand-conversion-step-counts")), 1_000)).resolves.toBe(OVER_BUDGET);
    await expect(withinBudget(Promise.reject(new Error("lead-service 500")), 1_000)).rejects.toThrow("lead-service 500");
    await expect(withinBudget(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });
});
