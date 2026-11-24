import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** PLAN-RECURSIVE-PER-ENGINE-1124: the campaign's Plan tree (org-scoped, read-only) and the staff dry read of carried verdicts. */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
  apiKeyOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: async () => {}, BrandOwnershipError: class extends Error {} }));
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({
  fetchSalesFunnelCampaigns: async () => [
    { id: "sfc-1", target: "signup", units: [{ campaignId: "u-1" }] },
    { id: "sfc-2", target: null, units: [] },
  ],
}));
let stored: { text: string; computedAt: number } | null = null;
vi.mock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: async () => stored }));
const warm = vi.fn(async () => "skipped");
vi.mock("./script-engines.js", () => ({ warmScriptEngines: (...a: unknown[]) => warm(...(a as [])) }));
const list = vi.fn(async (id: string | null) =>
  id === null
    ? [
        { campaignId: "sfc-1", outcome: "signup", orgId: "org-1", strategyId: null, source: "carried", briefHash: "h", optionsSignature: null, confidence: null, model: null, carriedFrom: "p", judgedAt: "2026-11-08T00:00:00.000Z" },
        { campaignId: "sfc-9", outcome: "signup", orgId: "org-2", strategyId: null, source: "judge", briefHash: "h", optionsSignature: "s", confidence: 0.9, model: "m", carriedFrom: null, judgedAt: "2026-11-20T00:00:00.000Z" },
      ]
    : [],
);
const write = vi.fn();
const judged = vi.fn();
vi.mock("../lib/engine-strategy-io.js", () => ({
  listEngineStrategies: (id: string | null) => list(id),
  labelOfOutcome: (o: string) => o,
  writeEngineStrategy: (...a: unknown[]) => write(...a),
  engineStrategyOfCampaign: (...a: unknown[]) => judged(...a),
  askJev: (...a: unknown[]) => judged(...a),
}));
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({
  ...(await orig<object>()),
  readRunnableScripts: async () => [
    { id: "1", outcome: "signup", dynasty: "path", version: 1, description: "", code: "", tactics: {}, materials: ["message_sent"] },
    { id: "2", outcome: "message_sent", dynasty: "sender", version: 2, description: "Sends", code: "", tactics: { asks: ["message_written"] } },
    { id: "3", outcome: "message_written", dynasty: "writer", version: 1, description: "", code: "", tactics: {}, materials: [] },
    { id: "4", outcome: "lead_found", dynasty: "finder", version: 1, description: "", code: "", tactics: {}, materials: [] },
  ],
}));
vi.mock("../lib/plays-store.js", () => ({ loadPlayCatalogue: async () => ({ tactics: new Map(), strategies: new Map(), tacticsByWriter: new Map() }) }));
vi.mock("../lib/channel-declarations-store.js", () => ({ listDeclaredSteps: async () => [] }));

const { default: treeRoutes } = await import("./campaign-plan-tree.js");
const { default: carriedRoutes } = await import("./carried-verdicts.js");
const app = express().use(treeRoutes).use(carriedRoutes);
const url = "/brands/b-1/sales-funnel-campaigns/sfc-1/plan-tree";
const built = () => ({ text: JSON.stringify({ computedAt: "2026-11-24T08:00:00Z", engines: [], ratings: [], values: [] }), computedAt: Date.now() });

describe("GET /brands/:brandId/sales-funnel-campaigns/:id/plan-tree", () => {
  it("503 and a rebuild while the Rating is not built", async () => {
    stored = { text: JSON.stringify({ computedAt: "2026-11-24T08:00:00Z", engines: [] }), computedAt: Date.now() };
    const res = await request(app).get(url);
    expect([res.status, res.body.reason]).toEqual([503, "script_rating_not_built_yet"]);
    expect(warm).toHaveBeenCalledWith(true);
  });

  it("walks from the Target down through what each picked script needs, read-only, with no score", async () => {
    stored = built();
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.target).toEqual({ key: "signup", label: "Signup" });
    expect(res.body.strategiesReadFrom).toBe("stored_verdicts");
    expect(res.body.nodes.map((n: { id: string }) => n.id)).toEqual(["signup", "signup>message_sent", "signup>message_sent>message_written"]);
    expect(res.body.nodes.map((n: { strategyState: string }) => n.strategyState)).toEqual(["not_judged_yet", "not_judged_yet", "not_judged_yet"]);
    expect(res.body.nodes.map((n: { picked: string }) => n.picked)).toEqual(["signup/path", "message_sent/sender", "message_written/writer"]);
    expect(res.body.nodes[2].endReason).toBe("script_needs_nothing");
    // Read-only: the stored verdicts of THIS campaign are listed once; nothing is judged, nothing written.
    expect(list).toHaveBeenCalledWith("sfc-1");
    expect(judged).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/valuePerDollar|creditUsd|valueUsd|score/);
    expect((await request(app).get(url)).body).toEqual(res.body);
  });

  it("a campaign stating no Target serves no node, with the reason", async () => {
    stored = built();
    const res = await request(app).get("/brands/b-1/sales-funnel-campaigns/sfc-2/plan-tree");
    expect([res.status, res.body.target, res.body.nodes, res.body.unavailableReason]).toEqual([200, null, [], "campaign_states_no_target"]);
  });

  it("404 for a campaign of another brand / org", async () => {
    const res = await request(app).get("/brands/b-1/sales-funnel-campaigns/other/plan-tree");
    expect([res.status, res.body.reason]).toEqual([404, "sales_funnel_campaign_not_found"]);
  });
});

describe("GET /internal/engine-strategies/carried-reask", () => {
  it("lists the carried verdicts a judged-row reading would re-ask, asking no judge and writing nothing", async () => {
    const res = await request(app).get("/internal/engine-strategies/carried-reask");
    expect(res.status).toBe(200);
    expect([res.body.carriedRows, res.body.carriedCampaigns, res.body.wouldReaskRows, res.body.wouldCallJudgeRows]).toEqual([1, 1, 1, 0]);
    expect(res.body.rows.map((r: Record<string, unknown>) => [r.campaignId, r.outcome, r.storedStrategyId, r.optionsToday, r.reason])).toEqual([["sfc-1", "signup", null, 1, "no_signature_stored"]]);
    expect(judged).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
