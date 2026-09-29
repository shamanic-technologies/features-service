import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { funnelStepKeys } from "./acquisition-channels.js";
import { DEFAULT_LEG_RATE_PCT, defaultLegRatePct } from "./default-leg-rates.js";
import { buildBrandEffectiveRates } from "./effective-conversion-rates.js";
import { FUNNEL_LEG_KEYS, funnelLeg } from "./funnel-legs.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

const NOTHING_MEASURED = {
  contactedRecipients: 0,
  evidence: {},
  reachedCounts: {},
} as never;

describe("every leg always has a conversion rate", () => {
  it("seeds a default in (0, 100] for every arrow of every catalogue funnel", () => {
    for (const funnelKey of SALES_FUNNEL_KEYS) {
      const steps = funnelStepKeys(funnelKey);
      for (let i = 0; i + 1 < steps.length; i++) {
        const rate = defaultLegRatePct(steps[i]!, steps[i + 1]!);
        expect(rate, `${funnelKey}: ${steps[i]} -> ${steps[i + 1]}`).not.toBeNull();
        expect(rate!).toBeGreaterThan(0);
        expect(rate!).toBeLessThanOrEqual(100);
      }
    }
  });

  it("seeds a default for every non-entry leg of the published leg catalogue", () => {
    for (const legKey of FUNNEL_LEG_KEYS) {
      const leg = funnelLeg(legKey)!;
      if (leg.fromStep == null) continue;
      expect(defaultLegRatePct(leg.fromStep.key, leg.toStep.key), legKey).not.toBeNull();
    }
    expect(Object.keys(DEFAULT_LEG_RATE_PCT)).toContain("conversation>booking_call");
    expect(Object.keys(DEFAULT_LEG_RATE_PCT)).toContain("booking_call>meeting_booked");
  });

  it("a brand that stated nothing, measured nothing and has no fleet median reads a default on EVERY leg, labelled as one", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: SALES_FUNNEL_KEYS,
      measurement: NOTHING_MEASURED,
      manual: [],
      medians: new Map(),
    });
    expect(rates.legs.length).toBeGreaterThan(0);
    for (const leg of rates.legs) {
      expect(leg.effectiveRatePct, `${leg.fromStep} -> ${leg.toStep}`).not.toBeNull();
      expect(leg.source).toBe("default");
      expect(leg.unresolvedReason).toBeNull();
      expect(leg.defaultRatePct).toBe(leg.effectiveRatePct);
    }
    const call = rates.legs.find((l) => l.fromStep === "Positive reply" && l.toStep === "Booking call");
    expect(call?.effectiveRatePct).toBe(60);
  });

  it("a stated rate still beats the default, and the median beats it too", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: SALES_FUNNEL_KEYS,
      measurement: NOTHING_MEASURED,
      manual: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 55, stated: true } as never],
      medians: new Map([["meeting_booked>meeting_attended", { ratePct: 66, brandCount: 3 }]]),
    });
    const booked = rates.legs.find((l) => l.fromStep === "Positive reply" && l.toStep === "Meeting booked")!;
    expect(booked).toMatchObject({ effectiveRatePct: 55, source: "manual", defaultRatePct: 30 });
    const showUp = rates.legs.find((l) => l.fromStep === "Meeting booked" && l.toStep === "Meeting attended")!;
    expect(showUp).toMatchObject({ effectiveRatePct: 66, source: "median", defaultRatePct: 75 });
  });
});
