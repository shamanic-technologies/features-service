/**
 * A FUNNEL READ STEP BY STEP — the count, the cost and the conversion, per rung.
 *
 * ONE downstream fixture drives every case, so the numbers are comparable line by line and a rung's
 * count can be checked against the very `leads[]` rows on the same response. What they pin:
 *
 *   - a four-step reply-to-meeting funnel answers at EVERY rung — reply, booked, ATTENDED, paid — with
 *     no step of the chain unanswerable, which is the hole this exists to close;
 *   - the three other chains (visit→meeting, visit→signup, visit→form) answer the same way;
 *   - the rates are the funnel's own: each rung over the rung before it, the first over outreach;
 *   - ONE committed basis — every cost divides the same total the money block reports;
 *   - a rung with no evidence is NULL and a rung nobody reached is 0, and they are told apart: the
 *     statements degrade → "Meeting attended" is null while "Meeting booked" still reads off the
 *     legacy qualifications, and a null count nulls its cost and both rates that touch it;
 *   - a funnel we cannot PRICE still walks its chain — volume is measurable when money is not;
 *   - there is no chain to state when there is no ONE funnel: the lensed read, and a brand priced on
 *     several declared funnels at once;
 *   - every field an existing consumer reads is untouched.
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
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const PITCH = "sales-cold-email-outreach";
const BRAND = "b1";
const OFFER = "offer-a";
const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE = "sales_meetings_from_website";
const PURCHASES = "website_purchases";
const FORM = "form_magnet";

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`, slug, name: slug, description: "x", status: "active",
  outputs: [], charts: [], entities: [],
  createdAt: new Date(), updatedAt: new Date(),
});

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 10,
  visitToMeetingPct: 10,
  meetingToClosePct: 10,
  visitToSignupPct: 10,
  signupToPaidClientPct: 10,
  visitToClosePct: 1,
  replyToPaidClientPct: 1,
  visitToPaidClientPct: 1,
  visitToFormSubmissionPct: 10,
  formSubmissionToPaidClientPct: 10,
};

const declaredFunnel = (funnelKey: string, steps: string[]) => ({
  funnelKey,
  name: funnelKey,
  steps,
  rates: { replyToMeetingPct: 40, visitToMeetingPct: 20, meetingBookedToAttendedPct: 50, meetingToClosePct: 60 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const ALL_DECLARED = [
  declaredFunnel(CONVERSATION, ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]),
  declaredFunnel(WEBSITE, ["Website visit", "Meeting booked", "Meeting attended", "Paid client"]),
  declaredFunnel(PURCHASES, ["Website visit", "Signup", "Paid client"]),
  declaredFunnel(FORM, ["Website visit", "Form filled", "Paid client"]),
];

const emailOf = (leadId: string) => `${leadId}@x.com`;

function lead(campaignId: string, leadId: string, signal: "reply" | "click" | "none"): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    workflowSlug: "dawn-v1",
    email: emailOf(leadId),
    contacted: true,
    sent: true,
    delivered: true,
    clicked: signal === "click",
    bounced: false,
    unsubscribed: false,
    replied: signal === "reply",
    replyClassification: signal === "reply" ? "positive" : null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

interface Fixture {
  campaigns: Record<string, { featureSlug: string; funnelKey: string | null; offerId: string | null }>;
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** lead ids a HUMAN stated reached each priced rung. */
  stated?: Partial<Record<"meeting_booked" | "meeting_attended" | "sale", string[]>>;
  /** lead ids the LEGACY instantly qualifications carry a booked meeting / a close for. */
  legacy?: { booked?: string[]; closed?: string[] };
  /** lead ids the conversion tracker matched for each website conversion. */
  converted?: Partial<Record<"signup" | "form_submission", string[]>>;
  /** `null` = the statements read fails (a fail-soft producer gap). */
  statedReadable?: boolean;
  /** `null` = the legacy qualifications read fails. */
  legacyReadable?: boolean;
  /** `null` = the matched-lead email sets fail. */
  convertedReadable?: boolean;
  /** What the CUSTOMER states each leg they worked themselves cost them, per campaign. */
  stepCosts?: Array<{ campaignId: string | null; step: string; kind?: "outcome" | "never"; costCents: number | null }>;
  /** `false` = the statement read fails (fail-soft) — every rung's customer half reads null. */
  stepCostsReadable?: boolean;
  declared?: typeof ALL_DECLARED | null;
}

function mockFetch(fixture: Fixture): void {
  const inScope = (cid: string, q: URLSearchParams): boolean => {
    const row = fixture.campaigns[cid];
    if (!row) return false;
    const only = q.get("campaignId");
    if (only && only !== cid) return false;
    const slugs = (q.get("featureSlugs") ?? "").split(",").filter(Boolean);
    if (slugs.length > 0 && !slugs.includes(row.featureSlug)) return false;
    return true;
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      const narrowed = q.get("featureSlug");
      return json({
        campaigns: Object.entries(fixture.campaigns)
          .filter(([, row]) => !narrowed || row.featureSlug === narrowed)
          .map(([id, row]) => ({
            id,
            orgId: "org-1",
            brandId: BRAND,
            featureSlug: row.featureSlug,
            funnelKey: row.funnelKey,
            acquisitionChannel: row.featureSlug,
            offerId: row.offerId,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
      });
    }
    if (path.includes("/sales-funnels")) {
      const declared = fixture.declared === undefined ? ALL_DECLARED : fixture.declared;
      if (declared === null) return new Response("not found", { status: 404 });
      return json({ funnels: declared });
    }
    if (path.includes("/costs/timeseries")) {
      return json({
        buckets: Object.keys(fixture.costByCampaign)
          .filter((cid) => inScope(cid, q))
          .map((cid) => ({ period: "2026-01-02", totalCostInUsdCents: String(fixture.costByCampaign[cid]) })),
      });
    }
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});

    if (path.includes("/stats/costs")) {
      const groupBy = q.get("groupBy") ?? "";
      const wantsAudience = groupBy.includes("audienceId");
      return json({
        groups: Object.keys(fixture.costByCampaign)
          .filter((cid) => inScope(cid, q))
          .map((cid) => ({
            dimensions: { campaignId: cid, workflowSlug: "dawn-v1", ...(wantsAudience ? { audienceId: "aud-1" } : {}) },
            totalCostInUsdCents: String(fixture.costByCampaign[cid]),
            actualCostInUsdCents: String(fixture.costByCampaign[cid]),
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          })),
      });
    }

    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (path.endsWith("/orgs/leads")) {
      const only = q.get("campaignId");
      return json({ leads: only ? fixture.leads.filter((l) => l.campaignId === only) : fixture.leads });
    }

    // WHAT A HUMAN STATED — the only evidence "Meeting attended" has anywhere in the fleet.
    if (path.includes("/converted-lead-emails")) {
      if (fixture.convertedReadable === false) return new Response("boom", { status: 502 });
      const event = q.get("event") as "signup" | "form_submission";
      return json({ event, emails: (fixture.converted?.[event] ?? []).map(emailOf) });
    }
    if (path.includes("/converted-leads")) {
      if (fixture.statedReadable === false) return new Response("boom", { status: 502 });
      const event = q.get("event") as "meeting_booked" | "meeting_attended" | "sale";
      return json({
        outcomes: (fixture.stated?.[event] ?? []).map((leadId) => ({
          leadId,
          email: emailOf(leadId),
          campaignId: null,
          occurredAt: "2026-01-03T00:00:00.000Z",
          valueCents: null,
          source: "manual",
        })),
      });
    }
    if (path.includes("/manual-qualifications")) {
      if (fixture.legacyReadable === false) return new Response("boom", { status: 502 });
      return json({
        qualifications: [
          ...(fixture.legacy?.booked ?? []).map((leadId) => ({
            email: emailOf(leadId),
            status: "lead_meeting_booked",
            qualifiedAt: "2026-01-03T00:00:00.000Z",
          })),
          ...(fixture.legacy?.closed ?? []).map((leadId) => ({
            email: emailOf(leadId),
            status: "lead_closed",
            qualifiedAt: "2026-01-04T00:00:00.000Z",
          })),
        ],
      });
    }
    if (path.includes("/step-costs")) {
      if (fixture.stepCostsReadable === false) return new Response("boom", { status: 502 });
      return json({
        brandId: BRAND,
        costs: (fixture.stepCosts ?? []).map((c) => ({ kind: "outcome", ...c })),
      });
    }
    if (path.includes("/step-disqualifications")) return json({ byStep: {} });
    if (path.includes("/conversion-counts")) {
      return json({ counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 } });
    }
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 5000 });
    if (path.endsWith("/orgs/stats")) return json({ groups: [] });
    return json({});
  });
}

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation(
    (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
  );
};

type Step = {
  step: string;
  leadField: string;
  recipientsReached: number | null;
  costPerReachCents: number | null;
  fromStep: string;
  fromRecipientsReached: number | null;
  conversionFromPreviousPct: number | null;
  customerCost: {
    costCents: number;
    statedCount: number;
    unstatedCount: number;
    coverage: string;
    costPerReachCents: number | null;
  } | null;
};
type Breakdown = {
  funnelKey: string;
  name: string;
  committedSpentCents: number;
  contactedRecipients: number;
  steps: Step[];
};

/**
 * THE CONVERSATION FUNNEL, FULLY EVIDENCED.
 *
 * Four contacted leads: l1 replied, booked, attended and closed; l2 replied, booked and attended but
 * did not close; l3 replied only; l4 was contacted and did nothing. So every rung has a different
 * count and the rates between them are all distinct — a band that mislabels or mis-zips a rung cannot
 * pass by coincidence.
 */
const CONVERSATION_FIXTURE: Fixture = {
  campaigns: { c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER } },
  costByCampaign: { c1: 12000 },
  leads: [
    lead("c1", "l1", "reply"),
    lead("c1", "l2", "reply"),
    lead("c1", "l3", "reply"),
    lead("c1", "l4", "none"),
  ],
  stated: { meeting_booked: ["l1", "l2"], meeting_attended: ["l1", "l2"], sale: ["l1"] },
};

const funnelRevenue = (funnelKey: string, query = "") =>
  request(app)
    .get(`/offers/${OFFER}/funnels/${funnelKey}/revenue?brandId=${BRAND}${query}`)
    .set(AUTH);

describe("a funnel read step by step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers EVERY rung of a four-step reply-to-meeting funnel — count, cost and conversion", async () => {
    mockFetch(CONVERSATION_FIXTURE);
    const res = await funnelRevenue(CONVERSATION);
    expect(res.status).toBe(200);

    const band = res.body.funnelSteps as Breakdown;
    expect(band.funnelKey).toBe(CONVERSATION);
    expect(band.contactedRecipients).toBe(4);
    expect(band.committedSpentCents).toBe(12000);
    expect(band.steps.map((s) => s.step)).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
    expect(band.steps.map((s) => s.leadField)).toEqual([
      "repliedPositive",
      "meetingBooked",
      "meetingAttended",
      "purchased",
    ]);
    // No rung of the chain is unanswerable — the whole point.
    for (const step of band.steps) {
      expect(step.recipientsReached).not.toBeNull();
      expect(step.costPerReachCents).not.toBeNull();
      expect(step.conversionFromPreviousPct).not.toBeNull();
    }
    expect(band.steps.map((s) => s.recipientsReached)).toEqual([3, 2, 2, 1]);
    // 12000 committed cents over each rung's own count.
    expect(band.steps.map((s) => s.costPerReachCents)).toEqual([4000, 6000, 6000, 12000]);
    // Each rung over the one before it; the first over outreach.
    expect(band.steps.map((s) => s.fromStep)).toEqual([
      "Contacted",
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
    ]);
    expect(band.steps.map((s) => s.fromRecipientsReached)).toEqual([4, 3, 2, 2]);
    expect(band.steps.map((s) => s.conversionFromPreviousPct)).toEqual([75, (2 / 3) * 100, 100, 50]);
  });

  it("counts the SAME leads the response's own rows carry, and divides the SAME committed money", async () => {
    mockFetch(CONVERSATION_FIXTURE);
    const res = await funnelRevenue(CONVERSATION);
    const band = res.body.funnelSteps as Breakdown;
    const leads = res.body.leads as Array<Record<string, unknown>>;

    for (const step of band.steps) {
      expect(step.recipientsReached).toBe(leads.filter((l) => l[step.leadField] === true).length);
    }
    // ONE basis: the band's cents ARE the money block's cents, so a cost per rung and the ROI beside
    // it can never describe different dollars.
    expect(band.committedSpentCents).toBe(res.body.costEconomics.committedCostUsd * 100);
    expect(band.committedSpentCents).toBe(res.body.outcomes.committedSpentCents);
    expect(band.contactedRecipients).toBe(res.body.outcomes.recipientsContacted);
    expect(band.steps[0].recipientsReached).toBe(res.body.outcomes.recipientsRepliesPositive);
    for (const step of band.steps) {
      expect(step.costPerReachCents! * step.recipientsReached!).toBeCloseTo(band.committedSpentCents, 6);
    }
  });

  it("walks the visit-to-meeting, visit-to-signup and visit-to-form chains the same way", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: WEBSITE, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: PURCHASES, offerId: OFFER },
        c3: { featureSlug: PITCH, funnelKey: FORM, offerId: OFFER },
      },
      costByCampaign: { c1: 6000, c2: 6000, c3: 6000 },
      leads: [
        lead("c1", "w1", "click"),
        lead("c1", "w2", "none"),
        lead("c2", "s1", "click"),
        lead("c2", "s2", "none"),
        lead("c3", "f1", "click"),
        lead("c3", "f2", "none"),
      ],
      stated: { meeting_booked: ["w1"], meeting_attended: ["w1"], sale: ["w1", "s1", "f1"] },
      converted: { signup: ["s1"], form_submission: ["f1"] },
    });

    const website = (await funnelRevenue(WEBSITE)).body.funnelSteps as Breakdown;
    expect(website.steps.map((s) => s.step)).toEqual([
      "Website visit",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
    expect(website.steps.map((s) => s.recipientsReached)).toEqual([1, 1, 1, 1]);
    expect(website.steps.every((s) => s.conversionFromPreviousPct !== null)).toBe(true);

    const purchases = (await funnelRevenue(PURCHASES)).body.funnelSteps as Breakdown;
    expect(purchases.steps.map((s) => s.step)).toEqual(["Website visit", "Signup", "Paid client"]);
    expect(purchases.steps.map((s) => s.leadField)).toEqual(["clicked", "signup", "purchased"]);
    expect(purchases.steps.map((s) => s.recipientsReached)).toEqual([1, 1, 1]);

    const form = (await funnelRevenue(FORM)).body.funnelSteps as Breakdown;
    expect(form.steps.map((s) => s.step)).toEqual(["Website visit", "Form filled", "Paid client"]);
    expect(form.steps.map((s) => s.leadField)).toEqual(["clicked", "formSubmission", "purchased"]);
    expect(form.steps.map((s) => s.recipientsReached)).toEqual([1, 1, 1]);
  });

  it("reports a rung NOBODY reached as a measured 0 with a null cost — not as a gap", async () => {
    mockFetch({
      ...CONVERSATION_FIXTURE,
      stated: { meeting_booked: ["l1"], meeting_attended: [], sale: [] },
    });
    const band = (await funnelRevenue(CONVERSATION)).body.funnelSteps as Breakdown;
    const attended = band.steps[2];
    expect(attended.step).toBe("Meeting attended");
    expect(attended.recipientsReached).toBe(0);
    // 0 outcomes is not a denominator: a $0 cost per attended meeting would read as free.
    expect(attended.costPerReachCents).toBeNull();
    expect(attended.conversionFromPreviousPct).toBe(0);
    // And the rung AFTER a 0 has no base to convert from, which is not the same as converting at 0%.
    expect(band.steps[3].recipientsReached).toBe(0);
    expect(band.steps[3].conversionFromPreviousPct).toBeNull();
  });

  it("reports a rung whose evidence could not be READ as null — distinguishable from nobody reaching it", async () => {
    // The statements degrade; the LEGACY qualifications still answer. "Meeting attended" is stated by
    // hand only, so it alone goes unmeasured — booked and paid still read off the legacy source.
    mockFetch({
      ...CONVERSATION_FIXTURE,
      statedReadable: false,
      legacy: { booked: ["l1", "l2"], closed: ["l1"] },
    });
    const band = (await funnelRevenue(CONVERSATION)).body.funnelSteps as Breakdown;
    expect(band.steps.map((s) => s.recipientsReached)).toEqual([3, 2, null, 1]);

    const attended = band.steps[2];
    expect(attended.costPerReachCents).toBeNull();
    // A null count nulls BOTH rates that touch it — the one into it and the one out of it.
    expect(attended.conversionFromPreviousPct).toBeNull();
    expect(band.steps[3].fromRecipientsReached).toBeNull();
    expect(band.steps[3].conversionFromPreviousPct).toBeNull();
    // …and the rungs whose evidence WAS readable are unaffected.
    expect(band.steps[1].conversionFromPreviousPct).toBeCloseTo((2 / 3) * 100, 6);
  });

  it("reports booked and paid as null only when BOTH of their producers are unreadable", async () => {
    mockFetch({ ...CONVERSATION_FIXTURE, statedReadable: false, legacyReadable: false });
    const band = (await funnelRevenue(CONVERSATION)).body.funnelSteps as Breakdown;
    expect(band.steps.map((s) => s.recipientsReached)).toEqual([3, null, null, null]);
    // The engagement rung rides the core lead read, which is fail-loud: it is always measured.
    expect(band.steps[0].recipientsReached).toBe(3);
  });

  it("reports an unreadable website-conversion set as null while the other conversion still answers", async () => {
    mockFetch({
      campaigns: {
        c2: { featureSlug: PITCH, funnelKey: PURCHASES, offerId: OFFER },
        c3: { featureSlug: PITCH, funnelKey: FORM, offerId: OFFER },
      },
      costByCampaign: { c2: 6000, c3: 6000 },
      leads: [lead("c2", "s1", "click"), lead("c3", "f1", "click")],
      convertedReadable: false,
    });
    const purchases = (await funnelRevenue(PURCHASES)).body.funnelSteps as Breakdown;
    expect(purchases.steps[0].recipientsReached).toBe(1);
    expect(purchases.steps[1].recipientsReached).toBeNull();
  });

  it("walks the chain of a funnel it cannot PRICE — volume is measurable when money is not", async () => {
    mockFetch({ ...CONVERSATION_FIXTURE, declared: null });
    const res = await funnelRevenue(CONVERSATION);
    expect(res.status).toBe(200);
    expect(res.body.priced).toBe(false);
    expect(res.body.unpricedReason).toBe("no_economics_declared");
    const band = res.body.funnelSteps as Breakdown;
    expect(band.funnelKey).toBe(CONVERSATION);
    expect(band.contactedRecipients).toBe(4);
    expect(band.steps.map((s) => s.step)).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
    // The engagement rungs are real; the statement-backed rungs were never read on this path, so they
    // say "we could not measure this" rather than 0.
    expect(band.steps[0].recipientsReached).toBe(3);
    expect(band.steps.slice(1).every((s) => s.recipientsReached === null)).toBe(true);
  });

  it("states no chain when there is no ONE funnel to walk", async () => {
    mockFetch({
      campaigns: {
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: WEBSITE, offerId: OFFER },
      },
      costByCampaign: { c1: 6000, c2: 6000 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "click")],
      stated: { meeting_booked: ["l1"] },
    });
    // The brand read is priced on FOUR declared funnels at once: four chains, so no single one.
    const brand = await request(app).get(`/features/${PITCH}/revenue?brandId=${BRAND}`).set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.funnelSteps).toBeNull();

    // Naming one gives the chain back.
    const named = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&funnel=${CONVERSATION}`)
      .set(AUTH);
    expect((named.body.funnelSteps as Breakdown).funnelKey).toBe(CONVERSATION);

    // A lens is a SUBSET of the brand's leads beside the brand's whole spend — the same gate as spend.
    const lensed = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&lens=booked-meetings`)
      .set(AUTH);
    expect(lensed.status).toBe(200);
    expect(lensed.body.funnelSteps).toBeNull();
    expect(lensed.body.spend).toBeNull();
  });

  it("leaves every field an existing consumer reads untouched", async () => {
    mockFetch(CONVERSATION_FIXTURE);
    const res = await funnelRevenue(CONVERSATION);
    expect(res.body.headline.totalPipelineUsd).toBeGreaterThan(0);
    expect(res.body.costEconomics.committedCostUsd).toBe(120);
    expect(res.body.outcomes.recipientsContacted).toBe(4);
    expect(res.body.spend.totalSpentCents).toBe(12000);
    expect(Array.isArray(res.body.leads)).toBe(true);
    expect(res.body.steps).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);

    // The offer's own table row is byte-unchanged: it is LEAN, and a chain is a page's shape.
    const table = await request(app).get(`/offers/${OFFER}/funnels?brandId=${BRAND}`).set(AUTH);
    expect(table.status).toBe(200);
    const row = (table.body.funnels as Array<Record<string, unknown>>).find((f) => f.funnelKey === CONVERSATION)!;
    expect(row).not.toHaveProperty("funnelSteps");
    expect(row.headline).toEqual(res.body.headline);
  });
});

/**
 * WHAT THE CUSTOMER'S OWN WORK ON ONE ARROW COST THEM.
 *
 * The same four leads, with the customer's statements laid over them so every rung reads a different
 * shape: booked carries two real figures, attended carries one figure and one crossing nobody was
 * asked about, the sale carries only an unanswered one, and the reply — a leg the platform works and
 * bills for — carries none at all. A band that mis-zips a statement onto the wrong rung, or that
 * fabricates a zero for one, cannot pass by coincidence.
 */
const CUSTOMER_COST_FIXTURE: Fixture = {
  ...CONVERSATION_FIXTURE,
  stepCosts: [
    { campaignId: "c1", step: "meeting_booked", costCents: 1500 },
    { campaignId: "c1", step: "meeting_booked", costCents: 2500 },
    { campaignId: "c1", step: "meeting_attended", costCents: 6000 },
    { campaignId: "c1", step: "meeting_attended", costCents: null },
    { campaignId: "c1", step: "sale", costCents: null },
  ],
};

describe("what the customer states each rung of a funnel cost them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  it("states the customer's own money PER RUNG, with an average per person who crossed it", async () => {
    mockFetch(CUSTOMER_COST_FIXTURE);
    const res = await funnelRevenue(CONVERSATION);
    expect(res.status).toBe(200);
    const band = res.body.funnelSteps as Breakdown;

    // Two people booked; the customer stated $15 and $25 on that leg. So booking a meeting costs them
    // $20 on average — the number a customer opening this arrow is asking for, SERVED not divided.
    expect(band.steps[1].step).toBe("Meeting booked");
    expect(band.steps[1].recipientsReached).toBe(2);
    expect(band.steps[1].customerCost).toEqual({
      costCents: 4000,
      statedCount: 2,
      unstatedCount: 0,
      coverage: "platform_and_customer_spend",
      costPerReachCents: 2000,
    });

    // Two attended, one statement carried a figure and one did not: the total is a FLOOR and the row
    // says so, rather than guessing at the crossing nobody was asked about.
    expect(band.steps[2].step).toBe("Meeting attended");
    expect(band.steps[2].customerCost).toEqual({
      costCents: 6000,
      statedCount: 1,
      unstatedCount: 1,
      coverage: "platform_and_partial_customer_spend",
      costPerReachCents: 3000,
    });

    // Nobody has answered for the close, so there is no figure — and no average, never a $0 that
    // would say closing the deal was free.
    expect(band.steps[3].step).toBe("Paid client");
    expect(band.steps[3].customerCost).toEqual({
      costCents: 0,
      statedCount: 0,
      unstatedCount: 1,
      coverage: "platform_and_partial_customer_spend",
      costPerReachCents: null,
    });

    // The reply is a leg the PLATFORM works and bills for. Nobody is ever asked what it cost them.
    expect(band.steps[0].step).toBe("Positive reply");
    expect(band.steps[0].customerCost).toEqual({
      costCents: 0,
      statedCount: 0,
      unstatedCount: 0,
      coverage: "platform_spend_only",
      costPerReachCents: null,
    });
  });

  it("never folds the customer's money into what we charged, and leaves the funnel-wide answer alone", async () => {
    mockFetch(CUSTOMER_COST_FIXTURE);
    const withCosts = (await funnelRevenue(CONVERSATION)).body;
    mockFetch(CONVERSATION_FIXTURE);
    const without = (await funnelRevenue(CONVERSATION)).body;

    // Every CHARGED figure is byte-identical with and without the customer's statements.
    const charged = (b: Record<string, unknown>) =>
      (b.funnelSteps as Breakdown).steps.map((s) => [s.recipientsReached, s.costPerReachCents, s.conversionFromPreviousPct]);
    expect(charged(withCosts)).toEqual(charged(without));
    expect(withCosts.costEconomics).toEqual(without.costEconomics);
    expect((withCosts.funnelSteps as Breakdown).committedSpentCents).toBe(12000);

    // The funnel-WIDE answer a consumer already reads is exactly the sum of the same statements —
    // unchanged in shape, and never replaced by the per-rung one.
    expect(withCosts.customerCost).toEqual({ declaredCostUsd: 100, statedCount: 3, unstatedCount: 2 });
    expect(withCosts.costCoverage).toBe("platform_and_partial_customer_spend");
    expect(without.customerCost).toEqual({ declaredCostUsd: 0, statedCount: 0, unstatedCount: 0 });
  });

  it("tells a stated ZERO apart from a rung nobody was ever asked about", async () => {
    mockFetch({
      ...CONVERSATION_FIXTURE,
      stepCosts: [{ campaignId: "c1", step: "meeting_booked", costCents: 0 }],
    });
    const band = (await funnelRevenue(CONVERSATION)).body.funnelSteps as Breakdown;

    // Somebody ANSWERED, and the answer was zero: a real statement, counted.
    expect(band.steps[1].customerCost).toMatchObject({
      costCents: 0,
      statedCount: 1,
      unstatedCount: 0,
      coverage: "platform_and_customer_spend",
    });
    // Nobody was asked about the close at all — the same zero cents, a different statement.
    expect(band.steps[3].customerCost).toMatchObject({
      costCents: 0,
      statedCount: 0,
      unstatedCount: 0,
      coverage: "platform_spend_only",
    });
  });

  it("says 'we could not read this' rather than zero when the statements degrade", async () => {
    mockFetch({ ...CUSTOMER_COST_FIXTURE, stepCostsReadable: false });
    const res = await funnelRevenue(CONVERSATION);
    // The page still answers — every other number on it is right.
    expect(res.status).toBe(200);
    const band = res.body.funnelSteps as Breakdown;
    expect(band.steps.every((s) => s.customerCost === null)).toBe(true);
    expect(band.steps[1].recipientsReached).toBe(2);
    expect(res.body.customerCost).toBeNull();
  });

  it("scopes a rung's statements by the SAME campaigns its committed cents are scoped by", async () => {
    mockFetch({
      campaigns: {
        // c1 + c2 share ONE campaign identity (same brand, funnel and channel), so they are one
        // campaign to the customer and their money totals together. c3 sells another funnel entirely.
        c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c2: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER },
        c3: { featureSlug: PITCH, funnelKey: WEBSITE, offerId: OFFER },
      },
      costByCampaign: { c1: 6000, c2: 6000, c3: 6000 },
      leads: [lead("c1", "l1", "reply"), lead("c2", "l2", "reply"), lead("c3", "l3", "click")],
      stated: { meeting_booked: ["l1", "l2", "l3"] },
      stepCosts: [
        { campaignId: "c1", step: "meeting_booked", costCents: 1000 },
        { campaignId: "c2", step: "meeting_booked", costCents: 9000 },
        { campaignId: "c3", step: "meeting_booked", costCents: 4444 },
        { campaignId: null, step: "meeting_booked", costCents: 7777 },
      ],
    });

    // A campaign-narrowed read answers for the campaign's whole IDENTITY, exactly as its money does —
    // so both members' statements count and c3's, which sells a different funnel, does not. A
    // statement naming no campaign cannot be placed inside a narrowed scope, so it is left out rather
    // than parked on a rung nobody attributed it to.
    const narrowed = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&funnel=${CONVERSATION}&campaignId=c1`)
      .set(AUTH);
    expect((narrowed.body.funnelSteps as Breakdown).steps[1].customerCost).toMatchObject({
      costCents: 10000,
      statedCount: 2,
      costPerReachCents: 5000,
    });

    // The brand-wide read's spend leg is the brand's WHOLE spend, so its counterpart is every
    // statement the brand has made — the unplaceable one included.
    const brand = await request(app)
      .get(`/features/${PITCH}/revenue?brandId=${BRAND}&funnel=${CONVERSATION}`)
      .set(AUTH);
    expect((brand.body.funnelSteps as Breakdown).steps[1].customerCost).toMatchObject({
      costCents: 22221,
      statedCount: 4,
    });
  });
});
