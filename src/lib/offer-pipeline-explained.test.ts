import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPricingFunnels } from "./reading-funnels.js";
import { stepValues } from "./offer-outcomes.js";
import { STEP_PEOPLE_LIMIT, buildOfferPipeline, buildOfferPipelineAndFamilies, explainStepValue, offerStepSets, previousStepsOf, stepConversion } from "./offer-pipeline-explained.js";
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

  it("each step lists who stands on it in three disjoint groups that reconcile with the counts", () => {
    const p = run();
    for (const step of p.ladder) {
      if (!step.people) continue;
      expect(step.people.ours.count + step.people.lost.count, step.step.key).toBe(step.pricedRecipientsReached);
      expect(step.people.ours.count + step.people.lost.count + step.people.notOurs.count, step.step.key).toBe(step.recipientsReached);
    }
    const paid = p.ladder.find((s) => s.step.key === "paid_client")!.people!;
    // Same people as customersWon: 2 leads of ours, none lost, 1 not ours.
    expect(paid.ours.count).toBe(p.customersWon!.leadCount);
    expect(paid.lost.count).toBe(0);
    expect(paid.notOurs.count).toBe(p.customersWon!.otherCausesLeadCount);
    expect(paid.notOurs.leads.map((l) => l.leadId)).toEqual(["won-other"]);
    expect(paid.ours.leads[0].leadId).toBe("won-ours"); // stated $9,000 ranks first
    const reply = p.ladder.find((s) => s.step.key === "conversation")!.people!;
    expect(reply.lost.leads).toEqual([
      expect.objectContaining({ leadId: "cold1", lostReason: "went_cold", lostSince: "2026-09-01T00:00:00Z", coldAtStep: { key: "meeting_booked", label: expect.any(String) } }),
    ]);
    expect(reply.ours.leads.map((l) => l.leadId).sort()).toEqual(["hot-meeting", "hot-reply", "won-ours"]);
    // pre-us: lead-service says it went cold (its cold row is not ours to LIST, but it is not alive either:
    // hot leads exclude it on the same verdict).
    const booked = p.ladder.find((s) => s.step.key === "meeting_booked")!.people!;
    expect(booked.lost.leads.map((l) => [l.leadId, l.lostReason, l.lostSince])).toEqual([["pre-us", "went_cold", "2024-09-23T00:00:00Z"]]);
    expect(p.hotLeads!.leads.map((l) => l.leadId)).not.toContain("pre-us");
    // A step nobody's producer counts lists nobody (null), never an empty "ours".
    const unread = buildOfferPipeline({
      persons,
      evidence: { ...ALL_STEP_EVIDENCE, observedSteps: false, legacyQualifications: false },
      declared,
      values,
      cold,
      sets: offerStepSets(persons, { ...ALL_STEP_EVIDENCE, observedSteps: false, legacyQualifications: false }),
    });
    expect(unread.ladder.find((s) => s.step.key === "meeting_attended")!.people).toBeNull();
  });

  it("lost leads = went cold (ours) + ruled out, one verdict with the lost family", () => {
    const rows = [
      ...persons,
      person("ruled", { positiveReply: true, meeting: true }, { deadSignals: ["positiveReply", "meeting", "meetingAttended", "closeWin"] }),
    ];
    const { pipeline: p, families } = buildOfferPipelineAndFamilies({ persons: rows, evidence: ALL_STEP_EVIDENCE, declared, values, cold, sets: offerStepSets(rows, ALL_STEP_EVIDENCE) });
    expect(p.lostLeads?.wentColdCount).toBe(p.coldLeads?.count);
    expect(p.lostLeads?.ruledOutCount).toBe(1);
    expect(p.lostLeads?.count).toBe(p.coldLeads!.count + 1);
    expect(p.lostLeads?.leads.map((l) => [l.leadId, l.lostReason])).toEqual([["cold1", "went_cold"], ["ruled", "ruled_out"]]);
    expect(p.lostLeads?.leads[1]).toEqual(expect.objectContaining({ lostSince: null, coldAtStep: null, coldSince: null, stalledSince: null, valueUsd: 0 }));
    const lostFamily = families.filter((f) => f.family === "lost").map((f) => f.leadId).sort();
    expect(lostFamily).toEqual(p.lostLeads!.leads.map((l) => l.leadId).sort());
    expect(run(null).lostLeads).toBeNull();
  });

  it("caps each group's list at STEP_PEOPLE_LIMIT and still counts every one", () => {
    const many = Array.from({ length: STEP_PEOPLE_LIMIT + 7 }, (_, i) => person(`r${String(i).padStart(3, "0")}`, { positiveReply: true }));
    const p = buildOfferPipeline({ persons: many, evidence: ALL_STEP_EVIDENCE, declared, values, cold: null, sets: offerStepSets(many, ALL_STEP_EVIDENCE) });
    const reply = p.ladder.find((s) => s.step.key === "conversation")!.people!;
    expect(reply.ours.count).toBe(STEP_PEOPLE_LIMIT + 7);
    expect(reply.ours.leads).toHaveLength(STEP_PEOPLE_LIMIT);
    expect(reply.limit).toBe(STEP_PEOPLE_LIMIT);
  });

  it("every listed person carries the leads_campaigns row ids a status write takes, merged across campaigns", () => {
    const rows = [
      person("x", { positiveReply: true, meeting: true }, { campaignLeadIds: ["lc-1"] }),
      person("x", { positiveReply: true }, { campaignId: "c2", campaignLeadIds: ["lc-2"] }),
      person("y", { positiveReply: true }, { campaignLeadIds: ["lc-3"], signalDates: { delivered: "2026-07-20T00:00:00Z" } }),
      // Ruled out by a human, nothing priced left, not cold.
      person("z", { positiveReply: true, meeting: true }, { campaignLeadIds: ["lc-4"], deadSignals: ["positiveReply", "meeting", "meetingAttended", "closeWin"] }),
    ];
    const coldY: ColdLeadsRead = {
      applies: true,
      afterDays: 30,
      leads: [{ leadId: "y", campaignId: "c1", email: "y@x.com", step: "meeting_booked", since: "2026-09-01T00:00:00Z", after: "positive_reply", stalledSince: "2026-08-02T00:00:00Z" }],
    };
    const p = buildOfferPipeline({ persons: rows, evidence: ALL_STEP_EVIDENCE, declared, values, cold: coldY, sets: offerStepSets(rows, ALL_STEP_EVIDENCE) });
    const x = p.hotLeads!.leads.find((l) => l.leadId === "x")!;
    expect(x.campaignLeadIds).toEqual(["lc-1", "lc-2"]);
    expect(x.campaignLeadId).toBe("lc-1");
    expect(p.coldLeads!.leads[0]).toEqual(expect.objectContaining({ leadId: "y", campaignLeadId: "lc-3", campaignLeadIds: ["lc-3"] }));
    const booked = p.ladder.find((s) => s.step.key === "meeting_booked")!.people!;
    expect(booked.ours.leads[0]).toEqual(expect.objectContaining({ leadId: "x", campaignLeadIds: ["lc-1", "lc-2"] }));
    expect(booked.lost.leads).toEqual([expect.objectContaining({ leadId: "z", campaignLeadId: "lc-4", lostReason: "ruled_out", lostSince: null, coldAtStep: null, valueUsd: 0 })]);
    // No row id stated: null + [], never an invented one.
    const bare = run().hotLeads!.leads[0];
    expect(bare.campaignLeadId).toBeNull();
    expect(bare.campaignLeadIds).toEqual([]);
  });

  it("serves the conversion from the previous step on the PRICED leads beside the every-cause one", () => {
    const rows = [
      person("a", { positiveReply: true, meeting: true, meetingAttended: true, closeWin: true }),
      person("b", { positiveReply: true, meeting: true, meetingAttended: true, closeWin: true }, { unpricedSignals: ["closeWin"] }),
      person("c", { positiveReply: true, meeting: true, meetingAttended: true }, { unpricedSignals: ["meetingAttended"] }),
    ];
    const p = buildOfferPipeline({ persons: rows, evidence: ALL_STEP_EVIDENCE, declared, values, cold: null, sets: offerStepSets(rows, ALL_STEP_EVIDENCE) });
    const paid = p.ladder.find((s) => s.step.key === "paid_client")!;
    expect(paid.conversionFromPrevious).toEqual(expect.objectContaining({ previousSteps: ["meeting_attended"], previousReached: 3, reachedFromPrevious: 2 }));
    expect(paid.pricedConversionFromPrevious).toEqual(expect.objectContaining({ previousSteps: ["meeting_attended"], previousReached: 2, reachedFromPrevious: 1, ratePct: 50 }));
    expect(paid.pricedConversionFromPrevious!.reachedFromPrevious).toBeLessThanOrEqual(paid.pricedRecipientsReached!);
    // The entry step converts from everyone contacted on both bases.
    const reply = p.ladder.find((s) => s.step.key === "conversation")!;
    expect(reply.pricedConversionFromPrevious?.previousSteps).toEqual(["contacted"]);
    expect(reply.pricedConversionFromPrevious?.previousReached).toBe(3);
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
