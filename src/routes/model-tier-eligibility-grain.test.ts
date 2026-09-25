/**
 * THE VERDICT ON THE WIRE — one fixture shaped like the campaign that motivated it.
 *
 * Prod 2026-09-14, brand `75d7e3e8…` / campaign `f7b1b610…` / leg `start_to_conversation`: the
 * channel's catalogue holds 27 active workflow dynasties, of which SIX write their emails with a
 * cheap-tier model (`flash` ×3, `deepseek-flash`, `flash-pro`, `glm-flash`) — and `flash-pro` is one
 * of them despite containing "pro", which is why the tier is READ from chat-service and never derived
 * from the alias string.
 *
 * The fixture keeps that shape at four dynasties:
 *
 *   lithium   → "pro"        strong    eligible on a conversation leg, EXCLUDED on a visit leg
 *   sodium    → "flash"      cheap     EXCLUDED on a conversation leg, eligible on a visit leg
 *   argon     → "flash-pro"  cheap     the counter-example: EXCLUDED on a conversation leg
 *   neon      → (none)       unknown   ELIGIBLE on every leg, with the gap stated
 *
 * Every case asserts a DIVERGENCE — two legs disagreeing about one workflow, or the verdict
 * disagreeing with the alias string — so a suite that only checked "a block came back" would pass on
 * the inert implementation this ship must not be.
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
process.env.CHAT_SERVICE_URL = "http://chat:3000";
process.env.CHAT_SERVICE_API_KEY = "chat-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const AUD = "aud-1";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

/** The brand declares BOTH a conversation funnel and a website-led one, so both legs are answerable. */
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const CONVERSATION_FUNNEL = {
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Conversation",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 20, meetingToClosePct: 50, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 5000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-14T00:00:00.000Z",
};
const WEBSITE_FUNNEL = {
  funnelKey: "website_purchases",
  name: "Website Purchases",
  steps: ["Website visit", "Signup", "Paid client"],
  rates: { visitToSignupPct: 4, signupToPaidClientPct: 50 },
  lifetimeRevenueUsd: 5000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const wf = (dynasty: string, version = 1, status = "active") => ({
  id: `${dynasty}-${version}`,
  workflowSlug: `wf-${dynasty}-v${version}`,
  workflowName: `${dynasty} v${version}`,
  workflowDynastyName: dynasty,
  workflowDynastySlug: dynasty,
  version,
  status,
  workflowDynastyStatus: "active",
  featureSlug: "x",
  createdForBrandId: null,
  upgradedTo: null,
});
const DYNASTIES = ["lithium", "sodium", "argon", "neon"];
const PUBLIC_WORKFLOWS = DYNASTIES.map((d) => wf(d));

/** workflow-service `GET /workflows` — the FULL shape, which carries `contentModel`. */
const MODEL_BY_DYNASTY: Record<string, string | null> = {
  lithium: "pro",
  sodium: "flash",
  argon: "flash-pro",
  neon: null,
};
const FULL_WORKFLOWS = DYNASTIES.map((d) => ({ ...wf(d), contentModel: MODEL_BY_DYNASTY[d] }));

/** chat-service `GET /internal/models` — the alias → tier catalogue, taken verbatim. */
const TIER_CATALOGUE = {
  models: [
    { provider: "google", model: "pro", capabilityTier: "strong" },
    { provider: "google", model: "flash", capabilityTier: "cheap" },
    { provider: "google", model: "flash-pro", capabilityTier: "cheap" },
    { provider: "anthropic", model: "fable", capabilityTier: "frontier" },
  ],
};

const cost = (slug: string, cents: number, audienceId?: string) => ({
  dimensions: audienceId ? { workflowSlug: slug, audienceId } : { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 5,
  minStartedAt: null,
  maxStartedAt: null,
});
const email = (slug: string, contacted: number, repliesPositive: number, clicked = 0) => ({
  key: slug,
  broadcast: {
    recipientStats: {
      contacted,
      sent: contacted,
      delivered: contacted,
      opened: 0,
      clicked,
      bounced: 0,
      repliesPositive,
      repliesNegative: 0,
      repliesNeutral: 0,
      repliesAutoReply: 0,
    },
  },
});

interface Options {
  /** Replaces the chat-service catalogue response. `"fail"` makes the read non-OK. */
  tierCatalogue?: unknown | "fail";
  /** Replaces the workflow-service full listing. `"fail"` makes the read non-OK. */
  fullWorkflows?: unknown | "fail";
  /** Overrides a dynasty's brand-grain positive replies (default 10 + its index). */
  brandReplies?: Record<string, number>;
}

let requestedUrls: string[] = [];

function mockFetch(options: Options = {}): void {
  requestedUrls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    requestedUrls.push(url);
    const u = new URL(url, "http://x");

    if (url.includes("/internal/models")) {
      if (options.tierCatalogue === "fail") return new Response("nope", { status: 503 });
      return json(options.tierCatalogue ?? TIER_CATALOGUE);
    }
    if (url.includes("/public/workflows")) return json({ workflows: PUBLIC_WORKFLOWS });
    // The full listing is the one that carries contentModel. Matched AFTER /public/workflows so the
    // narrower path wins (substring order matters — "/workflows" is a substring of both).
    if (u.pathname === "/workflows") {
      if (options.fullWorkflows === "fail") return new Response("nope", { status: 503 });
      return json(options.fullWorkflows ?? { workflows: FULL_WORKFLOWS });
    }
    if (url.includes("/v1/stats/public/costs")) {
      return json({ groups: DYNASTIES.map((d) => cost(`wf-${d}-v1`, 5_000_000)) });
    }
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) {
        return json({ groups: DYNASTIES.map((d) => cost(`wf-${d}-v1`, 20_000, AUD)) });
      }
      return json({ groups: DYNASTIES.map((d) => cost(`wf-${d}-v1`, 100_000)) });
    }
    if (url.includes("/orgs/stats")) {
      const audienceId = u.searchParams.get("audienceId");
      if (audienceId === AUD) return json({ groups: DYNASTIES.map((d) => email(`wf-${d}-v1`, 200, 2, 20)) });
      if (audienceId) return json({ groups: [] });
      return json({
        groups: DYNASTIES.map((d, i) => email(`wf-${d}-v1`, 1000, options.brandReplies?.[d] ?? 10 + i, 100 + i)),
      });
    }
    if (url.includes("/public/stats")) {
      return json({ groups: DYNASTIES.map((d) => email(`wf-${d}-v1`, 9000, 100, 900)) });
    }
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL, WEBSITE_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: AUD, name: "Aud", status: "active", filters: {} }] });
    }
    if (url.includes("/campaigns")) return json({ campaigns: [] });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
/** The verdict of one dynasty — identical on every row of it, asserted below. */
const verdictOf = (body: any, dynasty: string) =>
  body.rows.find((r: any) => r.workflow.workflowDynastySlug === dynasty)?.modelEligibility;
const excludedSet = (body: any) =>
  [...new Set(body.rows.filter((r: any) => r.modelEligibility?.eligible === false).map((r: any) => r.workflow.workflowDynastySlug))].sort();

describe("a leg-keyed row states whether the model writing its emails is right for that leg", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("EXCLUDES the cheap tier on a leg that sells a conversation, and nothing else", async () => {
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);

    expect(excludedSet(res.body)).toEqual(["argon", "sodium"]);
    expect(verdictOf(res.body, "lithium")).toMatchObject({ modelAlias: "pro", modelTier: "strong", eligible: true });
    expect(verdictOf(res.body, "sodium")).toMatchObject({ modelAlias: "flash", modelTier: "cheap", eligible: false });
  });

  it("EXCLUDES the strong and frontier tiers on a leg that sells a website visit — the exact inverse", async () => {
    const conversation = await get("leg=start_to_conversation");
    const visit = await get("leg=start_to_website_visit");
    expect(visit.status).toBe(200);

    expect(excludedSet(visit.body)).toEqual(["lithium"]);
    // The SAME two workflows, opposite verdicts. A suite that only asserted one leg would pass on an
    // implementation that hardcoded the conversation rule.
    expect(verdictOf(conversation.body, "sodium").eligible).toBe(false);
    expect(verdictOf(visit.body, "sodium").eligible).toBe(true);
    expect(verdictOf(conversation.body, "lithium").eligible).toBe(true);
    expect(verdictOf(visit.body, "lithium").eligible).toBe(false);
  });

  it("excludes NOTHING on a leg the study is silent about", async () => {
    const res = await get("leg=meeting_booked_to_meeting_attended");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(excludedSet(res.body)).toEqual([]);
    // The tier is still stated where it decides nothing.
    expect(verdictOf(res.body, "sodium")).toMatchObject({ modelTier: "cheap", eligible: true });
  });

  it("reads `flash-pro` off the catalogue as CHEAP — never derived from the string", async () => {
    const res = await get("leg=start_to_conversation");
    const argon = verdictOf(res.body, "argon");
    expect(argon).toMatchObject({ modelAlias: "flash-pro", modelTier: "cheap", eligible: false });
    // The substring rule would have said the opposite, and `pro` — which IS strong — proves the two
    // answers genuinely diverge on this fixture.
    expect(verdictOf(res.body, "lithium").eligible).toBe(true);
  });

  it("keeps an EXCLUDED workflow on the body, with its figures, its rank and its history", async () => {
    const res = await get("leg=start_to_conversation");

    const sodiumRows = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === "sodium");
    expect(sodiumRows.length).toBeGreaterThan(0);
    for (const row of sodiumRows) {
      expect(row.modelEligibility.eligible).toBe(false);
      expect(row.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
      expect(row.rank).toBeGreaterThan(0);
      expect(row.scopeRank).toBeGreaterThan(0);
      expect(row.measured).toBe(true);
    }
  });

  it("states ONE verdict per workflow — every row of a dynasty carries the same one", async () => {
    const res = await get("leg=start_to_conversation");
    for (const dynasty of DYNASTIES) {
      const rows = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === dynasty);
      expect(rows.length).toBeGreaterThan(1);
      const first = JSON.stringify(rows[0].modelEligibility);
      for (const row of rows) expect(JSON.stringify(row.modelEligibility)).toBe(first);
    }
  });

  it("MOVES NO FIGURE: every row's numbers are what they were — only the orders and the pick move", async () => {
    const withCatalogue = await get("leg=start_to_conversation");
    // The same read with both producers down — every verdict flips to unknowable-but-eligible, so any
    // difference in a row's FIGURES would be the verdict having leaked into the math.
    mockFetch({ tierCatalogue: "fail", fullWorkflows: "fail" });
    const without = await get("leg=start_to_conversation");

    const figures = (body: any) =>
      body.rows
        .map(({ modelEligibility, rank, scopeRank, ...rest }: any) => rest)
        .sort((a: any, b: any) =>
          `${a.workflow.workflowDynastySlug}|${a.audienceId}`.localeCompare(`${b.workflow.workflowDynastySlug}|${b.audienceId}`),
        );
    expect(figures(without.body)).toEqual(figures(withCatalogue.body));
    expect(without.body.rows.length).toBe(withCatalogue.body.rows.length);
  });
});

describe("an unknowable tier is ELIGIBLE, loudly", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a workflow whose DAG names no model eligible, and says so", async () => {
    mockFetch();
    const res = await get("leg=start_to_conversation");
    const neon = verdictOf(res.body, "neon");
    expect(neon).toMatchObject({ modelAlias: null, modelTier: null, eligible: true, ineligibleReason: null });
    expect(neon.unknownTierReason).toContain("names no content model");
  });

  it("keeps a workflow naming an alias the catalogue does not carry eligible", async () => {
    mockFetch({ tierCatalogue: { models: [{ provider: "google", model: "pro", capabilityTier: "strong" }] } });
    const res = await get("leg=start_to_conversation");
    const sodium = verdictOf(res.body, "sodium");
    expect(sodium).toMatchObject({ modelAlias: "flash", modelTier: null, eligible: true });
    expect(sodium.unknownTierReason).toContain("carries no entry for the alias");
    // The alias that IS in the catalogue is still judged, so the read did not degrade wholesale.
    expect(verdictOf(res.body, "lithium")).toMatchObject({ modelTier: "strong", eligible: true });
  });

  it("leaves EVERY row eligible when the tier catalogue read fails — never an exclusion on a failed read", async () => {
    mockFetch({ tierCatalogue: "fail" });
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(excludedSet(res.body)).toEqual([]);
    for (const row of res.body.rows) {
      expect(row.modelEligibility.eligible).toBe(true);
      expect(row.modelEligibility.modelTier).toBeNull();
      expect(row.modelEligibility.unknownTierReason).toContain("could not be read on this request");
    }
  });

  it("leaves EVERY row eligible when the workflow models read fails, with a DIFFERENT reason", async () => {
    mockFetch({ fullWorkflows: "fail" });
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(excludedSet(res.body)).toEqual([]);
    for (const row of res.body.rows) {
      expect(row.modelEligibility.unknownTierReason).toContain("workflow-service could not be asked");
    }
  });

  it("refuses a catalogue entry that states no usable tier rather than half-populating the map", async () => {
    mockFetch({ tierCatalogue: { models: [{ provider: "google", model: "pro", capabilityTier: "premium" }] } });
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    // A malformed catalogue is an unreadable one: no row is judged, none is excluded.
    expect(excludedSet(res.body)).toEqual([]);
    expect(verdictOf(res.body, "lithium").unknownTierReason).toContain("could not be read on this request");
  });

  it("drops an alias two providers disagree about, leaving workflows naming it eligible", async () => {
    mockFetch({
      tierCatalogue: {
        models: [
          { provider: "google", model: "flash", capabilityTier: "cheap" },
          { provider: "moonshot", model: "flash", capabilityTier: "frontier" },
          { provider: "google", model: "flash-pro", capabilityTier: "cheap" },
        ],
      },
    });
    const res = await get("leg=start_to_conversation");
    expect(verdictOf(res.body, "sodium")).toMatchObject({ modelAlias: "flash", modelTier: null, eligible: true });
    // The unambiguous alias in the same catalogue is still judged.
    expect(verdictOf(res.body, "argon")).toMatchObject({ modelTier: "cheap", eligible: false });
  });
});

describe("the verdict rides `?leg=` only", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("carries NO verdict on a funnel- or goal-keyed read, and spends NO read on one", async () => {
    for (const query of ["funnel=sales_meetings_from_conversation", "goal=meetingBooked"]) {
      mockFetch();
      const res = await get(query);
      expect(res.status).toBe(200);
      expect(res.body.rows.length).toBeGreaterThan(0);
      for (const row of res.body.rows) expect(row.modelEligibility).toBeUndefined();
      expect(requestedUrls.filter((u) => u.includes("/internal/models"))).toHaveLength(0);
      expect(requestedUrls.filter((u) => new URL(u, "http://x").pathname === "/workflows")).toHaveLength(0);
    }
  });

  it("asks each producer exactly ONCE on a leg-keyed read, on the documented request shape", async () => {
    await get("leg=start_to_conversation");

    const catalogue = requestedUrls.filter((u) => u.includes("/internal/models"));
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]).toBe("http://chat:3000/internal/models");

    const listing = requestedUrls.filter((u) => new URL(u, "http://x").pathname === "/workflows");
    expect(listing).toHaveLength(1);
    const q = new URL(listing[0], "http://x").searchParams;
    expect(q.get("featureSlug")).toBe("sales-cold-email-outreach");
    // `all`, not `active`: a RETIRED lineage still carries rows and must resolve to the model its last
    // version named rather than vanishing into "no model stated".
    expect(q.get("status")).toBe("all");
  });
});

/**
 * THE VERDICT DECIDES THE PICK AND THE ORDER — prod 2026-09-24, campaign `c8133eca…` on a leg selling a
 * positive reply: a cheap-tier workflow carrying `eligible: false` was `rank: 1` and the recommendation,
 * so onboarding created the campaign on it and its very first run executed it.
 *
 * The fixture makes `sodium` (cheap, EXCLUDED on this leg) the cheapest workflow by a wide margin, and
 * every audience cell ties so the slug tie-break would put `argon` (cheap, EXCLUDED) first in that
 * column. Every case asserts the DIVERGENCE from what the verdict-blind order says on the same fixture.
 */
describe("an EXCLUDED workflow is never put forward", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  const CHEAP_SODIUM = { brandReplies: { sodium: 50 } };
  const rankOf = (body: any, dynasty: string) =>
    body.rows.find((r: any) => r.workflow.workflowDynastySlug === dynasty).rank;

  it("never recommends it, even when it is the cheapest workflow by far", async () => {
    // Verdict-blind (both producers down → everything eligible): sodium wins.
    mockFetch({ ...CHEAP_SODIUM, tierCatalogue: "fail", fullWorkflows: "fail" });
    const blind = await get("leg=start_to_conversation");
    expect(blind.body.recommendedWorkflowDynastySlug).toBe("sodium");

    mockFetch(CHEAP_SODIUM);
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(verdictOf(res.body, "sodium").eligible).toBe(false);
    expect(res.body.recommendedWorkflowDynastySlug).not.toBe("sodium");
    expect(verdictOf(res.body, res.body.recommendedWorkflowDynastySlug).eligible).toBe(true);
    expect(rankOf(res.body, res.body.recommendedWorkflowDynastySlug)).toBe(1);
    expect(res.body.recommendationWithheldReason).toBeUndefined();
    // Budget is priced off the ELIGIBLE pick, not the excluded cheaper one.
    expect(res.body.recommendedBudgetUsd).not.toBe(blind.body.recommendedBudgetUsd);
  });

  it("ranks EVERY eligible workflow above EVERY excluded one", async () => {
    mockFetch(CHEAP_SODIUM);
    const res = await get("leg=start_to_conversation");
    const eligibleRanks = res.body.rows.filter((r: any) => r.modelEligibility.eligible).map((r: any) => r.rank);
    const excludedRanks = res.body.rows.filter((r: any) => !r.modelEligibility.eligible).map((r: any) => r.rank);
    expect(excludedRanks.length).toBeGreaterThan(0);
    expect(Math.max(...eligibleRanks)).toBeLessThan(Math.min(...excludedRanks));
    // Among the excluded, the usual order still holds: sodium (cheapest) before argon.
    expect(rankOf(res.body, "sodium")).toBeLessThan(rankOf(res.body, "argon"));
  });

  it("ranks every eligible row above every excluded row in EACH scope's column", async () => {
    // Verdict-blind, the audience column ties and the slug puts argon (excluded) first.
    mockFetch({ ...CHEAP_SODIUM, tierCatalogue: "fail", fullWorkflows: "fail" });
    const blind = await get("leg=start_to_conversation");
    const blindAud = blind.body.rows.find((r: any) => r.audienceId === AUD && r.scopeRank === 1);
    expect(["argon", "sodium"]).toContain(blindAud.workflow.workflowDynastySlug);

    mockFetch(CHEAP_SODIUM);
    const res = await get("leg=start_to_conversation");
    const scopes = new Set(res.body.rows.map((r: any) => r.audienceId));
    expect(scopes.size).toBeGreaterThan(1);
    for (const scope of scopes) {
      const col = res.body.rows.filter((r: any) => r.audienceId === scope);
      const eligible = col.filter((r: any) => r.modelEligibility.eligible).map((r: any) => r.scopeRank);
      const excluded = col.filter((r: any) => !r.modelEligibility.eligible).map((r: any) => r.scopeRank);
      expect(excluded.length).toBeGreaterThan(0);
      expect(Math.max(...eligible)).toBeLessThan(Math.min(...excluded));
      // Still a total order: 1..n, no ties, no gaps.
      expect(col.map((r: any) => r.scopeRank).sort((a: number, b: number) => a - b)).toEqual(col.map((_: any, i: number) => i + 1));
    }
  });

  it("keeps the excluded rows on the body, flagged, with their figures", async () => {
    mockFetch(CHEAP_SODIUM);
    const res = await get("leg=start_to_conversation");
    const sodium = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === "sodium");
    expect(sodium.length).toBeGreaterThan(1);
    for (const row of sodium) {
      expect(row.modelEligibility.eligible).toBe(false);
      expect(row.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
    }
  });

  it("says so — and recommends nothing — when EVERY workflow is excluded", async () => {
    mockFetch({
      fullWorkflows: { workflows: DYNASTIES.map((d) => ({ ...wf(d), contentModel: "flash" })) },
    });
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(excludedSet(res.body)).toEqual([...DYNASTIES].sort());
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendedBudgetUsd).toBeNull();
    expect(res.body.recommendationWithheldReason).toBe("no_eligible_workflow");
    // Rows are all still served and still ranked.
    expect(res.body.rows.every((r: any) => r.rank > 0 && r.scopeRank > 0)).toBe(true);
  });

  it("changes nothing on a funnel-keyed read, which carries no verdict", async () => {
    mockFetch(CHEAP_SODIUM);
    const res = await get("funnel=sales_meetings_from_conversation");
    expect(res.status).toBe(200);
    expect(res.body.recommendedWorkflowDynastySlug).toBe("sodium");
    expect(res.body.recommendationWithheldReason).toBeUndefined();
  });
});
