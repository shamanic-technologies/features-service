import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildBrandEffectiveRates,
  buildFleetArrowMedians,
  measuredArrowRate,
  MIN_MEASURED_FROM_REACHED,
  resolveArrow,
  MIN_FLEET_MEDIAN_BRANDS,
  fleetMedianApplies,
  crmMeasurementOf,
  crmArrowRate,
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
  it("counts the leads THROUGH the leg at TO — not the intersection, not a sibling leg's outcomes", () => {
    const m = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
    // 13 meetings over 20 replies: the 8 who replied and booked, plus the 5 booked with NO earlier rung
    // recorded (benefit of the doubt). The 3 booked off the website are the visit leg's, not this one's.
    // The intersection would have read 8 / 20 = 40%, under-stating every brand whose bookings are
    // recorded without a reply flag (prod: 21.7% against the rung's 60.9%).
    expect(m).toEqual({
      basis: "our_leads",
      outcomesCounted: "all",
      fromReached: 20,
      toReached: 13,
      toReachedThroughOtherLegs: 3,
      ratePct: 65,
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

  it("#1053 still holds: meetings recorded without the reply flag stay on the reply leg", () => {
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
    expect(m).toMatchObject({ fromReached: 23, toReached: 14, toReachedThroughOtherLegs: 0, sufficient: true });
    expect(m.ratePct).toBeCloseTo(60.87, 2);
  });

  it("a single-route TO step is the count ratio, byte for byte", () => {
    // Meeting attended has one leg into it: every attended lead counts, even one with no booking flag.
    const m = measuredArrowRate(
      { ...MEASUREMENT, reached: [...MEASUREMENT.reached, lead({ meetingAttended: true })] },
      "meetingBooked",
      "meetingAttended",
    );
    expect(m).toMatchObject({ fromReached: 16, toReached: 6, toReachedThroughOtherLegs: 0 });
  });

  it("more leads at TO than at FROM is no probability: unmeasurable, never clamped", () => {
    const skewed: BrandStepMeasurement = {
      ...MEASUREMENT,
      reached: [...times(10, lead({ repliedPositive: true })), ...times(12, lead({ meetingBooked: true }))],
    };
    expect(measuredArrowRate(skewed, "repliedPositive", "meetingBooked")).toMatchObject({ ratePct: 120, sufficient: false, gap: "to_exceeds_from" });
  });

  it("an arrow truly at 0% becomes measured once the FROM step clears the bar", () => {
    const zero: BrandStepMeasurement = { ...MEASUREMENT, reached: times(MIN_MEASURED_FROM_REACHED, lead({ repliedPositive: true })) };
    const m = measuredArrowRate(zero, "repliedPositive", "meetingBooked");
    expect(m.ratePct).toBe(0);
    expect(m.sufficient).toBe(true);
  });

  it("below the bar the rate is still reported, and is not sufficient", () => {
    const m = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");
    // 3 website visits; 8 meetings count for the leg (3 off the website + 5 with no earlier rung) — over
    // 100%, so not a probability.
    expect(m).toMatchObject({ fromReached: 3, toReached: 8, sufficient: false, gap: "to_exceeds_from" });
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

describe("resolveArrow — measured, else manual, else median, else null", () => {
  const measured = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
  const thin = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");
  const median = { ratePct: 22, brandCount: 7 };

  it("a sufficient measurement wins over a stated rate", () => {
    expect(resolveArrow("Positive reply", "Meeting booked", measured, 70, median)).toMatchObject({
      effectiveRatePct: 65,
      source: "measured",
      manualRatePct: 70,
      median,
    });
  });
  it("under the bar, the brand's own statement wins over the fleet", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, 5, median)).toMatchObject({ effectiveRatePct: 5, source: "manual" });
  });
  it("nothing stated, the median", () => {
    expect(resolveArrow("Meeting booked", "Meeting attended", thin, null, median)).toMatchObject({ effectiveRatePct: 22, source: "median" });
  });
  it("a fleet median over FEWER than 5 brands keeps the industry default (owner rule 2026-10-03)", () => {
    expect(MIN_FLEET_MEDIAN_BRANDS).toBe(5);
    const four = { ratePct: 40, brandCount: 4 };
    expect(resolveArrow("Meeting booked", "Meeting attended", thin, null, four, 75)).toMatchObject({
      effectiveRatePct: 75,
      source: "default",
      median: four,
      defaultRatePct: 75,
    });
  });
  it("a fleet median over 5 brands overrides the default", () => {
    const five = { ratePct: 40, brandCount: 5 };
    expect(resolveArrow("Meeting booked", "Meeting attended", thin, null, five, 75)).toMatchObject({ effectiveRatePct: 40, source: "median" });
  });
  it("a leg leaving Website visit takes the fleet median like any leg (owner 2026-10-04, supersedes the 2026-10-03 exclusion)", () => {
    const nine = { ratePct: 0.8, brandCount: 9 };
    expect(resolveArrow("Website visit", "Form submitted", thin, null, nine, 0.5)).toMatchObject({
      effectiveRatePct: 0.8,
      source: "median",
      median: nine,
      defaultRatePct: 0.5,
    });
    expect(fleetMedianApplies(nine)).toBe(true);
    // The 5-brand bar still holds on a visit leg: a 2-brand median stays an input, the default is served.
    expect(fleetMedianApplies({ ratePct: 4.99, brandCount: 2 })).toBe(false);
  });
  it("on a website-visit leg the brand's own statement still wins over the default", () => {
    expect(resolveArrow("Website visit", "Signup", thin, 7, { ratePct: 5, brandCount: 9 }, 0.5)).toMatchObject({ effectiveRatePct: 7, source: "manual" });
  });
  it("the brand's own statement still wins over a thin median and the default", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, 3, { ratePct: 4.99, brandCount: 2 }, 1)).toMatchObject({ effectiveRatePct: 3, source: "manual" });
  });
  it("nothing at all: null with a reason, never a default", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, null, { ratePct: null, brandCount: 0 })).toMatchObject({
      effectiveRatePct: null,
      source: null,
      unresolvedReason: "no_rate_available",
    });
  });
});

describe("buildFleetArrowMedians — the median of what brands STATED, per LEG", () => {
  const stated = (ratePct: number | null) => [
    { fromStep: "Positive reply", toStep: "Meeting booked", ratePct, stated: ratePct !== null },
  ];
  it("is the median, never the mean, over stated values only — keyed on the leg, no funnel in the key", () => {
    const medians = buildFleetArrowMedians([stated(10), stated(20), stated(90), stated(null)]);
    expect(medians.get("conversation>meeting_booked")).toEqual({ ratePct: 20, brandCount: 3 });
  });
  it("brand-service's 'Form filled' and our 'Form submitted' are ONE leg", () => {
    const medians = buildFleetArrowMedians([
      [{ fromStep: "Website visit", toStep: "Form filled", ratePct: 10, stated: true }],
      [{ fromStep: "Website visit", toStep: "Form submitted", ratePct: 30, stated: true }],
    ]);
    expect(medians.get("website_visit>form_submitted")).toEqual({ ratePct: 20, brandCount: 2 });
  });
});

describe("pricing rests on the EFFECTIVE rate", () => {
  const effective = buildBrandEffectiveRates({
    brandId: "b1",
    funnelKeys: ["sales_meetings_from_conversation"],
    measurement: MEASUREMENT,
    manual: [{ fromStep: "Meeting attended", toStep: "Paid client", ratePct: 25, stated: true }],
    medians: new Map([["meeting_booked>meeting_attended", { ratePct: 60, brandCount: 5 }]]),
  });

  it("each arrow resolves from its own best source", () => {
    const [funnel] = effective.funnels;
    expect(funnel.arrows.map((a) => [a.source, a.effectiveRatePct])).toEqual([
      ["measured", 65], // 13 meetings through the reply leg over 20 replies
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
    expect(econ.replyToMeetingPct).toBeCloseTo(65, 9);
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
      medians: new Map(),
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
      medians: new Map(),
    });
    expect(rates.funnels[0].arrows.map((a) => [a.fromStep, a.toStep, a.manualRatePct])).toEqual([
      ["Website visit", "Form filled", 16.5],
      ["Form filled", "Paid client", null],
    ]);
  });
});

describe("every leg between two steps of the PUBLIC catalogue joins the served legs by the catalogue's own identity", () => {
  // The public catalogue (/public/channels `legs`) is what every dashboard surface names legs with.
  const catalogue = funnelLegCatalogue().filter((l) => l.fromStep !== null);
  const EMPTY: BrandStepMeasurement = { contactedRecipients: 0, evidence: ALL_STEP_EVIDENCE, reached: [] };

  it("a brand with no statement and no measurement still gets a non-null rate on every catalogue leg, joinable by legKey AND by catalogue labels", () => {
    const rates = buildBrandEffectiveRates({ brandId: "b0", funnelKeys: [], measurement: EMPTY, manual: [], medians: new Map() });
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
      medians: new Map(),
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
    const rates = buildBrandEffectiveRates({ brandId: "b0", funnelKeys: [], measurement: EMPTY, manual: [], medians: new Map() });
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
      medians: new Map(),
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

  it("the SAME brand without a usable CRM reads today's numbers: 45 > 26 is no probability, so the hand-stated 61% wins", () => {
    for (const status of ["no_connection", "not_synced", "stage_meanings_pending"] as const) {
      const r = build(crmMeasurementOf({ available: false, reason: status }));
      expect(r.crm).toEqual({ status, totalContacts: null, lastSyncedAt: null });
      const [reply, show, close] = arrows(r);
      expect(reply).toMatchObject({ source: "manual", effectiveRatePct: 61 });
      expect(reply.measured).toMatchObject({ basis: "our_leads", outcomesCounted: "all", fromReached: 26, toReached: 45, gap: "to_exceeds_from" });
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
