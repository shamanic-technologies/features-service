import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audienceMetricPair,
  buildGroupMaturity,
  buildScopeMaturity,
  campaignKey,
  costRatiosPair,
  matureRows,
  outcomeRatiosPair,
  pairKey,
  parsePairKey,
  scopeMaturityVerdict,
  scopeSpendUsd,
  splitByCampaignFor,
  type ScopeCampaign,
  type SpendSplit,
} from "./scope-maturity.js";
import type { EnginePerson } from "./revenue-engine.js";
import { assembleOfferOutcomes, offerGroupSpend, type OfferLegGroup } from "./offer-outcomes.js";
import { ALL_STEP_EVIDENCE } from "./funnel-steps.js";

/**
 * ONE FIXTURE shaped like the campaign that reported the problem (features-service#1196, campaign
 * `3922c8e1…`, leg `start_to_conversation`): two member campaigns of one identity, 15 audiences, positive
 * replies spread over three of them, spend on every one — and a clock that puts some serves before the
 * 21-day cutoff and some after it.
 */
const NOW = new Date("2026-09-28T13:00:00.000Z");
// UTC midnight of 2026-09-07 — 21 days before NOW's day.
const OLD = "2026-08-20T10:00:00.000Z";
const YOUNG = "2026-09-20T10:00:00.000Z";
const REPLY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";

let seq = 0;
function person(input: {
  campaignId: string;
  audienceId?: string | null;
  servedAt?: string | null;
  replied?: boolean;
  clicked?: boolean;
  email?: string;
}): EnginePerson {
  seq += 1;
  return {
    leadId: `lead-${seq}`,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    email: input.email ?? `lead-${seq}@x.com`,
    campaignId: input.campaignId,
    servedAt: input.servedAt === undefined ? OLD : input.servedAt,
    audienceId: input.audienceId === undefined ? "aud-0" : input.audienceId,
    signals: {
      contacted: true,
      positiveReply: Boolean(input.replied),
      clicked: Boolean(input.clicked),
    },
  };
}

const CAMPAIGNS: ScopeCampaign[] = [
  { id: "live", legKey: REPLY_LEG },
  { id: "ancestor", legKey: REPLY_LEG },
];

describe("buildScopeMaturity — one leg of one campaign identity", () => {
  it("divides the leg's spend summed EXACTLY by its distinct repliers, on both bases", () => {
    const persons = [
      person({ campaignId: "live", replied: true }),
      person({ campaignId: "ancestor", replied: true }),
      person({ campaignId: "live", replied: true, servedAt: YOUNG }), // not mature yet
      person({ campaignId: "live", servedAt: YOUNG }),
    ];
    const spend = new Map<string, SpendSplit>([
      ["live", { flash: "43788.4312345678", mature: "30000.0000000001" }],
      ["ancestor", { flash: "10094.5376341927", mature: "10094.5376341927" }],
    ]);
    const m = buildScopeMaturity({ campaigns: CAMPAIGNS, persons, spend, serveDatesStated: true, now: NOW });

    expect(m.legs).toHaveLength(1);
    const leg = m.legs[0]!;
    expect(leg.legKey).toBe(REPLY_LEG);
    expect(leg.durationDays).toBe(21);
    expect(leg.outcomesRequired).toBe(1);
    // Exact: 43788.4312345678 + 10094.5376341927 = 53882.9688687605 cents, never rounded per campaign.
    expect(leg.flash!.spentUsd).toBeCloseTo(538.829688687605, 10);
    expect(leg.flash!.outcomes).toBe(3);
    expect(leg.flash!.contacted).toBe(4);
    expect(leg.flash!.costPerOutcomeUsd).toBeCloseTo(538.829688687605 / 3, 10);
    // Mature: the leads served before the cutoff, and the runs started before it.
    expect(leg.mature!.spentUsd).toBeCloseTo(400.945376341928, 10);
    expect(leg.mature!.outcomes).toBe(2);
    expect(leg.mature!.contacted).toBe(2);
    expect(leg.isMature).toBe(true);
    expect(m.isMature).toBe(true);
  });

  it("a campaign younger than 21 days is NOT mature — false, with its flash figures present", () => {
    const persons = [
      person({ campaignId: "live", replied: true, servedAt: YOUNG }),
      person({ campaignId: "live", servedAt: YOUNG }),
    ];
    const spend = new Map<string, SpendSplit>([["live", { flash: "5000", mature: "0" }]]);
    const m = buildScopeMaturity({ campaigns: CAMPAIGNS, persons, spend, serveDatesStated: true, now: NOW });

    const leg = m.legs[0]!;
    expect(leg.flash).toEqual({ spentUsd: 50, contacted: 2, outcomes: 1, costPerOutcomeUsd: 50, conversionRatePct: 50 });
    // Read, and empty: a zero cohort — never null, which would say "could not judge".
    expect(leg.mature).toEqual({ spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null, conversionRatePct: null });
    expect(leg.isMature).toBe(false);
    expect(m.isMature).toBe(false);
  });

  it("serve dates not stated → the cut cannot be made: every mature half and the verdict are null", () => {
    const persons = [person({ campaignId: "live", replied: true })];
    const spend = new Map<string, SpendSplit>([["live", { flash: "1000", mature: "1000" }]]);
    const m = buildScopeMaturity({ campaigns: CAMPAIGNS, persons, spend, serveDatesStated: false, now: NOW });
    expect(m.legs[0]!.flash!.outcomes).toBe(1);
    expect(m.legs[0]!.mature).toBeNull();
    expect(m.legs[0]!.isMature).toBeNull();
    expect(m.isMature).toBeNull();
  });

  it("the visit leg's bar is 10 visits: nine mature visits are not enough", () => {
    const campaigns: ScopeCampaign[] = [{ id: "v", legKey: VISIT_LEG }];
    const persons = Array.from({ length: 12 }, (_, i) =>
      person({ campaignId: "v", clicked: i < 9 || i === 11, servedAt: i === 11 ? YOUNG : OLD }),
    );
    const spend = new Map<string, SpendSplit>([["v", { flash: "12000", mature: "11000" }]]);
    const m = buildScopeMaturity({ campaigns, persons, spend, serveDatesStated: true, now: NOW });
    expect(m.legs[0]!.flash!.outcomes).toBe(10);
    expect(m.legs[0]!.mature!.outcomes).toBe(9);
    expect(m.legs[0]!.isMature).toBe(false);
  });

  it("leaves out a campaign with no leg and a leg whose outcome is not a counted signal", () => {
    const campaigns: ScopeCampaign[] = [
      { id: "legacy", legKey: null },
      { id: "ai", legKey: "conversation_to_meeting_booked" },
      { id: "live", legKey: REPLY_LEG },
    ];
    const persons = [person({ campaignId: "live", replied: true })];
    const spend = new Map<string, SpendSplit>([
      ["legacy", { flash: "9000", mature: "9000" }],
      ["ai", { flash: "200", mature: "200" }],
      ["live", { flash: "1000", mature: "1000" }],
    ]);
    const m = buildScopeMaturity({ campaigns, persons, spend, serveDatesStated: true, now: NOW });
    expect(m.legs.map((l) => l.legKey)).toEqual([REPLY_LEG]);
    expect(m.legs[0]!.flash!.spentUsd).toBe(10);
    expect(m.isMature).toBe(true);
  });
});

describe("scopeMaturityVerdict — the multi-leg rule", () => {
  const leg = (legKey: string, mature: { spentUsd: number; contacted: number; outcomes: number } | null, flashSpent = 100) =>
    buildScopeMaturity({
      campaigns: [{ id: legKey, legKey }],
      persons: [],
      spend: new Map([[legKey, { flash: String(flashSpent * 100), mature: String((mature?.spentUsd ?? 0) * 100) }]]),
      serveDatesStated: mature !== null,
      now: NOW,
    }).legs[0]!;

  it("is mature when EVERY leg present in its mature figures is mature", () => {
    const reply = { ...leg(REPLY_LEG, { spentUsd: 50, contacted: 0, outcomes: 0 }) };
    const matureReply = { ...reply, mature: { ...reply.mature!, outcomes: 2 }, isMature: true };
    const visitNotMature = { ...leg(VISIT_LEG, { spentUsd: 80, contacted: 0, outcomes: 0 }) };
    const visit = { ...visitNotMature, mature: { ...visitNotMature.mature!, outcomes: 3 } };
    // Both present, the visit leg holds 3 of its 10 → the brand is not mature.
    expect(scopeMaturityVerdict([matureReply, visit])).toBe(false);
    // The visit leg entirely young (nothing in its mature figures) → not present → the brand is mature.
    const youngVisit = { ...visit, mature: { spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null, conversionRatePct: null } };
    expect(scopeMaturityVerdict([matureReply, youngVisit])).toBe(true);
  });

  it("no leg present while the scope has spent is a young scope: false, never null", () => {
    const young = leg(REPLY_LEG, { spentUsd: 0, contacted: 0, outcomes: 0 });
    expect(scopeMaturityVerdict([young])).toBe(false);
  });

  it("nothing to judge at all is null, and so is a leg whose cut could not be made", () => {
    expect(scopeMaturityVerdict([])).toBeNull();
    expect(scopeMaturityVerdict([leg(REPLY_LEG, null)])).toBeNull();
  });
});

describe("rows add up to their scope — the audience partition", () => {
  // 15 audiences like the reported campaign, spend on every one, replies on three; one untagged serve.
  const audiences = Array.from({ length: 15 }, (_, i) => `aud-${i}`);
  const persons: EnginePerson[] = [];
  const split = new Map<string, SpendSplit>();
  audiences.forEach((aud, i) => {
    const campaignId = i % 2 === 0 ? "live" : "ancestor";
    persons.push(person({ campaignId, audienceId: aud, replied: i < 3, servedAt: i === 1 ? YOUNG : OLD }));
    persons.push(person({ campaignId, audienceId: aud, servedAt: YOUNG }));
    // Fractional cents on purpose: rounded per row they would drift the sum by cents.
    split.set(pairKey(aud, campaignId), { flash: `${1234 + i}.3333333333`, mature: `${1000 + i}.6666666666` });
  });
  persons.push(person({ campaignId: "live", audienceId: null, replied: true }));
  split.set(pairKey(null, "live"), { flash: "777.0000000001", mature: "700.0000000001" });

  it("the rows' spend and outcomes, plus the untagged remainder, are the scope's own — exactly", () => {
    const scope = buildGroupMaturity({
      campaigns: CAMPAIGNS,
      persons,
      spend: splitByCampaignFor(split, () => true),
      serveDatesStated: true,
      now: NOW,
    });
    const groups = [...audiences, null].map((aud) =>
      buildGroupMaturity({
        campaigns: CAMPAIGNS,
        persons: persons.filter((p) => (p.audienceId ?? null) === aud),
        spend: splitByCampaignFor(split, (d) => d === aud),
        serveDatesStated: true,
        now: NOW,
      }),
    );
    for (const basis of ["flash", "mature"] as const) {
      const rowSpend = groups.reduce((s, g) => s + g.maturity.legs[0]![basis]!.spentUsd, 0);
      const rowOutcomes = groups.reduce((s, g) => s + g.maturity.legs[0]![basis]!.outcomes, 0);
      expect(rowSpend).toBeCloseTo(scope.maturity.legs[0]![basis]!.spentUsd, 9);
      expect(rowOutcomes).toBe(scope.maturity.legs[0]![basis]!.outcomes);
      // And so the cost per positive reply computed from the rows' sums is the scope's own.
      expect(rowSpend / rowOutcomes).toBeCloseTo(scope.maturity.legs[0]![basis]!.costPerOutcomeUsd!, 9);
    }
    expect(scope.maturity.legs[0]!.flash!.outcomes).toBe(4);
    expect(scope.maturity.legs[0]!.mature!.outcomes).toBe(3);
  });
});

describe("the block pairs", () => {
  const persons = [
    person({ campaignId: "live", replied: true, clicked: true }),
    person({ campaignId: "live", replied: true, servedAt: YOUNG }),
    person({ campaignId: "live", clicked: true, servedAt: YOUNG }),
  ];

  it("cost ratios: flash on everything, mature on the cohort; a young scope's mature ratios are null, never 0", () => {
    const pair = costRatiosPair({ flashSpendUsd: 300, matureSpendUsd: 100, isMature: true }, { flash: 900, mature: 500 }, 1000);
    expect(pair.flash).toEqual({ roiMultiple: 3, costOfAcquisitionPct: (300 / 900) * 100, costPerAcquisitionUsd: 300 / 0.9 });
    expect(pair.mature).toEqual({ roiMultiple: 5, costOfAcquisitionPct: 20, costPerAcquisitionUsd: 200 });
    const young = costRatiosPair({ flashSpendUsd: 300, matureSpendUsd: 0, isMature: false }, { flash: 900, mature: 0 }, 1000);
    expect(young.mature).toEqual({ roiMultiple: null, costOfAcquisitionPct: null, costPerAcquisitionUsd: null });
    expect(young.isMature).toBe(false);
    const unreadable = costRatiosPair({ flashSpendUsd: 300, matureSpendUsd: null, isMature: null }, { flash: 900, mature: null }, 1000);
    expect(unreadable.mature).toBeNull();
  });

  it("outcome ratios are OBSERVED: spend over distinct visitors / repliers, null at 0", () => {
    const mature = matureRows(persons, CAMPAIGNS, NOW);
    expect(mature).toHaveLength(1);
    const pair = outcomeRatiosPair({ flashSpendUsd: 30, matureSpendUsd: 10, persons, maturePersons: mature, isMature: true });
    expect(pair.flash).toEqual({ cpcCents: 1500, cpprCents: 1500 });
    expect(pair.mature).toEqual({ cpcCents: 1000, cpprCents: 1000 });
  });

  it("an audience's conversion column exists only when its matched-lead set was read", () => {
    const withForm = [...persons, person({ campaignId: "live", email: "form@x.com" })];
    const pair = audienceMetricPair(
      { flashSpendUsd: 40, matureSpendUsd: 20, persons: withForm, maturePersons: matureRows(withForm, CAMPAIGNS, NOW), isMature: true },
      { formSubmission: new Set(["form@x.com"]), signup: null, sale: null },
    );
    expect(pair.flash!.cpfsCents).toBe(4000);
    expect(pair.mature!.cpfsCents).toBe(2000);
    expect(pair.flash!.cpsCents).toBeNull();
    expect(pair.flash!.cpsaleCents).toBeNull();
  });
});

describe("keys and exact sums", () => {
  it("a pair key round-trips, the untagged dimension included", () => {
    expect(parsePairKey(pairKey("aud-1", "c1"))).toEqual({ dimension: "aud-1", campaignId: "c1" });
    expect(parsePairKey(pairKey(null, "c1"))).toEqual({ dimension: null, campaignId: "c1" });
    expect(parsePairKey(pairKey("dawn-v1", null))).toEqual({ dimension: "dawn-v1", campaignId: null });
    expect(campaignKey(null)).toBe("");
  });

  it("sums a scope's spend on the producer's text, never rounding a campaign to the cent", () => {
    const split = new Map<string, SpendSplit>([
      ["a", { flash: "0.4999999999", mature: "0.2000000000" }],
      ["b", { flash: "0.4999999999", mature: "0.2000000000" }],
      ["c", { flash: "0.0000000003", mature: "0" }],
    ]);
    // Rounded per campaign this would read 0 cents; summed exactly it is 1.0000000001 cents.
    expect(scopeSpendUsd(split).flash).toBeCloseTo(0.010000000001, 12);
    expect(scopeSpendUsd(split).mature).toBeCloseTo(0.004, 12);
  });
});

/**
 * THE ACCEPTANCE CRITERION ON ONE FIXTURE: campaign `3922c8e1…`'s cost per positive reply reads the same
 * on every surface that states it — `/revenue` and `/stats` (the scope builder), the audience rows summed
 * with the untagged remainder (`/audience-stats`), and the offer's outcome row (`/offers/:id/outcomes`) —
 * on BOTH bases, with one verdict. Each surface is driven through the function its route calls, from the
 * byte-same persons and the byte-same exact spend split, so a surface that drifted onto its own rule
 * (rounding per group, counting on another clock, dividing another spend) fails here.
 */
describe("one scope, four surfaces — the same flash, mature and verdict", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const audiences = ["aud-a", "aud-b", "aud-c"];
  const persons: EnginePerson[] = [];
  const split = new Map<string, SpendSplit>();
  audiences.forEach((aud, i) => {
    const campaignId = i === 0 ? "live" : "ancestor";
    persons.push(person({ campaignId, audienceId: aud, replied: true }));
    persons.push(person({ campaignId, audienceId: aud, replied: i === 2, servedAt: YOUNG }));
    persons.push(person({ campaignId, audienceId: aud }));
    split.set(pairKey(aud, campaignId), { flash: `${30000 + i}.1234567891`, mature: `${21000 + i}.9876543219` });
  });
  persons.push(person({ campaignId: "live", audienceId: null, replied: true, servedAt: YOUNG }));
  split.set(pairKey(null, "live"), { flash: "4321.0000000007", mature: "0" });
  const byCampaign = splitByCampaignFor(split, () => true);

  const scopeOf = () =>
    buildGroupMaturity({ campaigns: CAMPAIGNS, persons, spend: byCampaign, serveDatesStated: true, now: NOW });

  it("the scope builder (/revenue, /stats): 3 mature repliers of 5, the verdict on the mature ones", () => {
    const scope = scopeOf();
    const leg = scope.maturity.legs[0]!;
    expect(leg.flash!.outcomes).toBe(5);
    expect(leg.mature!.outcomes).toBe(3);
    expect(scope.maturity.isMature).toBe(true);
    // /revenue's `outcomes.maturity` divides the SAME spend by the SAME repliers (one leg in scope).
    const ratios = outcomeRatiosPair(scope.bases);
    expect(ratios.flash!.cpprCents! / 100).toBeCloseTo(leg.flash!.costPerOutcomeUsd!, 9);
    expect(ratios.mature!.cpprCents! / 100).toBeCloseTo(leg.mature!.costPerOutcomeUsd!, 9);
    expect(ratios.isMature).toBe(scope.maturity.isMature);
  });

  it("the audience rows (/audience-stats) plus the untagged remainder give the scope's cost per reply", () => {
    const leg = scopeOf().maturity.legs[0]!;
    const groups = [...audiences, null].map((aud) =>
      buildGroupMaturity({
        campaigns: CAMPAIGNS,
        persons: persons.filter((p) => (p.audienceId ?? null) === aud),
        spend: splitByCampaignFor(split, (d) => d === aud),
        serveDatesStated: true,
        now: NOW,
      }),
    );
    for (const basis of ["flash", "mature"] as const) {
      const spent = groups.reduce((s, g) => s + (g.maturity.legs[0]?.[basis]?.spentUsd ?? 0), 0);
      const outcomes = groups.reduce((s, g) => s + (g.maturity.legs[0]?.[basis]?.outcomes ?? 0), 0);
      expect(spent / outcomes).toBeCloseTo(leg[basis]!.costPerOutcomeUsd!, 9);
    }
  });

  it("the offer's outcome row (/offers/:id/outcomes) states the same pair and the same verdict", () => {
    const scope = scopeOf().maturity;
    const leg = scope.legs[0]!;
    const group: OfferLegGroup = {
      legKey: REPLY_LEG,
      fromStep: null,
      toStep: "conversation",
      featureSlug: "sales-cold-email-outreach",
      campaignIds: ["live", "ancestor"],
      legSource: "stated",
    };
    const [row] = assembleOfferOutcomes({
      groups: [group],
      persons,
      evidence: ALL_STEP_EVIDENCE,
      spendByGroup: new Map([[group, offerGroupSpend(group, byCampaign)]]),
      values: new Map([["conversation", { valuePerOutcomeUsd: 100, basisFunnelKey: "sales_meetings_from_conversation" }]]),
      channelName: () => "Cold email",
      actedLeadIdsByCampaign: null,
      serveDatesStated: true,
    });
    expect(row!.step.key).toBe("conversation");
    expect(row!.maturity.flash!.costPerOutcomeUsd).toBeCloseTo(leg.flash!.costPerOutcomeUsd!, 9);
    expect(row!.maturity.mature!.costPerOutcomeUsd).toBeCloseTo(leg.mature!.costPerOutcomeUsd!, 9);
    expect(row!.maturity.isMature).toBe(scope.isMature);
    // The legacy flash figure divides the same exact spend (never rounded per group).
    expect(row!.costPerOutcomeUsd).toBeCloseTo(leg.flash!.costPerOutcomeUsd!, 9);
  });

  it("a scope whose every reply is young: flash present, mature has none, NOT mature — on every surface", () => {
    const young = persons.map((p) => ({ ...p, servedAt: p.signals.positiveReply ? YOUNG : p.servedAt }));
    const scope = buildGroupMaturity({ campaigns: CAMPAIGNS, persons: young, spend: byCampaign, serveDatesStated: true, now: NOW });
    const leg = scope.maturity.legs[0]!;
    expect(leg.flash!.costPerOutcomeUsd).not.toBeNull();
    expect(leg.mature!.outcomes).toBe(0);
    expect(leg.mature!.costPerOutcomeUsd).toBeNull();
    expect(scope.maturity.isMature).toBe(false);
    const group: OfferLegGroup = {
      legKey: REPLY_LEG,
      fromStep: null,
      toStep: "conversation",
      featureSlug: "sales-cold-email-outreach",
      campaignIds: ["live", "ancestor"],
      legSource: "stated",
    };
    const [row] = assembleOfferOutcomes({
      groups: [group],
      persons: young,
      evidence: ALL_STEP_EVIDENCE,
      spendByGroup: new Map([[group, offerGroupSpend(group, byCampaign)]]),
      values: new Map(),
      channelName: () => "Cold email",
      actedLeadIdsByCampaign: null,
      serveDatesStated: true,
    });
    expect(row!.maturity.isMature).toBe(false);
    expect(row!.maturity.mature!.costPerOutcomeUsd).toBeNull();
    expect(row!.maturity.flash!.costPerOutcomeUsd).toBeCloseTo(leg.flash!.costPerOutcomeUsd!, 9);
  });
});
