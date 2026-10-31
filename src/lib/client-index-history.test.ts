import { describe, expect, it } from "vitest";
import { addPairBrandEngagement, brandReturnRowsOn, emptyBrandEngagementHistory, engagedLeadPointOn, engineAsOf, replayPairReturn, roiPointOn, type PairSpendDay } from "./client-index-history.js";
import type { EngineCapture } from "./engine-capture.js";
import { vendorReturnMedian } from "./fleet-return-vendor.js";
import type { BrandReturnRow } from "./fleet-return-on-spend.js";
import { dayRange } from "./fleet-index-history.js";
import type { Journey } from "./lived-sales-paths.js";
import { NO_MATURITY } from "./roi-maturity.js";
import type { EnginePerson } from "./revenue-engine.js";
import { indexTimelines } from "./serving-row-credit.js";

const END = (day: string) => Date.parse(`${day}T23:59:59.999Z`);

function person(id: string, servedAt: string, replyAt: string | null): EnginePerson {
  return {
    leadId: id,
    campaignId: "c1",
    workflowSlug: "a1",
    servedAt,
    signals: { contacted: true, sent: true, positiveReply: replyAt !== null },
    signalDates: { contacted: servedAt, lastSent: servedAt, positiveReply: replyAt },
  } as unknown as EnginePerson;
}

describe("engineAsOf (PUBLIC-VENDOR-COST-1031-HISTORY)", () => {
  it("a person is out before its entry, and a signal stands only from its own date", () => {
    const p = person("l1", "2026-08-01T10:00:00.000Z", "2026-08-05T09:00:00.000Z");
    expect(engineAsOf(p, END("2026-07-31"))).toBeNull();
    expect(engineAsOf(p, END("2026-08-04"))!.signals.positiveReply).toBe(false);
    expect(engineAsOf(p, END("2026-08-05"))!.signals.positiveReply).toBe(true);
    expect(engineAsOf(p, END("2026-08-05"))!.signals.contacted).toBe(true);
  });

  it("an undated value signal is in no past day; a never-dated flag stands from the entry", () => {
    const p = { ...person("l1", "2026-08-01T10:00:00.000Z", null), signals: { contacted: true, meeting: true, bounced: true } } as EnginePerson;
    const cut = engineAsOf(p, END("2026-09-01"))!;
    expect(cut.signals.meeting).toBe(false);
    expect(cut.signals.bounced).toBe(true);
  });
});

const PATHS = [{ tag: "reply", signal: "positiveReply", expectedRevenueUsd: 100, engagementRoute: true }];

function capture(persons: EnginePerson[]): EngineCapture {
  return { paths: PATHS, persons, closeValueUsd: 1000, milestones: [], contacted: null, plan: NO_MATURITY, campaigns: [{ id: "c1", legKey: "lead_found_to_conversation" }], matureCut: false };
}

function spendDay(day: string, cents: number, unpriced = 0): PairSpendDay {
  return { campaignId: "c1", day, netCents: cents, grossIncurredCents: cents, vendorCents: cents / 2, unpricedCents: unpriced, checkVendorReadCents: cents, checkBilledReadCents: cents };
}

describe("replayPairReturn", () => {
  const days = dayRange("2026-08-01", "2026-08-10");
  const persons = [person("l1", "2026-08-01T10:00:00.000Z", "2026-08-05T09:00:00.000Z"), person("l2", "2026-08-02T10:00:00.000Z", null)];
  const spend = days.map((d) => spendDay(d, 1000));

  it("pipeline and spend grow day by day; nothing dated after a day moves that day", () => {
    const r = replayPairReturn(capture(persons), spend, days, "2026-08-10");
    expect(r[0]!.matureNetUsd).toBe(10);
    expect(r[0]!.matureVendorUsd).toBe(5);
    expect(r[3]!.maturePipelineUsd).toBe(0);
    expect(r[4]!.maturePipelineUsd).toBeGreaterThan(0);
    expect(r[9]!.matureNetUsd).toBe(100);
  });

  it("the replay of today prices the live persons untouched (undated evidence included)", () => {
    const undated = [{ ...persons[0]!, signalDates: { contacted: "2026-08-01T10:00:00.000Z" } } as EnginePerson];
    const r = replayPairReturn(capture(undated), spend, days, "2026-08-10");
    expect(r[8]!.maturePipelineUsd).toBe(0);
    expect(r[9]!.maturePipelineUsd).toBeGreaterThan(0);
  });

  it("no captured pass = no pipeline and no verdict, the spend still counted", () => {
    const r = replayPairReturn(null, spend, days, "2026-08-10");
    expect(r[9]).toMatchObject({ maturePipelineUsd: null, isMature: null, matureNetUsd: 100 });
  });
});

describe("vendorReturnMedian (shared with the live index)", () => {
  const row = (brandId: string, net: number, pipeline: number, vendor: number, unpriced = 0): BrandReturnRow => ({
    brandId,
    committedSpendUsd: net,
    expectedPipelineUsd: pipeline,
    isMature: true,
    vendorSpend: { flashUsd: vendor, matureUsd: vendor, unpricedFlashUsd: unpriced, unpricedMatureUsd: unpriced },
  });

  it("median over known clients past the floor, an unknown vendor cost left out and counted", () => {
    const rows = [row("a", 200, 400, 100), row("b", 200, 800, 100), row("c", 200, 1200, 100), row("d", 200, 1600, 100), row("e", 200, 2000, 100), row("f", 200, 99999, 100, 50), row("g", 50, 500, 25)];
    const r = vendorReturnMedian(rows, 100);
    expect(r.medianReturnPerDollar).toBe(12);
    expect(r.brandCount).toBe(5);
    expect(r.vendorCostUnknownBrands).toBe(1);
    expect(roiPointOn(rows).value).toBe(12);
  });

  it("brand rows sum a brand's pairs", () => {
    const d = { maturePipelineUsd: 100, matureNetUsd: 60, matureVendorUsd: 30, matureUnpricedUsd: 0, isMature: true };
    const rows = brandReturnRowsOn([{ brandId: "a", days: [d] }, { brandId: "a", days: [{ ...d, isMature: false }] }], 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ committedSpendUsd: 120, expectedPipelineUsd: 200, isMature: false });
  });
});

describe("brand engagement history", () => {
  const days = dayRange("2026-08-01", "2026-08-10");
  const journey = (id: string, at: string, replyAt: string | null): Journey =>
    ({
      leadId: id,
      offerId: null,
      acts: [{ campaignId: "c1", firstActedAt: at, kind: "email" }],
      emailSends: [{ campaignId: "c1", workflowSlug: "a1", firstSentAt: at, lastSentAt: at, screenable: true }],
      facts: replyAt ? [{ label: "interested", source: "reply", occurredAt: replyAt, campaignId: "c1", attributable: true, valueCents: null }] : [],
    }) as unknown as Journey;

  it("counts credited persons as of each day and the median client's vendor cost per engaged lead", () => {
    const h = emptyBrandEngagementHistory(days, "2026-08-10");
    const mk = (brand: string, replyDay: string) => {
      const ps = [person(`${brand}-1`, "2026-08-01T10:00:00.000Z", `${replyDay}T09:00:00.000Z`)];
      addPairBrandEngagement(h, brand, ps, indexTimelines([journey(`${brand}-1`, "2026-08-01T10:00:00.000Z", `${replyDay}T09:00:00.000Z`)]));
    };
    mk("A", "2026-08-03");
    mk("B", "2026-08-06");
    const spend = new Map([
      ["A", days.map((d) => spendDay(d, 200))],
      ["B", days.map((d) => spendDay(d, 400))],
    ]);
    expect(engagedLeadPointOn(h, spend, 1).point.value).toBeNull();
    expect(engagedLeadPointOn(h, spend, 4).point.value).toBeNull();
    // 08-06: A $6 vendor / 1 reply, B $12 / 1: median $9.
    expect(engagedLeadPointOn(h, spend, 5).point.value).toBe(9);
  });

  it("a brand whose unpriced spend passes 1% is left out and counted", () => {
    const h = emptyBrandEngagementHistory(days, null);
    for (const b of ["A", "B", "C"]) addPairBrandEngagement(h, b, [person(`${b}-1`, "2026-08-01T10:00:00.000Z", "2026-08-02T09:00:00.000Z")], indexTimelines([journey(`${b}-1`, "2026-08-01T10:00:00.000Z", "2026-08-02T09:00:00.000Z")]));
    const spend = new Map([
      ["A", [spendDay("2026-08-01", 200)]],
      ["B", [spendDay("2026-08-01", 400)]],
      ["C", [spendDay("2026-08-01", 400, 100)]],
    ]);
    const { point } = engagedLeadPointOn(h, spend, 5);
    expect(point.value).toBe(1.5);
    expect(point.inputs).toMatchObject({ clients: 2, clientsVendorCostUnknown: 1 });
  });
});
