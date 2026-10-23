import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import router, {
  __awaitCustomerHealthBuild,
  __resetCustomerHealthServing,
  __setCustomerHealthServingDeps,
} from "./customer-health.js";
import type { CustomerHealthBoard } from "../lib/customer-health-compute.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";

const CELL = `customer-health:${routeResponseShapeFingerprint("/internal/stats/customer-health")}`;

const KEY = "test-key";
process.env.FEATURES_SERVICE_API_KEY = KEY;

const board = (asOf: string): CustomerHealthBoard =>
  ({ customers: [], orgs: [], orgStats: {}, stats: {}, unreadOrgReads: [], asOf }) as unknown as CustomerHealthBoard;

function app() {
  const a = express();
  a.use(router);
  return a;
}

/** An in-memory persisted copy, like fleet-cell-store. */
function memoryCells() {
  const cells = new Map<string, { text: string; computedAt: number }>();
  return {
    cells,
    loadCell: async (k: string) => cells.get(k) ?? null,
    storeCell: async (k: string, text: string, computedAt: number) => void cells.set(k, { text, computedAt }),
  };
}

beforeEach(() => {
  __resetCustomerHealthServing();
  __setCustomerHealthServingDeps(null);
});

describe("GET /internal/stats/customer-health (CUSTOMER-HEALTH-OOM-1023)", () => {
  it("never builds on the request path: 503 while the first build runs, then the build at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const computeBoard = vi.fn(async () => {
      await gate;
      return board("t1");
    });
    __setCustomerHealthServingDeps({ ...memoryCells(), computeBoard, refresherBase: () => null });

    // Three reads at once while nothing is built: each answers now, ONE build runs.
    const first = await Promise.all([1, 2, 3].map(() => request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY)));
    expect(first.map((r) => r.status)).toEqual([503, 503, 503]);
    expect(first[0].body.reason).toBe("customer_health_not_computed_yet");
    expect(computeBoard).toHaveBeenCalledTimes(1);

    release();
    await __awaitCustomerHealthBuild();
    const res = await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe("t1");
    expect(res.body.freshness.refreshEveryMinutes).toBe(15);
    expect(computeBoard).toHaveBeenCalledTimes(1); // fresh: no rebuild
  });

  it("a fresh process serves the persisted copy without building", async () => {
    const mem = memoryCells();
    const computeBoard = vi.fn(async () => board("new"));
    __setCustomerHealthServingDeps({ ...mem, computeBoard, refresherBase: () => null });
    // Persist one build, then forget the process state.
    await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    await __awaitCustomerHealthBuild();
    __resetCustomerHealthServing();
    computeBoard.mockClear();
    const res = await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe("new");
    expect(computeBoard).not.toHaveBeenCalled();
  });

  it("with a refresher, the server asks it to build and reads the copy it stored; it never builds itself", async () => {
    const mem = memoryCells();
    const serverCompute = vi.fn(async () => board("server"));
    let status = { running: true, lastFinished: null as null | { buildId: number; finishedAt: string; error: string | null } };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/build") && init?.method === "POST") return new Response(JSON.stringify({ buildId: 7 }), { status: 202 });
      if (u.endsWith("/build-status")) {
        const s = status;
        if (s.running) {
          // The refresher stores its copy, then reports the build finished on the next poll.
          await mem.storeCell(CELL, JSON.stringify({ asOf: "refresher" }), Date.now());
          status = { running: false, lastFinished: { buildId: 7, finishedAt: "x", error: null } };
        }
        return new Response(JSON.stringify(s));
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    __setCustomerHealthServingDeps({ ...mem, computeBoard: serverCompute, refresherBase: () => "http://refresher", fetchImpl, pollMs: 1 });

    const first = await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(first.status).toBe(503);
    await __awaitCustomerHealthBuild();
    const res = await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe("refresher");
    expect(serverCompute).not.toHaveBeenCalled();
  });

  it("refresher down: the build fails, nothing is built on the server, the next try waits 10 min", async () => {
    const serverCompute = vi.fn(async () => board("server"));
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    __setCustomerHealthServingDeps({ ...memoryCells(), computeBoard: serverCompute, refresherBase: () => "http://refresher", fetchImpl, pollMs: 1 });
    const res = await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(res.status).toBe(503);
    await __awaitCustomerHealthBuild();
    await request(app()).get("/internal/stats/customer-health").set("x-api-key", KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(serverCompute).not.toHaveBeenCalled();
  });

  it("the server refuses to build when it has a refresher (409)", async () => {
    __setCustomerHealthServingDeps({ ...memoryCells(), refresherBase: () => "http://refresher" });
    const res = await request(app()).post("/internal/stats/customer-health/build").set("x-api-key", KEY);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("build_runs_in_refresher");
  });

  it("refresher side: POST /build starts one build, status reports it finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const computeBoard = vi.fn(async () => (await gate, board("r")));
    __setCustomerHealthServingDeps({ ...memoryCells(), computeBoard, refresherBase: () => null });
    const a = await request(app()).post("/internal/stats/customer-health/build").set("x-api-key", KEY);
    const b = await request(app()).post("/internal/stats/customer-health/build").set("x-api-key", KEY);
    const running = await request(app()).get("/internal/stats/customer-health/build-status").set("x-api-key", KEY);
    expect(running.body.running).toBe(true);
    release();
    expect(a.status).toBe(202);
    expect(b.body.buildId).toBe(a.body.buildId); // joins the running build
    await __awaitCustomerHealthBuild();
    const s = await request(app()).get("/internal/stats/customer-health/build-status").set("x-api-key", KEY);
    expect(s.body).toMatchObject({ running: false, lastFinished: { buildId: a.body.buildId, error: null } });
    expect(computeBoard).toHaveBeenCalledTimes(1);
  });
});
