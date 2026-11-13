import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** SCRIPT-VALUE-RATING-1113-MON: the board is served from its stored copy, with the stored daily shares; stale = broken. */
vi.mock("../db/index.js", () => {
  const rows = [
    { day: "2026-11-12", outcome: "message_written", scriptDynasty: "message_written/a", sharePct: 70 },
    { day: "2026-11-12", outcome: "message_written", scriptDynasty: "message_written/b", sharePct: 30 },
    { day: "2026-11-13", outcome: "message_written", scriptDynasty: "message_written/b", sharePct: 55 },
    { day: "2026-11-13", outcome: "message_written", scriptDynasty: "message_written/a", sharePct: 45 },
  ];
  return { db: { select: () => ({ from: () => ({ where: async () => rows }) }) }, sql: {} };
});
process.env.FEATURES_SERVICE_API_KEY = "k";
let stored: { text: string; computedAt: number } | null = null;
vi.mock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: async () => stored, claimFleetCellBuild: async () => false, storeFleetCell: async () => {} }));
vi.mock("./script-rating.js", () => ({ buildScriptRating: async () => { throw new Error("not in this test"); } }));

const { default: routes, drawShareHistory } = await import("./script-engines.js");
const app = express().use(routes);
const cell = (computedAt: number) => ({
  text: JSON.stringify({ ledgerBuiltAt: "2026-11-13T10:00:00Z", computedAt: new Date(computedAt).toISOString(), draws: 400, engines: [{ outcome: "message_written", scripts: [] }, { outcome: "post_published", scripts: [] }] }),
  computedAt,
});

describe("GET /internal/research/script-engines", () => {
  it("503 before the first build", async () => {
    stored = null;
    const res = await request(app).get("/internal/research/script-engines").set("x-api-key", "k");
    expect([res.status, res.body.reason]).toEqual([503, "script_engines_not_built_yet"]);
  });

  it("serves the stored board + each Engine's stored daily shares, healthy while fresh", async () => {
    stored = cell(Date.now() - 60_000);
    const res = await request(app).get("/internal/research/script-engines").set("x-api-key", "k");
    expect(res.status).toBe(200);
    expect(res.body.health).toEqual({ broken: false, reason: null });
    expect(res.body.engines[0].drawShareHistory).toEqual([
      { day: "2026-11-12", shares: [{ scriptDynasty: "message_written/a", sharePct: 70 }, { scriptDynasty: "message_written/b", sharePct: 30 }] },
      { day: "2026-11-13", shares: [{ scriptDynasty: "message_written/b", sharePct: 55 }, { scriptDynasty: "message_written/a", sharePct: 45 }] },
    ]);
    expect(res.body.engines[1].drawShareHistory).toEqual([]);
  });

  it("a build over an hour old is broken (red on Monitoring)", async () => {
    stored = cell(Date.now() - 2 * 3_600_000);
    const res = await request(app).get("/internal/research/script-engines").set("x-api-key", "k");
    expect(res.body.health).toEqual({ broken: true, reason: "board_not_rebuilt" });
  });

  it("drawShareHistory orders days and shares", () => {
    expect(drawShareHistory([]).size).toBe(0);
  });
});
