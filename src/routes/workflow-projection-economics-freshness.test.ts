import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

/**
 * Onboarding JTBD: the user confirms their lifetime revenue per paying customer, and the NEXT screen
 * shows the projected ROI + cost-of-acquisition for the best model we would run. Those two numbers must
 * reflect the number they just typed.
 *
 * Regression guard (prod 2026-07-29): the projection was served whole from the Gold SWR snapshot, whose
 * freshness key ignored the brand's economics — so a read inside the stale window returned an ROI
 * derived from the PREVIOUS lifetime revenue (2500 vs 100 = a 25x wrong answer). The fix caches only the
 * economics-INDEPENDENT evidence fan-out and projects from LIVE economics on every request.
 *
 * These tests run with the view cache ENABLED (the sibling suite disables it), which is the only way to
 * reproduce the stale window.
 */

// ── Stateful drizzle-funnel mock: features lookup + the view-cache snapshot row ──────────────────
// `body` round-trips through JSON to mirror the real jsonb column — a Map stored in jsonb comes back as
// `{}`, so this also guards the evidence shape's serializability.
let storedRow: Record<string, unknown> | undefined;

const makeThenable = (value: unknown, extra: Record<string, unknown> = {}) => ({
  then: (resolve: (v: unknown) => void) => resolve(value),
  ...extra,
});

const dbMock = {
  query: { features: { findFirst: vi.fn(), findMany: vi.fn() } },
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => (storedRow ? [storedRow] : []) }) }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        storedRow = { ...v, body: JSON.parse(JSON.stringify(v.body)) };
      },
    }),
  }),
  update: () => ({
    set: (s: Record<string, unknown>) => ({
      where: () =>
        makeThenable(undefined, {
          returning: async () => {
            if (storedRow) storedRow.refreshingAt = s.refreshingAt;
            return [{ id: "snap-1" }];
          },
        }),
    }),
  }),
};

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
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
// Cache ON with a long fresh window: a second read inside the window is a FRESH snapshot hit — exactly
// the state in which the pre-fix endpoint replayed the previous economics.
process.env.FEATURE_VIEW_CACHE_ENABLED = "true";
process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS = "60000";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "a81327ee-727a-4978-ab5d-6503658a9abf",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const BRAND_ID = "7604c385-1f02-4016-b42f-344565bcd36d";
const SALES_FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const URL_BASE = `/features/sales-cold-email-outreach/workflow-projection?brandId=${BRAND_ID}&goal=meetingBooked`;

/** Economics the "brand-service write" mutates between reads — only lifetimeRevenueUsd moves. */
let lifetimeRevenueUsd = 2500;
/** Counts the reads that make up the HEAVY evidence fan-out (everything except economics). */
let fanOutCalls = 0;

const economicsBody = () => ({
  economics: {
    lifetimeRevenueUsd,
    replyToMeetingPct: 40,
    visitToMeetingPct: 5,
    meetingToClosePct: 30,
    visitToClosePct: 2,
    visitToSignupPct: 4,
    signupToPaidClientPct: 50,
  },
  source: "user",
});

const WORKFLOWS = [
  { id: "ida", workflowSlug: "wf-a", workflowName: "WF A", workflowDynastyName: "Dynasty A", workflowDynastySlug: "dyn-a", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
];
const COST = [{ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "100000", runCount: 10, minStartedAt: null, maxStartedAt: null }];
const EMAIL = [{ key: "wf-a", broadcast: { recipientStats: { contacted: 200, sent: 200, delivered: 200, opened: 150, clicked: 100, bounced: 0, repliesPositive: 50, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } }];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");

    // The brand's economics — read LIVE on every request, never cached.
    if (url.includes("/sales-economics-effective")) return json(economicsBody());

    fanOutCalls += 1;
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: COST });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: COST });
    }
    if (url.includes("/orgs/stats")) return json({ groups: EMAIL });
    if (url.includes("/public/stats")) return json({ groups: EMAIL });
    if (url.includes("/orgs/audiences")) return json({ audiences: [] });
    return json({});
  });
}

/** ROI = LTR / cost-per-paid-client, so it scales linearly with the lifetime revenue the user typed. */
const readProjection = async () => {
  const res = await request(app).get(URL_BASE).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
};

describe("workflow-projection reflects a just-written lifetime revenue (no consumer opt-in)", () => {
  beforeEach(() => {
    storedRow = undefined;
    fanOutCalls = 0;
    lifetimeRevenueUsd = 2500;
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("AC1 — a read immediately after the economics write returns the NEW ROI + CAC, not the previous one", async () => {
    const before = await readProjection();
    expect(before.economics.lifetimeRevenueUsd).toBe(2500);
    const roiBefore = before.rows[0].resolved.roiMultiple;
    const cacBefore = before.rows[0].resolved.cacPct;
    expect(roiBefore).toBeGreaterThan(0);

    // The dashboard writes the confirmed lifetime revenue, then reads back with NO wait.
    lifetimeRevenueUsd = 100;
    const after = await readProjection();

    expect(after.economics.lifetimeRevenueUsd).toBe(100);
    // ROI = LTR / cost-per-paid-client → 25x lower for a 25x lower LTR; CAC% = 100/ROI → 25x higher.
    expect(after.rows[0].resolved.roiMultiple).toBeCloseTo(roiBefore / 25, 6);
    expect(after.rows[0].resolved.cacPct).toBeCloseTo(cacBefore * 25, 6);
    expect(after.rows[0].resolved.roiMultiple).not.toBeCloseTo(roiBefore, 6);
  });

  it("AC2 — repeated writes always read back the newest lifetime revenue, never the previous one", async () => {
    let previousRoi: number | null = null;
    for (const ltr of [2500, 100, 900, 40, 5000]) {
      lifetimeRevenueUsd = ltr;
      const body = await readProjection();
      const roi = body.rows[0].resolved.roiMultiple;
      const costPerPaidClient = body.rows[0].resolved.costPerPaidClientUsd;

      expect(body.economics.lifetimeRevenueUsd).toBe(ltr);
      // Coherent with the number the user typed: roiMultiple === LTR / cost-per-paid-client.
      expect(roi).toBeCloseTo(ltr / costPerPaidClient, 6);
      expect(body.rows[0].resolved.cacPct).toBeCloseTo(100 / roi, 6);
      if (previousRoi !== null) expect(roi).not.toBeCloseTo(previousRoi, 6);
      previousRoi = roi;
    }
  });

  it("AC3 — repeated reads with no economics change do NOT re-run the heavy fan-out", async () => {
    await readProjection();
    const afterFirst = fanOutCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await readProjection();
    await readProjection();
    expect(fanOutCalls).toBe(afterFirst); // served from the Gold snapshot

    // An economics change likewise does not re-fan-out — the evidence never depended on economics.
    lifetimeRevenueUsd = 100;
    await readProjection();
    expect(fanOutCalls).toBe(afterFirst);
  });

  it("AC4 — the snapshot survives the jsonb round-trip: cached reads carry the same grains as the live one", async () => {
    const live = await readProjection();
    const cached = await readProjection();
    expect(cached.rows).toEqual(live.rows);
    expect(cached.rows[0].estimatesByGrain.crossOrg.evidence.observedClicks).toBe(100);
    expect(cached.recommendedWorkflowDynastySlug).toBe(live.recommendedWorkflowDynastySlug);
  });
});
