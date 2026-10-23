import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// TPL-STATUS-LIVE-1023: the catalogue read serves each template's status as content-generation states it NOW, over the
// stored build (both views, both bases).
describe("research catalogue template status is live", () => {
  it("a template deprecated after the build reads deprecated on the next read; unreadable keeps the build's", async () => {
    vi.resetModules();
    const row = {
      key: "cold-reply-client-rep-pitch-blind",
      label: "Client Rep Pitch",
      dynasty: { slug: "cold-reply-client-rep-pitch-blind", name: "Client Rep Pitch", description: "", signature: null, identity: "blind", head: { key: "v7", label: "v7" } },
      status: "active",
      statusSource: "content_generation",
      statusUnavailableReason: null,
      versions: [{ key: "v7", label: "v7", head: true, status: "active" }],
      sample: "1 positive reply · 10 emails",
    };
    const build = JSON.stringify({
      file: { computedAt: "2026-10-23T16:40:00Z", costBasis: "user", pipes: [{ id: "cold-email-positive-reply", channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation" }] },
      catalog: { "cold-email-positive-reply": { workflows: [], templates: [row], models: [] }, "cold-email-website-visit": { workflows: [], templates: [], models: [] } },
      texts: null,
    });
    vi.doMock("../db/index.js", () => ({ db: {}, sql: {} }));
    vi.doMock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: vi.fn(async () => ({ text: build, computedAt: Date.now() })), storeFleetCell: vi.fn(async () => undefined) }));
    vi.doMock("../lib/template-tactics.js", () => ({ readTemplateTactics: vi.fn(async () => null), withTemplateTactics: (rows: unknown[]) => rows }));
    vi.doMock("../lib/catalogue-mark-serving.js", () => ({ withResearchCatalogMarks: async (c: unknown) => c, withPerformanceMarks: async (p: unknown) => p }));
    let live: unknown = [{ slug: "cold-reply-client-rep-pitch-blind", head: "v7", versions: ["v7"], status: "deprecated", statusSource: "content_generation", versionStatuses: { v7: "deprecated" } }];
    const readLive = vi.fn(async () => live);
    vi.doMock("../lib/writer-catalogue-client.js", async (orig) => ({ ...(await orig<object>()), readLiveTemplateDynasties: readLive }));
    vi.doMock("./public.js", async (orig) => ({ ...(await orig<object>()), readLegWorkflowRanking: vi.fn(async () => null) }));
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const m = await import("./research.js");
    process.env.FEATURES_SERVICE_API_KEY = "k";
    const app = express().use(m.default);
    for (const q of ["", "?view=flash", "?basis=actual", "?basis=actual&view=flash"]) {
      const res = await request(app).get(`/internal/research/catalog${q}`).set("x-api-key", "k");
      expect(res.status).toBe(200);
      const t = res.body["cold-email-positive-reply"].templates[0];
      expect([t.status, t.versions[0].status]).toEqual(["deprecated", "deprecated"]);
    }
    expect(readLive).toHaveBeenCalledWith("sales-cold-email-outreach", "lead_found_to_conversation");
    live = "template_dynasties_unreadable";
    const res = await request(app).get("/internal/research/catalog").set("x-api-key", "k");
    expect(res.status).toBe(200);
    expect(res.body["cold-email-positive-reply"].templates[0].status).toBe("active");
  }, 30_000);
});
