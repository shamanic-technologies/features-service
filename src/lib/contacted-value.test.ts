import { describe, it, expect } from "vitest";
import { priceContactedLeads, fleetEntryCountsOf } from "./contacted-value.js";
import { computeRevenue, type ContactedPricing, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import type { ContactedValueResult } from "./contacted-value.js";

/** The pricing a pipeline read takes off this result (what `contactedPricingSoft` hands the engine). */
function contactedPricingOf(r: ContactedValueResult): ContactedPricing {
  return {
    entryRatePct: Object.fromEntries(r.routes.filter((x) => x.entryRatePct !== null).map((x) => [x.signal, x.entryRatePct!])),
    lastSentOnOrAfter: r.lastSentOnOrAfter,
  };
}

// LTR $1,000. A website visit is worth $100 (10% visit→paid), a positive reply $400 (40% reply→paid).
const LTR = 1000;
const PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 100, engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 400, engagementRoute: true },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 500 },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, terminal: true },
];
const NOW = new Date("2026-09-26T12:00:00Z");
const OLD = "2026-08-01T10:00:00Z"; // before the 21-day cutoff (2026-09-05, lib/maturity.ts)
const YOUNG = "2026-09-24T10:00:00Z";

let seq = 0;
const RECENT_SEND = "2026-09-25T09:00:00Z"; // within 30 days of NOW
const STALE_SEND = "2026-08-26T11:59:59Z"; // just past 30 days before NOW (cutoff 2026-08-27T12:00:00Z)

/**
 * `contactedAt` is also the SERVE date unless `servedAt` says otherwise — the brand's mature cohort is cut
 * on the serve (run-start) clock (lib/maturity.ts), and every fixture below was served when contacted.
 */
function person(opts: { signals?: Record<string, boolean>; contactedAt?: string | null; servedAt?: string | null; lastSent?: string | null; orgId?: string | null; dead?: string[] } = {}): EnginePerson {
  seq += 1;
  const contacted = opts.contactedAt === undefined ? YOUNG : opts.contactedAt;
  return {
    leadId: `lead-${String(seq).padStart(4, "0")}`,
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
    signals: { contacted: true, sent: true, delivered: true, ...(opts.signals ?? {}) },
    signalDates: {
      contacted,
      lastSent: opts.lastSent === undefined ? RECENT_SEND : opts.lastSent,
    },
    servedAt: opts.servedAt === undefined ? contacted : opts.servedAt,
    ...(opts.dead ? { deadSignals: opts.dead } : {}),
  };
}

// Fleet: 2% of contacted click, 0.5% reply positively.
const FLEET = { clicked: { contacted: 10_000, reached: 200 }, positiveReply: { contacted: 10_000, reached: 50 } };
// P(paid | contacted) = 1 − (1 − 0.02×0.1)(1 − 0.005×0.4) = 1 − 0.998 × 0.998 = 0.003996
const FLEET_P = 1 - (1 - 0.02 * 0.1) * (1 - 0.005 * 0.4);

describe("priceContactedLeads — a brand whose contacts have not engaged yet (webprime's shape)", () => {
  const persons = Array.from({ length: 69 }, () => person());
  const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });

  it("prices every one of the 69 contacted leads, non-null, on the fleet entry rates", () => {
    expect(result.unmeasuredReason).toBeNull();
    expect(result.leads).toHaveLength(69);
    for (const l of result.leads) expect(l.expectedValueUsd).toBeCloseTo(LTR * FLEET_P, 6);
    expect(result.routes.map((r) => [r.signal, r.entryRateSource, r.entryRatePct])).toEqual([
      ["clicked", "fleet_measured", 2],
      ["positiveReply", "fleet_measured", 0.5],
    ]);
    expect(result.contactedToPaidClientPct).toBeCloseTo(FLEET_P * 100, 6);
  });

  it("the total is the sum over organisations (one lead per organisation here)", () => {
    expect(result.totalExpectedValueUsd).toBeCloseTo(69 * LTR * FLEET_P, 4);
    expect(result.population).toEqual({ contactedOnly: 69, organizations: 69, engaged: 0, cannotConvert: 0, expired: 0 });
  });

  it("a route's value at its step IS the engine's own path value", () => {
    expect(result.routes.map((r) => [r.valueAtStepUsd, r.paidClientGivenStepPct])).toEqual([
      [100, 10],
      [400, 40],
    ]);
  });
});

describe("priceContactedLeads — who is priced", () => {
  it("an engaged lead is not in the read, and the pipeline's figure for it is untouched", () => {
    const clicker = person({ signals: { clicked: true } });
    const negative = person({ signals: { negativeReply: true } });
    const bounced = person({ signals: { bounced: true } });
    const quiet = person({ signals: { open: true } });
    const persons = [clicker, negative, bounced, quiet];
    const before = computeRevenue(PATHS, persons, LTR);
    const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    const after = computeRevenue(PATHS, persons, LTR);
    expect(result.leads.map((l) => l.leadId)).toEqual([quiet.leadId]);
    expect(result.population).toEqual({ contactedOnly: 1, organizations: 1, engaged: 2, cannotConvert: 1, expired: 0 });
    // The engine's answer for the clicker ($100) does not move and gains no contacted value.
    expect(after).toEqual(before);
    expect(after.leads.find((l) => l.leadId === clicker.leadId)?.expectedRevenueUsd).toBe(100);
    expect(after.headline.totalPipelineUsd).toBe(100);
  });

  it("people of one organisation are one client: the total takes the MOST valuable member, the pipeline's rule", () => {
    const a = person({ orgId: "acme" });
    const b = person({ orgId: "acme", dead: ["positiveReply"] });
    const result = priceContactedLeads({ paths: PATHS, persons: [a, b], lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    expect(result.population.organizations).toBe(1);
    expect(result.totalExpectedValueUsd).toBeCloseTo(LTR * FLEET_P, 6);
    // …and it is exactly what these leads add to the pipeline.
    expect(computeRevenue(PATHS, [a, b], LTR, [], contactedPricingOf(result)).headline.totalPipelineUsd).toBeCloseTo(
      result.totalExpectedValueUsd!,
      6,
    );
  });

  it("a route a human ruled the lead out of contributes nothing", () => {
    const ruledOut = person({ dead: ["positiveReply"] });
    const result = priceContactedLeads({ paths: PATHS, persons: [ruledOut], lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    expect(result.leads[0].expectedValueUsd).toBeCloseTo(LTR * 0.02 * 0.1, 6);
  });
});

describe("priceContactedLeads — where P(entry | contacted) is measured", () => {
  it("the brand's own MATURE cohort wins once it holds the ROUTE's leg bar; young serves stay out of the rate", () => {
    // 500 mature contacted, 20 clicked (4%); 2 replied (0.4%). 1,000 young, none engaged.
    const persons: EnginePerson[] = [];
    for (let i = 0; i < 20; i++) persons.push(person({ contactedAt: OLD, signals: { clicked: true } }));
    for (let i = 0; i < 2; i++) persons.push(person({ contactedAt: OLD, signals: { positiveReply: true } }));
    for (let i = 0; i < 478; i++) persons.push(person({ contactedAt: OLD }));
    for (let i = 0; i < 1000; i++) persons.push(person({ contactedAt: YOUNG }));
    const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    const click = result.routes.find((r) => r.signal === "clicked")!;
    const reply = result.routes.find((r) => r.signal === "positiveReply")!;
    // Each route on its own leg rule: 10 visits on the visit leg, ONE positive reply on the conversation leg.
    expect(click).toMatchObject({
      entryRateSource: "brand_measured", entryRatePct: 4, brand: { contacted: 500, reached: 20 },
      maturityDays: 21, minBrandOutcomes: 10, matureBefore: "2026-09-05T00:00:00.000Z",
    });
    expect(reply).toMatchObject({
      entryRateSource: "brand_measured", entryRatePct: 0.4, brand: { contacted: 500, reached: 2 },
      maturityDays: 21, minBrandOutcomes: 1,
    });
    expect(result.perLeadExpectedValueUsd).toBeCloseTo(LTR * (1 - (1 - 0.04 * 0.1) * (1 - 0.004 * 0.4)), 6);
    // Below the bar the fleet's rate stands: the same 2 replies are 0 on a brand that got none.
    const none = priceContactedLeads({
      paths: PATHS,
      persons: persons.filter((p) => !p.signals.positiveReply),
      lifetimeRevenueUsd: LTR,
      fleet: FLEET,
      now: NOW,
    });
    expect(none.routes.find((r) => r.signal === "positiveReply")).toMatchObject({ entryRateSource: "fleet_measured", entryRatePct: 0.5 });
  });

  it("the cohort is cut on the SERVE clock: a lead contacted long ago but served young is out", () => {
    const persons = [person({ contactedAt: OLD, servedAt: YOUNG, signals: { clicked: true } }), person({ contactedAt: OLD })];
    const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    expect(result.routes[0].brand).toEqual({ contacted: 1, reached: 0 });
  });

  it("undated leads are left out of the brand cohort", () => {
    const persons = [person({ contactedAt: null }), person({ contactedAt: OLD })];
    const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    expect(result.routes[0].brand.contacted).toBe(1);
    expect(result.leads).toHaveLength(2);
  });

  it("only the routes of the funnels the brand is priced on count (a reply-only funnel prices no click)", () => {
    const replyOnly = PATHS.filter((p) => p.signal !== "clicked");
    const result = priceContactedLeads({ paths: replyOnly, persons: [person()], lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
    expect(result.routes.map((r) => r.signal)).toEqual(["positiveReply"]);
    expect(result.perLeadExpectedValueUsd).toBeCloseTo(LTR * 0.005 * 0.4, 6);
  });
});

describe("priceContactedLeads — no measurable probability is said, never a 0", () => {
  const persons = [person(), person()];
  it.each([
    ["no_economics", { lifetimeRevenueUsd: null, paths: PATHS, fleet: FLEET }],
    ["no_client_value", { lifetimeRevenueUsd: 0, paths: PATHS, fleet: FLEET }],
    ["no_entry_path", { lifetimeRevenueUsd: LTR, paths: PATHS.filter((p) => !p.engagementRoute), fleet: FLEET }],
    ["no_entry_rate", { lifetimeRevenueUsd: LTR, paths: PATHS, fleet: null }],
  ] as const)("%s", (reason, input) => {
    const result = priceContactedLeads({ ...input, persons, now: NOW });
    expect(result.unmeasuredReason).toBe(reason);
    expect(result.perLeadExpectedValueUsd).toBeNull();
    expect(result.totalExpectedValueUsd).toBeNull();
    expect(result.contactedToPaidClientPct).toBeNull();
    expect(result.leads.map((l) => l.expectedValueUsd)).toEqual([null, null]);
    expect(result.population.contactedOnly).toBe(2);
  });
});

describe("fleetEntryCountsOf", () => {
  it("pools email-gateway's per-workflow recipient stats", () => {
    expect(
      fleetEntryCountsOf([
        { recipientsContacted: 100, recipientsClicked: 3, recipientsRepliesPositive: 1 },
        { recipientsContacted: 50, recipientsClicked: 1 },
      ]),
    ).toEqual({ clicked: { contacted: 150, reached: 4 }, positiveReply: { contacted: 150, reached: 1 } });
  });
});

describe("a contacted lead's value EXPIRES 30 days after the LAST email sent to it", () => {
  const recent = person({ lastSent: RECENT_SEND });
  const stale = person({ lastSent: STALE_SEND, contactedAt: OLD });
  const neverSent = person({ lastSent: null, contactedAt: OLD }); // handed off 8 weeks ago, never sent
  const pendingFirstSend = person({ lastSent: null, contactedAt: YOUNG }); // queued two days ago
  // First contacted long ago, but re-sent recently: the LAST send counts, never the contacted date.
  const reSent = person({ contactedAt: OLD, lastSent: RECENT_SEND });
  const persons = [recent, stale, neverSent, reSent, pendingFirstSend];
  const result = priceContactedLeads({ paths: PATHS, persons, lifetimeRevenueUsd: LTR, fleet: FLEET, now: NOW });
  const byId = new Map(result.leads.map((l) => [l.leadId, l]));

  it("a lead whose last send is older than 30 days, or never sent and handed off >30 days ago, is worth $0", () => {
    expect(result.lastSentOnOrAfter).toBe("2026-08-27T12:00:00.000Z");
    expect(byId.get(stale.leadId)).toMatchObject({ expectedValueUsd: 0, expired: true });
    expect(byId.get(neverSent.leadId)).toMatchObject({ expectedValueUsd: 0, expired: true });
    expect(result.population.expired).toBe(2);
  });

  it("a lead whose first email is still pending counts: its clock has not started", () => {
    expect(byId.get(pendingFirstSend.leadId)!.expired).toBe(false);
    expect(byId.get(pendingFirstSend.leadId)!.expectedValueUsd).toBeCloseTo(LTR * FLEET_P, 6);
  });

  it("the last send, not the first contact, decides", () => {
    expect(byId.get(reSent.leadId)).toMatchObject({ expired: false });
    expect(byId.get(reSent.leadId)!.expectedValueUsd).toBeCloseTo(LTR * FLEET_P, 6);
  });

  it("the pipeline counts exactly the non-expired value, and nothing for an expired lead", () => {
    const pricing = contactedPricingOf(result);
    const pipeline = computeRevenue(PATHS, persons, LTR, [], pricing);
    expect(result.totalExpectedValueUsd).toBeCloseTo(3 * LTR * FLEET_P, 6);
    expect(pipeline.headline.totalPipelineUsd).toBeCloseTo(result.totalExpectedValueUsd!, 6);
    expect(computeRevenue(PATHS, [stale, neverSent], LTR, [], pricing).headline.totalPipelineUsd).toBe(0);
  });

  it("without contacted pricing the pipeline is unchanged (a bare delivery is worth nothing)", () => {
    expect(computeRevenue(PATHS, persons, LTR).headline.totalPipelineUsd).toBe(0);
  });

  it("an engaged lead is valued exactly as before, contacted pricing or not", () => {
    const clicker = person({ signals: { clicked: true }, lastSent: STALE_SEND });
    const replier = person({ signals: { positiveReply: true } });
    const pricing = contactedPricingOf(result);
    expect(computeRevenue(PATHS, [clicker, replier], LTR, [], pricing)).toEqual(computeRevenue(PATHS, [clicker, replier], LTR));
  });
});
