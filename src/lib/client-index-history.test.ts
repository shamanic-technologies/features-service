import { describe, expect, it } from "vitest";
import { addPairBrandEngagement, emptyBrandEngagementHistory, engagedLeadPointOn, type PairSpendDay } from "./client-index-history.js";
import { dayRange } from "./fleet-index-history.js";
import type { Journey } from "./lived-sales-paths.js";
import type { EnginePerson } from "./revenue-engine.js";
import { indexTimelines } from "./serving-row-credit.js";

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

function spendDay(day: string, cents: number, unpriced = 0): PairSpendDay {
  return { campaignId: "c1", day, netCents: cents, grossIncurredCents: cents, vendorCents: cents / 2, unpricedCents: unpriced, checkVendorReadCents: cents, checkBilledReadCents: cents };
}

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
