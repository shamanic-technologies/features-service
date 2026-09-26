/**
 * Wave C4 — the funnel-keyed public reads re-stated per OUTCOME and per LEG.
 *
 * Every case asserts a RECONCILIATION with the funnel-keyed figure the new one is projected from, on
 * the SAME inputs — a suite that only checked "an outcome row came back" would pass on an
 * implementation that priced outcomes some other way, which is the one thing this must not do.
 */
import { describe, it, expect } from "vitest";
import { pricePair, type PairResult } from "./channel-funnel-economics.js";
import { buildFunnelReturnOnSpend } from "./fleet-funnel-return.js";
import { buildOutcomeReturnOnSpend, channelOutcomeEconomicsOf, showcaseOutcomesOf } from "./outcome-public-reads.js";
import { legKeysOfFunnel } from "./funnel-legs.js";
import type { PublicChannel } from "./channel-catalogue.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import type { ProjectionEconomics } from "./funnel-registry.js";

const ECON: ProjectionEconomics = {
  r2m: 0.5,
  v2m: 0.1,
  m2c: 0.4,
  v2c: 0.02,
  v2s: 0.25,
  s2pc: 0.2,
  v2fs: 0.2,
  fs2pc: 0.1,
  v2pc: 0.01,
  r2pc: 0.05,
};

const EVIDENCE = { totalSpentUsd: 1000, conversationsProduced: 50, websiteVisitsProduced: 200, brandCount: 4 };

const price = (funnelKey: SalesFunnelKey, ltr: number | null = 1000): PairResult =>
  pricePair({ funnelKey, unitCosts: { clickUsd: 5, replyUsd: 30 }, economics: ECON, lifetimeRevenueUsd: ltr, evidence: EVIDENCE });

const channel = (slug: string, legs: Array<[string | null, string]>): PublicChannel =>
  ({
    slug,
    name: slug,
    stepTransitions: legs.map(([from, to]) => ({
      legKey: `${from ?? "start"}_to_${to}`,
      from: from ? { key: from, label: from, description: "" } : null,
      to: { key: to, label: to, description: "" },
    })),
  }) as unknown as PublicChannel;

describe("channelOutcomeEconomicsOf", () => {
  it("a ONE-path channel reads the byte-same prices, return and commitment as its pair row", () => {
    const pair = price("sales_meetings_from_conversation");
    const out = channelOutcomeEconomicsOf(channel("c", [[null, "conversation"]]), [
      { funnelKey: "sales_meetings_from_conversation", effectiveMinimumCommitmentDays: 30, result: pair },
    ]);
    if (!pair.measured) throw new Error("fixture must price");
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0].legKeys).toEqual(legKeysOfFunnel("sales_meetings_from_conversation"));
    expect(out.paths[0].steps.map((s) => s.costPerOutcomeUsd)).toEqual(pair.economics.steps.map((s) => s.costPerStepUsd));
    expect(out.paths[0].costPerPaidClientUsd).toBe(pair.economics.costPerSaleUsd);
    expect(out.returnPerDollar).toBe(pair.economics.returnPerDollar);
    expect(out.effectiveMinimumCommitmentDays).toBe(30);
    // Each outcome IS its rung on the one path.
    expect(out.outcomes.map((o) => [o.step.key, o.costPerOutcomeUsd])).toEqual([
      ["conversation", pair.economics.steps[0].costPerStepUsd],
      ["meeting_booked", pair.economics.steps[1].costPerStepUsd],
      ["meeting_attended", null],
      ["paid_client", pair.economics.costPerSaleUsd],
    ]);
    expect(out.outcomes[2].unpricedReason).toBe("rate_not_declared");
    expect(out.outcomes[0].landedByChannel).toBe(true);
    expect(out.outcomes[1].landedByChannel).toBe(false);
    // No KEY on the per-outcome answer names a funnel (step descriptions are prose and may).
    const keys: string[] = [];
    JSON.stringify(out, (k, v) => (keys.push(k), v));
    expect(keys.filter((k) => /funnel/i.test(k))).toEqual([]);
  });

  it("two paths reaching one outcome: the CHEAPEST answers, both are listed, the best return wins", () => {
    const conv = price("sales_meetings_from_conversation");
    const web = price("sales_meetings_from_website");
    if (!conv.measured || !web.measured) throw new Error("fixture must price");
    const out = channelOutcomeEconomicsOf(channel("c", [[null, "conversation"], [null, "website_visit"]]), [
      { funnelKey: "sales_meetings_from_conversation", effectiveMinimumCommitmentDays: 30, result: conv },
      { funnelKey: "sales_meetings_from_website", effectiveMinimumCommitmentDays: 30, result: web },
    ]);
    const booked = out.outcomes.find((o) => o.step.key === "meeting_booked")!;
    const a = conv.economics.steps[1].costPerStepUsd!;
    const b = web.economics.steps[1].costPerStepUsd!;
    expect(a).not.toBe(b);
    expect(booked.costPerOutcomeUsd).toBe(Math.min(a, b));
    expect(booked.paths.map((p) => p.costPerOutcomeUsd)).toEqual([a, b]);
    expect(out.returnPerDollar).toBe(Math.max(conv.economics.returnPerDollar!, web.economics.returnPerDollar!));
    // The shared leg (attended → paid) is priced on the cheaper of its two paths.
    const shared = out.legs.find((l) => l.legKey === "meeting_attended_to_paid_client")!;
    expect(shared.costPerOutcomeUsd).toBe(Math.min(conv.economics.costPerSaleUsd!, web.economics.costPerSaleUsd!));
  });

  it("an unmeasured pair leaves its outcomes NULL with the pair's own reason — never 0, never borrowed", () => {
    const out = channelOutcomeEconomicsOf(channel("ads", [[null, "meeting_booked"]]), [
      { funnelKey: "sales_meetings_from_ads", effectiveMinimumCommitmentDays: 30, result: price("sales_meetings_from_ads") },
    ]);
    expect(out.outcomes.every((o) => o.costPerOutcomeUsd === null && o.unpricedReason === "entry_step_not_measured")).toBe(true);
    expect(out.returnPerDollar).toBeNull();
    expect(out.evidence).toBeNull();
  });
});

describe("buildOutcomeReturnOnSpend", () => {
  const brand = (id: string, legs: string[] | undefined, multiple: number, clients: number | null = 2) => ({
    brandId: id,
    committedSpendUsd: 1000,
    expectedPipelineUsd: 1000 * multiple,
    ...(legs === undefined ? {} : { legKeys: legs }),
    expectedPaidClients: clients,
  });

  it("a leg population of one-path brands reads the byte-same median as the funnel row", () => {
    const rows = [brand("a", ["start_to_conversation"], 1.5), brand("b", ["start_to_conversation"], 2), brand("c", ["start_to_conversation"], 3), brand("d", ["start_to_website_visit"], 9)];
    const leg = buildOutcomeReturnOnSpend(rows, new Set(["start_to_conversation"]), 100);
    const funnel = buildFunnelReturnOnSpend(rows.slice(0, 3).map((r) => ({ ...r, funnelKey: "sales_meetings_from_conversation" as const })), 100);
    expect(leg).toEqual(funnel);
    expect(leg.medianReturnPerDollar).toBe(2);
    expect(leg.medianCostPerPaidClientUsd).toBe(500);
  });

  it("tells a snapshot that predates legs apart from a thin population", () => {
    expect(buildOutcomeReturnOnSpend([brand("a", undefined, 2)], new Set(["start_to_conversation"]), 100).reason).toBe("legs_not_recorded_yet");
    expect(buildOutcomeReturnOnSpend([brand("a", ["start_to_conversation"], 2)], new Set(["start_to_conversation"]), 100).reason).toBe("not_enough_brands");
    expect(buildOutcomeReturnOnSpend(null, new Set(["start_to_conversation"]), 100).reason).toBe("no_snapshot_yet");
  });
});

describe("showcaseOutcomesOf", () => {
  it("merges two paths' identical rungs into one outcome naming both legs, and keeps the brand return", () => {
    const chain = (steps: Array<[string, number]>) => ({
      funnelKey: "x" as SalesFunnelKey,
      funnelName: "x",
      returnPerDollar: 1,
      steps: [{ key: "contacted", label: "Contacted", peopleReached: 100, costPerReachUsd: 1 }, ...steps.map(([key, n]) => ({ key, label: key, peopleReached: n, costPerReachUsd: 100 / n }))],
    });
    const out = showcaseOutcomesOf(
      {
        brand: { id: "b", name: null, domain: null },
        funnels: [
          chain([["start_to_conversation", 10], ["conversation_to_meeting_booked", 4], ["meeting_booked_to_meeting_attended", 2], ["meeting_attended_to_paid_client", 1]]),
          chain([["start_to_website_visit", 20], ["website_visit_to_meeting_booked", 4], ["meeting_booked_to_meeting_attended", 2], ["meeting_attended_to_paid_client", 1]]),
        ],
        measured: true,
        unmeasuredReason: null,
      },
      2.5,
    );
    expect(out.outcomes.map((o) => o.key)).toEqual(["contacted", "conversation", "website_visit", "meeting_booked", "meeting_attended", "paid_client"]);
    expect(out.outcomes.find((o) => o.key === "meeting_booked")!.legKeys).toEqual(["conversation_to_meeting_booked", "website_visit_to_meeting_booked"]);
    expect(out.returnPerDollar).toBe(2.5);
  });
});
