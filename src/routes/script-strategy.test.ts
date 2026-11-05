import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const unitOf = vi.fn();
const scriptsOf = vi.fn();
const playOf = vi.fn();
const catalogueOf = vi.fn();
vi.mock("../lib/fleet-leg-campaigns.js", () => ({ fetchCampaignUnit: (id: string) => unitOf(id) }));
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/script-catalogue-client.js")>()), readRunnableScripts: () => scriptsOf() }));
vi.mock("./workflow-projection.js", () => ({ playOfLegRead: (...a: unknown[]) => playOf(...a) }));
vi.mock("../lib/plays-store.js", () => ({ loadPlayCatalogue: () => catalogueOf() }));

import router from "./script-strategy.js";
import { buildPlayCatalogue, type Strategy } from "../lib/plays.js";

const at = "2026-11-06T00:00:00.000Z";
const valid: Strategy = { id: "valid-only", name: "Valid only", description: "", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: at };
const script = (outcome: string, dynasty: string) => ({ id: `${dynasty}-id`, outcome, dynasty, version: 1, description: "", tactics: {}, code: "" });

function app() {
  const a = express();
  a.use(router);
  return a;
}
const get = (q: string) => request(app()).get(`/internal/script-strategy${q}`).set("x-api-key", "k");

beforeEach(() => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  unitOf.mockReset();
  scriptsOf.mockReset();
  playOf.mockReset();
  catalogueOf.mockReset();
  catalogueOf.mockResolvedValue(
    buildPlayCatalogue({
      tactics: [{ id: "catch-all", name: "Catch-all", description: "d", createdBy: "t", createdAt: at, appliesTo: "script" }],
      strategies: [valid],
      plays: [],
      verdicts: [],
      writerVerdicts: [
        { subjectKind: "script", subjectKey: "lead_found/dy_valid", tacticId: "catch-all", subjectVersion: "v1", verdict: false, probability: 0.1, model: "jev", judgedDescription: "d", judgedAt: at },
        { subjectKind: "script", subjectKey: "lead_found/dy_catch", tacticId: "catch-all", subjectVersion: "v1", verdict: true, probability: 0.9, model: "jev", judgedDescription: "d", judgedAt: at },
      ],
    }),
  );
  scriptsOf.mockResolvedValue([script("lead_found", "dy_valid"), script("lead_found", "dy_catch"), script("email_found", "dy_other")]);
});

describe("GET /internal/script-strategy", () => {
  it("keeps the Engine's scripts the unit's strategy allows", async () => {
    unitOf.mockResolvedValue({ found: true, featureSlug: "lead-sourcing", legKey: "start_to_lead_found", salesFunnelId: "start_to_lead_found@lead-sourcing~valid-only" });
    playOf.mockResolvedValue({ answer: { id: "p~valid-only", pipeId: "p", strategyId: "valid-only", strategyName: "Valid only", default: false, source: "sales_funnel" }, excludedReason: () => null });
    const r = await get("?campaignId=c1&outcome=lead_found");
    expect(r.status).toBe(200);
    expect(playOf).toHaveBeenCalledWith("lead-sourcing", "start_to_lead_found", "start_to_lead_found@lead-sourcing~valid-only");
    expect(r.body).toMatchObject({ campaignId: "c1", outcome: "lead_found", strategyId: "valid-only", strategySource: "sales_funnel", keptDynasties: ["dy_valid"], scriptTacticIds: ["catch-all"] });
    expect(r.body.scripts).toHaveLength(2);
  });

  it("no strategy on the unit's pipe keeps every script of the Engine", async () => {
    unitOf.mockResolvedValue({ found: true, featureSlug: "lead-sourcing", legKey: "start_to_lead_found", salesFunnelId: null });
    playOf.mockResolvedValue(null);
    const r = await get("?campaignId=c1&outcome=lead_found");
    expect(r.body).toMatchObject({ strategyId: null, strategySource: "no_strategy", keptDynasties: ["dy_catch", "dy_valid"] });
  });

  it("refuses without both parameters, 404s an unknown campaign, 502s an unreadable catalogue (fail closed)", async () => {
    expect((await get("?campaignId=c1")).status).toBe(400);
    unitOf.mockResolvedValue({ found: false });
    expect((await get("?campaignId=nope&outcome=lead_found")).body.reason).toBe("campaign_not_found");
    unitOf.mockResolvedValue({ found: true, featureSlug: null, legKey: null, salesFunnelId: null });
    scriptsOf.mockRejectedValue(new Error("workflow-service 503"));
    const r = await get("?campaignId=c1&outcome=lead_found");
    expect(r.status).toBe(502);
    expect(r.body.reason).toBe("script_strategy_unreadable");
  });
});
