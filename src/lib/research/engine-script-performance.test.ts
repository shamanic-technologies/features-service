import { describe, expect, it } from "vitest";
import { measureScripts, scriptKeyOf, type ScriptFacts } from "./engine-script-performance.js";
import { withMeasureScripts, type ResearchMeasure } from "./by-engine.js";
import type { LedgerPipeBook } from "../ledger-pipe-costs.js";

// RESEARCH-PERF-SCRIPTS-1116: a measure's rows of today are its Engine's scripts, measured on the ledger.
const P = (o: Partial<LedgerPipeBook["produced"][number]>) => ({ outcomeKey: "x", campaignId: "c1", workflowSlug: null, occurrences: 0, costUsd: 0, runStartDay: "2026-11-10", scriptSlug: null, ...o });
const BOOK: LedgerPipeBook = {
  produced: [
    // script A sends 100 emails
    P({ outcomeKey: "message_sent", occurrences: 100, costUsd: 10, scriptSlug: "email_sent/dy_a/v2" }),
    // the reply judge (another Engine) makes 2 conversations answering A's emails
    P({ outcomeKey: "conversation", occurrences: 2, costUsd: 0.4, runStartDay: "2026-11-12", scriptSlug: "lead_interested/dy_judge/v1" }),
    // runs naming no script (before runs-service named them): 3 conversations on no Engine
    P({ outcomeKey: "conversation", occurrences: 3, costUsd: 0.3, campaignId: "c2", scriptSlug: null }),
    // another Engine's script
    P({ outcomeKey: "lead_found", occurrences: 50, costUsd: 4, scriptSlug: "lead_found/dy_x/v1" }),
  ],
  noOutput: [{ campaignId: "c1", workflowSlug: null, costUsd: 1, runStartDay: "2026-10-30", scriptSlug: "email_sent/dy_a/v1" }],
  consumed: [
    { consumerKey: "conversation", consumedKey: "message_sent", campaignId: "c1", workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: null, count: 2, runStartDay: "2026-11-12", sourceRunStartDay: "2026-11-10", scriptSlug: "lead_interested/dy_judge/v1", sourceScriptSlug: "email_sent/dy_a/v2" },
  ],
};
const MEASURE = { engine: "email_sent", startsFrom: null, counts: "conversation" };
const facts = new Map<string, ScriptFacts>([
  ["email_sent/dy_a", { key: "email_sent/dy_a", name: "Cold email A", runnable: true, recentRuns: 40, llm: { key: "glm", label: "GLM", provider: "zai" }, template: { key: "three-line", label: "three-line" } }],
  // ran on the board, no cent on the ledger
  ["email_sent/dy_b", { key: "email_sent/dy_b", name: null, runnable: true, recentRuns: 5, llm: null, template: null }],
  // runnable, never ran: no row
  ["email_sent/dy_c", { key: "email_sent/dy_c", name: null, runnable: true, recentRuns: 0, llm: null, template: null }],
]);
const NOW = new Date("2026-11-16T10:00:00Z");
const keyOf = scriptKeyOf(["email_sent/dy_a", "email_sent/dy_b", "email_sent/dy_c"]);

describe("measureScripts", () => {
  const unit = 0.7 / 5; // the conversation's own stage cost: every conversation a no-workflow run made
  const flash = measureScripts({ measure: MEASURE, book: BOOK, view: "flash", matureCutDay: null, keyOf, facts, now: NOW });

  it("lists the Engine's scripts that ran (ledger or board), each measured on its own production, credited the replies to its sends", () => {
    expect(flash.rows.map((r) => r.key)).toEqual(["email_sent/dy_a", "email_sent/dy_b"]);
    const a = flash.rows.find((r) => r.key === "email_sent/dy_a")!;
    expect(a.spentUsd.value).toBeCloseTo(11 + 2 * unit, 10);
    expect(a.outcomes.value).toBe(2);
    expect(a.contacted.value).toBe(100);
    expect(a.conversionRatePct.value).toBeCloseTo(2, 10);
    expect(a.costPerOutcomeUsd.value).toBeCloseTo((11 + 2 * unit) / 2, 10);
    expect(a).toMatchObject({ era: "scripts", status: "active", untested: false, script: { label: "Cold email A" }, llm: { key: "glm" }, template: { key: "three-line" }, writerSource: "script_tactics", spendUnavailableReason: null });
    // a script that ran is never untested, even with no cent on the ledger
    const b = flash.rows.find((r) => r.key === "email_sent/dy_b")!;
    expect(b).toMatchObject({ untested: false, recentRuns: 5, spendUnavailableReason: "ran_with_no_cost_on_ledger", spentUsd: { value: 0 } });
    expect(flash.unplacedOutcomes).toBe(3);
  });

  it("the cumulative series ends on the rows' figures", () => {
    expect(flash.points.map((p) => p.month)).toEqual(["2026-10", "2026-11"]);
    expect(flash.points[0]).toMatchObject({ spentUsd: 1, outcomes: 0 });
    const sum = flash.rows.reduce((s, r) => s + r.spentUsd.value, 0);
    expect(flash.points[1]!.spentUsd).toBeCloseTo(sum, 10);
    expect(flash.points[1]!.outcomes).toBe(2);
  });

  it("mature view: a script with no run in the mature cohort is served on its flash figures, said so", () => {
    const mature = measureScripts({ measure: MEASURE, book: BOOK, view: "mature", matureCutDay: "2026-10-20", keyOf, facts, now: NOW });
    const a = mature.rows.find((r) => r.key === "email_sent/dy_a")!;
    expect(a.basis).toBe("flash");
    expect(a.spentUsd.value).toBeCloseTo(11 + 2 * unit, 10);
    expect(a.maturity.isMature).toBe(false);
  });

  it("a script re-homed under another Engine keeps its runs", () => {
    const k = scriptKeyOf(["email_sent/dy_pushed", "lead_found/dy_two", "email_sent/dy_two"]);
    expect(k("conversation/dy_pushed/v3")).toBe("email_sent/dy_pushed");
    expect(k("conversation/dy_two/v1")).toBe("conversation/dy_two");
    expect(k(null)).toBe("scripts");
  });
});

describe("withMeasureScripts", () => {
  const m: ResearchMeasure = { id: "email_sent/start/conversation", engine: "email_sent", startsFrom: null, counts: { key: "conversation", name: "Conversation" }, description: "" };
  const cnt = (v: number) => ({ value: v, display: String(v) });
  const histRow = (key: string, spent: number, written: boolean, status: "active" | "deprecated") => ({ key, rank: 0, written, status, deprecatedParts: status === "deprecated" ? ["script"] : [], spentUsd: cnt(spent), outcomes: cnt(written ? 1 : 0), contacted: cnt(written ? 100 : 0) });
  const body = {
    rows: [histRow("old|t|l", 0, false, "active"), histRow("old2|t|l", 0, false, "active"), histRow("w1|t|l", 40, true, "deprecated"), histRow("w2|t|l", 60, true, "active")],
    totals: { spentUsd: cnt(100), outcomes: cnt(2), contacted: cnt(200), conversionRatePct: { value: 1 } },
    series: { grain: "month", points: [{ month: "2026-10", outcomes: 2, spentUsd: 100, conversionRatePct: 1 }] },
    totalsUnavailableReason: null,
  };
  const scripts = measureScripts({ measure: MEASURE, book: BOOK, view: "flash", matureCutDay: null, keyOf, facts, now: NOW });
  const out = withMeasureScripts(m, body, { scripts, unavailableReason: null }, { script: "email_sent/dy_a", llm: { key: "glm", name: "GLM" }, template: null }, NOW) as Record<string, any>;

  it("scripts first, then the history that wrote (deprecated); never-written combinations are not listed", () => {
    expect(out.rows.map((r: any) => `${r.rank}:${r.key}:${r.status}`)).toEqual(["1:email_sent/dy_a:active", "2:email_sent/dy_b:active", "3:w1|t|l:deprecated", "4:w2|t|l:deprecated"]);
    expect(out.combinationsNeverRunNotListed).toBe(2);
    expect(out.rows.filter((r: any) => r.status === "active").every((r: any) => !r.untested)).toBe(true);
  });

  it("Σ rows' spend = the totals = the series' last point", () => {
    const rowsSum = out.rows.reduce((s: number, r: any) => s + r.spentUsd.value, 0);
    expect(out.totals.spentUsd.value).toBeCloseTo(rowsSum, 10);
    expect(out.totals.outcomes.value).toBe(4);
    expect(out.totals.contacted.value).toBe(300);
    const last = out.series.points[out.series.points.length - 1];
    expect(last.month).toBe("2026-11");
    expect(last.spentUsd).toBeCloseTo(rowsSum, 10);
    expect(last.conversionRatePct).toBeCloseTo((100 * 4) / 300, 10);
    expect(out.unplacedScriptOutcomes).toBe(3);
  });

  it("served now = the Rating's favourite script and its row", () => {
    expect(out.servedNow).toMatchObject({ script: { key: "email_sent/dy_a", label: "Cold email A" }, llm: { key: "glm", label: "GLM" }, row: { key: "email_sent/dy_a" }, unavailableReason: null });
    const unread = withMeasureScripts(m, body, { scripts: null, unavailableReason: "ledger_book_unreadable" }, undefined, NOW) as Record<string, any>;
    expect(unread).toMatchObject({ scriptsUnavailableReason: "ledger_book_unreadable", servedNow: { unavailableReason: "served_pick_unreadable" } });
    expect(unread.totals.spentUsd.value).toBe(100);
  });
});
