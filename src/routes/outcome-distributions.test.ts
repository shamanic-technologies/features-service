import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const readSilverStats = vi.fn();
const readSilverSweepRecord = vi.fn();
vi.mock("../lib/outcome-silver-io.js", () => ({ readSilverStats: (...a: unknown[]) => readSilverStats(...a), readCurrentSilverSweep: () => readSilverSweepRecord() }));

process.env.FEATURES_SERVICE_API_KEY = "k";
const { default: router } = await import("./outcome-distributions.js");
const app = express().use(router);

const dist = { n: 3, mean: 1, median: 1, p10: 1, p25: 1, p75: 1, p90: 1 };
const estimate = { mean: 0.1, median: 0.09, p10: 0.05, p25: 0.07, p75: 0.12, p90: 0.16, shape: 2.5, rate: 25 };

describe("GET /internal/outcome-distributions (Silver, staff)", () => {
  beforeEach(() => {
    readSilverStats.mockReset();
    readSilverSweepRecord.mockReset();
    readSilverSweepRecord.mockResolvedValue({ sweptAt: "2026-11-17T10:00:00.000Z", units: 880000, stats: 2, copy: { pages: 1, units: 1 }, copyMs: 1, buildMs: 1 });
  });

  it("serves the stored cost rows and transitions of a scope, never computing", async () => {
    readSilverStats.mockResolvedValue([
      { scope: "brand", scopeId: "b1", fromKey: "", toKey: "alpha", sampleSize: 3, computedAt: "x", body: { kind: "unit_cost", stat: { units: 3, costUsd: dist, meanGrossCostUsd: 2 } } },
      { scope: "brand", scopeId: "b1", fromKey: "alpha", toKey: "beta", sampleSize: 3, computedAt: "x", body: { kind: "transition", stat: { fromUnits: 3, toUnits: 1, exposure: 2.5, censoredBy: "fleet", yield: estimate, prior: { shape: 0.5, rate: 5 }, delay: null } } },
    ]);
    const res = await request(app).get("/internal/outcome-distributions?scope=brand&scopeId=b1&toKey=beta").set("x-api-key", "k");
    expect(res.status).toBe(200);
    expect(readSilverStats).toHaveBeenCalledWith("brand", "b1", { fromKey: undefined, toKey: "beta" });
    expect(res.body).toEqual({
      scope: "brand",
      scopeId: "b1",
      computedAt: "2026-11-17T10:00:00.000Z",
      unitsHeld: 880000,
      unitCosts: [{ outcomeKey: "alpha", units: 3, costUsd: dist, meanGrossCostUsd: 2 }],
      transitions: [{ fromKey: "alpha", toKey: "beta", fromUnits: 3, toUnits: 1, exposure: 2.5, censoredBy: "fleet", yield: estimate, prior: { shape: 0.5, rate: 5 }, delay: null }],
    });
  });

  it("the fleet needs no id; a brand or a campaign does; an unknown scope is refused", async () => {
    readSilverStats.mockResolvedValue([]);
    expect((await request(app).get("/internal/outcome-distributions?scope=fleet").set("x-api-key", "k")).status).toBe(200);
    expect(readSilverStats).toHaveBeenCalledWith("fleet", "all", { fromKey: undefined, toKey: undefined });
    expect((await request(app).get("/internal/outcome-distributions?scope=campaign").set("x-api-key", "k")).body.reason).toBe("scope_id_missing");
    expect((await request(app).get("/internal/outcome-distributions?scope=org&scopeId=x").set("x-api-key", "k")).body.reason).toBe("scope_unrecognised");
  });

  it("before the first sweep: 503, never an empty answer read as « nothing measured »", async () => {
    readSilverStats.mockResolvedValue([]);
    readSilverSweepRecord.mockResolvedValue(null);
    const res = await request(app).get("/internal/outcome-distributions?scope=fleet").set("x-api-key", "k");
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("outcome_distributions_not_built_yet");
  });

  it("needs the api key", async () => {
    expect((await request(app).get("/internal/outcome-distributions?scope=fleet")).status).toBe(401);
  });
});
