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
 *   - Contacted: the pipeline's `contactedLeadValue` on the pipeline's `contactedPricingSoft` (P(entry step |
 *     contacted, campaign × workflow) × the value at that step, expiring 30 days after the last send; a group with
 *     no measured entry rate on the seeded benchmark, `entryRateSource: "default_entry"`, never blank). A lead the
 *     engine already sees engaged is priced as an engaged lead; a bounced / unsubscribed one is 0 `cannot_convert`.
 *   - Engaged, Signed up, Meeting booked, Meeting attended: the engine's own expected value of the person
 *     (`expectedValueOfPerson`). An observed rung REPLACES the forecast pointing at it, exactly as the pipeline
 *     prices it. 0 says why (`zeroValueReason`).
 *   - Paid client: what was won: the amount a human STATED on the sale, else the offer's lifetime revenue per client
 *     (`valueSource`); a sale none of our pipes caused is 0 `not_ours`.
 *
 * A card is one Unibox row (a person at a company); its value is the MAX over its leads held by this population. A
 * rung's value is company-level, the pipeline's rule: one organisation = one client = the MAX over its members on
 * the rung, organisations summed. `totalUsd` = Σ rung values, `expectedPipelineUsd` = Σ of every rung but Paid
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
  | "not_sent";

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
  leadCount: number;
  organizationCount: number;
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

/** PURE. Every board rung's value from the engine's inputs and lead-service's lifecycle rows. */
export function priceLifecycleColumns(input: {
  rows: readonly LifecycleBoardRow[];
  persons: readonly EnginePerson[];
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: OfferLifetimeRevenueSource | null;
  /** The pipeline's own contacted pricing (`contactedPricingSoft`): measured group rates, else the seeded default. */
  contactedPricing: ContactedPricing;
  statedWonAmountUsdByEmail: ReadonlyMap<string, number> | null;
  pricedCauses: readonly string[];
}): DealsLifecycleResult {
  const ltr = input.lifetimeRevenueUsd;
  const unvaluedReason = ltr === null ? "no_economics" : !(ltr > 0) ? "no_client_value" : null;
  const byLead = new Map(input.persons.map((p) => [p.leadId, p] as const));
  const pricing = input.contactedPricing;
  const cutoff = pricing.lastSentOnOrAfter;

  const engagedValue = (p: EnginePerson): PersonValue => {
    const v = expectedValueOfPerson(p, input.paths, ltr!);
    const zero: LifecycleCardZeroReason | null =
      v !== 0 ? null : isRuledOut(p) ? "ruled_out" : reachedNotOurs(p) ? "not_ours" : "step_not_priced";
    return { v, zero, source: null, entry: null };
  };

  const valueOf = (p: EnginePerson, rung: BoardRungKey): PersonValue => {
    if (rung === "paid_client") {
      // A sale none of our pipes caused is the customer's, never our pipeline nor our won value.
      if (p.signals.closeWin && (p.unpricedSignals ?? []).includes("closeWin")) {
        return { v: 0, zero: "not_ours", source: null, entry: null };
      }
      const email = p.email?.trim().toLowerCase() ?? null;
      const stated = email ? (input.statedWonAmountUsdByEmail?.get(email) ?? null) : null;
      return stated !== null
        ? { v: stated, zero: null, source: "stated_amount", entry: null }
        : { v: ltr!, zero: null, source: "lifetime_revenue", entry: null };
    }
    if (rung !== "contacted") return engagedValue(p);
    // Contacted: the engine may already know more (an engaged lead is priced as one, never guessed down).
    if (ENGAGED_SIGNALS.some((s) => p.signals[s])) return engagedValue(p);
    if (p.signals.bounced || p.signals.unsubscribed) return { v: 0, zero: "cannot_convert", source: null, entry: null };
    if (!p.signals.contacted) return { v: 0, zero: "not_sent", source: null, entry: null };
    if (isRuledOut(p)) return { v: 0, zero: "ruled_out", source: null, entry: null };
    const entry = contactedEntryRatesOf(p, pricing);
    if (contactedExpired(p, cutoff)) return { v: 0, zero: "expired", source: null, entry: entry?.source ?? null };
    if (!entry) return { v: 0, zero: "step_not_priced", source: null, entry: null };
    // The byte-same function and pricing the pipeline values this lead with.
    const v = contactedLeadValue(p, input.paths, ltr!, pricing);
    return { v, zero: v === 0 ? "step_not_priced" : null, source: null, entry: entry.source };
  };

  const ltrAssumption: LifecycleAssumption[] = input.lifetimeRevenueSource
    ? [{ input: "lifetime_revenue", source: input.lifetimeRevenueSource }]
    : [];

  let outOfScopeCardCount = 0;
  const rowsByRung = new Map<BoardRungKey, LifecycleBoardRow[]>(BOARD_RUNG_KEYS.map((k) => [k, []]));
  for (const row of input.rows) rowsByRung.get(row.rung)?.push(row);

  const rungs: LifecycleRungValue[] = BOARD_LIFECYCLE_RUNGS.map((r) => {
    const key = r.key as BoardRungKey;
    const rows = [...(rowsByRung.get(key) ?? [])].sort((a, b) =>
      a.humanId < b.humanId ? -1 : a.humanId > b.humanId ? 1 : a.companyKey < b.companyKey ? -1 : a.companyKey > b.companyKey ? 1 : 0,
    );
    const cards: LifecycleCard[] = [];
    const byOrg = new Map<string, number>();
    const leadIds = new Set<string>();
    let allStated = true;
    const entrySources = new Set<EntryRateSource>();
    for (const row of rows) {
      const held = [...new Set(row.leadIds)].sort().map((id) => byLead.get(id)).filter((p): p is EnginePerson => p !== undefined);
      if (held.length === 0) {
        outOfScopeCardCount += 1;
        continue;
      }
      let best: PersonValue | null = null;
      for (const p of held) {
        leadIds.add(p.leadId);
        if (unvaluedReason !== null) continue;
        const pv = valueOf(p, key);
        byOrg.set(orgKey(p), Math.max(byOrg.get(orgKey(p)) ?? 0, pv.v));
        if (best === null || pv.v > best.v) best = pv;
      }
      if (best && best.source !== "stated_amount") allStated = false;
      if (best?.entry) entrySources.add(best.entry);
      cards.push({
        humanId: row.humanId,
        companyKey: row.companyKey,
        relationKey: row.relationKey,
        leadIds: held.map((p) => p.leadId),
        valueUsd: best === null ? null : round(best.v),
        zeroValueReason: best?.zero ?? null,
        valueSource: best?.source ?? null,
        entryRateSource: best?.entry ?? null,
      });
    }
    const valueKind: LifecycleValueKind = key === "paid_client" ? "won_value" : key === "contacted" ? "contacted_expected_value" : "expected_value";
    const assumptions: LifecycleAssumption[] = [...ltrAssumption];
    if (key === "contacted") for (const s of [...entrySources].sort()) assumptions.push({ input: "entry_rate", source: s });
    const organizationCount = new Set(
      cards.flatMap((c) => c.leadIds.map((id) => orgKey(byLead.get(id)!))),
    ).size;
    return {
      key,
      rank: r.rank,
      label: r.label,
      valueKind,
      valueUsd: unvaluedReason !== null ? null : round([...byOrg.values()].reduce((s, v) => s + v, 0)),
      expected: !(key === "paid_client" && cards.length > 0 && allStated),
      assumptions,
      cardCount: cards.length,
      leadCount: leadIds.size,
      organizationCount,
      cards,
    };
  });

  const sum = (rs: LifecycleRungValue[]): number | null =>
    unvaluedReason !== null ? null : round(rs.reduce((s, r) => s + (r.valueUsd ?? 0), 0));
  return {
    columns: "lifecycle",
    lifetimeRevenueUsd: ltr,
    lifetimeRevenueSource: input.lifetimeRevenueSource,
    pricedCauses: [...input.pricedCauses],
    unvaluedReason,
    totalUsd: sum(rungs),
    expectedPipelineUsd: sum(rungs.filter((r) => r.key !== "paid_client")),
    wonUsd: sum(rungs.filter((r) => r.key === "paid_client")),
    rungs,
    outOfScopeCardCount,
  };
}
