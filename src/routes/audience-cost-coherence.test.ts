/**
 * CROSS-SURFACE INVARIANT — the per-audience cost the dashboard's Audiences table shows
 * (`/audience-stats`) must be the SAME number the Strategy page shows for that same audience
 * (`/workflow-projection`), for the same brand + goal + moment.
 *
 * Both endpoints are driven here by ONE downstream fixture, so the equality is a property of the two
 * computes, not of two hand-written expectations. The case under test is the one that used to disagree
 * by ~3x in prod: an audience with ZERO outcomes whose own spend is BELOW the parent, so its cost is the
 * parent verbatim on both surfaces.
 *
 * The old parent summed the WHOLE fleet's spend over the WHOLE fleet's outcomes (cross-org AND
 * cross-workflow pooled); the Strategy page floors each audience against the workflow it is actually
 * projected under. Both were labelled "fleet benchmark" in the UI → two prices for one thing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));

vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // pure live-compute path on both surfaces
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
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 10,
  visitToSignupPct: 20,
  signupToPaidClientPct: 40,
  visitToPaidClientPct: 20,
  replyToPaidClientPct: 50,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}

function workflow(slug: string): Record<string, unknown> {
  return {
    id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastySlug: slug, workflowDynastyName: slug,
    version: 1, status: "active", featureSlug: FEATURE.slug, createdForBrandId: null, upgradedTo: null,
  };
}
function costGroup(dimensions: Record<string, string>, cents: number, runCount = 10): Record<string, unknown> {
  return { dimensions, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
function emailGroup(key: string, clicked: number, repliesPositive: number, contacted = 500): Record<string, unknown> {
  return { key, broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive } } };
}

// ── The ONE fixture both surfaces read ────────────────────────────────────────
// Fleet (cross-org, per workflow):
//   wf-cheap  $200 over 100 clicks →  $2.00 per website visit  ← the BEST workflow
//   wf-pricey $1000 over 50 clicks → $20.00
//   wf-husk   $5 over 0 clicks     → no observed outcome (ineligible)
// POOLED across all three (the old parent) = 120,500¢ ÷ 150 clicks = $8.03 — ~4x the best workflow.
// This brand ran nothing of its own (no brand-grain spend) and its single audience has 0 clicks with a
// 50¢ attributed spend — below the parent — so BOTH surfaces must report the parent verbatim.
interface Fleet {
  workflows: Array<Record<string, unknown>>;
  costs: Array<Record<string, unknown>>;
  email: Array<Record<string, unknown>>;
}

// Case A — a plain cheapest-click fleet:
//   wf-cheap  $200 over 100 clicks →  $2.00 per website visit  ← the BEST workflow
//   wf-pricey $1000 over 50 clicks → $20.00
//   wf-husk   $5 over 0 clicks     → no observed outcome (ineligible)
// POOLED across all three (the old parent) = 120,500¢ ÷ 150 clicks ≈ $8.03 — ~4x the best workflow.
const FLEET_CHEAPEST_CLICK: Fleet = {
  workflows: [workflow("wf-cheap"), workflow("wf-pricey"), workflow("wf-husk")],
  costs: [
    costGroup({ workflowSlug: "wf-cheap" }, 20000),
    costGroup({ workflowSlug: "wf-pricey" }, 100000),
    costGroup({ workflowSlug: "wf-husk" }, 500),
  ],
  email: [emailGroup("wf-cheap", 100, 40), emailGroup("wf-pricey", 50, 10), emailGroup("wf-husk", 0, 0)],
};
const POOLED_CPC_USD = 120500 / 100 / 150; // the old cross-workflow pooled average ≈ $8.03

// Case B — the best workflow for the GOAL is NOT the cheapest-click one:
//   wf-cheap  $200 / 100 clicks / 0 replies   → click $2.00, cost-per-purchase $10.53
//   wf-closer $400 / 100 clicks / 200 replies → click $4.00, reply $2.00, cost-per-purchase $8.16
// The goal (website purchase) closes through BOTH channels, so wf-closer wins it despite pricier
// clicks. Every column must then read wf-closer's unit costs — a per-column "best" would price clicks
// off wf-cheap ($2.00) while the Strategy page shows wf-closer's $4.00.
const FLEET_GOAL_BEATS_CLICKS: Fleet = {
  workflows: [workflow("wf-cheap"), workflow("wf-closer")],
  costs: [costGroup({ workflowSlug: "wf-cheap" }, 20000), costGroup({ workflowSlug: "wf-closer" }, 40000)],
  email: [emailGroup("wf-cheap", 100, 0), emailGroup("wf-closer", 100, 200)],
};

let fleet: Fleet = FLEET_CHEAPEST_CLICK;
/** The workflow the audience's own 50¢ of spend is attributed to (workflow-projection audience grain). */
let audienceSpendSlug = "wf-cheap";

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: fleet.workflows });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: fleet.costs });
    if (url.includes("email:3000/public/stats")) return json({ groups: fleet.email });
    if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    // Conversion tracker (purchase / sale goals): no converted lead → 0 conversions, not absent.
    if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) return json({ emails: [] });

    // Org-scoped runs cost, split by groupBy.
    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      // audience-stats numerator: this audience carries 50¢ of attributed spend.
      if (groupBy === "audienceId") return json({ groups: [costGroup({ audienceId: "audience-a" }, 50, 1)] });
      // workflow-projection audience grain: the SAME 50¢, attributed to the workflow it ran under.
      if (groupBy === "audienceId,workflowSlug") return json({ groups: [costGroup({ audienceId: "audience-a", workflowSlug: audienceSpendSlug }, 50, 1)] });
      // brand grain (groupBy=workflowSlug + brandId): the brand has no own workflow-level spend.
      return json({ groups: [] });
    }

    // Email-gateway org-scoped stats, split by the requested dimension.
    if (url.includes("email:3000/orgs/stats")) {
      const audienceId = params.get("audienceId");
      // workflow-projection audience grain (per audience × workflow): contacted, ZERO outcomes.
      if (audienceId) return json({ groups: [emailGroup(audienceSpendSlug, 0, 0, 10)] });
      const groupBy = params.get("groupBy") ?? "";
      // audience-stats send-tag engagement (per audience): the SAME contacted / ZERO outcomes.
      if (groupBy === "audienceId") return json({ groups: [emailGroup("audience-a", 0, 0, 10)] });
      // workflow-projection brand grain: nothing of its own.
      return json({ groups: [] });
    }

    if (url.includes("human:3000/orgs/audiences/audience-a/members")) {
      return json({ members: [{ emailNorm: "a1" }], total: 1, limit: 500, offset: 0 });
    }
    if (url.includes("human:3000/orgs/audiences")) {
      return json({
        audiences: [{ id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null }],
        total: 1, limit: 200, offset: 0,
      });
    }
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    return json({});
  });
}

/** The two surfaces' numbers for audience-a, driven by the SAME fixture. */
async function bothSurfaces(goal: string, statsMetric: "cpcCents" | "cpsaleCents", projectionField: "costPerOutcomeUsd" | "costPerClickUsd") {
  const stats = await request(app).get(`/features/${FEATURE.slug}/audience-stats?brandId=brand-1&goal=${goal}`).set(AUTH);
  expect(stats.status).toBe(200);
  const projection = await request(app).get(`/features/${FEATURE.slug}/workflow-projection?brandId=brand-1&goal=${goal}`).set(AUTH);
  expect(projection.status).toBe(200);

  const row = stats.body.audiences.find((r: any) => r.audienceId === "audience-a");
  expect(row.evidence.websiteClicks).toBe(0);

  const recommendedSlug = projection.body.recommendedWorkflowDynastySlug;
  const projectionRow = projection.body.rows.find(
    (r: any) => r.audienceId === "audience-a" && r.workflow.workflowDynastySlug === recommendedSlug,
  );
  return {
    recommendedSlug,
    statsUsd: row.metrics[statsMetric] / 100,
    projectionUsd: projectionRow.resolved[projectionField],
  };
}

describe("per-audience cost coherence: /audience-stats ↔ /workflow-projection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    fleet = FLEET_CHEAPEST_CLICK;
    audienceSpendSlug = "wf-cheap";
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("a 0-outcome audience whose own spend is below the parent reports the SAME cost on both surfaces", async () => {
    const { recommendedSlug, statsUsd, projectionUsd } = await bothSurfaces("websiteVisit", "cpcCents", "costPerOutcomeUsd");

    expect(statsUsd).toBe(projectionUsd);
    // …and that shared number is the BEST workflow's cost, not the cross-workflow pooled average.
    expect(statsUsd).toBe(2); // wf-cheap: $200 / 100 clicks
    expect(statsUsd).not.toBeCloseTo(POOLED_CPC_USD, 2);
    expect(recommendedSlug).toBe("wf-cheap");
  });

  it("both surfaces agree on the workflow the GOAL picks, even when it is not the cheapest-click one", async () => {
    fleet = FLEET_GOAL_BEATS_CLICKS;

    // The goal's own metric (cost per purchase) matches…
    const outcome = await bothSurfaces("websitePurchase", "cpsaleCents", "costPerOutcomeUsd");
    expect(outcome.recommendedSlug).toBe("wf-closer");
    expect(outcome.statsUsd).toBeCloseTo(outcome.projectionUsd, 9);

    // …and so does the click column, because BOTH surfaces read the SAME single workflow's unit costs.
    const click = await bothSurfaces("websitePurchase", "cpcCents", "costPerClickUsd");
    expect(click.statsUsd).toBe(click.projectionUsd);
    expect(click.statsUsd).toBe(4); // wf-closer's click cost, NOT wf-cheap's cheaper $2.00
  });
});
