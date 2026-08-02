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
  visitToFormSubmissionPct: 25,
  formSubmissionToPaidClientPct: 20,
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
  /** Brand-grain evidence (runs groupBy=workflowSlug + brandId, email groupBy=workflowSlug). */
  brandCosts?: Array<Record<string, unknown>>;
  brandEmail?: Array<Record<string, unknown>>;
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
// Case C — the BRAND grain flips the winner (the prod shape, EmailToolsHub / Osprey vs Pelican):
//   wf-a fleet $200 / 100 clicks → $2.00, but this brand burned $5.00 on it with ZERO clicks, so its
//        brand grain floors the click to max($5.00, $2.00) = $5.00
//   wf-b fleet $300 / 100 clicks → $3.00, this brand never ran it → stays $3.00
// The brand-level row wf-b therefore wins at $3.00. A parent built from the crossOrg grain alone would
// crown wf-a at $2.00 and disagree with the Strategy page by 50%.
const FLEET_BRAND_GRAIN_FLIPS: Fleet = {
  workflows: [workflow("wf-a"), workflow("wf-b")],
  costs: [costGroup({ workflowSlug: "wf-a" }, 20000), costGroup({ workflowSlug: "wf-b" }, 30000)],
  email: [emailGroup("wf-a", 100, 0), emailGroup("wf-b", 100, 0)],
  brandCosts: [costGroup({ workflowSlug: "wf-a" }, 500, 1)],
  brandEmail: [emailGroup("wf-a", 0, 0, 13)],
};

// Case D — a HUSK undercuts the measured workflow on the goal's own metric (the prod shape, `dawn` vs
// `arcadia` at goal=positiveReply). Cost-per-outcome here IS the reply cost:
//   wf-husk     $60 / 13 clicks / ZERO replies → reply cost = max($60, no parent) = $60, a pure LOWER
//               BOUND ("spent $60, got no replies"), NOT a measured ratio — yet it is the smallest number
//   wf-measured $80 /  0 clicks /  1 reply     → reply cost = $80/1 = $80, genuinely MEASURED
// Every ranker argmins on `resolved.costPerOutcomeUsd`, so while the husk reports $60 it is crowned "best
// cost per positive reply" — by a workflow that has never produced one — and the Strategy page prices
// every audience off it, while /audience-stats (whose parent pick has always been husk-gated) uses $80.
const FLEET_HUSK_UNDERCUTS: Fleet = {
  workflows: [workflow("wf-husk"), workflow("wf-measured")],
  costs: [costGroup({ workflowSlug: "wf-husk" }, 6000), costGroup({ workflowSlug: "wf-measured" }, 8000)],
  email: [emailGroup("wf-husk", 13, 0), emailGroup("wf-measured", 0, 1)],
};

const FLEET_GOAL_BEATS_CLICKS: Fleet = {
  workflows: [workflow("wf-cheap"), workflow("wf-closer")],
  costs: [costGroup({ workflowSlug: "wf-cheap" }, 20000), costGroup({ workflowSlug: "wf-closer" }, 40000)],
  email: [emailGroup("wf-cheap", 100, 0), emailGroup("wf-closer", 100, 200)],
};

let fleet: Fleet = FLEET_CHEAPEST_CLICK;
/** The workflow the audience's own spend is attributed to (workflow-projection audience grain). */
let audienceSpendSlug = "wf-cheap";
/** The audience's own attributed spend, in cents — the SAME figure on both surfaces. */
let audienceSpendCents = 50;
/** The audience's own observed website clicks — the driving outcome of the funnel columns. */
let audienceClicks = 0;
/** Per-(audience × dynasty) legs. Set to spread the audience's evidence over several workflows. */
interface AudienceLeg {
  slug: string;
  cents: number;
  clicks: number;
}
let audienceLegsOverride: AudienceLeg[] | null = null;
/** The audience's legs — the single-workflow scalars unless a test spread them across dynasties. */
function audienceLegs(): AudienceLeg[] {
  return audienceLegsOverride ?? [{ slug: audienceSpendSlug, cents: audienceSpendCents, clicks: audienceClicks }];
}
const sumBy = (pick: (l: AudienceLeg) => number): number => audienceLegs().reduce((t, l) => t + pick(l), 0);

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: fleet.workflows });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: fleet.costs });
    if (url.includes("email:3000/public/stats")) return json({ groups: fleet.email });
    if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    // The funnels this brand declared — both meeting chains, so a `?funnel=` request is answerable.
    if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
      return json({
        funnels: ["sales_meetings_from_conversation", "sales_meetings_from_website", "website_purchases", "form_magnet"].map(
          (funnelKey) => ({ funnelKey, active: true, name: funnelKey, steps: [], rates: {}, lifetimeRevenueUsd: null, destinationUrl: null, bookingUrl: null, updatedAt: "2026-08-02T00:00:00.000Z" }),
        ),
      });
    }
    // Conversion tracker (purchase / sale goals): no converted lead → 0 conversions, not absent.
    if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) return json({ emails: [] });

    // Org-scoped runs cost, split by groupBy.
    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      // audience-stats numerator: this audience's attributed spend, summed over its legs.
      if (groupBy === "audienceId") return json({ groups: [costGroup({ audienceId: "audience-a" }, sumBy((l) => l.cents), 1)] });
      // workflow-projection audience grain: the SAME spend, split across the workflows it ran under.
      if (groupBy === "audienceId,workflowSlug")
        return json({
          groups: audienceLegs().map((l) => costGroup({ audienceId: "audience-a", workflowSlug: l.slug }, l.cents, 1)),
        });
      // brand grain (groupBy=workflowSlug + brandId).
      return json({ groups: fleet.brandCosts ?? [] });
    }

    // Email-gateway org-scoped stats, split by the requested dimension.
    if (url.includes("email:3000/orgs/stats")) {
      const audienceId = params.get("audienceId");
      // workflow-projection audience grain (per audience × workflow): contacted + clicks per leg.
      if (audienceId) return json({ groups: audienceLegs().map((l) => emailGroup(l.slug, l.clicks, 0, 10)) });
      const groupBy = params.get("groupBy") ?? "";
      // audience-stats send-tag engagement (per audience): the SAME totals, one basis.
      if (groupBy === "audienceId")
        return json({ groups: [emailGroup("audience-a", sumBy((l) => l.clicks), 0, 10 * audienceLegs().length)] });
      // workflow-projection brand grain.
      return json({ groups: fleet.brandEmail ?? [] });
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
async function bothSurfaces(
  goal: string,
  statsMetric: "cpcCents" | "cpprCents" | "cpsaleCents" | "cpfsCents",
  projectionField: "costPerOutcomeUsd" | "costPerClickUsd",
  // The SALES FUNNEL to price on. Threaded onto BOTH URLs, because the invariant this suite guards is
  // that the two surfaces answer with one number — which only holds if they are asked one question.
  funnel?: string,
) {
  const q = funnel ? `&funnel=${funnel}` : "";
  const stats = await request(app).get(`/features/${FEATURE.slug}/audience-stats?brandId=brand-1&goal=${goal}${q}`).set(AUTH);
  expect(stats.status).toBe(200);
  const projection = await request(app).get(`/features/${FEATURE.slug}/workflow-projection?brandId=brand-1&goal=${goal}${q}`).set(AUTH);
  expect(projection.status).toBe(200);

  const row = stats.body.audiences.find((r: any) => r.audienceId === "audience-a");
  // Both surfaces read the SAME send-tag click evidence for this audience.
  expect(row.evidence.websiteClicks).toBe(sumBy((l) => l.clicks));

  const recommendedSlug = projection.body.recommendedWorkflowDynastySlug;
  return {
    recommendedSlug,
    statsUsd: row.metrics[statsMetric] / 100,
    projectionUsd: strategyRowFor("audience-a", projection.body).resolved[projectionField],
  };
}

/**
 * The row the Strategy page actually renders for an audience — mirroring the dashboard's
 * `strategy-model.ts` (distribute.you) so this suite compares against what the customer SEES, not
 * against whichever row is convenient:
 *   - `pickBestBrandRow`: the headline workflow is the cheapest BRAND-LEVEL row on
 *     `resolved.costPerOutcomeUsd` — deliberately NOT `recommendedWorkflowDynastySlug`, whose argmin
 *     spans per-audience rows (it exists for campaign-service's per-run audience selection).
 *   - `pickAudienceOrBrandRow` → `pickAudienceGrainRow`: WORKFLOW-AGNOSTIC — among ALL of this
 *     audience's rows resolved at grain "audience", the lowest `resolved.costPerClickUsd`; falling back
 *     to the headline workflow's brand-level row when the audience has no measured grain anywhere.
 */
function strategyRowFor(audienceId: string, body: any): any {
  const brandRows = body.rows.filter((r: any) => r.audienceId == null);
  const bestBrandRow = brandRows
    .filter((r: any) => r.resolved.costPerOutcomeUsd != null && r.resolved.costPerOutcomeUsd > 0)
    .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];
  const audienceGrainRows = body.rows
    .filter((r: any) => r.audienceId === audienceId && r.resolved.grain === "audience")
    .sort((a: any, b: any) => a.resolved.costPerClickUsd - b.resolved.costPerClickUsd);
  return (
    audienceGrainRows[0] ??
    brandRows.find(
      (r: any) => r.workflow.workflowDynastySlug === bestBrandRow?.workflow.workflowDynastySlug,
    )
  );
}

describe("per-audience cost coherence: /audience-stats ↔ /workflow-projection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    fleet = FLEET_CHEAPEST_CLICK;
    audienceSpendSlug = "wf-cheap";
    audienceSpendCents = 50;
    audienceClicks = 0;
    audienceLegsOverride = null;
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  // STARVATION GUARD — a workflow with ZERO of the goal's outcome must still report a RANKABLE NUMBER
  // (its cascade floor), never null. campaign-service's `selectWorkflowGreedy` SKIPS a null-cost row, so
  // nulling it makes that workflow un-selectable → it never runs → never produces an outcome → stays
  // nulled forever (an absorbing state), and a NEWLY ADDED workflow could never enter rotation at all.
  // The floor is the exploration device: barely-tried reads cheap, gets picked, spends, its floor RISES,
  // and it drops out on its own if it keeps producing nothing. Gating this field was tried in v0.107.2
  // and reverted in v0.107.3 — do not re-introduce it.
  it("a workflow with ZERO of the goal's outcome still reports a rankable number, never null (exploration must not starve)", async () => {
    fleet = FLEET_HUSK_UNDERCUTS;
    audienceSpendSlug = "wf-measured";

    const res = await request(app)
      .get(`/features/${FEATURE.slug}/workflow-projection?brandId=brand-1&goal=positiveReply`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const husk = res.body.rows.find((r: any) => r.audienceId == null && r.workflow.workflowDynastySlug === "wf-husk");

    // Rankable: its own cascade floor ($60 spent, 0 replies → at least $60 per reply).
    expect(husk.resolved.costPerOutcomeUsd).toBe(60);
    // Still competes on the ranking every consumer runs — it is the cheapest, so it gets explored.
    expect(res.body.recommendedWorkflowDynastySlug).toBe("wf-husk");
    // The provenance LABEL stays honest even though the number competes: a floored row is never tagged
    // as this brand's own result. Number rankable, label truthful — the two stay decoupled.
    expect(husk.resolved.grain).toBe("crossOrg");
  });

  // ...and BOTH surfaces must then price the audience off that SAME cheapest workflow. `/audience-stats`
  // used to exclude the husk from its parent pick while the Strategy page ranked it, so the two showed
  // different prices for one audience (prod: $64.11 vs $61.73, both labelled "fleet benchmark").
  it("both surfaces price the audience off the cheapest workflow even when that workflow has ZERO of the outcome", async () => {
    fleet = FLEET_HUSK_UNDERCUTS;
    audienceSpendSlug = "wf-measured";

    const { statsUsd, projectionUsd } = await bothSurfaces("positiveReply", "cpprCents", "costPerOutcomeUsd");

    expect(statsUsd).toBeCloseTo(projectionUsd, 9);
    // $60 = wf-husk's floor, the cheapest row and the one the Strategy page renders.
    expect(statsUsd).toBe(60);
    // NOT wf-measured's $80 — that was the gated pick this module used to make on its own.
    expect(statsUsd).not.toBe(80);
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

  // THE RETIREMENT'S OWN COHERENCE CASE — the two meeting funnels are two chains bought through two
  // different channels, so they legitimately crown DIFFERENT workflows and price the same audience
  // differently. What must NOT differ is the two surfaces' answer for one funnel: the per-audience floor
  // parent has to move with the funnel, or the Audiences table and the Strategy page split apart again
  // one layer down — the exact incoherence this suite exists to prevent, in the new vocabulary.
  it("each MEETING FUNNEL prices the audience on its own channel, and both surfaces agree per funnel", async () => {
    fleet = FLEET_GOAL_BEATS_CLICKS;

    // Bought with a positive reply: wf-cheap has none (its reply cost floors to its $200 spend), so the
    // conversation funnel is won by wf-closer and the audience's click column reads wf-closer's $4.
    const conversation = await bothSurfaces("meetingBooked", "cpcCents", "costPerClickUsd", "sales_meetings_from_conversation");
    expect(conversation.statsUsd).toBe(conversation.projectionUsd);
    expect(conversation.statsUsd).toBe(4);

    // Bought with a click onto the site: wf-cheap's $2 clicks win it outright.
    const website = await bothSurfaces("meetingBooked", "cpcCents", "costPerClickUsd", "sales_meetings_from_website");
    expect(website.statsUsd).toBe(website.projectionUsd);
    expect(website.statsUsd).toBe(2);

    // The two funnels genuinely disagree — a goal-keyed request cannot produce this split at all, which
    // is why a brand running only the reply chain was benchmarked against clicks it never buys.
    expect(conversation.statsUsd).not.toBe(website.statsUsd);
  });

  it("refuses to price a funnel the brand never declared, on the audience surface too", async () => {
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
        return json({ funnels: [{ funnelKey: "website_purchases", active: true, name: "Website Purchase", steps: [], rates: {}, lifetimeRevenueUsd: null, destinationUrl: null, bookingUrl: null, updatedAt: "2026-08-02T00:00:00.000Z" }] });
      }
      return json({});
    }) as ReturnType<typeof vi.spyOn>;

    const res = await request(app)
      .get(`/features/${FEATURE.slug}/audience-stats?brandId=brand-1&goal=meetingBooked&funnel=sales_meetings_from_website`)
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("funnel_not_declared");
  });

  it("the BRAND grain floor is part of the pick — a workflow this brand already outspent cannot win on its fleet rate", async () => {
    fleet = FLEET_BRAND_GRAIN_FLIPS;
    audienceSpendSlug = "wf-a";

    const { recommendedSlug, statsUsd, projectionUsd } = await bothSurfaces("websiteVisit", "cpcCents", "costPerOutcomeUsd");

    expect(recommendedSlug).toBe("wf-b");
    expect(statsUsd).toBe(projectionUsd);
    expect(statsUsd).toBe(3); // wf-b's $3.00 — NOT wf-a's cheaper $2.00 fleet rate, which this brand
    // has already overspent against ($5.00 with zero clicks).
  });

  // ── DERIVED (funnel) columns at zero outcomes ──────────────────────────────
  // The prod regime (2026-07-29, brand 6e21bb6c…): three audiences with REAL observed clicks and ZERO
  // form submissions each displayed their own raw net spend, to the cent, as their cost PER FORM
  // SUBMISSION — a dollar total answering a per-outcome question, discarding the clicks they did observe.
  describe("a DERIVED funnel column at 0 outcomes", () => {
    beforeEach(() => {
      // $40.00 attributed to wf-cheap, with 2 observed clicks and no form submission yet.
      audienceSpendCents = 4000;
      audienceClicks = 2;
    });

    it("is grounded in the audience's OWN observed clicks, and equals the Strategy projection", async () => {
      const { recommendedSlug, statsUsd, projectionUsd } = await bothSurfaces("formSubmission", "cpfsCents", "costPerOutcomeUsd");

      expect(recommendedSlug).toBe("wf-cheap");
      // The invariant: one number for one concept across both surfaces.
      expect(statsUsd).toBeCloseTo(projectionUsd, 9);
      // …and it is this audience's own click cost ($40.00 / 2 = $20.00) carried through the brand's
      // 25% visit→form rate, NOT the fleet benchmark ($2.00 / 25% = $8.00).
      expect(statsUsd).toBe(80);
    });

    it("is NEVER the audience's raw dollar total while it has observed clicks", async () => {
      const stats = await request(app).get(`/features/${FEATURE.slug}/audience-stats?brandId=brand-1&goal=formSubmission`).set(AUTH);
      const row = stats.body.audiences.find((r: any) => r.audienceId === "audience-a");

      expect(row.evidence.websiteClicks).toBe(2);
      expect(row.evidence.formSubmissions).toBe(0);
      expect(row.metrics.cpfsCents).not.toBe(row.evidence.totalCostInUsdCents); // the bug: $40.00 = $40.00
      // The RAW column is untouched — there the click IS the outcome, so the measured ratio stands.
      expect(row.metrics.cpcCents).toBe(2000); // $40.00 / 2 clicks
      // Row-internal coherence: the funnel column is exactly the click column through the 25% rate.
      expect(row.metrics.cpfsCents).toBe(row.metrics.cpcCents / 0.25);
    });

    it("follows the audience to the workflow it is actually rendered on, not the brand-best one", async () => {
      // The prod shape (CEO Defense-Tech): the audience ran several workflows, and the Strategy table
      // renders it on the one with its LOWEST resolved click cost — which is NOT the brand-best workflow.
      //   wf-cheap  (brand-best, fleet $2.00/click): this audience spent $40.00 for 2 clicks → $20.00
      //   wf-pricey (fleet $20.00/click):            this audience spent  $6.00 for 4 clicks →  $1.50  ← rendered
      audienceLegsOverride = [
        { slug: "wf-cheap", cents: 4000, clicks: 2 },
        { slug: "wf-pricey", cents: 600, clicks: 4 },
      ];

      const { statsUsd, projectionUsd } = await bothSurfaces("formSubmission", "cpfsCents", "costPerOutcomeUsd");

      expect(statsUsd).toBeCloseTo(projectionUsd, 9);
      expect(statsUsd).toBe(6); // $1.50 / 25% — wf-pricey's leg, the row the customer sees
      expect(statsUsd).not.toBe(80); // wf-cheap's leg ($20.00 / 25%), the brand-best workflow
    });

    // An UNSTARTED audience is not a different regime from a barely-started one — both are un-evidenced.
    // The Strategy page always has a row for it (its per-audience pick falls back to the best workflow's
    // brand row), so blanking it on the Audiences table alone is the "three priced, one blank" split for
    // audiences that are all equally unstarted.
    it("an audience with NO spend and NO clicks gets the SAME benchmark both surfaces show, not a blank", async () => {
      audienceSpendCents = 0;
      audienceClicks = 0;

      const { statsUsd, projectionUsd } = await bothSurfaces("formSubmission", "cpfsCents", "costPerOutcomeUsd");

      expect(statsUsd).not.toBeNull();
      expect(statsUsd).toBeCloseTo(projectionUsd, 9);
    });
  });
});
