import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// TPL-STATUS-LIVE-1023: the catalogue by Engine carries each template's status as content-generation states it NOW,
// over the stored Engine build (both views, both bases); the live read asks with the history population's own keys.
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
    const { ENGINE_BUILD_SHAPE } = await import("../lib/research/engine-build.js");
    const measure = { id: "email_sent/lead_found/conversation", engine: "email_sent", startsFrom: null, counts: { key: "conversation", name: "Conversation" }, description: "" };
    const build = JSON.stringify({
      shape: ENGINE_BUILD_SHAPE,
      view: "mature",
      computedAt: "2026-11-16T09:00:00Z",
      costBasis: "user",
      file: { engines: [{ outcome: "email_sent", name: "Email sent", measures: [measure] }] },
      catalog: { engines: [{ outcome: "email_sent", name: "Email sent", measures: [{ ...measure, scripts: [], templates: [row], llms: [] }] }], notCarried: [] },
      performance: null,
      texts: null,
      conclusions: null,
      measuredStudies: null,
      historySources: [{ measureId: measure.id, featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowRows: {} }],
    });
    vi.doMock("../db/index.js", () => ({ db: {}, sql: {} }));
    vi.doMock("../lib/fleet-cell-store.js", () => ({ loadFleetCell: vi.fn(async () => ({ text: build, computedAt: Date.now() })), storeFleetCell: vi.fn(async () => undefined) }));
    vi.doMock("../lib/template-tactics.js", () => ({ readTemplateTactics: vi.fn(async () => null), withTemplateTactics: (rows: unknown[]) => rows }));
    vi.doMock("../lib/catalogue-marks-store.js", () => ({ marksFor: vi.fn(async () => new Map()) }));
    let live: unknown = [{ slug: "cold-reply-client-rep-pitch-blind", head: "v7", versions: ["v7"], status: "deprecated", statusSource: "content_generation", versionStatuses: { v7: "deprecated" } }];
    const readLive = vi.fn(async () => live);
    vi.doMock("../lib/writer-catalogue-client.js", async (orig) => ({ ...(await orig<object>()), readLiveTemplateDynasties: readLive }));
    vi.doMock("./public.js", async (orig) => ({ ...(await orig<object>()), readLegWorkflowRanking: vi.fn(async () => null) }));
    const research = await import("./research.js");
    vi.spyOn(research, "warmResearch").mockResolvedValue(undefined);
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    process.env.FEATURES_SERVICE_API_KEY = "k";
    const app = express().use((await import("./research-engines.js")).default);
    const templateOf = async (q: string) => (await request(app).get(`/internal/research/engines/catalog?${q}`).set("x-api-key", "k")).body.engines[0].measures[0].templates[0];
    for (const q of ["basis=user&view=mature", "basis=user&view=flash", "basis=actual&view=mature", "basis=actual&view=flash"]) {
      const t = await templateOf(q);
      expect([t.status, t.versions[0].status]).toEqual(["deprecated", "deprecated"]);
    }
    expect(readLive).toHaveBeenCalledWith("sales-cold-email-outreach", "lead_found_to_conversation");
    live = "template_dynasties_unreadable";
    expect((await templateOf("basis=user&view=mature")).status).toBe("active");
  }, 30_000);
});
