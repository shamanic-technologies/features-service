/**
 * SAAS-CASH-1121 (owner 2026-11-21, choice 'A' = cash collected, never consumed spend; amended the same day:
 * « Revenue bruts m'intéresse le plus. En dessous on pourra noter les revenues net, et les revenue avec
 * agency »). Three series over the same periods, owner order:
 *   1. SaaS GROSS cash (headline): payments received, before refunds / lost disputes, agency excluded;
 *   2. SaaS NET cash: gross minus refunds / lost disputes on the day they happened;
 *   3. GROSS cash WITH agency: SaaS + agency orgs.
 * Our own orgs and money billing attributes to no org are in no series (stated in reconciliation).
 * Pure: the reads live in `saas-cash-io.ts`.
 *
 * - Agency = any org carrying a stated monthly amount (`agencyOrgIdsOf`, the SAME rule as the MRR split).
 * - Ours = billing's own-org verdict (absorbed-costs `ownOrg`), as every other fleet figure.
 *
 * Each (org, day) is rounded to whole cents ONCE, then every figure is an integer sum of those: the weekly
 * bars add up to the last cumulative point exactly, and the four sides add up to billing's fleet totals
 * (`reconciliation.{gross,net}.differenceCents` = the rounding residue, stated, never hidden).
 */

export interface OrgDayCash {
  /** null = money billing could not attribute to any org. */
  orgId: string | null;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Gross cash that day (payments received, before refunds / lost disputes), decimal text, cents. */
  grossCents: string;
  /** Net cash that day (gross minus refunds / lost disputes that happened that day), decimal text, cents. */
  netCents: string;
  /**
   * Agency money received that day OUTSIDE the product (billing: completed payment requests staff send by
   * hand), never inside gross / net, decimal text, cents. Counts only in the with-agency series.
   */
  agencyGrossCents: string;
  agencyNetCents: string;
}

export interface FleetCashByDay {
  /** The instant billing read the money as of (ISO). */
  asOf: string;
  /** billing's fleet gross cash since inception, decimal text, cents. */
  totalGrossCents: string;
  /** billing's fleet net cash since inception, decimal text, cents. */
  totalNetCents: string;
  /** billing's agency money received outside the product since inception (gross / net), decimal text, cents. */
  totalAgencyGrossCents: string;
  totalAgencyNetCents: string;
  rows: OrgDayCash[];
}

export type CashSide = "saas" | "agency" | "own_org" | "unattributed";

/**
 * The three figures of one period, owner order (2026-11-21): SaaS GROSS first (headline), then SaaS net,
 * then gross with agency (SaaS + agency orgs).
 */
export interface SaasCashFigures {
  saasGrossCents: number;
  saasGrossUsd: number;
  saasNetCents: number;
  saasNetUsd: number;
  withAgencyGrossCents: number;
  withAgencyGrossUsd: number;
}

export interface SaasCashWeek extends SaasCashFigures {
  /** ISO week label, e.g. 2026-W47. */
  isoWeek: string;
  /** Monday (UTC) the week starts on, YYYY-MM-DD. */
  weekStart: string;
  /** The week holding today (UTC): still running, partial. */
  isCurrent: boolean;
}

export interface SaasCashDay {
  day: string;
  /** Cash collected that day. */
  cash: SaasCashFigures;
  /** Cash collected from the first payment ever up to and including this day. */
  cumulative: SaasCashFigures;
  /** Today (UTC): still running, partial. */
  isCurrent: boolean;
}

export interface SideTotals {
  saasCents: number;
  agencyCents: number;
  ownOrgsCents: number;
  unattributedCents: number;
  /** billing's fleet total (every side) since inception. */
  fleetCents: number;
  sidesTotalCents: number;
  /** fleet − Σ sides: the per-(org, day) whole-cent rounding residue, nothing else. */
  differenceCents: number;
}

export interface SaasCashBody {
  computedAt: string;
  asOf: string;
  basis: {
    gross: string;
    net: string;
    saas: string;
    withAgency: string;
    excluded: string;
    periods: string;
  };
  /** First UTC day any cash moved (fleet, every side); null = nobody ever paid. */
  firstPaymentDay: string | null;
  weeks: SaasCashWeek[];
  days: SaasCashDay[];
  totals: {
    thisWeek: SaasCashFigures;
    sinceInception: SaasCashFigures;
  };
  /**
   * Σ the four sides vs billing's fleet totals, since inception, gross and net; plus the agency money
   * received outside the product (in no fleet total, only in the with-agency series) vs billing's total of it.
   */
  reconciliation: {
    gross: SideTotals;
    net: SideTotals;
    agencyOutsideProduct: { grossCents: number; netCents: number; billingGrossCents: number; billingNetCents: number; differenceCents: number };
  };
  /** Per agency / own org, its cash since inception (the orgs kept out of SaaS, and why). */
  excludedOrgs: Array<{
    orgId: string;
    orgName: string | null;
    side: "agency" | "own_org";
    reason: string;
    grossCents: number;
    netCents: number;
  }>;
  /** Orgs that paid but billing's absorbed-costs read carries no verdict for: counted as SaaS, named. */
  saasOrgsWithoutVerdict: string[];
  payingSaasOrgs: number;
}

export interface OrgVerdict {
  orgName: string | null;
  ownOrg: boolean;
  ownOrgReason: string | null;
}

export interface SaasCashInputs {
  cash: FleetCashByDay;
  agencyOrgIds: ReadonlySet<string>;
  /** billing's per-org verdict (absorbed-costs). */
  verdicts: ReadonlyMap<string, OrgVerdict>;
  now: Date;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Decimal text of cents rounded ONCE to whole cents (half away from zero), exactly on the text.
 * FAILS LOUD on a value that is not a decimal.
 */
function wholeCentsOf(text: string, what: string): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`[features-service] saas-cash: ${what} is not a decimal: ${JSON.stringify(text)}`);
  let whole = BigInt(m[2]!);
  if ((m[3] ?? "0").charAt(0) >= "5") whole += 1n;
  const n = Number(whole);
  if (!Number.isSafeInteger(n)) throw new Error(`[features-service] saas-cash: ${what} is out of range: ${text}`);
  return m[1] === "-" ? -n : n;
}

function usd(c: number): number {
  return Math.round(c) / 100;
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday (UTC) of the ISO week holding `day`. */
export function isoWeekStart(day: string): string {
  const ms = dayMs(day);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return isoDay(ms - dow * DAY_MS);
}

/** ISO 8601 week label (`YYYY-Www`) of `day`: the week belongs to the year of its Thursday. */
export function isoWeekLabel(day: string): string {
  const thursday = dayMs(isoWeekStart(day)) + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function sideOf(
  orgId: string | null,
  agencyOrgIds: ReadonlySet<string>,
  verdicts: ReadonlyMap<string, OrgVerdict>,
): CashSide {
  if (orgId === null) return "unattributed";
  if (verdicts.get(orgId)?.ownOrg === true) return "own_org";
  if (agencyOrgIds.has(orgId)) return "agency";
  return "saas";
}

interface Acc {
  saasGross: number;
  saasNet: number;
  agencyGross: number;
}

function figuresOf(a: Acc): SaasCashFigures {
  const withAgency = a.saasGross + a.agencyGross;
  return {
    saasGrossCents: a.saasGross,
    saasGrossUsd: usd(a.saasGross),
    saasNetCents: a.saasNet,
    saasNetUsd: usd(a.saasNet),
    withAgencyGrossCents: withAgency,
    withAgencyGrossUsd: usd(withAgency),
  };
}

function emptyAcc(): Acc {
  return { saasGross: 0, saasNet: 0, agencyGross: 0 };
}

function addInto(into: Acc, a: Acc): void {
  into.saasGross += a.saasGross;
  into.saasNet += a.saasNet;
  into.agencyGross += a.agencyGross;
}

interface Sides {
  saas: number;
  agency: number;
  own: number;
  unattributed: number;
}

function sideTotals(s: Sides, fleet: number): SideTotals {
  const total = s.saas + s.agency + s.own + s.unattributed;
  return {
    saasCents: s.saas,
    agencyCents: s.agency,
    ownOrgsCents: s.own,
    unattributedCents: s.unattributed,
    fleetCents: fleet,
    sidesTotalCents: total,
    differenceCents: fleet - total,
  };
}

export function computeSaasCash(inputs: SaasCashInputs): SaasCashBody {
  const { cash, agencyOrgIds, verdicts, now } = inputs;
  const today = isoDay(now.getTime());

  const byDay = new Map<string, Acc>();
  const gross: Sides = { saas: 0, agency: 0, own: 0, unattributed: 0 };
  const net: Sides = { saas: 0, agency: 0, own: 0, unattributed: 0 };
  const excluded = new Map<string, { gross: number; net: number }>();
  const withoutVerdict = new Set<string>();
  const payingSaas = new Set<string>();
  const agencyOutside = { gross: 0, net: 0 };
  let firstPaymentDay: string | null = null;

  for (const row of cash.rows) {
    if (!DAY_RE.test(row.day) || Number.isNaN(dayMs(row.day))) {
      throw new Error(`[features-service] saas-cash: billing day ${JSON.stringify(row.day)} is not YYYY-MM-DD`);
    }
    if (row.day > today) {
      throw new Error(`[features-service] saas-cash: billing served cash on ${row.day}, after today ${today}`);
    }
    const who = row.orgId ?? "unattributed";
    const g = wholeCentsOf(row.grossCents, `gross cash of ${who} on ${row.day}`);
    const n = wholeCentsOf(row.netCents, `net cash of ${who} on ${row.day}`);
    if (g < 0) throw new Error(`[features-service] saas-cash: billing served negative gross cash for ${who} on ${row.day}: ${row.grossCents}`);
    if (n > g) {
      throw new Error(`[features-service] saas-cash: billing served net ${row.netCents} above gross ${row.grossCents} for ${who} on ${row.day}`);
    }
    const ag = wholeCentsOf(row.agencyGrossCents, `agency gross cash of ${who} on ${row.day}`);
    const an = wholeCentsOf(row.agencyNetCents, `agency net cash of ${who} on ${row.day}`);
    if (ag < 0) throw new Error(`[features-service] saas-cash: billing served negative agency gross for ${who} on ${row.day}: ${row.agencyGrossCents}`);
    if (an > ag) {
      throw new Error(`[features-service] saas-cash: billing served agency net ${row.agencyNetCents} above agency gross ${row.agencyGrossCents} for ${who} on ${row.day}`);
    }
    if (g === 0 && n === 0 && ag === 0 && an === 0) continue;
    if (firstPaymentDay === null || row.day < firstPaymentDay) firstPaymentDay = row.day;
    let acc = byDay.get(row.day);
    if (!acc) {
      acc = emptyAcc();
      byDay.set(row.day, acc);
    }
    // Agency money received outside the product: whoever the row names, only the with-agency series.
    agencyOutside.gross += ag;
    agencyOutside.net += an;
    acc.agencyGross += ag;
    if (g === 0 && n === 0) continue;
    const side = sideOf(row.orgId, agencyOrgIds, verdicts);
    if (side === "saas") {
      gross.saas += g;
      net.saas += n;
      acc.saasGross += g;
      acc.saasNet += n;
      payingSaas.add(row.orgId!);
      if (!verdicts.has(row.orgId!)) withoutVerdict.add(row.orgId!);
    } else if (side === "agency" || side === "own_org") {
      if (side === "agency") {
        gross.agency += g;
        net.agency += n;
        acc.agencyGross += g;
      } else {
        gross.own += g;
        net.own += n;
      }
      const e = excluded.get(row.orgId!) ?? { gross: 0, net: 0 };
      e.gross += g;
      e.net += n;
      excluded.set(row.orgId!, e);
    } else {
      gross.unattributed += g;
      net.unattributed += n;
    }
  }

  const days: SaasCashDay[] = [];
  const weeks: SaasCashWeek[] = [];
  const weekAcc = new Map<string, Acc>();
  const cumulative = emptyAcc();
  if (firstPaymentDay !== null) {
    const weekMeta: Array<{ weekStart: string; isoWeek: string }> = [];
    for (let ms = dayMs(firstPaymentDay); ms <= dayMs(today); ms += DAY_MS) {
      const day = isoDay(ms);
      const a = byDay.get(day) ?? emptyAcc();
      addInto(cumulative, a);
      days.push({ day, cash: figuresOf(a), cumulative: figuresOf(cumulative), isCurrent: day === today });
      const weekStart = isoWeekStart(day);
      let w = weekAcc.get(weekStart);
      if (!w) {
        w = emptyAcc();
        weekAcc.set(weekStart, w);
        weekMeta.push({ weekStart, isoWeek: isoWeekLabel(day) });
      }
      addInto(w, a);
    }
    const currentWeek = isoWeekStart(today);
    for (const m of weekMeta) {
      weeks.push({ ...m, ...figuresOf(weekAcc.get(m.weekStart)!), isCurrent: m.weekStart === currentWeek });
    }
  }

  const thisWeek = weekAcc.get(isoWeekStart(today)) ?? emptyAcc();
  const sinceInception: Acc = { saasGross: gross.saas, saasNet: net.saas, agencyGross: gross.agency + agencyOutside.gross };

  return {
    computedAt: now.toISOString(),
    asOf: cash.asOf,
    basis: {
      gross:
        "Gross cash collected: payments received on the UTC day they landed, before refunds and lost disputes, every acquirer plus off-platform payments (billing-service). Never consumed spend.",
      net: "Net cash collected: gross minus the refunds and lost disputes that happened that UTC day.",
      saas: "SaaS = every paying org that is neither an agency org (one carrying a stated monthly amount, the rule of the MRR split) nor one of our own orgs (billing's own-org verdict).",
      withAgency:
        "With agency = SaaS gross + agency orgs' gross + agency money received outside the product (payment requests staff send by hand, billing). Our own orgs and SaaS money billing attributes to no org stay out; their totals are in reconciliation.",
      excluded: "Our own orgs (platform, staff, test) and money billing attributes to no org are in no series; agency orgs only in the with-agency series.",
      periods: "Weeks are ISO weeks (Monday 00:00 UTC); days are UTC. Both run from the first payment ever; the current week and today are partial (isCurrent).",
    },
    firstPaymentDay,
    weeks,
    days,
    totals: { thisWeek: figuresOf(thisWeek), sinceInception: figuresOf(sinceInception) },
    reconciliation: {
      gross: sideTotals(gross, wholeCentsOf(cash.totalGrossCents, "billing fleet gross total")),
      net: sideTotals(net, wholeCentsOf(cash.totalNetCents, "billing fleet net total")),
      agencyOutsideProduct: (() => {
        const billingGross = wholeCentsOf(cash.totalAgencyGrossCents, "billing agency gross total");
        return {
          grossCents: agencyOutside.gross,
          netCents: agencyOutside.net,
          billingGrossCents: billingGross,
          billingNetCents: wholeCentsOf(cash.totalAgencyNetCents, "billing agency net total"),
          differenceCents: billingGross - agencyOutside.gross,
        };
      })(),
    },
    excludedOrgs: [...excluded.entries()]
      .map(([orgId, e]) => {
        const v = verdicts.get(orgId);
        const own = v?.ownOrg === true;
        return {
          orgId,
          orgName: v?.orgName ?? null,
          side: own ? ("own_org" as const) : ("agency" as const),
          reason: own ? (v?.ownOrgReason ?? "own_org") : "stated_monthly_amount",
          grossCents: e.gross,
          netCents: e.net,
        };
      })
      .sort((a, b) => b.grossCents - a.grossCents || a.orgId.localeCompare(b.orgId)),
    saasOrgsWithoutVerdict: [...withoutVerdict].sort(),
    payingSaasOrgs: payingSaas.size,
  };
}
