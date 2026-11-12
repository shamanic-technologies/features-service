import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * LLM-RATING-PER-ENGINE-1112: the pick and the staff read through the real routes and the real Rating; only the stores
 * and the producer reads are mocked. The evidence = prod's X post history (Fable wrote, Sonnet researched).
 */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
process.env.FEATURES_SERVICE_API_KEY = "k";

const recorded: Array<Record<string, unknown>> = [];
const rules = [{ outcome: "*", allowed: null, excluded: ["claude-fable", "claude-opus"], decidedBy: "owner", note: null, decidedAt: "2026-11-12T00:00:00Z" }];
vi.mock("../lib/engine-llm-store.js", () => ({
  listUniverseRules: async () => rules,
  listLlmPicks: async () => [],
  recordLlmPick: async (p: Record<string, unknown>) => void recorded.push(p),
  putUniverseRule: async (r: Record<string, unknown>) => ({ ...r, decidedAt: "2026-11-12T10:00:00Z" }),
}));
vi.mock("../lib/llm-dynasties.js", () => ({
  readLlmDynasties: async () => [
    { slug: "claude-fable", name: "Claude Fable", provider: "anthropic", servedToday: true },
    { slug: "claude-opus", name: "Claude Opus", provider: "anthropic", servedToday: true },
    { slug: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", servedToday: true },
    { slug: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek", servedToday: true },
  ],
}));
vi.mock("../lib/vendor-credit-client.js", () => ({ readOutOfCreditProvidersSoft: async () => new Set<string>() }));
vi.mock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: async () => null, claimFleetCellBuild: async () => false, storeFleetCell: async () => undefined }));

const { llmEvidence } = await import("../lib/engine-llm-rating.js");
const { __resetEngineLlmEvidenceForTest } = await import("../lib/engine-llm-rating-io.js");
const { default: router } = await import("./engine-llm-rating.js");
const app = express().use(express.json()).use(router);

function seed() {
  const calls = [];
  for (let i = 0; i < 26; i++) {
    calls.push({ callRunId: `w${i}`, rootRunId: `r${i}`, day: "2026-11-08", outcome: "x_post_published", llmDynastySlug: "claude-fable", spentUsd: 0.07, support: false });
    calls.push({ callRunId: `a${i}`, rootRunId: `r${i}`, day: "2026-11-08", outcome: "x_post_published", llmDynastySlug: "claude-sonnet", spentUsd: 0.03, support: false });
  }
  const evidence = [...llmEvidence(calls, () => 1, []).values()];
  __resetEngineLlmEvidenceForTest({ computedAt: new Date().toISOString(), evidence, counts: { calls: 52, callsWithNoEngine: 0, decisionsAwaitingUnits: 0, supportCalls: 0, lastCallAt: null } });
}

beforeEach(() => {
  recorded.length = 0;
  seed();
});

describe("GET /internal/llm-pick", () => {
  it("never answers Fable or Opus, records the pick with its run and place", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get("/internal/llm-pick?outcome=x_post_published&place=writer&campaignId=c1").set("x-api-key", "k").set("x-run-id", `run-${i}`);
      expect(res.status).toBe(200);
      expect(["claude-sonnet", "deepseek-flash"]).toContain(res.body.llm.llmDynastySlug);
      expect(res.body.llm.model).toBe(res.body.llm.llmDynastySlug);
    }
    expect(recorded[0]).toMatchObject({ outcome: "x_post_published", place: "writer", runId: "run-0", campaignId: "c1" });
  });
  it("400 without outcome and place", async () => {
    expect((await request(app).get("/internal/llm-pick?outcome=x").set("x-api-key", "k")).status).toBe(400);
  });
});

describe("GET /internal/research/engine-llms", () => {
  it("lists the allowed LLMs ranked and the past ones outside the universe with their calls and $", async () => {
    const res = await request(app).get("/internal/research/engine-llms").set("x-api-key", "k");
    expect(res.status).toBe(200);
    const x = res.body.engines.find((e: { outcome: string }) => e.outcome === "x_post_published");
    expect(x.name).toBe("X post published");
    expect(x.universe).toMatchObject({ source: "fleet", allowed: ["claude-sonnet", "deepseek-flash"] });
    expect(x.llms.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
    expect(["claude-sonnet", "deepseek-flash"]).toContain(x.favourite.llmDynastySlug);
    const fable = x.outsideUniverse.find((r: { llmDynastySlug: string }) => r.llmDynastySlug === "claude-fable");
    expect(fable).toMatchObject({ calls: 26, outcomes: 26, rank: null });
    expect(fable.spentUsdToDate).toBeCloseTo(1.82, 6);
    expect(x.llms.find((r: { llmDynastySlug: string }) => r.llmDynastySlug === "claude-sonnet").calls).toBe(26);
  });
});

describe("PUT /internal/engine-llm-universes", () => {
  it("refuses an unknown LLM dynasty", async () => {
    const res = await request(app).put("/internal/engine-llm-universes").set("x-api-key", "k").send({ outcome: "backlink_earned", allowed: ["gpt-9"], excluded: [], decidedBy: "staff" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("llm_dynasty_unknown");
  });
  it("stores an Engine's own list", async () => {
    const res = await request(app).put("/internal/engine-llm-universes").set("x-api-key", "k").send({ outcome: "backlink_earned", allowed: ["claude-sonnet"], excluded: [], decidedBy: "staff" });
    expect(res.status).toBe(200);
    expect(res.body.allowed).toEqual(["claude-sonnet"]);
  });
});
