import { describe, expect, it } from "vitest";
import { offerMixOfStep, type OfferStepInput } from "./brand-offer-mix.js";

const offer = (o: Partial<OfferStepInput> & { offerId: string }): OfferStepInput => ({
  costFromStartUsd: null,
  valuePerOutcomeUsd: null,
  figuresUnavailableReason: null,
  targetCampaignIds: [],
  targetSpendByDay: new Map(),
  targetUnitsByDay: [],
  targetUnitsUnavailableReason: null,
  makingSpendUsd: 0,
  ...o,
});

describe("offerMixOfStep (BRAND-VALUE-ROI-1108: value traced per offer, never a stated share)", () => {
  it("two offers targeting Paid client: measured = traced value / spend; expected = flexible budget at the spend mix", () => {
    const a = offer({
      offerId: "a",
      costFromStartUsd: 100,
      valuePerOutcomeUsd: 1000,
      targetCampaignIds: ["fa"],
      targetSpendByDay: new Map([["2026-09-10", 200], ["2026-10-05", 100]]),
      targetUnitsByDay: [{ date: "2026-10-06", ourUnits: 1 }],
    });
    const b = offer({
      offerId: "b",
      costFromStartUsd: 50,
      valuePerOutcomeUsd: 100,
      targetCampaignIds: ["fb"],
      targetSpendByDay: new Map([["2026-10-01", 100]]),
      targetUnitsByDay: [{ date: "2026-09-20", ourUnits: 2 }],
    });
    const m = offerMixOfStep([a, b], ["2026-09", "2026-10"], "2026-10-27");
    expect(m.weightBasis).toBe("target_campaign_spend");
    // Measured: (1 x 1000 + 2 x 100) / (300 + 100) = 3.
    expect(m.measuredReturn).toMatchObject({ roiMultiple: 3, targetUnits: 3, valueUsd: 1200, spentUsd: 400, learning: true, unavailableReason: null });
    // Month by month (cumulative): Sept = 2 x 100 / 200 = 1; Oct = the headline.
    expect(m.measuredReturn.months).toEqual([
      { month: "2026-09", spentUsd: 200, targetUnits: 2, valueUsd: 200, roiMultiple: 1 },
      { month: "2026-10", spentUsd: 400, targetUnits: 3, valueUsd: 1200, roiMultiple: 3 },
    ]);
    // Expected units: 300/100 = 3 (a), 100/50 = 2 (b). Cost = 400/5 = 80; value = (3x1000 + 2x100)/5 = 640; return = 3200/400 = 8.
    expect(m.expectedCostPerOutcomeUsd).toBe(80);
    expect(m.valuePerOutcomeUsd).toBe(640);
    expect(m.expectedReturn).toEqual({ roiMultiple: 8, unavailableReason: null });
    expect(m.offers.map((o) => [o.offerId, o.weightShare, o.expectedReturn.roiMultiple, o.measuredReturn.roiMultiple])).toEqual([
      ["a", 0.75, 10, 3.33],
      ["b", 0.25, 2, 2],
    ]);
  });

  it("one offer = its own figures, even before any spend", () => {
    const m = offerMixOfStep([offer({ offerId: "a", costFromStartUsd: 40, valuePerOutcomeUsd: 200, targetCampaignIds: ["f"] })], ["2026-10"], "2026-10-27");
    expect(m.weightBasis).toBe("single_offer");
    expect(m.expectedCostPerOutcomeUsd).toBe(40);
    expect(m.valuePerOutcomeUsd).toBe(200);
    expect(m.expectedReturn.roiMultiple).toBe(5);
    expect(m.measuredReturn).toMatchObject({ roiMultiple: null, unavailableReason: "nothing_spent_yet" });
  });

  it("below a Target: no return (ROI-CONSISTENCY-1103), value and cost weighted by the spend making it", () => {
    const m = offerMixOfStep(
      [offer({ offerId: "a", costFromStartUsd: 10, valuePerOutcomeUsd: 30, makingSpendUsd: 100 }), offer({ offerId: "b", costFromStartUsd: 20, valuePerOutcomeUsd: 100, makingSpendUsd: 0 })],
      ["2026-10"],
      "2026-10-27",
    );
    expect(m.weightBasis).toBe("making_campaign_spend");
    expect(m.isCampaignTarget).toBe(false);
    expect(m.expectedReturn).toEqual({ roiMultiple: null, unavailableReason: "outcome_is_no_campaign_target" });
    expect(m.measuredReturn).toMatchObject({ roiMultiple: null, unavailableReason: "outcome_is_no_campaign_target", months: [] });
    // Offer b spent nothing making it: offer a's figures alone.
    expect(m.valuePerOutcomeUsd).toBe(30);
    expect(m.expectedCostPerOutcomeUsd).toBe(10);
  });

  it("several offers, nothing spent yet: no blend (no mix to weight), each offer's own figures served", () => {
    const m = offerMixOfStep([offer({ offerId: "a", costFromStartUsd: 10, valuePerOutcomeUsd: 30 }), offer({ offerId: "b", costFromStartUsd: 20, valuePerOutcomeUsd: 50 })], [], "2026-10-27");
    expect(m.valuePerOutcomeUsd).toBeNull();
    expect(m.valueUnavailableReason).toBe("no_spend_yet");
    expect(m.offers.map((o) => o.valuePerOutcomeUsd)).toEqual([30, 50]);
  });

  it("a Target Unit of an offer with no value nulls the traced value (never valued at another offer's)", () => {
    const m = offerMixOfStep(
      [
        offer({ offerId: "a", costFromStartUsd: 10, valuePerOutcomeUsd: 30, targetCampaignIds: ["fa"], targetSpendByDay: new Map([["2026-10-01", 10]]), targetUnitsByDay: [{ date: "2026-10-02", ourUnits: 1 }] }),
        offer({ offerId: "b", figuresUnavailableReason: "no_priced_sales_path", targetCampaignIds: ["fb"], targetSpendByDay: new Map([["2026-10-01", 10]]), targetUnitsByDay: [{ date: "2026-10-02", ourUnits: 1 }] }),
      ],
      ["2026-10"],
      "2026-10-27",
    );
    expect(m.measuredReturn).toMatchObject({ roiMultiple: null, valueUsd: null, unavailableReason: "target_has_no_value" });
    expect(m.expectedReturn).toEqual({ roiMultiple: null, unavailableReason: "no_priced_sales_path" });
  });
});
