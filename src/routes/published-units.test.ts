/**
 * OUTCOME-FINEST-1106: the published Units read, hard-coded per outcome. Rows come from the subject's own service filtered
 * on the org + brand; the ledger credits each row's Units.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const assertBrandHeld = vi.fn(async () => undefined);
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: (...a: unknown[]) => assertBrandHeld(...(a as [])), BrandOwnershipError: class BrandOwnershipError extends Error {} }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));
const fetchWithRetry = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

import router from "./published-units.js";
import { __resetPublishedUnits } from "../lib/published-units-io.js";

const app = express().use(router);
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const threadsPost = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: "org-1",
  brandId: "b1",
  accountUsername: "distribute_you_gtm",
  permalink: `https://threads.net/p/${id}`,
  text: `post ${id}`,
  performedBy: "ours",
  outcomeKey: "post_published",
  outcomeRunId: `run-${id}`,
  publishedAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  __resetPublishedUnits();
  for (const [k, v] of Object.entries({ RUNS_SERVICE_URL: "http://runs", RUNS_SERVICE_API_KEY: "k", SOCIAL_SERVICE_URL: "http://social", SOCIAL_SERVICE_API_KEY: "k", META_SERVICE_URL: "http://meta", META_SERVICE_API_KEY: "k", TRANSACTIONAL_EMAIL_SERVICE_URL: "http://te", TRANSACTIONAL_EMAIL_SERVICE_API_KEY: "k" })) process.env[k] = v;
  fetchWithRetry.mockReset();
});

describe("GET /brands/:brandId/published-units/:outcomeKey", () => {
  it("Threads: the brand's own posts (ours and hand posts), views from post metrics, cost and visits from the ledger", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://meta/internal/threads/measurable-posts"))
        return json({ posts: [threadsPost("p1"), threadsPost("p2", { performedBy: "client_team", outcomeKey: "threads_post_published" }), threadsPost("p3", { brandId: "other" })] });
      if (url.startsWith("http://social/internal/post-metrics")) return json({ posts: [{ subjectId: "p1", publishRunId: "run-p1", metrics: { views: 120 }, engagement: 7 }] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "post_published" && q.get("runIds") === "run-p1")
          return json({ occurrences: [{ id: "u1", runId: "run-p1", direction: "produced", outcomeKey: "post_published", subjectService: "meta-service", subjectId: "p1", cost: { grossCents: "50", netCents: "25" }, consumption: null }], nextCursor: null });
        if (q.get("direction") === "consumed" && !q.get("runIds") && q.get("outcomeKey") === "post_published")
          return json({ occurrences: [{ id: "c1", runId: "visit-run", direction: "consumed", outcomeKey: "post_published", subjectService: "meta-service", subjectId: "p1", cost: null, consumption: { sourceOccurrenceId: "u1", consumingOutcomes: [{ outcomeKey: "website_visit" }] } }], nextCursor: null });
        if (q.get("outcomeKey") === "website_visit" && q.get("direction") === "produced")
          return json({ occurrences: [{ id: "w1", runId: "visit-run", direction: "produced", outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "lead-1", cost: null, consumption: null }], nextCursor: null });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/threads_post_published");
    expect(res.status).toBe(200);
    expect(res.body.pricing).toBe("net");
    expect(res.body.rows).toHaveLength(2);
    const p1 = res.body.rows.find((r: { id: string }) => r.id === "p1");
    expect(p1).toMatchObject({ performedBy: "ours", text: "post p1", views: 120, engagements: 7, spentUsd: 0.25, visits: 1, signups: 0 });
    const p2 = res.body.rows.find((r: { id: string }) => r.id === "p2");
    expect(p2).toMatchObject({ performedBy: "client_team", views: null, ledgerUnavailableReason: "not_on_ledger_yet" });
    expect(res.body.learning).toBe(true);
    expect(res.body.costPerSignupUsd).toBeNull();
  });

  it("newsletter: one row per release of the org (a release stating no brand lists on its brands), Units = emails sent", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://te/internal/mailing-list-releases"))
        return json({
          releases: [
            { releaseId: "r1", listSlug: "newsletter", subject: "Hello", orgId: "org-1", brandIds: [], unitsRunId: "units-1", emailsSent: 3, firstSentAt: "2026-11-02T08:00:00.000Z", createdAt: "2026-11-02T07:00:00.000Z" },
            { releaseId: "r2", listSlug: "newsletter", subject: "Other org", orgId: "org-2", brandIds: [], unitsRunId: "units-2", emailsSent: 9, firstSentAt: null, createdAt: "2026-11-02T07:00:00.000Z" },
            { releaseId: "r3", listSlug: "newsletter", subject: "Other brand", orgId: "org-1", brandIds: ["b2"], unitsRunId: null, emailsSent: 9, firstSentAt: null, createdAt: "2026-11-02T07:00:00.000Z" },
          ],
        });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "newsletter_email_sent")
          return json({ occurrences: ["a", "b", "c"].map((s) => ({ id: `u-${s}`, runId: "units-1", direction: "produced", outcomeKey: "newsletter_email_sent", subjectService: "transactional-email-service", subjectId: s, cost: { grossCents: "2", netCents: "1" }, consumption: null })), nextCursor: null });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/newsletter_email_sent?pricing=gross");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ id: "r1", text: "Hello", account: "newsletter", units: 3, performedBy: "ours", spentUsd: 0.06, visits: 0, signups: 0 })]);
    expect(res.body.totals.all.units).toBe(3);
  });

  it("LinkedIn: the brand's connected LinkedIn accounts' posts, hand posts as client_team; X posts stay on the X page", async () => {
    const post = (id: string, platform: string, performedBy: string) => ({ id, platform, orgId: "org-1", brandId: "b1", username: "kevin", externalId: id, text: `t ${id}`, permalink: `https://linkedin.com/feed/${id}`, publishedAt: "2026-11-05T10:00:00.000Z", performedBy, ourSubjectId: null, outcomeKey: `${platform}_post_published`, unitRunId: null, metrics: { views: 10, likes: 2, replies: 1, reposts: null, quotes: null, bookmarks: null } });
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://social/internal/account-posts")) return json({ posts: [post("l1", "linkedin", "client_team"), post("x1", "x", "client_team")] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) return json({ occurrences: [], nextCursor: null });
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/linkedin_post_published");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ id: "l1", performedBy: "client_team", views: 10, engagements: 3, ledgerUnavailableReason: "not_on_ledger_yet" })]);
  });

  it("refuses an outcome it does not serve, and a foreign brand", async () => {
    expect((await request(app).get("/brands/b1/published-units/post_published")).status).toBe(400);
    expect((await request(app).get("/brands/b1/published-units/x_post_published?pricing=vendor")).status).toBe(400);
  });
});
