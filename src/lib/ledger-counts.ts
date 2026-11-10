/**
 * LEDGER-ONLY-1107-P2 (owner 2026-11-07, « TOUS LES CHIFFRES DOIVENT ETRE ISSUS DE LA COMPTA INDUSTRIELLE!!! SUPPRIME TOUS LES
 * AUTRES CHIFFRES NON COMPLIANT DE NOTRE BACKEND … ERADICATION »; doctrine: agent-config skill `cost-accounting`). PURE.
 *
 * Every COUNT a revenue / stats body serves is the scope's Units of an outcome in the general ledger (runs-service), every
 * $ / outcome is the scope's spend ÷ those Units (actual, full absorption), every conversion is Units of the outcome ÷
 * Units of the step before it (the yield). A figure with no ledger twin (people contacted, opened, delivered, bounced:
 * no catalogue outcome, `message_sent` counts MESSAGES) is served null + `not_a_ledger_outcome`; an outcome the ledger
 * lacks is null + the ledger's reason (`outcome_not_declared_in_ledger`, producer gap named). Never the old count beside.
 *
 * ONE resolver from a catalogue STEP to its ledger outcome keys (`ledgerKeysOfStep`): the step itself, except a step that
 * is the ONLY evidence of its lead state (a click is the only way to `lead_visited`): runs-service declares that state,
 * never the event. Read off `CODED_STEP_LEAD_STATES`, never a list.
 *
 * LEDGER-OTHER-FACTORY-1107: a COUNT is the TOTAL Units (ours + another factory's), a conversion divides totals; every
 * MONEY figure ($ per outcome, the learning price, the cost curve, a value) divides OUR Units only (`ourUnits`).
 */
import { CODED_STEP_LEAD_STATES, leadStateOf } from "./lead-states.js";
import { funnelLeg } from "./funnel-legs.js";
import { scopeOutcomeLedgerRowOf, standingUnitsByDay, type OtherFactoryUnits, type LedgerProducerGap, type ScopeOutcomeLedgerInput, type ScopeOutcomeLedgerRow } from "./scope-outcome-ledger.js";

export const NOT_A_LEDGER_OUTCOME = "not_a_ledger_outcome";

/** PURE. The ledger keys a catalogue step's Units are declared under. */
export function ledgerKeysOfStep(step: string): string[] {
  const state = leadStateOf(step);
  if (state === null || state === step) return [step];
  const siblings = Object.entries(CODED_STEP_LEAD_STATES).filter(([, s]) => s === state).map(([k]) => k);
  return siblings.length === 1 && siblings[0] === step ? [state] : [step];
}

/** A scope's ledger (or why there is none). */
export type LedgerScope = { ledger: ScopeOutcomeLedgerInput; unavailableReason: null } | { ledger: null; unavailableReason: string };

export const ledgerScopeOf = (ledger: ScopeOutcomeLedgerInput | null, reason = "ledger_unreadable"): LedgerScope =>
  ledger === null ? { ledger: null, unavailableReason: reason } : { ledger, unavailableReason: null };

export interface LedgerCount {
  /** TOTAL Units, every source. */
  units: number | null;
  /** OUR factory's Units: the only divisor of a money figure. */
  ourUnits: number | null;
  otherFactoryUnits: OtherFactoryUnits | null;
  reason: string | null;
  producerGap: LedgerProducerGap | null;
  row: ScopeOutcomeLedgerRow | null;
}

/** PURE. The scope's Units of a catalogue step. */
export function ledgerCountOfStep(scope: LedgerScope, step: string): LedgerCount {
  if (scope.ledger === null) return { units: null, ourUnits: null, otherFactoryUnits: null, reason: scope.unavailableReason, producerGap: null, row: null };
  const row = scopeOutcomeLedgerRowOf(ledgerKeysOfStep(step), scope.ledger);
  return { units: row.units, ourUnits: row.ourUnits, otherFactoryUnits: row.otherFactoryUnits, reason: row.unitsUnavailableReason, producerGap: row.producerGap, row };
}

export interface LedgerSignalSeries {
  total: number;
  daily: Array<{ date: string; count: number }>;
  undatedCount: number;
}

/** PURE. A `{total, daily, undatedCount}` series from a ledger row (null when the ledger cannot state it). */
export function ledgerSeriesOf(c: LedgerCount): LedgerSignalSeries | null {
  if (c.units === null || c.row === null) return null;
  return { total: c.units, daily: c.row.past.filter((p) => p.units > 0).map((p) => ({ date: p.date, count: p.units })), undatedCount: 0 };
}

const div = (num: number | null | undefined, den: number | null): number | null =>
  num === null || num === undefined || den === null || den <= 0 || num <= 0 ? null : num / den;
const pct = (num: number | null, den: number | null): number | null => (num === null || den === null || den <= 0 ? null : (num / den) * 100);

/** The series fields of a revenue body and the catalogue step each counts. `null` = no ledger twin. */
const SERIES_STEPS: Record<string, string | null> = {
  recipientsContacted: null,
  recipientsOpened: null,
  recipientsClicked: "website_visit",
  recipientsRepliesPositive: "conversation",
  meetingsBooked: "meeting_booked",
  purchased: "paid_client",
  signups: "signup",
  formSubmissions: "form_submitted",
  sequences: "message_sent",
};

/** The `spend` block's count fields → their step, and the cost fields dividing that count. */
const SPEND_COUNTS: Array<{ count: string | null; costs: string[]; step: string }> = [
  { count: null, costs: ["totalCpcCents", "actualCpcCents", "provisionedCpcCents"], step: "website_visit" },
  { count: "positiveRepliesCount", costs: ["cpprCents"], step: "conversation" },
  { count: "signupsCount", costs: ["cpsCents"], step: "signup" },
  { count: "salesMeetingsCount", costs: ["cpsmCents"], step: "meeting_booked" },
  { count: "formSubmissionsCount", costs: ["cpfsCents"], step: "form_submitted" },
  { count: "salesCount", costs: ["cpSaleCents"], step: "paid_client" },
];
const SPEND_NUMERATOR: Record<string, string> = { totalCpcCents: "totalSpentCents", actualCpcCents: "actualSpentCents", provisionedCpcCents: "provisionedSpentCents" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The `ledgerCounts` block every re-based body carries: which fields are ledger, which null and why, producer gaps. */
export interface LedgerCountsBlock {
  basis: "ledger";
  scope: string;
  unavailableReason: string | null;
  /** field path -> why it is null (no ledger twin, the ledger lacks the outcome, unreadable). */
  nullFields: Record<string, string>;
  /** outcome key -> the producer gap (who must declare it). */
  producerGaps: Record<string, LedgerProducerGap>;
  /** LEDGER-OTHER-FACTORY-1107: outcome key -> the Units of it another factory produced (in the counts, in no money figure). */
  otherFactoryUnits: Record<string, OtherFactoryUnits>;
  ledgerDaysMissing: string[];
}

function recorder(scope: LedgerScope, label: string) {
  const block: LedgerCountsBlock = {
    basis: "ledger",
    scope: label,
    unavailableReason: scope.unavailableReason,
    nullFields: {},
    producerGaps: {},
    otherFactoryUnits: {},
    ledgerDaysMissing: scope.ledger?.daysMissing ? [...scope.ledger.daysMissing] : [],
  };
  const count = (field: string, step: string | null): LedgerCount => {
    if (step === null) {
      block.nullFields[field] = NOT_A_LEDGER_OUTCOME;
      return { units: null, ourUnits: null, otherFactoryUnits: null, reason: NOT_A_LEDGER_OUTCOME, producerGap: null, row: null };
    }
    const c = ledgerCountOfStep(scope, step);
    if (c.otherFactoryUnits !== null && c.otherFactoryUnits.total > 0 && c.row) block.otherFactoryUnits[c.row.outcomeKeys.join("+")] = c.otherFactoryUnits;
    if (c.units === null) {
      block.nullFields[field] = c.reason ?? "ledger_unreadable";
      if (c.producerGap) for (const k of c.row?.outcomeKeys ?? ledgerKeysOfStep(step)) block.producerGaps[k] = c.producerGap;
    }
    return c;
  };
  const drop = (field: string, reason = NOT_A_LEDGER_OUTCOME) => {
    block.nullFields[field] = reason;
    return null;
  };
  return { block, count, drop };
}

/**
 * PURE. A revenue body (or a lean group) with every count / $ per outcome / conversion / curve re-based on the scope's
 * ledger, `ledgerCounts` beside it. Lists of people (`leads[]`, `organizations[]`, `events`) are records, untouched.
 */
export function withLedgerCounts<T extends object>(body: T, scope: LedgerScope, label: string): T {
  const out: Obj = { ...(body as Obj) };
  const { block, count, drop } = recorder(scope, label);

  for (const [field, step] of Object.entries(SERIES_STEPS)) {
    if (!(field in out)) continue;
    out[field] = step === null ? drop(field) : ledgerSeriesOf(count(field, step));
  }

  if (isObj(out.spend)) {
    const s: Obj = { ...out.spend };
    for (const { count: cf, costs, step } of SPEND_COUNTS) {
      const c = count(`spend.${cf ?? costs[0]}`, step);
      if (cf && cf in s) s[cf] = c.units;
      for (const f of costs) if (f in s) s[f] = div(s[SPEND_NUMERATOR[f] ?? "totalSpentCents"] as number, c.ourUnits);
    }
    if ("maturity" in s) s.maturity = drop("spend.maturity");
    out.spend = s;
  }

  if (isObj(out.outcomes)) {
    const o: Obj = { ...out.outcomes };
    for (const f of ["recipientsContacted", "recipientsConvertible", "recipientsBounced", "recipientsUnsubscribed"]) if (f in o) o[f] = drop(`outcomes.${f}`);
    const clicks = count("outcomes.recipientsClicked", "website_visit");
    const replies = count("outcomes.recipientsRepliesPositive", "conversation");
    if ("recipientsClicked" in o) o.recipientsClicked = clicks.units;
    if ("recipientsRepliesPositive" in o) o.recipientsRepliesPositive = replies.units;
    if ("cpcCents" in o) o.cpcCents = div(o.committedSpentCents as number, clicks.ourUnits);
    if ("cpprCents" in o) o.cpprCents = div(o.committedSpentCents as number, replies.ourUnits);
    if ("sending" in o) o.sending = drop("outcomes.sending");
    if ("maturity" in o) o.maturity = drop("outcomes.maturity");
    out.outcomes = o;
  }

  if (isObj(out.funnelSteps)) {
    const fs: Obj = { ...out.funnelSteps };
    const spent = fs.committedSpentCents as number;
    fs.contactedRecipients = drop("funnelSteps.contactedRecipients");
    fs.convertibleRecipients = drop("funnelSteps.convertibleRecipients");
    let prev: number | null = null;
    fs.steps = ((fs.steps as Obj[]) ?? []).map((st, i) => {
      const toStep = funnelLeg(String(st.legKey))?.toStep.key ?? null;
      const c = toStep === null ? { units: null, ourUnits: null, otherFactoryUnits: null, reason: "leg_unrecognised" } : count(`funnelSteps.steps[${st.legKey}].recipientsReached`, toStep);
      const from = i === 0 ? null : prev;
      prev = c.units;
      return {
        ...st,
        recipientsReached: c.units,
        costPerReachCents: div(spent, c.ourUnits),
        ratioBasisRecipientsReached: c.units,
        fromRecipientsReached: from,
        recipientsThroughLeg: from === null ? null : c.units,
        conversionFromPreviousPct: from === null ? null : pct(c.units, from),
      };
    });
    if (isObj(fs.ratioBasis)) fs.ratioBasis = { ...fs.ratioBasis, committedSpentCents: spent, unmeasuredReason: null };
    out.funnelSteps = fs;
  }

  if (isObj(out.costPerOutcomeHistory)) {
    const h = out.costPerOutcomeHistory as Obj & { outcomeStep?: { key?: string }; daily?: Array<Obj & { date: string; cumulativeSpendUsd: number }> };
    const c = h.outcomeStep?.key ? count("costPerOutcomeHistory", h.outcomeStep.key) : { units: null, row: null };
    if (c.units === null || c.row === null) out.costPerOutcomeHistory = null;
    else {
      const daily = (h.daily ?? []).map((p) => {
        // A cost curve divides OUR Units only (another factory's carry none of our cost).
        const n = cumulativeAt(c.row!, p.date, true);
        return { ...p, cumulativeOutcomes: n, costPerOutcomeUsd: div(p.cumulativeSpendUsd, n) };
      });
      out.costPerOutcomeHistory = { ...h, isMature: null, outcomeObserved: true, daily, datedOutcomes: c.row.ourUnits, undatedOutcomes: 0 };
    }
  }

  if (isObj(out.conversionRateHistory)) {
    const h = out.conversionRateHistory as Obj & { legKey?: string; daily?: Array<Obj & { date: string }> };
    const leg = h.legKey ? funnelLeg(h.legKey) : null;
    const to = leg ? count("conversionRateHistory", leg.toStep.key) : { units: null, row: null };
    const from = leg?.fromStep ? count("conversionRateHistory.from", leg.fromStep.key) : { units: null, row: null };
    if (to.units === null || to.row === null || from.units === null || from.row === null) {
      if (!leg?.fromStep) drop("conversionRateHistory", "no_entry_population");
      out.conversionRateHistory = null;
    } else {
      const daily = (h.daily ?? []).map((p) => {
        const n = cumulativeAt(to.row!, p.date);
        const d = cumulativeAt(from.row!, p.date);
        return { ...p, cumulativeContacted: d, cumulativeOutcomes: n, conversionRatePct: pct(n, d) };
      });
      out.conversionRateHistory = {
        ...h,
        outcomeObserved: true,
        daily,
        datedContacted: from.units,
        undatedContacted: 0,
        datedOutcomes: to.units,
        undatedOutcomes: 0,
        scopeConversionRatePct: pct(to.units, from.units),
        maturity: null,
      };
    }
  }

  if (isObj(out.learningPhase)) {
    const lp = out.learningPhase as Obj & { outcomeStep?: { key?: string } | null; outcomesRequired?: number; committedSpentUsd?: number | null };
    // Learning = what OUR spend produced: OUR Units (a client's own Paid clients prove nothing about our workflow).
    const lc = lp.outcomeStep?.key ? count("learningPhase.outcomesObserved", lp.outcomeStep.key) : null;
    const c = { units: lc?.ourUnits ?? null };
    const required = lp.outcomesRequired ?? 10;
    const price = c.units !== null && c.units > 0 && (lp.committedSpentUsd ?? 0) > 0 ? lp.committedSpentUsd! / c.units : null;
    out.learningPhase = {
      ...lp,
      isMature: null,
      outcomesBasis: "flash",
      outcomesObserved: c.units,
      flashOutcomesObserved: c.units,
      progressPct: c.units === null ? null : Math.min(100, (c.units / required) * 100),
      outcomeObserved: true,
      expectedCostPerOutcomeUsd: lp.status === "unmeasured" ? null : price,
      spendTargetUsd: lp.status === "unmeasured" || price === null ? null : price * required,
      spendRemainingUsd: lp.status === "unmeasured" || price === null ? null : Math.max(0, price * required - (lp.committedSpentUsd ?? 0)),
      ...(c.units !== null && c.units >= required && lp.status !== "paused" && lp.status !== "unmeasured" ? { status: "priced", daysRemaining: 0 } : {}),
    };
  }

  // Per-leg maturity figures (flash / mature conversions per person cohort) are not ledger figures.
  if ("maturity" in out && out.maturity !== null && out.maturity !== undefined) out.maturity = drop("maturity");

  out.ledgerCounts = block;
  return out as T;
}

function cumulativeAt(row: ScopeOutcomeLedgerRow, day: string, oursOnly = false): number {
  let v = 0;
  for (const p of row.past) {
    if (p.date > day) break;
    v = oursOnly ? p.cumulativeOurUnits : p.cumulativeUnits;
  }
  return v;
}

/**
 * `/features/:slug/stats` raw count keys → the catalogue step whose ledger Units they become. A raw COUNT key of the
 * registry not listed (contacted, delivered, opens, negative replies, companies, journalists, quotes, outlets, press kits,
 * buffered / skipped / claimed leads) has no ledger twin: dropped before the derived figures are computed, so it and every
 * rate / $ per recipient dividing it serve null. Spend, runs and active campaigns are the runs ledger's own; scores are no count.
 */
export const STATS_RAW_STEPS: Readonly<Record<string, string>> = {
  recipientsClicked: "website_visit",
  recipientsRepliesPositive: "conversation",
  leadsServed: "lead_found",
  emailsGenerated: "message_written",
  leadsClicked: "website_visit",
  leadsRepliesPositive: "conversation",
  leadsRepliesInterested: "conversation",
  leadsRepliesMeetingBooked: "meeting_booked",
  leadsRepliesClosed: "paid_client",
};
const STATS_LEDGER_NATIVE = new Set(["totalCostInUsdCents", "actualCostInUsdCents", "completedRuns", "activeCampaigns"]);

/** PURE. The raw `/stats` map re-based on the ledger (`countKeys` = the registry's raw `count` keys). */
export function withLedgerRawStats(raw: Record<string, number>, countKeys: ReadonlySet<string>, scope: LedgerScope, label: string): { raw: Record<string, number>; ledgerCounts: LedgerCountsBlock } {
  const { block, count, drop } = recorder(scope, label);
  const out: Record<string, number> = { ...raw };
  for (const key of countKeys) {
    if (STATS_LEDGER_NATIVE.has(key)) continue;
    const step = STATS_RAW_STEPS[key];
    if (step === undefined) {
      if (key in out) {
        delete out[key];
        drop(key);
      }
      continue;
    }
    const c = count(key, step);
    if (c.units === null) delete out[key];
    else out[key] = c.units;
  }
  return { raw: out, ledgerCounts: block };
}

/**
 * PURE. OUTCOME-COST-CUMUL-1109: one day per Unit OUR factory produced (the divisor of a money figure; another factory's
 * Units are no outcome of our spend), withdrawn Units taken back (`standingUnitsByDay`).
 */
export function ledgerOurUnitDays(c: LedgerCount): string[] {
  return unitDays(c, (p) => p.ourUnits);
}

/**
 * PURE. OUTCOME-TOTAL-UNITS-1110: every Unit of the step since inception, ours + another factory's (a client's own team, a
 * connector), each family netted of its withdrawals by the same rule, so it never reads below `ledgerOurUnitDays`.
 */
export function ledgerTotalUnitCount(c: LedgerCount): number {
  return unitDays(c, (p) => p.ourUnits).length + unitDays(c, (p) => p.otherFactoryUnits).length;
}

/**
 * PURE. One day per Unit still standing, by THE rule (LEDGER-NEGATIVE-DAYS-1110, `standingUnitsByDay`). A row from
 * `scopeOutcomeLedgerRowOf` is already netted (idempotent here); a hand-built row with a negative day is netted the same way.
 */
function unitDays(c: LedgerCount, n: (p: ScopeOutcomeLedgerRow["past"][number]) => number): string[] {
  const out: string[] = [];
  for (const [d, k] of standingUnitsByDay((c.row?.past ?? []).map((p) => [p.date, n(p)] as const))) for (let i = 0; i < k; i++) out.push(d);
  return out;
}

/**
 * PURE. A pipeline-activity day chart's ACTUAL bars on the ledger: outreach = `message_sent` Units of the day, clicks =
 * website visits (`lead_visited`), signups, form submissions = their Units. Opens are no outcome: null (actual AND
 * expected, and the open rate). Expected bars are the forecast (an expected figure), untouched.
 */
export function withLedgerDayChart<T extends object>(input: T, scope: LedgerScope): T {
  const body = input as unknown as { days?: Array<Obj & { date: string; metrics: Record<string, Obj> }>; summary?: Obj };
  const series = {
    outreach: ledgerCountOfStep(scope, "message_sent"),
    clicks: ledgerCountOfStep(scope, "website_visit"),
    signups: ledgerCountOfStep(scope, "signup"),
    formSubmissions: ledgerCountOfStep(scope, "form_submitted"),
  };
  const on = (c: LedgerCount, day: string) => (c.units === null ? null : (c.row?.past.find((p) => p.date === day)?.units ?? 0));
  const days = body.days?.map((d) => {
    const m: Record<string, Obj> = { ...d.metrics };
    for (const [k, c] of Object.entries(series)) if (m[k] && m[k]!.actual !== null && m[k]!.actual !== undefined) m[k] = { ...m[k], actual: on(c, d.date) };
    if (m.opens) m.opens = { ...m.opens, actual: null, expected: null };
    return { ...d, metrics: m };
  });
  const summary = body.summary
    ? {
        ...body.summary,
        openRatePct: null,
        undatedSignups: series.signups.units === null ? null : 0,
        undatedFormSubmissions: series.formSubmissions.units === null ? null : 0,
      }
    : body.summary;
  const nullFields: Record<string, string> = { "metrics.opens": NOT_A_LEDGER_OUTCOME, "summary.openRatePct": NOT_A_LEDGER_OUTCOME };
  const producerGaps: Record<string, LedgerProducerGap> = {};
  const otherFactoryUnits: Record<string, OtherFactoryUnits> = {};
  for (const c of Object.values(series)) if (c.otherFactoryUnits !== null && c.otherFactoryUnits.total > 0 && c.row) otherFactoryUnits[c.row.outcomeKeys.join("+")] = c.otherFactoryUnits;
  for (const [k, c] of Object.entries(series))
    if (c.units === null) {
      nullFields[`metrics.${k}.actual`] = c.reason ?? "ledger_unreadable";
      if (c.producerGap) for (const key of c.row?.outcomeKeys ?? []) producerGaps[key] = c.producerGap;
    }
  const ledgerCounts: LedgerCountsBlock = { basis: "ledger", scope: "brand", unavailableReason: scope.unavailableReason, nullFields, producerGaps, otherFactoryUnits, ledgerDaysMissing: [...(scope.ledger?.daysMissing ?? [])] };
  return { ...(input as Obj), days, summary, ledgerCounts } as unknown as T;
}

/** The lifecycle rungs' ledger outcome steps (contacted / engaged have no twin: engaged spans two lead tracks). */
const RUNG_STEPS: Readonly<Record<string, readonly string[] | null>> = {
  lead_found: ["lead_found"],
  contacted: null,
  engaged: null,
  signup_or_form: ["signup", "form_submitted"],
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  paid_client: ["paid_client"],
};

/** PURE. A lifecycle rung's ledger Units in a scope. */
export function ledgerUnitsOfRung(scope: LedgerScope, rung: string): { units: number | null; ourUnits: number | null; otherFactoryUnits: OtherFactoryUnits | null; reason: string | null } {
  const steps = RUNG_STEPS[rung];
  if (!steps) return { units: null, ourUnits: null, otherFactoryUnits: null, reason: NOT_A_LEDGER_OUTCOME };
  if (scope.ledger === null) return { units: null, ourUnits: null, otherFactoryUnits: null, reason: scope.unavailableReason };
  const row = scopeOutcomeLedgerRowOf(steps.flatMap(ledgerKeysOfStep), scope.ledger);
  return { units: row.units, ourUnits: row.ourUnits, otherFactoryUnits: row.otherFactoryUnits, reason: row.unitsUnavailableReason };
}

/**
 * PURE. LEDGER-ONLY-1107-P2: the Deals standing body (Interested / Won). The WON column's value = the ledger's OUR Paid client
 * Units x LTR (its `units` = the total, another factory's included) (never the CRM's won standing), its cards carry none; people / organisation counts on a column are no ledger
 * figure (null). Interested stays the pipeline's expected value (a forecast), its counts null.
 */
export function withLedgerDealsColumns<T extends { lifetimeRevenueUsd: number | null; columns: Array<Obj & { standing: string; basis: string | null }> }>(r: T, scope: LedgerScope): T {
  const paid = ledgerUnitsOfRung(scope, "paid_client");
  const columns = r.columns.map((c) => {
    const base = { ...c, leadCount: null, organizationCount: null, unpricedLeadCount: null };
    if (c.basis !== "won_value") return base;
    // Value = OUR Paid clients × LTR; another factory's are counted in `units`, worth nothing of ours.
    const valueUsd = paid.ourUnits === null || r.lifetimeRevenueUsd === null ? null : Math.round(paid.ourUnits * r.lifetimeRevenueUsd * 100) / 100;
    return {
      ...base,
      valueUsd,
      units: paid.units,
      ourUnits: paid.ourUnits,
      otherFactoryUnits: paid.otherFactoryUnits,
      unitsUnavailableReason: paid.units === null ? paid.reason : null,
      leads: ((c.leads as Obj[] | undefined) ?? []).map((l) => ({ ...l, valueUsd: null, valueSource: null })),
    };
  });
  return { ...r, columns };
}
