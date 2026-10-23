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
