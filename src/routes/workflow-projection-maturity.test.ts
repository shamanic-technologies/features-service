/**
 * A MATURE WORKFLOW IS PRICED ON ITS MATURE EVIDENCE, AT EVERY GRAIN — features-service#1196.
 *
 * Prod 2026-09-28, campaign `3922c8e1…`: every figure divided everything spent to date by everything
 * observed to date, so the leader's own last three weeks of sends (whose visits and replies were still on
 * their way) inflated its price, while a new workflow read cheap, took the budget, and was replaced the
 * moment its own spend floor passed the leader — a LADDER: $357 of $1,022 went to 33 workflows with zero
 * positive replies.
 *
 * ONE fixture on the website-visit leg (21 days, 10 mature visits), shaped like that:
 *   - `wf-old` (the leader): $100 of runs started 30-40 days ago that served 100 leads → 20 visits, plus
 *     $200 of runs started 5 days ago that served 50 leads → 2 visits so far. Flash reads $300 / 22 =
 *     $13.64 a visit; its mature figure is $100 / 20 = $5.00.
 *   - `wf-new` (the newcomer): $30 of runs started 3 days ago → 3 visits. Flash $10.00; nothing mature.
 * On flash alone the newcomer outranks the leader ($10 < $13.64) — the ladder. Every case asserts the
 * DIVERGENCE between the two versions, so a suite that only checked "a number came back" would pass on
 * the implementation this replaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { offerEconomicsFromDeclared } from "../lib/leg-economics-fixture.js";

const fixture = vi.hoisted(() => ({
  persons: [] as Array<Record<string, any>>,
}));

vi.unmock("../lib/leg-fleet-evidence.js");
vi.unmock("../lib/fleet-positive-repliers.js");
vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => {
  const { everyWorkflowActive } = await import("../lib/leg-assignments-fixture.js");
  return {
    ...(await importOriginal<typeof import("../lib/workflow-leg-assignments.js")>()),
    fetchLegAssignments: vi.fn(async () => everyWorkflowActive()),
  };
});
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crm-only-repliers.js")>();
  /** The deduped persons of one (org, brand[, campaigns]) scope — lead-service's compact rows, mapped. */
  const scopePersons = async (brandId: string, scope: unknown, identity: { orgId: string }) => {
    const ids = typeof scope === "string" ? new Set([scope]) : Array.isArray(scope) ? new Set(scope as string[]) : null;
    return fixture.persons.filter(
      (p) => p.orgId === identity.orgId && p.brandId === brandId && (!ids || ids.has(p.campaignId)),
    ) as any;
  };
  return {
    ...actual,
    fetchScopePersons: vi.fn(scopePersons),
    fetchPositiveRepliers: vi.fn(async (brandId: string, scope: unknown, identity: { orgId: string }) =>
      actual.positiveRepliersOf(await scopePersons(brandId, scope, identity)),
    ),
  };
});
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
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const { __resetLegFleetEvidence } = await import("../lib/leg-fleet-evidence.js");
const { __resetFleetPositiveRepliers } = await import("../lib/fleet-positive-repliers.js");
const { maturityCutoffIso } = await import("../lib/maturity.js");
const { heldPriceOn } = await import("./workflow-projection.js");
const app = (await import("../index.js")).default;

const ORG = "org-1";
const OTHER_ORG = "org-2";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OTHER_BRAND = "b2";
const AUTH = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const SLUG = "sales-cold-email-outreach";
const URL_BASE = `/features/${SLUG}/workflow-projection`;
const VISIT = "start_to_website_visit";
const CONVERSATION = "start_to_conversation";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
// Frozen once so every read of one test sees the byte-same dates.
const D40 = daysAgo(40);
const D30 = daysAgo(30);
const D5 = daysAgo(5);
const D4 = daysAgo(4);
const D3 = daysAgo(3);

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 50,
  visitToMeetingPct: 50,
  meetingToClosePct: 40,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const FUNNEL = (funnelKey: string, steps: string[]) => ({
  funnelKey,
  name: funnelKey,
  steps,
  rates: { replyToMeetingPct: 50, visitToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-27T00:00:00.000Z",
});
const FUNNELS = [
  FUNNEL("sales_meetings_from_conversation", ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]),
  FUNNEL("sales_meetings_from_website", ["Website visit", "Meeting booked", "Meeting attended", "Paid client"]),
];

const wf = (slug: string, dynasty: string) => ({
  id: slug, workflowSlug: slug, workflowName: slug, workflowDynastyName: dynasty, workflowDynastySlug: dynasty,
  version: 1, status: "active", featureSlug: SLUG, createdForBrandId: null, upgradedTo: null,
});
const WORKFLOWS = [wf("wf-old", "dyn-old"), wf("wf-new", "dyn-new")];

const CAMPAIGNS = [
  { id: "c-own", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: VISIT },
  { id: "c-other", orgId: OTHER_ORG, brandIds: [OTHER_BRAND], featureSlug: SLUG, legKey: VISIT },
  { id: "c-conv", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: CONVERSATION },
];

/** The runs ledger: one cost row per run, with the run's START — the one clock both halves are cut on. */
interface Run { campaignId: string; orgId: string; brandId: string; slug: string; cents: number; started: string; audienceId: string | null }
let RUNS: Run[] = [];
const BASE_RUNS: Run[] = [
  { campaignId: "c-own", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 6000, started: D30, audienceId: "aud-1" },
  { campaignId: "c-own", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 20000, started: D5, audienceId: "aud-1" },
  { campaignId: "c-other", orgId: OTHER_ORG, brandId: OTHER_BRAND, slug: "wf-old", cents: 4000, started: D40, audienceId: null },
  { campaignId: "c-own", orgId: ORG, brandId: BRAND, slug: "wf-new", cents: 3000, started: D3, audienceId: "aud-1" },
  { campaignId: "c-conv", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 5000, started: D30, audienceId: "aud-1" },
  { campaignId: "c-conv", orgId: ORG, brandId: BRAND, slug: "wf-new", cents: 5000, started: D4, audienceId: "aud-1" },
];

let seq = 0;
/** `n` leads served at `servedAt` under one (campaign, workflow); the first `clicks` visited, the first `replies` replied. */
function lead(
  n: number,
  shape: { orgId: string; brandId: string; campaignId: string; slug: string; servedAt: string | "unstated"; clicks?: number; replies?: number; audienceId?: string | null },
) {
  return Array.from({ length: n }, (_, i) => {
    const id = `L${++seq}`;
    return {
      leadId: id,
      email: `${id}@x.com`,
      orgId: shape.orgId,
      brandId: shape.brandId,
      campaignId: shape.campaignId,
      workflowSlug: shape.slug,
      ...(shape.servedAt === "unstated" ? {} : { servedAt: shape.servedAt }),
      audienceId: shape.audienceId ?? null,
      signals: { contacted: true, clicked: i < (shape.clicks ?? 0), positiveReply: i < (shape.replies ?? 0) },
    };
  });
}
const own = { orgId: ORG, brandId: BRAND };
const other = { orgId: OTHER_ORG, brandId: OTHER_BRAND };
function basePersons() {
  seq = 0;
  return [
    ...lead(60, { ...own, campaignId: "c-own", slug: "wf-old", servedAt: D30, clicks: 12, audienceId: "aud-1" }),
    ...lead(50, { ...own, campaignId: "c-own", slug: "wf-old", servedAt: D5, clicks: 2, audienceId: "aud-1" }),
    ...lead(40, { ...other, campaignId: "c-other", slug: "wf-old", servedAt: D40, clicks: 8 }),
    ...lead(30, { ...own, campaignId: "c-own", slug: "wf-new", servedAt: D3, clicks: 3, audienceId: "aud-1" }),
    ...lead(20, { ...own, campaignId: "c-conv", slug: "wf-old", servedAt: D30, replies: 1, audienceId: "aud-1" }),
    ...lead(20, { ...own, campaignId: "c-conv", slug: "wf-new", servedAt: D4, replies: 2, audienceId: "aud-1" }),
  ];
}

function scopeFilter(u: URL, headers: Record<string, string>, isPublic: boolean) {
  const one = u.searchParams.get("campaignId");
  const many = u.searchParams.get("campaignIds");
  const ids = one ? new Set([one]) : many ? new Set(many.split(",")) : null;
  const brand = u.searchParams.get("brandId");
  const audience = u.searchParams.get("audienceId");
  return (r: { orgId: string; brandId: string; campaignId: string; audienceId?: string | null }) =>
    (!ids || ids.has(r.campaignId)) &&
    (isPublic || r.orgId === headers["x-org-id"]) &&
    (!brand || r.brandId === brand) &&
    (!audience || r.audienceId === audience);
}

function mockFetch(opts: { failMatureCosts?: boolean } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (opts.failMatureCosts && url.includes("/v1/stats/costs") && u.searchParams.get("startedBefore")) {
      return new Response("runs-service down", { status: 500 });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/campaigns/list")) return json({ campaigns: CAMPAIGNS });
    if (url.includes("/internal/feature-memberships")) {
      const seen = new Map<string, { orgId: string; brandId: string; workflowSlug: string }>();
      for (const p of fixture.persons) seen.set(`${p.orgId}|${p.brandId}|${p.workflowSlug}`, { orgId: p.orgId, brandId: p.brandId, workflowSlug: p.workflowSlug });
      return json({ memberships: [...seen.values()] });
    }
    if (url.includes("/v1/stats/public/costs") || url.includes("/v1/stats/costs")) {
      const keep = scopeFilter(u, headers, url.includes("/public/"));
      const before = u.searchParams.get("startedBefore");
      const after = u.searchParams.get("startedAfter");
      const dims = (u.searchParams.get("groupBy") ?? "").split(",").filter(Boolean);
      const groups = new Map<string, any>();
      for (const r of RUNS) {
        if (!keep(r)) continue;
        if (before && r.started > before) continue;
        if (after && r.started < after) continue;
        const d: Record<string, string | null> = {};
        for (const k of dims) d[k] = k === "workflowSlug" ? r.slug : (r as any)[k] ?? null;
        const key = JSON.stringify(d);
        const g = groups.get(key) ?? { dimensions: d, totalCostInUsdCents: "0", netTotalCostInUsdCents: "0", runCount: 0 };
        g.totalCostInUsdCents = String(Number(g.totalCostInUsdCents) + r.cents);
        g.netTotalCostInUsdCents = g.totalCostInUsdCents;
        g.runCount += 1;
        groups.set(key, g);
      }
      return json({ groups: [...groups.values()] });
    }
    if (url.includes("/orgs/stats") || url.includes("/public/stats")) {
      // The sender's per-slug recipient counts: every lead of the scope, whenever it was served.
      const keep = scopeFilter(u, headers, url.includes("/public/"));
      const groups = new Map<string, any>();
      for (const p of fixture.persons) {
        if (!keep(p as any)) continue;
        const g = groups.get(p.workflowSlug) ?? { key: p.workflowSlug, broadcast: { recipientStats: { contacted: 0, clicked: 0, repliesPositive: 0 } } };
        g.broadcast.recipientStats.contacted += 1;
        if (p.signals.clicked) g.broadcast.recipientStats.clicked += 1;
        if (p.signals.positiveReply) g.broadcast.recipientStats.repliesPositive += 1;
        groups.set(p.workflowSlug, g);
      }
      return json({ groups: [...groups.values()] });
    }
    if (url.includes("/offer-economics")) return json(offerEconomicsFromDeclared(FUNNELS));
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: "aud-1", name: "A", status: "active", filters: {}, availableToContactCount: 10 }] });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&pricing=net&${query}`).set(AUTH);
const brandRow = (body: any, dynasty: string) =>
  body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === dynasty);
const audienceRow = (body: any, dynasty: string) =>
  body.rows.find((r: any) => r.audienceId === "aud-1" && r.workflow.workflowDynastySlug === dynasty);

describe("a leg-keyed ladder prices a MATURE workflow on its mature evidence (features-service#1196)", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    __resetLegFleetEvidence();
    __resetFleetPositiveRepliers();
    RUNS = [...BASE_RUNS];
    fixture.persons = basePersons();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("echoes the leg's rule: 21 days, 10 visits, cut at UTC midnight 21 days ago", async () => {
    const res = await get(`leg=${VISIT}`);
    expect(res.status).toBe(200);
    expect(res.body.maturity).toMatchObject({
      // The legacy `?leg=` still reads; an outbound channel's leg is served in its new spelling (wave 2).
      legKey: "lead_found_to_website_visit",
      durationDays: 21,
      outcomesRequired: 10,
      outcomeSignal: "clicked",
      measured: true,
      unmeasuredReason: null,
    });
    expect(res.body.maturity.cutoffIso).toBe(maturityCutoffIso(21));
  });

  it("the leader is MATURE on the fleet and priced on its mature figure; the newcomer keeps flash — the ladder is gone", async () => {
    const res = await get(`leg=${VISIT}`);
    const old = brandRow(res.body, "dyn-old");
    const fresh = brandRow(res.body, "dyn-new");

    expect(old.maturity).toMatchObject({ basis: "mature", isMature: true, matureOutcomes: 20 });
    // $100 of runs started before the cutoff over the 20 visits of the leads they served.
    expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(5, 6);
    expect(old.maturity.resolved.mature.costPerOutcomeUsd).toBeCloseTo(5, 6);
    // THE DIVERGENCE: everything to date reads $260 over 14 visits at the brand grain.
    expect(old.maturity.resolved.flash.costPerOutcomeUsd).toBeCloseTo(260 / 14, 6);

    expect(fresh.maturity).toMatchObject({ basis: "flash", isMature: false, matureOutcomes: 0 });
    expect(fresh.resolved.costPerOutcomeUsd).toBeCloseTo(10, 6);

    // On flash alone the newcomer ($10) outranks the leader ($18.57). On the rule, the leader leads.
    expect(old.rank).toBe(1);
    expect(fresh.rank).toBe(2);
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-old");
  });

  it("every grain block states BOTH versions and its own verdict, and the row's grains are on the row's version", async () => {
    const res = await get(`leg=${VISIT}`);
    const old = brandRow(res.body, "dyn-old");
    const fleet = old.estimatesByGrain.crossOrg;
    expect(fleet.basis).toBe("mature");
    expect(fleet.flash).toMatchObject({ spentUsd: 300, contacted: 150, outcomes: 22 });
    expect(fleet.mature).toMatchObject({ spentUsd: 100, contacted: 100, outcomes: 20, costPerOutcomeUsd: 5 });
    expect(fleet.isMature).toBe(true);
    // The block's own evidence is the mature version's.
    expect(fleet.evidence.spentUsd).toBeCloseTo(100, 6);
    expect(fleet.evidence.observedClicks).toBe(20);

    const brand = old.estimatesByGrain.brand;
    expect(brand.basis).toBe("mature");
    expect(brand.flash).toMatchObject({ spentUsd: 260, contacted: 110, outcomes: 14 });
    expect(brand.mature).toMatchObject({ spentUsd: 60, contacted: 60, outcomes: 12, costPerOutcomeUsd: 5 });
    expect(brand.isMature).toBe(true);

    // The newcomer: priced on flash, its mature cut holds nothing yet.
    const freshFleet = brandRow(res.body, "dyn-new").estimatesByGrain.crossOrg;
    expect(freshFleet.basis).toBe("flash");
    expect(freshFleet.mature).toMatchObject({ spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null });
    expect(freshFleet.isMature).toBe(false);
  });

  it("YOUNG spend never moves a mature workflow's price", async () => {
    const before = brandRow((await get(`leg=${VISIT}`)).body, "dyn-old");
    __resetLegFleetEvidence();
    __resetFleetPositiveRepliers();
    // Three more weeks' worth of fresh sends, none of their visits in yet.
    RUNS.push({ campaignId: "c-own", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 90000, started: D3, audienceId: "aud-1" });
    fixture.persons.push(...lead(300, { ...own, campaignId: "c-own", slug: "wf-old", servedAt: D3, audienceId: "aud-1" }));
    const after = brandRow((await get(`leg=${VISIT}`)).body, "dyn-old");
    expect(after.resolved.costPerOutcomeUsd).toBe(before.resolved.costPerOutcomeUsd);
    // The flash figure absorbed it, which is exactly what used to price the leader out.
    expect(after.maturity.resolved.flash.costPerOutcomeUsd).toBeGreaterThan(before.maturity.resolved.flash.costPerOutcomeUsd * 3);
  });

  it("the audience row of a mature workflow draws on the audience's MATURE evidence", async () => {
    const res = await get(`leg=${VISIT}`);
    const aud = audienceRow(res.body, "dyn-old");
    expect(aud.maturity.basis).toBe("mature");
    const block = aud.estimatesByGrain.audience;
    expect(block.basis).toBe("mature");
    // aud-1 served 60 leads before the cutoff under wf-old on the leg: $60, 12 visits.
    expect(block.mature).toMatchObject({ spentUsd: 60, contacted: 60, outcomes: 12 });
    expect(block.flash).toMatchObject({ spentUsd: 260, contacted: 110, outcomes: 14 });
    expect(aud.resolved.costPerOutcomeUsd).toBeCloseTo(5, 6);
  });

  it("a NON-mature workflow is priced EXACTLY as before: byte-equal to a read where the cut could not be made", async () => {
    const cut = brandRow((await get(`leg=${VISIT}`)).body, "dyn-new");
    __resetLegFleetEvidence();
    __resetFleetPositiveRepliers();
    // One lead-service row without a serve date: the whole answer falls back to flash.
    fixture.persons.push(...lead(1, { ...other, campaignId: "c-other", slug: "wf-old", servedAt: "unstated" }));
    const res = await get(`leg=${VISIT}`);
    const uncut = brandRow(res.body, "dyn-new");
    expect(uncut.resolved).toEqual(cut.resolved);
    expect(res.body.maturity).toMatchObject({ measured: false, unmeasuredReason: "serve_dates_unavailable" });
  });

  it("when the cut cannot be made every row is priced on flash and says so — the leader reads its old figure", async () => {
    fixture.persons.push(...lead(1, { ...other, campaignId: "c-other", slug: "wf-old", servedAt: "unstated" }));
    const res = await get(`leg=${VISIT}`);
    const old = brandRow(res.body, "dyn-old");
    expect(old.maturity).toMatchObject({ basis: "flash", isMature: null, matureOutcomes: null });
    expect(old.maturity.resolved.mature).toBeNull();
    expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(260 / 14, 6);
  });

  it("the CONVERSATION leg judges on its own bar of ONE positive reply", async () => {
    const res = await get(`leg=${CONVERSATION}`);
    expect(res.status).toBe(200);
    expect(res.body.maturity).toMatchObject({ durationDays: 21, outcomesRequired: 1, outcomeSignal: "positiveReply" });
    const old = brandRow(res.body, "dyn-old");
    const fresh = brandRow(res.body, "dyn-new");
    // One mature reply (a lead served 30 days ago) is enough; the newcomer's two young replies are not mature.
    expect(old.maturity).toMatchObject({ basis: "mature", isMature: true, matureOutcomes: 1 });
    expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(50, 6);
    expect(fresh.maturity).toMatchObject({ basis: "flash", isMature: false, matureOutcomes: 0 });
    expect(fresh.resolved.costPerOutcomeUsd).toBeCloseTo(25, 6);
  });

  it("RECONCILES: the campaign grain's mature spend and outcomes, summed over workflows, are the campaign's mature totals to the cent", async () => {
    const res = await get(`leg=${VISIT}&campaignId=c-own`);
    expect(res.status).toBe(200);
    const rows = res.body.rows.filter((r: any) => r.audienceId === null && r.estimatesByGrain.campaign);
    const spent = rows.reduce((s: number, r: any) => s + r.estimatesByGrain.campaign.mature.spentUsd, 0);
    const outcomes = rows.reduce((s: number, r: any) => s + r.estimatesByGrain.campaign.mature.outcomes, 0);
    const cutoff = maturityCutoffIso(21);
    const ledgerCents = BASE_RUNS.filter((r) => r.campaignId === "c-own" && r.started < cutoff).reduce((s, r) => s + r.cents, 0);
    const ledgerVisits = basePersons().filter((p) => p.campaignId === "c-own" && p.servedAt! < cutoff && p.signals.clicked).length;
    expect(Math.round(spent * 100)).toBe(ledgerCents);
    expect(outcomes).toBe(ledgerVisits);
  });

  it("a FLEET-MATURE workflow keeps a YOUNG mission's grain, served on flash with its own verdict (prod 2026-10-01, osprey)", async () => {
    // A mission started 3 days ago: $33.74 of wf-old runs, 20 leads served, 2 visits — nothing mature yet.
    CAMPAIGNS.push({ id: "c-young", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: VISIT });
    RUNS.push({ campaignId: "c-young", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 3374, started: D3, audienceId: "aud-1" });
    fixture.persons.push(...lead(20, { ...own, campaignId: "c-young", slug: "wf-old", servedAt: D3, clicks: 2, audienceId: "aud-1" }));
    try {
      const res = await get(`leg=${VISIT}&campaignId=c-young`);
      expect(res.status).toBe(200);
      const old = brandRow(res.body, "dyn-old");
      // The workflow is still priced on its mature fleet evidence…
      expect(old.maturity).toMatchObject({ basis: "mature", isMature: true });
      expect(old.estimatesByGrain.crossOrg.basis).toBe("mature");
      // …but the mission's grain exists, on flash, with an empty mature half and its own verdict.
      const campaign = old.estimatesByGrain.campaign;
      expect(campaign).toBeDefined();
      expect(campaign.basis).toBe("flash");
      expect(campaign.isMature).toBe(false);
      expect(campaign.flash).toMatchObject({ spentUsd: 33.74, contacted: 20, outcomes: 2 });
      expect(campaign.mature).toMatchObject({ spentUsd: 0, outcomes: 0, costPerOutcomeUsd: null });
      expect(campaign.evidence.spentUsd).toBeCloseTo(33.74, 6);
      // RECONCILES with the mission: summed over workflows, the flash half is the mission's whole spend.
      const rows = res.body.rows.filter((r: any) => r.audienceId === null && r.estimatesByGrain.campaign);
      const spent = rows.reduce((t: number, r: any) => t + r.estimatesByGrain.campaign.flash.spentUsd, 0);
      const visits = rows.reduce((t: number, r: any) => t + r.estimatesByGrain.campaign.flash.outcomes, 0);
      expect(spent).toBeCloseTo(33.74, 6);
      expect(visits).toBe(2);
      // The selection is untouched: the row still resolves on its mature ladder.
      expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(old.maturity.resolved.mature.costPerOutcomeUsd, 9);
    } finally {
      CAMPAIGNS.pop();
    }
  });

  it("a FAILED mature read degrades the answer to flash and says so — it never 502s the ladder", async () => {
    vi.restoreAllMocks();
    mockFetch({ failMatureCosts: true });
    const res = await get(`leg=${VISIT}`);
    expect(res.status).toBe(200);
    expect(res.body.maturity).toMatchObject({ measured: false, unmeasuredReason: "mature_evidence_unavailable" });
    const old = brandRow(res.body, "dyn-old");
    expect(old.maturity).toMatchObject({ basis: "flash", isMature: null });
    expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(260 / 14, 6);
  });

  it("the LEG block's return is read on the SAME version as the rows: the funnel is ranked on the maturity rule too", async () => {
    const res = await get(`leg=${VISIT}`);
    const old = brandRow(res.body, "dyn-old");
    expect(old.maturity.basis).toBe("mature");
    // The basis funnel's best workflow is the mature leader, and the return stated for it is the one its
    // row is priced on — not a flash return beside a mature-priced row.
    expect(res.body.leg.returnPerDollar).toBeCloseTo(old.resolved.roiMultiple, 9);
  });

  it("a LEG-LESS read is byte-unchanged: no maturity anywhere", async () => {
    const res = await get("goal=meetingBooked");
    expect(res.status).toBe(200);
    expect(res.body.maturity).toBeUndefined();
    for (const row of res.body.rows) {
      expect(row.maturity).toBeUndefined();
      for (const block of Object.values(row.estimatesByGrain) as any[]) {
        expect(block).not.toHaveProperty("basis");
        expect(block).not.toHaveProperty("flash");
        expect(block).not.toHaveProperty("mature");
      }
    }
  });
});

describe("heldPriceOn — the cascade walked once, here, never by a reader", () => {
  const block = (cost: number | null) => ({ legOutcome: { costPerOutcomeUsd: cost } });

  it("a grain with its OWN block states its own (floored) price", () => {
    expect(heldPriceOn({ crossOrg: block(2.39), offer: block(2.51) }, "offer")).toEqual({
      costPerOutcomeUsd: 2.51, source: "own", fromGrain: "offer", unpricedReason: null,
    });
  });

  it("a grain with NO block inherits the NEAREST coarser grain's price, provenance stated (rampart)", () => {
    expect(heldPriceOn({ crossOrg: block(2.39) }, "offer")).toEqual({
      costPerOutcomeUsd: 2.39, source: "inherited", fromGrain: "crossOrg", unpricedReason: null,
    });
    // The nearest, never a cheaper one further up: the brand's floor is what the offer would stand on.
    expect(heldPriceOn({ crossOrg: block(1), brand: block(7) }, "campaign")).toMatchObject({
      costPerOutcomeUsd: 7, source: "inherited", fromGrain: "brand",
    });
    expect(heldPriceOn({ crossOrg: block(1), campaign: block(4) }, "audience")).toMatchObject({ costPerOutcomeUsd: 4, fromGrain: "campaign" });
  });

  it("nothing held is NULL with a reason, never 0", () => {
    expect(heldPriceOn({}, "brand")).toEqual({ costPerOutcomeUsd: null, source: null, fromGrain: null, unpricedReason: "no_evidence" });
    expect(heldPriceOn(null, "brand")).toMatchObject({ costPerOutcomeUsd: null, unpricedReason: "mature_cut_unavailable" });
    expect(heldPriceOn({ brand: block(null) }, "brand")).toMatchObject({ costPerOutcomeUsd: null, source: "own", unpricedReason: "leg_unpriceable" });
  });
});

describe("priceByGrain — every grain of a mission row priced on BOTH bases (prod 2026-10-01, osprey / rampart)", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    __resetLegFleetEvidence();
    __resetFleetPositiveRepliers();
    RUNS = [...BASE_RUNS];
    fixture.persons = basePersons();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a fleet-mature row's YOUNG mission grain: mature INHERITED from the brand, flash its OWN figure", async () => {
    CAMPAIGNS.push({ id: "c-young", orgId: ORG, brandIds: [BRAND], featureSlug: SLUG, legKey: VISIT });
    RUNS.push({ campaignId: "c-young", orgId: ORG, brandId: BRAND, slug: "wf-old", cents: 3374, started: D3, audienceId: "aud-1" });
    fixture.persons.push(...lead(20, { ...own, campaignId: "c-young", slug: "wf-old", servedAt: D3, clicks: 2, audienceId: "aud-1" }));
    try {
      const res = await get(`leg=${VISIT}&campaignId=c-young`);
      expect(res.status).toBe(200);
      const old = brandRow(res.body, "dyn-old");
      expect(old.maturity.basis).toBe("mature");
      const campaign = old.priceByGrain.campaign;
      // Flash: the mission's own $33.74 over its own 2 visits.
      expect(campaign.flash).toMatchObject({ source: "own", fromGrain: "campaign", unpricedReason: null });
      expect(campaign.flash.costPerOutcomeUsd).toBeCloseTo(33.74 / 2, 6);
      // Mature: the mission holds none, so it is what its parent holds — the brand's $60 / 12 visits.
      expect(campaign.mature).toMatchObject({ source: "inherited", fromGrain: "brand", unpricedReason: null });
      expect(campaign.mature.costPerOutcomeUsd).toBeCloseTo(5, 6);
      // …which is exactly the mature block the brand grain serves, and the fleet's own mature price.
      expect(old.priceByGrain.brand.mature).toMatchObject({ source: "own", fromGrain: "brand" });
      expect(old.priceByGrain.crossOrg.mature.costPerOutcomeUsd).toBeCloseTo(old.estimatesByGrain.crossOrg.legOutcome.costPerOutcomeUsd, 9);
      // The observed blocks and the selection are untouched.
      expect(old.estimatesByGrain.campaign.basis).toBe("flash");
      expect(old.resolved.costPerOutcomeUsd).toBeCloseTo(old.maturity.resolved.mature.costPerOutcomeUsd, 9);

      // A workflow the mission never ran: flash inherited from its brand ($30 / 3 visits), and nothing
      // mature anywhere — null with a reason, never the flash figure under the mature name.
      const fresh = brandRow(res.body, "dyn-new");
      expect(fresh.estimatesByGrain.campaign).toBeUndefined();
      expect(fresh.priceByGrain.campaign.flash).toMatchObject({ source: "inherited", fromGrain: "brand" });
      expect(fresh.priceByGrain.campaign.flash.costPerOutcomeUsd).toBeCloseTo(10, 6);
      expect(fresh.priceByGrain.campaign.mature).toEqual({ costPerOutcomeUsd: null, source: null, fromGrain: null, unpricedReason: "no_evidence" });
    } finally {
      CAMPAIGNS.pop();
    }
  });

  it("audience rows list the audience grain; a leg-less read carries no priceByGrain", async () => {
    const res = await get(`leg=${VISIT}`);
    const aud = audienceRow(res.body, "dyn-old");
    expect(Object.keys(aud.priceByGrain).sort()).toEqual(["audience", "brand", "crossOrg"]);
    expect(aud.priceByGrain.audience.mature).toMatchObject({ source: "own", fromGrain: "audience" });
    const legless = await get("goal=meetingBooked");
    for (const row of legless.body.rows) expect(row.priceByGrain).toBeUndefined();
  });
});
