import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import express from "express";
import request from "supertest";
import router from "./research.js";

// MATURITY-VIEW-1023: every Research read takes `?view=mature|flash` (default mature); anything else is a 400.
describe("research ?view=", () => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  const app = express().use(router);
  for (const path of ["/internal/research/studies", "/internal/research/conclusions"]) {
    it(`${path} refuses an unknown view`, async () => {
      const res = await request(app).get(`${path}?view=both`).set("x-api-key", "k");
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("view_unrecognised");
    });
  }
});

// RESEARCH-NATIVE-ENGINE-1116-P2: a copy stored by the per-population build keeps serving (re-keyed by Engine once),
// rebuilt behind; never a 503 while the first Engine build runs.
describe("research stored per-population copy", () => {
  it("is served re-keyed by Engine and is not current", async () => {
    vi.resetModules();
    const old = JSON.stringify({
      file: { view: "mature", computedAt: "2026-11-16T08:57:00Z", costBasis: "user", pipes: [{ id: "cold-email-positive-reply", channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation" }], outcomes: [], studies: [], unavailable: [] },
      catalog: null,
      texts: null,
    });
    vi.doMock("../db/index.js", () => ({ db: {}, sql: {} }));
    vi.doMock("../lib/fleet-cell-store.js", () => ({
      loadFleetCell: vi.fn(async (k: string) => (k === "research:user:mature" ? { text: old, computedAt: 1 } : null)),
      storeFleetCell: vi.fn(async () => undefined),
    }));
    vi.doMock("../lib/channel-declarations-store.js", async (orig) => ({
      ...(await orig<object>()),
      loadChannelCatalogue: vi.fn(async () => ({ channels: [{ slug: "sales-cold-email-outreach", stepTransitions: [{ legKey: "lead_found_to_conversation", from: { key: "lead_found" }, to: { key: "conversation" }, outcome: "email_sent" }] }] })),
    }));
    const m = await import("./research.js");
    const warm = vi.spyOn(m, "warmResearch").mockResolvedValue(undefined);
    const b = (await m.readResearchBuild("user", "mature"))!;
    expect(b.computedAt).toBe("2026-11-16T08:57:00Z");
    expect(b.file.engines[0]!.measures[0]!.id).toBe("email_sent/lead_found/conversation");
    expect(b.historySources).toMatchObject([{ measureId: "email_sent/lead_found/conversation", featureSlug: "sales-cold-email-outreach" }]);
    expect(m.isCurrentBuild(b, "mature")).toBe(false);
    expect(await m.readResearchBuild("user", "flash")).toBeNull();
    warm.mockRestore();
  });
});
