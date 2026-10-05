import { describe, it, expect } from "vitest";
import {
  priceContactedLeads,
  contactedEntryRatesByGroup,
  contactedGroupsOf,
  contactedEntryLegs,
  type ContactedGroupInput,
} from "./contacted-value.js";
import { computeRevenue, type ContactedPricing, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import type { ContactedValueResult } from "./contacted-value.js";

/** The pricing a pipeline read takes off this result (what `contactedPricingSoft` hands the engine). */
function contactedPricingOf(r: ContactedValueResult): ContactedPricing {
  return { entryRatePctByGroup: contactedEntryRatesByGroup(r.workflows), lastSentOnOrAfter: r.lastSentOnOrAfter };
}

// LTR $1,000. A website visit is worth $100 (10% visit→paid), a positive reply $400 (40% reply→paid).
const LTR = 1000;
const PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 100, engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 400, engagementRoute: true },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 500 },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, terminal: true },
];
const REPLY_ONLY = PATHS.filter((p) => p.signal !== "clicked");
const NOW = new Date("2026-09-26T12:00:00Z");
const OLD = "2026-08-01T10:00:00Z";
const YOUNG = "2026-09-24T10:00:00Z";

let seq = 0;
const RECENT_SEND = "2026-09-25T09:00:00Z"; // within 30 days of NOW
const STALE_SEND = "2026-08-26T11:59:59Z"; // just past 30 days before NOW (cutoff 2026-08-27T12:00:00Z)

function person(
  opts: {
    signals?: Record<string, boolean>;
    contactedAt?: string | null;
    lastSent?: string | null;
    orgId?: string | null;
    dead?: string[];
    campaignId?: string | null;
    workflowSlug?: string | null;
    valueUsd?: number;
  } = {},
): EnginePerson {
  seq += 1;
  const contacted = opts.contactedAt === undefined ? YOUNG : opts.contactedAt;
  return {
    leadId: `lead-${String(seq).padStart(5, "0")}`,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId: opts.orgId === undefined ? `org-${seq}` : opts.orgId,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    campaignId: opts.campaignId === undefined ? "camp-1" : opts.campaignId,
    workflowSlug: opts.workflowSlug === undefined ? "wf-a" : opts.workflowSlug,
    signals: { contacted: true, sent: true, delivered: true, ...(opts.signals ?? {}) },
    signalDates: { contacted, lastSent: opts.lastSent === undefined ? RECENT_SEND : opts.lastSent },
    servedAt: contacted,
    ...(opts.dead ? { deadSignals: opts.dead } : {}),
    ...(opts.valueUsd !== undefined ? { valueUsd: opts.valueUsd } : {}),
  };
}

const priced = (costPerOutcomeUsd: number | null, unpricedReason: string | null = null) => ({
  costPerOutcomeUsd,
  unpricedReason: costPerOutcomeUsd === null ? (unpricedReason ?? "workflow_unpriced") : null,
});

function group(
  workflowSlug: string,
  committedSpentUsd: number | null,
  prices: Record<string, { costPerOutcomeUsd: number | null; unpricedReason: string | null }>,
  campaignId = "camp-1",
): ContactedGroupInput {
  return {
    campaignId,
    workflowSlug,
    offerId: "offer-1",
    featureSlug: "sales-cold-email-outreach",
    workflowDynastySlug: `${workflowSlug}-dynasty`,
    committedSpentUsd,
    prices,
  };
}

describe("P(entry | contacted) per (campaign × workflow) = cost per contact ÷ the workflow's cost per outcome", () => {
  // Jubilation's real shape: one campaign, four workflows, the reply route only, a reply worth $106.3125.
  const V = 106.3125;
  const JUB_LTR = 425.25; // 25% reply→paid
  const JUB_PATHS: ResolvedPath[] = [
    { tag: "reply", signal: "positiveReply", expectedRevenueUsd: V, engagementRoute: true },
    { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: JUB_LTR, terminal: true },
  ];
  const WORKFLOWS = [
    { slug: "iceberg", spend: 37.09, price: 45.76, contacted: 300 },
    { slug: "torrent", spend: 10.16, price: 52, contacted: 100 },
    { slug: "raven", spend: 9.39, price: 50.85, contacted: 100 },
    { slug: "concerto", spend: 5.73, price: 44.72, contacted: 80 },
  ];
  const persons = WORKFLOWS.flatMap((w) => Array.from({ length: w.contacted }, () => person({ workflowSlug: w.slug })));
  const groups = WORKFLOWS.map((w) => group(w.slug, w.spend, { positiveReply: priced(w.price) }));
  const result = priceContactedLeads({ paths: JUB_PATHS, persons, lifetimeRevenueUsd: JUB_LTR, groups, now: NOW });

  it("the total is Σ over workflows of spend ÷ $/outcome × value at the step (≈ $140.2)", () => {
    const expected = WORKFLOWS.reduce((s, w) => s + (w.spend / w.price) * V, 0);
    expect(result.unmeasuredReason).toBeNull();
    expect(result.totalExpectedValueUsd).toBeCloseTo(expected, 6);
    expect(result.totalExpectedValueUsd).toBeCloseTo(140.2, 1);
  });

  it("each workflow row states its spend, contacts, cost per contact, price, rate and expected outcomes", () => {
    const iceberg = result.workflows.find((w) => w.workflowSlug === "iceberg")!;
    expect(iceberg).toMatchObject({
      campaignId: "camp-1",
      offerId: "offer-1",
      featureSlug: "sales-cold-email-outreach",
      workflowDynastySlug: "iceberg-dynasty",
      contacted: 300,
      committedSpentUsd: 37.09,
    });
    expect(iceberg.costPerContactUsd).toBeCloseTo(37.09 / 300, 12);
    expect(iceberg.routes).toHaveLength(1);
    expect(iceberg.routes[0]).toMatchObject({ signal: "positiveReply", legKey: "start_to_conversation", costPerOutcomeUsd: 45.76, unpricedReason: null });
    expect(iceberg.routes[0].entryRatePct).toBeCloseTo((37.09 / 300 / 45.76) * 100, 12);
    expect(iceberg.routes[0].expectedOutcomes).toBeCloseTo(37.09 / 45.76, 12);
  });

  it("perLeadExpectedValueUsd is the mean over priced, non-expired contacted-only leads", () => {
    expect(result.perLeadExpectedValueUsd).toBeCloseTo(result.totalExpectedValueUsd! / 580, 9);
  });

  it("a campaign 100% on one workflow reproduces the sales path's ROI: total ÷ spend = value at step ÷ $/outcome", () => {
    const solo = Array.from({ length: 123 }, () => person({ workflowSlug: "iceberg" }));
    const r = priceContactedLeads({
      paths: JUB_PATHS,
      persons: solo,
      lifetimeRevenueUsd: JUB_LTR,
      groups: [group("iceberg", 37.09, { positiveReply: priced(45.76) })],
      now: NOW,
    });
    expect(Math.abs(r.totalExpectedValueUsd! / 37.09 - V / 45.76)).toBeLessThan(1e-9);
  });

  it("a workflow whose ladder has no price carries no value, the others stay priced, no fallback rate", () => {
    const ps = [
      ...Array.from({ length: 10 }, () => person({ workflowSlug: "priced" })),
      ...Array.from({ length: 5 }, () => person({ workflowSlug: "bare" })),
    ];
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [
        group("priced", 20, { positiveReply: priced(40) }),
        group("bare", 9, { positiveReply: priced(null, "workflow_not_on_ladder") }),
      ],
      now: NOW,
    });
    const bare = r.workflows.find((w) => w.workflowSlug === "bare")!;
    expect(bare.routes[0]).toMatchObject({ costPerOutcomeUsd: null, unpricedReason: "workflow_not_on_ladder", entryRatePct: null, expectedOutcomes: null });
    const bareIds = new Set(ps.slice(10).map((p) => p.leadId));
    for (const l of r.leads) {
      if (bareIds.has(l.leadId)) expect(l.expectedValueUsd).toBeNull();
      else expect(l.expectedValueUsd).toBeCloseTo((2 / 40) * 400, 6);
    }
    expect(r.population.unpriced).toBe(5);
    expect(r.totalExpectedValueUsd).toBeCloseTo((20 / 40) * 400, 6);
    expect(r.unmeasuredReason).toBeNull();
  });

  it("cost per contact above the cost per outcome caps P at 100%", () => {
    const ps = Array.from({ length: 10 }, () => person({ workflowSlug: "dear" }));
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [group("dear", 100, { positiveReply: priced(5) })],
      now: NOW,
    });
    expect(r.workflows[0].routes[0].entryRatePct).toBe(100);
    expect(r.workflows[0].routes[0].expectedOutcomes).toBe(10);
    for (const l of r.leads) expect(l.expectedValueUsd).toBeCloseTo(400, 9);
  });

  it("a person with no campaign or no workflow is unattributed and carries no value", () => {
    const ps = [person({ campaignId: null }), person({ workflowSlug: null }), person()];
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", 1, { positiveReply: priced(10) })],
      now: NOW,
    });
    expect(r.population.unattributed).toBe(2);
    expect(r.workflows.map((w) => [w.workflowSlug, w.contacted])).toEqual([["wf-a", 1]]);
    expect(r.leads.find((l) => l.leadId === ps[0].leadId)!.expectedValueUsd).toBeNull();
    expect(r.leads.find((l) => l.leadId === ps[1].leadId)!.expectedValueUsd).toBeNull();
    expect(r.leads.find((l) => l.leadId === ps[2].leadId)!.expectedValueUsd).toBeCloseTo(0.1 * 400, 9);
  });

  it("runs recording no spend for a group prices nothing (never a free lead at P = 0)", () => {
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: [person()],
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", null, { positiveReply: priced(10) })],
      now: NOW,
    });
    expect(r.workflows[0].routes[0]).toMatchObject({ entryRatePct: null, unpricedReason: "no_spend_recorded" });
    expect(r.unmeasuredReason).toBe("no_entry_rate");
  });

  it("every contacted person counts in the contacts of its group, engaged and bounced included", () => {
    const ps = [person(), person({ signals: { positiveReply: true } }), person({ signals: { bounced: true } })];
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", 3, { positiveReply: priced(10) })],
      now: NOW,
    });
    expect(r.workflows[0].contacted).toBe(3);
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0].expectedValueUsd).toBeCloseTo(0.1 * 400, 9);
  });

  it("both routes: each takes its own leg's price, combined as independent shots", () => {
    const ps = Array.from({ length: 50 }, () => person());
    const r = priceContactedLeads({
      paths: PATHS,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", 10, { clicked: priced(5), positiveReply: priced(50) })],
      now: NOW,
    });
    // cost per contact $0.20 → P(click) = 4%, P(reply) = 0.4%.
    const p = 1 - (1 - 0.04 * 0.1) * (1 - 0.004 * 0.4);
    for (const l of r.leads) expect(l.expectedValueUsd).toBeCloseTo(LTR * p, 6);
    expect(r.workflows[0].routes.map((x) => [x.signal, x.legKey])).toEqual([
      ["clicked", "start_to_website_visit"],
      ["positiveReply", "start_to_conversation"],
    ]);
  });
});

describe("the pipeline prices a contacted-only lead by its own group's rate (engine)", () => {
  it("computeRevenue adds exactly the read's total, group by group", () => {
    const a = Array.from({ length: 4 }, () => person({ workflowSlug: "wf-a" }));
    const b = Array.from({ length: 2 }, () => person({ workflowSlug: "wf-b" }));
    const r = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: [...a, ...b],
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", 2, { positiveReply: priced(10) }), group("wf-b", 2, { positiveReply: priced(20) })],
      now: NOW,
    });
    const pricing = contactedPricingOf(r);
    expect(pricing.entryRatePctByGroup["camp-1|wf-a"].positiveReply).toBeCloseTo(5, 12);
    expect(pricing.entryRatePctByGroup["camp-1|wf-b"].positiveReply).toBeCloseTo(5, 12);
    const engine = computeRevenue(REPLY_ONLY, [...a, ...b], LTR, [], pricing);
    expect(engine.headline.totalPipelineUsd).toBeCloseTo(r.totalExpectedValueUsd!, 6);
    expect(engine.leads.find((l) => l.leadId === a[0].leadId)?.expectedRevenueUsd).toBeCloseTo(0.05 * 400, 6);
    // A lead of a group the read never priced carries nothing.
    const stray = person({ workflowSlug: "wf-unknown" });
    expect(computeRevenue(REPLY_ONLY, [stray], LTR, [], pricing).headline.totalPipelineUsd).toBe(0);
  });
});

describe("priceContactedLeads — who is priced", () => {
  const G = [group("wf-a", 1, { clicked: priced(5), positiveReply: priced(50) })];
  it("an engaged lead is not in the read, and the pipeline's figure for it is untouched", () => {
    const clicker = person({ signals: { clicked: true } });
    const negative = person({ signals: { negativeReply: true } });
    const bounced = person({ signals: { bounced: true } });
    const quiet = person({ signals: { open: true } });
    const persons = [clicker, negative, bounced, quiet];
    const before = computeRevenue(PATHS, persons, LTR);
    const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, groups: G, now: NOW });
    const after = computeRevenue(PATHS, persons, LTR);
    expect(result.leads.map((l) => l.leadId)).toEqual([quiet.leadId]);
    expect(result.population).toEqual({
      contactedOnly: 1, organizations: 1, engaged: 2, cannotConvert: 1, expired: 0, unattributed: 0, unpriced: 0,
    });
    expect(after).toEqual(before);
    expect(after.headline.totalPipelineUsd).toBe(100);
  });

  it("people of one organisation are one client: the total takes the MOST valuable member, the pipeline's rule", () => {
    const a = person({ orgId: "acme" });
    const b = person({ orgId: "acme", dead: ["positiveReply"] });
    const result = priceContactedLeads({ paths: PATHS, persons: [a, b], lifetimeRevenueUsd: LTR, groups: G, now: NOW });
    const va = result.leads.find((l) => l.leadId === a.leadId)!.expectedValueUsd!;
    expect(result.population.organizations).toBe(1);
    expect(result.totalExpectedValueUsd).toBeCloseTo(va, 6);
    expect(computeRevenue(PATHS, [a, b], LTR, [], contactedPricingOf(result)).headline.totalPipelineUsd).toBeCloseTo(
      result.totalExpectedValueUsd!,
      6,
    );
  });

  it("a route a human ruled the lead out of contributes nothing", () => {
    const ruledOut = person({ dead: ["positiveReply"] });
    const result = priceContactedLeads({ paths: PATHS, persons: [ruledOut], lifetimeRevenueUsd: LTR, groups: G, now: NOW });
    // cost per contact $1 → P(click) = 20%.
    expect(result.leads[0].expectedValueUsd).toBeCloseTo(0.2 * 100, 6);
  });

  it("a stated value scales the lead's ladder", () => {
    const big = person({ valueUsd: 2 * LTR });
    const result = priceContactedLeads({ paths: REPLY_ONLY, persons: [big], lifetimeRevenueUsd: LTR, groups: G, now: NOW });
    expect(result.leads[0].expectedValueUsd).toBeCloseTo(2 * 0.02 * 400, 6);
  });

  it("only the routes of the funnels the brand is priced on count (a reply-only funnel prices no click)", () => {
    const result = priceContactedLeads({ paths: REPLY_ONLY, persons: [person()], lifetimeRevenueUsd: LTR, groups: G, now: NOW });
    expect(result.routes.map((r) => [r.signal, r.legKey])).toEqual([["positiveReply", "start_to_conversation"]]);
    expect(result.workflows[0].routes.map((r) => r.signal)).toEqual(["positiveReply"]);
    expect(contactedEntryLegs(REPLY_ONLY)).toEqual([{ signal: "positiveReply", legKey: "start_to_conversation" }]);
  });
});

describe("contactedGroupsOf", () => {
  it("counts contacted persons per (campaign × workflow), unattributed ones apart", () => {
    const groups = contactedGroupsOf([
      person({ workflowSlug: "x" }),
      person({ workflowSlug: "x", signals: { clicked: true } }),
      person({ workflowSlug: "y", campaignId: "camp-2" }),
      person({ workflowSlug: null }),
    ]);
    expect([...groups.values()]).toEqual([
      { campaignId: "camp-1", workflowSlug: "x", contacted: 2 },
      { campaignId: "camp-2", workflowSlug: "y", contacted: 1 },
    ]);
  });
});

describe("priceContactedLeads — no measurable probability is said, never a 0", () => {
  const persons = [person(), person()];
  const G = [group("wf-a", 1, { clicked: priced(5), positiveReply: priced(50) })];
  it.each([
    ["no_economics", { lifetimeRevenueUsd: null, paths: PATHS, groups: G }],
    ["no_client_value", { lifetimeRevenueUsd: 0, paths: PATHS, groups: G }],
    ["no_entry_path", { lifetimeRevenueUsd: LTR, paths: PATHS.filter((p) => !p.engagementRoute), groups: G }],
    ["no_entry_rate", { lifetimeRevenueUsd: LTR, paths: PATHS, groups: [group("wf-a", 1, { clicked: priced(null), positiveReply: priced(null) })] }],
  ] as const)("%s", (reason, input) => {
    const result = priceContactedLeads({ ...input, persons, now: NOW });
    expect(result.unmeasuredReason).toBe(reason);
    expect(result.perLeadExpectedValueUsd).toBeNull();
    expect(result.totalExpectedValueUsd).toBeNull();
    expect(result.leads.map((l) => l.expectedValueUsd)).toEqual([null, null]);
    expect(result.population.contactedOnly).toBe(2);
  });
});

describe("the OFFER grain borrows the brand's per-group rates verbatim", () => {
  it("the same lead gets the same value, from the brand's workflows[] rows", () => {
    const ps = Array.from({ length: 6 }, (_, i) => person({ workflowSlug: i < 3 ? "wf-a" : "wf-b" }));
    const brand = priceContactedLeads({
      paths: REPLY_ONLY,
      persons: ps,
      lifetimeRevenueUsd: LTR,
      groups: [group("wf-a", 3, { positiveReply: priced(10) }), group("wf-b", 3, { positiveReply: priced(30) })],
      now: NOW,
    });
    const offer = priceContactedLeads({ paths: REPLY_ONLY, persons: ps.slice(0, 3), lifetimeRevenueUsd: LTR, entryRatesFrom: brand.workflows, now: NOW });
    expect(offer.workflows).toEqual([brand.workflows[0]]);
    expect(offer.leads).toEqual(brand.leads.slice(0, 3));
    const none = priceContactedLeads({ paths: REPLY_ONLY, persons: ps, lifetimeRevenueUsd: LTR, entryRatesFrom: null, now: NOW });
    expect(none.unmeasuredReason).toBe("no_entry_rate");
  });
});

describe("a contacted lead's value EXPIRES 30 days after the LAST email sent to it", () => {
  const recent = person({ lastSent: RECENT_SEND });
  const stale = person({ lastSent: STALE_SEND, contactedAt: OLD });
  const neverSent = person({ lastSent: null, contactedAt: OLD }); // handed off 8 weeks ago, never sent
  const pendingFirstSend = person({ lastSent: null, contactedAt: YOUNG }); // queued two days ago
  const reSent = person({ contactedAt: OLD, lastSent: RECENT_SEND });
  const persons = [recent, stale, neverSent, reSent, pendingFirstSend];
  // 5 contacted, $5 spent → $1 per contact; reply at $50 → P = 2%, value $8.
  const G = [group("wf-a", 5, { positiveReply: priced(50) })];
  const result = priceContactedLeads({ paths: REPLY_ONLY, persons, lifetimeRevenueUsd: LTR, groups: G, now: NOW });
  const byId = new Map(result.leads.map((l) => [l.leadId, l]));

  it("a lead whose last send is older than 30 days, or never sent and handed off >30 days ago, is worth $0", () => {
    expect(result.lastSentOnOrAfter).toBe("2026-08-27T12:00:00.000Z");
    expect(byId.get(stale.leadId)).toMatchObject({ expectedValueUsd: 0, expired: true });
    expect(byId.get(neverSent.leadId)).toMatchObject({ expectedValueUsd: 0, expired: true });
    expect(result.population.expired).toBe(2);
  });

  it("a lead whose first email is still pending counts; the last send, not the first contact, decides", () => {
    expect(byId.get(pendingFirstSend.leadId)).toMatchObject({ expired: false });
    expect(byId.get(pendingFirstSend.leadId)!.expectedValueUsd).toBeCloseTo(8, 6);
    expect(byId.get(reSent.leadId)!.expectedValueUsd).toBeCloseTo(8, 6);
  });

  it("the per-lead mean leaves expired leads out", () => {
    expect(result.perLeadExpectedValueUsd).toBeCloseTo(8, 6);
  });

  it("the pipeline counts exactly the non-expired value, and nothing for an expired lead", () => {
    const pricing = contactedPricingOf(result);
    expect(result.totalExpectedValueUsd).toBeCloseTo(3 * 8, 6);
    expect(computeRevenue(REPLY_ONLY, persons, LTR, [], pricing).headline.totalPipelineUsd).toBeCloseTo(24, 6);
    expect(computeRevenue(REPLY_ONLY, [stale, neverSent], LTR, [], pricing).headline.totalPipelineUsd).toBe(0);
  });

  it("without contacted pricing the pipeline is unchanged (a bare delivery is worth nothing)", () => {
    expect(computeRevenue(REPLY_ONLY, persons, LTR).headline.totalPipelineUsd).toBe(0);
  });

  it("an engaged lead is valued exactly as before, contacted pricing or not", () => {
    const clicker = person({ signals: { clicked: true }, lastSent: STALE_SEND });
    const replier = person({ signals: { positiveReply: true } });
    const pricing = contactedPricingOf(result);
    expect(computeRevenue(PATHS, [clicker, replier], LTR, [], pricing)).toEqual(computeRevenue(PATHS, [clicker, replier], LTR));
  });
});
