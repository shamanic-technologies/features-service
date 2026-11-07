/**
 * OUTCOME-FINEST-1106 (owner 2026-11-06: « pour les pages Outcomes … du hardcode pour chaque [outcome] »; « en connectant
 * les comptes sociaux, même si ce n'est pas Distribute qui a posté … ça n'empêche pas d'avoir tous les graphes, stats, les
 * créatives »). The brand's Units of ONE published outcome (Threads posts, X posts, LinkedIn posts, newsletter emails), each
 * row a creative with what it led to, the totals and a day series. PURE; IO in `published-units-io.ts`, route
 * `routes/published-units.ts`.
 *
 * Who performed it = what the subject's service states (`ours` | `client_team`, a hand post imported off a connected
 * account). Visits = website visits that CONSUMED the Unit on the ledger (a click on its link, never a time window); signups
 * = signups consuming those visits. $ spent = the produced occurrences' cost (runs-service allocation). Budget and return
 * read OURS only (owner: « le coût est facturé à l'org »; the chart reads all): `costPerSignupUsd` = ours spend ÷ ours
 * signups, null while ours has no signup (`learning`).
 */

import { accountingReturn, outcomeAccountingOf, yieldToNext, type AccountingReturn, type ExpectedRouteFigures, type OutcomeAccounting } from "./outcome-accounting.js";

/** The four published outcomes this read serves, each with its own row source (hard-coded per outcome, owner). */
export const PUBLISHED_OUTCOME_KEYS = ["threads_post_published", "x_post_published", "linkedin_post_published", "newsletter_email_sent"] as const;
export type PublishedOutcomeKey = (typeof PUBLISHED_OUTCOME_KEYS)[number];

export const isPublishedOutcomeKey = (k: string): k is PublishedOutcomeKey => (PUBLISHED_OUTCOME_KEYS as readonly string[]).includes(k);

export type PerformedBy = "ours" | "client_team";

/** One creative as its own service serves it, plus the ledger handles to credit it. */
export interface UnitSource {
  /** The row's id in its own service (publication, account post, release, occurrence). */
  id: string;
  publishedAt: string;
  /** The account / list it went out on (`@distribute_you_gtm`, `newsletter`). */
  account: string | null;
  performedBy: PerformedBy;
  /** The creative: the post text, the newsletter subject. */
  text: string | null;
  url: string | null;
  /** How many Units this row is (1 per post; one per email sent for a release). */
  units: number;
  /** Lifetime views / engagements its platform reports (null = not reported, or no such count for this outcome). */
  views: number | null;
  engagements: number | null;
  /**
   * The platform's raw counts (social-service `metrics`: likes, replies, reposts, quotes, shares, bookmarks, clicks...).
   * When present, `engagements` and the breakdown are read off it (one rule); absent = `engagements` as given.
   */
  metrics?: Record<string, number | null | undefined> | null;
  /**
   * What the row is, in the producer's own vocabulary (social-service `post | quote | repost | comment`). A `repost` (an X
   * retweet, a LinkedIn plain reshare: no text of ours, the ORIGINAL post's counts) is not a Unit we published. Absent = a post.
   */
  kind?: string | null;
  /** The campaign the Unit was produced on (ledger tag), to value it on that campaign's offer. Null = none. */
  campaignId?: string | null;
  /** The ledger handles: the run the Unit(s) are produced on and the outcome key they carry (null = not on the ledger yet). */
  ledger: {
    runId: string;
    outcomeKey: string;
    subjectId: string | null;
    /**
     * A row of many Units (a newsletter release, tens of thousands of emails): its run is credited as a whole from a
     * stored per-run total, rebuilt only when this fingerprint (the producer's count of Units declared) moves.
     */
    bulkFingerprint?: string;
  } | null;
}

/** The ledger's credit of one row: spend, visits through its link, signups from those visits. */
export interface LedgerCredit {
  spentUsd: number;
  visits: number;
  signups: number;
}

/**
 * SOCIAL-OUTCOMES-1107. The engagement kinds a platform reports on a published Unit, in the producer's own words
 * (social-service `metrics`): `replies` are the comments. `clicks` is listed so a network that reports link clicks is
 * read the day it does; none does today (null). ONE rule for every published outcome: `engagements` = the sum of the
 * kinds reported, so a breakdown always adds up to it.
 */
export const ENGAGEMENT_KINDS = ["likes", "replies", "reposts", "quotes", "shares", "bookmarks", "clicks"] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];
export type EngagementBreakdown = Record<EngagementKind, number | null>;

/** What one Unit of the outcome is worth, and on what terms (the Target value rule of `lib/campaign-targets.ts`). */
export interface UnitValue {
  /** The catalogue value of the step the outcome lands on, on the offer's lifetime revenue (null = no route to Paid client rated). */
  valuePerUnitUsd: number | null;
  /** The catalogue step valued (the outcome's own step, else the step its pipe lands on). */
  step: string | null;
  /** The offer of the campaign that produced the Unit; null = the Unit names no campaign stating an offer. */
  offerId: string | null;
  /** `offer_stated` = the offer's typed lifetime revenue; `fleet_median` = no offer or an unstated one (every offer has an LTR). */
  lifetimeRevenueSource: "offer_stated" | "fleet_median" | null;
  unavailableReason: string | null;
}

/** A return on money actually spent (the campaign MEASURED return rule: Units x their value / spend). */
export interface MeasuredReturn {
  roiMultiple: number | null;
  valueUsd: number | null;
  spentUsd: number | null;
  /** Fewer Units than the maturity bar: the figure is shown, but the page reads the expected return instead. */
  learning: boolean;
  unavailableReason: string | null;
}

/** The EXPECTED return of one more Unit: its value / what one costs to make on the catalogue pipe producing it. */
export interface ExpectedReturn {
  roiMultiple: number | null;
  valuePerUnitUsd: number | null;
  costPerUnitUsd: number | null;
  /** Where the cost comes from (`lib/agent-catalogue.ts` `expectedPipeCost`: workflow, default, benchmark, flash...). */
  costSource: string | null;
  /** The weakest input (measured < stated < fleet < default). */
  basis: string | null;
  pipeId: string | null;
  unavailableReason: string | null;
}

/** Fewer Units of ours than this = Learning (the maturity bar of every leg with no stated rule, `lib/maturity.ts`). */
export const MEASURED_RETURN_MIN_UNITS = 10;

export interface UnitRow extends Omit<UnitSource, "ledger" | "metrics" | "campaignId"> {
  spentUsd: number | null;
  visits: number | null;
  signups: number | null;
  /** Why the ledger figures are null: `not_on_ledger_yet` (no Unit declared for it yet). */
  ledgerUnavailableReason: "not_on_ledger_yet" | null;
  /** Why visits and signups are null while spend is served: `no_visit_attribution_on_outcome` (no website visit was ever
   *  credited to a Unit of this outcome in the org: its links carry no tracked click yet), or `not_on_ledger_yet`. */
  visitsUnavailableReason: "no_visit_attribution_on_outcome" | "not_on_ledger_yet" | null;
  /** Each engagement kind the platform reports (null = not reported); sums to `engagements`. */
  engagementBreakdown: EngagementBreakdown;
  /** `views_not_reported`: the platform gives no views (absent, or 0 beside an engagement: nobody engages unseen). */
  viewsUnavailableReason: "views_not_reported" | null;
  /** `engagements_exceed_views`: the platform reports more interactions than (non-zero) views, so one of the two is not measured. */
  metricsWarning: "engagements_exceed_views" | null;
  valuePerUnitUsd: number | null;
  /** units x valuePerUnitUsd: the value this row produced (yield). */
  valueUsd: number | null;
  value: UnitValue;
  /** RE-BASED (OUTCOME-ACCOUNTING-1107): a Unit row is no campaign Target, so null with `return_only_at_campaign_target`. */
  measuredReturn: MeasuredReturn;
  /** OUTCOME-ACCOUNTING-1107: this row's cost-accounting report (`lib/outcome-accounting.ts`); null on a client-team row
   *  (`performed_by_client_team`: it costs us $0 and enters none of our figures). */
  accounting: OutcomeAccounting | null;
  accountingUnavailableReason: "performed_by_client_team" | null;
}

export interface Totals {
  rows: number;
  units: number;
  views: number;
  engagements: number;
  visits: number;
  signups: number;
  spentUsd: number;
  /** Rows whose platform reports views (views on the others are not counted, never 0). */
  viewsReportedRows: number;
  engagementBreakdown: EngagementBreakdown;
  /** Rows flagged `engagements_exceed_views`. */
  rowsEngagementsAboveViews: number;
  /** Σ rows' valueUsd (rows with no value left out, counted in `unvaluedRows`). */
  valueUsd: number;
  unvaluedRows: number;
}

export interface DayPoint {
  date: string;
  units: number;
  oursUnits: number;
  views: number;
  visits: number;
  signups: number;
  spentUsd: number;
  engagements: number;
  engagementBreakdown: EngagementBreakdown;
  valueUsd: number;
  oursSpentUsd: number;
  oursValueUsd: number;
  /** Ours that day: value / spend (learning = that day's ours Units under the bar). */
  measuredReturn: MeasuredReturn;
}

export interface PublishedUnitsBody {
  outcomeKey: PublishedOutcomeKey;
  rows: UnitRow[];
  /** `clientTeam` = the client's own Units (hand posts imported): counted and charted apart, in none of our figures. */
  totals: { all: Totals; ours: Totals; clientTeam: Totals };
  /** Ours spend ÷ ours signups; null while ours has no signup (`learning: true`) or nothing was spent. */
  costPerSignupUsd: number | null;
  costPerSignupUnavailableReason: "no_visit_attribution_on_outcome" | "no_signup_yet" | "nothing_spent_yet" | null;
  learning: boolean;
  /** One point per UTC day a row was published on (quiet days omitted: a time axis), oldest first. */
  daily: DayPoint[];
  /** Reposts of someone else's post (a retweet, a plain reshare): not a Unit we published, left out of every row and total. */
  repostsExcluded: { rows: number; engagements: number };
  /** Whether the org's ledger credits website visits to Units of this outcome at all (false = visits/signups null). */
  visitsMeasured: boolean;
  visitsUnavailableReason: "no_visit_attribution_on_outcome" | null;
  /** RE-BASED (OUTCOME-ACCOUNTING-1107): `accounting.returns`' measured figure when the outcome is a campaign's Target,
   *  else null with `outcome_is_no_campaign_target` (a return exists only at a campaign's Target). */
  measuredReturn: MeasuredReturn;
  /** RE-BASED likewise: the Target value ÷ the expected cost from Start, only at a campaign's Target. */
  expectedReturn: ExpectedReturn;
  /** OUTCOME-ACCOUNTING-1107: the page's cost-accounting report over OUR Units (`lib/outcome-accounting.ts`). */
  accounting: OutcomeAccounting;
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** PURE. One occurrence as runs-service serves it (fields this read uses). */
export interface LedgerOccurrence {
  id: string;
  runId: string;
  direction: "produced" | "consumed";
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  cost: { grossCents: string; netCents: string } | null;
  consumption: {
    sourceOccurrenceId: string | null;
    sourceRunId?: string | null;
    consumingOutcomes: Array<{ outcomeKey: string | null; standardCost?: { grossCents: string; netCents: string } | null }>;
  } | null;
}

const consumesInto = (o: LedgerOccurrence, key: string) => (o.consumption?.consumingOutcomes ?? []).some((c) => c.outcomeKey === key);

/**
 * PURE. The ledger credit of each produced Unit occurrence: its cost (net or gross cents), the website visits consuming it
 * (the visit run consumed the Unit into a `website_visit`), and the signups consuming those visits (once per visit).
 */
export function creditsByOccurrence(
  units: readonly LedgerOccurrence[],
  unitConsumptions: readonly LedgerOccurrence[],
  visitsProduced: readonly LedgerOccurrence[],
  visitConsumptions: readonly LedgerOccurrence[],
  pricing: "gross" | "net",
): Map<string, LedgerCredit> {
  const out = new Map<string, LedgerCredit>();
  for (const u of units) {
    if (u.direction !== "produced") continue;
    const cents = u.cost ? Number(pricing === "net" ? u.cost.netCents : u.cost.grossCents) : 0;
    out.set(u.id, { spentUsd: Number.isFinite(cents) ? cents / 100 : 0, visits: 0, signups: 0 });
  }
  const visitRunUnit = new Map<string, string>();
  for (const c of unitConsumptions) {
    const src = c.consumption?.sourceOccurrenceId;
    if (c.direction === "consumed" && src && out.has(src) && consumesInto(c, "website_visit")) visitRunUnit.set(c.runId, src);
  }
  const visitUnit = new Map<string, string>();
  for (const v of visitsProduced) {
    const unit = visitRunUnit.get(v.runId);
    if (!unit || v.direction !== "produced" || v.outcomeKey !== "website_visit") continue;
    visitUnit.set(v.id, unit);
    out.get(unit)!.visits += 1;
  }
  const signed = new Set<string>();
  for (const c of visitConsumptions) {
    const src = c.consumption?.sourceOccurrenceId;
    if (c.direction === "consumed" && c.outcomeKey === "website_visit" && src && visitUnit.has(src) && consumesInto(c, "signup")) signed.add(src);
  }
  for (const v of signed) out.get(visitUnit.get(v)!)!.signups += 1;
  return out;
}

/**
 * PURE. Full absorption: what a Unit's production order CONSUMED is part of its cost (a newsletter email's run is
 * spend-free, its cost is the `message_sent` it consumes, ~1.5 cents). Per run, the standard cost of every consumption
 * part going to a Unit key is spread evenly over that run's produced Units of the key, added to their credit.
 */
export function addInputCosts(credits: Map<string, LedgerCredit>, units: readonly LedgerOccurrence[], consumedOnRuns: readonly LedgerOccurrence[], pricing: "gross" | "net"): void {
  const unitsOf = new Map<string, LedgerOccurrence[]>();
  for (const u of units) {
    if (u.direction !== "produced") continue;
    const k = `${u.runId}|${u.outcomeKey}`;
    unitsOf.set(k, [...(unitsOf.get(k) ?? []), u]);
  }
  const inputOf = new Map<string, number>();
  for (const c of consumedOnRuns) {
    if (c.direction !== "consumed") continue;
    for (const part of c.consumption?.consumingOutcomes ?? []) {
      if (!part.outcomeKey || !part.standardCost) continue;
      const k = `${c.runId}|${part.outcomeKey}`;
      if (!unitsOf.has(k)) continue;
      const cents = Number(pricing === "net" ? part.standardCost.netCents : part.standardCost.grossCents);
      if (Number.isFinite(cents)) inputOf.set(k, (inputOf.get(k) ?? 0) + cents / 100);
    }
  }
  for (const [k, usd] of inputOf) {
    const on = unitsOf.get(k)!;
    for (const u of on) {
      const c = credits.get(u.id);
      if (c) c.spentUsd += usd / on.length;
    }
  }
}

/** A bulk run's stored total: its Units and their cost on both bases (own cost + what the run consumed into them). */
export interface RunAggregate {
  units: number;
  netUsd: number;
  grossUsd: number;
}

/** PURE. A bulk run's total from its produced Units of the key and everything the run consumed (full absorption). */
export function runAggregateOf(outcomeKey: string, produced: readonly LedgerOccurrence[], consumed: readonly LedgerOccurrence[]): RunAggregate {
  let units = 0;
  let net = 0;
  let gross = 0;
  for (const u of produced) {
    if (u.direction !== "produced" || u.outcomeKey !== outcomeKey) continue;
    units += 1;
    net += Number(u.cost?.netCents ?? 0) || 0;
    gross += Number(u.cost?.grossCents ?? 0) || 0;
  }
  for (const c of consumed) {
    if (c.direction !== "consumed") continue;
    for (const part of c.consumption?.consumingOutcomes ?? []) {
      if (part.outcomeKey !== outcomeKey || !part.standardCost) continue;
      net += Number(part.standardCost.netCents) || 0;
      gross += Number(part.standardCost.grossCents) || 0;
    }
  }
  return { units, netUsd: round(net / 100), grossUsd: round(gross / 100) };
}

/**
 * NEWSLETTER-COST-1107-FEATURES: a stored bulk-run total is a CACHE of the ledger, so it must move when the ledger's MONEY
 * on its rows moves, not only their count (prod 2026-11-07: runs-service re-priced our org's Postmark sends 1.19c -> 0.165c,
 * the Units count never moved, every finished release kept its pre-correction cost). Reading the whole run is the build
 * itself (minutes), so the money key is a deterministic SAMPLE: the ledger money of the run's first
 * `BULK_RUN_COST_SAMPLE_ROWS` produced and consumed occurrences (runs-service pages by id, the same rows on every read). A
 * re-price, a late cost or a re-allocation of the run's inputs moves it; anything a sample can miss is caught by the
 * rebuild ceiling (`BULK_RUN_REBUILD_CEILING_MS`).
 */
export const BULK_RUN_COST_SAMPLE_ROWS = 100;
export const BULK_RUN_REBUILD_CEILING_MS = 24 * 60 * 60_000;

/** PURE. The money key of a bulk run's sample (gross and net, every produced cost and every consumed part of the key). */
export function bulkRunCostKeyOf(outcomeKey: string, produced: readonly LedgerOccurrence[], consumed: readonly LedgerOccurrence[]): string {
  let net = 0;
  let gross = 0;
  let rows = 0;
  for (const u of produced) {
    if (u.direction !== "produced" || u.outcomeKey !== outcomeKey) continue;
    rows += 1;
    net += Number(u.cost?.netCents ?? 0) || 0;
    gross += Number(u.cost?.grossCents ?? 0) || 0;
  }
  for (const c of consumed) {
    if (c.direction !== "consumed") continue;
    rows += 1;
    for (const part of c.consumption?.consumingOutcomes ?? []) {
      if (part.outcomeKey !== outcomeKey || !part.standardCost) continue;
      net += Number(part.standardCost.netCents) || 0;
      gross += Number(part.standardCost.grossCents) || 0;
    }
  }
  return `rows:${rows}|gross:${gross.toFixed(6)}|net:${net.toFixed(6)}`;
}

/** A bulk run's stored total: the Units fingerprint and the money key it was built at (read BEFORE the build). */
export interface StoredBulkRun {
  fingerprint: string;
  /** Absent on a total stored before NEWSLETTER-COST-1107-FEATURES: rebuilt once. */
  costKey?: string | null;
  builtAt?: string | null;
  agg: RunAggregate;
}

export type BulkRunRebuildReason = "never_built" | "units_moved" | "ledger_cost_moved" | "ceiling";

/**
 * PURE. Why a stored bulk total must be rebuilt, null when it still IS the ledger's figure: never built, its Units count
 * moved, its ledger money moved (same count), or it is older than the ceiling. An unknown current money key (the sample
 * read failed) never forces a rebuild on its own.
 */
export function bulkRunRebuildReason(
  stored: StoredBulkRun | null,
  current: { fingerprint: string; costKey: string | null },
  nowMs: number,
): BulkRunRebuildReason | null {
  if (!stored) return "never_built";
  if (stored.fingerprint !== current.fingerprint) return "units_moved";
  if (current.costKey !== null && stored.costKey !== current.costKey) return "ledger_cost_moved";
  const built = stored.builtAt ? Date.parse(stored.builtAt) : NaN;
  if (!Number.isFinite(built) || nowMs - built > BULK_RUN_REBUILD_CEILING_MS) return "ceiling";
  return null;
}

/**
 * PURE. Visits and signups of bulk runs: a website visit consumed one of the run's Units (its consumption names the
 * Unit's run), a signup consumed that visit (once per visit).
 */
export function bulkVisitCredits(
  bulkRuns: ReadonlySet<string>,
  unitConsumptions: readonly LedgerOccurrence[],
  visitsProduced: readonly LedgerOccurrence[],
  visitConsumptions: readonly LedgerOccurrence[],
): Map<string, { visits: number; signups: number }> {
  const out = new Map([...bulkRuns].map((r) => [r, { visits: 0, signups: 0 }]));
  const visitRunOf = new Map<string, string>();
  for (const c of unitConsumptions) {
    const src = c.consumption?.sourceRunId;
    if (c.direction === "consumed" && src && bulkRuns.has(src) && consumesInto(c, "website_visit")) visitRunOf.set(c.runId, src);
  }
  const visitRun = new Map<string, string>();
  for (const v of visitsProduced) {
    const run = visitRunOf.get(v.runId);
    if (!run || v.direction !== "produced" || v.outcomeKey !== "website_visit") continue;
    visitRun.set(v.id, run);
    out.get(run)!.visits += 1;
  }
  const signed = new Set<string>();
  for (const c of visitConsumptions) {
    const src = c.consumption?.sourceOccurrenceId;
    if (c.direction === "consumed" && c.outcomeKey === "website_visit" && src && visitRun.has(src) && consumesInto(c, "signup")) signed.add(src);
  }
  for (const v of signed) out.get(visitRun.get(v)!)!.signups += 1;
  return out;
}

/**
 * PURE. Each row's credit = the sum over the produced occurrences on its run with its outcome key (a release's thousands
 * of emails; one post). When the row names its subject and an occurrence carries it, only that one counts (a run that
 * published several posts).
 */
export function creditOfRow(src: UnitSource, unitsByRun: ReadonlyMap<string, readonly LedgerOccurrence[]>, credits: ReadonlyMap<string, LedgerCredit>): LedgerCredit | null {
  if (!src.ledger) return null;
  const onRun = (unitsByRun.get(src.ledger.runId) ?? []).filter((o) => o.outcomeKey === src.ledger!.outcomeKey);
  if (onRun.length === 0) return null;
  const own = src.ledger.subjectId ? onRun.filter((o) => o.subjectId === src.ledger!.subjectId) : [];
  const picked = own.length > 0 ? own : onRun;
  const sum: LedgerCredit = { spentUsd: 0, visits: 0, signups: 0 };
  for (const o of picked) {
    const c = credits.get(o.id);
    if (!c) continue;
    sum.spentUsd += c.spentUsd;
    sum.visits += c.visits;
    sum.signups += c.signups;
  }
  return { spentUsd: round(sum.spentUsd), visits: sum.visits, signups: sum.signups };
}

const emptyBreakdown = (): EngagementBreakdown => Object.fromEntries(ENGAGEMENT_KINDS.map((k) => [k, null])) as EngagementBreakdown;

/** PURE. Each engagement kind the platform reports (null = not reported). */
export function engagementBreakdownOf(m: Record<string, number | null | undefined> | null | undefined): EngagementBreakdown {
  const out = emptyBreakdown();
  if (!m) return out;
  for (const k of ENGAGEMENT_KINDS) {
    const v = m[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/** PURE. The sum of the kinds reported; null when none is. */
export function engagementsOfBreakdown(b: EngagementBreakdown): number | null {
  const known = ENGAGEMENT_KINDS.map((k) => b[k]).filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, c) => a + c, 0) : null;
}

/** PURE. A repost of someone else's post (producer `kind: repost`): left out of the page. */
export const isRepost = (s: Pick<UnitSource, "kind">): boolean => s.kind === "repost";

/** PURE. Units x value / spend, with the maturity bar. */
export function measuredReturnOf(units: number, valueUsd: number | null, spentUsd: number | null, unvalued: boolean): MeasuredReturn {
  const learning = units < MEASURED_RETURN_MIN_UNITS;
  if (units === 0) return { roiMultiple: null, valueUsd: null, spentUsd, learning, unavailableReason: "no_unit_yet" };
  if (unvalued || valueUsd === null) return { roiMultiple: null, valueUsd: null, spentUsd, learning, unavailableReason: "unit_has_no_value" };
  if (spentUsd === null || !(spentUsd > 0)) return { roiMultiple: null, valueUsd: round(valueUsd, 2), spentUsd, learning, unavailableReason: "nothing_spent_yet" };
  return { roiMultiple: round(valueUsd / spentUsd, 2), valueUsd: round(valueUsd, 2), spentUsd: round(spentUsd), learning, unavailableReason: null };
}

/** PURE. The expected return of one more Unit: value / expected cost per Unit. */
export function expectedReturnOf(valuePerUnitUsd: number | null, cost: { costPerUnitUsd: number; costSource: string; basis: string; pipeId: string } | null, valueReason: string | null): ExpectedReturn {
  const base = { valuePerUnitUsd, costPerUnitUsd: cost?.costPerUnitUsd ?? null, costSource: cost?.costSource ?? null, basis: cost?.basis ?? null, pipeId: cost?.pipeId ?? null };
  if (valuePerUnitUsd === null) return { ...base, roiMultiple: null, unavailableReason: valueReason ?? "unit_has_no_value" };
  if (!cost || !(cost.costPerUnitUsd > 0)) return { ...base, roiMultiple: null, unavailableReason: cost ? "pipe_cost_zero" : "no_pipe_prices_outcome" };
  return { ...base, roiMultiple: round(valuePerUnitUsd / cost.costPerUnitUsd, 2), unavailableReason: null };
}

/**
 * PURE. The Units whose cost is evidence of what one costs. OURS Units on the ledger count, a $0 one included: our run
 * made it and declared everything it metered, so $0 is its true cost (OUTCOME-ACCOUNTING-1107, prod 2026-11-07: 24
 * LinkedIn posts written on our Claude Max login and published by social-service's scheduler, treg billing $0, read an
 * expected $0.0188 beside an actual $0.0051 when only the 9 posts carrying a cost row counted). With no spend among ours,
 * the Units of any performer that carry a cost; a client-team Unit at $0 (a hand post imported: nothing of ours ran to
 * make it) is never evidence (an X post read $0.00015 and 16,447x, SOCIAL-OUTCOMES-1107).
 */
export function costedUnitsOf(rows: readonly Pick<UnitRow, "units" | "spentUsd" | "performedBy">[]): Pick<Totals, "units" | "spentUsd"> {
  const ours = rows.filter((r) => r.performedBy === "ours" && r.spentUsd !== null);
  const costed = rows.filter((r) => r.spentUsd !== null && r.spentUsd > 0);
  const pick = ours.some((r) => r.spentUsd! > 0) ? ours : costed;
  return { units: pick.reduce((a, r) => a + r.units, 0), spentUsd: round(pick.reduce((a, r) => a + r.spentUsd!, 0)) };
}

/**
 * PURE. No catalogue pipe prices the outcome: the expected cost of one more Unit is what one cost to date over the Units
 * that carry a cost (`costedUnitsOf`), the catalogue's own last rung (`expectedPipeCost` `own_spend`, owner rule: a cost
 * is never blank).
 */
export function withOwnSpendCost(e: ExpectedReturn, t: Pick<Totals, "units" | "spentUsd">): ExpectedReturn {
  if (e.unavailableReason !== "no_pipe_prices_outcome") return e;
  // Nothing was ever spent making one: no cost to divide by, the only case an expected return stays blank.
  if (!(t.units > 0) || !(t.spentUsd > 0)) return { ...e, unavailableReason: "nothing_spent_on_outcome" };
  const own = expectedReturnOf(e.valuePerUnitUsd, { costPerUnitUsd: round(t.spentUsd / t.units), costSource: "own_spend", basis: "measured", pipeId: "" }, null);
  return { ...own, pipeId: null };
}

const NO_VALUE: UnitValue = { valuePerUnitUsd: null, step: null, offerId: null, lifetimeRevenueSource: null, unavailableReason: "not_priced" };

const zero = (): Totals => ({
  rows: 0,
  units: 0,
  views: 0,
  engagements: 0,
  visits: 0,
  signups: 0,
  spentUsd: 0,
  viewsReportedRows: 0,
  engagementBreakdown: emptyBreakdown(),
  rowsEngagementsAboveViews: 0,
  valueUsd: 0,
  unvaluedRows: 0,
});

function addBreakdown(into: EngagementBreakdown, b: EngagementBreakdown): void {
  for (const k of ENGAGEMENT_KINDS) if (b[k] !== null) into[k] = (into[k] ?? 0) + b[k]!;
}

function add(t: Totals, r: UnitRow): void {
  t.rows += 1;
  t.units += r.units;
  t.views += r.views ?? 0;
  if (r.views !== null) t.viewsReportedRows += 1;
  t.engagements += r.engagements ?? 0;
  addBreakdown(t.engagementBreakdown, r.engagementBreakdown);
  if (r.metricsWarning) t.rowsEngagementsAboveViews += 1;
  t.visits += r.visits ?? 0;
  t.signups += r.signups ?? 0;
  t.spentUsd = round(t.spentUsd + (r.spentUsd ?? 0));
  if (r.valueUsd === null) t.unvaluedRows += 1;
  else t.valueUsd = round(t.valueUsd + r.valueUsd);
}

export interface PublishedUnitsOptions {
  /** What one Unit of the row is worth (IO resolves the offer and the catalogue). Absent = not priced. */
  unitValueOf?: (src: UnitSource) => UnitValue;
  /** The expected return of one more Unit (catalogue pipe producing the outcome). */
  expected?: ExpectedReturn;
  /** Whether the org's ledger credits website visits to this outcome at all. Default true. */
  visitsMeasured?: boolean;
  /** OUTCOME-ACCOUNTING-1107: the Plan's route figures for the page (its offer), and what the report needs. */
  accounting?: PublishedAccountingInputs;
}

export interface PublishedAccountingInputs {
  figures: ExpectedRouteFigures;
  step: string | null;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: string | null;
  /** The cost source of the route's expected cost per Unit (`expectedPipeCost` rung). */
  expectedCostSource: string | null;
  /** The brand's funnel campaigns whose Target is this outcome, each with the unit campaign ids its runs are tagged with. */
  targets: ReadonlyArray<{ campaignId: string; unitCampaignIds: readonly string[] }>;
  /** The next leg's maturity window (days): an open decision counts for its elapsed share. */
  windowDays: number;
  today: string;
}

const NO_ACCOUNTING: PublishedAccountingInputs = {
  figures: { route: [], costPerUnitUsd: null, costPerUnitBasis: null, costPerUnitUnavailableReason: "not_priced", costFromStartUsd: null, costFromStartUnavailableReason: "not_priced", rolledYieldPct: null, rolledYieldFromStep: null, next: null, netValuePerUnitUsd: null, netValueUnavailableReason: "not_priced" },
  step: null,
  lifetimeRevenueUsd: null,
  lifetimeRevenueSource: null,
  expectedCostSource: null,
  targets: [],
  windowDays: 0,
  today: new Date().toISOString().slice(0, 10),
};

/** PURE. A measured return of a row or a day: no return below a campaign's Target, a Unit row is never one. */
const noReturn = (spentUsd: number | null, reason: string): MeasuredReturn => ({ roiMultiple: null, valueUsd: null, spentUsd, learning: false, unavailableReason: reason });

/** PURE. The page return re-based on the report: measured / expected only at a campaign's Target. */
function returnsOf(ret: AccountingReturn, expected: ExpectedReturn): { measured: MeasuredReturn; expected: ExpectedReturn } {
  if (!ret.isCampaignTarget) return { measured: noReturn(null, ret.unavailableReason!), expected: { ...expected, roiMultiple: null, unavailableReason: ret.unavailableReason } };
  const m = ret.measured;
  return {
    measured: { roiMultiple: m.roiMultiple, valueUsd: m.valueUsd, spentUsd: m.spentUsd, learning: m.learning, unavailableReason: m.unavailableReason },
    expected: { ...expected, roiMultiple: ret.expected.roiMultiple, valuePerUnitUsd: ret.expected.valuePerUnitUsd, costPerUnitUsd: ret.expected.costFromStartUsd, unavailableReason: ret.expected.unavailableReason },
  };
}

/** PURE. The page body: rows newest first, totals (all and ours), $ per signup on ours, the day series, value and returns. */
export function publishedUnitsOf(
  outcomeKey: PublishedOutcomeKey,
  allSources: readonly UnitSource[],
  creditOf: (src: UnitSource) => LedgerCredit | null,
  opts: PublishedUnitsOptions = {},
): PublishedUnitsBody {
  const visitsMeasured = opts.visitsMeasured ?? true;
  const reposts = allSources.filter(isRepost);
  const sources = allSources.filter((s) => !isRepost(s));
  const rows: Array<UnitRow & { campaignId: string | null }> = sources
    .map((s) => {
      const c = creditOf(s);
      const { ledger: _ledger, metrics, campaignId: _campaignId, ...rest } = s;
      const engagementBreakdown = metrics ? engagementBreakdownOf(metrics) : { ...emptyBreakdown() };
      // The breakdown when the platform reports any kind (it then sums to engagements); else the total it gives.
      const engagements = engagementsOfBreakdown(engagementBreakdown) ?? s.engagements;
      const value = opts.unitValueOf ? opts.unitValueOf(s) : NO_VALUE;
      const valueUsd = value.valuePerUnitUsd === null ? null : round(s.units * value.valuePerUnitUsd, 4);
      const spentUsd = c ? c.spentUsd : null;
      // Zero views beside an engagement is no measured zero (nobody engages unseen): the source does not report views.
      const viewsUnreported = s.views === 0 && engagements !== null && engagements > 0;
      const views = viewsUnreported ? null : s.views;
      return {
        ...rest,
        views,
        viewsUnavailableReason: viewsUnreported ? ("views_not_reported" as const) : views === null ? ("views_not_reported" as const) : null,
        engagements,
        engagementBreakdown,
        metricsWarning: views !== null && views > 0 && engagements !== null && engagements > views ? ("engagements_exceed_views" as const) : null,
        spentUsd,
        visits: c && visitsMeasured ? c.visits : null,
        signups: c && visitsMeasured ? c.signups : null,
        ledgerUnavailableReason: c ? null : ("not_on_ledger_yet" as const),
        visitsUnavailableReason: !c ? ("not_on_ledger_yet" as const) : visitsMeasured ? null : ("no_visit_attribution_on_outcome" as const),
        valuePerUnitUsd: value.valuePerUnitUsd,
        valueUsd,
        value,
        measuredReturn: noReturn(spentUsd, "return_only_at_campaign_target"),
        accounting: null as OutcomeAccounting | null,
        accountingUnavailableReason: s.performedBy === "ours" ? null : ("performed_by_client_team" as const),
        campaignId: s.campaignId ?? null,
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const acc = opts.accounting ?? NO_ACCOUNTING;
  const all = zero();
  const ours = zero();
  const clientTeam = zero();
  const days = new Map<string, DayPoint & { oursUnvalued: boolean }>();
  for (const r of rows) {
    add(all, r);
    if (r.performedBy === "ours") add(ours, r);
    else add(clientTeam, r);
    const date = r.publishedAt.slice(0, 10);
    const d =
      days.get(date) ??
      ({ date, units: 0, oursUnits: 0, views: 0, visits: 0, signups: 0, spentUsd: 0, engagements: 0, engagementBreakdown: emptyBreakdown(), valueUsd: 0, oursSpentUsd: 0, oursValueUsd: 0, measuredReturn: measuredReturnOf(0, null, null, true), oursUnvalued: false });
    d.units += r.units;
    d.views += r.views ?? 0;
    d.visits += r.visits ?? 0;
    d.signups += r.signups ?? 0;
    d.spentUsd = round(d.spentUsd + (r.spentUsd ?? 0));
    d.engagements += r.engagements ?? 0;
    addBreakdown(d.engagementBreakdown, r.engagementBreakdown);
    d.valueUsd = round(d.valueUsd + (r.valueUsd ?? 0));
    if (r.performedBy === "ours") {
      d.oursUnits += r.units;
      d.oursSpentUsd = round(d.oursSpentUsd + (r.spentUsd ?? 0));
      d.oursValueUsd = round(d.oursValueUsd + (r.valueUsd ?? 0));
      if (r.valueUsd === null) d.oursUnvalued = true;
    }
    days.set(date, d);
  }
  const daily = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    // A day is no campaign Target: its return is null (OUTCOME-ACCOUNTING-1107).
    .map(({ oursUnvalued: _u, ...d }) => ({ ...d, measuredReturn: noReturn(d.oursSpentUsd, "return_only_at_campaign_target") }));
  const costPerSignupUsd = visitsMeasured && ours.signups > 0 && ours.spentUsd > 0 ? round(ours.spentUsd / ours.signups) : null;
  const costPerSignupUnavailableReason = costPerSignupUsd !== null ? null : !visitsMeasured ? "no_visit_attribution_on_outcome" : ours.signups === 0 ? "no_signup_yet" : "nothing_spent_yet";
  const repostBreakdowns = reposts.map((s) => engagementsOfBreakdown(engagementBreakdownOf(s.metrics)) ?? s.engagements ?? 0);

  // OUTCOME-ACCOUNTING-1107: the report, over OUR Units only. The visits are the next milestone only when the route's
  // next step IS a website visit (a click on the Unit's link); else the next milestone is not tracked for this outcome.
  const next = acc.figures.next;
  const yieldReason = !next ? null : next.step !== "website_visit" ? "next_milestone_not_tracked_for_outcome" : visitsMeasured ? null : "no_visit_attribution_on_outcome";
  const costed = costedUnitsOf(rows);
  const override = costed.units > 0 && costed.spentUsd > 0 ? { usd: costed.spentUsd / costed.units, basis: "measured", source: "own_spend" } : null;
  const oursRows = rows.filter((r) => r.performedBy === "ours");
  const targetUnitIds = new Set(acc.targets.flatMap((t) => [t.campaignId, ...t.unitCampaignIds]));
  const targetRows = oursRows.filter((r) => r.campaignId !== null && targetUnitIds.has(r.campaignId));
  const ret = accountingReturn(
    acc.targets.map((t) => t.campaignId),
    { targetUnits: targetRows.reduce((a, r) => a + r.units, 0), spentUsd: round(targetRows.reduce((a, r) => a + (r.spentUsd ?? 0), 0)) },
    acc.figures.netValuePerUnitUsd,
    acc.figures.costFromStartUsd ?? (acc.figures.route.length === 1 && override ? override.usd : null),
  );
  const reportOf = (units: number, spentUsd: number, trials: Parameters<typeof yieldToNext>[1], actualReason: string | null, r: AccountingReturn) =>
    outcomeAccountingOf({
      outcomeKey,
      step: acc.step,
      route: acc.figures,
      actual: { units, spentUsd },
      actualUnavailableReason: actualReason,
      expectedCostOverride: override,
      expectedCostSource: acc.expectedCostSource,
      yield: yieldToNext(next, trials, yieldReason, acc.windowDays, acc.today),
      yieldInto: null,
      yieldIntoReason: "attempts_not_on_ledger",
      lifetimeRevenueUsd: acc.lifetimeRevenueUsd,
      lifetimeRevenueSource: acc.lifetimeRevenueSource,
      ret: r,
    });
  const trialOf = (r: UnitRow) => ({ day: r.publishedAt.slice(0, 10), nextUnits: r.visits ?? 0, units: r.units });
  const rowReturn = accountingReturn([], null, null, null);
  const rowRet: AccountingReturn = { ...rowReturn, unavailableReason: "return_only_at_campaign_target", measured: { ...rowReturn.measured, unavailableReason: "return_only_at_campaign_target" }, expected: { ...rowReturn.expected, unavailableReason: "return_only_at_campaign_target" } };
  for (const r of oursRows) r.accounting = reportOf(r.units, r.spentUsd ?? 0, [trialOf(r)], r.spentUsd === null ? "not_on_ledger_yet" : null, rowRet);
  const accounting = reportOf(ours.units, ours.spentUsd, oursRows.filter((r) => r.spentUsd !== null).map(trialOf), null, ret);
  const returns = returnsOf(ret, withOwnSpendCost(opts.expected ?? expectedReturnOf(null, null, "not_priced"), costed));
  const servedRows: UnitRow[] = rows.map(({ campaignId: _c, ...r }) => r);
  return {
    outcomeKey,
    rows: servedRows,
    totals: { all, ours, clientTeam },
    costPerSignupUsd,
    costPerSignupUnavailableReason,
    learning: ours.signups === 0,
    daily,
    repostsExcluded: { rows: reposts.length, engagements: repostBreakdowns.reduce((a, b) => a + b, 0) },
    visitsMeasured,
    visitsUnavailableReason: visitsMeasured ? null : "no_visit_attribution_on_outcome",
    measuredReturn: returns.measured,
    expectedReturn: returns.expected,
    accounting,
  };
}

/** PURE. engagements = the platform's interaction counts summed (likes, replies, reposts, quotes); null when none is reported. */
export function engagementsOf(m: Record<string, number | null | undefined>, keys: readonly string[]): number | null {
  const known = keys.map((k) => m[k]).filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
