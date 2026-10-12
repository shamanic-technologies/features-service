import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildPipeStats, campaignsInScope, customerTeamVolumes, pipeStatsKind } = await import("./pipe-stats.js");

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
    // A source finding leads on its own (owner 2026-10-12, proactive, no trigger) is still measured on leads found.
    expect(pipeStatsKind({ fromStep: null, toStep: "lead_found", triggerId: null })).toBe("on_demand");
  });
});

describe("customer-team pipe (owner 2026-10-12: their team's rate on the same leg, from their tools)", () => {
  const pipe = { fromStepLabel: "Conversation", toStepLabel: "Meeting booked" };
  const answered = (from: Record<string, number>, to: Record<string, number>, fromSources = ["gohighlevel"], toSources = ["gohighlevel"]) => ({
    available: true as const,
    from: { daily: new Map(Object.entries(from)), undated: 0 },
    to: { daily: new Map(Object.entries(to)), undated: 0 },
    fromSources,
    toSources,
    toByFromDay: null,
  });

  it("periods read the producer's cohort (TO on the FROM day) when every brand serves it", () => {
    const withCohort = { ...answered({ "2026-09-30": 2 }, { "2026-10-02": 2 }), toByFromDay: { daily: new Map([["2026-09-30", 2]]), undated: 0 } };
    const s = buildPipeStats({ ...customerTeamVolumes(pipe, [withCohort], true), outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: null, today: "2026-10-03", hasSpend: false });
    expect(s.periods.countsDatedBy).toEqual({ reachedFrom: "input_day", outcomes: "input_day" });
    expect(s.periods.months.map((m) => [m.period, m.counts.reachedFrom, m.counts.outcomes, m.ratesPct.reachedFrom_to_outcomes])).toEqual([["2026-09", 2, 2, 100], ["2026-10", 0, 0, null]]);
    // One brand without it: the booking-day count stands, stated.
    const mixed = buildPipeStats({ ...customerTeamVolumes(pipe, [withCohort, answered({}, {})], false), outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: null, today: "2026-10-03", hasSpend: false });
    expect(mixed.periods.countsDatedBy.outcomes).toBe("own_date");
  });

  it("is chosen by who works the leg (operatedBy), never by the channel", () => {
    expect(pipeStatsKind({ fromStep: "conversation", triggerId: null, operatedBy: "customer" })).toBe("customer_team");
    expect(pipeStatsKind({ fromStep: "conversation", triggerId: null, operatedBy: "platform" })).toBe("internal");
  });

  it("sums the brands that answered and rates of the people who reached FROM, how many reached TO", () => {
    const { volumes, teamSource } = customerTeamVolumes(pipe, [answered({ "2026-10-01": 8, "2026-10-02": 2 }, { "2026-10-03": 3 }), answered({ "2026-10-02": 10 }, { "2026-10-02": 1 }, ["gmail"], ["gmail"]), { available: false, reason: "no_connection" }], false);
    const s = buildPipeStats({ volumes, outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: 100, today: "2026-10-03" });
    expect(s.volumes.map((v) => [v.key, v.total])).toEqual([["reachedFrom", 20], ["outcomes", 4]]);
    expect(s.conversionRates).toEqual([expect.objectContaining({ key: "reachedFrom_to_outcomes", numerator: 4, denominator: 20, ratePct: 20 })]);
    expect(s.costPerOutcomeUnavailableReason).toBe("no_spend_recorded");
    expect(teamSource).toMatchObject({ available: true, unavailableReason: null, brandsCounted: 2, unavailableBrands: { no_connection: 1 }, fromSources: ["gmail", "gohighlevel"], offerNarrowed: false });
  });

  it("an unanswerable brand is UNMEASURED with the producer's reason, never 0", () => {
    const { volumes, teamSource } = customerTeamVolumes(pipe, [{ available: false, reason: "from_step_not_recorded" }], true);
    const s = buildPipeStats({ volumes, outcomeKey: "outcomes", spendByDay: new Map(), valuePerOutcomeUsd: 100, today: "2026-10-03" });
    expect(s.volumes.map((v) => v.total)).toEqual([null, null]);
    expect(s.conversionRates[0]).toMatchObject({ ratePct: null, unavailableReason: "volume_not_measured" });
    expect(teamSource).toMatchObject({ available: false, unavailableReason: "from_step_not_recorded", brandsCounted: 0 });
    // A brand two orgs hold: the most specific reason wins over the empty org's.
    expect(customerTeamVolumes(pipe, [{ available: false, reason: "no_connected_source" }, { available: false, reason: "from_step_not_recorded" }], true).teamSource.unavailableReason).toBe("from_step_not_recorded");
    // Fleet with nobody answering names that, per-brand reasons counted.
    expect(customerTeamVolumes(pipe, [{ available: false, reason: "no_connection" }], false).teamSource.unavailableReason).toBe("no_brand_answers");
  });
});
