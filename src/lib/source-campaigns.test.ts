import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { computeOfferSourcing, type ServeCost, type SourcedLead } from "./offer-sourcing.js";
import { buildOutreachCampaignSplits, buildSourceCampaigns, sourceCampaignOrigins, withSourceCampaigns } from "./source-campaigns.js";
import { LEAD_FOUND_STEP, SOURCE_LEG_KEY, originOfUnrecorded, sourceCampaignKeyOf, SOURCING_ORIGINS } from "./sourcing-origins.js";
import { campaignNameKeyOf } from "./offer-sales-paths.js";
import { CHANNEL_STEP_KEYS } from "./acquisition-channels.js";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const lists = new Map<string, string | null>([
  ["aud-cold", "apollo_search"],
  ["aud-signal", "linkedin_engagement"],
]);
// Jubilation = cold email × start_to_conversation, spread over two campaign-service campaigns (c1, c2);
// a feedback-request campaign (c3) also sources from Apollo Cold Filters.
const campaigns = [
  { id: "c1", featureSlug: COLD, channelName: "Sales Cold Email", legKey: "start_to_conversation", status: "ongoing" },
  { id: "c2", featureSlug: COLD, channelName: "Sales Cold Email", legKey: "start_to_conversation", status: "stopped" },
  { id: "c3", featureSlug: FEEDBACK, channelName: "Feedback", legKey: "start_to_conversation", status: "stopped" },
];
const serves: ServeCost[] = [
  { runId: "s1", campaignId: "c1", audienceId: "aud-cold", featureSlug: COLD, cents: "100.25" },
  { runId: "s2", campaignId: "c1", audienceId: "aud-signal", featureSlug: "sourcing-linkedin-engagement-signals", cents: "50" },
  { runId: "s3", campaignId: "c2", audienceId: "aud-cold", featureSlug: COLD, cents: "30.5" },
  // no audience, nothing proves its origin: unattributed, stays with Jubilation
  { runId: "s4", campaignId: "c2", audienceId: null, featureSlug: COLD, cents: "7.13" },
  { runId: "s5", campaignId: "c3", audienceId: "aud-cold", featureSlug: FEEDBACK, cents: "4" },
];
const leads: SourcedLead[] = [
  { leadId: "l1", campaignId: "c1", audienceId: "aud-cold", positiveReply: true },
  { leadId: "l2", campaignId: "c1", audienceId: "aud-signal", positiveReply: false },
  { leadId: "l3", campaignId: "c2", audienceId: "aud-cold", positiveReply: false },
  { leadId: "l4", campaignId: "c3", audienceId: "aud-cold", positiveReply: false },
];
const sourcing = computeOfferSourcing({
  campaigns,
  serves,
  totalCentsByCampaign: new Map([
    ["c1", "400.77"],
    ["c2", "90.01"],
    ["c3", "12"],
  ]),
  listOfAudience: lists,
  unrecordedOriginByCampaign: new Map(),
  leads,
  valuePerPositiveReplyUsd: 55,
});
const NAMES = new Map(SOURCING_ORIGINS.map((o, i) => [sourceCampaignKeyOf(o.slug), `Name${i}`] as const));
const rows = buildSourceCampaigns({ sourcing, names: NAMES });
const bySlug = (slug: string) => rows.find((r) => r.channelSlug === slug)!;
const JUBILATION = campaignNameKeyOf(COLD, "start_to_conversation");

describe("source campaign identity (the contract campaign-service and billing key On/Off and budget on)", () => {
  it("(featureSlug = origin slug, legKey = start_to_lead_found), keyed like every campaign", () => {
    expect(SOURCE_LEG_KEY).toBe("start_to_lead_found");
    for (const o of SOURCING_ORIGINS) expect(sourceCampaignKeyOf(o.slug)).toBe(campaignNameKeyOf(o.slug, SOURCE_LEG_KEY));
    const cold = bySlug("sourcing-apollo-cold-filters");
    expect(cold).toMatchObject({
      kind: "source",
      campaignKey: "campaign:sourcing-apollo-cold-filters|start_to_lead_found",
      channelSlug: "sourcing-apollo-cold-filters",
      channelName: "Apollo Cold Filters",
      legKey: "start_to_lead_found",
      campaignName: "Name0",
      reactive: false,
      managed: true,
      operatedBy: "platform",
      fromStep: null,
      toStep: { key: "lead_found", label: "Lead found" },
      provider: { name: "Apollo", domain: "apollo.io" },
      roiBasis: "measured",
    });
  });

  it("lead_found is the hand-off, never a funnel step (no existing leg or funnel moves)", () => {
    expect(LEAD_FOUND_STEP.key).toBe("lead_found");
    expect((CHANNEL_STEP_KEYS as readonly string[]).includes("lead_found")).toBe(false);
  });

  it("every live origin is a source campaign; a retired one only when the offer used it", () => {
    expect(rows.map((r) => r.channelSlug)).toEqual([
      "sourcing-apollo-cold-filters",
      "sourcing-apollo-buying-signals",
      "sourcing-linkedin-engagement-signals",
      "sourcing-crm-contacts",
    ]);
    const used = { ...sourcing, origins: sourcing.origins.map((o) => (o.slug === "sourcing-apify-search" ? { ...o, used: true } : o)) };
    expect(sourceCampaignOrigins(used).map((o) => o.slug)).toContain("sourcing-apify-search");
  });

  it("a campaign whose featureSlug IS an origin sources from that origin (the future state)", () => {
    expect(originOfUnrecorded("sourcing-crm-contacts", [])?.slug).toBe("sourcing-crm-contacts");
    expect(originOfUnrecorded("sourcing-apollo-buying-signals", [{ costName: "apify-pipelinelabs-x", maxStartedAt: null }])?.slug).toBe(
      "sourcing-apollo-buying-signals",
    );
  });
});

describe("source campaign figures: the origin's, measured; an unused origin is unmeasured", () => {
  it("ROI = what its leads returned once contacted (the origin's measured ROI), cost = its sourcing", () => {
    const o = sourcing.origins.find((x) => x.slug === "sourcing-apollo-cold-filters")!;
    const cold = bySlug("sourcing-apollo-cold-filters");
    expect(cold.roi).toBe(o.roi);
    expect(cold.roi).not.toBeNull();
    expect(cold).toMatchObject({ leadsFound: 3, positiveReplies: 1, costUsd: o.sourcingCostUsd, endToEndCostUsd: o.endToEndCostUsd });
    expect(cold.costUsd).toBeCloseTo(1.3475, 10);
    for (const slug of ["sourcing-apollo-buying-signals", "sourcing-crm-contacts"]) {
      expect(bySlug(slug)).toMatchObject({ roi: null, roiUnavailableReason: "nothing_spent", costUsd: 0, leadsFound: 0 });
    }
  });

  it("an unreadable sourcing lists the live source campaigns with null figures and a reason", () => {
    const none = buildSourceCampaigns({ sourcing: null, names: NAMES });
    expect(none).toHaveLength(4);
    for (const r of none) expect(r).toMatchObject({ roi: null, roiUnavailableReason: "sourcing_unavailable", costUsd: null, leadsFound: null });
  });
});

describe("money: nothing moves, the outreach total is re-cut around the source campaigns", () => {
  const splits = buildOutreachCampaignSplits(sourcing);
  const jub = splits.find((s) => s.campaignKey === JUBILATION)!;
  const cold = bySlug("sourcing-apollo-cold-filters");

  it("Jubilation keeps its total (Σ of its campaign-service campaigns) and its identity", () => {
    expect(jub).toMatchObject({ featureSlug: COLD, legKey: "start_to_conversation", campaignIds: ["c1", "c2"] });
    expect(jub.totalCostUsd).toBeCloseTo(4.9078, 10);
  });

  it("Apollo Cold Filters' part of Jubilation + Jubilation's own cost = Jubilation's old total, to the cent", () => {
    const apolloOnJub = cold.costByOutreachCampaign.find((e) => e.campaignKey === JUBILATION)!.costUsd;
    const sourced = jub.sourcedBy.reduce((t, x) => t + x.costUsd, 0);
    expect(Math.round((sourced + jub.ownCostUsd) * 100)).toBe(Math.round(jub.totalCostUsd * 100));
    expect(apolloOnJub).toBeCloseTo(1.3075, 10);
    // own = outreach + the unattributed sourcing that stays on it
    expect(jub.unattributedSourcingCostUsd).toBeCloseTo(0.0713, 10);
    expect(jub.ownCostUsd).toBeCloseTo(jub.outreachCostUsd! + jub.unattributedSourcingCostUsd, 10);
  });

  it("over the offer: Σ source campaigns + Σ outreach own = the offer total, to the cent", () => {
    const sum = rows.reduce((t, r) => t + (r.costUsd ?? 0), 0) + splits.reduce((t, s) => t + s.ownCostUsd, 0);
    expect(Math.round(sum * 100)).toBe(Math.round(sourcing.totals.totalCostUsd * 100));
    expect(sum).toBeCloseTo(sourcing.totals.totalCostUsd, 9);
  });

  it("a source's cost is split per outreach campaign it fed (sums to its cost)", () => {
    expect(cold.costByOutreachCampaign.map((e) => e.campaignKey)).toEqual([JUBILATION, campaignNameKeyOf(FEEDBACK, "start_to_conversation")]);
    expect(cold.costByOutreachCampaign.reduce((t, e) => t + e.costUsd, 0)).toBeCloseTo(cold.costUsd!, 10);
  });
});

describe("withSourceCampaigns: additive on the sales-paths body", () => {
  const campaignsRows = [
    { campaignKey: JUBILATION, channelSlug: COLD, legKey: "start_to_conversation", reactive: false, roi: 0.87 },
    { campaignKey: "campaign:ai-meeting-booking|conversation_to_meeting_booked", channelSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", reactive: true, roi: 0.7 },
  ];
  const out = withSourceCampaigns({ offerId: "o", campaigns: campaignsRows }, rows);

  it("every existing campaign field is unchanged; fedBy is added", () => {
    out.campaigns!.forEach((c, i) => {
      const { fedBy, ...rest } = c;
      expect(rest).toEqual(campaignsRows[i]);
      expect(fedBy === null || typeof fedBy === "object").toBe(true);
    });
  });

  it("an entry campaign of a channel that sources leads is fed by Lead found from every source campaign; a reactive one is not", () => {
    expect(out.campaigns![0]!.fedBy).toEqual({ step: { ...LEAD_FOUND_STEP }, sourceCampaignKeys: rows.map((r) => r.campaignKey) });
    expect(out.campaigns![1]!.fedBy).toBeNull();
    expect(out.sourceCampaigns).toBe(rows);
  });

  it("a body without campaigns (pure build) gains only sourceCampaigns", () => {
    const bare = withSourceCampaigns({ offerId: "o" } as { offerId: string; campaigns?: never[] }, rows);
    expect("campaigns" in bare).toBe(false);
    expect(bare.sourceCampaigns).toHaveLength(4);
  });
});

describe("the routes wire it (source guards)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const paths = strip(readFileSync(new URL("../routes/offer-sales-paths.ts", import.meta.url), "utf8"));
  const sourcingRoute = strip(readFileSync(new URL("../routes/offer-sourcing.ts", import.meta.url), "utf8"));

  it("sales-paths reads the SAME net sourcing cell as the dashboard, fail-soft, and serves the source campaigns", () => {
    expect(paths).toContain('readOfferSourcing({ offerId, brandId, pricing: "net", identity })');
    expect(paths).toContain(".catch(");
    expect(paths).toContain("withSourceCampaigns(withRois, buildSourceCampaigns({ sourcing, names: sourceNames }))");
  });

  it("the sourcing cell includes the offer's SOURCE campaigns (featureSlug = an origin) and serves the outreach split", () => {
    expect(sourcingRoute).toContain("SOURCING_ORIGIN_SLUGS.includes(r.featureSlug)");
    expect(sourcingRoute).toContain("outreachCampaigns: buildOutreachCampaignSplits(result)");
  });
});
