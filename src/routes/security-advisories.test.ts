import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { StoredAdvisoryRow, SecurityAdvisoryRepoReport } from "../lib/security-advisories.js";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// In-memory store with the real store's contract: writing a day REPLACES that day.
const mem = vi.hoisted(() => ({ rows: [] as StoredAdvisoryRow[] }));
vi.mock("../lib/security-advisories-store.js", () => ({
  replaceSecurityAdvisoryDay: vi.fn(async (day: string, repos: SecurityAdvisoryRepoReport[], now: Date) => {
    mem.rows = mem.rows.filter((r) => r.day !== day);
    for (const r of repos)
      mem.rows.push({
        day,
        repo: r.repo,
        critical: r.critical ?? null,
        high: r.high ?? null,
        moderate: r.moderate ?? null,
        low: r.low ?? null,
        packages: r.packages,
        error: r.error ?? null,
        reportedAt: now,
      });
  }),
  readSecurityAdvisoryRows: vi.fn(async (sinceDay: string) => {
    const latest = mem.rows.reduce<string | null>((m, r) => (m == null || r.day > m ? r.day : m), null);
    return mem.rows.filter((r) => r.day >= sinceDay || r.day === latest);
  }),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: router } = await import("./security-advisories.js");
const app = express().use(express.json()).use(router);
const KEY = { "x-api-key": "test-key" };

beforeEach(() => {
  mem.rows = [];
});

describe("security advisories routes", () => {
  it("refuses a call without the service key", async () => {
    expect((await request(app).get("/internal/security-advisories")).status).toBe(401);
    expect((await request(app).post("/internal/security-advisories/reports").send({ repos: [] })).status).toBe(401);
  });

  it("400s an invalid body or window", async () => {
    const bad = await request(app).post("/internal/security-advisories/reports").set(KEY).send({ repos: [{ repo: "a" }] });
    expect(bad.status).toBe(400);
    expect((await request(app).get("/internal/security-advisories?days=0").set(KEY)).status).toBe(400);
    expect((await request(app).get("/internal/security-advisories?days=abc").set(KEY)).status).toBe(400);
  });

  it("is red before any report arrives", async () => {
    const res = await request(app).get("/internal/security-advisories").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("red");
    expect(res.body.reason).toBe("No security audit report has arrived yet.");
    expect(res.body.windowDays).toBe(30);
    expect(res.body.days).toHaveLength(30);
  });

  it("stores a report, serves it, and a re-send of the same day overwrites it", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const first = await request(app)
      .post("/internal/security-advisories/reports")
      .set(KEY)
      .send({
        day,
        repos: [
          { repo: "api-service", critical: 1, high: 0, moderate: 2, low: 0, packages: ["next"] },
          { repo: "crm-service", error: "audit endpoint 503" },
        ],
      });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ day, repoCount: 2 });

    let res = await request(app).get("/internal/security-advisories?days=7").set(KEY);
    expect(res.body.status).toBe("red");
    expect(res.body.redRepos.map((r: { repo: string }) => r.repo)).toEqual(["api-service", "crm-service"]);
    expect(res.body.repos[0].series).toHaveLength(7);

    await request(app)
      .post("/internal/security-advisories/reports")
      .set(KEY)
      .send({ day, repos: [{ repo: "api-service", critical: 0, high: 0, moderate: 2, low: 0 }] });
    res = await request(app).get("/internal/security-advisories?days=7").set(KEY);
    expect(res.body.status).toBe("green");
    expect(res.body.redRepos).toEqual([]);
    expect(res.body.repos.map((r: { repo: string }) => r.repo)).toEqual(["api-service"]);
    expect(mem.rows).toHaveLength(1);
  });

  it("defaults the day to today (UTC)", async () => {
    const res = await request(app)
      .post("/internal/security-advisories/reports")
      .set(KEY)
      .send({ repos: [{ repo: "a", critical: 0, high: 0, moderate: 0, low: 0 }] });
    expect(res.body.day).toBe(new Date().toISOString().slice(0, 10));
  });
});
