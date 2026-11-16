import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const FILE = {
  computedAt: "2026-11-14T00:00:00Z",
  costBasis: "user",
  pipes: [{ id: "cold-email-positive-reply", channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation", outcome: "Positive reply", description: "" }],
  outcomes: [{ id: "positive-reply", pipes: ["cold-email-positive-reply"] }],
  studies: [{ id: "cold-email-positive-reply-workflow-roi", pipe: "cold-email-positive-reply", topic: "workflow", question: "Which workflow?" }],
  unavailable: [],
};
let built = true;
vi.mock("./research.js", async () => {
  const { engineResearchBuildOf } = await import("../lib/research/engine-build.js");
  const name = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");
  const sources = [{ sourceId: "cold-email-positive-reply", engine: "email_sent", startsFrom: "lead_found", counts: "conversation", channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation" }];
  let BUILD: ReturnType<typeof engineResearchBuildOf> | null = null;
  const make = () => engineResearchBuildOf(
    {
      file: { ...FILE, costBasis: "actual" } as never,
      catalog: { "cold-email-positive-reply": { workflows: [{ key: "hunor", label: "Hunor", wroteWith: null, writesWithNow: null }], templates: [], models: [] } } as never,
      texts: null,
      performance: { "cold-email-positive-reply": { pipe: "x", rows: [], totals: null, series: null } } as never,
    },
    sources,
    name,
  );
  return {
    readResearchBuild: vi.fn(async () => (built ? (BUILD ??= make()) : null)),
    researchFreshnessOf: vi.fn(() => ({ stale: false })),
  };
});
vi.mock("./public.js", () => ({
  readLegWorkflowRanking: vi.fn(async () => null),
}));
vi.mock("../lib/catalogue-marks-store.js", () => ({ marksFor: vi.fn(async () => new Map()) }));
vi.mock("../lib/writer-catalogue-client.js", () => ({ readLiveTemplateDynasties: vi.fn(async () => null) }));
vi.mock("../lib/template-tactics.js", () => ({ readTemplateTactics: vi.fn(async () => null), withTemplateTactics: (rows: unknown[]) => rows }));

import express from "express";
import request from "supertest";
import router from "./research-engines.js";
import { sourceWordsLeft } from "../lib/research/by-engine.js";

// RESEARCH-BY-ENGINE-1113: the Engine-keyed twins of the Research reads.
describe("research by Engine routes", () => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  const app = express().use(router);
  const get = (p: string) => request(app).get(p).set("x-api-key", "k");

  it("the file: studies on their Engine + measure, no source word", async () => {
    const res = await get("/internal/research/engines");
    expect(res.status).toBe(200);
    expect(res.body.engines).toEqual([{ outcome: "email_sent", name: "Email sent", measures: [expect.objectContaining({ id: "email_sent/lead_found/conversation" })] }]);
    expect(res.body.studies[0]).toMatchObject({ id: "email_sent/lead_found/conversation:script-roi", engine: "email_sent", topic: "script" });
    expect(sourceWordsLeft(res.body)).toEqual([]);
  });

  it("catalogue, performance", async () => {
    const cat = await get("/internal/research/engines/catalog");
    expect(cat.body.engines[0].measures[0].scripts[0]).toMatchObject({ key: "hunor", tactics: { llm: null, template: null } });
    const perf = await get("/internal/research/engines/performance?view=flash");
    expect(perf.status).toBe(200);
    expect(sourceWordsLeft(perf.body)).toEqual([]);
  });

  it("performance: the Engine's scripts that ran lead the measure, measured on the ledger (RESEARCH-PERF-SCRIPTS-1116)", async () => {
    const { loadDailyLedgerBook } = await import("../lib/ledger-book.js");
    vi.mocked(loadDailyLedgerBook).mockResolvedValueOnce({
      book: { produced: [{ outcomeKey: "message_sent", campaignId: "c1", workflowSlug: null, occurrences: 10, costUsd: 2, runStartDay: "2026-11-10", scriptSlug: "email_sent/dy_a/v1" }], noOutput: [], consumed: [] },
      daysMissing: 0,
      missingDays: [],
    });
    const perf = await get("/internal/research/engines/performance?view=flash");
    const m = perf.body.engines[0].measures[0];
    expect(m.rows[0]).toMatchObject({ key: "email_sent/dy_a", era: "scripts", status: "deprecated", spentUsd: { value: 2 }, untested: false });
    expect(m).toMatchObject({ scriptsUnavailableReason: null, totals: { spentUsd: { value: 2 } } });
    expect(sourceWordsLeft(perf.body)).toEqual([]);
  });

  it("refuses unknown params; 503 before the first build", async () => {
    expect((await get("/internal/research/engines?view=both")).body.reason).toBe("view_unrecognised");
    expect((await get("/internal/research/engines/catalog?basis=x")).body.reason).toBe("basis_unrecognised");
    // RESEARCH-NATIVE-ENGINE-1116-P3: the retired workflow ranking read is deleted, never stubbed.
    expect((await get("/internal/research/engines/live-scripts?measure=email_sent/lead_found/conversation")).status).toBe(404);
    built = false;
    expect((await get("/internal/research/engines/performance")).status).toBe(503);
    built = true;
  });
});
