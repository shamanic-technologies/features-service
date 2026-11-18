/**
 * OUTCOME-FORECAST-1117, GOLD read: built on the campaign page's own figures and Silver's stored stats, every hypothesis
 * named, the OpenAPI schema holding the body it serves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const fetchSalesFunnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...a) }));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => undefined), BrandOwnershipError: class BrandOwnershipError extends Error {} }));
const basis = vi.fn();
vi.mock("./campaign-targets.js", () => ({ campaignTargetBasis: (...a: unknown[]) => basis(...a) }));
const readSilverStats = vi.fn();
const readSilverSweepRecord = vi.fn();
const readCampaignPairBins = vi.fn(async () => ({ bins: new Map<number, number>(), sumHours: 0, samplesHours: [] as number[] }));
vi.mock("../lib/outcome-silver-io.js", () => ({ readSilverStats: (...a: unknown[]) => readSilverStats(...a), readCurrentSilverSweep: () => readSilverSweepRecord(), readCampaignPairBins: (...a: unknown[]) => readCampaignPairBins(...(a as [])) }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

import router from "./outcome-forecast.js";
import { openApiDocument } from "../lib/openapi.js";
import { rateEstimateOf } from "../lib/outcome-silver.js";

const app = express().use(router);
const URL = "/brands/b1/sales-funnel-campaigns/c1/outcome-forecast";
const campaign = { id: "c1", brandId: "b1", offerId: "o1", salesFunnelId: "f", salesFunnelName: "Wide", status: "ongoing", stopReason: null, createdAt: "2026-01-01T00:00:00Z", units: [{ campaignId: "u1" }, { campaignId: "u2" }], target: "t_c" };
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const past = (units: number) => Array.from({ length: 20 }, (_, k) => ({ date: daysAgo(20 - k), outcomes: units, cumulativeOutcomes: units * (k + 1) }));
const card = (step: string, label: string, isTarget: boolean, units: number | null) => ({ step, label, isTarget, count: units === null ? null : units * 20, countUnavailableReason: units === null ? "outcome_not_declared_in_ledger" : null, past: units === null ? [] : past(units) });
const prior = { shape: 0.5, rate: 200 };
const transition = (scope: string, scopeId: string, fromKey: string, toKey: string, fromUnits: number, toUnits: number, pairs: number) => ({
  scope,
  scopeId,
  fromKey,
  toKey,
  sampleSize: fromUnits,
  computedAt: "x",
  body: { kind: "transition", stat: { fromUnits, toUnits, foreignToUnits: 0, linkedToUnits: pairs, linkCoverage: toUnits > 0 ? pairs / toUnits : null, exposure: fromUnits, censoredBy: null, yield: rateEstimateOf({ toUnits, exposure: fromUnits }, prior), prior, delay: pairs === 0 ? null : { n: pairs, meanHours: 30, medianHours: 24, p10Hours: 2, p25Hours: 8, p75Hours: 48, p90Hours: 72, cdf: [{ hours: 96, share: 1 }] } } },
});

describe("GET /brands/:brandId/sales-funnel-campaigns/:id/outcome-forecast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSalesFunnelCampaigns.mockResolvedValue([campaign]);
    readSilverSweepRecord.mockResolvedValue({ sweptAt: "2026-11-17T10:00:00.000Z" });
    basis.mockResolvedValue({
      row: {
        target: { key: "t_c", label: "C", lifecycleRung: null },
        milestones: [card("t_a", "A", false, 100), card("t_x", "X", false, null), card("t_b", "B", false, 10), card("t_c", "C", true, 0)],
        projection: { spendPerDayUsd: 10, spendPerDaySource: "daily_budget", costPerTargetUsd: 400, costPerTargetBasis: "default" },
      },
      input: {
        spendByDay: Array.from({ length: 20 }, (_, k) => ({ date: daysAgo(20 - k), spendUsd: 10 })),
        capacity: { campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: null },
        targetValueUsd: 5000,
      },
      milestoneBasis: [
        { step: "t_a", ledgerKeys: ["k_a"], neededPerTarget: 200 },
        { step: "t_x", ledgerKeys: ["k_x"], neededPerTarget: null },
        { step: "t_b", ledgerKeys: ["k_b"], neededPerTarget: 20 },
        { step: "t_c", ledgerKeys: ["k_c"], neededPerTarget: 1 },
      ],
    });
    readSilverStats.mockImplementation(async (scope: string) =>
      scope === "campaign" ? [transition("campaign", "c1", "k_a", "k_b", 2000, 200, 200)] : scope === "fleet" ? [transition("fleet", "all", "k_a", "k_b", 90000, 9000, 9000), transition("fleet", "all", "k_b", "k_c", 5000, 250, 40)] : [],
    );
  });

  it("serves the projection of the campaign page's milestones, each hypothesis named with its scope", async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);
    expect(basis).toHaveBeenCalledWith("b1", campaign, expect.objectContaining({ orgId: "org-1" }), "net", expect.any(String));
    expect(res.body).toMatchObject({ brandId: "b1", salesFunnelCampaignId: "c1", name: "Wide", pricing: "net", silverComputedAt: "2026-11-17T10:00:00.000Z", unavailableReason: null });
    // The milestone the ledger cannot count is left out and named.
    expect(res.body.uncountedMilestones).toEqual([{ step: "t_x", label: "X", reason: "outcome_not_declared_in_ledger" }]);
    expect(res.body.forecast.outcomes.map((o: { step: string }) => o.step)).toEqual(["t_a", "t_b", "t_c"]);
    expect(res.body.forecast.outcomes[0].unitsToDate).toBe(2000);
    expect(res.body.forecast.days).toHaveLength(548);
    expect(res.body.hypotheses.budget).toMatchObject({ source: "daily_budget", spendPerDayWhileSpendingUsd: 10 });
    expect(res.body.hypotheses.entryCost).toMatchObject({ step: "t_a", source: "campaign", measuredUsdPerUnit: 0.1 });
    expect(res.body.hypotheses.entryCost.usdPerUnit).toBeCloseTo(0.1, 2);
    expect(res.body.hypotheses.transitions.map((t: { yield: { source: string }; delay: { source: string } }) => [t.yield.source, t.delay.source])).toEqual([["campaign", "campaign"], ["fleet", "fleet"]]);
    // FORECAST-FRESH-EVIDENCE-1118: the transition Silver holds no campaign row for reads the campaign's own pairs live,
    // for its unit campaigns and that pair of outcomes only; the one it holds a row for reads nothing.
    expect(readCampaignPairBins.mock.calls).toEqual([[["u1", "u2"], "k_b", "k_c"]]);
    // $10 a day at $0.10 = 100 A a day, x 10% = 10 B, x 5% = one Target every 2 days.
    expect(res.body.forecast.nextTarget.medianInDays).toBeLessThan(15);
    expect(res.body.alternatives.map((a: { budgetMultiplier: number }) => a.budgetMultiplier)).toEqual([2, 5, 10]);
    expect(res.body.forecast.expectedRevenueUsd.expected[547]).toBeGreaterThan(5000 * 100);
  });

  it("the body is exactly what the OpenAPI schema states (no field the dashboard cannot type)", async () => {
    const res = await request(app).get(URL);
    const doc = openApiDocument as unknown as { paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
    const schema = doc.paths["/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/outcome-forecast"]!.get.responses["200"]!.content["application/json"]!.schema;
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(schema.properties).sort());
    const props = (s: unknown) => Object.keys((s as { properties: Record<string, unknown> }).properties).sort();
    const h = schema.properties.hypotheses as { properties: Record<string, { properties?: Record<string, unknown>; items?: unknown }> };
    expect(Object.keys(res.body.hypotheses.budget).sort()).toEqual(props(h.properties.budget));
    expect(Object.keys(res.body.hypotheses.entryCost).sort()).toEqual(props(h.properties.entryCost));
    expect(Object.keys(res.body.hypotheses.transitions[0]).sort()).toEqual(props(h.properties.transitions!.items));
  });

  it("before the first Silver sweep the yields come from the plan line, and it says so; never blank", async () => {
    // The stats table still holds rows of an OLDER rule (UNIT-LINKS-CONSUME-1117): with no sweep on today's rule they are never read.
    readSilverSweepRecord.mockResolvedValue(null);
    readSilverStats.mockClear();
    const res = await request(app).get(URL);
    expect(readSilverStats).not.toHaveBeenCalled();
    expect(res.body.silverComputedAt).toBeNull();
    // The plan line's rate, blended with the campaign's own counts (THIN-SAMPLE-BLEND-1118): the ladder names both.
    for (const t of res.body.hypotheses.transitions as Array<{ yield: { source: string; campaignEvidence: string | null; blend: Array<{ level: string }> }; delay: { source: string } }>) {
      expect([null, "live_counts"]).toContain(t.yield.campaignEvidence);
      expect(t.yield.blend[0]!.level).toBe("plan");
      // The campaign's own level is its page's live counts (FORECAST-FRESH-EVIDENCE-1118), never a stored row.
      expect(t.yield.blend.map((l) => l.level).filter((l) => !["plan", "campaign"].includes(l))).toEqual([]);
      expect(t.delay.source).toBe("default");
    }
    expect(res.body.forecast).not.toBeNull();
  });

  it("a Target the ledger cannot count: no forecast, under its own named reason", async () => {
    const reasons: Array<[string, string]> = [
      ["outcome_not_declared_in_ledger", "target_outcome_not_declared_in_ledger"],
      ["no_producer_declares_outcome", "target_no_producer_declares_outcome"],
      ["ledger_unreadable", "target_ledger_unreadable"],
      ["something_new", "target_not_counted_in_ledger"],
    ];
    for (const [cardReason, served] of reasons) {
      const b = await basis();
      b.row.milestones[3] = { ...card("t_c", "C", true, null), countUnavailableReason: cardReason };
      basis.mockResolvedValue(b);
      const res = await request(app).get(URL);
      expect([cardReason, res.body.unavailableReason, res.body.forecast]).toEqual([cardReason, served, null]);
      expect(res.body.uncountedMilestones.map((m: { step: string }) => m.step)).toContain("t_c");
    }
  });

  // FORECAST-NO-TARGET-YET-1118 (prod 2026-11-18, « Email Replies »: no paid client yet, the client's own team makes that
  // step so the campaign spends nothing on it: « The forecast is not available yet »). Its card reads a measured 0 since
  // FORECAST-FRESH-EVIDENCE-1118.
  it("a Target the ledger has simply not seen yet holds ZERO Units and is projected: the forecast is served", async () => {
    const b = await basis();
    b.row.milestones[3] = { ...card("t_c", "C", true, 0), count: 0, past: [] };
    basis.mockResolvedValue(b);
    const res = await request(app).get(URL);
    expect(res.body.unavailableReason).toBeNull();
    const outcomes = res.body.forecast.outcomes as Array<{ step: string; isTarget: boolean; unitsToDate: number }>;
    expect(outcomes.map((o) => o.step)).toEqual(["t_a", "t_b", "t_c"]);
    expect(outcomes[2]).toMatchObject({ isTarget: true, unitsToDate: 0 });
    expect(res.body.forecast.nextTarget.expectedOneByDate).not.toBeNull();
    expect(res.body.uncountedMilestones).toEqual([{ step: "t_x", label: "X", reason: "outcome_not_declared_in_ledger" }]);
  });

  it("a MIDDLE milestone at zero with no rate measured or planned around it: the chain goes on without it, and it is listed with why", async () => {
    const b = await basis();
    b.row.milestones[1] = { ...card("t_x", "X", false, 0), count: 0, past: [] };
    basis.mockResolvedValue(b);
    const res = await request(app).get(URL);
    expect(res.body.unavailableReason).toBeNull();
    expect(res.body.forecast.outcomes.map((o: { step: string }) => o.step)).toEqual(["t_a", "t_b", "t_c"]);
    expect(res.body.uncountedMilestones).toEqual([{ step: "t_x", label: "X", reason: "zero_units_and_no_rate_around_it" }]);
  });

  it("404 on a campaign that is not the brand's; 400 on an unknown pricing", async () => {
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns/nope/outcome-forecast")).body.reason).toBe("sales_funnel_campaign_not_found");
    expect((await request(app).get(`${URL}?pricing=x`)).body.reason).toBe("pricing_unrecognised");
  });
});
