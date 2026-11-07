/**
 * OUTCOME-RUNG-AND-TARGET-1106: the Today read, one row per ongoing funnel campaign on its Target. The past comes from the
 * campaign's own pipe charts and never moves with the Plan; only the projection reads the stored plan line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../lib/channel-declarations-store.js", () => ({ listDeclaredSteps: vi.fn(async () => [{ key: "threads_post_published", label: "Threads post published" }]) }));
const copies = vi.fn();
vi.mock("./agent-catalogue.js", () => ({ funnelCopiesFor: (...a: unknown[]) => copies(...a) }));
const ledgerOf = vi.fn();
vi.mock("../lib/campaign-ledger-units-client.js", async (orig) => ({ ...(await orig<object>()), fetchCampaignLedgerUnits: (...a: unknown[]) => ledgerOf(...a) }));
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
const row = (id: string, status: string) => ({
  id,
  brandId: "b1",
  offerId: "o1",
  salesFunnelId: "f",
  salesFunnelName: `Funnel ${id}`,
  status,
  stopReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  units: [
    { campaignId: "u-src", pipeId: "p-src", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", status: "ongoing" },
    { campaignId: "u-mail", pipeId: "p-mail", featureSlug: "cold-email", legKey: "lead_found_to_conversation", status: "ongoing" },
  ],
  target: "conversation",
  mode: "proactive",
});
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
    pipes: [
      { campaignId: "u-src", outcomeStep: "lead_found", outcomeUnavailableReason: null, daily: [], totals: { spendUsd: 10, outcomes: 0 } },
      { campaignId: "u-mail", outcomeStep: "conversation", outcomeUnavailableReason: null, daily: pipeDaily, totals: { spendUsd: 20, outcomes: 2 } },
    ],
  });
  readPlan.mockResolvedValue({ orgId: "org-1", brandId: "b1", offerId: "o1", status: "ok", failure: null, body: planBody(15, "f1"), computedAt: "2026-11-06T09:00:00.000Z" });
  budget.mockResolvedValue(30);
  copies.mockResolvedValue({ pipeSteps: new Map([["p-src", { fromStep: null, toStep: "lead_found" }], ["p-mail", { fromStep: "lead_found", toStep: "conversation" }]]) });
  ledgerOf.mockResolvedValue({ byOutcome: new Map(), daysMissing: [] });
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

  it("one campaign (the campaign page): a card per milestone from Start to its Target, counted from the Units its runs produced (ledger)", async () => {
    ledgerOf.mockImplementation(async (id: string) =>
      id === "u-src" ? { byOutcome: new Map([["lead_found", new Map([[day(2), 60], [day(1), 40]])]]), daysMissing: [day(0)] } : { byOutcome: new Map(), daysMissing: [] },
    );
    const res = await request(app).get("/brands/b1/campaign-targets?salesFunnelCampaignId=c2");
    expect(res.status).toBe(200);
    const t = res.body.targets[0];
    expect(t.salesFunnelCampaignId).toBe("c2");
    expect(t.milestones.map((m: { step: string }) => m.step)).toEqual(["lead_found", "conversation"]);
    expect(t.milestones[0]).toMatchObject({ count: 100, countSource: "ledger", costPerUnitUsd: 0.1, conversionToNextPct: 2, lifecycleRung: "lead_found" });
    // A reply no run of the campaign declares: the campaign's own people, said so.
    expect(t.milestones[1]).toMatchObject({ isTarget: true, count: 2, countSource: "campaign_people", costPerUnitUsd: 10, costFromStartUsd: 15 });
    expect(t.targetCountSource).toBe("campaign_people");
    expect(t.ledgerDaysMissing).toEqual([day(0)]);
    expect(t.milestones[1].projection.outcomesPerDay).toBe(t.projection.outcomesPerDay);
    expect((await request(app).get("/brands/b1/campaign-targets?salesFunnelCampaignId=nope")).status).toBe(404);
  });

  // MIGRATE-1105 S5: a pipe whose Engine makes a finer outcome lands its Units under it; its milestone still counts them.
  it("a milestone counts the Units of the finer outcome its pipe's Engine makes, beside its own step's", async () => {
    copies.mockResolvedValue({ pipeSteps: new Map([["p-src", { fromStep: null, toStep: "lead_found", outcome: "lead_found" }], ["p-mail", { fromStep: "lead_found", toStep: "conversation", outcome: "email_sequence_sent" }]]) });
    ledgerOf.mockImplementation(async (id: string) =>
      id === "u-mail"
        ? { byOutcome: new Map([["conversation", new Map([[day(2), 1]])], ["email_sequence_sent", new Map([[day(1), 2]])]]), daysMissing: [] }
        : { byOutcome: new Map(), daysMissing: [] },
    );
    const t = (await request(app).get("/brands/b1/campaign-targets?salesFunnelCampaignId=c1")).body.targets[0];
    expect(t.milestones[1]).toMatchObject({ step: "conversation", count: 3, countSource: "ledger" });
  });

  it("a ledger read that fails leaves every milestone on the campaign's own people", async () => {
    ledgerOf.mockRejectedValue(new Error("runs down"));
    const t = (await request(app).get("/brands/b1/campaign-targets")).body.targets[0];
    expect(t.milestones[1]).toMatchObject({ count: 2, countSource: "campaign_people" });
  });

  it("serves offerTargets: two ongoing campaigns on one Target are ONE entry, no campaign name, the rows per campaign unchanged (TARGET-ROWS-UNIQUE-1107)", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([row("c1", "ongoing"), { ...row("c2", "ongoing"), createdAt: "2026-10-02T00:00:00.000Z" }]);
    const body = (await request(app).get("/brands/b1/campaign-targets")).body;
    expect(body.targets.map((t: { salesFunnelCampaignId: string }) => t.salesFunnelCampaignId)).toEqual(["c1", "c2"]);
    expect(body.offerTargets).toHaveLength(1);
    const e = body.offerTargets[0];
    expect(e).not.toHaveProperty("name");
    expect(e).not.toHaveProperty("milestones");
    expect(e).toMatchObject({ offerId: "o1", target: { key: "conversation" }, salesFunnelCampaignIds: ["c1", "c2"], outcomesToDate: body.targets[0].outcomesToDate * 2, spentUsd: 60 });
    expect(e.costPerOutcomeUsd).toBe(body.targets[0].costPerOutcomeUsd);
    expect(e.projection.outcomesPerDay).toBe(body.targets[0].projection.outcomesPerDay * 2);
  });
});
