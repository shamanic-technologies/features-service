import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPricingFunnels } from "./reading-funnels.js";
import { stepValues } from "./offer-outcomes.js";
import { buildOfferPipeline, explainStepValue, offerStepSets, previousStepsOf, stepConversion } from "./offer-pipeline-explained.js";
import { ALL_STEP_EVIDENCE } from "./funnel-steps.js";
import { DISPLAY_ONLY_SALES_FUNNELS, SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";
import { funnelStepKeys } from "./acquisition-channels.js";
import type { EnginePerson } from "./revenue-engine.js";
import type { ColdLeadsRead } from "./step-outcomes-client.js";

const ALL_FUNNELS = (Object.keys(SALES_FUNNELS) as SalesFunnelKey[]).filter((k) => !DISPLAY_ONLY_SALES_FUNNELS.has(k));

/** Funnels built exactly as the pricing door builds them, every arrow on a distinct effective rate. */
function pricingFunnels(keys: readonly SalesFunnelKey[], ltr: number | null = 2500) {
  const rates = [37, 12.5, 65, 8, 41, 3.3, 90, 22];
  let i = 0;
  const seen = new Map<string, number>();
  return buildPricingFunnels({
    funnelKeys: keys,
    lifetimeRevenueUsd: ltr,
    rateOf: (from, to) => {
      const key = `${from}>${to}`;
      if (!seen.has(key)) seen.set(key, rates[i++ % rates.length]);
      const measured = key.endsWith("Paid client")
        ? { basis: "crm" as const, outcomesCounted: null, fromReached: 20, toReached: 13, toReachedThroughOtherLegs: null, ratePct: 65, sufficient: true, gap: null }
        : null;
      return { ratePct: seen.get(key)!, provenance: measured ? "stated_measured" : "stated_default", measured };
    },
  });
}

function person(leadId: string, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    campaignId: "c1",
    firstName: leadId,
    lastName: null,
    photoUrl: null,
    orgId: `org-${leadId}`,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    email: `${leadId}@x.com`,
    signals: { contacted: true, ...signals },
    ...extra,
  } as EnginePerson;
}

describe("explainStepValue", () => {
  it.each(ALL_FUNNELS)("on %s: LTR × Π leg rates IS the served value of every priced step, to the cent", (key) => {
    const declared = pricingFunnels([key]);
    const values = stepValues(declared);
    expect(values.size).toBeGreaterThan(0);
    for (const [step, value] of values) {
      const explanation = explainStepValue(declared, step, value);
      expect(explanation, `${key} ${step}`).not.toBeNull();
      const product = explanation!.legs.reduce((p, leg) => p * (leg.ratePct / 100), 1);
      expect(Math.abs(explanation!.lifetimeRevenueUsd * product - value.valuePerOutcomeUsd)).toBeLessThan(0.005);
      expect(explanation!.probabilityPct).toBeCloseTo(product * 100, 9);
      expect(explanation!.basisFunnelKey).toBe(value.basisFunnelKey);
      // The legs run from the step to Paid client.
      const steps = funnelStepKeys(key);
      expect(explanation!.legs.length).toBe(steps.length - 1 - steps.indexOf(step));
    }
  });

  it("follows the best-path value across several funnels, and states sources and measured counts", () => {
    const declared = pricingFunnels(ALL_FUNNELS);
    const values = stepValues(declared);
    for (const [step, value] of values) {
      const explanation = explainStepValue(declared, step, value)!;
      expect(explanation).not.toBeNull();
      expect(explanation.lifetimeRevenueUsd * (explanation.probabilityPct / 100)).toBeCloseTo(value.valuePerOutcomeUsd, 6);
      for (const leg of explanation.legs) {
        if (leg.toStep.key === "paid_client") {
          expect(leg.source).toBe("measured");
          expect(leg.measured).toEqual({ basis: "crm", fromReached: 20, toReached: 13 });
        } else {
          expect(leg.source).toBe("default");
          expect(leg.measured).toBeNull();
        }
      }
    }
    const paid = explainStepValue(declared, "paid_client", values.get("paid_client"));
    expect(paid?.legs).toEqual([]);
    expect(paid?.probabilityPct).toBe(100);
  });

  it("withholds an explanation that does not multiply back to the value", () => {
    const declared = pricingFunnels(["sales_from_conversation"]);
    const value = stepValues(declared).get("conversation")!;
    expect(explainStepValue(declared, "conversation", { ...value, valuePerOutcomeUsd: value.valuePerOutcomeUsd + 1 })).toBeNull();
    expect(explainStepValue(declared, "conversation", undefined)).toBeNull();
  });
});

describe("stepConversion", () => {
  it("divides the step's distinct leads that stood on the previous step by the previous step's leads", () => {
    const persons = [
      person("a", { positiveReply: true, meeting: true }),
      person("b", { positiveReply: true }),
      person("c", { positiveReply: true }),
      person("d", { meeting: true }), // a meeting reached some other way: not from a reply
      person("e", {}),
    ];
    const sets = offerStepSets(persons, ALL_STEP_EVIDENCE);
    expect(previousStepsOf("meeting_booked", ["sales_meetings_from_conversation"])).toEqual(["conversation"]);
    expect(stepConversion("meeting_booked", sets.byStep.get("meeting_booked")!, sets, ["sales_meetings_from_conversation"])).toEqual({
      previousSteps: ["conversation"],
      previousReached: 3,
      reachedFromPrevious: 1,
      ratePct: (1 / 3) * 100,
    });
    // A path's first step is preceded by "contacted".
    expect(stepConversion("conversation", sets.byStep.get("conversation")!, sets, ["sales_meetings_from_conversation"])).toEqual({
      previousSteps: ["contacted"],
      previousReached: 5,
      reachedFromPrevious: 3,
      ratePct: 60,
    });
  });

  it("is null when a previous step is not counted", () => {
    const sets = offerStepSets([person("a", { meeting: true })], { ...ALL_STEP_EVIDENCE, observedSteps: false, legacyQualifications: false });
    expect(stepConversion("meeting_attended", new Set(["a"]), sets, ["sales_meetings_from_conversation"])).toBeNull();
  });
});

describe("buildOfferPipeline", () => {
  const declared = pricingFunnels(["sales_meetings_from_conversation"]);
  const values = stepValues(declared);
  const cold: ColdLeadsRead = {
    applies: true,
    afterDays: 30,
    leads: [
      { leadId: "cold1", campaignId: "c1", email: "cold1@x.com", step: "meeting_booked", since: "2026-09-01T00:00:00Z", after: "positive_reply", stalledSince: "2026-08-02T00:00:00Z" },
      { leadId: "elsewhere", campaignId: "c9", email: "z@x.com", step: "meeting_booked", since: "2026-09-01T00:00:00Z", after: "positive_reply", stalledSince: "2026-08-02T00:00:00Z" },
      // A CRM deal that stalled in 2024, before we ever emailed: not interest we caused.
      { leadId: "pre-us", campaignId: "c1", email: "pre-us@x.com", step: "meeting_attended", since: "2024-09-23T00:00:00Z", after: "meeting_booked", stalledSince: "2024-08-24T00:00:00Z" },
    ],
  };
  const persons = [
    // Cold at meeting_booked: the dead-step overlay already killed the meeting funnel for it.
    person("cold1", { positiveReply: true }, { deadSignals: ["positiveReply", "meeting", "meetingAttended", "closeWin"], signalDates: { delivered: "2026-07-20T00:00:00Z" } }),
    person("pre-us", { meeting: true }, { deadSignals: ["meetingAttended", "closeWin"], signalDates: { delivered: "2026-07-20T00:00:00Z" } }),
    person("hot-reply", { positiveReply: true }),
    person("hot-meeting", { positiveReply: true, meeting: true }),
    person("won-ours", { positiveReply: true, meeting: true, closeWin: true }, { orgId: "org-w", valueUsd: 9000 }),
    person("won-ours-2", { closeWin: true }, { orgId: "org-w" }), // same company: one client
    person("won-other", { closeWin: true }, { unpricedSignals: ["closeWin"] }),
    person("nobody", {}, { orgId: null }),
  ];
  const run = (c: ColdLeadsRead | null = cold) =>
    buildOfferPipeline({ persons, evidence: ALL_STEP_EVIDENCE, declared, values, cold: c, sets: offerStepSets(persons, ALL_STEP_EVIDENCE) });

  it("counts people and distinct companies contacted", () => {
    const p = run();
    expect(p.peopleContacted).toBe(8);
    expect(p.companiesContacted).toBe(6); // org-w twice, nobody has none
    expect(p.contactedWithoutCompanyCount).toBe(1);
  });

  it("serves the offer's cold leads only, priced as the pipeline prices them now, attributed to the step they reached", () => {
    const p = run();
    expect(p.coldRule).toEqual({ applies: true, afterDays: 30 });
    expect(p.coldLeads?.count).toBe(1);
    expect(p.coldLeads?.otherCausesCount).toBe(1); // pre-us: stalled before our first delivered email
    const lead = p.coldLeads!.leads[0];
    expect(lead.leadId).toBe("cold1");
    expect(lead.step.key).toBe("conversation");
    expect(lead.coldAtStep.key).toBe("meeting_booked");
    expect(lead.valueUsd).toBe(0); // every path through the dead step is dead
    expect(p.ladder.find((s) => s.step.key === "conversation")?.wentCold).toEqual({ count: 1, valueUsd: 0 });
    expect(p.ladder.find((s) => s.step.key === "meeting_booked")?.wentCold).toEqual({ count: 0, valueUsd: 0 });
  });

  it("a brand the rule does not apply to serves zero cold leads, stated; an unread rule serves null", () => {
    const none = run({ applies: false, afterDays: 30, leads: [] });
    expect(none.coldRule?.applies).toBe(false);
    expect(none.coldLeads).toEqual({ count: 0, valueUsd: 0, leads: [], otherCausesCount: 0 });
    const unread = run(null);
    expect(unread.coldRule).toBeNull();
    expect(unread.coldLeads).toBeNull();
    expect(unread.ladder.every((s) => s.wentCold === null)).toBe(true);
  });

  it("ranks live engaged leads by value, never a cold or won lead", () => {
    const p = run();
    expect(p.hotLeads?.leads.map((l) => l.leadId)).toEqual(["hot-meeting", "hot-reply"]);
    expect(p.hotLeads?.totalCount).toBe(2);
    expect(p.hotLeads!.leads[0].step.key).toBe("meeting_booked");
    const v = values.get("meeting_booked")!.valuePerOutcomeUsd;
    expect(p.hotLeads!.leads[0].valueUsd).toBeCloseTo(v, 9);
    expect(p.hotLeads!.leads[0].probabilityPct).toBeCloseTo((v / 2500) * 100, 9);
    expect(p.hotLeads!.totalValueUsd).toBeCloseTo(p.hotLeads!.leads[0].valueUsd! + p.hotLeads!.leads[1].valueUsd!, 9);
  });

  it("counts customers won on the priced causes, one company one client, stated amount else LTR", () => {
    const p = run();
    expect(p.customersWon).toEqual({ count: 1, leadCount: 2, valueUsd: 9000, otherCausesLeadCount: 1 });
  });

  it("customers won is null when no source of closed deals could be read, 0 when measured", () => {
    const unread = buildOfferPipeline({
      persons: [],
      evidence: { ...ALL_STEP_EVIDENCE, observedSteps: false, legacyQualifications: false },
      declared,
      values,
      cold,
      sets: offerStepSets([], ALL_STEP_EVIDENCE),
    });
    expect(unread.customersWon).toBeNull();
    const zero = buildOfferPipeline({ persons: [person("x", {})], evidence: ALL_STEP_EVIDENCE, declared, values, cold, sets: offerStepSets([person("x", {})], ALL_STEP_EVIDENCE) });
    expect(zero.customersWon).toEqual({ count: 0, leadCount: 0, valueUsd: 0, otherCausesLeadCount: 0 });
  });

  it("the ladder carries every step, its value byte-equal to the outcome rows' and explained", () => {
    const p = run();
    expect(p.ladder.map((s) => s.step.key)).toEqual(["website_visit", "conversation", "signup", "form_submitted", "meeting_booked", "meeting_attended", "paid_client"]);
    const booked = p.ladder.find((s) => s.step.key === "meeting_booked")!;
    expect(booked.recipientsReached).toBe(3);
    expect(booked.valuePerOutcomeUsd).toBe(values.get("meeting_booked")!.valuePerOutcomeUsd);
    expect(booked.pricedRecipientsReached).toBe(3);
    expect(booked.pricedValueUsd).toBe(3 * values.get("meeting_booked")!.valuePerOutcomeUsd);
    expect(p.ladder.find((s) => s.step.key === "website_visit")!.pricedValueUsd).toBeNull();
    expect(booked.valueExplanation?.legs.map((l) => l.legKey)).toEqual(["meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"]);
    expect(p.ladder.find((s) => s.step.key === "website_visit")!.valuePerOutcomeUsd).toBeNull();
  });

  it("no priced economics ⇒ lead values null with the reason, counts still served", () => {
    const unpriced = pricingFunnels(["sales_meetings_from_conversation"], null);
    const p = buildOfferPipeline({ persons, evidence: ALL_STEP_EVIDENCE, declared: unpriced, values: stepValues(unpriced), cold, sets: offerStepSets(persons, ALL_STEP_EVIDENCE) });
    expect(p.hotLeads).toBeNull();
    expect(p.leadValuesUnpricedReason).toBe("lifetime_revenue_not_stated");
    expect(p.coldLeads?.leads[0].valueUsd).toBeNull();
    expect(p.coldLeads?.valueUsd).toBeNull();
    expect(p.peopleContacted).toBe(8);
  });
});
