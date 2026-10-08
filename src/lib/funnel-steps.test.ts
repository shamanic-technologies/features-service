/**
 * The funnel walk places each rung by the step's WORDING, and a step nothing in the fleet counts is a
 * rung stated UNMEASURED — never a throw, never dropped, never counted on a lookalike
 * (features-service#1203).
 *
 * ONE fixture drives every case. Two of its people filled the form on the brand's OWN site, which is
 * exactly the lookalike the ad funnel's form must not be counted on: `form_magnet` counts them at its
 * form rung, `lead_forms_from_ads` must not. A suite that only checked "the walk no longer throws"
 * would pass on an implementation that counted them there.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { ALL_STEP_EVIDENCE, buildFunnelSteps, FunnelStepShapeError, leadFieldOfStep } from "./funnel-steps.js";
import { FUNNEL_LEG_SIGNALS } from "./funnel-registry.js";
import { legKeysOfFunnel } from "./funnel-legs.js";
import { SALES_FUNNEL_KEYS, SALES_FUNNELS } from "./sales-funnels.js";
import type { EnginePerson } from "./revenue-engine.js";

function person(leadId: string, signals: Record<string, boolean>): EnginePerson {
  return { leadId, orgId: null, orgName: null, signals, signalDates: {} } as unknown as EnginePerson;
}

const PERSONS: EnginePerson[] = [
  person("p1", { contacted: true, clicked: true, formSubmission: true, closeWin: true }),
  person("p2", { contacted: true, clicked: true }),
  person("p3", { contacted: true, clicked: true, formSubmission: true }),
  person("p4", { contacted: true }),
  person("p5", { contacted: true, closeWin: true }),
];
const COMMITTED_CENTS = 10_000;
const NO_STATEMENTS = {};

describe("buildFunnelSteps — every catalogue funnel walks, rung for step", () => {
  it.each(SALES_FUNNEL_KEYS)("%s: one rung per step, in the funnel's own order and words", (key) => {
    const walk = buildFunnelSteps(key, PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE);
    expect(walk.steps.map((s) => s.step)).toEqual([...SALES_FUNNELS[key].steps]);
    expect(walk.steps.map((s) => s.legKey)).toEqual(legKeysOfFunnel(key));
    // Every counted leg is placed on exactly one rung.
    expect(walk.steps.filter((s) => s.leadField !== null)).toHaveLength(FUNNEL_LEG_SIGNALS[key].length);
  });

  it("the funnels whose every step is counted are unchanged: each rung counts its step's own flag", () => {
    const fields = (key: (typeof SALES_FUNNEL_KEYS)[number]) =>
      buildFunnelSteps(key, PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE).steps.map((s) => s.leadField);
    expect(fields("sales_meetings_from_conversation")).toEqual(["repliedPositive", "meetingBooked", "meetingAttended", "purchased"]);
    expect(fields("sales_meetings_from_website")).toEqual(["clicked", "meetingBooked", "meetingAttended", "purchased"]);
    expect(fields("website_purchases")).toEqual(["clicked", "signup", "purchased"]);
    expect(fields("form_magnet")).toEqual(["clicked", "formSubmission", "purchased"]);
    expect(fields("sales_from_conversation")).toEqual(["repliedPositive", "purchased"]);
    expect(fields("sales_meetings_from_ads")).toEqual(["meetingBooked", "meetingAttended", "purchased"]);
  });
});

describe("a step nothing in the fleet counts is an UNMEASURED rung", () => {
  it("sales_from_website: the Direct purchase rung is stated, with no figure, between two counted rungs", () => {
    const walk = buildFunnelSteps("sales_from_website", PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE, NO_STATEMENTS);
    const [visit, purchase, paid] = walk.steps;

    expect(visit).toMatchObject({ step: "Website visit", leadField: "clicked", recipientsReached: 3, fromStep: "Contacted", fromRecipientsReached: 5 });
    expect(visit.conversionFromPreviousPct).toBeCloseTo(60, 9);

    expect(purchase).toMatchObject({
      step: SALES_FUNNELS.sales_from_website.steps[1],
      leadField: null,
      recipientsReached: null,
      costPerReachCents: null,
      ratioBasisRecipientsReached: null,
      conversionFromPreviousPct: null,
      fromStep: "Website visit",
      fromRecipientsReached: 3,
    });
    // Statements were read and none lands on a step nothing counts: an empty set, no average.
    expect(purchase.customerCost).toMatchObject({ costCents: 0, statedCount: 0, costPerReachCents: null });

    // The sale is still counted; its rate from an unmeasured rung has no base.
    expect(paid).toMatchObject({ step: "Paid client", leadField: "purchased", recipientsReached: 2, fromRecipientsReached: null, conversionFromPreviousPct: null });
    expect(paid.costPerReachCents).not.toBeNull();
  });

  it("lead_forms_from_ads: a form filled on the brand's OWN site is never counted on the ad's form", () => {
    const ad = buildFunnelSteps("lead_forms_from_ads", PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE);
    const magnet = buildFunnelSteps("form_magnet", PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE);

    // The same two people, the same label's wording: counted on the own-site form, not on the ad's.
    expect(leadFieldOfStep(SALES_FUNNELS.lead_forms_from_ads.steps[0])).toBe("formSubmission");
    expect(magnet.steps[1]).toMatchObject({ leadField: "formSubmission", recipientsReached: 2 });
    expect(ad.steps[0]).toMatchObject({ leadField: null, recipientsReached: null, costPerReachCents: null, conversionFromPreviousPct: null });

    expect(ad.steps[1]).toMatchObject({ step: "Paid client", leadField: "purchased", recipientsReached: 2, fromRecipientsReached: null, conversionFromPreviousPct: null });
  });

  it("a counted leg that names no step still fails loud — placing it anyway would mislabel a rung", () => {
    const signals = FUNNEL_LEG_SIGNALS as Record<string, readonly string[]>;
    const original = signals.form_magnet;
    signals.form_magnet = ["clicked", "signup", "closeWin"];
    try {
      expect(() => buildFunnelSteps("form_magnet", PERSONS, COMMITTED_CENTS, ALL_STEP_EVIDENCE)).toThrow(FunnelStepShapeError);
    } finally {
      signals.form_magnet = original;
    }
  });
});

describe("a rung several legs lead into counts only the leads that came through ITS leg", () => {
  // 12 clicked, nobody who clicked booked; 3 booked off a positive reply; 1 booked with no earlier rung.
  const persons: EnginePerson[] = [
    ...Array.from({ length: 12 }, (_, i) => person(`c${i}`, { contacted: true, clicked: true })),
    ...Array.from({ length: 3 }, (_, i) => person(`r${i}`, { contacted: true, positiveReply: true, meeting: true })),
    person("orphan", { contacted: true, meeting: true }),
  ];

  it("website visit → meeting booked does not borrow the reply leg's meetings", () => {
    const [, booked] = buildFunnelSteps("sales_meetings_from_website", persons, COMMITTED_CENTS, ALL_STEP_EVIDENCE).steps;
    // 4 people booked; none of them clicked, so the leg is a measured 0 (owner 2026-10-08: of the
    // people at FROM, how many reached TO).
    expect(booked).toMatchObject({ recipientsReached: 4, recipientsThroughLeg: 0, fromRecipientsReached: 12 });
    expect(booked.conversionFromPreviousPct).toBe(0);
  });

  it("the reply leg keeps the meetings of the people who replied, and the first rung is untouched", () => {
    const [reply, booked] = buildFunnelSteps("sales_meetings_from_conversation", persons, COMMITTED_CENTS, ALL_STEP_EVIDENCE).steps;
    expect(reply).toMatchObject({ recipientsReached: 3, recipientsThroughLeg: 3 });
    expect(booked).toMatchObject({ recipientsReached: 4, recipientsThroughLeg: 3, fromRecipientsReached: 3 });
  });
});
