/**
 * BRIEF-DAILY-CAP-1125 (owner 2026-11-25; framework v10 §6: « Daily caps in the brief become most Units per day at an
 * Engine. … The verdicts are stored on the campaign. »): `GET /internal/script-strategy` serves `mostUnits`, the most
 * Units of the Engine's outcome the campaign's brief allows, judged by Jev in the brief judge's live pass and stored.
 * The real `engineStrategyOfCampaign` and the real `mostUnitsOfCampaign`, with the stores, campaign-service,
 * workflow-service and Jev faked. The fake Jev answers on the Engine it is shown (the test fixture's, never the code's).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.unmock("../lib/brief-most-units-io.js");
const strategies: Record<string, unknown>[] = [];
vi.mock("../lib/engine-answers-store.js", () => ({ persistEngineAnswer: async () => undefined }));
vi.mock("../db/index.js", () => ({
  sql: {},
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => ({ onConflictDoUpdate: async () => void strategies.push(v) }) }),
  },
}));
const caps = new Map<string, Record<string, unknown>>();
const capWrites = vi.fn();
vi.mock("../lib/brief-most-units-store.js", () => ({
  readBriefMostUnits: async (c: string, o: string) => caps.get(`${c}|${o}`) ?? null,
  listBriefMostUnits: async (c: string) => [...caps.values()].filter((r) => r.campaignId === c),
  writeBriefMostUnits: async (row: Record<string, unknown>) => {
    capWrites(row);
    caps.set(`${row.campaignId}|${row.outcome}`, { ...row, judgedAt: "2026-11-25T00:00:00.000Z" });
  },
}));
const unitOf = vi.fn();
vi.mock("../lib/fleet-leg-campaigns.js", () => ({ fetchCampaignPipe: (id: string) => unitOf(id) }));
const funnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => funnelCampaigns(...a) }));
const script = (outcome: string, dynasty: string, description: string) => ({ id: `${dynasty}-id`, outcome, dynasty, version: 1, description, tactics: {}, code: "" });
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/script-catalogue-client.js")>()),
  readRunnableScripts: async () => [
    script("signup", "dy_signup_threads", "Gets signups through posts on Threads: asks the Threads post Engine for one."),
    script("threads_post_published", "dy_threads", "Publishes one post on Threads."),
    script("llm_completion", "dy_llm", "Writes a text with one model."),
  ],
}));
vi.mock("../lib/plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("../lib/plays.js");
  return { loadPlayCatalogue: async () => buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [], writerVerdicts: [] }) };
});
const jev = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => jev(...a) }));

import router from "./script-strategy.js";
import { __resetEngineStrategyForTest } from "../lib/engine-strategy-io.js";
import { BRIEF_MOST_UNITS_SUPPORT } from "../lib/platform-caller.js";

const get = (q: string) => {
  const a = express();
  a.use(router);
  return request(a).get(`/internal/script-strategy${q}`).set("x-api-key", "k");
};
const digit = (d: number) => ({ type: "choice", choice: `n${d}`, confidence: 0.97 });
/** The fake judge: a brief capping Threads posts caps the Engine shown as making Threads posts, and no other. */
const fakeJev = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { state: { brief: string; engine: { outcome: string; makes: string } }; questions: Record<string, unknown>; support: unknown };
  const capped = /at most one Threads post a day/i.test(body.state.brief) && body.state.engine.makes === "Threads post published";
  return {
    ok: true,
    json: async () => ({
      model: "jev-1.13.0",
      answers: { states: { type: "noul", noul: capped ? 0.97 : 0.1 }, per: { type: "choice", choice: "day", confidence: 1 }, d4: digit(0), d3: digit(0), d2: digit(0), d1: digit(0), d0: digit(1) },
    }),
  };
};
const THREADS_BRIEF = "Get signups from founders. Publish at most one Threads post a day.";

beforeEach(() => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  process.env.CHAT_SERVICE_URL = "http://chat";
  process.env.CHAT_SERVICE_API_KEY = "c";
  strategies.length = 0;
  caps.clear();
  capWrites.mockClear();
  __resetEngineStrategyForTest();
  jev.mockReset();
  jev.mockImplementation(fakeJev);
  unitOf.mockResolvedValue({ found: true, featureSlug: null, legKey: null, salesFunnelCampaignId: "sfc-1", orgId: "org-1", brandId: "brand-1" });
  funnelCampaigns.mockResolvedValue([{ id: "sfc-1", brief: THREADS_BRIEF }]);
});

describe("GET /internal/script-strategy serves the most Units the brief allows (BRIEF-DAILY-CAP-1125)", () => {
  it("« Publish at most one Threads post a day »: 1 per day on the Engine making Threads posts, null on the others", async () => {
    const posts = await get("?campaignId=u-1&outcome=threads_post_published");
    expect(posts.status).toBe(200);
    expect(posts.body.mostUnits).toEqual({ units: 1, per: "day", days: 1 });
    expect((await get("?campaignId=u-1&outcome=signup")).body.mostUnits).toBeNull();
    expect((await get("?campaignId=u-1&outcome=llm_completion")).body.mostUnits).toBeNull();
    // One Jev call per Engine, in the live pass, stating whose work it is; the judge sees the brief, the Engine and its scripts.
    expect(jev).toHaveBeenCalledTimes(3);
    const sent = JSON.parse((jev.mock.calls[0]![1] as { body: string }).body);
    expect(jev.mock.calls[0]![0]).toBe("http://chat/internal/platform-judgments");
    expect(sent.support).toEqual(BRIEF_MOST_UNITS_SUPPORT);
    expect(sent.state).toEqual({ brief: THREADS_BRIEF, engine: { outcome: "threads_post_published", makes: "Threads post published", scripts: [{ script: "dy_threads", does: "Publishes one post on Threads." }] } });
    expect(Object.keys(sent.questions)).toEqual(["states", "per", "d4", "d3", "d2", "d1", "d0"]);
    // Stored on the campaign, with the brief it was judged on: the silent Engines too (a judged no cap is not re-asked).
    expect(capWrites.mock.calls.map(([r]) => [r.campaignId, r.outcome, r.units, r.per, typeof r.briefHash])).toEqual([
      ["sfc-1", "threads_post_published", 1, "day", "string"],
      ["sfc-1", "signup", null, null, "string"],
      ["sfc-1", "llm_completion", null, null, "string"],
    ]);
  });

  it("a brief silent on a pace: null, and the answer is otherwise the one a capped brief gets", async () => {
    const capped = await get("?campaignId=u-1&outcome=threads_post_published");
    caps.clear();
    __resetEngineStrategyForTest();
    funnelCampaigns.mockResolvedValue([{ id: "sfc-1", brief: "Get signups from founders." }]);
    const silent = await get("?campaignId=u-1&outcome=threads_post_published");
    expect(silent.status).toBe(200);
    expect(silent.body.mostUnits).toBeNull();
    const { mostUnits: _a, ...rest } = silent.body;
    const { mostUnits: _b, ...cappedRest } = capped.body;
    expect(rest).toEqual(cappedRest);
    expect(rest).toMatchObject({ strategyId: null, keptDynasties: ["dy_threads"], briefAsksTacticIds: [] });
  });

  it("no brief: no Jev call, no cap, nothing stored", async () => {
    funnelCampaigns.mockResolvedValue([{ id: "sfc-1", brief: null }]);
    const r = await get("?campaignId=u-1&outcome=threads_post_published");
    expect([r.status, r.body.mostUnits, r.body.strategySource]).toEqual([200, null, "campaign_engine_empty_brief"]);
    expect(jev).not.toHaveBeenCalled();
    expect(capWrites).not.toHaveBeenCalled();
  });

  it("the stored answer stands while the brief is unchanged; a moved brief is re-asked", async () => {
    await get("?campaignId=u-1&outcome=threads_post_published");
    expect(jev).toHaveBeenCalledTimes(1);
    __resetEngineStrategyForTest();
    expect((await get("?campaignId=u-1&outcome=threads_post_published")).body.mostUnits).toEqual({ units: 1, per: "day", days: 1 });
    expect(jev).toHaveBeenCalledTimes(1);
    __resetEngineStrategyForTest();
    funnelCampaigns.mockResolvedValue([{ id: "sfc-1", brief: "Get signups from founders. Post on Threads as often as it works." }]);
    expect((await get("?campaignId=u-1&outcome=threads_post_published")).body.mostUnits).toBeNull();
    expect(jev).toHaveBeenCalledTimes(2);
  });

  it("Jev unreadable = 502 (fail closed, like the strategy judge), never a silent no cap", async () => {
    jev.mockResolvedValue({ ok: false, status: 503, text: async () => "down" });
    const r = await get("?campaignId=u-1&outcome=threads_post_published");
    expect([r.status, r.body.reason]).toEqual([502, "script_strategy_unreadable"]);
    __resetEngineStrategyForTest();
    jev.mockResolvedValue({ ok: true, json: async () => ({ model: "jev-1.13.0", answers: { states: { type: "noul", noul: 0.9 } } }) });
    expect((await get("?campaignId=u-1&outcome=threads_post_published")).status).toBe(502);
    expect(capWrites).not.toHaveBeenCalled();
  });

  it("a read with no campaign serves no cap and asks nothing", async () => {
    const r = await get("?outcome=threads_post_published");
    expect([r.status, r.body.mostUnits]).toEqual([200, null]);
    expect(jev).not.toHaveBeenCalled();
  });
});
