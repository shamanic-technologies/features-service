import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { writerSubjectKey } from "../lib/plays.js";

/** PLAN-RECURSIVE-PER-ENGINE-1124: `carried-reask?judge=dry` asks the live judge for each carried row, and stores nothing. */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../middleware/auth.js", () => ({ apiKeyOnly: (_req: unknown, _res: unknown, next: () => void) => next() }));

const verdict = (campaignId: string, outcome: string, over: Record<string, unknown> = {}) => ({ campaignId, outcome, orgId: `org-${campaignId}`, strategyId: null, source: "carried", briefHash: "stored-hash", optionsSignature: null, confidence: null, model: null, carriedFrom: "p", judgedAt: "2026-11-08T00:00:00.000Z", ...over });
let verdicts: Array<ReturnType<typeof verdict>> = [];
const write = vi.fn();
const live = vi.fn();
const ask = vi.fn();
vi.mock("../lib/engine-strategy-io.js", () => ({
  listEngineStrategies: async () => verdicts,
  labelOfOutcome: (o: string) => `Label ${o}`,
  writeEngineStrategy: (...a: unknown[]) => write(...a),
  engineStrategyOfCampaign: (...a: unknown[]) => live(...a),
  askJev: (...a: unknown[]) => ask(...a),
}));
const scripts = [
  { id: "1", outcome: "signup", dynasty: "dy_path", version: 1, description: "Any path", code: "", tactics: {} },
  { id: "2", outcome: "signup", dynasty: "dy_post", version: 1, description: "Through a post", code: "", tactics: {} },
  { id: "3", outcome: "message_sent", dynasty: "dy_sender", version: 1, description: "Sends", code: "", tactics: {} },
];
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({ ...(await orig<object>()), readRunnableScripts: async () => scripts }));
vi.mock("../lib/plays-store.js", () => ({
  loadPlayCatalogue: async () => ({
    tactics: new Map([["post", { id: "post", name: "Works through a post", description: "x", createdBy: "t", createdAt: "2026-11-21", appliesTo: "script", optIn: true }]]),
    strategies: new Map([["through-posts", { id: "through-posts", name: "Through posts", description: "Signups from posts", requiresTacticIds: ["post"], excludesTacticIds: [], createdBy: "t", createdAt: "2026-11-21" }]]),
    tacticsByWriter: new Map(scripts.map((s) => [writerSubjectKey("script", `${s.outcome}/${s.dynasty}`), new Map([["post", s.dynasty === "dy_post"]])])),
  }),
}));
let units: Array<Record<string, unknown>> = [];
const fleet = vi.fn(async () => units);
vi.mock("../lib/fleet-leg-campaigns.js", () => ({ fetchFleetCampaignRows: () => fleet() }));
let briefs: Record<string, string | null> = {};
const campaigns = vi.fn(async (brandId: string, _o: unknown, _who: { orgId: string }) => Object.entries(briefs).filter(([id]) => `b-${id}` === brandId).map(([id, brief]) => ({ id, brief })));
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (b: string, o: unknown, w: { orgId: string }) => campaigns(b, o, w) }));

const { default: routes } = await import("./carried-verdicts.js");
const { CARRIED_DRY_JUDGE_SUPPORT } = await import("../lib/platform-caller.js");
const { briefHashOf } = await import("../lib/engine-strategy.js");
const app = express().use(routes);
const url = "/internal/engine-strategies/carried-reask";
const unit = (id: string, status = "ongoing") => ({ salesFunnelCampaignId: id, orgId: `org-${id}`, brandIds: [`b-${id}`], status });
const picks = (byCampaign: Record<string, string | null | Error>) =>
  ask.mockImplementation(async (state: { brief: string }, options: Array<{ strategyId: string | null }>) => {
    const want = byCampaign[state.brief.replace("brief of ", "")];
    if (want instanceof Error) throw want;
    return { option: options.find((o) => o.strategyId === want)!, confidence: 0.9, model: "m-1" };
  });

beforeEach(() => {
  [write, live, ask, fleet, campaigns].forEach((m) => m.mockClear());
  verdicts = [verdict("c1", "signup"), verdict("c1", "message_sent"), verdict("c2", "signup"), verdict("c3", "signup"), verdict("c4", "signup", { briefHash: briefHashOf("brief of c4") })];
  units = [unit("c1"), unit("c2", "stopped"), unit("c3"), unit("c4")];
  briefs = { c1: "brief of c1", c2: "brief of c2", c3: "  ", c4: "brief of c4" };
});

describe("GET /internal/engine-strategies/carried-reask?judge=dry", () => {
  it("without the parameter: the measured read only, no judge, no campaign-service read, no dryJudge key", async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["carriedCampaigns", "carriedRows", "computedAt", "rows", "unchangedRows", "wouldCallJudgeRows", "wouldReaskCampaigns", "wouldReaskRows"]);
    expect([ask.mock.calls.length, fleet.mock.calls.length, campaigns.mock.calls.length, write.mock.calls.length]).toEqual([0, 0, 0, 0]);
  });

  it("asks the judge for each row that would call it, with the campaign's brief of today, and stores nothing", async () => {
    picks({ c1: "through-posts", c2: null, c4: "through-posts" });
    const res = await request(app).get(`${url}?judge=dry`);
    expect(res.status).toBe(200);
    const d = res.body.dryJudge;
    // message_sent has one option (no call, not asked); c3 states no brief today (no call).
    expect(d.rows.map((r: Record<string, unknown>) => [r.campaignId, r.outcome, r.status, r.changes, r.campaignRunning, r.briefMovedSinceVerdict])).toEqual([
      ["c1", "signup", "judged", true, true, true],
      ["c2", "signup", "judged", false, false, true],
      ["c3", "signup", "no_brief_today", false, true, true],
      ["c4", "signup", "judged", true, true, false],
    ]);
    expect(d.rows[0]).toMatchObject({ orgId: "org-c1", stored: { strategyId: null, name: "No condition" }, dryPick: { strategyId: "through-posts", name: "Through posts" }, confidence: 0.9, model: "m-1", stopsBeingKept: ["dy_path"], startsBeingKept: ["dy_post"], error: null });
    expect([d.stored, d.maxJudgeCalls, d.rowsAsked, d.rowsJudged, d.rowsChanging, d.campaignsChanging, d.runningCampaignsChanging, d.rowsFailed, d.rowsNoBriefToday]).toEqual([false, 100, 4, 3, 2, 2, 2, 0, 1]);
    // The judge is asked as the live read asks it (brief, Engine, scripts, options), under the staff experiment mark.
    expect(ask).toHaveBeenCalledTimes(3);
    const [state, options, support] = ask.mock.calls[0]!;
    expect(state).toMatchObject({ brief: "brief of c1", engine: { outcome: "signup", makes: "Label signup" } });
    expect((options as Array<{ strategyId: string | null }>).map((o) => o.strategyId)).toEqual([null, "through-posts"]);
    expect(support).toBe(CARRIED_DRY_JUDGE_SUPPORT);
    // Each brief is read under its own org, once per brand.
    expect(campaigns.mock.calls.map((c) => [c[0], c[2]])).toEqual(expect.arrayContaining([["b-c1", { orgId: "org-c1" }]]));
    expect(campaigns).toHaveBeenCalledTimes(4);
    // Nothing written, the live read (which stores its verdict) never called; the measured report is unchanged beside it.
    expect([write.mock.calls.length, live.mock.calls.length]).toEqual([0, 0]);
    const plain = (await request(app).get(url)).body;
    expect({ ...res.body, dryJudge: undefined, computedAt: undefined }).toEqual({ ...plain, dryJudge: undefined, computedAt: undefined });
  });

  it("a row whose judge or brief read fails carries its error, never an unchanged verdict; the others are served", async () => {
    picks({ c1: new Error("chat-service platform-judgments 503: down"), c2: "through-posts", c4: null });
    units = units.filter((u) => u.salesFunnelCampaignId !== "c4");
    const d = (await request(app).get(`${url}?judge=dry`)).body.dryJudge;
    expect(d.rows.map((r: Record<string, unknown>) => [r.campaignId, r.status, r.changes, r.dryPick === null, r.campaignRunning])).toEqual([
      ["c1", "failed", null, true, true],
      ["c2", "judged", true, false, false],
      ["c3", "no_brief_today", false, true, true],
      ["c4", "failed", null, true, null],
    ]);
    expect(d.rows[0].error).toBe("chat-service platform-judgments 503: down");
    expect(d.rows[3].error).toMatch(/lists no unit for campaign c4/);
    expect([d.rowsJudged, d.rowsChanging, d.campaignsChanging, d.runningCampaignsChanging, d.rowsFailed]).toEqual([1, 1, 1, 0, 2]);
    expect(write).not.toHaveBeenCalled();
  });

  it("more than 100 rows to judge is refused before the first call; campaignIds narrows the ask", async () => {
    verdicts = Array.from({ length: 101 }, (_, i) => verdict(`k${String(i).padStart(3, "0")}`, "signup"));
    units = verdicts.map((v) => unit(v.campaignId));
    briefs = Object.fromEntries(verdicts.map((v) => [v.campaignId, `brief of ${v.campaignId}`]));
    picks({});
    const over = await request(app).get(`${url}?judge=dry`);
    expect([over.status, over.body.reason, over.body.rowsToJudge, over.body.maxJudgeCalls]).toEqual([422, "too_many_judge_calls", 101, 100]);
    expect([ask.mock.calls.length, fleet.mock.calls.length]).toEqual([0, 0]);
    picks({ k000: "through-posts", k001: null });
    const some = await request(app).get(`${url}?judge=dry&campaignIds=k000,k001`);
    expect([some.status, some.body.dryJudge.rowsAsked, some.body.dryJudge.rowsChanging, some.body.dryJudge.campaignIds, some.body.rows.length]).toEqual([200, 2, 1, ["k000", "k001"], 101]);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("an unknown judge value is a 400, nothing read", async () => {
    const res = await request(app).get(`${url}?judge=live`);
    expect([res.status, res.body.reason, ask.mock.calls.length]).toEqual([400, "judge_unrecognised", 0]);
  });
});
