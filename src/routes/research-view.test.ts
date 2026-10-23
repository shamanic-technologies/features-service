import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import express from "express";
import request from "supertest";
import router from "./research.js";

// MATURITY-VIEW-1023: every Research read takes `?view=mature|flash` (default mature); anything else is a 400.
describe("research ?view=", () => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  const app = express().use(router);
  for (const path of ["/internal/research", "/internal/research/catalog", "/internal/research/performance", "/internal/research/studies", "/internal/research/conclusions"]) {
    it(`${path} refuses an unknown view`, async () => {
      const res = await request(app).get(`${path}?view=both`).set("x-api-key", "k");
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("view_unrecognised");
    });
  }
});

// The mature view's first read after the deploy serves the copy stored before the views, never a 503 while builds run.
describe("research view fallback", () => {
  it("the mature view falls back to the legacy stored copy; the flash view does not", async () => {
    vi.resetModules();
    const legacy = JSON.stringify({ file: { computedAt: "2026-10-23T11:00:00Z", costBasis: "user" }, catalog: null, texts: null });
    vi.doMock("../db/index.js", () => ({ db: {}, sql: {} }));
    vi.doMock("../lib/fleet-cell-store.js", () => ({
      loadFleetCell: vi.fn(async (k: string) => (k === "research:user" ? { text: legacy, computedAt: 1 } : null)),
      storeFleetCell: vi.fn(async () => undefined),
    }));
    const m = await import("./research.js");
    const warm = vi.spyOn(m, "warmResearch").mockResolvedValue(undefined);
    expect((await m.readResearchBuild("user", "mature"))?.file.computedAt).toBe("2026-10-23T11:00:00Z");
    expect(await m.readResearchBuild("user", "flash")).toBeNull();
    warm.mockRestore();
  });
});
