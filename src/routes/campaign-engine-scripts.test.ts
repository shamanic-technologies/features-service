import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** CAMPAIGN-SCRIPTS-1113: the campaign page's Engines in scripts, org-scoped, read on the campaign's own unit runs. */
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
  fetchSalesFunnelCampaigns: async () => [{ id: "sfc-1", target: "message_written", units: [{ campaignId: "u-1" }, { campaignId: "u-2" }] }],
}));
let stored: { text: string; computedAt: number } | null = null;
vi.mock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: async () => stored }));
const warm = vi.fn(async () => "skipped");
vi.mock("./script-engines.js", () => ({ warmScriptEngines: (...a: unknown[]) => warm(...(a as [])) }));
vi.mock("../lib/engine-strategy-io.js", () => ({
  listEngineStrategies: async () => [{ campaignId: "sfc-1", outcome: "message_written", strategyId: null }],
  labelOfOutcome: (o: string) => o,
}));
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({
  ...(await orig<object>()),
  readRunnableScripts: async () => [
    { id: "1", outcome: "message_written", dynasty: "a", version: 1, description: "", code: "", tactics: {} },
    { id: "2", outcome: "message_written", dynasty: "b", version: 1, description: "", code: "", tactics: {} },
  ],
}));
vi.mock("../lib/plays-store.js", () => ({ loadPlayCatalogue: async () => ({ tactics: new Map(), strategies: new Map(), tacticsByWriter: new Map() }) }));
const reach = vi.fn();
vi.mock("../lib/script-value-rating-io.js", () => ({ readCampaignScriptReach: (ids: string[]) => reach(ids) }));
vi.mock("../lib/channel-declarations-store.js", () => ({ listDeclaredSteps: async () => [] }));

const { default: routes } = await import("./campaign-engine-scripts.js");
const app = express().use(routes);
const url = "/brands/b-1/sales-funnel-campaigns/sfc-1/engine-scripts";

describe("GET /brands/:brandId/sales-funnel-campaigns/:id/engine-scripts", () => {
  it("503 and a rebuild while the stored Rating predates the campaign read", async () => {
    stored = { text: JSON.stringify({ computedAt: "2026-11-13T20:00:00Z", engines: [] }), computedAt: Date.now() };
    const res = await request(app).get(url);
    expect([res.status, res.body.reason]).toEqual([503, "script_rating_not_built_yet"]);
    expect(warm).toHaveBeenCalledWith(true);
  });

  it("reads the campaign's own unit runs and serves every kept script with shares adding to 100", async () => {
    stored = { text: JSON.stringify({ computedAt: "2026-11-13T20:00:00Z", engines: [], ratings: [], values: [] }), computedAt: Date.now() };
    reach.mockResolvedValue({ builtAt: "2026-11-13T19:50:00Z", groups: [{ scriptDynasty: "message_written/a", day: "2026-11-13", producedOutcomes: ["message_written"], reachedOutcomes: [], runs: 3, spentUsd: 0.03 }] });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(reach).toHaveBeenCalledWith(["u-1", "u-2"]);
    const [engine] = res.body.engines;
    expect(engine.outcome).toBe("message_written");
    expect(engine.isTarget).toBe(true);
    expect(engine.strategyState).toBe("no_condition");
    expect(engine.scripts.reduce((n: number, s: { shareOfDrawsPct: number }) => n + s.shareOfDrawsPct, 0)).toBeCloseTo(100, 0);
    expect(engine.scripts.find((s: { script: string }) => s.script === "message_written/a").campaign.runs).toBe(3);
    expect(JSON.stringify(res.body)).not.toMatch(/valuePerDollar|creditUsd/);
  });

  it("404 for a campaign of another brand / org", async () => {
    const res = await request(app).get("/brands/b-1/sales-funnel-campaigns/other/engine-scripts");
    expect([res.status, res.body.reason]).toEqual([404, "sales_funnel_campaign_not_found"]);
  });
});
