import { describe, expect, it } from "vitest";
import {
  FUNNEL_MINIMUM_COMMITMENT_DAYS,
  composeMinimumCommitment,
  minimumCommitmentDaysFor,
} from "./funnel-commercial-terms.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("per-funnel minimum run length", () => {
  it("carries ONE entry per declared funnel — a missing key is a corrupt map, never a default", () => {
    expect(Object.keys(FUNNEL_MINIMUM_COMMITMENT_DAYS).sort()).toEqual([...SALES_FUNNEL_KEYS].sort());
  });

  it("every value is either null (adds nothing) or a whole number of days > 0", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const value = FUNNEL_MINIMUM_COMMITMENT_DAYS[key];
      expect(value === null || (Number.isInteger(value) && value > 0), key).toBe(true);
    }
  });

  it("NO funnel exceeds the channel it is sold through today, so every entry is null", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(minimumCommitmentDaysFor(key), key).toBeNull();
    }
  });
});

describe("composing the pair's answer", () => {
  it("the CHANNEL governs when the funnel adds nothing", () => {
    expect(composeMinimumCommitment(30, null)).toEqual({
      funnelMinimumCommitmentDays: null,
      effectiveMinimumCommitmentDays: 30,
      governedBy: "channel",
    });
  });

  it("the FUNNEL governs only when it states strictly MORE than its channel", () => {
    expect(composeMinimumCommitment(30, 60)).toEqual({
      funnelMinimumCommitmentDays: 60,
      effectiveMinimumCommitmentDays: 60,
      governedBy: "funnel",
    });
  });

  it("a funnel BELOW its channel changes nothing — the channel already covers it", () => {
    expect(composeMinimumCommitment(90, 60)).toEqual({
      funnelMinimumCommitmentDays: 60,
      effectiveMinimumCommitmentDays: 90,
      governedBy: "channel",
    });
  });

  it("a TIE reads as the channel — a funnel restating its channel adds nothing", () => {
    expect(composeMinimumCommitment(30, 30)).toEqual({
      funnelMinimumCommitmentDays: 30,
      effectiveMinimumCommitmentDays: 30,
      governedBy: "channel",
    });
  });

  it("the effective figure is a property of the PAIR — one funnel, two channels, two answers", () => {
    const onShortChannel = composeMinimumCommitment(30, null);
    const onSeo = composeMinimumCommitment(90, null);
    expect(onShortChannel.effectiveMinimumCommitmentDays).toBe(30);
    expect(onSeo.effectiveMinimumCommitmentDays).toBe(90);
    // Same funnel value on both sides — only the channel moved.
    expect(onShortChannel.funnelMinimumCommitmentDays).toBe(onSeo.funnelMinimumCommitmentDays);
  });

  it("is NEVER null — a channel always states one, so a pair always has an answer", () => {
    for (const channelDays of [1, 30, 60, 90]) {
      for (const funnelDays of [null, 1, 30, 200]) {
        const composed = composeMinimumCommitment(channelDays, funnelDays);
        expect(typeof composed.effectiveMinimumCommitmentDays).toBe("number");
        expect(composed.effectiveMinimumCommitmentDays).toBeGreaterThanOrEqual(channelDays);
      }
    }
  });
});
