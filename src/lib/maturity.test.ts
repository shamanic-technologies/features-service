/**
 * THE ONE MATURITY RULE (features-service#1196) — its parameters, its cutoff, its cohort predicate and its
 * verdicts, plus the two pure helpers every mature figure rests on (exact decimal sums, the person counts).
 */
import { describe, it, expect } from "vitest";
import {
  legMaturity,
  legMaturityCatalogue,
  maturityCutoffIso,
  legCutoffIso,
  servedInMatureCohort,
  startedBeforeParam,
  isMatureCount,
  scopeIsMature,
  outcomeFigures,
  legMaturityFigures,
} from "./maturity.js";
import { addDecimals, asDecimalString, sumDecimalStrings, decimalCentsToUsd } from "./decimal.js";
import { serveDatesStated, matureSlugStats, matureAudienceDynastyCounts } from "./mature-evidence.js";
import type { EnginePerson } from "./revenue-engine.js";

const NOW = new Date("2026-09-28T14:05:00.000Z");

describe("the per-leg parameters (owner decision 2026-09-28)", () => {
  it("the conversation leg: 21 days, ONE positive reply", () => {
    expect(legMaturity("start_to_conversation")).toEqual({
      legKey: "start_to_conversation",
      durationDays: 21,
      outcomesRequired: 1,
      outcomeSignal: "positiveReply",
      source: "measured",
    });
  });

  it("the website-visit leg: 21 days, TEN visits", () => {
    expect(legMaturity("start_to_website_visit")).toMatchObject({ durationDays: 21, outcomesRequired: 10, outcomeSignal: "clicked", source: "measured" });
  });

  it("every other leg (and no leg) matures the day it is bought, on the pre-existing bar of 10", () => {
    for (const legKey of ["conversation_to_meeting_booked", "meeting_booked_to_meeting_attended", null, undefined]) {
      expect(legMaturity(legKey)).toMatchObject({ durationDays: 0, outcomesRequired: 10, outcomeSignal: null, source: "default" });
    }
    expect(legCutoffIso("conversation_to_meeting_booked", NOW)).toBeNull();
  });

  it("the catalogue keeps the order it is given", () => {
    expect(legMaturityCatalogue(["start_to_website_visit", "start_to_conversation"]).map((m) => m.outcomesRequired)).toEqual([10, 1]);
  });
});

describe("the cutoff is UTC midnight of today − duration, and the cohort is cut on the SERVE", () => {
  it("moves once a day", () => {
    expect(maturityCutoffIso(21, NOW)).toBe("2026-09-07T00:00:00.000Z");
    expect(maturityCutoffIso(21, new Date("2026-09-28T23:59:59.999Z"))).toBe("2026-09-07T00:00:00.000Z");
    expect(legCutoffIso("start_to_conversation", NOW)).toBe("2026-09-07T00:00:00.000Z");
  });

  it("a lead served before the cutoff is mature; at or after it is young; no serve date stated is IN", () => {
    const cutoff = "2026-09-07T00:00:00.000Z";
    expect(servedInMatureCohort("2026-09-06T23:59:59.999Z", cutoff)).toBe(true);
    expect(servedInMatureCohort("2026-09-07T00:00:00.000Z", cutoff)).toBe(false);
    expect(servedInMatureCohort(null, cutoff)).toBe(true);
    expect(servedInMatureCohort(undefined, cutoff)).toBe(true);
    // A 0-day leg keeps everybody: mature ≡ flash.
    expect(servedInMatureCohort("2026-09-28T10:00:00.000Z", null)).toBe(true);
  });

  it("runs-service is asked for runs started up to the microsecond before the cutoff", () => {
    expect(startedBeforeParam("2026-09-07T00:00:00.000Z")).toBe("2026-09-06T23:59:59.999999Z");
  });
});

describe("the verdicts", () => {
  it("is judged on the MATURE outcomes against the leg's own bar; null is not a verdict", () => {
    expect(isMatureCount(1, "start_to_conversation")).toBe(true);
    expect(isMatureCount(0, "start_to_conversation")).toBe(false);
    expect(isMatureCount(9, "start_to_website_visit")).toBe(false);
    expect(isMatureCount(10, "start_to_website_visit")).toBe(true);
    expect(isMatureCount(null, "start_to_website_visit")).toBeNull();
  });

  it("a scope spanning several legs is mature only when every leg is", () => {
    const conv = { legKey: "start_to_conversation", matureOutcomes: 3 };
    const visitYoung = { legKey: "start_to_website_visit", matureOutcomes: 4 };
    const visitMature = { legKey: "start_to_website_visit", matureOutcomes: 12 };
    expect(scopeIsMature([conv, visitMature])).toBe(true);
    expect(scopeIsMature([conv, visitYoung])).toBe(false);
    expect(scopeIsMature([conv, { legKey: "start_to_website_visit", matureOutcomes: null }])).toBeNull();
    expect(scopeIsMature([visitYoung, { legKey: "start_to_conversation", matureOutcomes: null }])).toBe(false);
    expect(scopeIsMature([])).toBeNull();
  });
});

describe("the observed figures of one version", () => {
  it("never floors: 0 outcomes is a null cost, 0 contacted a null rate, a measured 0 stays 0", () => {
    expect(outcomeFigures(100, 60, 12)).toEqual({ spentUsd: 100, contacted: 60, outcomes: 12, costPerOutcomeUsd: 100 / 12, conversionRatePct: 20 });
    expect(outcomeFigures(100, 60, 0)).toMatchObject({ costPerOutcomeUsd: null, conversionRatePct: 0 });
    expect(outcomeFigures(0, 0, 0)).toMatchObject({ costPerOutcomeUsd: null, conversionRatePct: null });
  });

  it("a leg's wrapper states its rule, both versions and the verdict on the MATURE outcomes", () => {
    const leg = legMaturityFigures("start_to_website_visit", outcomeFigures(300, 150, 22), outcomeFigures(100, 100, 9));
    expect(leg).toMatchObject({ durationDays: 21, outcomesRequired: 10, isMature: false });
    // 22 flash visits do not make it mature: the verdict reads the mature 9.
    expect(legMaturityFigures("start_to_website_visit", outcomeFigures(300, 150, 22), null).isMature).toBeNull();
  });
});

describe("exact decimal sums (lib/decimal.ts)", () => {
  it("adds the producer's decimal text exactly, where floats drift", () => {
    expect(addDecimals("0.1000000000", "0.2000000000", "t")).toBe("0.3000000000");
    expect(sumDecimalStrings(["1234.5678901234", "0.0000000001", "-0.5"], "t")).toBe("1234.0678901235");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("renders an exponent as plain decimal text, and fails loud on garbage", () => {
    expect(asDecimalString(1e-7)).not.toContain("e");
    expect(() => addDecimals("abc", "1", "t")).toThrow();
  });

  it("converts cents to dollars once, at the end", () => {
    expect(decimalCentsToUsd("12345.6789")).toBeCloseTo(123.456789, 10);
  });
});

const person = (over: Partial<EnginePerson> & { leadId: string }): EnginePerson =>
  ({
    campaignId: "c1",
    workflowSlug: "wf-a",
    audienceId: null,
    signals: { contacted: true },
    ...over,
  }) as EnginePerson;

describe("the mature cohort's person counts (lib/mature-evidence.ts)", () => {
  const cutoff = "2026-09-07T00:00:00.000Z";
  const persons = [
    person({ leadId: "a", servedAt: "2026-08-01T00:00:00Z", audienceId: "aud-1", signals: { contacted: true, clicked: true } }),
    person({ leadId: "b", servedAt: "2026-08-02T00:00:00Z", audienceId: "aud-1", signals: { contacted: true, positiveReply: true } }),
    person({ leadId: "c", servedAt: "2026-09-20T00:00:00Z", audienceId: "aud-1", signals: { contacted: true, clicked: true } }),
    person({ leadId: "d", servedAt: "2026-08-03T00:00:00Z", campaignId: "c2", signals: { contacted: true, clicked: true } }),
    person({ leadId: "e", servedAt: "2026-08-03T00:00:00Z", workflowSlug: null, signals: { contacted: true, clicked: true } }),
  ];

  it("a population is cut only when EVERY row states its serve date", () => {
    expect(serveDatesStated(persons)).toBe(true);
    expect(serveDatesStated([...persons, { leadId: "x", signals: {} } as EnginePerson])).toBe(false);
    expect(serveDatesStated([])).toBe(true);
  });

  it("counts per slug the leads served before the cutoff, whenever their outcome landed", () => {
    const stats = matureSlugStats(persons, cutoff);
    // a, b, d on wf-a; c is young; e has no workflow.
    expect(stats.get("wf-a")).toEqual({ recipientsContacted: 3, recipientsClicked: 2, recipientsRepliesPositive: 1 });
    expect(matureSlugStats(persons, cutoff, new Set(["c1"])).get("wf-a")).toEqual({
      recipientsContacted: 2,
      recipientsClicked: 1,
      recipientsRepliesPositive: 1,
    });
    // A 0-day leg: everybody.
    expect(matureSlugStats(persons, null).get("wf-a")?.recipientsContacted).toBe(4);
  });

  it("attributes each person to the audience its SERVE drew it from", () => {
    const counts = matureAudienceDynastyCounts(persons, cutoff, new Set(["aud-1"]), new Map([["wf-a", "dyn-a"]]));
    expect(counts.get("aud-1")?.get("dyn-a")).toEqual({ contacted: 2, clicks: 1, replies: 1 });
  });
});
