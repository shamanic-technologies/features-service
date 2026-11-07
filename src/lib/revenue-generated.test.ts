import { describe, expect, it } from "vitest";
import { buildRevenueGenerated } from "./revenue-generated.js";
import { closedWonDealsOf, closedWonOf } from "./ratio-basis.js";
import type { EnginePerson } from "./revenue-engine.js";

const person = (leadId: string, over: Partial<EnginePerson> = {}): EnginePerson =>
  ({ leadId, orgId: null, email: `${leadId}@x.io`, signals: { contacted: true }, signalDates: {}, ...over }) as unknown as EnginePerson;

describe("REVENUE-GENERATED-1107: real revenue = the realized return's deals, dated", () => {
  it("closedWonDealsOf is closedWonOf's deals, each with its won date (unpriced / dead sales left out)", () => {
    const persons = [
      person("a", { signals: { contacted: true, closeWin: true }, signalDates: { closeWin: "2026-11-02T10:00:00Z" } } as never),
      person("b", { signals: { contacted: true, closeWin: true }, unpricedSignals: ["closeWin"] } as never),
      person("c", { signals: { contacted: true, closeWin: true }, deadSignals: ["closeWin"] } as never),
      person("d", { signals: { contacted: true, closeWin: true }, valueUsd: 1200 } as never),
    ];
    const deals = closedWonDealsOf(persons, 500)!;
    expect(deals).toEqual([
      { leadId: "a", valueUsd: 500, wonAt: "2026-11-02T10:00:00Z" },
      { leadId: "d", valueUsd: 1200, wonAt: null },
    ]);
    expect(closedWonOf(persons, 500)).toEqual({ closedWonCount: 2, closedWonRevenueUsd: 1700 });
  });

  it("no won deal: real $0 on every day (agrees with 0 paid clients); expected ÷ spend IS the expected ROI", () => {
    const r = buildRevenueGenerated({
      deals: [],
      spentUsd: 4381.47,
      spendByDay: new Map([["2026-11-05", 1000], ["2026-11-06", 2000], ["2026-11-07", 1385.58]]),
      expectedRoiMultiple: 0.22188451783116683,
      offerRunning: true,
      today: "2026-11-07",
      horizonDays: 2,
    });
    expect(r.realUsd).toBe(0);
    expect(r.paidClientCount).toBe(0);
    expect(r.points.filter((p) => p.kind === "measured").every((p) => p.realCumulativeUsd === 0)).toBe(true);
    const roi = 0.22188451783116683;
    expect(r.expectedToDateUsd).toBe(round(4381.47 * roi));
    expect(r.expectedToDateUsd! / r.spentUsd).toBeCloseTo(0.2219, 3);
    // Past days: ROI × committed spend by then, scaled onto the actual spend; today = expectedToDate.
    expect(r.points.map((p) => [p.date, p.kind, p.expectedCumulativeUsd])).toEqual([
      ["2026-11-05", "measured", round(0.22188451783116683 * 1000 * (4381.47 / 4385.58))],
      ["2026-11-06", "measured", round(0.22188451783116683 * 3000 * (4381.47 / 4385.58))],
      ["2026-11-07", "measured", round(4381.47 * roi)],
      ["2026-11-08", "expected", round(4381.47 * roi + roi * (4381.47 / 3))],
      ["2026-11-09", "expected", r.expectedUsd],
    ]);
    expect(r.dailySpendPaceUsd).toBe(1460.49);
    expect(r.expectedFlatReason).toBeNull();
  });

  it("won deals: the solid line places each on its won day and ends at the won total (undated on the first day)", () => {
    const r = buildRevenueGenerated({
      deals: [
        { leadId: "a", valueUsd: 500, wonAt: "2026-11-02T10:00:00Z" },
        { leadId: "b", valueUsd: 1200, wonAt: null },
        { leadId: "c", valueUsd: 300, wonAt: "2026-11-04T09:00:00Z" },
      ],
      spentUsd: 100,
      spendByDay: new Map([["2026-11-01", 100]]),
      expectedRoiMultiple: 3,
      offerRunning: false,
      today: "2026-11-04",
      horizonDays: 1,
    });
    expect(r.firstDay).toBe("2026-11-01");
    expect(r.points.map((p) => [p.date, p.realUsd, p.realCumulativeUsd])).toEqual([
      ["2026-11-01", 1200, 1200],
      ["2026-11-02", 500, 1700],
      ["2026-11-03", 0, 1700],
      ["2026-11-04", 300, 2000],
      ["2026-11-05", null, null],
    ]);
    expect(r.realUsd).toBe(2000);
    expect(r.undatedRealUsd).toBe(1200);
    // Nothing running: the expected continuation stays flat at expectedToDate.
    expect(r.expectedFlatReason).toBe("offer_not_running");
    expect(r.expectedToDateUsd).toBe(300);
    expect(r.expectedUsd).toBe(300);
  });

  it("names every null: closed deals unread, expected unavailable, nothing spent", () => {
    const unread = buildRevenueGenerated({ deals: null, spentUsd: 10, spendByDay: null, expectedRoiMultiple: null, offerRunning: null, today: "2026-11-07" });
    expect(unread.realUsd).toBeNull();
    expect(unread.realUnavailableReason).toBe("closed_deals_not_read");
    expect(unread.expectedUnavailableReason).toBe("expected_return_unavailable");
    expect(unread.points.every((p) => p.expectedCumulativeUsd === null && p.realCumulativeUsd === null)).toBe(true);
    const idle = buildRevenueGenerated({ deals: [], spentUsd: 0, spendByDay: new Map(), expectedRoiMultiple: 2, offerRunning: true, today: "2026-11-07" });
    expect(idle.expectedUnavailableReason).toBe("nothing_spent_yet");
    expect(idle.firstDay).toBeNull();
    expect(idle.points).toEqual([]);
    const status = buildRevenueGenerated({ deals: [], spentUsd: 10, spendByDay: new Map([["2026-11-07", 10]]), expectedRoiMultiple: 2, offerRunning: null, today: "2026-11-07" });
    expect(status.expectedFlatReason).toBe("offer_status_unreadable");
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
