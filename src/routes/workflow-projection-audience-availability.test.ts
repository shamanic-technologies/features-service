/**
 * A CAMPAIGN PICKS AN AUDIENCE FOR A SERVE OFF THESE ROWS — so each audience row states how many people
 * human-service says it can still be served (features-service#1035).
 *
 * Over 96h (2026-09-20 → 09-24) human-service logged 15,413 `serve_next status=exhausted` against 342
 * served, 97.8% on three audiences of one brand that human-service already reported as served out
 * (`availableToContactCount: 0`). The rows enumerated them like any other audience, so the only way a
 * picker learned an audience was dry was to spend a serve on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));

vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
// These suites pin the grains on email-gateway counts alone: the person-grain reply set is not read,
// so every grain reads what it always did (the person basis is guarded in crm-only-repliers.test.ts).
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(async () => undefined),
}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

// The brand's declared conversation-funnel rates, as brand-service serves them.
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 50,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const V2M = ECONOMICS.visitToMeetingPct / 100;
const R2M = ECONOMICS.replyToMeetingPct / 100;

function wf(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "id", workflowSlug: "wf", workflowName: "WF", workflowDynastyName: "Dyn", workflowDynastySlug: "dyn", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null, ...over };
}

// ── PROD-SHAPED evidence (brand 75d7e3e8…, sales-cold-email-outreach, 2026-08-25) ────────────────
// Three dynasties with real history: the measured leader, a zero-reply husk, the heavy spender.
const MEASURED = [
  { dyn: "ballad", crossCents: 39610, crossContacted: 1143, crossReplies: 4, brandCents: 26996, brandContacted: 761, brandReplies: 4 },
  { dyn: "moraine", crossCents: 8466, crossContacted: 314, crossReplies: 0, brandCents: 3093, brandContacted: 155, brandReplies: 0 },
  { dyn: "lithium", crossCents: 169361, crossContacted: 7045, crossReplies: 16, brandCents: 121255, brandContacted: 4009, brandReplies: 10 },
];
// The workflows created on 15-16 August: active, and nothing anywhere has ever spent on them.
const UNPROVEN = ["cinder", "bramble"];
// A retired lineage with no history either — it must stay unreachable.
const RETIRED = "obsidian";

const MEASURED_WORKFLOWS = MEASURED.map((m) => wf({ id: `id-${m.dyn}`, workflowSlug: `wf-${m.dyn}`, workflowDynastySlug: m.dyn, workflowDynastyName: m.dyn }));
const WORKFLOWS = [
  ...MEASURED_WORKFLOWS,
  ...UNPROVEN.map((d) => wf({ id: `id-${d}`, workflowSlug: `wf-${d}`, workflowDynastySlug: d, workflowDynastyName: d })),
  wf({ id: `id-${RETIRED}`, workflowSlug: `wf-${RETIRED}`, workflowDynastySlug: RETIRED, workflowDynastyName: RETIRED, status: "deprecated" }),
];

// Prod 2026-09-26, brand 75d7e3e8…: `f703c236` served out (0 left) beside `68d1aa78` (6,153 left),
// and one audience whose count human-service does not state.
const AUDIENCES = [
  { id: "aud-dry", availableToContactCount: 0 },
  { id: "aud-full", availableToContactCount: 6153 },
  { id: "aud-unstated" },
];

const costGroup = (slug: string, cents: number) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null });
const emailGroup = (slug: string, contacted: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked: 0, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

const CROSS_COST = MEASURED.map((m) => costGroup(`wf-${m.dyn}`, m.crossCents));
const CROSS_EMAIL = MEASURED.map((m) => emailGroup(`wf-${m.dyn}`, m.crossContacted, m.crossReplies));
const BRAND_COST = MEASURED.map((m) => costGroup(`wf-${m.dyn}`, m.brandCents));
const BRAND_EMAIL = MEASURED.map((m) => emailGroup(`wf-${m.dyn}`, m.brandContacted, m.brandReplies));

function mockFetch(opts: { audiencesFail?: boolean; audiencesAfterFirst?: unknown[] } = {}): void {
  let audienceReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: CROSS_COST });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: BRAND_COST });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      return json({ groups: BRAND_EMAIL });
    }
    if (url.includes("/public/stats")) return json({ groups: CROSS_EMAIL });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      audienceReads += 1;
      // The evidence compute's read succeeds; the LIVE availability read (the second) is the one that fails.
      if (opts.audiencesFail && audienceReads > 1) return new Response("boom", { status: 500 });
      return json({ audiences: AUDIENCES });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";
const QUERY = "brandId=75d7e3e8-6926-4f85-a557-976895400666&goal=meetingBooked";

describe("workflow-projection: each audience row states how many people it can still be served (#1035)", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("a served-out audience reads 0 while its neighbour reads what is left — on every workflow's row", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    expect(res.status).toBe(200);
    const audienceRows = res.body.rows.filter((r: any) => r.audienceId !== null);
    expect(audienceRows.length).toBeGreaterThan(0);
    for (const r of audienceRows) {
      const expected = r.audienceId === "aud-dry" ? 0 : r.audienceId === "aud-full" ? 6153 : null;
      expect(r.availableToContactCount).toBe(expected);
    }
    // The divergence a consumer acts on: both audiences are enumerated, only one can be served.
    const ids = new Set(audienceRows.filter((r: any) => r.availableToContactCount === 0).map((r: any) => r.audienceId));
    expect([...ids]).toEqual(["aud-dry"]);
  });

  it("the brand column carries no availability — it is not an audience", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    for (const r of res.body.rows.filter((x: any) => x.audienceId === null)) {
      expect("availableToContactCount" in r).toBe(false);
    }
  });

  it("an unstated count is null, never 0 — only the producer may say an audience is served out", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    const unstated = res.body.rows.filter((r: any) => r.audienceId === "aud-unstated");
    expect(unstated.length).toBeGreaterThan(0);
    for (const r of unstated) expect(r.availableToContactCount).toBeNull();
  });

  it("a failed availability read is null, never a map of zeros — and degrades every audience row to null", async () => {
    const { fetchActiveAudienceAvailabilitySoft } = await import("../lib/human-client.js");
    const { withAudienceAvailability } = await import("./workflow-projection.js");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const availability = await fetchActiveAudienceAvailabilitySoft("brand-1", { orgId: "org-1" });
    expect(availability).toBeNull();
    const rows = withAudienceAvailability(
      [
        { audienceId: null, workflow: { workflowDynastySlug: "d", workflowDynastyName: null } },
        { audienceId: "aud-dry", workflow: { workflowDynastySlug: "d", workflowDynastyName: null } },
      ] as any,
      availability,
    );
    expect("availableToContactCount" in rows[0]).toBe(false);
    expect(rows[1].availableToContactCount).toBeNull();
  });
});
