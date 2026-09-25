import { describe, it, expect } from "vitest";

import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { brandStatedEconomics, collapseStated, median, medianFleetEconomics } from "./stated-economics.js";

const conversation = (rates: Record<string, number | null>, ltr: number | null): DeclaredSalesFunnel => ({
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Positive Reply",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates,
  lifetimeRevenueUsd: ltr,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-25T00:00:00Z",
});

describe("median", () => {
  it("is the middle value, never the mean — one brand far from the rest does not carry it", () => {
    // Mean of [10, 20, 30, 1000] is 265; the median is 25.
    expect(median([1000, 10, 30, 20])).toBe(25);
    expect(median([3, 1, 2])).toBe(2);
  });
  it("is null over nothing", () => {
    expect(median([])).toBeNull();
  });
});

describe("medianFleetEconomics — the population is what brands STATED", () => {
  it("takes the median per rate over the brands that stated it, and ignores brands that did not", () => {
    const fleet = medianFleetEconomics([
      { replyToMeetingPct: 10 },
      { replyToMeetingPct: 20 },
      { replyToMeetingPct: 90 },
      // States nothing about replies — contributes no data point to that rate (never a 0).
      { visitToSignupPct: 4 },
    ]);
    expect(fleet.economics!.r2m).toBeCloseTo(0.2, 9); // median of 10/20/90, not their mean 0.4
    expect(fleet.economics!.v2s).toBeCloseTo(0.04, 9);
    expect(fleet.brandCount).toBe(4);
  });

  it("a rate no brand stated stays undefined (optional) — no default stands in", () => {
    const fleet = medianFleetEconomics([{ replyToMeetingPct: 30 }]);
    expect(fleet.economics!.r2pc).toBeUndefined();
    expect(fleet.economics!.v2fs).toBeUndefined();
  });

  it("the median lifetime revenue is over stated positive values only", () => {
    const fleet = medianFleetEconomics([
      { lifetimeRevenueUsd: 100, replyToMeetingPct: 30 },
      { lifetimeRevenueUsd: 5000 },
      { lifetimeRevenueUsd: 200 },
    ]);
    expect(fleet.lifetimeRevenueUsd).toBe(200);
  });

  it("nothing stated anywhere → no economics and no revenue, never a fabricated vector", () => {
    const fleet = medianFleetEconomics([{}, {}]);
    expect(fleet.economics).toBeNull();
    expect(fleet.lifetimeRevenueUsd).toBeNull();
    expect(fleet.brandCount).toBe(0);
  });
});

describe("brandStatedEconomics", () => {
  it("drops every undeclared rate — a null on the funnel never becomes a data point", () => {
    const stated = brandStatedEconomics([conversation({ replyToMeetingPct: 30, meetingToClosePct: null }, null)]);
    expect(stated.byFunnel.sales_meetings_from_conversation).toEqual({ replyToMeetingPct: 30 });
    expect(stated.overall).toEqual({ replyToMeetingPct: 30 });
  });

  it("a several-offer brand is ONE data point: the median of its offers' statements", () => {
    const stated = brandStatedEconomics([
      conversation({ replyToMeetingPct: 10 }, 100),
      conversation({ replyToMeetingPct: 30 }, 300),
      conversation({ replyToMeetingPct: 50 }, 900),
    ]);
    expect(stated.overall.replyToMeetingPct).toBe(30);
    expect(stated.overall.lifetimeRevenueUsd).toBe(300);
  });

  it("derives the direct self-serve close only from two halves the brand stated", () => {
    const stated = brandStatedEconomics([
      {
        ...conversation({}, null),
        funnelKey: "website_purchases",
        steps: ["Website visit", "Signup", "Paid client"],
        rates: { visitToSignupPct: 10, signupToPaidClientPct: 20 },
      },
    ]);
    expect(stated.overall.visitToClosePct).toBeCloseTo(2, 9);
  });

  it("collapseStated keeps a field only where something was stated", () => {
    expect(collapseStated([{ replyToMeetingPct: 10 }, {}])).toEqual({ replyToMeetingPct: 10 });
  });
});
