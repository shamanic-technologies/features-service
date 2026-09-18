/**
 * A PAIR EITHER REPORTS WHAT IT MEASURED OR SAYS IT CANNOT — never a figure it did not measure, and
 * never an empty value a consumer would have to interpret.
 *
 * These cases drive one fixture through both halves: the three ways a pair can be unmeasurable (each
 * naming the ingredient we are missing), and the pricing itself, where the load-bearing property is
 * that a funnel is priced through its OWN channel and that a step whose rate nobody declared says so
 * rather than reading as free.
 */
import { describe, it, expect } from "vitest";

import { pricePair, funnelEntryChannel, FUNNEL_MILESTONE_STEP, type PricePairInput } from "./channel-funnel-economics.js";
import type { ProjectionEconomics } from "./funnel-registry.js";

const ECON: ProjectionEconomics = {
  r2m: 0.5, // half of the conversations become a booked meeting
  v2m: 0.1, // a tenth of the visits do
  m2c: 0.4, // booked meeting → paid client (the show-up rate is already composed in)
  v2c: 0.02,
  v2s: 0.25, // a quarter of the visits sign up
  s2pc: 0.2, // a fifth of the signups pay
  v2fs: 0.2, // a fifth of the visits fill the form
  fs2pc: 0.1,
  v2pc: 0.01,
  r2pc: 0.05,
};

const EVIDENCE = { totalSpentUsd: 1000, conversationsProduced: 100, websiteVisitsProduced: 500, brandCount: 3 };

// $1000 over 500 visits = $2 a visit; over 100 conversations = $10 a conversation.
const UNIT_COSTS = { clickUsd: 2, replyUsd: 10 };

const input = (over: Partial<PricePairInput> = {}): PricePairInput => ({
  funnelKey: "sales_meetings_from_conversation",
  unitCosts: UNIT_COSTS,
  economics: ECON,
  lifetimeRevenueUsd: 5000,
  evidence: EVIDENCE,
  ...over,
});

describe("not enough data is an answer, and it names the missing ingredient", () => {
  it("nothing spent yet → no_spend_recorded", () => {
    const result = pricePair(input({ evidence: { ...EVIDENCE, totalSpentUsd: 0 } }));
    expect(result).toEqual({ measured: false, reason: "no_spend_recorded" });
  });

  it("spent, but the funnel's own entry step was never produced → no_entry_step_produced", () => {
    // A channel that has only ever produced website visits cannot price the conversation funnel, even
    // though it has plenty of spend and plenty of the OTHER step.
    const result = pricePair(input({ unitCosts: { clickUsd: 2, replyUsd: null } }));
    expect(result).toEqual({ measured: false, reason: "no_entry_step_produced" });

    // ...and the reverse, for a click-driven funnel on a conversation-only channel.
    const website = pricePair(
      input({ funnelKey: "sales_meetings_from_website", unitCosts: { clickUsd: null, replyUsd: 10 } }),
    );
    expect(website).toEqual({ measured: false, reason: "no_entry_step_produced" });
  });

  it("a LEG channel nobody has run yet says the plain thing, on every funnel its leg belongs to", () => {
    // A channel that picks a lead up MID-funnel (booking the meeting, closing it) is sellable through
    // every funnel containing that leg, so it has pairs from the day it is published — and until
    // somebody runs one, each of those pairs has nothing to divide. `no_spend_recorded` is the honest
    // answer, and it is the one the per-pair read gives: the customer will declare what each of these
    // transitions cost them per lead, so spend arrives later rather than never.
    for (const funnelKey of ["sales_meetings_from_conversation", "sales_meetings_from_website"] as const) {
      const result = pricePair(
        input({
          funnelKey,
          evidence: { totalSpentUsd: 0, conversationsProduced: 0, websiteVisitsProduced: 0, brandCount: 0 },
          unitCosts: { clickUsd: null, replyUsd: null },
        }),
      );
      expect(result, funnelKey).toEqual({ measured: false, reason: "no_spend_recorded" });
    }
  });

  it("no brand declared the funnel's rates → no_economics_declared", () => {
    expect(pricePair(input({ economics: null }))).toEqual({ measured: false, reason: "no_economics_declared" });
  });

  it("checks them in the order a buyer asks them — spend first, so a fresh channel says the plain thing", () => {
    const fresh = pricePair(
      input({
        evidence: { totalSpentUsd: 0, conversationsProduced: 0, websiteVisitsProduced: 0, brandCount: 0 },
        unitCosts: { clickUsd: null, replyUsd: null },
        economics: null,
        lifetimeRevenueUsd: null,
      }),
    );
    expect(fresh).toEqual({ measured: false, reason: "no_spend_recorded" });
  });
});

describe("a measured pair prices every step of its own funnel", () => {
  it("the conversation funnel prices on REPLIES, and the click channel cannot dilute it", () => {
    const result = pricePair(input());
    expect(result.measured).toBe(true);
    if (!result.measured) throw new Error("unreachable");

    const { steps, costPerSaleUsd, returnPerDollar } = result.economics;
    expect(steps.map((s) => s.step)).toEqual(["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]);

    // A conversation costs what the channel paid for one: $10.
    expect(steps[0].costPerStepUsd).toBeCloseTo(10, 10);
    // A booked meeting costs replyUsd / r2m = 10 / 0.5 = $20. Priced through the REPLY channel alone:
    // blending the $2 clicks in would have made it look far cheaper than this funnel can actually buy.
    expect(steps[1].costPerStepUsd).toBeCloseTo(20, 10);
    // A paid client costs replyUsd / (r2m x m2c) = 10 / 0.2 = $50.
    expect(steps[3].costPerStepUsd).toBeCloseTo(50, 10);
    expect(costPerSaleUsd).toBeCloseTo(50, 10);
    // Return = lifetime revenue / cost per sale = 5000 / 50.
    expect(returnPerDollar).toBeCloseTo(100, 10);
  });

  it("says out loud that a meeting ATTENDED has no price of its own, rather than reading as free", () => {
    const result = pricePair(input());
    if (!result.measured) throw new Error("unreachable");
    const attended = result.economics.steps[2];
    expect(attended.step).toBe("Meeting attended");
    expect(attended.costPerStepUsd).toBeNull();
    expect(attended.unpricedReason).toBe("rate_not_declared");
    // A priced step never carries a reason, and an unpriced one never carries a figure.
    for (const step of result.economics.steps) {
      expect(step.costPerStepUsd == null, step.step).toBe(step.unpricedReason != null);
    }
  });

  it("the website meeting funnel prices on CLICKS — same evidence, a different number", () => {
    const result = pricePair(input({ funnelKey: "sales_meetings_from_website" }));
    if (!result.measured) throw new Error("unreachable");
    const { steps, costPerSaleUsd } = result.economics;
    expect(steps[0].costPerStepUsd).toBeCloseTo(2, 10); // a website visit
    expect(steps[1].costPerStepUsd).toBeCloseTo(20, 10); // clickUsd / v2m = 2 / 0.1
    expect(costPerSaleUsd).toBeCloseTo(50, 10); // / m2c = 20 / 0.4

    // The whole reason the two funnels are priced apart: they buy the same milestone through different
    // channels, so the same evidence gives each its own cost per conversation-bought vs click-bought
    // step, and neither is benchmarked against a step it never buys.
    const conversation = pricePair(input());
    if (!conversation.measured) throw new Error("unreachable");
    expect(conversation.economics.steps[0].costPerStepUsd).not.toBeCloseTo(steps[0].costPerStepUsd!, 5);
  });

  it("the purchase funnel prices visit → signup → paid", () => {
    const result = pricePair(input({ funnelKey: "website_purchases" }));
    if (!result.measured) throw new Error("unreachable");
    const { steps, costPerSaleUsd } = result.economics;
    expect(steps.map((s) => s.step)).toEqual(["Website visit", "Signup", "Paid client"]);
    expect(steps[0].costPerStepUsd).toBeCloseTo(2, 10);
    expect(steps[1].costPerStepUsd).toBeCloseTo(8, 10); // clickUsd / v2s = 2 / 0.25
    expect(costPerSaleUsd).toBeCloseTo(40, 10); // / s2pc = 8 / 0.2
  });

  it("the form funnel prices visit → form filled → paid", () => {
    const result = pricePair(input({ funnelKey: "form_magnet" }));
    if (!result.measured) throw new Error("unreachable");
    const { steps, costPerSaleUsd } = result.economics;
    expect(steps.map((s) => s.step)).toEqual(["Website visit", "Form submitted", "Paid client"]);
    expect(steps[1].costPerStepUsd).toBeCloseTo(10, 10); // clickUsd / v2fs = 2 / 0.2
    expect(costPerSaleUsd).toBeCloseTo(100, 10); // / fs2pc = 10 / 0.1
  });

  it("a SALE costs at least as much as the milestone that leads to it, on every funnel", () => {
    for (const funnelKey of ["sales_meetings_from_conversation", "sales_meetings_from_website", "website_purchases", "form_magnet"] as const) {
      const result = pricePair(input({ funnelKey }));
      if (!result.measured) throw new Error("unreachable");
      const milestone = result.economics.steps.find((s) => s.milestone);
      expect(milestone, funnelKey).toBeDefined();
      expect(milestone!.step, funnelKey).toBe(FUNNEL_MILESTONE_STEP[funnelKey]);
      expect(result.economics.costPerSaleUsd!, funnelKey).toBeGreaterThanOrEqual(milestone!.costPerStepUsd!);
    }
  });

  it("no lifetime revenue leaves the RETURN null, never 0 — the step prices still stand", () => {
    const result = pricePair(input({ lifetimeRevenueUsd: null }));
    if (!result.measured) throw new Error("unreachable");
    expect(result.economics.returnPerDollar).toBeNull();
    expect(result.economics.lifetimeRevenueUsd).toBeNull();
    expect(result.economics.costPerSaleUsd).toBeCloseTo(50, 10);
  });

  it("a rate declared at 0 leaves the steps it gates unpriced, never a false $0", () => {
    const result = pricePair(input({ economics: { ...ECON, m2c: 0 } }));
    if (!result.measured) throw new Error("unreachable");
    // The meeting is still bought; the paid client behind a 0% close rate is not.
    expect(result.economics.steps[1].costPerStepUsd).toBeCloseTo(20, 10);
    expect(result.economics.costPerSaleUsd).toBeNull();
    expect(result.economics.costPerSaleUnpricedReason).toBe("rate_is_zero");
    expect(result.economics.returnPerDollar).toBeNull();
  });

  it("carries the evidence it stands on, so a row can say how much that is", () => {
    const result = pricePair(input());
    if (!result.measured) throw new Error("unreachable");
    expect(result.economics.evidence).toEqual(EVIDENCE);
  });
});

describe("which channel a funnel is bought through", () => {
  it("a funnel entered by a positive reply buys with a reply; one entered by a visit, with a click", () => {
    for (const key of ["sales_meetings_from_conversation", "sales_from_conversation"] as const) {
      expect(funnelEntryChannel(key), key).toBe("reply");
    }
    for (const key of ["sales_meetings_from_website", "website_purchases", "form_magnet", "sales_from_website"] as const) {
      expect(funnelEntryChannel(key), key).toBe("click");
    }
  });

  it("an AD funnel buys with NEITHER — its first step is delivered, not observed", () => {
    for (const key of ["sales_meetings_from_ads", "lead_forms_from_ads"] as const) {
      expect(funnelEntryChannel(key), key).toBeNull();
    }
  });
});

describe("the funnels brand-service added when the ad channels opened", () => {
  it("an AD funnel is UNMEASURED with its own named reason, not priced off click or reply evidence", () => {
    // Its first step is DELIVERED by the advertising platform, so the two signals this fleet counts say
    // nothing about it. A figure here would be the price of a click or a reply under an ad's name.
    for (const key of ["sales_meetings_from_ads", "lead_forms_from_ads"] as const) {
      expect(pricePair(input({ funnelKey: key })), key).toEqual({
        measured: false,
        reason: "entry_step_not_measured",
      });
    }
    // DISTINCT from `no_entry_step_produced`, which says the channel never made the step — these
    // channels may well be making it; we have no unit cost for it. Same fixture, both answers.
    expect(pricePair(input({ unitCosts: { clickUsd: 2, replyUsd: null } }))).toEqual({
      measured: false,
      reason: "no_entry_step_produced",
    });
  });

  it("a DIRECT funnel prices its sale on the brand's own DIRECT rate, never through a meeting", () => {
    // Website visit → PURCHASE → paid client: $2 a visit at a 1% direct close = $200. The meeting
    // route (v2m 10% × m2c 40% = 4%) would have read $50 — four times cheaper, through a step this
    // funnel does not contain. `visitToClosePct` SPANS the purchase rung, exactly as
    // `meetingToClosePct` spans the show-up rung, so the sale's price did not move when the rung was
    // inserted — asserted to the cent against the two-step era's own figure.
    const web = pricePair(input({ funnelKey: "sales_from_website" }));
    if (!web.measured) throw new Error("unreachable");
    expect(web.economics.steps.map((x) => x.step)).toEqual(["Website visit", "Direct purchase", "Paid client"]);
    expect(web.economics.steps[0].costPerStepUsd).toBe(2);
    expect(web.economics.costPerSaleUsd).toBeCloseTo(200, 6);
    expect(web.economics.costPerSaleUsd).not.toBeCloseTo(50, 6);
    expect(web.economics.returnPerDollar).toBeCloseTo(5000 / 200, 6);

    // Positive reply → paid client: $10 a conversation at a 5% direct close = $200. The meeting route
    // (r2m 50% × m2c 40% = 20%) would have read $50.
    const reply = pricePair(input({ funnelKey: "sales_from_conversation" }));
    if (!reply.measured) throw new Error("unreachable");
    expect(reply.economics.steps.map((x) => x.step)).toEqual(["Positive reply", "Paid client"]);
    expect(reply.economics.steps[0].costPerStepUsd).toBe(10);
    expect(reply.economics.costPerSaleUsd).toBeCloseTo(200, 6);
    expect(reply.economics.costPerSaleUsd).not.toBeCloseTo(50, 6);
  });

  it("the PURCHASE rung carries no price and says why — never the sale's price under the middle rung", () => {
    // The whole hazard of inserting a rung into a funnel priced BY INDEX: the terminal's figure slides
    // up one and prints under the step before it, which is what the two-step branch did to this funnel
    // before it got a case of its own. Asserted as a DIVERGENCE — the middle rung is null while the
    // SALE carries the $200 — so a suite that only checked "three steps came back" would pass on it.
    const web = pricePair(input({ funnelKey: "sales_from_website" }));
    if (!web.measured) throw new Error("unreachable");
    const [visit, purchase, sale] = web.economics.steps;
    expect(purchase.step).toBe("Direct purchase");
    expect(purchase.costPerStepUsd).toBeNull();
    expect(purchase.unpricedReason).toBe("rate_not_declared");
    expect(sale.step).toBe("Paid client");
    expect(sale.costPerStepUsd).toBeCloseTo(200, 6);
    // ...and it is not the entry price either: a checkout does not cost what a click costs.
    expect(purchase.costPerStepUsd).not.toBe(visit.costPerStepUsd);
  });

  it("a funnel names the step it is NAMED after — Website Purchase names the purchase", () => {
    // It named the SALE while the purchase was folded inside it; it has a stage before the sale now,
    // and that stage is the one the funnel is literally called after.
    expect(FUNNEL_MILESTONE_STEP.sales_from_website).toBe("Direct purchase");
    // The funnel whose ONLY stage genuinely is the sale still names the sale.
    expect(FUNNEL_MILESTONE_STEP.sales_from_conversation).toBe("Paid client");
    const web = pricePair(input({ funnelKey: "sales_from_website" }));
    if (!web.measured) throw new Error("unreachable");
    expect(web.economics.steps.map((x) => x.milestone)).toEqual([false, true, false]);
    const reply = pricePair(input({ funnelKey: "sales_from_conversation" }));
    if (!reply.measured) throw new Error("unreachable");
    expect(reply.economics.steps.map((x) => x.milestone)).toEqual([false, true]);
  });

  it("the FOUR ORIGINAL funnels price exactly as they did — the widening only ADDED", () => {
    // Pinned to the cent against the numbers this fixture produced before the catalogue widened, so a
    // change to the shared pricing path cannot move a live brand's figures unnoticed.
    const expected: Array<[string, number]> = [
      ["sales_meetings_from_conversation", 50],
      ["sales_meetings_from_website", 50],
      ["website_purchases", 40],
      ["form_magnet", 100],
    ];
    for (const [key, costPerSaleUsd] of expected) {
      const result = pricePair(input({ funnelKey: key as never }));
      if (!result.measured) throw new Error(`${key} unexpectedly unmeasured`);
      expect(result.economics.costPerSaleUsd, key).toBeCloseTo(costPerSaleUsd, 6);
      expect(result.economics.returnPerDollar, key).toBeCloseTo(5000 / costPerSaleUsd, 6);
      expect(result.economics.steps[0].costPerStepUsd, key).toBe(key === "sales_meetings_from_conversation" ? 10 : 2);
    }
  });
});
