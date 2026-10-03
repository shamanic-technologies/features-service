/**
 * WHICH WORKFLOWS MAY RUN ON A LEG IS A STATED ASSIGNMENT — the verdict on the wire.
 *
 * Four dynasties, and the conversation leg assigns them the three possible states:
 *
 *   lithium  "pro"        active on BOTH legs
 *   sodium   "flash"      active on BOTH legs — a cheap-tier model the retired tier rule excluded from
 *                         the conversation leg (the `maelstrom` case): the assignment, not the model,
 *                         decides now
 *   argon    "flash-pro"  DEPRECATED on the conversation leg, ACTIVE on the visit leg
 *   neon     (none)       UNASSIGNED on the conversation leg, never assigned anywhere
 *
 * Every case asserts a DIVERGENCE (two legs disagreeing about one workflow, a cheap model selectable,
 * the cheapest workflow not recommended because it is not assigned) so a suite checking only "a block
 * came back" would pass on the implementation this replaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { offerEconomicsFromDeclared } from "../lib/leg-economics-fixture.js";

const assignmentsByLeg = new Map<string, Map<string, any>>();
vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workflow-leg-assignments.js")>()),
  fetchLegAssignments: vi.fn(async (_featureSlug: string, legKey: string) => assignmentsByLeg.get(legKey) ?? new Map()),
}));
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
  /** Replaces the workflow-service full listing. `"fail"` makes the read non-OK. */
  fullWorkflows?: unknown | "fail";
  /** Overrides a dynasty's brand-grain positive replies (default 10 + its index). */
  brandReplies?: Record<string, number>;
  /** Dynasties that never ran anywhere: no spend, no contact, at any grain (the explore allowance). */
  unrun?: string[];
}

let requestedUrls: string[] = [];

function mockFetch(options: Options = {}): void {
  requestedUrls = [];
  const ran = (groups: any[]) =>
    groups.filter((g) => !(options.unrun ?? []).some((d) => (g.key ?? g.dimensions?.workflowSlug) === `wf-${d}-v1`));
  const json = (body: any) => jsonResponse(body?.groups ? { ...body, groups: ran(body.groups) } : body);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    requestedUrls.push(url);
    const u = new URL(url, "http://x");

    if (url.includes("/internal/models")) throw new Error("the model-tier catalogue must never be read");
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
    if (url.includes("/offer-economics")) return json(offerEconomicsFromDeclared([CONVERSATION_FUNNEL, WEBSITE_FUNNEL]));
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL, WEBSITE_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: AUD, name: "Aud", status: "active", filters: {} }] });
    }
    if (url.includes("/campaigns")) return json({ campaigns: [] });
    return json({});
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}


const row = (d: string, state: "active" | "deprecated") => ({
  featureSlug: "sales-cold-email-outreach",
  legKey: "x",
  workflowDynastySlug: d,
  state,
  decidedBy: "kevin",
  decidedAt: "2026-09-27T10:00:00.000Z",
  note: null,
});
function assign(legKey: string, entries: Record<string, "active" | "deprecated">): void {
  assignmentsByLeg.set(legKey, new Map(Object.entries(entries).map(([d, s]) => [d, row(d, s)])));
}
function standardAssignments(): void {
  assignmentsByLeg.clear();
  assign("start_to_conversation", { lithium: "active", sodium: "active", argon: "deprecated" });
  assign("start_to_website_visit", { lithium: "active", sodium: "active", argon: "active" });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
const rowOf = (body: any, dynasty: string) => body.rows.find((r: any) => r.workflow.workflowDynastySlug === dynasty);
const selectableSet = (body: any) =>
  [...new Set(body.rows.filter((r: any) => r.legAssignment?.selectable).map((r: any) => r.workflow.workflowDynastySlug))].sort();

describe("a leg-keyed row states the workflow's ASSIGNMENT to that leg", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    standardAssignments();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("states the three states, and only ACTIVE is selectable", async () => {
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(rowOf(res.body, "lithium").legAssignment).toMatchObject({ state: "active", selectable: true, reason: null, decidedBy: "kevin" });
    expect(rowOf(res.body, "argon").legAssignment).toMatchObject({ state: "deprecated", selectable: false, decidedBy: "kevin" });
    expect(rowOf(res.body, "argon").legAssignment.reason).toContain("deprecated");
    expect(rowOf(res.body, "neon").legAssignment).toMatchObject({ state: "unassigned", selectable: false, decidedBy: null, decidedAt: null });
    expect(rowOf(res.body, "neon").legAssignment.reason).toContain("has not been assigned");
    expect(selectableSet(res.body)).toEqual(["lithium", "sodium"]);
  });

  it("a CHEAP-tier model is selectable when assigned — the model decides nothing any more", async () => {
    const res = await get("leg=start_to_conversation");
    const sodium = rowOf(res.body, "sodium");
    expect(sodium.legAssignment.selectable).toBe(true);
    // The transitional block mirrors the assignment; the tier is gone, the alias is display only.
    expect(sodium.modelEligibility).toEqual({
      modelAlias: "flash",
      modelTier: null,
      eligible: true,
      ineligibleReason: null,
      unknownTierReason: null,
    });
    expect(requestedUrls.filter((u) => u.includes("/internal/models"))).toHaveLength(0);
  });

  it("deprecation is PER LEG: deprecated on one, still selectable on the other", async () => {
    const conversation = await get("leg=start_to_conversation");
    const visit = await get("leg=start_to_website_visit");
    expect(rowOf(conversation.body, "argon").legAssignment.selectable).toBe(false);
    expect(rowOf(conversation.body, "argon").modelEligibility.eligible).toBe(false);
    expect(rowOf(visit.body, "argon").legAssignment.selectable).toBe(true);
    expect(rowOf(visit.body, "argon").modelEligibility.eligible).toBe(true);
  });

  it("keeps a DEPRECATED workflow on the body with its figures, its rank and its state", async () => {
    const res = await get("leg=start_to_conversation");
    const argon = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === "argon");
    expect(argon.length).toBeGreaterThan(1);
    for (const r of argon) {
      expect(r.legAssignment.state).toBe("deprecated");
      expect(r.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
      expect(r.rank).toBeGreaterThan(0);
      expect(r.scopeRank).toBeGreaterThan(0);
    }
  });

  it("MOVES NO FIGURE: the numbers are those of a read where everything is active", async () => {
    const assigned = await get("leg=start_to_conversation");
    assign("start_to_conversation", { lithium: "active", sodium: "active", argon: "active", neon: "active" });
    const all = await get("leg=start_to_conversation");
    const figures = (body: any) =>
      body.rows
        .map(({ legAssignment, modelEligibility, rank, scopeRank, ...rest }: any) => rest)
        .sort((a: any, b: any) =>
          `${a.workflow.workflowDynastySlug}|${a.audienceId}`.localeCompare(`${b.workflow.workflowDynastySlug}|${b.audienceId}`),
        );
    expect(figures(assigned.body)).toEqual(figures(all.body));
  });
});

describe("a workflow not assigned ACTIVE is never put forward", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    standardAssignments();
  });
  afterEach(() => vi.restoreAllMocks());

  // argon is made the cheapest workflow by far; it is deprecated on the conversation leg.
  const CHEAP_ARGON = { brandReplies: { argon: 50 } };

  it("never recommends it, even when it is the cheapest", async () => {
    assign("start_to_conversation", { lithium: "active", sodium: "active", argon: "active", neon: "active" });
    mockFetch(CHEAP_ARGON);
    const blind = await get("leg=start_to_conversation");
    expect(blind.body.recommendedWorkflowDynastySlug).toBe("argon");

    standardAssignments();
    const res = await get("leg=start_to_conversation");
    expect(res.body.recommendedWorkflowDynastySlug).not.toBe("argon");
    expect(rowOf(res.body, res.body.recommendedWorkflowDynastySlug).legAssignment.selectable).toBe(true);
    expect(rowOf(res.body, res.body.recommendedWorkflowDynastySlug).rank).toBe(1);
    expect(res.body.recommendationWithheldReason).toBeUndefined();
  });

  it("ranks every selectable workflow above every non-selectable one, overall and per scope", async () => {
    mockFetch(CHEAP_ARGON);
    const res = await get("leg=start_to_conversation");
    const sel = res.body.rows.filter((r: any) => r.legAssignment.selectable).map((r: any) => r.rank);
    const non = res.body.rows.filter((r: any) => !r.legAssignment.selectable).map((r: any) => r.rank);
    expect(Math.max(...sel)).toBeLessThan(Math.min(...non));
    for (const scope of new Set(res.body.rows.map((r: any) => r.audienceId))) {
      const col = res.body.rows.filter((r: any) => r.audienceId === scope);
      const s = col.filter((r: any) => r.legAssignment.selectable).map((r: any) => r.scopeRank);
      const n = col.filter((r: any) => !r.legAssignment.selectable).map((r: any) => r.scopeRank);
      expect(Math.max(...s)).toBeLessThan(Math.min(...n));
    }
  });

  it("recommends nothing, and says why, when NO workflow is assigned active on the leg", async () => {
    assignmentsByLeg.clear();
    mockFetch();
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    expect(selectableSet(res.body)).toEqual([]);
    expect(res.body.rows.every((r: any) => r.legAssignment.state === "unassigned")).toBe(true);
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendationWithheldReason).toBe("no_eligible_workflow");
  });

  it("a goal-keyed read carries no assignment and reads none", async () => {
    mockFetch(CHEAP_ARGON);
    const { fetchLegAssignments } = await import("../lib/workflow-leg-assignments.js");
    vi.mocked(fetchLegAssignments).mockClear();
    const res = await get("goal=meetingBooked");
    expect(res.status).toBe(200);
    expect(res.body.recommendedWorkflowDynastySlug).toBe("argon");
    for (const r of res.body.rows) {
      expect(r.legAssignment).toBeUndefined();
      expect(r.modelEligibility).toBeUndefined();
    }
    expect(fetchLegAssignments).not.toHaveBeenCalled();
  });
});

describe("COLD START: a leg with no priced workflow still names a selectable one to run", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    assignmentsByLeg.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  // The prod case (2026-10-03, ai-meeting-booking conversation_to_meeting_booked): the only workflow
  // assigned active never ran, every priced one is not selectable on the leg.
  const PROD_SHAPE = () => {
    assign("start_to_conversation", { neon: "active", lithium: "deprecated", sodium: "deprecated", argon: "deprecated" });
    mockFetch({ unrun: ["neon"] });
  };

  it("recommends the rank-1 SELECTABLE workflow, flagged cold_start, with no invented price", async () => {
    PROD_SHAPE();
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    const neon = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === "neon");
    expect(neon.length).toBeGreaterThan(0);
    for (const r of neon) {
      expect(r.measured).toBe(false); // the explore allowance: no evidence anywhere
    }
    expect(res.body.recommendedWorkflowDynastySlug).toBe("neon");
    expect(rowOf(res.body, "neon").rank).toBe(1);
    expect(res.body.recommendationBasis).toBe("cold_start");
    expect(res.body.recommendedBudgetUsd).toBeNull();
    expect(res.body.recommendationWithheldReason).toBeUndefined();
  });

  it("never falls back to a deprecated or unassigned workflow", async () => {
    assign("start_to_conversation", { lithium: "deprecated", sodium: "deprecated", argon: "deprecated" });
    mockFetch({ unrun: ["neon"] });
    const res = await get("leg=start_to_conversation");
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendationBasis).toBeUndefined();
    expect(res.body.recommendationWithheldReason).toBe("no_eligible_workflow");
  });

  it("a PRICED selectable workflow still wins over a never-run one, with no cold_start flag", async () => {
    assign("start_to_conversation", { neon: "active", lithium: "active", sodium: "active", argon: "deprecated" });
    mockFetch({ unrun: ["neon"] });
    const res = await get("leg=start_to_conversation");
    expect(res.body.recommendationBasis).toBeUndefined();
    expect(["lithium", "sodium"]).toContain(res.body.recommendedWorkflowDynastySlug);
    expect(rowOf(res.body, res.body.recommendedWorkflowDynastySlug).resolved.costPerOutcomeUsd).toBeGreaterThan(0);
    expect(res.body.recommendedBudgetUsd).toBeGreaterThan(0);
  });

  it("a goal-keyed read is unchanged: no cold-start flag", async () => {
    PROD_SHAPE();
    const res = await get("goal=meetingBooked");
    expect(res.body.recommendationBasis).toBeUndefined();
  });
});
