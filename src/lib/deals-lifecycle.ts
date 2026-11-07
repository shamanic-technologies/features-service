/**
 * WHAT EACH LIFECYCLE COLUMN OF THE DEALS BOARD IS WORTH (owner 2026-10-21, DEALS-LIFECYCLE-1021): the board's
 * columns are the ONE lifecycle ladder (`lib/lifecycle-ladder.ts`: Contacted < Engaged < Signed up < Meeting booked <
 * Meeting attended < Paid client; Lead found is not on the board), no longer lead-service's standings.
 *
 * WHO stands on a rung is lead-service's served lifecycle (its Unibox row's `lifecycle`, the highest rung the person
 * ever reached), read, never recomputed here from raw signals. WHAT each person is worth is priced here, on the
 * byte-same engine the standing-keyed board (`lib/deals-value.ts`) and the pipeline use:
 *
 * Every value is priced on the PIPELINE's own basis (owner 2026-10-21: « On fait tout (toute campaign, tout sales
 * funnels, tout pipes) », one pipeline figure everywhere): the causes the offer revenue read prices by default (an
 * outcome our pipes caused; one that came on its own is `not_ours`, worth 0), and the same contacted pricing.
 *
 *   - Contacted: the pipeline's `contactedLeadValue` on the pipeline's `contactedPricingOf` (P(entry step |
 *     contacted, campaign × workflow) × the value at that step, expiring 30 days after the last send; a group with
 *     no measured entry rate on the seeded benchmark, `entryRateSource: "default_entry"`, never blank). A lead the
 *     engine already sees engaged is priced as an engaged lead; a bounced / unsubscribed one is 0 `cannot_convert`.
 *   - Engaged, Signed up, Meeting booked, Meeting attended: the engine's own expected value of the person
 *     (`expectedValueOfPerson`). An observed rung REPLACES the forecast pointing at it, exactly as the pipeline
 *     prices it. 0 says why (`zeroValueReason`).
 *   - Paid client: what was won: the amount a human STATED on the sale, else the offer's lifetime revenue per client
 *     (`valueSource`), ONLY on a sale OURS by the realized return's predicate (`isClosedWonOurs`, REVENUE-GENERATED-1107):
 *     anyone else on the rung (a sale none of our pipes caused, or no sale recorded at all) is 0 `not_ours`, so the
 *     won column is exactly `costEconomics.realizedReturn`'s deals among the people on the rung.
 *
 * A card is one Unibox row (a person at a company); its value is the MAX over its leads held by this population. A
 * rung's value is company-level, the pipeline's rule: one organisation = one client = the MAX over its members, so
 * an organisation is counted ONCE across the pipeline rungs (Contacted..Meeting attended), on the rung of its
 * most valuable member (ties: the higher rung); a colleague on another rung keeps its card value and adds 0 to its
 * rung (2026-10-21: karriere.at stood on Contacted $0.26 AND Engaged $0.36, the board read $0.26 above the
 * revenue read's pipeline, which takes the max). Paid client (won, not pipeline) keeps its own org max. `totalUsd` = Σ rung values, `expectedPipelineUsd` = Σ of every rung but Paid
 * client, `wonUsd` = Paid client's: each sum is exact by construction. A rung with nobody on it is 0, never absent.
 *
 * Every figure but a stated sale is EXPECTED (`expected: true`), and lists what it assumes (`assumptions`): the
 * lifetime revenue's source (`offer_stated` | `fleet_median`) and, on Contacted, the entry rate's
 * (`measured` | `default_entry`).
 */
import { LIFECYCLE_RUNGS, type LifecycleRungKey } from "./lifecycle-ladder.js";
import {
  contactedEntryRatesOf,
  contactedExpired,
  contactedLeadValue,
  ENGAGED_SIGNALS,
  expectedValueOfPerson,
  isRuledOut,
  type ContactedPricing,
  type EnginePerson,
  type ResolvedPath,
} from "./revenue-engine.js";
import type { OfferLifetimeRevenueSource } from "./offer-lifetime-revenue.js";

/** The rungs the Deals board draws, in ladder order (Lead found is not on the board). */
export const BOARD_LIFECYCLE_RUNGS = LIFECYCLE_RUNGS.filter((r) => r.key !== "lead_found");
export type BoardRungKey = Exclude<LifecycleRungKey, "lead_found">;
export const BOARD_RUNG_KEYS: readonly BoardRungKey[] = BOARD_LIFECYCLE_RUNGS.map((r) => r.key as BoardRungKey);

/** One Unibox row of lead-service, as this read needs it. */
export interface LifecycleBoardRow {
  humanId: string;
  companyKey: string;
  relationKey: string | null;
  leadIds: readonly string[];
  /** lead-service's served lifecycle rung of the row. */
  rung: BoardRungKey;
}

export type LifecycleCardZeroReason =
  /** A human ruled the lead out, it went cold, or lead-service holds its Disqualified mark. */
  | "ruled_out"
  /** The steps it reached are on no funnel the offer is priced on. */
  | "step_not_priced"
  /** Contacted, nothing sent for 30 days: a contacted lead's value expires. */
  | "expired"
  /**
   * What it reached was not caused by any of our pipes (its cause is not priced: `other`, or undecided), so it
   * adds nothing to the pipeline, the read every other figure states (owner 2026-10-21: one pipeline figure).
   */
  | "not_ours"
  /** Bounced or unsubscribed: it cannot convert. */
  | "cannot_convert"
  /** lead-service places it on Contacted, but no send reached our records yet. */
  | "not_sent"
  /**
   * LEDGER-ONLY-1107-P2: on the Paid client rung. A won value is the ledger's Paid client Units x the offer's lifetime
   * revenue, stated on the rung; the ledger names no card, so a card carries none.
   */
  | "won_counted_on_ledger";

export type LifecycleValueKind = "contacted_expected_value" | "expected_value" | "won_value";
export type EntryRateSource = "measured" | "default_entry";

export interface LifecycleCard {
  humanId: string;
  companyKey: string;
  relationKey: string | null;
  /** The row's leads this population holds (the ones priced). */
  leadIds: string[];
  /** MAX over those leads. Null only when the offer has no economics (`unvaluedReason`). */
  valueUsd: number | null;
  zeroValueReason: LifecycleCardZeroReason | null;
  /** Paid client only: where the amount comes from. */
  valueSource: "stated_amount" | "lifetime_revenue" | null;
  /** Contacted only: the entry rate the value rests on (`default_entry` = no measured rate for its campaign × workflow). */
  entryRateSource: EntryRateSource | null;
}

export interface LifecycleAssumption {
  input: "lifetime_revenue" | "entry_rate";
  source: string;
}

export interface LifecycleRungValue {
  key: BoardRungKey;
  rank: number;
  label: string;
  valueKind: LifecycleValueKind;
  /** Company-level value; 0 when nobody stands here; null only when the offer has no economics. */
  valueUsd: number | null;
  /** True unless every card is a human-stated sale. */
  expected: boolean;
  assumptions: LifecycleAssumption[];
  cardCount: number;
  /** LEDGER-ONLY-1107-P2: people / organisations on a rung are no ledger figure: null. */
  leadCount: number | null;
  organizationCount: number | null;
  /** LEDGER-ONLY-1107-P2: the ledger's Units of the rung's outcome (null + reason when it has no twin or the ledger lacks it). */
  units: number | null;
  unitsUnavailableReason: string | null;
  /** LEDGER-OTHER-FACTORY-1107: OUR Units of the rung (the won value divides these); `units` is the total. */
  ourUnits: number | null;
  /** The rung's Units another factory produced (in `units`, worth nothing of ours). */
  otherFactoryUnits: import("./scope-outcome-ledger.js").OtherFactoryUnits | null;
  cards: LifecycleCard[];
}

export interface DealsLifecycleResult {
  columns: "lifecycle";
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: OfferLifetimeRevenueSource | null;
  pricedCauses: readonly string[];
  /** `no_economics`: the offer prices on no funnel, so no figure exists (every value null). */
  unvaluedReason: "no_economics" | "no_client_value" | null;
  /** Σ rung values. */
  totalUsd: number | null;
  /** Σ every rung but Paid client: the expected pipeline. */
  expectedPipelineUsd: number | null;
  /** Paid client's value. */
  wonUsd: number | null;
  rungs: LifecycleRungValue[];
  /** Unibox rows on a board rung none of whose leads this population holds (not this scope's people). */
  outOfScopeCardCount: number;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const orgKey = (p: EnginePerson): string => (p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`);

/** A rung this person reached whose cause is not priced (`unpricedSignals`): reached, but not ours. */
const reachedNotOurs = (p: EnginePerson): boolean =>
  (p.unpricedSignals ?? []).some((s) => p.signals[s]);

interface PersonValue {
  v: number;
  zero: LifecycleCardZeroReason | null;
  source: "stated_amount" | "lifetime_revenue" | null;
  entry: EntryRateSource | null;
}

/** The board's inputs (`priceLifecycleColumns`). */
export interface LifecycleBoardInput {
  /**
   * LEDGER-ONLY-1107-P2: the scope's ledger Units per rung (`ledgerCountOfStep` of the rung key; contacted / engaged have
   * no twin). Paid client's Units price the won column (never `isClosedWonOurs` on the CRM's deals).
   */
  ledgerUnitsOf: (rung: BoardRungKey) => { units: number | null; ourUnits: number | null; otherFactoryUnits: import("./scope-outcome-ledger.js").OtherFactoryUnits | null; reason: string | null };
  rows: readonly LifecycleBoardRow[];
  persons: readonly EnginePerson[];
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: OfferLifetimeRevenueSource | null;
  /** The pipeline's own contacted pricing (`contactedPricingOf`): measured group rates, else the seeded default. */
  contactedPricing: ContactedPricing;
  statedWonAmountUsdByEmail: ReadonlyMap<string, number> | null;
  pricedCauses: readonly string[];
}

/**
 * One OFFER's pricing of its people (BRAND-GRAIN-READS-1107): its lead population and the paths and lifetime revenue
 * its declared funnels price on. A brand board is priced on several (one per offer), each person on ITS offer's terms.
 */
export interface LifecyclePricingScope {
  persons: readonly EnginePerson[];
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: OfferLifetimeRevenueSource | null;
}

/** The board's inputs over several pricing scopes (`priceLifecycleBoardScopes`). */
export interface LifecycleBoardScopesInput
  extends Omit<LifecycleBoardInput, "persons" | "paths" | "lifetimeRevenueUsd" | "lifetimeRevenueSource"> {
  scopes: readonly LifecyclePricingScope[];
  /**
   * The won column's value when the caller prices it (a brand whose offers state different lifetime revenues: each
   * offer's Paid client Units x its own). Omitted → the ledger's OUR Paid client Units x the scopes' one lifetime revenue.
   */
  wonUsd?: number | null;
}

/** PURE. Every board rung's value from the engine's inputs and lead-service's lifecycle rows. */
export function priceLifecycleColumns(input: LifecycleBoardInput): DealsLifecycleResult {
  return priceLifecycleBoard(input).board;
}

/**
 * PURE. The board AND what each organisation adds to its `totalUsd` (its pipeline rung value, counted once, plus its
 * won value), keyed like the board (`org:<orgId>`, else `lead:<leadId>`): Σ `organizationValues` = `totalUsd` exactly.
 * Empty when the offer has no economics. Read by the pipeline-generated series (`lib/pipeline-generated.ts`).
 */
export function priceLifecycleBoard(input: LifecycleBoardInput): {
  board: DealsLifecycleResult;
  organizationValues: Map<string, number>;
} {
  const { persons, paths, lifetimeRevenueUsd, lifetimeRevenueSource, ...rest } = input;
  return priceLifecycleBoardScopes({ ...rest, scopes: [{ persons, paths, lifetimeRevenueUsd, lifetimeRevenueSource }] });
}

/**
 * PURE. The board over several pricing scopes (BRAND-GRAIN-READS-1107: a brand = every offer's people, each person
 * priced on its own offer's paths and lifetime revenue). One scope = `priceLifecycleBoard` byte for byte. A person
 * several offers served is priced on each; its card holds the MAX, and an organisation still counts ONCE (the
 * pipeline's MAX over members), so a brand never adds a person twice. A scope with no economics prices nobody; the
 * board is unvalued only when no scope is valued.
 */
export function priceLifecycleBoardScopes(input: LifecycleBoardScopesInput): {
  board: DealsLifecycleResult;
  organizationValues: Map<string, number>;
} {
  const ltrs = input.scopes.map((s) => s.lifetimeRevenueUsd);
  const valuedOf = (s: LifecyclePricingScope): boolean => s.lifetimeRevenueUsd !== null && s.lifetimeRevenueUsd > 0;
  const unvaluedReason: DealsLifecycleResult["unvaluedReason"] = input.scopes.some(valuedOf)
    ? null
    : ltrs.some((l) => l !== null)
      ? "no_client_value"
      : "no_economics";
  /** The scopes' one lifetime revenue (null when they state different ones, or none). */
  const ltr = ltrs.length > 0 && ltrs.every((l) => l === ltrs[0]) ? ltrs[0]! : null;
  const sources = [...new Set(input.scopes.map((s) => s.lifetimeRevenueSource).filter((x): x is OfferLifetimeRevenueSource => Boolean(x)))];
  const byLead = new Map<string, Array<{ p: EnginePerson; s: LifecyclePricingScope }>>();
  for (const s of input.scopes) for (const p of s.persons) byLead.set(p.leadId, [...(byLead.get(p.leadId) ?? []), { p, s }]);
  const pricing = input.contactedPricing;
  const cutoff = pricing.lastSentOnOrAfter;

  const engagedValue = (p: EnginePerson, s: LifecyclePricingScope): PersonValue => {
    // The pipeline's own value of the person, contacted pricing included: someone lead-service places further along
    // than the engine sees them (no priced step yet) is worth exactly what the pipeline prices them at.
    const v = expectedValueOfPerson(p, s.paths, s.lifetimeRevenueUsd!, pricing);
    const zero: LifecycleCardZeroReason | null =
      v !== 0 ? null : isRuledOut(p) ? "ruled_out" : reachedNotOurs(p) ? "not_ours" : "step_not_priced";
    return { v, zero, source: null, entry: null };
  };

  const valueOf = (p: EnginePerson, s: LifecyclePricingScope, rung: BoardRungKey): PersonValue => {
    if (rung === "paid_client") {
      // Won value = a sale OURS by the realized return's own predicate (`isClosedWonOurs`: closed, priced to our
      // outreach, not ruled dead), so the board's won column and "N paid clients" are the same deals
      // (REVENUE-GENERATED-1107: 13 companies on the Paid client rung with no sale of ours read $6,500 won beside
      // 0 paid clients). A person on the rung with no sale of ours (the customer's own sale, a rung lead-service
      // places from another source) is worth 0 here.
      // LEDGER-ONLY-1107-P2 (supersedes `isClosedWonOurs` on the CRM's deals): the won value is the ledger's Paid client
      // Units x LTR, on the rung; no card carries it (the ledger names no card).
      return { v: 0, zero: "won_counted_on_ledger", source: null, entry: null };
    }
    if (rung !== "contacted") return engagedValue(p, s);
    // Contacted: the engine may already know more (an engaged lead is priced as one, never guessed down).
    if (ENGAGED_SIGNALS.some((sig) => p.signals[sig])) return engagedValue(p, s);
    if (p.signals.bounced || p.signals.unsubscribed) return { v: 0, zero: "cannot_convert", source: null, entry: null };
    if (!p.signals.contacted) return { v: 0, zero: "not_sent", source: null, entry: null };
    if (isRuledOut(p)) return { v: 0, zero: "ruled_out", source: null, entry: null };
    const entry = contactedEntryRatesOf(p, pricing);
    if (contactedExpired(p, cutoff)) return { v: 0, zero: "expired", source: null, entry: entry?.source ?? null };
    if (!entry) return { v: 0, zero: "step_not_priced", source: null, entry: null };
    // The byte-same function and pricing the pipeline values this lead with.
    const v = contactedLeadValue(p, s.paths, s.lifetimeRevenueUsd!, pricing);
    return { v, zero: v === 0 ? "step_not_priced" : null, source: null, entry: entry.source };
  };

  const ltrAssumption: LifecycleAssumption[] = sources.map((source) => ({ input: "lifetime_revenue", source }));

  let outOfScopeCardCount = 0;
  /** Per rung, each organisation's MAX over its members on that rung (before the cross-rung count-once). */
  const orgMaxByRung = new Map<BoardRungKey, Map<string, number>>();
  const rowsByRung = new Map<BoardRungKey, LifecycleBoardRow[]>(BOARD_RUNG_KEYS.map((k) => [k, []]));
  for (const row of input.rows) rowsByRung.get(row.rung)?.push(row);

  const rungs: LifecycleRungValue[] = BOARD_LIFECYCLE_RUNGS.map((r) => {
    const key = r.key as BoardRungKey;
    const rows = [...(rowsByRung.get(key) ?? [])].sort((a, b) =>
      a.humanId < b.humanId ? -1 : a.humanId > b.humanId ? 1 : a.companyKey < b.companyKey ? -1 : a.companyKey > b.companyKey ? 1 : 0,
    );
    const cards: LifecycleCard[] = [];
    const byOrg = new Map<string, number>();
    orgMaxByRung.set(key, byOrg);
    const leadIds = new Set<string>();
    let allStated = true;
    const entrySources = new Set<EntryRateSource>();
    for (const row of rows) {
      const held = [...new Set(row.leadIds)].sort().flatMap((id) => byLead.get(id) ?? []);
      if (held.length === 0) {
        outOfScopeCardCount += 1;
        continue;
      }
      let best: PersonValue | null = null;
      for (const { p, s } of held) {
        leadIds.add(p.leadId);
        if (unvaluedReason !== null || !valuedOf(s)) continue;
        const pv = valueOf(p, s, key);
        byOrg.set(orgKey(p), Math.max(byOrg.get(orgKey(p)) ?? 0, pv.v));
        if (best === null || pv.v > best.v) best = pv;
      }
      if (best && best.source !== "stated_amount") allStated = false;
      if (best?.entry) entrySources.add(best.entry);
      cards.push({
        humanId: row.humanId,
        companyKey: row.companyKey,
        relationKey: row.relationKey,
        leadIds: [...new Set(held.map(({ p }) => p.leadId))],
        valueUsd: best === null ? null : round(best.v),
        zeroValueReason: best?.zero ?? null,
        valueSource: best?.source ?? null,
        entryRateSource: best?.entry ?? null,
      });
    }
    const valueKind: LifecycleValueKind = key === "paid_client" ? "won_value" : key === "contacted" ? "contacted_expected_value" : "expected_value";
    const assumptions: LifecycleAssumption[] = [...ltrAssumption];
    if (key === "contacted") for (const s of [...entrySources].sort()) assumptions.push({ input: "entry_rate", source: s });
    const ledger = input.ledgerUnitsOf(key);
    return {
      key,
      rank: r.rank,
      label: r.label,
      valueKind,
      // Set below once every rung is known (an organisation counts once across the pipeline rungs).
      valueUsd: unvaluedReason !== null ? null : 0,
      expected: !(key === "paid_client" && cards.length > 0 && allStated),
      assumptions,
      cardCount: cards.length,
      leadCount: null,
      organizationCount: null,
      units: ledger.units,
      unitsUnavailableReason: ledger.units === null ? ledger.reason : null,
      ourUnits: ledger.ourUnits,
      otherFactoryUnits: ledger.otherFactoryUnits,
      cards,
    };
  });

  const organizationValues = new Map<string, number>();
  if (unvaluedReason === null) {
    // ONE organisation = ONE client (the pipeline's MAX over members): each organisation's value lands on the
    // pipeline rung holding its most valuable member (ties: the higher rung), never on every rung it touches.
    const pipelineRungs = rungs.filter((r) => r.key !== "paid_client");
    const top = new Map<string, { rung: BoardRungKey; v: number }>();
    for (const r of pipelineRungs) {
      for (const [org, v] of orgMaxByRung.get(r.key) ?? []) {
        const cur = top.get(org);
        if (cur === undefined || v >= cur.v) top.set(org, { rung: r.key, v });
      }
    }
    const perRung = new Map<BoardRungKey, number>();
    for (const [org, { rung, v }] of top) {
      perRung.set(rung, (perRung.get(rung) ?? 0) + v);
      organizationValues.set(org, (organizationValues.get(org) ?? 0) + v);
    }
    for (const r of pipelineRungs) r.valueUsd = round(perRung.get(r.key) ?? 0);
    const won = rungs.find((r) => r.key === "paid_client");
    // Won value = OUR Paid clients × LTR (another factory's are counted in `units`, worth nothing of ours).
    if (won) {
      won.valueUsd =
        input.wonUsd !== undefined
          ? input.wonUsd === null
            ? null
            : round(input.wonUsd)
          : won.ourUnits === null || ltr === null
            ? null
            : round(won.ourUnits * ltr);
    }
  }

  // A rung the ledger cannot value (won Units unknown) makes every total including it unknown, never a partial sum.
  const sum = (rs: LifecycleRungValue[]): number | null =>
    unvaluedReason !== null || rs.some((r) => r.valueUsd === null) ? null : round(rs.reduce((s, r) => s + (r.valueUsd ?? 0), 0));
  const board: DealsLifecycleResult = {
    columns: "lifecycle",
    lifetimeRevenueUsd: ltr,
    lifetimeRevenueSource: sources.length === 1 && input.scopes.every((s) => s.lifetimeRevenueSource === sources[0]) ? sources[0]! : null,
    pricedCauses: [...input.pricedCauses],
    unvaluedReason,
    totalUsd: sum(rungs),
    expectedPipelineUsd: sum(rungs.filter((r) => r.key !== "paid_client")),
    wonUsd: sum(rungs.filter((r) => r.key === "paid_client")),
    rungs,
    outOfScopeCardCount,
  };
  return { board, organizationValues };
}
