import { describe, it, expect, vi } from "vitest";
import {
  computeOfferSourcing,
  fetchUnrecordedCostEvidence,
  unrecordedOriginsByCampaign,
  type ServeCost,
  type SourcedLead,
} from "./offer-sourcing.js";
import {
  originOfServe,
  originOfUnrecorded,
  sourcingOriginBySlug,
  withSourcingSlugs,
  APOLLO_BUYING_SIGNALS_FIRST_SERVE,
  SOURCING_ORIGIN_SLUGS,
  SOURCING_ORIGINS,
  SOURCING_ORIGINS_BY_CHANNEL,
} from "./sourcing-origins.js";
import { SEED_FEATURES } from "../seed/features.js";

const AUD_COLD = "aud-cold";
const AUD_SIGNAL = "aud-signal";
const lists = new Map<string, string | null>([
  [AUD_COLD, "apollo_search"],
  [AUD_SIGNAL, "linkedin_engagement"],
]);
const campaigns = [
  { id: "c1", featureSlug: "sales-cold-email-outreach", channelName: "Sales Cold Email Outreach", legKey: "start_to_conversation", status: "ongoing" },
  { id: "c2", featureSlug: "sales-cold-email-outreach", channelName: "Sales Cold Email Outreach", legKey: "start_to_conversation", status: "stopped" },
];

describe("sourcing origins", () => {
  it("every origin is a seeded feature that is not an acquisition channel", () => {
    for (const o of SOURCING_ORIGINS) {
      const f = SEED_FEATURES.find((s) => s.slug === o.slug);
      expect(f, o.slug).toBeDefined();
      expect(f!.acquisitionChannel).toBeNull();
      expect(f!.salesFunnels).toEqual([]);
    }
  });

  it("a serve's origin is its own slug when it carries one (new runs), else its audience's list kind (old runs)", () => {
    expect(originOfServe({ runFeatureSlug: "sourcing-apollo-buying-signals", audienceId: AUD_COLD, listOfAudience: lists })?.slug).toBe(
      "sourcing-apollo-buying-signals",
    );
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: AUD_COLD, listOfAudience: lists })?.slug).toBe(
      "sourcing-apollo-cold-filters",
    );
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: null, listOfAudience: lists })).toBeNull();
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: "unknown", listOfAudience: lists })).toBeNull();
  });

  it("a spend read about a sourcing channel also counts the origins THAT channel serves from; any other scope is unchanged", () => {
    expect(withSourcingSlugs(["sales-cold-email-outreach"])).toEqual([
      "sales-cold-email-outreach",
      "sourcing-apify-search",
      "sourcing-apollo-buying-signals",
      "sourcing-apollo-cold-filters",
      "sourcing-linkedin-engagement-signals",
    ]);
    expect(withSourcingSlugs(["sales-crm-email-outreach"])).toEqual(["sales-crm-email-outreach", "sourcing-crm-contacts"]);
    expect(withSourcingSlugs(["ai-meeting-booking"])).toEqual(["ai-meeting-booking"]);
  });

  it("every origin is served by at least one sourcing channel, and no origin by two channel families", () => {
    const servedBy = new Map<string, string[]>();
    for (const [channel, origins] of Object.entries(SOURCING_ORIGINS_BY_CHANNEL)) for (const o of origins) servedBy.set(o, [...(servedBy.get(o) ?? []), channel]);
    for (const slug of SOURCING_ORIGIN_SLUGS) expect(servedBy.has(slug), slug).toBe(true);
    // a CRM origin under cold email would be counted twice on a brand running both channels
    expect(servedBy.get("sourcing-crm-contacts")).toEqual(["sales-crm-email-outreach"]);
  });
});

describe("computeOfferSourcing", () => {
  const serves: ServeCost[] = [
    // c1: two cold serves, one signal serve (new state: carries its origin slug), one with no audience.
    { runId: "s1", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "100.5000000000" },
    { runId: "s2", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "99.5000000000" },
    { runId: "s3", campaignId: "c1", audienceId: AUD_SIGNAL, featureSlug: "sourcing-linkedin-engagement-signals", cents: "50.0000000000" },
    { runId: "s4", campaignId: "c2", audienceId: null, featureSlug: "sales-cold-email-outreach", cents: "10.0000000000" },
    // a serve of a campaign outside the offer is ignored
    { runId: "s5", campaignId: "other", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "999" },
  ];
  const leads: SourcedLead[] = [
    { leadId: "l1", campaignId: "c1", audienceId: AUD_COLD, positiveReply: true },
    { leadId: "l2", campaignId: "c1", audienceId: AUD_COLD, positiveReply: false },
    { leadId: "l3", campaignId: "c1", audienceId: AUD_SIGNAL, positiveReply: true },
    { leadId: "l4", campaignId: "c2", audienceId: null, positiveReply: false },
  ];
  const totals = new Map([
    ["c1", "650.0000000000"],
    ["c2", "40.0000000000"],
  ]);

  const r = computeOfferSourcing({ campaigns, serves, totalCentsByCampaign: totals, listOfAudience: lists, unrecordedOriginByCampaign: new Map(), leads, valuePerPositiveReplyUsd: 10 });

  it("sourcing + outreach = the campaign total to the cent, per campaign and overall", () => {
    const c1 = r.campaigns.find((c) => c.campaignId === "c1")!;
    expect(c1.sourcingCostUsd).toBe(2.5);
    expect(c1.outreachCostUsd).toBe(4);
    expect(c1.totalCostUsd).toBe(6.5);
    const c2 = r.campaigns.find((c) => c.campaignId === "c2")!;
    expect(c2.sourcingCostUsd + c2.outreachCostUsd!).toBe(c2.totalCostUsd);
    expect(r.totals).toEqual({ sourcingCostUsd: 2.6, outreachCostUsd: 4.3, totalCostUsd: 6.9 });
  });

  it("lists every origin, used or not, with leads, cost per lead, positive replies and cost per positive reply", () => {
    expect(r.origins.map((o) => o.slug)).toEqual(SOURCING_ORIGINS.map((o) => o.slug));
    const cold = r.origins.find((o) => o.slug === "sourcing-apollo-cold-filters")!;
    expect(cold).toMatchObject({ used: true, serveCount: 2, leadsServed: 2, sourcingCostUsd: 2, costPerLeadUsd: 1, positiveReplies: 1, sourcingCostPerPositiveReplyUsd: 2 });
    // c1 outreach $4 over 3 leads: 2/3 to cold.
    expect(cold.outreachCostUsd).toBeCloseTo(8 / 3, 10);
    expect(cold.endToEndCostUsd).toBeCloseTo(2 + 8 / 3, 10);
    expect(cold.roi).toBeCloseTo(10 / (2 + 8 / 3), 10);
    const signal = r.origins.find((o) => o.slug === "sourcing-linkedin-engagement-signals")!;
    expect(signal).toMatchObject({ used: true, serveCount: 1, leadsServed: 1, sourcingCostUsd: 0.5, positiveReplies: 1 });
    const crm = r.origins.find((o) => o.slug === "sourcing-crm-contacts")!;
    expect(crm).toMatchObject({ used: false, serveCount: 0, leadsServed: 0, costPerLeadUsd: null, roi: null, roiUnavailableReason: "nothing_spent" });
  });

  it("a serve or lead of unknown origin is unattributed, never spread", () => {
    expect(r.unattributed).toMatchObject({ slug: null, serveCount: 1, leadsServed: 1, sourcingCostUsd: 0.1 });
    // c2's outreach ($0.30) belongs to its only lead, which is unattributed.
    expect(r.unattributed.outreachCostUsd).toBeCloseTo(0.3, 10);
    // Σ origins end-to-end + unattributed = the offer total.
    const sum = r.origins.reduce((s, o) => s + o.endToEndCostUsd, 0) + r.unattributed.endToEndCostUsd;
    expect(sum).toBeCloseTo(r.totals.totalCostUsd, 10);
  });

  it("per campaign: its sources, and a cost per positive reply for each half and the total", () => {
    const c1 = r.campaigns.find((c) => c.campaignId === "c1")!;
    expect(c1.sources.map((s) => s.slug)).toEqual(["sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals"]);
    expect(c1.positiveReplies).toBe(2);
    expect(c1.costPerPositiveReply).toEqual({ sourcingUsd: 1.25, outreachUsd: 2, totalUsd: 3.25 });
  });

  it("a sourcing figure above the campaign total withholds the outreach share loudly, never a negative", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = computeOfferSourcing({
      campaigns: [campaigns[0]!],
      serves: serves.slice(0, 1),
      totalCentsByCampaign: new Map([["c1", "50"]]),
      listOfAudience: lists,
      unrecordedOriginByCampaign: new Map(),
      leads: [],
      valuePerPositiveReplyUsd: null,
    });
    expect(bad.campaigns[0]).toMatchObject({ outreachCostUsd: null, outreachUnavailableReason: "sourcing_exceeds_campaign_total" });
    expect(bad.totals.outreachCostUsd).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no value for a positive reply = no ROI, named", () => {
    const none = computeOfferSourcing({ campaigns, serves, totalCentsByCampaign: totals, listOfAudience: lists, unrecordedOriginByCampaign: new Map(), leads, valuePerPositiveReplyUsd: null });
    expect(none.origins[0]).toMatchObject({ roi: null, roiUnavailableReason: "no_positive_reply_value" });
  });
});

describe("every origin states its provider (a logo keys on the stated domain)", () => {
  it("Apollo origins are Apollo, LinkedIn engagement is LinkedIn, Apify search is Apify, your CRM contacts have none", () => {
    const provider = Object.fromEntries(SOURCING_ORIGINS.map((o) => [o.slug, o.provider]));
    expect(provider).toEqual({
      "sourcing-apollo-cold-filters": { name: "Apollo", domain: "apollo.io" },
      "sourcing-apollo-buying-signals": { name: "Apollo", domain: "apollo.io" },
      "sourcing-linkedin-engagement-signals": { name: "LinkedIn", domain: "linkedin.com" },
      "sourcing-crm-contacts": null,
      "sourcing-apify-search": { name: "Apify", domain: "apify.com" },
    });
  });

  it("the offer read carries it on every origin row and every campaign source; the unattributed row has none", () => {
    const r = computeOfferSourcing({
      campaigns: [{ id: "c1", featureSlug: "sales-cold-email-outreach", channelName: "x", legKey: null, status: null }],
      serves: [{ runId: "s", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "1" }],
      totalCentsByCampaign: new Map([["c1", "2"]]),
      listOfAudience: lists,
      unrecordedOriginByCampaign: new Map(),
      leads: [],
      valuePerPositiveReplyUsd: null,
    });
    for (const o of r.origins) expect(o.provider).toEqual(sourcingOriginBySlug(o.slug)!.provider);
    expect(r.unattributed.provider).toBeNull();
    expect(r.campaigns[0]!.sources[0]!.provider).toEqual({ name: "Apollo", domain: "apollo.io" });
  });
});

describe("unrecorded serves (no audience): attributed on positive evidence only", () => {
  const before = "2026-05-10T09:00:00.000Z";
  const after = "2026-10-03T09:00:00.000Z";
  const COLD = "sales-cold-email-outreach";

  it("Apollo lead costs only, all before Apollo Buying Signals existed -> Apollo Cold Filters", () => {
    const ev = [
      { costName: "apollo-credit", maxStartedAt: before },
      { costName: "apollo-enrichment-credit", maxStartedAt: before },
      { costName: "apollo-search-credit", maxStartedAt: before },
      { costName: "google-pro-3.1-tokens-input", maxStartedAt: after },
    ];
    expect(originOfUnrecorded(COLD, ev)?.slug).toBe("sourcing-apollo-cold-filters");
  });

  it("an Apollo cost on or after the first buying-signal serve (or of unknown date) proves nothing", () => {
    expect(originOfUnrecorded(COLD, [{ costName: "apollo-credit", maxStartedAt: after }])).toBeNull();
    expect(originOfUnrecorded(COLD, [{ costName: "apollo-credit", maxStartedAt: APOLLO_BUYING_SIGNALS_FIRST_SERVE }])).toBeNull();
    expect(originOfUnrecorded(COLD, [{ costName: "apollo-credit", maxStartedAt: null }])).toBeNull();
  });

  it("Apify search lead costs only -> Apify Search; both providers -> unattributed", () => {
    expect(originOfUnrecorded(COLD, [{ costName: "apify-pipelinelabs-lead", maxStartedAt: before }])?.slug).toBe("sourcing-apify-search");
    expect(
      originOfUnrecorded(COLD, [
        { costName: "apify-pipelinelabs-lead", maxStartedAt: before },
        { costName: "apollo-credit", maxStartedAt: before },
      ]),
    ).toBeNull();
  });

  it("no lead-provider cost (LLM, email verification, nothing at all) -> unattributed", () => {
    expect(originOfUnrecorded(COLD, [])).toBeNull();
    expect(
      originOfUnrecorded(COLD, [
        { costName: "apify-bounceverify-email", maxStartedAt: before },
        { costName: "anthropic-sonnet-4.6-tokens-input", maxStartedAt: before },
      ]),
    ).toBeNull();
  });

  it("a channel serving from ONE origin proves it (CRM email -> your CRM contacts), whatever its costs", () => {
    expect(originOfUnrecorded("sales-crm-email-outreach", [])?.slug).toBe("sourcing-crm-contacts");
    // an origin the channel never serves from is never picked
    expect(originOfUnrecorded("sales-crm-email-outreach", [{ costName: "apollo-credit", maxStartedAt: before }])?.slug).toBe("sourcing-crm-contacts");
  });

  it("an unrecorded serve AND lead move to the proven origin; campaign totals, sourcing totals and offer totals stay to the cent", () => {
    const serves: ServeCost[] = [
      { runId: "a", campaignId: "c1", audienceId: AUD_COLD, featureSlug: COLD, cents: "100.0000000000" },
      { runId: "b", campaignId: "c2", audienceId: null, featureSlug: COLD, cents: "23002.1234567890" },
      { runId: "c", campaignId: "c2", audienceId: null, featureSlug: COLD, cents: "0" },
    ];
    const leads: SourcedLead[] = [
      { leadId: "l1", campaignId: "c1", audienceId: AUD_COLD, positiveReply: false },
      { leadId: "l2", campaignId: "c2", audienceId: null, positiveReply: true },
    ];
    const totals = new Map([
      ["c1", "300.0000000000"],
      ["c2", "40000.0000000000"],
    ]);
    const base = { campaigns, serves, totalCentsByCampaign: totals, listOfAudience: lists, leads, valuePerPositiveReplyUsd: 50 };
    const beforeRule = computeOfferSourcing({ ...base, unrecordedOriginByCampaign: new Map() });
    const evidence = new Map([["c2", [{ costName: "apollo-credit", maxStartedAt: before }]]]);
    const afterRule = computeOfferSourcing({ ...base, unrecordedOriginByCampaign: unrecordedOriginsByCampaign(campaigns, evidence) });

    expect(beforeRule.unattributed).toMatchObject({ serveCount: 2, leadsServed: 1, sourcingCostUsd: 230.021234567890 });
    expect(afterRule.unattributed).toMatchObject({ used: false, serveCount: 0, leadsServed: 0, sourcingCostUsd: 0, positiveReplies: 0 });
    const cold = afterRule.origins.find((o) => o.slug === "sourcing-apollo-cold-filters")!;
    expect(cold).toMatchObject({ serveCount: 3, leadsServed: 2, positiveReplies: 1 });
    expect(cold.sourcingCostUsd).toBeCloseTo(231.02123456789, 9);

    expect(afterRule.totals).toEqual(beforeRule.totals);
    for (const c of afterRule.campaigns) {
      const b = beforeRule.campaigns.find((x) => x.campaignId === c.campaignId)!;
      expect([c.sourcingCostUsd, c.outreachCostUsd, c.totalCostUsd]).toEqual([b.sourcingCostUsd, b.outreachCostUsd, b.totalCostUsd]);
    }
    expect(afterRule.campaigns.find((c) => c.campaignId === "c2")!.sources.map((s) => s.slug)).toEqual(["sourcing-apollo-cold-filters"]);
    const endToEnd = (r: typeof afterRule) => r.origins.reduce((s, o) => s + o.endToEndCostUsd, 0) + r.unattributed.endToEndCostUsd;
    expect(endToEnd(afterRule)).toBeCloseTo(endToEnd(beforeRule), 9);
  });

  it("a serve with an audience human-service states no list for stays unattributed (the evidence is about audience-less runs)", () => {
    const origin = originOfServe({
      runFeatureSlug: COLD,
      audienceId: "aud-without-list",
      listOfAudience: new Map([["aud-without-list", null]]),
      unrecordedOrigin: sourcingOriginBySlug("sourcing-apollo-cold-filters"),
    });
    expect(origin).toBeNull();
  });
});

describe("fetchUnrecordedCostEvidence", () => {
  it("reads runs costs by campaign, audience and cost name, keeping only audience-less rows of the offer's campaigns", async () => {
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          groups: [
            { dimensions: { campaignId: "c1", audienceId: null, costName: "apollo-credit" }, maxStartedAt: "2026-05-01T00:00:00.000Z" },
            { dimensions: { campaignId: "c1", audienceId: "aud", costName: "apify-pipelinelabs-lead" }, maxStartedAt: "2026-06-01T00:00:00.000Z" },
            { dimensions: { campaignId: "other", audienceId: null, costName: "apify-pipelinelabs-lead" }, maxStartedAt: null },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ev = await fetchUnrecordedCostEvidence("brand", ["c1"], ["sales-cold-email-outreach"], { orgId: "org" });
      expect(ev.get("c1")).toEqual([{ costName: "apollo-credit", maxStartedAt: "2026-05-01T00:00:00.000Z" }]);
      expect(ev.has("other")).toBe(false);
      const u = new URL(calls[0]!);
      expect(u.pathname).toBe("/v1/stats/costs");
      expect(u.searchParams.get("groupBy")).toBe("campaignId,audienceId,costName");
      expect(u.searchParams.get("featureSlugs")).toBe(withSourcingSlugs(["sales-cold-email-outreach"]).join(","));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a lead carries EVERY source that found it (owner 2026-10-08: no first-found credit)", () => {
  const AUD_SIGNALS_APOLLO = "aud-buying";
  const listsMulti = new Map<string, string | null>([...lists, [AUD_SIGNALS_APOLLO, "apollo_buying_signal"]]);
  const serves: ServeCost[] = [
    { runId: "s1", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "100" },
    { runId: "s2", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "100" },
    { runId: "s3", campaignId: "c1", audienceId: AUD_SIGNAL, featureSlug: "sourcing-linkedin-engagement-signals", cents: "100" },
    { runId: "s4", campaignId: "c2", audienceId: null, featureSlug: "sales-cold-email-outreach", cents: "100" },
  ];
  // l1 served from cold, ALSO found by the LinkedIn signal and the Apollo buying signal (3 sources).
  // l2 served from cold, also found by the LinkedIn signal (2 sources). l3 LinkedIn only. l4 nothing proven.
  // l1 is on two campaigns: still ONE lead of the offer.
  const leads: SourcedLead[] = [
    { leadId: "l1", campaignId: "c1", audienceId: AUD_COLD, positiveReply: true, email: "A@x.com", servedAt: "2026-08-01T00:00:00.000Z" },
    { leadId: "l1", campaignId: "c2", audienceId: null, positiveReply: false, email: "a@x.com", servedAt: "2026-08-05T00:00:00.000Z" },
    { leadId: "l2", campaignId: "c1", audienceId: AUD_COLD, positiveReply: true, email: "b@x.com", servedAt: "2026-10-07T00:00:00.000Z" },
    { leadId: "l3", campaignId: "c1", audienceId: AUD_SIGNAL, positiveReply: false, email: "c@x.com", servedAt: "2026-08-01T00:00:00.000Z" },
    { leadId: "l4", campaignId: "c2", audienceId: null, positiveReply: false, email: "d@x.com", servedAt: null },
  ];
  const memberships = new Map<string, Set<string>>([
    ["a@x.com", new Set(["sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals", "sourcing-apollo-buying-signals"])],
    ["b@x.com", new Set(["sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals"])],
    ["c@x.com", new Set(["sourcing-linkedin-engagement-signals"])],
  ]);
  const totals = new Map([
    ["c1", "700"],
    ["c2", "200"],
  ]);
  const base = {
    campaigns,
    serves,
    totalCentsByCampaign: totals,
    listOfAudience: listsMulti,
    unrecordedOriginByCampaign: new Map(),
    leads,
    valuePerPositiveReplyUsd: 10,
    now: new Date("2026-10-08T12:00:00.000Z"),
  };
  const r = computeOfferSourcing({ ...base, memberships });
  const by = (slug: string) => r.origins.find((o) => o.slug === slug)!;

  it("each source counts every lead carrying it, and how many of those another source found too", () => {
    expect(by("sourcing-apollo-cold-filters")).toMatchObject({ leadsServed: 2, leadsAlsoFoundByAnotherSource: 2, positiveReplies: 2 });
    expect(by("sourcing-linkedin-engagement-signals")).toMatchObject({ leadsServed: 3, leadsAlsoFoundByAnotherSource: 2, positiveReplies: 2 });
    expect(by("sourcing-apollo-buying-signals")).toMatchObject({ leadsServed: 1, leadsAlsoFoundByAnotherSource: 1, positiveReplies: 1, sourcingCostUsd: 0 });
    // l1's c2 row had no proven origin: a lead some source is proven for is never also unattributed.
    expect(r.unattributed).toMatchObject({ leadsServed: 1, positiveReplies: 0 });
  });

  it("Σ per-source leads − the leads with a source = Σ (sources − 1) over multi-source leads; buckets sum to the offer total", () => {
    const o = r.sourceOverlap!;
    const perSource = r.origins.reduce((s, x) => s + x.leadsServed, 0);
    expect(o.leadTotal).toBe(4);
    expect(o.sourceCreditTotal).toBe(perSource);
    expect(perSource).toBe(6);
    expect(o.multiSourceLeads).toBe(2);
    expect(o.extraSourceCredits).toBe((3 - 1) + (2 - 1));
    expect(perSource - (o.leadTotal - o.buckets[0]!.leads)).toBe(o.extraSourceCredits);
    expect(o.buckets.reduce((s, b) => s + b.leads, 0)).toBe(o.leadTotal);
    expect(o.buckets.map((b) => [b.label, b.leads, b.positiveReplies])).toEqual([
      ["unattributed", 1, 0],
      ["1", 1, 0],
      ["2", 1, 1],
      ["3+", 1, 1],
    ]);
    expect(o.positiveReplyTotal).toBe(2);
  });

  it("bucket rates follow the conversation leg's maturity rule: a lead served inside 21 days is flash only", () => {
    const o = r.sourceOverlap!;
    expect(o.maturityRule).toEqual({ legKey: "start_to_conversation", durationDays: 21, outcomesRequired: 1, cutoff: "2026-09-17T00:00:00.000Z" });
    const two = o.buckets.find((b) => b.label === "2")!;
    expect(two.positiveReplyRatePct).toBe(100);
    expect(two.maturity).toEqual({ flash: { leads: 1, positiveReplies: 1, positiveReplyRatePct: 100 }, mature: null, isMature: false });
    const three = o.buckets.find((b) => b.label === "3+")!;
    expect(three.maturity.isMature).toBe(true);
    const one = o.buckets.find((b) => b.label === "1")!;
    expect(one.maturity).toEqual({ flash: { leads: 1, positiveReplies: 0, positiveReplyRatePct: 0 }, mature: { leads: 1, positiveReplies: 0, positiveReplyRatePct: 0 }, isMature: false });
  });

  it("money totals are unchanged by the tags; each source's end-to-end cost counts its leads' outreach", () => {
    const without = computeOfferSourcing({ ...base, memberships: null });
    expect(r.totals).toEqual(without.totals);
    expect(r.campaigns).toEqual(without.campaigns);
    // c1 outreach $4 over l1,l2,l3 = $4/3 each; c2 outreach $1 over l1,l4 = $0.5 each.
    expect(by("sourcing-apollo-buying-signals").outreachCostUsd).toBeCloseTo(4 / 3 + 0.5, 10);
    expect(by("sourcing-linkedin-engagement-signals").outreachCostUsd).toBeCloseTo(4 + 0.5, 10);
  });

  it("memberships unreadable: each lead carries its serve's origin only, the overlap is null and named", () => {
    const without = computeOfferSourcing({ ...base, memberships: null });
    expect(without.sourceOverlap).toBeNull();
    expect(without.sourceOverlapUnavailableReason).toBe("memberships_unavailable");
    expect(without.origins.find((o) => o.slug === "sourcing-apollo-cold-filters")).toMatchObject({ leadsServed: 2, leadsAlsoFoundByAnotherSource: null });
    // l1 served from cold (c1) with an unproven row on c2: still cold only, never also unattributed.
    expect(without.unattributed.leadsServed).toBe(1);
  });
});

describe("fetchMembershipOrigins (human-service memberships, RAW)", () => {
  it("maps each email to the origins of this offer's (or offer-less) audiences, every page, never another offer's", async () => {
    vi.stubEnv("HUMAN_SERVICE_URL", "http://human");
    vi.stubEnv("HUMAN_SERVICE_API_KEY", "k");
    const page = (people: unknown[]) => new Response(JSON.stringify({ people }), { status: 200 });
    const fill = Array.from({ length: 4999 }, (_, i) => ({ emailNorm: `p${i}@x.com`, memberships: [] }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        page([
          ...fill,
          {
            emailNorm: "A@x.com",
            memberships: [
              { audienceId: "1", offerId: "off", list: "apollo_search" },
              { audienceId: "2", offerId: null, list: "linkedin_engagement" },
              { audienceId: "3", offerId: "other", list: "apollo_buying_signal" },
              { audienceId: "4", offerId: "off", list: null },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(page([{ emailNorm: "b@x.com", memberships: [{ audienceId: "5", offerId: "off", list: "apify_search" }] }]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchMembershipOrigins } = await import("./offer-sourcing.js");
    const out = await fetchMembershipOrigins("brand-1", "off", { orgId: "org-1" });
    expect([...out.get("a@x.com")!].sort()).toEqual(["sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals"]);
    expect([...out.get("b@x.com")!]).toEqual(["sourcing-apify-search"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("http://human/internal/brands/brand-1/memberships?orgId=org-1&limit=5000&offset=5000");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
