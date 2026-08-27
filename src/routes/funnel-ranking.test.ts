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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // exercise the pure live-compute path
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

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const SALES_FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

// LTR $1000. Per funnel: website_purchases paid = click / (4% × 50%); the conversation meeting funnel
// pays reply / (40% × 30%); the website meeting funnel pays click / (5% × 30%) — same funnel, different
// channel, which is exactly what a goal could not express.
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
  visitToPaidClientPct: 5,
  replyToPaidClientPct: 25,
};

function wf(slug: string, dynasty: string, name: string): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    workflowSlug: slug,
    workflowName: name,
    workflowDynastyName: name,
    workflowDynastySlug: dynasty,
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
  };
}
const WORKFLOWS = [wf("wf-a", "dyn-a", "Dynasty A"), wf("wf-b", "dyn-b", "Dynasty B")];

const costGroup = (slug: string, cents: number) => ({
  dimensions: { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 10,
  minStartedAt: null,
  maxStartedAt: null,
});
const emailGroup = (slug: string, clicked: number, repliesPositive: number, contacted = 200) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 10, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

// dyn-a: $1000 / 100 clicks / 50 replies → click $10, reply $20 (cheapest CLICK).
// dyn-b: $1000 /  10 clicks / 100 replies → click $100, reply $10 (cheapest REPLY).
const CROSSORG_COST = [costGroup("wf-a", 100_000), costGroup("wf-b", 100_000)];
const CROSSORG_EMAIL = [emailGroup("wf-a", 100, 50), emailGroup("wf-b", 10, 100)];

/** A declared sales funnel, shaped exactly like brand-service's deployed item — which carries NO
 * `goal` and no `currentGoal` since the retirement (brand-service #434). */
function declaredFunnel(funnelKey: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funnelKey,
    active: true,
    name: funnelKey,
    steps: [],
    rates: {},
    lifetimeRevenueUsd: null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  };
}

interface MockOpts {
  economics?: unknown;
  /** The funnels brand-service serves. Omitted → the endpoint 404s (a brand-service without the model). */
  funnels?: unknown[];
  audiences?: Array<{ id: string }>;
}

function mockFetch(opts: MockOpts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");

    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: CROSSORG_COST });
    if (url.includes("/v1/stats/costs")) return json({ groups: [] }); // brand + audience grains: no spend
    if (url.includes("/orgs/stats")) return json({ groups: [] });
    if (url.includes("/public/stats")) return json({ groups: CROSSORG_EMAIL });
    if (url.includes("/sales-funnels")) {
      if (!("funnels" in opts)) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }
      return json({ funnels: opts.funnels });
    }
    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS;
      return json({ economics, source: economics == null ? null : "user" });
    }
    if (url.includes("/orgs/audiences")) return json({ audiences: opts.audiences ?? [] });
    void u;
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/funnel-ranking";
/** The pre-retirement path, still mounted while callers migrate. */
const LEGACY_URL_BASE = "/features/sales-cold-email-outreach/goal-arbitration";

describe("GET /features/:featureSlug/funnel-ranking", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing, 400 on an invalid pricing value, 404 when the feature is unknown", async () => {
    mockFetch({ funnels: [declaredFunnel("website_purchases")] });
    expect((await request(app).get(URL_BASE).set(AUTH)).status).toBe(400);
    expect((await request(app).get(`${URL_BASE}?brandId=b1&pricing=bogus`).set(AUTH)).status).toBe(400);

    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    expect((await request(app).get(`/features/nope/funnel-ranking?brandId=b1`).set(AUTH)).status).toBe(404);
  });

  // The rename is a rename, not a re-scoring: the deprecated path must keep answering, and answering
  // the SAME thing, for as long as a caller is still on it (campaign-service reads `arbitration` /
  // `workflow` / `rows` off it in production to pace a brand with no per-funnel funding).
  it("the deprecated /goal-arbitration path serves a BYTE-IDENTICAL body — the rename changes no number", async () => {
    mockFetch({
      funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")],
      audiences: [{ id: "aud-1" }],
    });
    const canonical = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    mockFetch({
      funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")],
      audiences: [{ id: "aud-1" }],
    });
    const legacy = await request(app).get(`${LEGACY_URL_BASE}?brandId=b1`).set(AUTH);

    expect(canonical.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(JSON.stringify(legacy.body)).toBe(JSON.stringify(canonical.body));
    // ...including the legacy fields campaign-service actually reads.
    expect(legacy.body.arbitration.status).toBe("resolved");
    expect(legacy.body.arbitration.goal).toBeTruthy();
    expect(legacy.body.workflow.workflowDynastySlug).toBeTruthy();
    expect(Array.isArray(legacy.body.rows)).toBe(true);
  });

  it("asks brand-service for the CALLER'S org's declared set — a brand id alone cannot name whose funnels", async () => {
    // A brand row is a shared global identity (every org claiming the same domain gets the same brand
    // id), so the authorized set is the (org, brand) pair's data. brand-service refuses to guess for a
    // multi-org brand, so the org whose answer we want has to be on the wire.
    let funnelsOrg: string | undefined = "NEVER CALLED";
    mockFetch({ funnels: [declaredFunnel("website_purchases")] });
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      if (url.includes("/sales-funnels")) {
        funnelsOrg = ((init?.headers as Record<string, string>) ?? {})["x-org-id"];
      }
      return inner(input, init);
    });

    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(funnelsOrg).toBe("org-1");
  });

  it("ranks every declared funnel, and serves the best-returning one's workflow + rows — in ONE request", async () => {
    mockFetch({
      funnels: [
        declaredFunnel("website_purchases"),
        declaredFunnel("sales_meetings_from_conversation"),
        // Declared but priced at a 0% close: there is no path to a paying client through this funnel.
        declaredFunnel("form_magnet", { rates: { visitToFormSubmissionPct: 10, formSubmissionToPaidClientPct: 0 } }),
      ],
      audiences: [{ id: "aud-1" }],
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    // Every declared funnel is present — the comparison is the answer, and it is never short.
    expect(res.body.ranking.map((r: any) => r.funnelKey)).toEqual([
      "sales_meetings_from_conversation",
      "website_purchases",
      "form_magnet",
    ]);
    expect(res.body.ranking.map((r: any) => r.rank)).toEqual([1, 2, null]);
    expect(res.body.recommendation.funnelKey).toBe("sales_meetings_from_conversation");
    expect(res.body.recommendation.goal).toBe("meetingBooked");
    // reply $10 (dyn-b) / 40% = $25 per meeting; / 30% = $83.33 per paid client; 1000 / 83.33 = 12.
    expect(res.body.recommendation.returnPerDollar).toBeCloseTo(12, 6);
    expect(res.body.workflow.workflowDynastySlug).toBe("dyn-b");
    expect(res.body.rows.every((r: any) => r.workflow.workflowDynastySlug === "dyn-b")).toBe(true);
    expect(res.body.rows.some((r: any) => r.audienceId === "aud-1")).toBe(true);
    expect(res.body.economics.lifetimeRevenueUsd).toBe(1000);

    // The funnel with no path to a paying client is scored and listed, but carries no rank.
    const dead = res.body.ranking.find((r: any) => r.funnelKey === "form_magnet");
    expect(dead.rankable).toBe(false);
    expect(dead.unrankableReason).toBe("no_paid_client_path");
  });

  it("keeps the deployed campaign-service contract: arbitration.status/goal + workflow + rows", async () => {
    // campaign-service reads exactly these in prod to pace a brand with no per-funnel funding. They
    // are DERIVED from the head of the ranking, so the two surfaces can never name different funnels.
    mockFetch({ funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("resolved");
    expect(res.body.arbitration.goal).toBe(res.body.ranking[0].goal);
    expect(res.body.arbitration.returnPerDollar).toBe(res.body.ranking[0].returnPerDollar);
    expect(res.body.workflow).toEqual(res.body.ranking[0].workflow);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it("never asks billing which funnels are funded — an unfunded funnel is ranked on its history", async () => {
    // The whole request path (route + ranking) makes exactly three downstream reads: the evidence
    // fan-out, the brand's economics, and the declared funnels. No budget, no ceiling, no billing.
    mockFetch({ funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url,
    );
    expect(urls.some((u) => /billing|budget|ceiling/i.test(u))).toBe(false);
    // Both funnels rank purely on what they returned, with no funded/ceiling field anywhere.
    expect(res.body.ranking.map((r: any) => r.rank)).toEqual([1, 2]);
    expect(JSON.stringify(res.body.ranking)).not.toMatch(/funded|ceiling|budgetCents/i);
  });

  it("the recommended workflow matches what the SINGLE-FUNNEL read says — same fixture, same argmin", async () => {
    mockFetch({ funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")] });
    const arbitrated = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    // Reproduce each funnel's own projection in isolation, then check the winner against them.
    const single = async (funnel: string) =>
      (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&funnel=${funnel}`).set(AUTH)).body;
    const bestBrandRow = (body: any) =>
      body.rows
        .filter((r: any) => r.audienceId === null && r.resolved.costPerOutcomeUsd > 0)
        .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];

    const meeting = bestBrandRow(await single("sales_meetings_from_conversation"));
    const purchase = bestBrandRow(await single("website_purchases"));
    expect(meeting.resolved.roiMultiple).toBeCloseTo(12, 6);
    expect(purchase.resolved.roiMultiple).toBeCloseTo(2, 6);
    expect(arbitrated.body.recommendation.funnelKey).toBe("sales_meetings_from_conversation");
    expect(arbitrated.body.workflow.workflowDynastySlug).toBe(meeting.workflow.workflowDynastySlug);
    expect(arbitrated.body.recommendation.costPerOutcomeUsd).toBeCloseTo(meeting.resolved.costPerOutcomeUsd, 6);
    expect(arbitrated.body.recommendation.returnPerDollar).toBeCloseTo(meeting.resolved.roiMultiple, 6);
    expect(
      arbitrated.body.ranking.find((r: any) => r.funnelKey === "website_purchases").workflow.workflowDynastySlug,
    ).toBe(purchase.workflow.workflowDynastySlug);
  });

  it("the TWO MEETING FUNNELS get two different costs from the SAME evidence — the whole point", async () => {
    // Both echo `meetingBooked`, so before the retirement this brand was told one blended price for
    // both funnels and could not see which of the two to fund.
    mockFetch({
      funnels: [declaredFunnel("sales_meetings_from_conversation"), declaredFunnel("sales_meetings_from_website")],
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.ranking.map((r: any) => [r.funnelKey, r]));
    expect(byKey.sales_meetings_from_conversation.costPerOutcomeUsd).toBeCloseTo(25, 6);   // reply $10 / 40%
    expect(byKey.sales_meetings_from_website.costPerOutcomeUsd).toBeCloseTo(200, 6);       // click $10 /  5%
    expect(byKey.sales_meetings_from_conversation.goal).toBe("meetingBooked");
    expect(byKey.sales_meetings_from_website.goal).toBe("meetingBooked");
    // ...bought from different workflows, too, which one blended number could never have shown.
    expect(byKey.sales_meetings_from_conversation.workflow.workflowDynastySlug).toBe("dyn-b");
    expect(byKey.sales_meetings_from_website.workflow.workflowDynastySlug).toBe("dyn-a");
  });

  it("a consumer that still sends a GOAL gets byte-identically the answer it got before", async () => {
    // The transition tolerance: `?goal=meetingBooked` keeps funnelling from BOTH channels, which is the
    // right answer to the coarser question, and carries no funnelKey. Only `?funnel=` narrows.
    mockFetch({ funnels: [declaredFunnel("sales_meetings_from_conversation")] });
    const byGoal = (await request(app)
      .get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=meetingBooked`)
      .set(AUTH)).body;

    // BOTH channels fund it: on dyn-b that is (1/$100)·5% + (1/$10)·40% = 0.0405 meetings per dollar,
    // i.e. $24.69 — a blend that is neither of the two funnels' real prices ($25 and $200), which is
    // precisely why a brand running only one of them could not read its own cost off it.
    const best = byGoal.rows
      .filter((r: any) => r.audienceId === null && r.resolved.costPerOutcomeUsd > 0)
      .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];
    expect(best.resolved.costPerOutcomeUsd).toBeCloseTo(1 / 0.0405, 6);
    expect(byGoal.goal).toBe("meetingBooked");
    expect(byGoal).not.toHaveProperty("funnelKey");
  });

  it("a `?funnel=` read prices on the funnel's OWN declared terms, exactly as the ranking does", async () => {
    // Prod caught this after the first ship: brand `b97440f6…` declares `replyToMeetingPct: 100` on its
    // conversation funnel, so the ranking said $73.74 per meeting while `?funnel=` — projecting on the
    // brand-wide 40% — said $184.36. Same brand, same funnel, same moment, two numbers.
    const declared = declaredFunnel("sales_meetings_from_conversation", {
      rates: { replyToMeetingPct: 100, meetingToClosePct: 25 },
      lifetimeRevenueUsd: 2500,
    });
    mockFetch({ funnels: [declared] });

    const arbitrated = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);
    const projected = await request(app)
      .get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&funnel=sales_meetings_from_conversation`)
      .set(AUTH);
    expect(projected.status).toBe(200);

    const best = projected.body.rows
      .filter((r: any) => r.audienceId === null && r.resolved.costPerOutcomeUsd > 0)
      .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];

    // The declared 100% reply→meeting makes the meeting cost the RAW reply cost ($10 on dyn-b), not the
    // $25 the brand-wide 40% would give — and both surfaces must say so.
    expect(best.resolved.costPerOutcomeUsd).toBeCloseTo(10, 6);
    expect(arbitrated.body.recommendation.costPerOutcomeUsd).toBeCloseTo(best.resolved.costPerOutcomeUsd, 6);
    // ...including the funnel's own lifetime revenue, which drives the return.
    expect(projected.body.economics.lifetimeRevenueUsd).toBe(2500);
  });

  it("refuses to price a funnel the brand never declared — a gap is not a zero", async () => {
    mockFetch({ funnels: [declaredFunnel("website_purchases")] });
    const res = await request(app)
      .get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&funnel=form_magnet`)
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("funnel_not_declared");
    expect(res.body.declaredFunnelKeys).toEqual(["website_purchases"]);
    // ...and a word that names no funnel at all fails loud rather than falling back to the goal.
    const bogus = await request(app)
      .get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&funnel=telepathy`)
      .set(AUTH);
    expect(bogus.status).toBe(400);
  });

  it("accepts a PRE-RETIREMENT funnel spelling and answers with the canonical key", async () => {
    mockFetch({ funnels: [declaredFunnel("reply_meeting")] });
    const res = await request(app)
      .get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&funnel=reply_meeting`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.funnelKey).toBe("sales_meetings_from_conversation");
  });

  it("the declared meeting show-up rate lowers the meeting goal's return — it is not a free 100%", async () => {
    // The meeting funnel is reply → BOOKED → attended → paid. Our meetingToClosePct is BOOKED → paid,
    // brand-service's funnel prices ATTENDED → paid, so a declared show-up rate must divide the return.
    const meetingFunnel = (rates: Record<string, number | null>) =>
      declaredFunnel("sales_meetings_from_conversation", { rates });

    // 40% reply→booked, 50% booked→attended, 40% attended→paid ⇒ 20% booked→paid.
    mockFetch({ funnels: [meetingFunnel({ replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 40 })] });
    const withShowUp = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    // The SAME funnel with no show-up rate declared ⇒ 40% booked→paid, i.e. twice the conversion.
    mockFetch({ funnels: [meetingFunnel({ replyToMeetingPct: 40, meetingToClosePct: 40 })] });
    const without = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(withShowUp.status).toBe(200);
    expect(without.status).toBe(200);
    expect(withShowUp.body.economics.meetingToClosePct).toBeCloseTo(20, 6);
    expect(without.body.economics.meetingToClosePct).toBeCloseTo(40, 6);
    // Half the booked→paid rate ⇒ twice the cost per paid client ⇒ half the return per dollar.
    expect(withShowUp.body.recommendation.costPerPaidClientUsd).toBeCloseTo(
      without.body.recommendation.costPerPaidClientUsd * 2,
      6,
    );
    expect(withShowUp.body.recommendation.returnPerDollar).toBeCloseTo(
      without.body.recommendation.returnPerDollar / 2,
      6,
    );
  });

  it("the single-goal read is untouched by the presence of a declared funnel set", async () => {
    mockFetch({ funnels: [declaredFunnel("website_purchases"), declaredFunnel("sales_meetings_from_conversation")] });
    const withSet = (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=signup`).set(AUTH)).body;
    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    mockFetch(); // a brand that declared no funnel at all
    const without = (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=signup`).set(AUTH)).body;
    expect(withSet).toEqual(without);
  });

  it("502 with an explicit reason when the declared-funnel read cannot be answered — never a substituted default", async () => {
    mockFetch(); // brand-service without the funnel model → the read 404s
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goals_unavailable");
    expect(res.body.error).toContain("sales funnels");
  });

  it("502 with an explicit reason on a declared funnel we cannot map — never silently dropped", async () => {
    mockFetch({ funnels: [declaredFunnel("website_purchases"), declaredFunnel("telepathy")] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goal_unrecognised");
    expect(res.body.error).toContain("telepathy");
  });

  it("an EMPTY funnel list is a producer gap, never the org answering \"I sell through none\"", async () => {
    // There is no "answered, but sells through nothing" state to confuse this with: brand-service
    // refuses to switch off an org's last active funnel, so having answered always leaves at least
    // one. An empty list therefore means only that this org has never stated a set — a gap to
    // surface, not an answer to act on.
    mockFetch({ funnels: [] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goals_unavailable");
    expect(res.body.error).toContain("never stated");
  });

  it("reads the list alone — a payload with no `declared` flag is answered normally", async () => {
    // The flag said exactly what the list says and is being retired; brand-service serves it today
    // only because this reader used to refuse a payload without it. Nothing here may depend on it.
    mockFetch({ funnels: [declaredFunnel("website_purchases")] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).not.toBe("unrankable");
  });

  it("200 unrankable with a per-funnel reason when nothing can be ranked", async () => {
    mockFetch({
      funnels: [declaredFunnel("sales_meetings_from_conversation", { rates: { meetingToClosePct: 0 } })],
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("unrankable");
    expect(res.body.arbitration.reason).toBe("no_rankable_funnel");
    expect(res.body.recommendation).toBeNull();
    expect(res.body.ranking[0].unrankableReason).toBe("no_paid_client_path");
    expect(res.body.ranking[0].rank).toBeNull();
  });

  it("does not accept a funnel set from the caller", async () => {
    // The brand declared ONE funnel; the caller asks for two more. The answer must ignore the caller.
    mockFetch({ funnels: [declaredFunnel("website_purchases")] });
    const res = await request(app)
      .get(`${URL_BASE}?brandId=b1&funnel=form_magnet&funnelKeys=form_magnet,reply_meeting`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.ranking.map((r: any) => r.funnelKey)).toEqual(["website_purchases"]);
    expect(res.body.recommendation.funnelKey).toBe("website_purchases");
  });
});
