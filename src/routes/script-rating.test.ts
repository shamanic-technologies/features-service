import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * SCRIPT-VALUE-RATING-1113: the staff read and the pick through the real routes and the real rule; only the producer
 * reads are mocked. The chains are the shape prod serves (runs-service outcome chains, 2026-11-13).
 */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
process.env.FEATURES_SERVICE_API_KEY = "k";

const step = (fromOutcome: string, toOutcome: string, consumedUnits: number, ledUnits: number) => ({ fromOutcome, toOutcome, consumedUnits, ledUnits, share: ledUnits / consumedUnits, ledUnitsByPerformer: {} });
const group = (scriptDynasty: string, runs: number, reachedOutcomes: string[], cents?: string) => ({ scriptDynasty, day: "2026-11-10", producedOutcomes: ["message_written"], reachedOutcomes, runs, ...(cents === undefined ? {} : { costInUsdCents: cents }) });
let rates: unknown;
let reach: unknown;
let ledgerDown = false;
vi.mock("../lib/runs-ledger-read.js", () => ({
  readRunsLedgerJson: async (path: string) => {
    if (ledgerDown) throw new Error("runs-service 503");
    return path.includes("step-rates") ? rates : reach;
  },
}));
vi.mock("../lib/outcome-cost-totals-client.js", () => ({ FLEET_LEDGER_HOLD_MS: 0 }));
vi.mock("../lib/offer-lifetime-revenue.js", () => ({ offerLifetimeRevenue: async () => ({ usd: 2100, source: "fleet_median" }) }));
vi.mock("../lib/script-catalogue-client.js", () => ({
  scriptDynastyKey: (s: { outcome: string; dynasty: string }) => `${s.outcome}/${s.dynasty}`,
  readRunnableScripts: async () => [
    { outcome: "message_written", dynasty: "flash_lite" },
    { outcome: "message_written", dynasty: "haiku" },
  ],
}));
vi.mock("./agent-catalogue.js", () => ({
  loadCatalogueModelForLifetimeRevenue: async () => ({ steps: new Map([["meeting_booked", { valueUsd: 420 }], ["conversation", { valueUsd: 50 }], ["lead_found", { valueUsd: null }]]) }),
}));

const { default: routes } = await import("./script-rating.js");
const app = express().use(routes);
const key = { "x-api-key": "k" };

beforeEach(() => {
  ledgerDown = false;
  rates = { builtAt: "2026-11-13T16:40:37.347Z", brandId: null, consumed: [], steps: [step("message_written", "message_sent", 1000, 990), step("message_sent", "conversation", 1000, 15), step("conversation", "meeting_booked", 100, 30), step("meeting_booked", "meeting_attended", 5, 4)] };
  reach = {
    builtAt: "2026-11-13T16:40:37.347Z",
    brandId: null,
    groupBy: "dynasty",
    groups: [group("message_written/flash_lite", 496, ["message_sent"], "99.2"), group("message_written/flash_lite", 4, ["conversation", "message_sent"], "0.8"), group("old_outcome/haiku", 488, ["message_sent"], "195.2"), group("message_written/haiku", 12, ["conversation", "message_sent"], "4.8")],
  };
});

describe("GET /internal/script-ratings", () => {
  it("values flow from the lifetime revenue through measured steps, a step too thin to measure takes the declared value", async () => {
    const res = await request(app).get("/internal/script-ratings").set(key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ builtAt: "2026-11-13T16:40:37.347Z", lifetimeRevenueUsd: 2100, lifetimeRevenueSource: "fleet_median" });
    const v = new Map<string, { valueUsd: number; source: string }>(res.body.values.map((x: { outcome: string }) => [x.outcome, x]));
    expect(v.get("paid_client")).toMatchObject({ valueUsd: 2100, source: "anchor" });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 420, source: "declared" });
    expect(v.get("conversation")).toMatchObject({ valueUsd: 126, source: "measured" });
    expect(v.get("message_sent")!.valueUsd).toBeCloseTo(1.89, 6);
  });

  it("the dearer writer that brings three times the replies ranks first; a re-homed script keeps its runs", async () => {
    const res = await request(app).get("/internal/script-ratings").set(key);
    expect(res.body.scripts.map((s: { scriptDynasty: string }) => s.scriptDynasty)).toEqual(["message_written/haiku", "message_written/flash_lite"]);
    expect(res.body.scripts[0]).toMatchObject({ runs: 500, spentUsd: 2, costPerRunUsd: 0.004 });
    expect(Math.round(res.body.scripts[0].valuePerDollar)).toBe(749);
    expect(Math.round(res.body.scripts[1].valuePerDollar)).toBe(506);
  });

  it("a ledger that does not serve the spend yet: rated on value, no value per dollar, said why", async () => {
    reach = { builtAt: "x", groups: [group("message_written/haiku", 12, ["conversation", "message_sent"])] };
    const res = await request(app).get("/internal/script-ratings").set(key);
    expect(res.body.scripts[0]).toMatchObject({ spentUsd: null, valuePerDollar: null, valuePerDollarUnavailableReason: "spend_not_served" });
  });

  it("an unreadable ledger is a 502, never an empty rating", async () => {
    ledgerDown = true;
    const res = await request(app).get("/internal/script-ratings").set(key);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("script_rating_unreadable");
  });

  it("a malformed body is a 502 too", async () => {
    reach = { builtAt: "x", groups: [{ scriptDynasty: "a/b", day: "d", producedOutcomes: [], reachedOutcomes: [], runs: 1, costInUsdCents: "abc" }] };
    expect((await request(app).get("/internal/script-ratings").set(key)).status).toBe(502);
  });

  it("needs the key", async () => {
    expect((await request(app).get("/internal/script-ratings")).status).toBe(401);
  });
});

describe("GET /internal/script-pick", () => {
  it("answers one of the caller's candidates, with every candidate's score", async () => {
    const res = await request(app).get("/internal/script-pick?outcome=message_written&dynasties=message_written/haiku,message_written/flash_lite").set(key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "message_written", basis: "value_per_dollar", builtAt: expect.any(String) });
    expect(["message_written/haiku", "message_written/flash_lite"]).toContain(res.body.scriptDynasty);
    expect(res.body.candidates).toHaveLength(2);
  });

  it.each([["no outcome", "?dynasties=a/b"], ["no candidate", "?outcome=message_written"], ["a candidate of another Engine", "?outcome=message_written&dynasties=email_sent/x"]])("refuses %s", async (_l, q) => {
    const res = await request(app).get(`/internal/script-pick${q}`).set(key);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("script_pick_unrecognised");
  });

  it("an unreadable ledger is a 502: the caller picks nothing on a guess", async () => {
    ledgerDown = true;
    expect((await request(app).get("/internal/script-pick?outcome=message_written&dynasties=message_written/haiku").set(key)).status).toBe(502);
  });
});
