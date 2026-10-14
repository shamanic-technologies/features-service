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

  it("a brand that stated nothing and measured nothing reads a default on EVERY leg, labelled as one", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: SALES_FUNNEL_KEYS,
      measurement: NOTHING_MEASURED,
      manual: [],
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

  it("every leg leaving website_visit, purchase included, defaults to 0.2% (owner-stated 2026-10-14)", () => {
    const visitLegs = Object.keys(DEFAULT_LEG_RATE_PCT).filter((k) => k.startsWith("website_visit>"));
    expect(visitLegs.sort()).toEqual(["website_visit>form_submitted", "website_visit>meeting_booked", "website_visit>purchase", "website_visit>signup"]);
    for (const leg of visitLegs) expect(DEFAULT_LEG_RATE_PCT[leg as keyof typeof DEFAULT_LEG_RATE_PCT]).toBe(0.2);
  });

  it("a stated rate beats the default; an unstated leg reads the default, never another brand's rate", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: SALES_FUNNEL_KEYS,
      measurement: NOTHING_MEASURED,
      manual: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 55, stated: true } as never],
    });
    const booked = rates.legs.find((l) => l.fromStep === "Positive reply" && l.toStep === "Meeting booked")!;
    expect(booked).toMatchObject({ effectiveRatePct: 55, source: "manual", defaultRatePct: 30 });
    const showUp = rates.legs.find((l) => l.fromStep === "Meeting booked" && l.toStep === "Meeting attended")!;
    expect(showUp).toMatchObject({ effectiveRatePct: 75, source: "default", defaultRatePct: 75, median: { ratePct: null, brandCount: 0 } });
  });
});
