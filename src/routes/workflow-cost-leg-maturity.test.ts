/**
 * `/public/stats/workflow-cost-per-outcome` — each workflow's figures on its objective's LEG, flash and
 * mature, and the benchmark taken over MATURE workflows only (features-service#1196).
 *
 * ONE fixture where the flash and mature answers DISAGREE about which workflow is best: `wf-b` is the
 * cheapest per positive reply to date ($5) because its two replies both came from runs younger than the
 * leg's 21 days — it has no mature reply at all — while `wf-c` is the cheapest MATURE workflow ($15).
 * A benchmark taken on flash, or over every workflow, names `wf-b`; the one served names `wf-c`. A suite
 * that only checked "a block came back" would pass on either.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFindFirst = vi.fn();
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: (...a: unknown[]) => mockFindFirst(...a), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const { __resetWorkflowCostPerOutcomeCache, __awaitLegMaturityWarm, __resetFunnelBucketDatasetCache } = await import("./public.js");
const legFleet = await import("../lib/leg-fleet-evidence.js");
const fleetRepliers = await import("../lib/fleet-positive-repliers.js");

const FEATURE = { id: "f1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const LEG = "start_to_conversation";
// Derived from the one rule, never a literal: the cutoff moves with today, so a pinned date goes red a day later.
const CUTOFF = (await import("../lib/maturity.js")).legCutoffIso(LEG)!;

function wf(slug: string): Record<string, unknown> {
  return { id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastyName: slug, workflowDynastySlug: slug, version: 1, status: "active", featureSlug: FEATURE.slug, createdForBrandId: null, upgradedTo: null };
}
function group(slug: string, cents: string): Record<string, unknown> {
  return { dimensions: { workflowSlug: slug }, totalCostInUsdCents: cents, netTotalCostInUsdCents: cents, runCount: 3, minStartedAt: null, maxStartedAt: null };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function mockDownstreams(): void {
  vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://workflow:3000/public/workflows")) return json({ workflows: [wf("wf-a"), wf("wf-b"), wf("wf-c")] });
    if (url.startsWith("http://runs:3000/v1/stats/public/costs/timeseries")) return json({ buckets: [] });
    if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
      return json({ groups: [group("wf-a", "20000"), group("wf-b", "1000"), group("wf-c", "3000")] });
    }
    if (url.startsWith("http://email:3000/public/stats")) return json({ groups: [] });
    if (url.startsWith("http://lead:3000/internal/feature-memberships")) return json({ memberships: [] });
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}

/** The leg's evidence: flash (to date) and mature (runs started before the cutoff). */
function mockLegEvidence(mature: "cut" | "uncuttable" = "cut"): void {
  vi.mocked(legFleet.fetchLegFleetEvidence).mockResolvedValue({
    campaigns: [{ campaignId: "c1", orgId: "o1", brandId: "b1", legKey: LEG, featureSlug: FEATURE.slug }] as never,
    // Fractional cents on purpose: summed exactly, never rounded per slug.
    costGroups: [group("wf-a", "10000.5"), group("wf-b", "1000"), group("wf-c", "2000")] as never,
    emailStats: new Map([
      // email-gateway's own reply counts — REPLACED by the person basis below.
      ["wf-a", { recipientsContacted: 100, recipientsClicked: 10, recipientsRepliesPositive: 99 }],
      ["wf-b", { recipientsContacted: 30, recipientsClicked: 1, recipientsRepliesPositive: 99 }],
      ["wf-c", { recipientsContacted: 40, recipientsClicked: 2, recipientsRepliesPositive: 99 }],
    ]),
  });
  vi.mocked(fleetRepliers.fetchFleetPositiveRepliesBySlug).mockResolvedValue(
    new Map([["wf-a", 4], ["wf-b", 2], ["wf-c", 1]]),
  );
  vi.mocked(legFleet.fetchLegFleetMatureEvidence).mockResolvedValue(
    mature === "uncuttable"
      ? null
      : {
          cutoffIso: CUTOFF,
          costGroups: [group("wf-a", "6000"), group("wf-b", "800"), group("wf-c", "1500")] as never,
          emailStats: new Map([
            ["wf-a", { recipientsContacted: 60, recipientsClicked: 5, recipientsRepliesPositive: 2 }],
            ["wf-b", { recipientsContacted: 10, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
            ["wf-c", { recipientsContacted: 20, recipientsClicked: 1, recipientsRepliesPositive: 1 }],
          ]),
        },
  );
}

async function readWarmed(objective = "positiveReply") {
  const first = await request(app).get(`/public/stats/workflow-cost-per-outcome?featureSlug=${FEATURE.slug}&objective=${objective}`);
  await __awaitLegMaturityWarm();
  const second = await request(app).get(`/public/stats/workflow-cost-per-outcome?featureSlug=${FEATURE.slug}&objective=${objective}`);
  return { first, second };
}

describe("workflow-cost-per-outcome — the leg's flash, mature and verdict per workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetWorkflowCostPerOutcomeCache();
    __resetFunnelBucketDatasetCache();
    mockFindFirst.mockResolvedValue(FEATURE);
    mockDownstreams();
  });

  it("serves the rows at once with maturity not stated yet, then the warmed pairs", async () => {
    mockLegEvidence();
    const { first, second } = await readWarmed();
    expect(first.status).toBe(200);
    expect(first.body.fleet).toBeNull();
    expect(first.body.workflows.every((r: { maturity: unknown }) => r.maturity === null)).toBe(true);

    const bySlug = new Map(second.body.workflows.map((r: { workflowDynastySlug: string }) => [r.workflowDynastySlug, r]));
    const a = bySlug.get("wf-a") as { maturity: Record<string, any> };
    // Served in the outbound spelling (wave 2, lib/served-leg-keys.ts); the legacy `?leg=` above still reads it.
    expect(a.maturity.legKey).toBe("lead_found_to_conversation");
    expect(a.maturity.durationDays).toBe(21);
    expect(a.maturity.outcomesRequired).toBe(1);
    // Flash: the leg's whole-history spend EXACTLY over its PEOPLE who replied (4, never email-gateway's 99).
    expect(a.maturity.flash.spentUsd).toBeCloseTo(100.005, 9);
    expect(a.maturity.flash.outcomes).toBe(4);
    expect(a.maturity.flash.costPerOutcomeUsd).toBeCloseTo(25.00125, 9);
    expect(a.maturity.mature.costPerOutcomeUsd).toBeCloseTo(30, 9);
    expect(a.maturity.isMature).toBe(true);

    const b = bySlug.get("wf-b") as { maturity: Record<string, any> };
    expect(b.maturity.flash.costPerOutcomeUsd).toBeCloseTo(5, 9);
    expect(b.maturity.mature.outcomes).toBe(0);
    expect(b.maturity.mature.costPerOutcomeUsd).toBeNull();
    expect(b.maturity.isMature).toBe(false);
  });

  it("the benchmark is over MATURE workflows only: the flash-cheapest young workflow never takes best", async () => {
    mockLegEvidence();
    const { second } = await readWarmed();
    const fleet = second.body.fleet;
    expect(fleet).toMatchObject({ legKey: "lead_found_to_conversation", basis: "mature", measured: true, cutoffIso: CUTOFF, matureWorkflowCount: 2 });
    // wf-b reads $5 to date and would be named on flash; the mature best is wf-c at $15.
    expect(fleet.best).toEqual({ workflowDynastySlug: "wf-c", costPerOutcomeUsd: 15 });
    expect(fleet.median.costPerOutcomeUsd).toBeCloseTo((15 + 30) / 2, 9);
  });

  it("a cut that cannot be made nulls every mature half and verdict, and the benchmark says so", async () => {
    mockLegEvidence("uncuttable");
    const { second } = await readWarmed();
    for (const row of second.body.workflows) {
      expect(row.maturity.flash).not.toBeNull();
      expect(row.maturity.mature).toBeNull();
      expect(row.maturity.isMature).toBeNull();
    }
    expect(second.body.fleet).toMatchObject({ measured: false, matureWorkflowCount: 0, best: null, median: null });
  });

  it("an objective with no single leg states no maturity and reads no leg evidence", async () => {
    mockLegEvidence();
    const { second } = await readWarmed("signup");
    expect(second.status).toBe(200);
    expect(second.body.fleet).toBeNull();
    expect(second.body.workflows.every((r: { maturity: unknown }) => r.maturity === null)).toBe(true);
    expect(legFleet.fetchLegFleetEvidence).not.toHaveBeenCalled();
  });

  it("the legacy row figures are unchanged beside the pair", async () => {
    mockLegEvidence();
    const { first, second } = await readWarmed();
    const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ maturity: _m, ...rest }) => rest);
    expect(strip(second.body.workflows)).toEqual(strip(first.body.workflows));
  });
});
