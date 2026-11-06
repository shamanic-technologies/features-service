/**
 * OUTCOME-RUNG-AND-TARGET-1106: the Today read, one row per ongoing funnel campaign on its Target. The past comes from the
 * campaign's own pipe charts and never moves with the Plan; only the projection reads the stored plan line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const fetchSalesFunnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...a) }));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => undefined), BrandOwnershipError: class BrandOwnershipError extends Error {} }));
const activity = vi.fn();
vi.mock("./sales-funnel-campaign-activity.js", () => ({ funnelCampaignActivity: (...a: unknown[]) => activity(...a) }));
const charts = vi.fn();
vi.mock("./spend-charts.js", () => ({ funnelCampaignSpendCharts: (...a: unknown[]) => charts(...a) }));
const readPlan = vi.fn();
vi.mock("../lib/factory-shadow-store.js", () => ({ readPlan: (...a: unknown[]) => readPlan(...a) }));
const budget = vi.fn();
vi.mock("../lib/funnel-campaign-budget-client.js", () => ({ fetchFunnelCampaignDailyBudgetUsd: (...a: unknown[]) => budget(...a) }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

import router from "./campaign-targets.js";

const app = express().use(router);
const row = (id: string, status: string) => ({ id, brandId: "b1", offerId: "o1", salesFunnelId: "f", salesFunnelName: `Funnel ${id}`, status, stopReason: null, createdAt: "2026-10-01T00:00:00.000Z", units: [], target: "conversation", mode: "proactive" });
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const pipeDaily = [
  { date: day(2), spendUsd: 10, cumulativeOutcomes: 0 },
  { date: day(1), spendUsd: 10, cumulativeOutcomes: 1 },
  { date: day(0), spendUsd: 10, cumulativeOutcomes: 2 },
];
const planBody = (cost: number, funnelId: string) => ({ plan: { target: "conversation", mode: "proactive", running: { funnelId, reachesTarget: true, figures: { costPerTargetUsd: cost, basis: "fleet", unavailableReason: null, targetValueUsd: 60 } }, shadow: null } });

beforeEach(() => {
  fetchSalesFunnelCampaigns.mockResolvedValue([row("c1", "ongoing"), row("c2", "stopped")]);
  activity.mockResolvedValue({ funnel: { steps: [{ key: "lead_found", label: "Lead found", kind: "step", people: 100 }, { key: "conversation", label: "Positive reply", kind: "step", people: 2 }] } });
  charts.mockResolvedValue({
    campaign: { daily: pipeDaily, totals: { spendUsd: 30 } },
    pipes: [{ outcomeStep: "conversation", outcomeUnavailableReason: null, daily: pipeDaily, totals: { spendUsd: 20, outcomes: 2 } }],
  });
  readPlan.mockResolvedValue({ orgId: "org-1", brandId: "b1", offerId: "o1", status: "ok", failure: null, body: planBody(15, "f1"), computedAt: "2026-11-06T09:00:00.000Z" });
  budget.mockResolvedValue(30);
});

describe("GET /brands/:brandId/campaign-targets", () => {
  it("one row per ONGOING campaign on its Target, net by default, Lifecycle rung from the outcome rung catalogue", async () => {
    const res = await request(app).get("/brands/b1/campaign-targets");
    expect(res.status).toBe(200);
    expect(res.body.pricing).toBe("net");
    expect(charts.mock.calls[0]![2]).toBe("net");
    expect(res.body.targets).toHaveLength(1);
    expect(res.body.targets[0]).toMatchObject({
      salesFunnelCampaignId: "c1",
      target: { key: "conversation", label: "Positive reply", lifecycleRung: "engaged" },
      outcomesToDate: 2,
      costPerOutcomeUsd: 15,
      measuredReturn: { roiMultiple: 4, valueUsd: 120, spentUsd: 30 },
      projection: { planComputedAt: "2026-11-06T09:00:00.000Z", planFunnelId: "f1", outcomesPerDay: 2, nextExpectedInHours: 12, spendPerDaySource: "daily_budget" },
    });
    expect(res.body.targets[0].past.map((p: { outcomes: number }) => p.outcomes)).toEqual([0, 1, 1]);
  });

  it("two consecutive plan ticks with a different line: identical past, only the projection moves", async () => {
    const a = (await request(app).get("/brands/b1/campaign-targets")).body.targets[0];
    readPlan.mockResolvedValue({ orgId: "org-1", brandId: "b1", offerId: "o1", status: "ok", failure: null, body: planBody(30, "f2"), computedAt: "2026-11-06T12:00:00.000Z" });
    const b = (await request(app).get("/brands/b1/campaign-targets")).body.targets[0];
    expect(b.past).toEqual(a.past);
    expect([b.outcomesToDate, b.costPerOutcomeUsd, b.measuredReturn]).toEqual([a.outcomesToDate, a.costPerOutcomeUsd, a.measuredReturn]);
    expect(b.projection).toMatchObject({ planFunnelId: "f2", outcomesPerDay: 1 });
  });

  it("an unreadable budget projects on the spend pace; bad pricing is a 400", async () => {
    budget.mockRejectedValue(new Error("billing down"));
    const res = await request(app).get("/brands/b1/campaign-targets?pricing=gross");
    expect(res.body.targets[0].projection.spendPerDaySource).toBe("spend_pace_7d");
    expect((await request(app).get("/brands/b1/campaign-targets?pricing=x")).status).toBe(400);
  });
});
