/**
 * A WORKFLOW RECOMMENDATION FOR ONE ARROW, WITH NO SALES FUNNEL NAMED.
 *
 * A campaign is being redefined as (brand, offer, acquisition channel, the single ARROW it is bought
 * for), because one arrow belongs to several funnels at once. So a caller asking which workflow to put
 * a budget behind has a channel and an arrow, and no funnel to name — and this endpoint has to answer
 * anyway, pick the funnel to price through ITSELF, and say what that answer rests on.
 *
 * ONE fixture drives every case, so the numbers are comparable line by line: a brand declaring BOTH
 * meeting funnels, whose reply channel is ten times cheaper per meeting than its click channel, and
 * whose website funnel is worth twenty times more per client. The cheapest arrow is therefore NOT the
 * best one to buy, which is the whole reason the pick is made on return rather than on cost.
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
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

/** The brand-wide effective terms. Each declared funnel refines them with its own below. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 50,
  visitToMeetingPct: 50,
  meetingToClosePct: 40,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};

/** Priced through the REPLY channel ($1 a reply → $2 a meeting → $5 a client) on a $1,000 client. */
const CONVERSATION_FUNNEL = {
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Conversation",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};
/** Priced through the CLICK channel ($10 a click → $20 a meeting → $50 a client) on a $20,000 client:
 *  ten times DEARER per outcome and twice the return. The pick must take this one. */
const WEBSITE_FUNNEL = {
  funnelKey: "sales_meetings_from_website",
  name: "Sales Meeting from Website",
  steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { visitToMeetingPct: 50, meetingToClosePct: 40, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 20000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const FORM_FUNNEL = {
  funnelKey: "form_magnet",
  name: "Form Magnet",
  steps: ["Website visit", "Form filled", "Paid client"],
  rates: { visitToFormSubmissionPct: 10, formSubmissionToPaidClientPct: 10 },
  lifetimeRevenueUsd: 500,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const WORKFLOWS = [
  { id: "ida", workflowSlug: "wf-a", workflowName: "A", workflowDynastyName: "Dynasty A", workflowDynastySlug: "dyn-a", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];
const cost = (slug: string, cents: number) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null });
const email = (slug: string, clicked: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted: 500, sent: 500, delivered: 500, opened: 50, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

interface MockOpts {
  funnels?: unknown[];
  /** Omitted → the brand and the fleet have measured nothing at all. */
  spend?: boolean;
}

function mockFetch(opts: MockOpts = {}): void {
  // $100 spent, 10 clicks and 100 positive replies → clickUsd 10, replyUsd 1.
  const costs = opts.spend === false ? [] : [cost("wf-a", 10000)];
  const stats = opts.spend === false ? [] : [email("wf-a", 10, 100)];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: costs });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: costs });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      return json({ groups: stats });
    }
    if (url.includes("/public/stats")) return json({ groups: stats });
    if (url.includes("/sales-funnels")) return json({ funnels: opts.funnels ?? [CONVERSATION_FUNNEL, WEBSITE_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: [] });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);

describe("workflow-projection: an ARROW is answerable with no sales funnel named", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers a (brand, channel, arrow) with a workflow recommendation and projected economics", async () => {
    mockFetch();
    const res = await get("arrow=meeting_booked_to_meeting_attended");

    expect(res.status).toBe(200);
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a");
    expect(res.body.economics).not.toBeNull();
    expect(res.body.rows.length).toBeGreaterThan(0);
    // The arrow is echoed with its steps BESIDE it — a consumer reads them, it never splits the key.
    expect(res.body.arrow.arrowKey).toBe("meeting_booked_to_meeting_attended");
    expect(res.body.arrow.fromStep.key).toBe("meeting_booked");
    expect(res.body.arrow.toStep.key).toBe("meeting_attended");
  });

  it("an arrow on SEVERAL declared funnels yields ONE answer, priced through the BEST-RETURNING one — the cheapest arrow is not the best buy", async () => {
    mockFetch();
    const res = await get("arrow=meeting_booked_to_meeting_attended");

    expect(res.body.arrow.candidateFunnelKeys).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(res.body.arrow.basis).toBe("best_returning_declared_funnel");
    expect(res.body.arrow.basisFunnelKey).toBe("sales_meetings_from_website");
    expect(res.body.funnelKey).toBe("sales_meetings_from_website");
    // 20000 / 50 — the return the pick was made on, stated so nobody has to re-derive it.
    expect(res.body.arrow.returnPerDollar).toBeCloseTo(400, 6);

    // And it is emphatically NOT the cheap one: the funnel chosen costs ten times more per outcome
    // than the funnel rejected. A cost-ranked pick would have taken the conversation funnel.
    const cheap = await get("funnel=sales_meetings_from_conversation");
    const chosen = res.body.rows.find((r: any) => r.audienceId === null).resolved.costPerOutcomeUsd;
    const rejected = cheap.body.rows.find((r: any) => r.audienceId === null).resolved.costPerOutcomeUsd;
    expect(chosen).toBeCloseTo(20, 6);
    expect(rejected).toBeCloseTo(2, 6);
    expect(chosen).toBeGreaterThan(rejected);
  });

  it("asking for the arrow and asking for its basis funnel do not contradict each other", async () => {
    mockFetch();
    const byArrow = await get("arrow=meeting_booked_to_meeting_attended");
    const byFunnel = await get("funnel=sales_meetings_from_website");

    const { arrow, ...withoutArrow } = byArrow.body;
    expect(arrow.basisFunnelKey).toBe("sales_meetings_from_website");
    // Byte-identical apart from the arrow block that states which funnel answered.
    expect(withoutArrow).toEqual(byFunnel.body);
  });

  it("an arrow only ONE declared funnel contains says so, rather than claiming a comparison it never made", async () => {
    mockFetch({ funnels: [CONVERSATION_FUNNEL] });
    const res = await get("arrow=meeting_booked_to_meeting_attended");

    expect(res.status).toBe(200);
    expect(res.body.arrow.basis).toBe("sole_declared_funnel");
    expect(res.body.arrow.candidateFunnelKeys).toEqual(["sales_meetings_from_conversation"]);
    expect(res.body.arrow.basisFunnelKey).toBe("sales_meetings_from_conversation");
  });

  it("STATES WHAT THE RECOMMENDATION RESTS ON — the grain, whether anything was measured, and how many outcomes", async () => {
    mockFetch();
    const measured = await get("arrow=meeting_booked_to_meeting_attended");
    expect(measured.body.arrow.evidence.measured).toBe(true);
    expect(measured.body.arrow.evidence.grain).toBe("brand");
    // 10 clicks × 50% visit→meeting: the volume behind the pick, stated rather than implied.
    expect(measured.body.arrow.evidence.resolvedOutcomeCount).toBeCloseTo(5, 6);

    // With nothing measured anywhere the arrow is STILL answerable, and it says the pick rests on no
    // return at all — never a fabricated 0 return, never a silent basis change.
    mockFetch({ spend: false });
    const cold = await get("arrow=meeting_booked_to_meeting_attended");
    expect(cold.status).toBe(200);
    expect(cold.body.arrow.basis).toBe("no_return_evidence");
    expect(cold.body.arrow.returnPerDollar).toBeNull();
    expect(cold.body.arrow.evidence.measured).toBe(false);
    // The tie is broken by the catalogue's canonical order, deterministically.
    expect(cold.body.arrow.basisFunnelKey).toBe("sales_meetings_from_conversation");
  });

  it("an arrow NONE of the brand's declared funnels contains is a named 404, never an empty body", async () => {
    mockFetch({ funnels: [FORM_FUNNEL] });
    const res = await get("arrow=conversation_to_meeting_booked");

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("arrow_not_declared");
    expect(res.body.arrowKey).toBe("conversation_to_meeting_booked");
    expect(res.body.declaredFunnelKeys).toEqual(["form_magnet"]);
  });

  it("an unrecognised arrow FAILS LOUD, and a legacy-shaped spelling of a real one is accepted", async () => {
    mockFetch();
    const bad = await get("arrow=signup_to_meeting_attended");
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe("arrow_unrecognised");

    const tolerated = await get("arrow=Meeting-Booked-To-Meeting-Attended");
    expect(tolerated.status).toBe(200);
    expect(tolerated.body.arrow.arrowKey).toBe("meeting_booked_to_meeting_attended");
  });

  it("naming BOTH a funnel and an arrow is a 400 — two questions at once, either answer contradicting the other parameter", async () => {
    mockFetch();
    const res = await get("arrow=meeting_booked_to_meeting_attended&funnel=sales_meetings_from_conversation");
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("arrow_and_funnel");
  });

  it("every existing request answers exactly what it answered before — no arrow, no funnel, no declared read", async () => {
    mockFetch();
    const goal = await get("goal=meetingBooked");
    expect(goal.status).toBe(200);
    expect(goal.body.arrow).toBeUndefined();
    expect(goal.body.funnelKey).toBeUndefined();
    expect(goal.body.goal).toBe("meetingBooked");

    const funnel = await get("funnel=sales_meetings_from_conversation");
    expect(funnel.status).toBe(200);
    expect(funnel.body.arrow).toBeUndefined();
    expect(funnel.body.funnelKey).toBe("sales_meetings_from_conversation");
  });
});
