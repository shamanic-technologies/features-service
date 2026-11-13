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
vi.mock("./research.js", () => ({
  readResearch: vi.fn(async () => (built ? FILE : null)),
  servedResearchFile: vi.fn(async () => (built ? { ...FILE, freshness: { stale: false } } : null)),
  servedResearchCatalog: vi.fn(async () => (built ? { "cold-email-positive-reply": { workflows: [{ key: "hunor", label: "Hunor", wroteWith: null, writesWithNow: null }], templates: [], models: [] } } : null)),
  servedResearchPerformance: vi.fn(async () => (built ? { computedAt: "t", costBasis: "user", view: "mature", pipes: { "cold-email-positive-reply": { pipe: "x", rows: [], totals: null, series: null } } } : null)),
}));
vi.mock("./public.js", () => ({
  servedLegWorkflowRanking: vi.fn(async () => ({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", computedAt: "t", rows: [{ rank: 1, workflowDynastySlug: "hunor" }] })),
}));
vi.mock("../lib/channel-declarations-store.js", () => ({
  loadChannelCatalogue: vi.fn(async () => ({
    channels: [{ slug: "sales-cold-email-outreach", stepTransitions: [{ legKey: "lead_found_to_conversation", from: { key: "lead_found" }, to: { key: "conversation" }, outcome: "email_sent" }] }],
  })),
}));

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

  it("catalogue, performance, live scripts", async () => {
    const cat = await get("/internal/research/engines/catalog");
    expect(cat.body.engines[0].measures[0].scripts[0]).toMatchObject({ key: "hunor", tactics: { llm: null, template: null } });
    const perf = await get("/internal/research/engines/performance?view=flash");
    expect(perf.status).toBe(200);
    expect(sourceWordsLeft(perf.body)).toEqual([]);
    const live = await get("/internal/research/engines/live-scripts?measure=email_sent/lead_found/conversation");
    expect(live.body.rows).toEqual([{ rank: 1, scriptDynastySlug: "hunor" }]);
    expect(sourceWordsLeft(live.body)).toEqual([]);
  });

  it("refuses unknown params and an unknown measure; 503 before the first build", async () => {
    expect((await get("/internal/research/engines?view=both")).body.reason).toBe("view_unrecognised");
    expect((await get("/internal/research/engines/catalog?basis=x")).body.reason).toBe("basis_unrecognised");
    expect((await get("/internal/research/engines/live-scripts?measure=nope")).status).toBe(404);
    expect((await get("/internal/research/engines/live-scripts?measure=a&pricing=x")).body.reason).toBe("pricing_unrecognised");
    built = false;
    expect((await get("/internal/research/engines/performance")).status).toBe(503);
    built = true;
  });
});
