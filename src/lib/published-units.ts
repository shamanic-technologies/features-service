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

export interface UnitRow extends Omit<UnitSource, "ledger"> {
  spentUsd: number | null;
  visits: number | null;
  signups: number | null;
  /** Why the ledger figures are null: `not_on_ledger_yet` (no Unit declared for it yet). */
  ledgerUnavailableReason: "not_on_ledger_yet" | null;
}

export interface Totals {
  rows: number;
  units: number;
  views: number;
  engagements: number;
  visits: number;
  signups: number;
  spentUsd: number;
}

export interface DayPoint {
  date: string;
  units: number;
  oursUnits: number;
  views: number;
  visits: number;
  signups: number;
  spentUsd: number;
}

export interface PublishedUnitsBody {
  outcomeKey: PublishedOutcomeKey;
  rows: UnitRow[];
  totals: { all: Totals; ours: Totals };
  /** Ours spend ÷ ours signups; null while ours has no signup (`learning: true`) or nothing was spent. */
  costPerSignupUsd: number | null;
  learning: boolean;
  /** One point per UTC day a row was published on (quiet days omitted: a time axis), oldest first. */
  daily: DayPoint[];
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

const zero = (): Totals => ({ rows: 0, units: 0, views: 0, engagements: 0, visits: 0, signups: 0, spentUsd: 0 });

function add(t: Totals, r: UnitRow): void {
  t.rows += 1;
  t.units += r.units;
  t.views += r.views ?? 0;
  t.engagements += r.engagements ?? 0;
  t.visits += r.visits ?? 0;
  t.signups += r.signups ?? 0;
  t.spentUsd = round(t.spentUsd + (r.spentUsd ?? 0));
}

/** PURE. The page body: rows newest first, totals (all and ours), $ per signup on ours, the day series. */
export function publishedUnitsOf(
  outcomeKey: PublishedOutcomeKey,
  sources: readonly UnitSource[],
  creditOf: (src: UnitSource) => LedgerCredit | null,
): PublishedUnitsBody {
  const rows: UnitRow[] = sources
    .map((s) => {
      const c = creditOf(s);
      const { ledger: _ledger, ...rest } = s;
      return {
        ...rest,
        spentUsd: c ? c.spentUsd : null,
        visits: c ? c.visits : null,
        signups: c ? c.signups : null,
        ledgerUnavailableReason: c ? null : ("not_on_ledger_yet" as const),
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const all = zero();
  const ours = zero();
  const days = new Map<string, DayPoint>();
  for (const r of rows) {
    add(all, r);
    if (r.performedBy === "ours") add(ours, r);
    const date = r.publishedAt.slice(0, 10);
    const d = days.get(date) ?? { date, units: 0, oursUnits: 0, views: 0, visits: 0, signups: 0, spentUsd: 0 };
    d.units += r.units;
    if (r.performedBy === "ours") d.oursUnits += r.units;
    d.views += r.views ?? 0;
    d.visits += r.visits ?? 0;
    d.signups += r.signups ?? 0;
    d.spentUsd = round(d.spentUsd + (r.spentUsd ?? 0));
    days.set(date, d);
  }
  const costPerSignupUsd = ours.signups > 0 && ours.spentUsd > 0 ? round(ours.spentUsd / ours.signups) : null;
  return {
    outcomeKey,
    rows,
    totals: { all, ours },
    costPerSignupUsd,
    learning: ours.signups === 0,
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** PURE. engagements = the platform's interaction counts summed (likes, replies, reposts, quotes); null when none is reported. */
export function engagementsOf(m: Record<string, number | null | undefined>, keys: readonly string[]): number | null {
  const known = keys.map((k) => m[k]).filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
