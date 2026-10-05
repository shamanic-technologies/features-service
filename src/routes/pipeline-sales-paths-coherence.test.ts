/**
 * The Today pipeline and the Sales funnel page price ONE offer on ONE set of rates and ONE set of paths
 * (owner 2026-10-04). Legistai in prod: the pipeline priced a reply on brand-service's cross-brand AVERAGE
 * (22.35% reply → paid) and a click at 3.83%, while `/offers/:id/sales-paths` walked the same offer on the
 * effective leg rates (5.06% and ≤ 0.13%): 4.33x on Today against ≤ 2.8x on Sales funnel.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { priceOnDeclaredFunnel } = await import("./revenue.js");
const { buildPricingFunnels } = await import("../lib/reading-funnels.js");
const { getFunnel, orP } = await import("../lib/funnel-registry.js");
import type { SalesFunnelKey } from "../lib/sales-funnels.js";

// The effective leg rates `/offers/:id/sales-paths` served for Legistai (fleet medians + defaults).
const EFFECTIVE: Record<string, number> = {
  "Positive reply>Meeting booked": 30,
  "Meeting booked>Meeting attended": 67.5,
  "Meeting attended>Paid client": 25,
  "Website visit>Meeting booked": 0.5,
  "Website visit>Signup": 0.5,
  "Signup>Paid client": 10,
};
const LTR = 2100;

// brand-service's cross-brand average lifetime revenue — a number the pipeline can no longer read at
// all (owner 2026-10-05: the brand-wide record is no pricing input; there is no argument to pass it).
const CROSS_BRAND_AVERAGE_LTR = 9999;

const declaredOn = (keys: SalesFunnelKey[]) =>
  buildPricingFunnels({
    funnelKeys: keys,
    lifetimeRevenueUsd: LTR,
    rateOf: (from, to) => {
      const rate = EFFECTIVE[`${from}>${to}`];
      return rate === undefined ? { ratePct: null, provenance: "unstated" } : { ratePct: rate, provenance: "stated_median" };
    },
  });

const rungs = (keys: SalesFunnelKey[]) => {
  const priced = priceOnDeclaredFunnel(declaredOn(keys));
  const paths = getFunnel("sales-cold-email-outreach")!.resolvePaths({
    economics: priced.economics.economics!,
    pricedFunnelKeys: priced.pricedFunnelKeys,
  });
  return Object.fromEntries(paths.map((p) => [p.signal, p.expectedRevenueUsd / LTR]));
};

// The Sales funnel page's chains, leg by leg.
const replyToPaid = 0.3 * 0.675 * 0.25; // 5.06%
const visitViaMeeting = 0.005 * 0.675 * 0.25;
const visitViaSignup = 0.005 * 0.1;

describe("one offer, one set of rates: the pipeline prices each rung on the Sales funnel page's chains", () => {
  it("Legistai's three ticked paths: a reply is worth 5.06%, a click the two website chains combined", () => {
    const p = rungs(["sales_meetings_from_conversation", "sales_meetings_from_website", "website_purchases"]);
    expect(p.positiveReply).toBeCloseTo(replyToPaid, 12);
    expect(p.clicked).toBeCloseTo(orP(visitViaSignup, visitViaMeeting), 12);
    expect(p.meeting).toBeCloseTo(0.675 * 0.25, 12);
    expect(p.meetingAttended).toBeCloseTo(0.25, 12);
  });

  it("the offer's lifetime revenue prices the rungs, never the brand-wide record's", () => {
    const priced = priceOnDeclaredFunnel(declaredOn(["sales_meetings_from_conversation"]));
    expect(priced.economics.economics!.lifetimeRevenueUsd).toBe(LTR);
    expect(priced.economics.economics!.lifetimeRevenueUsd).not.toBe(CROSS_BRAND_AVERAGE_LTR);
  });

  it("a website route the offer does not walk adds nothing to a click (no brand-wide average leaks in)", () => {
    expect(rungs(["sales_meetings_from_website"]).clicked).toBeCloseTo(visitViaMeeting, 12);
    expect(rungs(["website_purchases"]).clicked).toBeCloseTo(visitViaSignup, 12);
    // A reply-only offer: a click is worth nothing at all.
    expect(rungs(["sales_meetings_from_conversation"]).clicked ?? 0).toBe(0);
  });

  it("no priced funnel → null economics with its reason, never the brand-wide record (the degraded read)", () => {
    const priced = priceOnDeclaredFunnel([]);
    expect(priced.economics).toEqual({ economics: null, unpricedReason: "no_priced_funnel" });
    expect(priced.pricedFunnelKeys).toEqual([]);
  });
});
