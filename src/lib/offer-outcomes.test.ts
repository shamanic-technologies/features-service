import { describe, expect, it } from "vitest";
import {
  assembleOfferOutcomes,
  buildOfferLegPartition,
  stepValues,
  type GroupSpend,
  type OfferLegGroup,
} from "./offer-outcomes.js";
import type { AcquisitionChannel } from "./acquisition-channels.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import type { EnginePerson } from "./revenue-engine.js";
import type { SalesEconomics } from "./funnel-registry.js";
import { ALL_STEP_EVIDENCE } from "./funnel-steps.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

const OFFER = "offer-1";

const coldEmail: AcquisitionChannel = {
  family: "outbound_one_to_one",
  operatedBy: "platform",
  stepTransitions: [
    { from: null, to: "conversation" },
    { from: null, to: "website_visit" },
  ],
  terms: { dailyOperatingCostCents: 100, minimumCommitmentDays: 30, maxDaysToFirstProduction: 7 },
};
const feedback: AcquisitionChannel = { ...coldEmail, stepTransitions: [{ from: null, to: "conversation" }] };
const aiBooking: AcquisitionChannel = {
  ...coldEmail,
  family: "conversion",
  stepTransitions: [{ from: "conversation", to: "meeting_booked" }],
};
const yourTeam: AcquisitionChannel = {
  ...coldEmail,
  family: "conversion",
  operatedBy: "customer",
  terms: { ...coldEmail.terms, dailyOperatingCostCents: 0 },
  stepTransitions: [{ from: "conversation", to: "meeting_booked" }],
};
const CATALOGUE: Record<string, AcquisitionChannel> = {
  "sales-cold-email-outreach": coldEmail,
  "feedback-request-cold-email-outreach": feedback,
  "ai-meeting-booking": aiBooking,
  "your-team-meeting-booking": yourTeam,
};
const channelOf = (slug: string) => CATALOGUE[slug] ?? null;

const row = (id: string, featureSlug: string, legKey: string | null, funnelKey: string | null = null, offerId = OFFER): CampaignIdentityRow => ({
  id,
  featureSlug,
  legKey,
  funnelKey,
  offerId,
});

function person(leadId: string, campaignId: string, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    campaignId,
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
    signals: { contacted: true, ...signals },
    ...extra,
  } as EnginePerson;
}

describe("buildOfferLegPartition", () => {
  it("groups by leg × channel, derives the one leg a pre-leg ancestor's channel performs, hides customer-run legs", () => {
    const rows = [
      row("c1", "sales-cold-email-outreach", "start_to_conversation"),
      row("c2", "sales-cold-email-outreach", null, "sales_meetings_from_conversation"), // derived
      row("f1", "feedback-request-cold-email-outreach", "start_to_conversation"),
      row("a1", "ai-meeting-booking", "conversation_to_meeting_booked"),
      row("t1", "your-team-meeting-booking", "conversation_to_meeting_booked"),
      row("x1", "sales-cold-email-outreach", null, null), // no leg, no funnel
      row("o1", "sales-cold-email-outreach", "start_to_conversation", null, "other-offer"),
    ];
    const p = buildOfferLegPartition(rows, OFFER, channelOf);
    expect(p.groups.map((g) => [g.legKey, g.featureSlug, g.campaignIds, g.legSource])).toEqual([
      ["start_to_conversation", "feedback-request-cold-email-outreach", ["f1"], "stated"],
      ["start_to_conversation", "sales-cold-email-outreach", ["c1", "c2"], "derived_from_funnel"],
      ["conversation_to_meeting_booked", "ai-meeting-booking", ["a1"], "stated"],
    ]);
    expect(p.unattributedCampaignIds).toEqual(["x1"]);
    expect(p.hiddenCampaignIds).toEqual(["t1"]);
  });
});

describe("stepValues", () => {
  const econ: SalesEconomics = {
    lifetimeRevenueUsd: 1000,
    replyToMeetingPct: 50,
    visitToMeetingPct: 10,
    meetingToClosePct: 20,
    visitToSignupPct: 5,
    signupToPaidClientPct: 10,
    visitToClosePct: 1,
  };
  const declared = (funnelKey: DeclaredSalesFunnel["funnelKey"], lifetimeRevenueUsd: number | null): DeclaredSalesFunnel => ({
    funnelKey,
    name: funnelKey,
    steps: [],
    rates: {},
    lifetimeRevenueUsd,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-09-25T00:00:00Z",
  });

  it("prices a step on the BEST declared funnel containing it (max), each on its own lifetime revenue", () => {
    const values = stepValues(
      [declared("sales_meetings_from_conversation", 1000), declared("sales_from_conversation", 5000)],
      { ...econ, replyToPaidClientPct: 4 },
    );
    // conversation funnel: reply → 50% × 20% × $1,000 = $100; direct reply funnel: 4% × $5,000 = $200.
    expect(values.get("conversation")).toEqual({ valuePerOutcomeUsd: 200, basisFunnelKey: "sales_from_conversation" });
    expect(values.get("meeting_booked")?.valuePerOutcomeUsd).toBeCloseTo(200); // 20% × $1,000
    expect(values.has("website_visit")).toBe(false); // no declared funnel contains it
  });

  it("no economics ⇒ no value, never 0", () => {
    expect(stepValues([declared("sales_meetings_from_conversation", 1000)], null).size).toBe(0);
  });
});

describe("assembleOfferOutcomes", () => {
  const cold: OfferLegGroup = {
    legKey: "start_to_conversation",
    fromStep: null,
    toStep: "conversation",
    featureSlug: "sales-cold-email-outreach",
    campaignIds: ["c1"],
    legSource: "stated",
  };
  const fb: OfferLegGroup = { ...cold, featureSlug: "feedback-request-cold-email-outreach", campaignIds: ["f1"] };
  const ai: OfferLegGroup = {
    legKey: "conversation_to_meeting_booked",
    fromStep: "conversation",
    toStep: "meeting_booked",
    featureSlug: "ai-meeting-booking",
    campaignIds: ["a1"],
    legSource: "stated",
  };
  // L2 was reached by BOTH channels — one lead, counted once on the outcome row.
  const persons = [
    person("L1", "c1", { positiveReply: true, meeting: true }, { signalDates: { contacted: "2026-08-01T00:00:00Z" } }),
    person("L2", "c1", { positiveReply: true }, { signalDates: { contacted: "2026-09-24T00:00:00Z" } }),
    person("L2", "f1", { positiveReply: true }),
    person("L3", "f1", { positiveReply: true, meeting: true }, { unpricedSignals: ["positiveReply", "meeting"] }),
    person("L4", "c1", { clicked: true }),
  ];
  const whole = (committedCents: number, matureCommittedCents = committedCents, cutoffIso: string | null = null): GroupSpend => ({
    committedCents,
    matureCommittedCents,
    cutoffIso,
  });
  const values = new Map([
    ["conversation", { valuePerOutcomeUsd: 100, basisFunnelKey: "sales_meetings_from_conversation" as const }],
    ["meeting_booked", { valuePerOutcomeUsd: 200, basisFunnelKey: "sales_meetings_from_conversation" as const }],
  ] as const);
  const build = (spend: Map<OfferLegGroup, GroupSpend>) =>
    assembleOfferOutcomes({
      groups: [cold, fb, ai],
      persons,
      evidence: ALL_STEP_EVIDENCE,
      spendByGroup: spend,
      values,
      channelName: (s) => s,
    });

  it("counts DISTINCT leads on the outcome row — fewer than the sum of its legs", () => {
    const rows = build(new Map([[cold, whole(6000)], [fb, whole(3000)], [ai, whole(1000)]]));
    const reply = rows.find((r) => r.step.key === "conversation")!;
    expect(reply.legs.map((l) => l.recipientsReached)).toEqual([2, 2]); // L1,L2 | L2,L3
    expect(reply.recipientsReached).toBe(3); // L1, L2, L3 — not 4
    expect(reply.spentUsd).toBe(90);
    expect(reply.costPerOutcomeUsd).toBeCloseTo(30);
    // L3's reply is not ours (unpriced): counted, not valued.
    expect(reply.valueUsd).toBe(200);
    expect(reply.roiMultiple).toBeCloseTo(200 / 90);
  });

  it("an INTERNAL leg counts the offer's leads that crossed it, on its own spend", () => {
    const rows = build(new Map([[cold, whole(6000)], [fb, whole(3000)], [ai, whole(1000)]]));
    const meeting = rows.find((r) => r.step.key === "meeting_booked")!;
    expect(meeting.legs).toHaveLength(1);
    expect(meeting.legs[0].countBasis).toBe("leg_crossings");
    expect(meeting.recipientsReached).toBe(2); // L1, L3
    expect(meeting.spentUsd).toBe(10);
    expect(meeting.costPerOutcomeUsd).toBeCloseTo(5);
    expect(meeting.valueUsd).toBe(200); // L1 only is priced
  });

  it("the ROI rides the mature cohort; an all-young leg reads `maturing`, never 0", () => {
    const cutoff = "2026-09-11T00:00:00.000Z";
    const rows = build(new Map([[cold, whole(6000, 0, cutoff)], [fb, whole(3000, 0, cutoff)], [ai, whole(1000)]]));
    const reply = rows.find((r) => r.step.key === "conversation")!;
    expect(reply.roiMultiple).toBeNull();
    expect(reply.unmeasuredReason).toBe("maturing");
    expect(reply.spentUsd).toBe(90); // spend keeps the whole history

    const mixed = build(new Map([[cold, whole(6000, 4000, cutoff)], [fb, whole(3000)], [ai, whole(1000)]]));
    const r2 = mixed.find((r) => r.step.key === "conversation")!;
    // Mature priced: L1 (contacted before cutoff) via cold, L2 via feedback (zero-delay group) → 2 × $100 / $70.
    expect(r2.roiMultiple).toBeCloseTo(200 / 70);
  });

  it("unreadable evidence nulls the count; a step with no signal says so", () => {
    const purchase: OfferLegGroup = { ...cold, legKey: "website_visit_to_purchase", fromStep: "website_visit", toStep: "purchase" };
    const rows = assembleOfferOutcomes({
      groups: [ai, purchase],
      persons,
      evidence: { ...ALL_STEP_EVIDENCE, observedSteps: false, legacyQualifications: false },
      spendByGroup: new Map([[ai, whole(1000)], [purchase, whole(500)]]),
      values,
      channelName: (s) => s,
    });
    const meeting = rows.find((r) => r.step.key === "meeting_booked")!;
    expect(meeting.recipientsReached).toBeNull();
    expect(meeting.costPerOutcomeUsd).toBeNull();
    expect(meeting.unmeasuredReason).toBe("evidence_unreadable");
    expect(meeting.spentUsd).toBe(10); // the money is still real
    const bought = rows.find((r) => r.step.key === "purchase")!;
    expect(bought.recipientsReached).toBeNull();
    expect(bought.unmeasuredReason).toBe("step_not_counted");
  });
});
