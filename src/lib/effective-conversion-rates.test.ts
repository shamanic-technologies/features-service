import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildBrandEffectiveRates,
  measuredArrowRate,
  MIN_MEASURED_FROM_REACHED,
  resolveArrow,
  crmMeasurementOf,
  crmArrowRate,
  legPairKey,
  zeroIsConclusive,
  type BrandStepMeasurement,
} from "./effective-conversion-rates.js";
import { ALL_STEP_EVIDENCE, type LeadStepField } from "./funnel-steps.js";
import { declaredEconomicsForFunnel } from "./declared-funnels.js";
import { buildPricingFunnels } from "./reading-funnels.js";
import { funnelLegCatalogue } from "./channel-catalogue.js";

const NONE: Record<LeadStepField, boolean> = {
  clicked: false,
  repliedPositive: false,
  meetingBooked: false,
  meetingAttended: false,
  signup: false,
  formSubmission: false,
  purchased: false,
};
const lead = (reached: Partial<Record<LeadStepField, boolean>>) => ({ ...NONE, ...reached });
const times = <T,>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

/** 20 positive replies, 8 of which booked a meeting; 3 MORE meetings booked off the website (no reply). */
const MEASUREMENT: BrandStepMeasurement = {
  contactedRecipients: 400,
  evidence: ALL_STEP_EVIDENCE,
  reached: [
    ...times(8, lead({ repliedPositive: true, meetingBooked: true })),
    ...times(12, lead({ repliedPositive: true })),
    ...times(3, lead({ clicked: true, meetingBooked: true })),
    ...times(5, lead({ meetingBooked: true, meetingAttended: true })),
  ],
};

describe("measuredArrowRate — the funnel-step conversion, the bar on the denominator", () => {
  it("of the leads at FROM, those who reached TO: the numerator is a subset of the denominator (owner 2026-10-08)", () => {
    const m = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
    // 8 meetings over 20 replies: only the 8 who replied AND booked. The 3 booked off the website and the
    // 5 booked with no reply recorded are at TO without having been at FROM: served beside, never counted.
    expect(m).toEqual({
      basis: "our_leads",
      outcomesCounted: "all",
      fromReached: 20,
      toReached: 8,
      toReachedThroughOtherLegs: 8,
      ratePct: 40,
      sufficient: true,
      gap: null,
    });
  });

  it("a TO step several legs share does not borrow a sibling leg's outcomes (prod brand 75d7e3e8, 2026-10-02)", () => {
    // Outcomes our outreach caused, per-lead patterns read in prod: 106 clicked, 29 replied positive, 6
    // booked — every one of them off a reply, and nobody who clicked booked anything.
    const prod: BrandStepMeasurement = {
      contactedRecipients: 18_823,
      evidence: ALL_STEP_EVIDENCE,
      reached: [
        ...times(106, lead({ clicked: true })),
        ...times(22, lead({ repliedPositive: true })),
        ...times(3, lead({ repliedPositive: true, meetingBooked: true, meetingAttended: true })),
        ...times(3, lead({ repliedPositive: true, meetingBooked: true })),
        lead({ repliedPositive: true, meetingAttended: true, purchased: true }),
      ],
    };
    // Was 6 of 106 = 5.7%, and a $361-per-paying-client path stood on it. A measured 0, served as such.
    expect(measuredArrowRate(prod, "clicked", "meetingBooked")).toMatchObject({
      fromReached: 106,
      toReached: 0,
      toReachedThroughOtherLegs: 6,
      ratePct: 0,
      sufficient: true,
      gap: null,
    });
    // The reply leg keeps every one of its meetings.
    expect(measuredArrowRate(prod, "repliedPositive", "meetingBooked")).toMatchObject({
      fromReached: 29,
      toReached: 6,
      toReachedThroughOtherLegs: 0,
      sufficient: true,
    });
  });

  it("supersedes #1053: a meeting recorded without the reply flag is not counted on the reply leg", () => {
    // 23 positive replies, 14 booked meetings of which only 5 carry the reply flag; nobody clicked.
    const m1053: BrandStepMeasurement = {
      contactedRecipients: 500,
      evidence: ALL_STEP_EVIDENCE,
      reached: [
        ...times(5, lead({ repliedPositive: true, meetingBooked: true })),
        ...times(18, lead({ repliedPositive: true })),
        ...times(9, lead({ meetingBooked: true })),
      ],
    };
    const m = measuredArrowRate(m1053, "repliedPositive", "meetingBooked");
    expect(m).toMatchObject({ fromReached: 23, toReached: 5, toReachedThroughOtherLegs: 9, sufficient: true });
    expect(m.ratePct).toBeCloseTo(21.74, 2);
  });

  it("Doc Dinners, booked → attended: 3 of 8, not 4 of 8 (the paying client who attended without a booked step is not in the 8)", () => {
    // Prod patterns of the outcomes our outreach caused (brand 75d7e3e8, 2026-10-08).
    const docDinners: BrandStepMeasurement = {
      contactedRecipients: 17_000,
      evidence: ALL_STEP_EVIDENCE,
      reached: [
        ...times(5, lead({ repliedPositive: true, meetingBooked: true })),
        ...times(3, lead({ repliedPositive: true, meetingBooked: true, meetingAttended: true })),
        lead({ repliedPositive: true, meetingAttended: true, purchased: true }),
      ],
    };
    const m = measuredArrowRate(docDinners, "meetingBooked", "meetingAttended");
    expect(m).toMatchObject({ fromReached: 8, toReached: 3, toReachedThroughOtherLegs: 1, ratePct: 37.5 });
  });

  it("on our leads TO never exceeds FROM: leads at TO without FROM are served beside, the rate stays a probability", () => {
    const skewed: BrandStepMeasurement = {
      ...MEASUREMENT,
      reached: [...times(10, lead({ repliedPositive: true })), ...times(12, lead({ meetingBooked: true }))],
    };
    expect(measuredArrowRate(skewed, "repliedPositive", "meetingBooked")).toMatchObject({
      fromReached: 10,
      toReached: 0,
      toReachedThroughOtherLegs: 12,
      ratePct: 0,
      sufficient: true,
      gap: null,
    });
  });

  it("an arrow truly at 0% becomes measured once the FROM step clears the bar", () => {
    const zero: BrandStepMeasurement = { ...MEASUREMENT, reached: times(MIN_MEASURED_FROM_REACHED, lead({ repliedPositive: true })) };
    const m = measuredArrowRate(zero, "repliedPositive", "meetingBooked");
    expect(m.ratePct).toBe(0);
    expect(m.sufficient).toBe(true);
  });

  it("below the bar the rate is still reported, and is not sufficient", () => {
    const m = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");
    // 3 website visits, all 3 booked; the 13 other meetings never visited.
    expect(m).toMatchObject({ fromReached: 3, toReached: 3, toReachedThroughOtherLegs: 13, ratePct: 100, sufficient: false, gap: "below_learning_bar" });
  });

  it("a step nothing counts, and an unreadable producer, are told apart and never read as 0", () => {
    expect(measuredArrowRate(MEASUREMENT, null, "purchased").gap).toBe("step_not_counted");
    const blind = { ...MEASUREMENT, evidence: { ...ALL_STEP_EVIDENCE, observedSteps: false } };
    expect(measuredArrowRate(blind, "meetingBooked", "meetingAttended")).toMatchObject({
      fromReached: null,
      ratePct: null,
      gap: "evidence_unreadable",
    });
  });
});

describe("resolveArrow — measured, else manual, else the industry default, NEVER a fleet median (owner 2026-10-14)", () => {
  const measured = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
  const thin = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");

  it("a sufficient measurement wins over a stated rate", () => {
    expect(resolveArrow("Positive reply", "Meeting booked", measured, 70)).toMatchObject({
      effectiveRatePct: 40,
      source: "measured",
      manualRatePct: 70,
    });
  });
  it("under the bar, the brand's own statement wins over the default", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, 5, 0.2)).toMatchObject({ effectiveRatePct: 5, source: "manual" });
  });
  it("nothing stated and nothing measured: the industry default, served as `default`", () => {
    expect(resolveArrow("Meeting booked", "Meeting attended", thin, null, 75)).toMatchObject({ effectiveRatePct: 75, source: "default", defaultRatePct: 75 });
  });
  it("the median block is retired: always null over 0 brands, and no candidate is ever a median", () => {
    const leg = resolveArrow("Website visit", "Signup", thin, null, 0.2);
    expect(leg.median).toEqual({ ratePct: null, brandCount: 0 });
    expect(leg.candidates.map((c) => c.basis)).not.toContain("median");
    expect(leg.candidates.every((c) => c.brandCount === null)).toBe(true);
  });
  it("on a website-visit leg the brand's own statement still wins over the default", () => {
    expect(resolveArrow("Website visit", "Signup", thin, 7, 0.2)).toMatchObject({ effectiveRatePct: 7, source: "manual" });
  });
  it("nothing at all: null with a reason", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, null)).toMatchObject({
      effectiveRatePct: null,
      source: null,
      unresolvedReason: "no_rate_available",
    });
  });
});

describe("no leg resolves from what OTHER brands stated (owner 2026-10-14, Definitejobs read 5% on Website visit -> Signup)", () => {
  const EMPTY: BrandStepMeasurement = { contactedRecipients: 0, evidence: ALL_STEP_EVIDENCE, reached: [] };
  const legOf = (l: { fromStep: string; toStep: string }) => legPairKey(l.fromStep, l.toStep);

  it("a brand that stated nothing and measured nothing reads 0.2% on every leg leaving Website visit, source default", () => {
    const rates = buildBrandEffectiveRates({ brandId: "new", funnelKeys: [], measurement: EMPTY, manual: [] });
    for (const to of ["meeting_booked", "signup", "form_submitted", "purchase"]) {
      const leg = rates.legs.find((l) => legOf(l) === `website_visit>${to}`);
      expect(leg, to).toBeDefined();
      expect(leg!.effectiveRatePct, to).toBe(0.2);
      expect(leg!.source, to).toBe("default");
    }
    for (const leg of rates.legs) {
      expect(leg.source).not.toBe("median");
      expect(leg.median).toEqual({ ratePct: null, brandCount: 0 });
    }
  });
  it("a brand that STATED a visit rate keeps it", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "stated",
      funnelKeys: [],
      measurement: EMPTY,
      manual: [{ fromStep: "Website visit", toStep: "Signup", ratePct: 3, stated: true }],
    });
    const signup = rates.legs.find((l) => legOf(l) === "website_visit>signup")!;
    expect(signup).toMatchObject({ effectiveRatePct: 3, source: "manual" });
  });
});

describe("a measured 0% must have seen enough attempts to rule out the next source (owner 2026-10-12)", () => {
  /** Doc Dinners: 119 visits, 0 bookings; 30 positive replies, 8 bookings. */
  const DOC_DINNERS: BrandStepMeasurement = {
    contactedRecipients: 2000,
    evidence: ALL_STEP_EVIDENCE,
    reached: [
      ...times(119, lead({ clicked: true })),
      ...times(8, lead({ repliedPositive: true, meetingBooked: true })),
      ...times(22, lead({ repliedPositive: true })),
    ],
  };

  it("the rule: (1 - p)^n <= 5%, about 3 / p attempts", () => {
    expect(zeroIsConclusive(119, 0.5)).toBe(false); // 0.995^119 = 55%: 0 of 119 is what a 0.5% leg looks like
    expect(zeroIsConclusive(597, 0.5)).toBe(false);
    expect(zeroIsConclusive(598, 0.5)).toBe(true);
    expect(zeroIsConclusive(148, 2)).toBe(false);
    expect(zeroIsConclusive(149, 2)).toBe(true);
    // Nothing to fall back to, or a stated 0: the measured 0 stands.
    expect(zeroIsConclusive(10, null)).toBe(true);
    expect(zeroIsConclusive(10, 0)).toBe(true);
  });

  it("0 of 119 visits does not price as 0%: the default wins, the measurement is shown with its reason", () => {
    const measured = measuredArrowRate(DOC_DINNERS, "clicked", "meetingBooked");
    expect(measured).toMatchObject({ fromReached: 119, toReached: 0, ratePct: 0, sufficient: true });
    const leg = resolveArrow("Website visit", "Meeting booked", measured, null, 0.5);
    expect(leg).toMatchObject({
      effectiveRatePct: 0.5,
      source: "default",
      measured: { fromReached: 119, toReached: 0, ratePct: 0, sufficient: false, gap: "zero_not_conclusive" },
    });
    expect(leg.candidates).toEqual([
      expect.objectContaining({ basis: "our_leads", ratePct: 0, fromReached: 119, toReached: 0, kept: false, notKeptReason: "zero_not_conclusive" }),
      expect.objectContaining({ basis: "default", ratePct: 0.5, kept: true, notKeptReason: null }),
    ]);
  });

  it("the comparison is against the NEXT source: the client's own statement, else the default", () => {
    const measured = measuredArrowRate(DOC_DINNERS, "clicked", "meetingBooked");
    // Stated 5%: 0 of 119 IS conclusive against 5% (0.95^119 = 0.2%), so the measured 0% stands.
    expect(resolveArrow("Website visit", "Meeting booked", measured, 5, 0.5)).toMatchObject({ effectiveRatePct: 0, source: "measured" });
    // Stated 1%: 0.99^119 = 30%, not conclusive, the statement wins.
    expect(resolveArrow("Website visit", "Meeting booked", measured, 1, 0.5)).toMatchObject({ effectiveRatePct: 1, source: "manual" });
    // Nothing stated: the default is the next source (never a fleet median, owner 2026-10-14).
    expect(resolveArrow("Website visit", "Meeting booked", measured, null, 0.2)).toMatchObject({ effectiveRatePct: 0.2, source: "default" });
  });

  it("a leg with real successes keeps its measured rate exactly (8 of 30 = 26.67%)", () => {
    const measured = measuredArrowRate(DOC_DINNERS, "repliedPositive", "meetingBooked");
    const leg = resolveArrow("Positive reply", "Meeting booked", measured, null, 10);
    expect(leg).toMatchObject({ source: "measured", measured: { fromReached: 30, toReached: 8, sufficient: true, gap: null } });
    expect(leg.effectiveRatePct).toBeCloseTo(26.6667, 3);
  });

  it("every reader of the brand's legs sees the same rule (buildBrandEffectiveRates)", () => {
    const rates = buildBrandEffectiveRates({ brandId: "b", measurement: DOC_DINNERS, manual: [], funnelKeys: [] } as never);
    const visit = rates.legs.find((l) => l.fromStep === "Website visit" && l.toStep === "Meeting booked")!;
    expect(visit.source).not.toBe("measured");
    expect(visit.effectiveRatePct).toBeGreaterThan(0);
    expect(visit.measured.gap).toBe("zero_not_conclusive");
  });
});

describe("pricing rests on the EFFECTIVE rate", () => {
  const effective = buildBrandEffectiveRates({
    brandId: "b1",
    funnelKeys: ["sales_meetings_from_conversation"],
    measurement: MEASUREMENT,
    manual: [{ fromStep: "Meeting attended", toStep: "Paid client", ratePct: 25, stated: true }],
  });

  it("each arrow resolves from its own best source", () => {
    const [funnel] = effective.funnels;
    expect(funnel.arrows.map((a) => [a.source, a.effectiveRatePct])).toEqual([
      ["measured", 40], // 8 of the 20 replies booked
      ["measured", 5 / 16 * 100], // 5 attended over 16 booked — 16 ≥ 10
      ["manual", 25], // 5 attended < the bar → the brand's own statement
    ]);
  });

  it("a funnel is priced on the effective LEG rates, and carries the offer's lifetime revenue", () => {
    const [onEffective] = buildPricingFunnels({
      funnelKeys: ["sales_meetings_from_conversation"],
      lifetimeRevenueUsd: 5000,
      rateOf: (from, to) => {
        const leg = effective.legs.find((l) => l.fromStep === from && l.toStep === to);
        return { ratePct: leg?.effectiveRatePct ?? null, provenance: leg?.source ? `stated_${leg.source}` : "unstated" };
      },
    });
    const econ = declaredEconomicsForFunnel([onEffective], "sales_meetings_from_conversation")!;
    expect(econ.replyToMeetingPct).toBeCloseTo(40, 9);
    expect(econ.meetingAttendedToPaidClientPct).toBeCloseTo(25, 9);
    // booked → paid = show-up (measured 31.25%) × attended → paid (25%).
    expect(econ.meetingToClosePct).toBeCloseTo(31.25 * 0.25, 9);
    expect(econ.lifetimeRevenueUsd).toBe(5000);
  });

  it("a leg shared by several funnels carries ONE rate in all of them", () => {
    const both = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: ["sales_meetings_from_conversation", "sales_meetings_from_website"],
      measurement: MEASUREMENT,
      manual: [{ fromStep: "Meeting attended", toStep: "Paid client", ratePct: 25, stated: true }],
     
    });
    const close = both.funnels.map((f) => f.arrows.find((a) => a.toStep === "Paid client")!.effectiveRatePct);
    expect(close).toEqual([25, 25]);
  });
});

describe("each arrow is named in brand-service's own step wording", () => {
  it("the form rung reads brand-service's 'Form filled', and still joins to its statement", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: ["form_magnet"],
      measurement: MEASUREMENT,
      manual: [
        { fromStep: "Website visit", toStep: "Form filled", ratePct: 16.5, stated: true },
        { fromStep: "Form filled", toStep: "Paid client", ratePct: null, stated: false },
      ],
     
    });
    expect(rates.funnels[0].arrows.map((a) => [a.fromStep, a.toStep, a.manualRatePct])).toEqual([
      ["Website visit", "Form filled", 16.5],
      ["Form filled", "Paid client", null],
    ]);
  });
});

describe("every leg between two steps of the PUBLIC catalogue joins the served legs by the catalogue's own identity", () => {
  // The public catalogue (/public/channels `legs`) is what every dashboard surface names legs with.
  // Every REACTIVE leg (one out of a step a lead reached by engaging). The outbound legs out of Lead found
  // are proactive entry legs (wave 2): they carry no conversion rate, like the funnel entry legs they feed.
  const catalogue = funnelLegCatalogue().filter((l) => l.reactive);
  const EMPTY: BrandStepMeasurement = { contactedRecipients: 0, evidence: ALL_STEP_EVIDENCE, reached: [] };

  it("a brand with no statement and no measurement still gets a non-null rate on every catalogue leg, joinable by legKey AND by catalogue labels", () => {
    const rates = buildBrandEffectiveRates({ brandId: "b0", funnelKeys: [], measurement: EMPTY, manual: [] });
    expect(catalogue.length).toBeGreaterThan(0);
    for (const leg of catalogue) {
      const byKey = rates.legs.filter((l) => l.legKey === leg.legKey);
      expect(byKey, leg.legKey).toHaveLength(1);
      expect(byKey[0].effectiveRatePct, leg.legKey).not.toBeNull();
      expect(byKey[0].source, leg.legKey).not.toBeNull();
      const byLabels = rates.legs.filter((l) => l.catalogueFromStep === leg.fromStep!.label && l.catalogueToStep === leg.toStep.label);
      expect(byLabels, leg.legKey).toEqual(byKey);
    }
  });

  it("a rate stated under brand-service's OLD spelling ('Form filled', 'Purchase') still counts on the catalogue leg", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: [],
      measurement: EMPTY,
      manual: [
        { fromStep: "Website visit", toStep: "Form filled", ratePct: 16.5, stated: true },
        { fromStep: "Website visit", toStep: "Purchase", ratePct: 2.5, stated: true },
      ],
     
    });
    const form = rates.legs.find((l) => l.legKey === "website_visit_to_form_submitted")!;
    expect(form).toMatchObject({ fromStep: "Website visit", toStep: "Form filled", catalogueToStep: "Form submitted", effectiveRatePct: 16.5, source: "manual" });
    const purchase = rates.legs.find((l) => l.legKey === "website_visit_to_purchase")!;
    expect(purchase).toMatchObject({ toStep: "Purchase", catalogueToStep: "Direct purchase", effectiveRatePct: 2.5, source: "manual" });
    for (const k of ["form_submitted_to_paid_client", "purchase_to_paid_client"]) {
      expect(rates.legs.find((l) => l.legKey === k)?.effectiveRatePct, k).not.toBeNull();
    }
  });

  it("the legs stay unique: one entry per leg however many spellings resolve to it", () => {
    const rates = buildBrandEffectiveRates({ brandId: "b0", funnelKeys: [], measurement: EMPTY, manual: [] });
    const keys = rates.legs.map((l) => l.legKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * ONE fixture shaped like Doc Dinners (brand 75d7e3e8…, prod 2026-09-26): 26 positive replies; 45 booked
 * meetings on our leads, of which only 6 our outreach caused (the rest paired from the CRM, many from
 * before we ever wrote); 15 attended, 9 won. The CRM itself: 251 booked, 43 attended, 28 won.
 */
describe("a leg is measured WHERE ITS DATA LIVES — the client's CRM, or our leads counting only our outcomes", () => {
  const ours = (reached: Partial<Record<LeadStepField, boolean>>) => lead(reached);
  const DOC_DINNERS: BrandStepMeasurement = {
    contactedRecipients: 17000,
    evidence: ALL_STEP_EVIDENCE,
    reached: [
      ...times(6, lead({ repliedPositive: true, meetingBooked: true })),
      ...times(20, lead({ repliedPositive: true })),
      ...times(15, lead({ meetingBooked: true, meetingAttended: true })),
      ...times(24, lead({ meetingBooked: true })),
    ].map((r, i) => (i >= 26 && i < 35 ? { ...r, purchased: true } : r)),
    // Only the 6 reply-born meetings are ours; every CRM-paired outcome is not.
    ourReached: [
      ...times(6, ours({ repliedPositive: true, meetingBooked: true })),
      ...times(20, ours({ repliedPositive: true })),
      ...times(15, ours({})),
      ...times(24, ours({})),
    ],
  };
  const CRM = crmMeasurementOf({
    available: true,
    totalContacts: 2696,
    lastSyncedAt: "2026-09-26T09:45:51.909Z",
    steps: [
      { step: "form_submitted", contacts: 0, contactsAtOrBeyond: 0 },
      { step: "meeting_booked", contacts: 249, contactsAtOrBeyond: 251 },
      { step: "meeting_attended", contacts: 41, contactsAtOrBeyond: 43 },
      { step: "meeting_not_held", contacts: 37, contactsAtOrBeyond: 37 },
      { step: "sale", contacts: 28, contactsAtOrBeyond: 28 },
      { step: "deal_lost", contacts: 0, contactsAtOrBeyond: 0 },
    ],
  });
  const build = (crm: ReturnType<typeof crmMeasurementOf> | undefined) =>
    buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: ["sales_meetings_from_conversation"],
      measurement: { ...DOC_DINNERS, ...(crm ? { crm } : {}) },
      manual: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 61, stated: true }],
     
    });
  const arrows = (r: ReturnType<typeof build>) => r.funnels[0].arrows;

  it("CRM available: reply → meeting on OUR leads with only our meetings (6/26), the client-run legs on the whole CRM", () => {
    const [reply, show, close] = arrows(build(CRM));
    expect(reply).toMatchObject({ source: "measured", effectiveRatePct: (6 / 26) * 100 });
    expect(reply.measured).toMatchObject({ basis: "our_leads", outcomesCounted: "caused_by_our_outreach", fromReached: 26, toReached: 6 });
    expect(show).toMatchObject({ source: "measured", effectiveRatePct: (43 / 251) * 100 });
    expect(show.measured).toMatchObject({ basis: "crm", outcomesCounted: null, fromReached: 251, toReached: 43 });
    expect(close).toMatchObject({ source: "measured", effectiveRatePct: (28 / 43) * 100 });
    expect(close.measured).toMatchObject({ basis: "crm", fromReached: 43, toReached: 28 });
  });

  it("the SAME brand without a usable CRM measures on all its leads: 6 of the 26 replies booked, measured over the hand-stated 61%", () => {
    for (const status of ["no_connection", "not_synced", "stage_meanings_pending"] as const) {
      const r = build(crmMeasurementOf({ available: false, reason: status }));
      expect(r.crm).toEqual({ status, totalContacts: null, lastSyncedAt: null });
      const [reply, show, close] = arrows(r);
      expect(reply).toMatchObject({ source: "measured", effectiveRatePct: (6 / 26) * 100 });
      expect(reply.measured).toMatchObject({ basis: "our_leads", outcomesCounted: "all", fromReached: 26, toReached: 6, toReachedThroughOtherLegs: 39, gap: null });
      expect(show.measured).toMatchObject({ basis: "our_leads", outcomesCounted: "all", fromReached: 45, toReached: 15 });
      expect(close.measured).toMatchObject({ basis: "our_leads", fromReached: 15, toReached: 9 });
    }
  });

  it("an unreadable CRM is stated, and degrades to today's numbers rather than to zero", () => {
    const r = build(crmMeasurementOf(null));
    expect(r.crm?.status).toBe("unreadable");
    expect(arrows(r)[1].measured).toMatchObject({ basis: "our_leads", outcomesCounted: "all", fromReached: 45, toReached: 15 });
  });

  it("a brand measured without any CRM answer is byte-identical to the lead-only rates, apart from the basis fields", () => {
    const withNoConnection = build(crmMeasurementOf({ available: false, reason: "no_connection" }));
    const legacy = build(undefined);
    expect({ ...withNoConnection, crm: null }).toEqual(legacy);
  });

  it("a leg the CRM evidences only ONE end of stays on our leads (the CRM holds no form submission here)", () => {
    expect(crmArrowRate(CRM, "Form submitted", "Paid client")).toBeNull();
    expect(crmArrowRate(CRM, "Positive reply", "Meeting booked")).toBeNull();
    expect(crmArrowRate(CRM, "Meeting booked", "Meeting attended")).toMatchObject({ basis: "crm", fromReached: 251 });
  });

  it("an outreach-caused rate on a measurement that never split the causes fails loud", () => {
    expect(() => measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked", "caused_by_our_outreach")).toThrow(/ourReachedCounts/);
  });
});
