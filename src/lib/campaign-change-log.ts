/**
 * CAMPAIGN-CHANGE-LOG-1119 (owner 2026-11-18: « a dated list of the changes our AI made on a campaign, each with its
 * measured result and a verdict, failures included »). PURE. ONE rule for every Engine, outcome and kind: none is named
 * here (guard `outcome-silver.test.ts`).
 *
 * THE CHANGES, each dated by its owner, never invented:
 *  - SCRIPT changes, read off runs-service's stored script decisions of the campaign's units (`script-reach` by version
 *    and UTC day). An Engine = an outcome; its scripts compete in dynasties. A model is a script of the LLM completion
 *    Engine and a way of writing a script of the writing Engine: their changes are script changes like any other.
 *    GROUPED, so a day of 100 trials is a handful of lines. On each day the Engine ran at least
 *    `MIN_ENGINE_DAY_DECISIONS` decisions for the campaign:
 *     - a dynasty SERVES the Engine once it carries `SERVING_ENTER_SHARE` (20%) of the day's decisions, and stops serving
 *       under `SERVING_LEAVE_SHARE` (5%): two thresholds, so a dynasty hovering around one is not a line a day.
 *       Entering = `script_started`; leaving = `script_stopped`.
 *     - inside a serving dynasty, its leading version changing while the new one carries 20% of the Engine's day =
 *       `script_upgraded` (100 versions tried in a day: at most one line, the one that took the day).
 *     - dynasties not serving, together carrying half the day across at least three of them = ONE `scripts_tried` line.
 *  - CAMPAIGN changes, copied from their owners' journals: its max budget / max volume (billing), its runs paused and
 *    resumed with the reason (campaign-service, grouped per minute and direction), its plan, brief, Target and
 *    follows-its-plan (campaign-service; brief and Target recorded since 2026-11-19), and the strategy kept per Engine
 *    (ours, recorded since 2026-11-19).
 *
 * THE MEASURED RESULT, one rule. The STEP of an Engine: from its own key and every ledger key its decisions PRODUCED
 * (an Engine's Units may be keyed another way in the ledger: read off the decisions, never a table), Silver's fleet
 * transitions out of them measured on at least `MIN_STEP_PAIRS` (10) linked pairs whose maturity fits `MAX_WINDOW_DAYS`
 * (a client reads it within weeks), the shortest median delay. A change on an Engine is measured on that Engine; a
 * campaign-wide change on the campaign's Engine whose step holds the most MATURED cases in its windows (none = said).
 * Rate = decisions whose chain reached the step ÷ decisions, on the decisions the change could affect: the changed
 * script's own for a script change (the new dynasty or version after, what it replaced before; the others after a
 * dynasty stopped), the Engine's whole for a campaign or strategy change. WINDOWS are sized by the step's delay:
 * maturity = its fleet p90 delay in whole days; window = 2 × maturity, from 7 to 28 days, cut at the next / previous
 * change of the same track (the Engine for its scripts and strategy, the campaign for campaign-wide changes).
 * CENSORING like Silver, by day: a decision day counts once it is `maturity` days old.
 *
 * THE VERDICT. Each side's rate is BLENDED like every thin sample of ours (Gamma-Poisson, prior = both sides pooled at
 * `BLEND_PSEUDO_CASES` (10) cases), and P(after > before) is exact (a regularized incomplete beta).
 * `worked` from 0.9, `partial` from 0.7, `did_not_work` up to 0.3, `inconclusive` between. Before any test, in order:
 * no step measured = `inconclusive`; no matured decision after = `too_early` with the day it is measured (or
 * `inconclusive` when the after window matured empty); nothing before = `inconclusive`; another track changing inside
 * either window = `confounded` (never credited with another change's effect); under `THIN_CASES` (10) cases in all or
 * `THIN_DECISIONS` (30) decisions on a side = `inconclusive` (thin evidence: most rows of a young campaign).
 */
import { lnGamma } from "./outcome-estimates.js";
import { BLEND_PSEUDO_CASES } from "./outcome-forecast.js";
import { MIN_DELAY_PAIRS } from "./outcome-silver.js";

export const MIN_ENGINE_DAY_DECISIONS = 5;
export const SERVING_ENTER_SHARE = 0.2;
export const SERVING_LEAVE_SHARE = 0.05;
export const TRIED_SHARE = 0.5;
export const TRIED_MIN_SCRIPTS = 3;
/** A downstream step holds volume once Silver measured its delay on this many linked pairs (its own thin line). */
export const MIN_STEP_PAIRS = MIN_DELAY_PAIRS;
export const WINDOW_MATURITY_MULTIPLE = 2;
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 28;
export const THIN_CASES = 10;
export const THIN_DECISIONS = 30;
export const VERDICT_THRESHOLDS = { worked: 0.9, partial: 0.7, didNotWork: 0.3 } as const;
/** Bump when a rule here changes what a stored list means: it is in the cell's key. */
export const CHANGE_LOG_RULE = "2026-11-19.3";

/** The decisions one script version ran for the campaign on one UTC day, and how many reached each outcome. */
export interface ScriptDayRow {
  /** The Engine: the outcome the script makes. */
  engine: string;
  dynasty: string;
  version: string;
  day: string;
  decisions: number;
  /** outcome -> decisions whose chain reached it (the Engine's own outcome left out). */
  reached: Readonly<Record<string, number>>;
  /** outcome -> decisions that PRODUCED it, as the ledger keys it (an Engine's Units may carry another key than its name). */
  produced: Readonly<Record<string, number>>;
}

export const CHANGE_KINDS = [
  "script_started",
  "script_stopped",
  "script_upgraded",
  "scripts_tried",
  "budget_changed",
  "campaign_stopped",
  "campaign_resumed",
  "plan_changed",
  "brief_changed",
  "target_changed",
  "follows_plan_changed",
  "strategy_changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Who made the change, from positive evidence only (null = the record does not say). */
export type Who = "our_ai" | "a_person" | "our_system";

export interface ChangeSide {
  /** A script: `<outcome>/<dynasty>` and its version. */
  scriptDynasty: string | null;
  version: string | null;
  /** Anything else: the value as its owner recorded it (a strategy id, a target step, a brief, a cap). */
  value: string | null;
  /** The value in words, when the owner's record carries them (a cap: "$10.00 a day"); null = named when served. */
  label: string | null;
}

export interface ChangeEvent {
  id: string;
  /** When it happened: an ISO instant (a script change: its UTC day at midnight). */
  at: string;
  day: string;
  kind: ChangeKind;
  /** The Engine it is about; null = the whole campaign. */
  engine: string | null;
  from: ChangeSide | null;
  to: ChangeSide | null;
  /** Script changes: share of the Engine's decisions that day carried by what the line is about. */
  share: number | null;
  tried: { scripts: number; decisions: number } | null;
  who: Who | null;
  whoEvidence: string | null;
  /** What the owner recorded about why (a stop reason, a plan change reason). */
  reason: string | null;
  /** Campaign pauses: how many of its parts moved, of how many it had. Plan changes: parts added / retired. */
  parts: { moved: number; total: number } | { added: number; retired: number } | null;
}

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
const scriptSide = (engine: string, dynasty: string, version: string | null): ChangeSide => ({ scriptDynasty: `${engine}/${dynasty}`, version, value: null, label: null });

/** PURE. The script changes of a campaign, oldest first, from its script decisions by version and day. */
export function scriptChangeEventsOf(rows: readonly ScriptDayRow[]): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  const base = { who: "our_ai" as const, whoEvidence: "the_rating_picks_the_script", reason: null, parts: null };
  const engines = [...new Set(rows.map((r) => r.engine))].sort();
  for (const engine of engines) {
    const byDay = new Map<string, ScriptDayRow[]>();
    for (const r of rows) if (r.engine === engine && r.decisions > 0) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
    let serving = new Map<string, string>(); // dynasty -> its leading version on the last judged day
    for (const day of [...byDay.keys()].sort()) {
      const at = `${day}T00:00:00.000Z`;
      const dayRows = byDay.get(day)!;
      const total = dayRows.reduce((a, r) => a + r.decisions, 0);
      if (total < MIN_ENGINE_DAY_DECISIONS) continue; // too few decisions to say who serves
      const perDynasty = new Map<string, { decisions: number; versions: Map<string, number> }>();
      for (const r of dayRows) {
        const d = perDynasty.get(r.dynasty) ?? perDynasty.set(r.dynasty, { decisions: 0, versions: new Map() }).get(r.dynasty)!;
        d.decisions += r.decisions;
        d.versions.set(r.version, (d.versions.get(r.version) ?? 0) + r.decisions);
      }
      const leading = (d: { versions: Map<string, number> }) => [...d.versions].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]!;
      const next = new Map<string, string>();
      for (const [dynasty, d] of [...perDynasty].sort((x, y) => x[0].localeCompare(y[0]))) {
        const share = d.decisions / total;
        const [version, versionDecisions] = leading(d);
        const was = serving.get(dynasty);
        if (was === undefined) {
          if (share < SERVING_ENTER_SHARE) continue;
          next.set(dynasty, version);
          events.push({ id: `${day}:${engine}:started:${dynasty}`, at, day, kind: "script_started", engine, from: null, to: scriptSide(engine, dynasty, version), share, tried: null, ...base });
        } else if (share >= SERVING_LEAVE_SHARE) {
          // Still serving. A new leading version is a line only when it carries a meaningful share of the Engine's day.
          const upgraded = version !== was && versionDecisions / total >= SERVING_ENTER_SHARE;
          next.set(dynasty, upgraded ? version : was);
          if (upgraded) events.push({ id: `${day}:${engine}:upgraded:${dynasty}:${version}`, at, day, kind: "script_upgraded", engine, from: scriptSide(engine, dynasty, was), to: scriptSide(engine, dynasty, version), share: versionDecisions / total, tried: null, ...base });
        }
      }
      for (const [dynasty, version] of serving) {
        if (next.has(dynasty)) continue;
        events.push({ id: `${day}:${engine}:stopped:${dynasty}`, at, day, kind: "script_stopped", engine, from: scriptSide(engine, dynasty, version), to: null, share: (perDynasty.get(dynasty)?.decisions ?? 0) / total, tried: null, ...base });
      }
      const others = [...perDynasty].filter(([dynasty]) => !next.has(dynasty));
      const othersDecisions = others.reduce((a, [, d]) => a + d.decisions, 0);
      if (others.length >= TRIED_MIN_SCRIPTS && othersDecisions / total >= TRIED_SHARE) {
        events.push({ id: `${day}:${engine}:tried`, at, day, kind: "scripts_tried", engine, from: null, to: null, share: othersDecisions / total, tried: { scripts: others.length, decisions: othersDecisions }, ...base });
      }
      serving = next;
    }
  }
  return events.sort(byTime);
}

const byTime = (a: ChangeEvent, b: ChangeEvent) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

// ── Campaign changes, copied from their owners' journals ──

export interface CapChangeRecord {
  id: string;
  scope: "sales_funnel_campaign" | "sales_funnel";
  maxBudget: { amountCents: string; period: string | null } | null;
  maxVolume: { count: number; period: string | null } | null;
  changedByUserId: string | null;
  changedAt: string;
}

export interface StatusTransitionRecord {
  id: string;
  campaignId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  source: string;
  occurredAt: string;
}

export interface SettingChangeRecord {
  id: string;
  field: "target" | "brief" | "follows_plan";
  before: string | null;
  after: string | null;
  changedByUserId: string | null;
  source: "edit" | "birth" | "birth_brief" | "target_backfill";
  changedAt: string;
}

export interface PlanChangeRecord {
  id: string;
  fromSalesFunnelId: string;
  toSalesFunnelId: string;
  appliedAt: string;
  reason: string;
  units: Array<{ campaignId: string; action: string }>;
}

export interface StrategyChangeRecord {
  id: string | number;
  campaignId: string;
  outcome: string;
  fromStrategyId: string | null;
  toStrategyId: string | null;
  source: string;
  changedAt: string;
}

const PERIOD_WORDS: Record<string, string> = { daily: "a day", weekly: "a week", monthly: "a month", total: "in total", one_off: "in total" };
const periodWords = (p: string | null) => (p === null ? "" : ` ${PERIOD_WORDS[p] ?? p}`);
export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** PURE. A cap state in words: "$10.00 a day, 500 a week" / "No max budget". */
export function capWords(c: Pick<CapChangeRecord, "maxBudget" | "maxVolume">): string {
  const parts: string[] = [];
  if (c.maxBudget) parts.push(`${usd(Number(c.maxBudget.amountCents))}${periodWords(c.maxBudget.period)}`);
  if (c.maxVolume) parts.push(`${c.maxVolume.count.toLocaleString("en-US")}${periodWords(c.maxVolume.period)}`);
  return parts.length === 0 ? "No max budget" : parts.join(", ");
}

const minuteOf = (iso: string) => iso.slice(0, 16);
const valueSide = (value: string | null, label: string | null = null): ChangeSide => ({ scriptDynasty: null, version: null, value, label });
const quiet = { share: null, tried: null, parts: null };

/**
 * PURE. The campaign changes its owners recorded, oldest first.
 *  - budget: a change of the cap the campaign is HELD to (its own; the funnel-wide one only while it states none of its
 *    own). A person named on the write = `a_person`; none = not said.
 *  - paused / resumed: unit transitions between ongoing and stopped (a birth or an observation is no change), grouped
 *    per minute and direction. Who: a person's stop or start (`sales_funnel`, `patch`) = `a_person`; billing unable to
 *    charge (`payment_hold`) = `our_system`; any other path = not said.
 *  - plan: our AI's plan follower (`plan`) = `our_ai`; another reason = not said.
 *  - brief / Target / follows-its-plan: a person's edit = `a_person`; the brief written from the offer = `our_ai`;
 *    the Target read off its funnel = `our_system`; the birth values are no change.
 *  - strategy: kept by our judge from the brief (`judge`, `empty_brief`) = `our_ai`; carried = `our_system`.
 */
export function campaignChangeEventsOf(input: {
  caps: readonly CapChangeRecord[];
  transitions: readonly StatusTransitionRecord[];
  settings: readonly SettingChangeRecord[];
  plans: readonly PlanChangeRecord[];
  strategies: readonly StrategyChangeRecord[];
}): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  // Budget: replay both scopes in order; a line only when the cap the campaign is held to changes.
  let own: CapChangeRecord | null = null;
  let wide: CapChangeRecord | null = null;
  const stated = (c: CapChangeRecord | null) => c !== null && (c.maxBudget !== null || c.maxVolume !== null);
  const held = () => (stated(own) ? own : wide);
  for (const c of [...input.caps].sort((a, b) => a.changedAt.localeCompare(b.changedAt) || Number(a.id) - Number(b.id))) {
    const before = held();
    if (c.scope === "sales_funnel_campaign") own = c;
    else wide = c;
    const after = held();
    const was = before ? capWords(before) : capWords({ maxBudget: null, maxVolume: null });
    const is = after ? capWords(after) : capWords({ maxBudget: null, maxVolume: null });
    if (was === is) continue;
    events.push({
      id: `budget:${c.id}`,
      at: c.changedAt,
      day: c.changedAt.slice(0, 10),
      kind: "budget_changed",
      engine: null,
      from: valueSide(was, was),
      to: valueSide(is, is),
      ...quiet,
      who: c.changedByUserId ? "a_person" : null,
      whoEvidence: c.changedByUserId ? "changed_by_a_signed_in_person" : null,
      reason: null,
    });
  }

  // Paused / resumed, grouped per minute and direction.
  const units = new Set(input.transitions.map((t) => t.campaignId));
  const groups = new Map<string, StatusTransitionRecord[]>();
  for (const t of input.transitions) {
    const dir = t.fromStatus === "ongoing" && t.toStatus === "stopped" ? "stopped" : t.fromStatus === "stopped" && t.toStatus === "ongoing" ? "resumed" : null;
    if (dir === null || t.source === "record_opened") continue;
    const k = `${minuteOf(t.occurredAt)}\u0000${dir}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  for (const [k, ts] of groups) {
    const dir = k.split("\u0000")[1] as "stopped" | "resumed";
    const first = [...ts].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0]!;
    const sources = new Set(ts.map((t) => t.source));
    const reasons = [...new Set(ts.map((t) => t.reason).filter((r): r is string => r !== null))].sort();
    const byPerson = [...sources].every((s) => s === "sales_funnel" || s === "patch");
    const byBilling = [...sources].every((s) => s === "payment_hold");
    events.push({
      id: `status:${first.id}`,
      at: first.occurredAt,
      day: first.occurredAt.slice(0, 10),
      kind: dir === "stopped" ? "campaign_stopped" : "campaign_resumed",
      engine: null,
      from: null,
      to: null,
      share: null,
      tried: null,
      parts: { moved: new Set(ts.map((t) => t.campaignId)).size, total: units.size },
      who: byPerson ? "a_person" : byBilling ? "our_system" : null,
      whoEvidence: byPerson ? "started_or_stopped_by_hand" : byBilling ? "billing_could_not_charge" : null,
      reason: reasons.join(",") || null,
    });
  }

  for (const p of input.plans) {
    events.push({
      id: `plan:${p.id}`,
      at: p.appliedAt,
      day: p.appliedAt.slice(0, 10),
      kind: "plan_changed",
      engine: null,
      from: valueSide(p.fromSalesFunnelId),
      to: valueSide(p.toSalesFunnelId),
      share: null,
      tried: null,
      parts: { added: p.units.filter((u) => u.action === "born").length, retired: p.units.filter((u) => u.action === "draining").length },
      who: p.reason === "plan" ? "our_ai" : null,
      whoEvidence: p.reason === "plan" ? "the_plan_follower_applied_its_plan" : null,
      reason: p.reason,
    });
  }

  for (const s of input.settings) {
    if (s.source === "birth") continue;
    const who: Who | null = s.source === "edit" ? (s.changedByUserId ? "a_person" : null) : s.source === "birth_brief" ? "our_ai" : "our_system";
    events.push({
      id: `setting:${s.id}`,
      at: s.changedAt,
      day: s.changedAt.slice(0, 10),
      kind: s.field === "brief" ? "brief_changed" : s.field === "target" ? "target_changed" : "follows_plan_changed",
      engine: null,
      from: valueSide(s.before),
      to: valueSide(s.after),
      ...quiet,
      who,
      whoEvidence: who === "a_person" ? "changed_by_a_signed_in_person" : s.source === "birth_brief" ? "written_by_our_ai_from_the_offer" : s.source === "target_backfill" ? "read_off_its_funnel" : null,
      reason: null,
    });
  }

  // Strategy kept per Engine: the same move on several units in one minute is one line.
  const strat = new Map<string, StrategyChangeRecord[]>();
  for (const s of input.strategies) {
    const k = `${minuteOf(s.changedAt)}\u0000${s.outcome}\u0000${s.fromStrategyId ?? ""}\u0000${s.toStrategyId ?? ""}`;
    (strat.get(k) ?? strat.set(k, []).get(k)!).push(s);
  }
  for (const ss of strat.values()) {
    const s = ss[0]!;
    const byJudge = s.source === "judge" || s.source === "empty_brief";
    events.push({
      id: `strategy:${s.id}`,
      at: s.changedAt,
      day: s.changedAt.slice(0, 10),
      kind: "strategy_changed",
      engine: s.outcome,
      from: valueSide(s.fromStrategyId),
      to: valueSide(s.toStrategyId),
      ...quiet,
      who: byJudge ? "our_ai" : s.source === "carried" ? "our_system" : null,
      whoEvidence: byJudge ? "our_judge_keeps_it_from_the_brief" : s.source === "carried" ? "carried_from_the_campaign_play" : null,
      reason: null,
    });
  }
  return events.sort(byTime);
}

// ── The measured result and the verdict ──

/** Regularized incomplete beta I_x(a, b) (Numerical Recipes: continued fraction). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx: number, aa: number, bb: number): number => {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 400; m++) {
      const m2 = 2 * m;
      let an = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + an * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + an / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      an = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + an * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + an / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (front * cf(x, a, b)) / a : 1 - (front * cf(1 - x, b, a)) / b;
}

/**
 * PURE. P(rate after > rate before). Each side is blended like every thin sample of ours (THIN-SAMPLE-BLEND-1118):
 * a Gamma-Poisson posterior whose prior is both sides POOLED, worth `BLEND_PSEUDO_CASES` cases, so a few cases barely
 * move it. With X ~ Gamma(a1, b1) before and Y ~ Gamma(a2, b2) after, P(Y > X) = I_{b1 / (b1 + b2)}(a1, a2): exact.
 */
export function probabilityAfterIsBetter(before: { cases: number; decisions: number }, after: { cases: number; decisions: number }): number {
  const pooled = Math.max(before.cases + after.cases, 0.5) / (before.decisions + after.decisions);
  const K = BLEND_PSEUDO_CASES;
  const b1 = K / pooled + before.decisions;
  const b2 = K / pooled + after.decisions;
  return regularizedBeta(b1 / (b1 + b2), K + before.cases, K + after.cases);
}

export type Verdict = "worked" | "partial" | "did_not_work" | "inconclusive" | "too_early" | "confounded";
export type VerdictReason = "no_downstream_step_measured" | "step_slower_than_window" | "no_step_readable_within_window" | "no_decisions_after" | "nothing_before_to_compare" | "thin_evidence" | "after_window_not_matured" | "another_change_in_the_window" | "tested";

export interface WindowStat {
  /** First and last UTC day counted (matured days only); null = none. */
  fromDay: string | null;
  toDay: string | null;
  decisions: number;
  /** Decisions that reached the step. */
  cases: number;
  /** cases ÷ decisions; null without a decision. */
  rate: number | null;
}

/** The nearest downstream step of an Engine with volume, and its fleet delay. */
export interface DownstreamStep {
  step: string;
  /** Linked pairs the delay was measured on. */
  pairs: number;
  medianHours: number;
  p90Hours: number;
}

export interface ChangeResult {
  /** The Engine whose decisions were measured; null = none to measure. */
  measuredEngine: string | null;
  step: string | null;
  /** A decision day counts once it is this many days old (the step's fleet p90 delay). */
  maturityDays: number | null;
  windowDays: number | null;
  before: WindowStat | null;
  after: WindowStat | null;
  /** P(the rate after is higher than before); null = not tested. */
  probabilityBetter: number | null;
  verdict: Verdict;
  verdictReason: VerdictReason;
  /** `too_early`: the first UTC day a rate after the change can be read. */
  measuredOn: string | null;
  /** The other changes dated inside its windows. */
  confoundedWith: string[];
}

const windowOf = (rows: readonly ScriptDayRow[], step: string): WindowStat => {
  const days = rows.map((r) => r.day).sort();
  const decisions = rows.reduce((a, r) => a + r.decisions, 0);
  const cases = rows.reduce((a, r) => a + (r.reached[step] ?? 0), 0);
  return { fromDay: days[0] ?? null, toDay: days[days.length - 1] ?? null, decisions, cases, rate: decisions > 0 ? cases / decisions : null };
};

export interface FleetTransition {
  fromKey: string;
  toKey: string;
  pairs: number;
  medianHours: number;
  p90Hours: number;
}

/** PURE. A step's delay in whole days (at least one), and the window it sizes. */
export const maturityDaysOf = (s: Pick<DownstreamStep, "p90Hours">) => Math.max(1, Math.ceil(s.p90Hours / 24));
export const windowDaysOf = (maturityDays: number) => Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, WINDOW_MATURITY_MULTIPLE * maturityDays));

/** PURE. Per Engine, the ledger keys its own decisions PRODUCED (read off the decisions, never a table keyed on a name). */
export function ledgerKeysOf(rows: readonly ScriptDayRow[]): Map<string, string[]> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.engine) ?? out.set(r.engine, new Map()).get(r.engine)!;
    for (const [k, n] of Object.entries(r.produced)) if (n > 0) m.set(k, (m.get(k) ?? 0) + n);
  }
  return new Map([...out].map(([e, m]) => [e, [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k]) => k)]));
}

export type StepPick = { step: DownstreamStep; reason: null } | { step: null; reason: "no_downstream_step_measured" | "step_slower_than_window" };

/**
 * PURE. The step an Engine's decisions are measured on: the nearest downstream step with volume a client can read
 * within the window. From-keys = the Engine's own key and every ledger key its decisions produced; candidates = Silver's
 * fleet transitions out of them measured on at least `MIN_STEP_PAIRS` pairs, to a key that is not one of them; of those
 * whose maturity (p90 delay in days) fits `MAX_WINDOW_DAYS`, the shortest median delay (then the most pairs, the key).
 */
export function engineStepOf(engine: string, ledgerKeys: readonly string[], transitions: readonly FleetTransition[]): StepPick {
  const from = new Set([engine, ...ledgerKeys]);
  const candidates = transitions.filter((t) => from.has(t.fromKey) && !from.has(t.toKey) && t.pairs >= MIN_STEP_PAIRS);
  if (candidates.length === 0) return { step: null, reason: "no_downstream_step_measured" };
  const readable = candidates.filter((t) => maturityDaysOf(t) <= MAX_WINDOW_DAYS);
  if (readable.length === 0) return { step: null, reason: "step_slower_than_window" };
  const best = [...readable].sort((x, y) => x.medianHours - y.medianHours || y.pairs - x.pairs || x.toKey.localeCompare(y.toKey))[0]!;
  return { step: { step: best.toKey, pairs: best.pairs, medianHours: best.medianHours, p90Hours: best.p90Hours }, reason: null };
}

const trackOf = (e: ChangeEvent) => e.engine ?? "\u0000campaign";

/**
 * PURE. The measured result and the verdict of one change. `stepOf` = the step an Engine is measured on (or why none);
 * `today` = the UTC day ages are counted to. A change on an Engine is measured on that Engine. A campaign-wide change
 * is measured on the campaign's Engine whose step holds the most MATURED cases in its windows (then decisions, then
 * key), among the Engines whose step fits the window; none = inconclusive, never a date months away.
 */
export function changeResultOf(event: ChangeEvent, events: readonly ChangeEvent[], rows: readonly ScriptDayRow[], stepOf: (engine: string) => StepPick, today: string): ChangeResult {
  const none = { before: null, after: null, probabilityBetter: null, measuredOn: null, confoundedWith: [] as string[] };
  const track = trackOf(event);
  const measure = (engine: string, step: DownstreamStep) => {
    const maturityDays = maturityDaysOf(step);
    const windowDays = windowDaysOf(maturityDays);
    // The track's own next / previous change ends the windows: each window holds ONE state of the track.
    const sameTrack = events.filter((e) => e.id !== event.id && trackOf(e) === track).map((e) => e.day);
    const nextChange = sameTrack.filter((d) => d > event.day).sort()[0] ?? null;
    const prevChange = sameTrack.filter((d) => d < event.day).sort().reverse()[0] ?? null;
    const afterEnd = [addDays(event.day, windowDays), nextChange].filter((d): d is string => d !== null).sort()[0]!; // exclusive
    const beforeStart = [addDays(event.day, -windowDays), prevChange].filter((d): d is string => d !== null).sort().reverse()[0]!; // inclusive
    const engineRows = rows.filter((r) => r.engine === engine);
    const dynastyOf = (side: ChangeSide | null) => (side?.scriptDynasty ? side.scriptDynasty.slice(engine.length + 1) : null);
    const inAfter = (r: ScriptDayRow) => r.day >= event.day && r.day < afterEnd;
    const inBefore = (r: ScriptDayRow) => r.day >= beforeStart && r.day < event.day;
    let after: ScriptDayRow[];
    let before: ScriptDayRow[];
    if (event.kind === "script_started") {
      after = engineRows.filter((r) => inAfter(r) && r.dynasty === dynastyOf(event.to));
      before = engineRows.filter(inBefore);
    } else if (event.kind === "script_upgraded") {
      after = engineRows.filter((r) => inAfter(r) && r.dynasty === dynastyOf(event.to) && r.version === event.to!.version);
      before = engineRows.filter((r) => inBefore(r) && r.dynasty === dynastyOf(event.from) && r.version === event.from!.version);
    } else if (event.kind === "script_stopped") {
      after = engineRows.filter((r) => inAfter(r) && r.dynasty !== dynastyOf(event.from));
      before = engineRows.filter((r) => inBefore(r) && r.dynasty === dynastyOf(event.from));
    } else if (event.kind === "scripts_tried") {
      // The scripts tried that day (those not serving), against the Engine's days before.
      const serving = new Set<string | null>();
      for (const e of events) {
        if (e.engine !== engine || e.day > event.day) continue;
        if (e.kind === "script_started") serving.add(dynastyOf(e.to));
        if (e.kind === "script_stopped") serving.delete(dynastyOf(e.from));
      }
      after = engineRows.filter((r) => r.day === event.day && !serving.has(r.dynasty));
      before = engineRows.filter(inBefore);
    } else {
      // A campaign or strategy change: every decision of the Engine.
      after = engineRows.filter(inAfter);
      before = engineRows.filter(inBefore);
    }
    const matured = (r: ScriptDayRow) => addDays(r.day, maturityDays) <= today;
    return { engine, step, maturityDays, windowDays, afterEnd, beforeStart, after, a: windowOf(after.filter(matured), step.step), b: windowOf(before.filter(matured), step.step) };
  };

  let m: ReturnType<typeof measure>;
  if (event.engine !== null) {
    const pick = stepOf(event.engine);
    if (pick.step === null) return { measuredEngine: event.engine, step: null, maturityDays: null, windowDays: null, ...none, verdict: "inconclusive", verdictReason: pick.reason };
    m = measure(event.engine, pick.step);
  } else {
    const candidates = [...new Set(rows.map((r) => r.engine))]
      .sort()
      .flatMap((e) => {
        const pick = stepOf(e);
        return pick.step === null ? [] : [measure(e, pick.step)];
      });
    const best = candidates.sort((x, y) => y.a.cases + y.b.cases - (x.a.cases + x.b.cases) || y.a.decisions + y.b.decisions - (x.a.decisions + x.b.decisions) || x.engine.localeCompare(y.engine))[0];
    if (!best) return { measuredEngine: null, step: null, maturityDays: null, windowDays: null, ...none, verdict: "inconclusive", verdictReason: "no_step_readable_within_window" };
    m = best;
  }
  const { a, b, after, afterEnd, beforeStart, maturityDays } = m;
  const base = { measuredEngine: m.engine, step: m.step.step, maturityDays, windowDays: m.windowDays, before: b, after: a };
  if (a.decisions === 0) {
    const firstAfter = after.map((r) => r.day).sort()[0] ?? null;
    // The whole after window is old enough and holds no decision: nothing ran to measure.
    if (firstAfter === null && addDays(addDays(afterEnd, -1), maturityDays) <= today) return { ...base, probabilityBetter: null, verdict: "inconclusive", verdictReason: "no_decisions_after", measuredOn: null, confoundedWith: [] };
    return { ...base, probabilityBetter: null, verdict: "too_early", verdictReason: "after_window_not_matured", measuredOn: addDays(firstAfter ?? event.day, maturityDays), confoundedWith: [] };
  }
  if (b.decisions === 0) return { ...base, probabilityBetter: null, verdict: "inconclusive", verdictReason: "nothing_before_to_compare", measuredOn: null, confoundedWith: [] };
  // Another track changing inside either window moves the step too: the effect cannot be told apart.
  const confoundedWith = events.filter((e) => e.id !== event.id && trackOf(e) !== track && e.day >= beforeStart && e.day < afterEnd).map((e) => e.id);
  if (confoundedWith.length > 0) return { ...base, probabilityBetter: null, verdict: "confounded", verdictReason: "another_change_in_the_window", measuredOn: null, confoundedWith };
  if (a.cases + b.cases < THIN_CASES || Math.min(a.decisions, b.decisions) < THIN_DECISIONS) return { ...base, probabilityBetter: null, verdict: "inconclusive", verdictReason: "thin_evidence", measuredOn: null, confoundedWith: [] };
  const p = probabilityAfterIsBetter({ cases: b.cases, decisions: b.decisions }, { cases: a.cases, decisions: a.decisions });
  const verdict: Verdict = p >= VERDICT_THRESHOLDS.worked ? "worked" : p >= VERDICT_THRESHOLDS.partial ? "partial" : p <= VERDICT_THRESHOLDS.didNotWork ? "did_not_work" : "inconclusive";
  return { ...base, probabilityBetter: p, verdict, verdictReason: "tested", measuredOn: null, confoundedWith: [] };
}

// ── The served list ──

export interface ServedSide {
  scriptDynasty: string | null;
  version: string | null;
  value: string | null;
  label: string;
}

export interface ServedChange {
  id: string;
  at: string;
  date: string;
  kind: ChangeKind;
  /** The Engine it is about; null = the whole campaign. */
  engine: { outcomeKey: string; label: string } | null;
  from: ServedSide | null;
  to: ServedSide | null;
  /** The change in words a client reads. */
  summary: string;
  who: Who | null;
  whoEvidence: string | null;
  reason: string | null;
  shareOfEngineDay: number | null;
  tried: { scripts: number; decisions: number } | null;
  parts: ChangeEvent["parts"];
  result: Omit<ChangeResult, "step" | "measuredEngine"> & {
    measuredEngine: { outcomeKey: string; label: string } | null;
    step: { outcomeKey: string; label: string } | null;
    /** (after − before) ÷ before, in %, one decimal; null without both rates or with a zero before. */
    changePct: number | null;
  };
}

const wordsOf = (slug: string) => {
  const w = slug.replace(/^dy_/, "").split("_").filter(Boolean).join(" ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const versionWords = (v: string | null) => (v === null ? "" : `version ${v.replace(/^v/, "")}`);
const STOP_REASON_WORDS: Record<string, string> = {
  manual: "paused by hand",
  payment_declined: "card declined",
  no_payment_method: "no card on file",
  org_teardown: "account closed",
};

/**
 * PURE. The campaign's changes, newest first, each with its result and verdict. `scriptLabel` = a dynasty's
 * client-readable name (null = not named: its slug in words); `strategyLabel` = a strategy's name; `outcomeLabel` =
 * the catalogue's label of an outcome.
 */
export function campaignChangesOf(input: {
  rows: readonly ScriptDayRow[];
  campaignEvents: readonly ChangeEvent[];
  /** Silver's fleet transitions with a measured delay. */
  transitions: readonly FleetTransition[];
  today: string;
  scriptLabel: (scriptDynasty: string) => string | null;
  strategyLabel: (strategyId: string) => string | null;
  outcomeLabel: (outcomeKey: string) => string;
}): ServedChange[] {
  const events = [...scriptChangeEventsOf(input.rows), ...input.campaignEvents].sort(byTime);
  const keys = ledgerKeysOf(input.rows);
  const picks = new Map<string, StepPick>();
  const stepOf = (engine: string) => picks.get(engine) ?? picks.set(engine, engineStepOf(engine, keys.get(engine) ?? [], input.transitions)).get(engine)!;
  const sideOf = (e: ChangeEvent, side: ChangeSide | null): ServedSide | null => {
    if (side === null) return null;
    let label: string;
    if (side.scriptDynasty !== null) label = input.scriptLabel(side.scriptDynasty) ?? wordsOf(side.scriptDynasty.split("/").slice(1).join("/"));
    else if (side.label !== null) label = side.label;
    else if (e.kind === "strategy_changed") label = side.value === null ? "No strategy" : (input.strategyLabel(side.value) ?? wordsOf(side.value));
    else if (e.kind === "target_changed") label = side.value === null ? "No Target" : input.outcomeLabel(side.value);
    else if (e.kind === "follows_plan_changed") label = side.value === "yes" ? "Follows its plan" : "Keeps its steps";
    else label = side.value ?? "None";
    return { scriptDynasty: side.scriptDynasty, version: side.version, value: side.value, label };
  };
  return events
    .map((e): ServedChange => {
      const result = changeResultOf(e, events, input.rows, stepOf, input.today);
      const engine = e.engine === null ? null : { outcomeKey: e.engine, label: input.outcomeLabel(e.engine) };
      const from = sideOf(e, e.from);
      const to = sideOf(e, e.to);
      const on = engine ? `${engine.label}: ` : "";
      const parts = e.parts as { moved?: number; total?: number; added?: number; retired?: number } | null;
      const share = parts && parts.moved !== undefined && parts.total !== undefined && parts.moved < parts.total ? ` (${parts.moved} of its ${parts.total} parts)` : "";
      const why = e.reason ? STOP_REASON_WORDS[e.reason] : undefined;
      const summary =
        e.kind === "script_started" ? `${on}started using ${to!.label}`
        : e.kind === "script_stopped" ? `${on}stopped using ${from!.label}`
        : e.kind === "script_upgraded" ? `${on}${to!.label} upgraded from ${versionWords(from!.version)} to ${versionWords(to!.version)}`
        : e.kind === "scripts_tried" ? `${on}tried ${e.tried!.scripts} scripts in one day`
        : e.kind === "budget_changed" ? `Max budget: ${from!.label} to ${to!.label}`
        : e.kind === "campaign_stopped" ? `Campaign paused${share}${why ? `: ${why}` : ""}`
        : e.kind === "campaign_resumed" ? `Campaign resumed${share}`
        : e.kind === "plan_changed" ? `New plan: ${parts?.added ?? 0} steps added, ${parts?.retired ?? 0} retired`
        : e.kind === "brief_changed" ? (to!.value === null ? "Brief cleared" : from!.value === null ? "Brief written" : "Brief rewritten")
        : e.kind === "target_changed" ? `Target: ${from!.label} to ${to!.label}`
        : e.kind === "follows_plan_changed" ? (to!.value === "yes" ? "Now follows its plan" : "Stopped following its plan")
        : `${on}strategy ${from!.label} to ${to!.label}`;
      const { step, measuredEngine, ...rest } = result;
      const changePct = result.before?.rate && result.after && result.after.rate !== null && result.before.rate > 0 ? Math.round(((result.after.rate - result.before.rate) / result.before.rate) * 1000) / 10 : null;
      return {
        id: e.id,
        at: e.at,
        date: e.day,
        kind: e.kind,
        engine,
        from,
        to,
        summary,
        who: e.who,
        whoEvidence: e.whoEvidence,
        reason: e.reason,
        shareOfEngineDay: e.share === null ? null : Math.round(e.share * 1000) / 1000,
        tried: e.tried,
        parts: e.parts,
        result: {
          ...rest,
          measuredEngine: measuredEngine === null ? null : { outcomeKey: measuredEngine, label: input.outcomeLabel(measuredEngine) },
          step: step === null ? null : { outcomeKey: step, label: input.outcomeLabel(step) },
          changePct,
        },
      };
    })
    .reverse();
}
