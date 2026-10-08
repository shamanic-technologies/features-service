import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPricingFunnels } from "./reading-funnels.js";
import { stepValues } from "./offer-outcomes.js";
import { buildConversionHistory, buildOfferPipeline, explainStepValue, offerStepSets } from "./offer-pipeline-explained.js";
import { ALL_STEP_EVIDENCE } from "./funnel-steps.js";
import { resolveArrow, type MeasuredArrowRate } from "./effective-conversion-rates.js";
import type { EnginePerson } from "./revenue-engine.js";

const measured = (basis: "crm" | "our_leads", from: number, to: number): MeasuredArrowRate => {
  const sufficient = from >= 10;
  return {
    basis,
    outcomesCounted: basis === "crm" ? null : "caused_by_our_outreach",
    fromReached: from,
    toReached: to,
    toReachedThroughOtherLegs: basis === "crm" ? null : 0,
    ratePct: (to / from) * 100,
    sufficient,
    gap: sufficient ? null : "below_learning_bar",
  };
};

describe("rate candidates per leg (owner 2026-10-08, the step side panel)", () => {
  it("a leg kept from the CRM lists our leads' measurement and the client's value beside it, one kept", () => {
    const leg = resolveArrow("Meeting attended", "Paid client", measured("crm", 43, 28), 32, { ratePct: 20, brandCount: 2 }, 15, measured("our_leads", 4, 1));
    expect(leg.source).toBe("measured");
    expect(leg.candidates.map((c) => [c.basis, c.kept, c.notKeptReason])).toEqual([
      ["crm", true, null],
      ["our_leads", false, "crm_measures_this_leg"],
      ["manual", false, "outranked"],
      ["median", false, "too_few_brands"],
      ["default", false, "outranked"],
    ]);
    const kept = leg.candidates.filter((c) => c.kept);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.ratePct).toBe(leg.effectiveRatePct);
    expect(leg.candidates[0]).toMatchObject({ fromReached: 43, toReached: 28 });
    expect(leg.candidates[1]).toMatchObject({ fromReached: 4, toReached: 1, ratePct: 25 });
  });

  it("a measurement below the bar is listed, not kept: the client's value is", () => {
    const leg = resolveArrow("Positive reply", "Meeting booked", measured("our_leads", 4, 1), 32, { ratePct: null, brandCount: 0 }, 15);
    expect(leg.source).toBe("manual");
    expect(leg.candidates.map((c) => [c.basis, c.kept, c.notKeptReason])).toEqual([
      ["our_leads", false, "below_learning_bar"],
      ["manual", true, null],
      ["default", false, "outranked"],
    ]);
  });

  it("precedence untouched: the effective rate is byte-same with or without the our-leads measurement", () => {
    const a = resolveArrow("A", "B", measured("crm", 43, 28), 32, { ratePct: 20, brandCount: 9 }, 15);
    const b = resolveArrow("A", "B", measured("crm", 43, 28), 32, { ratePct: 20, brandCount: 9 }, 15, measured("our_leads", 40, 10));
    expect([b.effectiveRatePct, b.source]).toEqual([a.effectiveRatePct, a.source]);
  });

  it("explainStepValue serves each leg's candidates, its kept one at the leg's rate", () => {
    const declared = buildPricingFunnels({
      funnelKeys: ["sales_meetings_from_conversation"],
      lifetimeRevenueUsd: 1000,
      rateOf: (from, to) => {
        const leg = resolveArrow(from, to, measured("crm", 43, 28), 32, { ratePct: null, brandCount: 0 }, 15, measured("our_leads", 4, 1));
        return { ratePct: leg.effectiveRatePct, provenance: `stated_${leg.source}`, measured: leg.measured, candidates: leg.candidates };
      },
    });
    const values = stepValues(declared);
    const explanation = explainStepValue(declared, "conversation", values.get("conversation"));
    expect(explanation).not.toBeNull();
    for (const leg of explanation!.legs) {
      const kept = leg.candidates.filter((c) => c.kept);
      expect(kept).toHaveLength(1);
      expect(kept[0]!.ratePct).toBe(leg.ratePct);
    }
  });

  it("a funnel carrying no candidates states its one rate as kept", () => {
    const declared = buildPricingFunnels({
      funnelKeys: ["sales_meetings_from_conversation"],
      lifetimeRevenueUsd: 1000,
      rateOf: () => ({ ratePct: 50, provenance: "stated_manual" }),
    });
    const explanation = explainStepValue(declared, "conversation", stepValues(declared).get("conversation"));
    expect(explanation!.legs[0]!.candidates).toEqual([
      { basis: "manual", ratePct: 50, fromReached: null, toReached: null, outcomesCounted: null, brandCount: null, kept: true, notKeptReason: null },
    ]);
  });
});

function person(leadId: string, signals: Record<string, boolean>, dates: Record<string, string | null>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    campaignId: "c1",
    orgId: `org-${leadId}`,
    email: `${leadId}@x.com`,
    signals: { contacted: true, ...signals },
    signalDates: dates,
    ...extra,
  } as EnginePerson;
}

describe("sliced % Conversion, dated (owner 2026-10-08)", () => {
  const declared = buildPricingFunnels({
    funnelKeys: ["sales_meetings_from_conversation"],
    lifetimeRevenueUsd: 1000,
    rateOf: () => ({ ratePct: 50, provenance: "stated_manual" }),
  });
  const values = stepValues(declared);
  const d = (day: string) => `${day}T10:00:00.000Z`;
  const persons = [
    person("a", {}, { contacted: d("2026-09-01"), delivered: d("2026-09-01") }),
    person("b", {}, { contacted: d("2026-09-01"), delivered: d("2026-09-02") }),
    person("c", { positiveReply: true }, { contacted: d("2026-09-01"), delivered: d("2026-09-01"), positiveReply: d("2026-09-03") }),
    person("m", { positiveReply: true, meeting: true }, { contacted: d("2026-09-01"), delivered: d("2026-09-01"), positiveReply: d("2026-09-02"), meeting: d("2026-09-04") }),
    // An undated reply: on the reply row from the last point only.
    person("u", { positiveReply: true }, { contacted: d("2026-09-02"), delivered: d("2026-09-02"), positiveReply: null }),
    // A CRM deal from before our first email: never a point before the first delivery.
    person("crm", { meeting: true }, { meeting: "2024-03-01T00:00:00.000Z" }, { signals: { contacted: false, meeting: true }, unpricedSignals: ["meeting"] } as Partial<EnginePerson>),
  ];
  const build = () =>
    buildOfferPipeline({
      persons,
      evidence: ALL_STEP_EVIDENCE,
      declared,
      values,
      cold: null,
      sets: offerStepSets(persons, ALL_STEP_EVIDENCE),
      conversionHistory: { dateOf: (p, s) => p.signalDates?.[s] ?? null, today: "2026-09-05" },
    }).exclusiveLadder;

  it("starts on the first delivery, one point per day, the last point = today's served column", () => {
    const x = build();
    const reply = x.rows.find((r) => r.step.key === "conversation")!;
    const meeting = x.rows.find((r) => r.step.key === "meeting_booked")!;
    for (const h of [reply.conversionHistory, meeting.conversionHistory, x.contacted.conversionHistory]) {
      expect(h!.startsOn).toBe("2026-09-01");
      expect(h!.points.map((p) => p.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
    }
    const lastOf = (h: typeof reply.conversionHistory) => h!.points[h!.points.length - 1]!;
    expect(lastOf(reply.conversionHistory).ratePct).toBe(reply.conversionFromRowAbove?.ratePct ?? null);
    expect(lastOf(x.contacted.conversionHistory).ratePct).toBe(x.contacted.conversionFromRowAbove?.ratePct ?? null);
    expect(lastOf(x.contacted.conversionHistory).rowPeople).toBe(x.contacted.count);
    expect(reply.conversionHistory!.undatedPeople).toBe(1);
  });

  it("each day places people where they stood that day; no defined rate is null, never 0", () => {
    const x = build();
    const reply = x.rows.find((r) => r.step.key === "conversation")!.conversionHistory!;
    // 09-01: nobody replied yet, the meeting row holds the pre-existing CRM deal (notOurs) → reply row is
    // displayed only once it has people; until then null.
    expect(reply.points[0]).toMatchObject({ rowPeople: 0, ratePct: null });
    // 09-02: m replied (reply row 1), nobody booked of ours → the row above is the meeting row (notOurs only, 0 priced).
    expect(reply.points[1]).toMatchObject({ rowPeople: 1, rowAbovePeople: 0, ratePct: 0 });
    // 09-04: m booked (meeting row 1), c replied (reply row 1) → 1 / (1 + 1).
    expect(reply.points[3]).toMatchObject({ rowPeople: 1, rowAbovePeople: 1, ratePct: 50 });
    // 09-05: u's undated reply lands → reply row 2 → 1 / 3.
    expect(reply.points[4]!.rowPeople).toBe(2);
    expect(reply.points[4]!.ratePct).toBeCloseTo(100 / 3, 9);
  });

  it("not asked → null on every row; no delivery date anywhere → null", () => {
    const plain = buildOfferPipeline({ persons, evidence: ALL_STEP_EVIDENCE, declared, values, cold: null, sets: offerStepSets(persons, ALL_STEP_EVIDENCE) }).exclusiveLadder;
    expect(plain.rows.every((r) => r.conversionHistory === null)).toBe(true);
    expect(plain.contacted.conversionHistory).toBeNull();
    const sets = offerStepSets(persons, ALL_STEP_EVIDENCE);
    expect(buildConversionHistory({ persons, sets, pricedSets: sets, dateOf: () => null, today: "2026-09-05" })).toBeNull();
  });

  it("asking for the series moves no other figure", () => {
    const strip = (x: ReturnType<typeof build>) =>
      JSON.parse(JSON.stringify(x, (k, v) => (k === "conversionHistory" ? undefined : v)));
    const plain = buildOfferPipeline({ persons, evidence: ALL_STEP_EVIDENCE, declared, values, cold: null, sets: offerStepSets(persons, ALL_STEP_EVIDENCE) }).exclusiveLadder;
    expect(strip(build())).toEqual(strip(plain));
  });
});
