/**
 * CAMPAIGN-TOTAL-POSREPLY-1106-B: the exact shape of prod funnel campaign b255706c (brand 33211c62), three units:
 * Lead Sourcing (Start -> Lead found), Cold Email (Lead found -> Positive reply) and the client's reply closing
 * (Positive reply -> Paid client). Its two positive repliers were last served by an AI Meeting Booking unit of
 * ANOTHER funnel campaign. The campaign chart (charted on the cold email leg) must count the same 2 positive replies
 * and the same people entered as the cold email pipe's own chart: prod 2026-11-06 15:08 read 0 / 1791 beside 2 / 1793.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./brand-spend-by-day-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./brand-spend-by-day-client.js")>()),
  fetchBrandCommittedSpendByDay: vi.fn(async (_b: string, scope: string | string[]) => {
    const ids = Array.isArray(scope) ? scope : [scope];
    const byDay = new Map<string, number>();
    if (ids.includes(SOURCING)) byDay.set("2026-10-30", 112.8);
    if (ids.includes(COLD_EMAIL)) byDay.set("2026-10-31", (byDay.get("2026-10-31") ?? 0) + 166.7);
    return byDay;
  }),
}));
vi.mock("./spend-by-task-day-client.js", () => ({ fetchSpendByTaskDay: vi.fn(async () => []) }));
vi.mock("./pipe-spend-attribution-io.js", () => ({ resolvePipeSpendAttribution: vi.fn(async () => null) }));
vi.mock("./email-status-client.js", () => ({ fetchEventTimestamps: vi.fn(async () => new Map()) }));
vi.mock("./observed-steps.js", () => ({ fetchObservedStepFacts: vi.fn(async () => null) }));

const SOURCING = "c-sourcing";
const COLD_EMAIL = "c-cold-email";
const COLD_EMAIL_OLD = "c-cold-email-old";
const REPLY_CLOSING = "c-reply-closing";
const OTHER_FUNNEL_MEETING = "c-meeting-other-funnel";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { computeSpendChart } = await import("./spend-charts-io.js");
const { groupScope, leadingUnit, pipeScope } = await import("../routes/spend-charts.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

function row(leadId: string, campaignId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lc-${leadId}-${campaignId}`,
    leadId,
    campaignId,
    email: `${leadId}@acme.com`,
    lastServedAt: "2026-10-31T21:00:00.000Z",
    contacted: true,
    sent: true,
    delivered: true,
    replied: false,
    replyClassification: null,
    lead: { organization: null },
    ...over,
  };
}
const positive = { replied: true, replyClassification: "positive" };

// lead-service: the brand list keeps each person's LATEST serve; a campaign read widens to the campaign's identity.
const BRAND_LIST = [
  row("mario", OTHER_FUNNEL_MEETING, { ...positive, lastServedAt: "2026-11-05T03:23:05.333Z" }),
  row("edmund", OTHER_FUNNEL_MEETING, { ...positive, lastServedAt: "2026-11-02T13:23:27.564Z" }),
  row("ada", COLD_EMAIL),
  row("bob", SOURCING, { contacted: false, sent: false, delivered: false }),
];
const CAMPAIGN_READ: Record<string, Record<string, unknown>[]> = {
  [COLD_EMAIL]: [row("mario", COLD_EMAIL, positive), row("edmund", COLD_EMAIL_OLD, positive), row("ada", COLD_EMAIL)],
  [SOURCING]: [
    row("mario", SOURCING, { contacted: false, sent: false, delivered: false }),
    row("edmund", SOURCING, { contacted: false, sent: false, delivered: false }),
    row("ada", SOURCING, { contacted: false, sent: false, delivered: false }),
    row("bob", SOURCING, { contacted: false, sent: false, delivered: false }),
  ],
  [REPLY_CLOSING]: [],
};
const CAMPAIGN_ROWS = [
  { id: SOURCING, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "start_to_lead_found", acquisitionChannel: "lead-sourcing", status: "ongoing" },
  { id: COLD_EMAIL, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "lead_found_to_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "ongoing" },
  { id: COLD_EMAIL_OLD, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "lead_found_to_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "stopped" },
  { id: REPLY_CLOSING, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "conversation_to_paid_client", acquisitionChannel: "your-team-reply-closing", status: "ongoing" },
  { id: OTHER_FUNNEL_MEETING, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "conversation_to_meeting_booked", acquisitionChannel: "ai-meeting-booking", status: "ongoing" },
];

const FUNNEL_CAMPAIGN = {
  id: "sfc-1",
  brandId: "brand-1",
  offerId: "o1",
  salesFunnelId: "f1",
  salesFunnelName: "Cold Email Replies",
  status: "ongoing",
  stopReason: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  units: [
    { campaignId: REPLY_CLOSING, pipeId: "your-team-reply-closing|conversation_to_paid_client", featureSlug: "your-team-reply-closing", legKey: "conversation_to_paid_client", status: "ongoing" },
    { campaignId: COLD_EMAIL, pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", status: "ongoing" },
    { campaignId: SOURCING, pipeId: "lead-sourcing|start_to_lead_found", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", status: "ongoing" },
  ],
};
const PIPE_STEPS = new Map<string, { fromStep: string | null; toStep: string }>([
  ["lead-sourcing|start_to_lead_found", { fromStep: null, toStep: "lead_found" }],
  ["sales-cold-email-outreach|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
  ["your-team-reply-closing|conversation_to_paid_client", { fromStep: "conversation", toStep: "paid_client" }],
]);

function mockServices(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("http://campaign:3000/campaigns")) return json({ campaigns: CAMPAIGN_ROWS });
    if (url.startsWith("http://lead:3000/orgs/leads")) {
      const campaignId = new URL(url).searchParams.get("campaignId");
      return json({ leads: campaignId ? (CAMPAIGN_READ[campaignId] ?? []) : BRAND_LIST });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const EXPECTED = { costPerOutcome: null, unavailableReason: "no_model" } as never;

describe("funnel campaign spend chart total (CAMPAIGN-TOTAL-POSREPLY-1106-B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sourcing + cold email + reply closing: the campaign total counts the cold email unit's 2 positive replies", async () => {
    mockServices();
    const lead = leadingUnit(FUNNEL_CAMPAIGN.units, PIPE_STEPS)!;
    expect(lead.campaignId).toBe(COLD_EMAIL);
    const coldEmailUnit = FUNNEL_CAMPAIGN.units.find((u) => u.campaignId === COLD_EMAIL)!;
    const leg = { channelSlug: lead.featureSlug, legKey: lead.legKey, ...PIPE_STEPS.get(lead.pipeId)! };
    const chart = (scope: ReturnType<typeof groupScope>) =>
      computeSpendChart({
        brandId: "brand-1",
        scope,
        handedRows: [],
        expected: EXPECTED,
        fleetConversions: new Map(),
        brandRateOf: () => null,
        pricing: "net",
        headers: HEADERS,
        today: "2026-11-06",
      });

    const [campaign, pipe] = await Promise.all([chart(groupScope([FUNNEL_CAMPAIGN], leg)), chart(pipeScope(FUNNEL_CAMPAIGN, coldEmailUnit, PIPE_STEPS))]);

    expect(pipe.totals.outcomes).toBe(2);
    expect(campaign.totals.outcomes).toBe(2);
    expect(campaign.totals.converted).toBe(2);
    // Same people entered: the campaign never loses the repliers last served by another funnel campaign.
    expect(campaign.totals.entered).toBe(pipe.totals.entered);
    expect(campaign.totals.entered).toBe(3);
    // The campaign's spend is every unit's (sourcing included), divided by its 2 replies.
    expect(campaign.totals.spendUsd).toBeCloseTo(279.5, 6);
    expect(campaign.totals.costPerOutcomeUsd).toBeCloseTo(139.75, 6);
  });
});
