import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  campaignChangeEventsOf,
  campaignChangesOf,
  capWords,
  changeResultOf,
  engineStepOf,
  ledgerKeysOf,
  probabilityAfterIsBetter,
  regularizedBeta,
  scriptChangeEventsOf,
  windowDaysOf,
  type ChangeEvent,
  type StepPick,
  type ScriptDayRow,
} from "./campaign-change-log.js";
import { parseChangeHistory, parseVersionReach } from "./campaign-change-log-io.js";
import { strategyChangeOf } from "./engine-strategy-io.js";

// Made-up Engines, scripts and steps on purpose: the rules know none.
const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);
const at = (n: number, hh = "12:00") => `${day(n)}T${hh}:00.000Z`;
const row = (engine: string, dynasty: string, version: string, n: number, decisions: number, reached: Record<string, number> = {}, produced: Record<string, number> = {}): ScriptDayRow => ({ engine, dynasty, version, day: day(n), decisions, reached, produced });
const span = (from: number, to: number, f: (n: number) => ScriptDayRow[]) => Array.from({ length: to - from + 1 }, (_, k) => f(from + k)).flat();
const TODAY = day(90);
/** alpha's nearest step is beta, 48 h at p90: maturity 2 days, window 7 days. */
const pick = (p90Hours: number) => ({ step: { step: "beta", pairs: 50, medianHours: 20, p90Hours }, reason: null }) as StepPick;
const unmeasured: StepPick = { step: null, reason: "no_downstream_step_measured" };
const twoDays = (engine: string): StepPick => (engine === "alpha" || engine === "gamma" ? pick(48) : unmeasured);
const fiveDays = (engine: string): StepPick => (engine === "alpha" ? pick(120) : unmeasured);

describe("scriptChangeEventsOf: what counts as a change (CAMPAIGN-CHANGE-LOG-1119)", () => {
  it("100 scripts tried in one day are a handful of lines: one for the trial, none per script", () => {
    const rows = [
      ...span(1, 3, (n) => [row("alpha", "main", "v1", n, 100)]),
      row("alpha", "main", "v1", 4, 20),
      ...Array.from({ length: 100 }, (_, k) => row("alpha", `trial_${k}`, "v1", 4, 2)),
      ...span(5, 6, (n) => [row("alpha", "main", "v1", n, 100)]),
    ];
    const events = scriptChangeEventsOf(rows);
    expect(events.map((e) => [e.day, e.kind])).toEqual([[day(1), "script_started"], [day(4), "scripts_tried"]]);
    expect(events[1]).toMatchObject({ tried: { scripts: 100, decisions: 200 }, from: null, to: null, who: "our_ai" });
    expect(events[1]!.share).toBeCloseTo(200 / 220, 9);
  });

  it("100 VERSIONS of one dynasty in one day are at most one upgrade line", () => {
    const rows = [
      ...span(1, 3, (n) => [row("alpha", "main", "v1", n, 100)]),
      ...Array.from({ length: 100 }, (_, k) => row("alpha", "main", `v${k + 2}`, 4, k === 99 ? 60 : 1)),
      ...span(5, 6, (n) => [row("alpha", "main", "v101", n, 100)]),
    ];
    expect(scriptChangeEventsOf(rows).map((e) => [e.day, e.kind, e.to?.version])).toEqual([
      [day(1), "script_started", "v1"],
      [day(4), "script_upgraded", "v101"],
    ]);
  });

  it("a dynasty serves from 20% of the Engine's day and stops under 5%: hovering in between is no line", () => {
    const shares = [100, 30, 10, 6, 25, 4]; // % of the day carried by `second`, day by day
    const rows = shares.flatMap((s, k) => [row("alpha", "first", "v1", k + 1, 100 - s), row("alpha", "second", "v1", k + 1, s)]);
    expect(scriptChangeEventsOf(rows).map((e) => [e.day, e.kind, (e.to ?? e.from)!.scriptDynasty])).toEqual([
      [day(1), "script_started", "alpha/second"],
      [day(2), "script_started", "alpha/first"],
      [day(6), "script_stopped", "alpha/second"], // 10%, 6% and 25% kept it serving; 4% ends it
    ]);
  });

  it("a quiet day (under 5 decisions) is not judged", () => {
    const rows = [row("alpha", "main", "v1", 1, 50), row("alpha", "other", "v1", 2, 4), row("alpha", "main", "v1", 3, 50)];
    expect(scriptChangeEventsOf(rows).map((e) => e.kind)).toEqual(["script_started"]);
  });
});

describe("the measured result and the verdict", () => {
  // `old` serves alpha on days 1-14 (100 decisions a day, 5 reach beta); `new` replaces it on day 15.
  const replaced = (perDay: number, reachedPerDay: number, days = 14) => [
    ...span(1, 14, (n) => [row("alpha", "old", "v1", n, 100, { beta: 5 })]),
    ...span(15, 14 + days, (n) => [row("alpha", "new", "v1", n, perDay, { beta: reachedPerDay })]),
  ];
  const resultOfNew = (rows: ScriptDayRow[], today = TODAY, downstream = twoDays, extra: ChangeEvent[] = []) => {
    const events = [...scriptChangeEventsOf(rows), ...extra];
    return changeResultOf(events.find((e) => e.kind === "script_started" && e.to!.scriptDynasty === "alpha/new")!, events, rows, downstream, today);
  };

  it("windows are sized by the step's delay: 2 x its p90 in days, from 7 to 28", () => {
    expect([windowDaysOf(1), windowDaysOf(2), windowDaysOf(5), windowDaysOf(20)]).toEqual([7, 7, 10, 28]);
  });

  it("a matured change that WORKED: the new script's own decisions against the ones it replaced", () => {
    const r = resultOfNew(replaced(100, 15));
    expect(r).toMatchObject({ measuredEngine: "alpha", step: "beta", maturityDays: 2, windowDays: 7, verdict: "worked", verdictReason: "tested", measuredOn: null, confoundedWith: [] });
    expect(r.before).toEqual({ fromDay: day(8), toDay: day(14), decisions: 700, cases: 35, rate: 0.05 });
    expect(r.after).toEqual({ fromDay: day(15), toDay: day(21), decisions: 700, cases: 105, rate: 0.15 });
    expect(r.probabilityBetter!).toBeGreaterThan(0.999);
  });

  it("a matured change that DID NOT WORK is said so; leaning better is partial; no difference is inconclusive", () => {
    const worse = resultOfNew(replaced(100, 1));
    expect(worse.verdict).toBe("did_not_work");
    expect(worse.probabilityBetter!).toBeLessThan(0.01);
    expect(resultOfNew(replaced(100, 6)).verdict).toBe("partial");
    expect(resultOfNew(replaced(100, 5))).toMatchObject({ verdict: "inconclusive", verdictReason: "tested" });
  });

  it("THIN evidence is inconclusive, whatever the rates look like", () => {
    expect(resultOfNew(replaced(10, 5, 2))).toMatchObject({ verdict: "inconclusive", verdictReason: "thin_evidence", probabilityBetter: null }); // 20 decisions after
    const fewCases = [...span(1, 14, (n) => [row("alpha", "old", "v1", n, 100, { beta: n === 10 ? 2 : 0 })]), ...span(15, 28, (n) => [row("alpha", "new", "v1", n, 100, { beta: n === 15 ? 5 : 0 })])];
    expect(resultOfNew(fewCases)).toMatchObject({ verdict: "inconclusive", verdictReason: "thin_evidence" }); // 7 cases in all
  });

  it("NOT MATURED yet: too early, with the day it is measured; half matured counts the matured days only", () => {
    const r = resultOfNew(replaced(100, 15), day(16), fiveDays);
    expect(r).toMatchObject({ verdict: "too_early", verdictReason: "after_window_not_matured", measuredOn: day(20), probabilityBetter: null, maturityDays: 5, windowDays: 10 });
    expect(r.after).toMatchObject({ decisions: 0, rate: null });
    expect(resultOfNew(replaced(100, 15), day(22), fiveDays).after).toMatchObject({ fromDay: day(15), toDay: day(17), decisions: 300 });
  });

  it("OVERLAPPING changes: another track changing inside a window is confounded, never credited with the other's effect", () => {
    const rows = [...replaced(100, 15), ...span(18, 30, (n) => [row("gamma", "sender", "v1", n, 50, { beta: 10 })])];
    const events = scriptChangeEventsOf(rows);
    const r = changeResultOf(events.find((e) => e.to?.scriptDynasty === "alpha/new")!, events, rows, twoDays, TODAY);
    expect(r).toMatchObject({ verdict: "confounded", verdictReason: "another_change_in_the_window", probabilityBetter: null, confoundedWith: [`${day(18)}:gamma:started:sender`] });
    expect(r.after!.rate).toBe(0.15); // the figures are still served
    // A campaign change (a budget move) inside the window confounds too.
    const budget: ChangeEvent = { id: "budget:1", at: at(12), day: day(12), kind: "budget_changed", engine: null, from: null, to: null, share: null, tried: null, who: null, whoEvidence: null, reason: null, parts: null };
    expect(resultOfNew(replaced(100, 15), TODAY, twoDays, [budget])).toMatchObject({ verdict: "confounded", confoundedWith: ["budget:1"] });
  });

  it("the track's own next change ends the window; nothing before = said; no step measured = said; nothing ran after = said", () => {
    const rows = [...replaced(100, 15), ...span(18, 30, (n) => [row("alpha", "third", "v1", n, 400, { beta: 4 })])];
    expect(resultOfNew(rows).after).toMatchObject({ fromDay: day(15), toDay: day(17), decisions: 300 });
    const events = scriptChangeEventsOf(rows);
    expect(changeResultOf(events[0]!, events, rows, twoDays, TODAY)).toMatchObject({ verdict: "inconclusive", verdictReason: "nothing_before_to_compare" });
    const blind = [row("zeta", "old", "v1", 1, 100)];
    expect(changeResultOf(scriptChangeEventsOf(blind)[0]!, scriptChangeEventsOf(blind), blind, twoDays, TODAY)).toMatchObject({ step: null, verdict: "inconclusive", verdictReason: "no_downstream_step_measured" });
    // A pause measured on the campaign's busiest Engine: nothing ran after it, and the whole window matured.
    const stop: ChangeEvent = { id: "status:1", at: at(15), day: day(15), kind: "campaign_stopped", engine: null, from: null, to: null, share: null, tried: null, who: "a_person", whoEvidence: null, reason: "manual", parts: null };
    const before = span(1, 14, (n) => [row("alpha", "old", "v1", n, 100, { beta: 5 })]);
    expect(changeResultOf(stop, [stop], before, twoDays, TODAY)).toMatchObject({ measuredEngine: "alpha", verdict: "inconclusive", verdictReason: "no_decisions_after" });
  });

  it("P(after > before) is exact and blended: the same rate on both sides is 0.5", () => {
    expect(regularizedBeta(0.5, 1, 1)).toBeCloseTo(0.5, 12);
    expect(regularizedBeta(0.25, 2, 3)).toBeCloseTo(0.26171875, 9);
    expect(probabilityAfterIsBetter({ cases: 50, decisions: 1000 }, { cases: 50, decisions: 1000 })).toBeCloseTo(0.5, 9);
    expect(probabilityAfterIsBetter({ cases: 50, decisions: 1000 }, { cases: 80, decisions: 1000 })).toBeGreaterThan(0.99);
    // 3 cases against 1 barely move a blend worth 10 cases: not sure at all.
    expect(probabilityAfterIsBetter({ cases: 1, decisions: 40 }, { cases: 3, decisions: 40 })).toBeLessThan(0.8);
  });
});

describe("engineStepOf: the step a change is measured on (CAMPAIGN-CHANGE-LOG-FIX-1119)", () => {
  const t = (fromKey: string, toKey: string, pairs: number, medianHours: number, p90Hours: number) => ({ fromKey, toKey, pairs, medianHours, p90Hours });
  it("an Engine whose Units the ledger keys another way is measured from the key its decisions PRODUCED", () => {
    const rows = [row("sent", "main", "v1", 1, 40, {}, { delivered: 40 }), row("sent", "main", "v1", 2, 10, {}, { delivered: 9, sent: 1 })];
    const keys = ledgerKeysOf(rows);
    expect(keys.get("sent")).toEqual(["delivered", "sent"]);
    const transitions = [t("delivered", "clicked", 800, 1, 10), t("delivered", "sent", 50, 0, 1)];
    expect(engineStepOf("sent", keys.get("sent")!, transitions)).toEqual({ step: { step: "clicked", pairs: 800, medianHours: 1, p90Hours: 10 }, reason: null });
    expect(engineStepOf("sent", [], transitions)).toEqual({ step: null, reason: "no_downstream_step_measured" });
  });
  it("the nearest step a client can read within the window: a faster median whose p90 passes 28 days is skipped", () => {
    const transitions = [t("alpha", "pool", 70000, 0, 71 * 24), t("alpha", "click", 800, 140, 24 * 24), t("alpha", "thin", 9, 1, 2)];
    expect(engineStepOf("alpha", [], transitions).step?.step).toBe("click");
    expect(engineStepOf("alpha", [], transitions.slice(0, 1))).toEqual({ step: null, reason: "step_slower_than_window" });
  });
});

describe("a campaign-wide change (CAMPAIGN-CHANGE-LOG-FIX-1119)", () => {
  const stop: ChangeEvent = { id: "budget:1", at: at(15), day: day(15), kind: "budget_changed", engine: null, from: null, to: null, share: null, tried: null, who: "a_person", whoEvidence: null, reason: null, parts: null };
  it("is measured on the Engine whose step holds the most matured cases, never the busiest one", () => {
    const rows = [...span(1, 28, (n) => [row("busy", "main", "v1", n, 1000, { far: 1 }), row("alpha", "main", "v1", n, 100, { beta: 10 })])];
    const stepOf = (e: string): StepPick => (e === "alpha" ? pick(48) : e === "busy" ? { step: { step: "far", pairs: 50, medianHours: 1, p90Hours: 48 }, reason: null } : unmeasured);
    expect(changeResultOf(stop, [stop], rows, stepOf, TODAY)).toMatchObject({ measuredEngine: "alpha", step: "beta" });
  });
  it("no Engine with a step the window holds: inconclusive, named, never a date months away", () => {
    const rows = span(1, 28, (n) => [row("alpha", "main", "v1", n, 100, { beta: 10 })]);
    expect(changeResultOf(stop, [stop], rows, () => ({ step: null, reason: "step_slower_than_window" }), TODAY)).toMatchObject({ measuredEngine: null, verdict: "inconclusive", verdictReason: "no_step_readable_within_window", measuredOn: null });
  });
});

describe("campaignChangeEventsOf: the owners' journals", () => {
  const empty = { caps: [], transitions: [], settings: [], plans: [], strategies: [] };

  it("budget: the cap the campaign is held to; a funnel-wide move under its own cap is no line", () => {
    const events = campaignChangeEventsOf({
      ...empty,
      caps: [
        { id: "1", scope: "sales_funnel", maxBudget: { amountCents: "1000", period: "daily" }, maxVolume: null, changedByUserId: "u1", changedAt: at(1) },
        { id: "2", scope: "sales_funnel_campaign", maxBudget: { amountCents: "2500", period: "daily" }, maxVolume: null, changedByUserId: null, changedAt: at(2) },
        { id: "3", scope: "sales_funnel", maxBudget: { amountCents: "9000", period: "daily" }, maxVolume: null, changedByUserId: "u1", changedAt: at(3) },
      ],
    });
    expect(events.map((e) => [e.kind, e.from!.label, e.to!.label, e.who])).toEqual([
      ["budget_changed", "No max budget", "$10.00 a day", "a_person"],
      ["budget_changed", "$10.00 a day", "$25.00 a day", null],
    ]);
    expect(capWords({ maxBudget: { amountCents: "150000", period: "monthly" }, maxVolume: { count: 1200, period: "weekly" } })).toBe("$1,500.00 a month, 1,200 a week");
  });

  it("pauses: units moving in the same minute are one line, with who and why; births and observations are none", () => {
    const t = (id: string, campaignId: string, from: string | null, to: string, source: string, reason: string | null, when: string) => ({ id, campaignId, fromStatus: from, toStatus: to, reason, source, occurredAt: when });
    const events = campaignChangeEventsOf({
      ...empty,
      transitions: [
        t("a", "u1", null, "ongoing", "sales_funnel", null, at(1)),
        t("b", "u2", null, "ongoing", "sales_funnel", null, at(1)),
        t("c", "u1", "ongoing", "stopped", "sales_funnel", "manual", at(5, "10:00")),
        t("d", "u2", "ongoing", "stopped", "sales_funnel", "manual", `${day(5)}T10:00:30.000Z`),
        t("e", "u1", "stopped", "ongoing", "patch", null, at(6)),
        t("f", "u2", "ongoing", "stopped", "payment_hold", "payment_declined", at(7)),
        t("g", "u1", null, "stopped", "record_opened", null, at(8)),
      ],
    });
    expect(events.map((e) => [e.day, e.kind, e.who, e.reason, e.parts])).toEqual([
      [day(5), "campaign_stopped", "a_person", "manual", { moved: 2, total: 2 }],
      [day(6), "campaign_resumed", "a_person", null, { moved: 1, total: 2 }],
      [day(7), "campaign_stopped", "our_system", "payment_declined", { moved: 1, total: 2 }],
    ]);
  });

  it("brief, Target, plan, strategy: who from the record; the birth values are no change", () => {
    const events = campaignChangeEventsOf({
      ...empty,
      settings: [
        { id: "s0", field: "brief", before: null, after: "Born words", changedByUserId: "u1", source: "birth", changedAt: at(1) },
        { id: "s1", field: "brief", before: "Born words", after: "New words", changedByUserId: "u1", source: "edit", changedAt: at(2) },
        { id: "s2", field: "target", before: null, after: "beta", changedByUserId: null, source: "target_backfill", changedAt: at(3) },
      ],
      plans: [{ id: "p1", fromSalesFunnelId: "f1", toSalesFunnelId: "f2", appliedAt: at(4), reason: "plan", units: [{ campaignId: "u3", action: "born" }, { campaignId: "u1", action: "draining" }, { campaignId: "u2", action: "kept" }] }],
      strategies: [
        { id: 1, campaignId: "u1", outcome: "alpha", fromStrategyId: null, toStrategyId: "st1", source: "judge", changedAt: at(5) },
        { id: 2, campaignId: "u2", outcome: "alpha", fromStrategyId: null, toStrategyId: "st1", source: "judge", changedAt: at(5) },
      ],
    });
    expect(events.map((e) => [e.kind, e.who, e.engine])).toEqual([
      ["brief_changed", "a_person", null],
      ["target_changed", "our_system", null],
      ["plan_changed", "our_ai", null],
      ["strategy_changed", "our_ai", "alpha"],
    ]);
    expect(events[2]!.parts).toEqual({ added: 1, retired: 1 });
  });
});

describe("campaignChangesOf: the served list", () => {
  it("newest first, a script named by its label, an Engine by its catalogue label, every figure served", () => {
    const rows = [...span(1, 14, (n) => [row("alpha", "old", "v1", n, 100, { beta: 5 })]), ...span(15, 28, (n) => [row("alpha", "dy_new_way", "v1", n, 100, { beta: 15 })])];
    const campaignEvents = campaignChangeEventsOf({ caps: [], transitions: [], settings: [], plans: [], strategies: [{ id: 9, campaignId: "u1", outcome: "alpha", fromStrategyId: null, toStrategyId: "st1", source: "judge", changedAt: at(40) }] });
    const list = campaignChangesOf({
      rows,
      campaignEvents,
      transitions: [{ fromKey: "alpha", toKey: "beta", pairs: 50, medianHours: 20, p90Hours: 48 }],
      today: TODAY,
      scriptLabel: (d) => (d === "alpha/old" ? "Plain Writer" : null),
      strategyLabel: (id) => (id === "st1" ? "Short emails" : null),
      outcomeLabel: (k) => ({ alpha: "Alpha made", beta: "Beta reached" })[k] ?? k,
    });
    expect(list.map((c) => [c.date, c.kind])).toEqual([[day(40), "strategy_changed"], [day(15), "script_stopped"], [day(15), "script_started"], [day(1), "script_started"]]);
    expect(list[0]!.summary).toBe("Alpha made: strategy No strategy to Short emails");
    const started = list[2]!;
    expect(started).toMatchObject({ engine: { outcomeKey: "alpha", label: "Alpha made" }, to: { scriptDynasty: "alpha/dy_new_way", label: "New way", version: "v1" }, summary: "Alpha made: started using New way", who: "our_ai", whoEvidence: "the_rating_picks_the_script" });
    expect(started.result).toMatchObject({ step: { outcomeKey: "beta", label: "Beta reached" }, measuredEngine: { outcomeKey: "alpha" }, changePct: 200 });
    expect(list[1]!.summary).toBe("Alpha made: stopped using Plain Writer");
  });
});

describe("owners' bodies", () => {
  it("parseVersionReach: one row per script version and day; the reached outcomes counted in decisions, the Engine's own left out", () => {
    const body = { builtAt: "2026-01-20T00:00:00.000Z", groups: [
      { scriptSlug: "alpha/main/v2", day: "2026-01-01", producedOutcomes: ["alpha"], reachedOutcomes: ["beta"], runs: 7 },
      { scriptSlug: "alpha/main/v2", day: "2026-01-01", producedOutcomes: ["alpha"], reachedOutcomes: [], runs: 30 },
      { scriptSlug: "alpha/main/v2", day: "2026-01-01", producedOutcomes: ["alpha"], reachedOutcomes: ["beta", "gamma"], runs: 3 },
    ] };
    expect(parseVersionReach(body).rows).toEqual([{ engine: "alpha", dynasty: "main", version: "v2", day: "2026-01-01", decisions: 40, reached: { beta: 10, gamma: 3 }, produced: { alpha: 40 } }]);
    expect(() => parseVersionReach({ builtAt: "x", groups: [{ scriptSlug: "alpha/main", day: "2026-01-01", producedOutcomes: [], reachedOutcomes: [], runs: 1 }] })).toThrow(/version/);
    expect(() => parseVersionReach({ groups: [] })).toThrow(/builtAt/);
  });

  it("parseChangeHistory fails loud on a missing list", () => {
    expect(() => parseChangeHistory({ units: [], statusTransitions: [], settingChanges: [], settingsRecordedSince: "2026-11-19" })).toThrow(/planChanges/);
  });

  it("strategyChangeOf: a row only when the kept strategy moves", () => {
    const after = { campaignId: "u1", outcome: "alpha", orgId: "o1", strategyId: "st2", source: "judge" as const, briefHash: null, optionsSignature: null, confidence: 0.9, model: "m", carriedFrom: null };
    expect(strategyChangeOf({ strategyId: "st2" }, after)).toBeNull();
    expect(strategyChangeOf(null, { ...after, strategyId: null })).toBeNull();
    expect(strategyChangeOf({ strategyId: "st1" }, after)).toMatchObject({ fromStrategyId: "st1", toStrategyId: "st2", source: "judge" });
  });
});
