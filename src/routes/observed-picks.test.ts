/**
 * WHAT ACTUALLY RAN, AGAINST WHAT THE CAMPAIGN ROW WAS CONFIGURED WITH.
 *
 * ONE fixture shaped like the campaign that reported it (prod 2026-09-14, brand `75d7e3e8…` /
 * campaign `f7b1b610…`): the identity is THREE stored rows, the live one is configured with
 * **rudder**, and rudder has never served anything. lithium ran this morning on one audience,
 * cerulean ran two days ago on another, and a retired lineage the catalogue no longer describes ran
 * before that under a stopped ancestor.
 *
 * Every case asserts the DIVERGENCE between the configured slug and the observed one, so a suite that
 * only checked "a block came back" would pass on the implementation this replaces — which badged the
 * configured column and was wrong for every campaign whose workflow the bandit had ever switched.
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
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

/** The identity: one live row and two stopped ancestors, exactly as campaign-service keeps them. */
const LIVE = "f7b1b610-4fa1-4b54-8fec-f7be124dc32b";
const OLD_A = "aaaaaaaa-4fa1-4b54-8fec-f7be124dc32b";
const OLD_B = "bbbbbbbb-4fa1-4b54-8fec-f7be124dc32b";
/** A member of the SAME identity that has never triggered — it must contribute nothing. */
const NEVER_RAN = OLD_B;

const HOT = "aud-hot";
const COLD = "aud-cold";

/** What campaign-service's row SAYS, frozen at creation. Never what actually ran. */
const CONFIGURED_SLUG = "sales-cold-email-outreach-rudder-v3";

const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 0,
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

/** `rudder` is in the catalogue and has never run. The retired lineage is NOT in it. */
const WORKFLOWS = [
  { id: "i1", workflowSlug: "wf-lithium-v6", workflowName: "Lithium v6", workflowDynastyName: "Lithium", workflowDynastySlug: "lithium", version: 6, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i2", workflowSlug: "wf-cerulean-v4", workflowName: "Cerulean v4", workflowDynastyName: "Cerulean", workflowDynastySlug: "cerulean", version: 4, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i3", workflowSlug: CONFIGURED_SLUG, workflowName: "Rudder v3", workflowDynastyName: "Rudder", workflowDynastySlug: "rudder", version: 3, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];

/** The ledger, interleaved across members and NOT in chronological order on the wire. */
const TRIGGER_RUNS: Record<string, Array<Record<string, unknown>>> = {
  [LIVE]: [
    { campaignId: LIVE, workflowSlug: "wf-lithium-v6", audienceId: HOT, startedAt: "2026-09-14T04:07:30.548Z" },
    { campaignId: LIVE, workflowSlug: "wf-cerulean-v4", audienceId: COLD, startedAt: "2026-09-12T02:27:34.602Z" },
  ],
  // A stopped ancestor whose lineage the catalogue no longer describes, and whose oldest trigger
  // predates the audience write-tag entirely.
  [OLD_A]: [
    { campaignId: OLD_A, workflowSlug: "wf-maelstrom-v2", audienceId: null, startedAt: "2026-09-09T15:23:29.688Z" },
    { campaignId: OLD_A, workflowSlug: "wf-lithium-v6", audienceId: COLD, startedAt: "2026-09-13T11:00:00.000Z" },
  ],
  [NEVER_RAN]: [],
};

const cost = (slug: string, cents: number, audienceId?: string) => ({
  dimensions: audienceId ? { workflowSlug: slug, audienceId } : { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 5,
  minStartedAt: null,
  maxStartedAt: null,
});
const email = (slug: string, contacted: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked: 0, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

/** Every `/v1/runs` request the handler made, in order — the request SHAPE is part of the contract. */
let runsRequests: URL[] = [];
let runsFails = false;

function mockFetch(): void {
  runsRequests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/v1/runs?")) {
      runsRequests.push(u);
      if (runsFails) return new Response("boom", { status: 503 });
      // runs-service's `campaignIds` contract: the newest `limit` runs across the whole set.
      const ids = (u.searchParams.get("campaignIds") ?? "").split(",").filter(Boolean);
      const limit = Number(u.searchParams.get("limit"));
      const runs = ids
        .flatMap((id) => (TRIGGER_RUNS[id] ?? []) as Array<{ startedAt: string }>)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit);
      return json({ runs, offset: 0, limit });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: [cost("wf-lithium-v6", 5000000), cost("wf-cerulean-v4", 5000000)] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) {
        return json({ groups: [cost("wf-lithium-v6", 3000, HOT), cost("wf-cerulean-v4", 40000, COLD)] });
      }
      return json({ groups: [cost("wf-lithium-v6", 200000), cost("wf-cerulean-v4", 60000)] });
    }
    if (url.includes("/orgs/stats")) {
      const audienceId = u.searchParams.get("audienceId");
      if (audienceId === HOT) return json({ groups: [email("wf-lithium-v6", 300, 3)] });
      if (audienceId === COLD) return json({ groups: [email("wf-cerulean-v4", 100, 1)] });
      if (audienceId) return json({ groups: [] });
      return json({ groups: [email("wf-lithium-v6", 1000, 10), email("wf-cerulean-v4", 2000, 10)] });
    }
    if (url.includes("/public/stats")) return json({ groups: [email("wf-lithium-v6", 9000, 100), email("wf-cerulean-v4", 9000, 100)] });
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: HOT, name: "Hot", status: "active", filters: {} }, { id: COLD, name: "Cold", status: "active", filters: {} }] });
    }
    // campaign-service: one identity of three stored rows, the live one configured with rudder.
    if (url.includes("/campaigns")) {
      const row = (id: string, status: string) => ({
        id,
        organizationId: "org-1",
        brandId: BRAND,
        funnelKey: "sales_meetings_from_conversation",
        acquisitionChannel: "sales-cold-email-outreach",
        workflowSlug: CONFIGURED_SLUG,
        status,
      });
      return json({ campaigns: [row(LIVE, "ongoing"), row(OLD_A, "stopped"), row(NEVER_RAN, "stopped")] });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
const LEG = "leg=start_to_conversation";

describe("a campaign states the workflow that RAN, not the one it was configured with", () => {
  beforeEach(() => {
    runsFails = false;
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the workflow the ledger recorded, which is NOT the campaign row's configured one", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}`);
    expect(res.status).toBe(200);

    // The divergence: the row says rudder, every trigger says something else.
    expect(res.body.observedPicks.last.workflowDynastySlug).toBe("lithium");
    expect(res.body.observedPicks.last.workflowSlug).toBe("wf-lithium-v6");
    expect(res.body.observedPicks.last.workflowDynastySlug).not.toBe("rudder");
    expect(res.body.observedPicks.recent.map((p: any) => p.workflowDynastySlug)).not.toContain("rudder");
    expect(res.body.observedPicks.last.workflowDynastyName).toBe("Lithium");
    expect(res.body.observedPicks.last.audienceId).toBe(HOT);
    expect(res.body.observedPicks.last.startedAt).toBe("2026-09-14T04:07:30.548Z");
  });

  it("merges the WHOLE identity, newest first — a stopped ancestor's trigger is in the list", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}`);

    const picks = res.body.observedPicks.recent;
    expect(picks.map((p: any) => p.startedAt)).toEqual([
      "2026-09-14T04:07:30.548Z",
      "2026-09-13T11:00:00.000Z",
      "2026-09-12T02:27:34.602Z",
      "2026-09-09T15:23:29.688Z",
    ]);
    // The second-most-recent pick belongs to a STOPPED row: a read scoped to the live row alone
    // would have missed it, which is the wrong-grain answer this identity scope exists to prevent.
    expect(picks[1].campaignId).toBe(OLD_A);
    expect(res.body.observedPicks.truncated).toBe(false);
  });

  it("either member of the identity reads the SAME answer", async () => {
    const live = await get(`${LEG}&campaignId=${LIVE}`);
    const ancestor = await get(`${LEG}&campaignId=${OLD_A}`);
    expect(ancestor.body.observedPicks).toEqual(live.body.observedPicks);
  });

  it("keeps an untagged trigger's audience NULL — never substituted from a neighbouring run", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}`);
    const untagged = res.body.observedPicks.recent.find((p: any) => p.workflowSlug === "wf-maelstrom-v2");
    expect(untagged.audienceId).toBeNull();
    // Its neighbours DO carry one, so a null here is a fact rather than an empty fixture.
    expect(res.body.observedPicks.recent.filter((p: any) => p.audienceId !== null)).toHaveLength(3);
  });

  it("gives a lineage the catalogue no longer describes its OWN dynasty, never drops it", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}`);
    const retired = res.body.observedPicks.recent.find((p: any) => p.workflowSlug === "wf-maelstrom-v2");
    expect(retired.workflowDynastySlug).toBe("wf-maelstrom-v2");
    expect(retired.workflowDynastyName).toBeNull();
  });

  it("asks runs ONCE for the whole family, for campaign-service's own runs, with limit + 1 on the wire", async () => {
    await get(`${LEG}&campaignId=${LIVE}`);

    // One round trip however many stored rows the identity has — never one per member.
    expect(runsRequests).toHaveLength(1);
    const [u] = runsRequests;
    expect(u.searchParams.get("campaignIds")!.split(",").sort()).toEqual([LIVE, OLD_A, NEVER_RAN].sort());
    expect(u.searchParams.has("campaignId")).toBe(false);
    expect(u.searchParams.get("serviceName")).toBe("campaign-service");
    // limit + 1, so `truncated` can say the list is a window.
    expect(u.searchParams.get("limit")).toBe("51");
  });

  it("says a family is truncated even when every run sits on ONE member", async () => {
    // The per-member fan-out got exactly `limit` rows back from such a family and read `false`.
    const saved = { ...TRIGGER_RUNS };
    TRIGGER_RUNS[OLD_A] = [];
    TRIGGER_RUNS[LIVE] = [0, 1, 2].map((i) => ({
      campaignId: LIVE,
      workflowSlug: "wf-lithium-v6",
      audienceId: HOT,
      startedAt: `2026-09-14T0${i}:00:00.000Z`,
    }));
    const res = await get(`${LEG}&campaignId=${LIVE}&picks=2`);
    expect(res.body.observedPicks.recent.map((p: { startedAt: string }) => p.startedAt)).toEqual([
      "2026-09-14T02:00:00.000Z",
      "2026-09-14T01:00:00.000Z",
    ]);
    expect(res.body.observedPicks.truncated).toBe(true);
    Object.assign(TRIGGER_RUNS, saved);
  });

  it("states a REAL, EMPTY answer for a campaign that has never triggered", async () => {
    // Every member answers nothing — distinct from a failed read, which is null.
    for (const id of [LIVE, OLD_A, NEVER_RAN]) TRIGGER_RUNS[id] = [];
    const res = await get(`${LEG}&campaignId=${LIVE}`);
    expect(res.body.observedPicks).toEqual({ last: null, recent: [], truncated: false });
    TRIGGER_RUNS[LIVE] = [
      { campaignId: LIVE, workflowSlug: "wf-lithium-v6", audienceId: HOT, startedAt: "2026-09-14T04:07:30.548Z" },
      { campaignId: LIVE, workflowSlug: "wf-cerulean-v4", audienceId: COLD, startedAt: "2026-09-12T02:27:34.602Z" },
    ];
    TRIGGER_RUNS[OLD_A] = [
      { campaignId: OLD_A, workflowSlug: "wf-maelstrom-v2", audienceId: null, startedAt: "2026-09-09T15:23:29.688Z" },
      { campaignId: OLD_A, workflowSlug: "wf-lithium-v6", audienceId: COLD, startedAt: "2026-09-13T11:00:00.000Z" },
    ];
  });

  it("nulls the block when runs is unreachable — never the CONFIGURED workflow, never a 502", async () => {
    runsFails = true;
    const res = await get(`${LEG}&campaignId=${LIVE}`);
    expect(res.status).toBe(200);
    expect(res.body.observedPicks).toBeNull();
    // The rest of the body is untouched: a degraded read of one block is not a degraded page.
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.campaignIdentity.campaignIds).toHaveLength(3);
  });

  it("states NOTHING, and asks runs NOTHING, on a read that named no campaign", async () => {
    const res = await get(LEG);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("observedPicks");
    expect(runsRequests).toHaveLength(0);
  });

  it("truncates to the requested window and SAYS it did", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}&picks=2`);
    expect(res.body.observedPicks.recent).toHaveLength(2);
    expect(res.body.observedPicks.truncated).toBe(true);
    // `last` is the whole identity's most recent pick, not merely the head of the window.
    expect(res.body.observedPicks.last.startedAt).toBe("2026-09-14T04:07:30.548Z");
    expect(runsRequests.map((u) => u.searchParams.get("limit"))).toEqual(["3"]);
  });

  it("spends no read at all on `picks=0`, and says so with an absent block", async () => {
    const res = await get(`${LEG}&campaignId=${LIVE}&picks=0`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("observedPicks");
    expect(runsRequests).toHaveLength(0);
  });

  it("400s an unreadable or out-of-range window rather than clamping it", async () => {
    for (const picks of ["banana", "-1", "201", "1.5"]) {
      const res = await get(`${LEG}&campaignId=${LIVE}&picks=${picks}`);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("picks_unrecognised");
    }
  });

  it("carries none of it on a funnel- or goal-keyed read, which campaign-service's selection uses", async () => {
    const funnel = await get("funnel=sales_meetings_from_conversation");
    const goal = await get("goal=meetingBooked");
    expect(funnel.body).not.toHaveProperty("observedPicks");
    expect(goal.body).not.toHaveProperty("observedPicks");
    expect(runsRequests).toHaveLength(0);
  });
});
