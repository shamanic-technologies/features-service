import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildPipeStats, campaignsInScope, pipeStatsKind } = await import("./pipe-stats.js");

const vol = (key: string, role: "input" | "action" | "outcome", days: Record<string, number> | null, undated = 0) => ({
  key,
  label: key,
  role,
  datedBy: "event_day" as const,
  daily: days ? new Map(Object.entries(days)) : null,
  undated,
});

describe("buildPipeStats", () => {
  it("cumulates every day from the first activity to today; the snapshot IS the last point", () => {
    const s = buildPipeStats({
      volumes: [vol("handed", "input", { "2026-10-01": 4, "2026-10-03": 2 }), vol("outcomes", "outcome", { "2026-10-03": 1 }, 1)],
      outcomeKey: "outcomes",
      spendByDay: new Map([
        ["2026-09-30", 3],
        ["2026-10-02", 2.005],
      ]),
      valuePerOutcomeUsd: 250,
      today: "2026-10-04",
    });
    expect(s.firstActivityDay).toBe("2026-09-30");
    expect(s.history.map((p) => p.date)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    // Learning while no outcome: null, never a floor, never the spend.
    expect(s.history[0]).toMatchObject({ spendUsd: 3, costPerOutcomeUsd: null, roi: null, volumes: { handed: 0, outcomes: 0 } });
    expect(s.history[3]).toMatchObject({ spendUsd: 5.01, costPerOutcomeUsd: 5.01, roi: 49.95, volumes: { handed: 6, outcomes: 1 } });
    // The undated outcome enters on the last point only.
    const last = s.history.at(-1)!;
    expect(last.volumes).toEqual({ handed: 6, outcomes: 2 });
    expect(s.volumes.find((v) => v.key === "outcomes")).toMatchObject({ total: 2, undated: 1 });
    expect(s).toMatchObject({ spendUsd: last.spendUsd, costPerOutcomeUsd: last.costPerOutcomeUsd, roi: last.roi });
    expect(s.costPerOutcomeUsd).toBe(2.5);
  });

  it("names why a figure is missing: no outcome, unmeasured outcome, unvalued step; nothing at all = empty history", () => {
    const none = buildPipeStats({ volumes: [vol("outcomes", "outcome", {})], outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: 10, today: "2026-10-04" });
    expect(none).toMatchObject({ history: [], spendUsd: 0, costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "no_outcome_yet", roiUnavailableReason: "no_cost_per_outcome" });
    const unmeasured = buildPipeStats({ volumes: [vol("outcomes", "outcome", null)], outcomeKey: "outcomes", spendByDay: new Map([["2026-10-04", 1]]), valuePerOutcomeUsd: 10, today: "2026-10-04" });
    expect(unmeasured).toMatchObject({ costPerOutcomeUnavailableReason: "outcome_not_measured", volumes: [{ total: null }] });
    expect(unmeasured.history[0]!.volumes.outcomes).toBeNull();
    const unvalued = buildPipeStats({ volumes: [vol("outcomes", "outcome", { "2026-10-04": 2 })], outcomeKey: "outcomes", spendByDay: new Map([["2026-10-04", 4]]), valuePerOutcomeUsd: null, today: "2026-10-04" });
    expect(unvalued).toMatchObject({ costPerOutcomeUsd: 2, roi: null, roiUnavailableReason: "step_unvalued" });
  });
});

describe("conversion rates", () => {
  it("rates every consecutive pair and first -> outcome, in percent with their counts; the last point equals the snapshot", () => {
    const s = buildPipeStats({
      volumes: [vol("handed", "input", { "2026-10-01": 10, "2026-10-02": 6 }), vol("actedOn", "action", { "2026-10-02": 10 }), vol("outcomes", "outcome", { "2026-10-03": 1 }, 1)],
      outcomeKey: "outcomes",
      spendByDay: new Map(),
      valuePerOutcomeUsd: null,
      today: "2026-10-03",
    });
    expect(s.conversionRates).toEqual([
      { key: "handed_to_actedOn", fromKey: "handed", toKey: "actedOn", label: "handed → actedOn", numerator: 10, denominator: 16, ratePct: 62.5, unavailableReason: null },
      { key: "actedOn_to_outcomes", fromKey: "actedOn", toKey: "outcomes", label: "actedOn → outcomes", numerator: 2, denominator: 10, ratePct: 20, unavailableReason: null },
      { key: "handed_to_outcomes", fromKey: "handed", toKey: "outcomes", label: "handed → outcomes", numerator: 2, denominator: 16, ratePct: 12.5, unavailableReason: null },
    ]);
    // Denominator 0 = null (never 0); a measured 0 numerator over a real input is a drawn 0.
    expect(s.history[0]!.conversionRates).toEqual({ handed_to_actedOn: 0, actedOn_to_outcomes: null, handed_to_outcomes: 0 });
    const last = s.history.at(-1)!.conversionRates;
    for (const r of s.conversionRates) expect(last[r.key]).toBe(r.ratePct);
  });

  it("two volumes = one rate; a zero input or an unmeasured volume is null with its reason", () => {
    const zero = buildPipeStats({ volumes: [vol("contacted", "input", {}), vol("outcomes", "outcome", {})], outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: null, today: "2026-10-03" });
    expect(zero.conversionRates).toEqual([{ key: "contacted_to_outcomes", fromKey: "contacted", toKey: "outcomes", label: "contacted → outcomes", numerator: 0, denominator: 0, ratePct: null, unavailableReason: "no_input_yet" }]);
    const unmeasured = buildPipeStats({ volumes: [vol("contacted", "input", { "2026-10-03": 4 }), vol("outcomes", "outcome", null)], outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: null, today: "2026-10-03" });
    expect(unmeasured.conversionRates[0]).toMatchObject({ numerator: null, denominator: 4, ratePct: null, unavailableReason: "volume_not_measured" });
    const single = buildPipeStats({ volumes: [vol("outcomes", "outcome", {}, 3)], outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: null, today: "2026-10-03" });
    expect(single.conversionRates).toEqual([]);
    expect(single.history[0]!.conversionRates).toEqual({});
  });
});

describe("scope and kind", () => {
  const cs = [
    { campaignId: "a", orgId: "o", brandId: "b1", offerId: "x" },
    { campaignId: "b", orgId: "o", brandId: "b1", offerId: "y" },
    { campaignId: "c", orgId: "p", brandId: "b2", offerId: "x" },
  ];
  it("fleet >= brand >= offer: each scope is the same read on fewer campaigns", () => {
    expect(campaignsInScope(cs, { kind: "fleet", brandId: null, offerId: null })).toHaveLength(3);
    expect(campaignsInScope(cs, { kind: "brand", brandId: "b1", offerId: null }).map((c) => c.campaignId)).toEqual(["a", "b"]);
    expect(campaignsInScope(cs, { kind: "offer", brandId: "b1", offerId: "x" }).map((c) => c.campaignId)).toEqual(["a"]);
  });
  it("kind follows where the leg starts and its trigger, never the channel", () => {
    expect(pipeStatsKind({ fromStep: "conversation", triggerId: "positive_reply" })).toBe("internal");
    expect(pipeStatsKind({ fromStep: "lead_found", triggerId: null })).toBe("entry");
    expect(pipeStatsKind({ fromStep: null, triggerId: null })).toBe("entry");
    expect(pipeStatsKind({ fromStep: null, triggerId: "on_demand" })).toBe("on_demand");
  });
});
