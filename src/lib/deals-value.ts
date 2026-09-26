/**
 * WHAT EACH DEALS-BOARD COLUMN IS WORTH — the dollar value of the people lead-service places at each
 * standing, per column and per card. A SEPARATE figure: added to no pipeline, no ROI, no cost figure.
 *
 * The board draws one column per lead-service STANDING. Which people are in a column is lead-service's
 * answer (its `?standing=` filter), never re-derived here; what they are worth is this service's.
 *
 *   - `sales_interest` (Interested) — each person at the engine's OWN expected value, the byte-same
 *     `evForPerson` the brand's pipeline prices them on (same paths, same LTR, same overlays, same
 *     priced causes). The column total is company-level exactly as the pipeline is: an organisation is
 *     one client, so it is worth the MAX over its members in the column, and organisations are summed.
 *     So the column is a SUBSET of the pipeline and can never exceed it.
 *   - `customer` (Won) — what was won: the amount a human STATED on the sale (whoever caused it — this
 *     column shows the deal, not our share of it), else the brand's lifetime revenue per client, and
 *     each card says which (`valueSource`). One organisation is one client: MAX over its members.
 *   - `disqualified`, `opted_out`, `not_contacted`, `unresolved` — no value, and the column SAYS so with a
 *     reason (`unvaluedReason`), never a 0. A lead ruled out or opted out is worth nothing going forward
 *     and we do not invent a past value; a lead never placed has done nothing to price.
 *   - `contacted` / `engaged` are not valued here: the Contacted column's value is
 *     `GET /brands/:brandId/contacted-value` (a different model — P(paid client | contacted)).
 *
 * A valued column with nothing priceable (no economics, no client value) is `valueUsd: null` with the
 * reason, never 0. A person lead-service places in the column that this service's population does not
 * hold (the two reads are minutes apart) is counted in `unpricedLeadCount` and carries a null card.
 */
import { expectedValueOfPerson, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";

export const VALUED_STANDINGS = ["sales_interest", "customer"] as const;
export type ValuedStanding = (typeof VALUED_STANDINGS)[number];

export type DealsColumnUnvaluedReason =
  /** The brand has no sales economics at all (cold start). */
  | "no_economics"
  /** The brand states no value for a client, and nobody stated an amount. */
  | "no_client_value"
  /** A human ruled the lead out: nothing to win going forward. */
  | "ruled_out"
  /** The prospect opted out: nothing to win going forward. */
  | "opted_out"
  /** Never contacted / never placed on a campaign: nothing has happened to price. */
  | "not_placed"
  /** lead-service could not resolve where these leads stand. */
  | "standing_unresolved"
  /** Valued by `GET /brands/:brandId/contacted-value`, not here. */
  | "see_contacted_value"
  /** Engaged but not on the step the campaign sells: the pipeline prices them, the board draws no value. */
  | "not_a_deal_column";

export type WonValueSource = "stated_amount" | "lifetime_revenue";

export interface DealCard {
  leadId: string;
  /** Null when the column has no value, or this service holds no such lead yet. */
  valueUsd: number | null;
  /** Won column only: where the amount comes from. */
  valueSource?: WonValueSource | null;
}

export interface DealsColumn {
  standing: string;
  /** Company-level total; null exactly when `unvaluedReason` is set. */
  valueUsd: number | null;
  unvaluedReason: DealsColumnUnvaluedReason | null;
  /** How the value is built, in words, so a surface can say it. Null for an unvalued column. */
  basis: "expected_value" | "won_value" | null;
  /** People lead-service places in the column (valued columns only; null otherwise). */
  leadCount: number | null;
  /** Distinct organisations those people belong to (valued columns only). */
  organizationCount: number | null;
  /** People in the column this service's lead population did not hold (priced at null). */
  unpricedLeadCount: number | null;
  leads: DealCard[];
}

export interface DealsValueResult {
  lifetimeRevenueUsd: number | null;
  columns: DealsColumn[];
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const orgKey = (p: EnginePerson): string => (p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`);

const UNVALUED: ReadonlyArray<[string, DealsColumnUnvaluedReason]> = [
  ["contacted", "see_contacted_value"],
  ["engaged", "not_a_deal_column"],
  ["disqualified", "ruled_out"],
  ["opted_out", "opted_out"],
  ["not_contacted", "not_placed"],
  ["unresolved", "standing_unresolved"],
];

function unvalued(standing: string, reason: DealsColumnUnvaluedReason): DealsColumn {
  return {
    standing,
    valueUsd: null,
    unvaluedReason: reason,
    basis: null,
    leadCount: null,
    organizationCount: null,
    unpricedLeadCount: null,
    leads: [],
  };
}

/** PURE. Every column's value from the pipeline's own inputs and lead-service's column membership. */
export function priceDealsColumns(input: {
  /** Deduped persons with every pipeline overlay applied (default priced causes). */
  persons: readonly EnginePerson[];
  /** The engine's paths for this brand, already restricted to the priced funnels' legs. */
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  /** lead-service's members per valued standing. */
  members: Record<ValuedStanding, ReadonlySet<string>>;
  /** Per canonical email: the amount a human stated on the SALE, whoever caused it. */
  statedWonAmountUsdByEmail: ReadonlyMap<string, number> | null;
}): DealsValueResult {
  const ltr = input.lifetimeRevenueUsd;
  const byLead = new Map(input.persons.map((p) => [p.leadId, p] as const));

  const column = (standing: ValuedStanding): DealsColumn => {
    const ids = [...input.members[standing]].sort();
    const held = ids.map((id) => byLead.get(id) ?? null);
    const organizationCount = new Set(held.map((p, i) => (p ? orgKey(p) : `lead:${ids[i]}`))).size;
    const unpricedLeadCount = held.filter((p) => p === null).length;
    const base = { standing, leadCount: ids.length, organizationCount, unpricedLeadCount };

    if (standing === "sales_interest") {
      const reason: DealsColumnUnvaluedReason | null = ltr === null ? "no_economics" : !(ltr > 0) ? "no_client_value" : null;
      const values = held.map((p) => (reason !== null || p === null ? null : expectedValueOfPerson(p, input.paths, ltr!)));
      return {
        ...base,
        ...companyTotal(held, values, reason),
        basis: reason === null ? "expected_value" : null,
        leads: ids.map((leadId, i) => ({ leadId, valueUsd: values[i] === null ? null : round(values[i]!) })),
      };
    }

    // Won: the stated amount of the sale, else the brand's value of a client.
    const cards: DealCard[] = [];
    const values: Array<number | null> = [];
    for (let i = 0; i < ids.length; i += 1) {
      const p = held[i];
      const email = p?.email?.trim().toLowerCase() ?? null;
      const stated = email ? (input.statedWonAmountUsdByEmail?.get(email) ?? null) : null;
      let v: number | null = null;
      let source: WonValueSource | null = null;
      if (p && stated !== null) {
        v = stated;
        source = "stated_amount";
      } else if (p && ltr !== null && ltr > 0) {
        v = ltr;
        source = "lifetime_revenue";
      }
      values.push(v);
      cards.push({ leadId: ids[i], valueUsd: v === null ? null : round(v), valueSource: source });
    }
    const anyValue = values.some((v) => v !== null);
    const reason: DealsColumnUnvaluedReason | null =
      ids.length === 0 || anyValue ? null : ltr === null ? "no_economics" : "no_client_value";
    return {
      ...base,
      ...companyTotal(held, values, reason),
      basis: reason === null ? "won_value" : null,
      leads: cards,
    };
  };

  return {
    lifetimeRevenueUsd: ltr,
    columns: [
      column("sales_interest"),
      column("customer"),
      ...UNVALUED.map(([standing, reason]) => unvalued(standing, reason)),
    ],
  };
}

/** Company-level: an organisation is one client — the MAX over its members; organisations summed. */
function companyTotal(
  held: ReadonlyArray<EnginePerson | null>,
  values: ReadonlyArray<number | null>,
  reason: DealsColumnUnvaluedReason | null,
): { valueUsd: number | null; unvaluedReason: DealsColumnUnvaluedReason | null } {
  if (reason !== null) return { valueUsd: null, unvaluedReason: reason };
  const byOrg = new Map<string, number>();
  held.forEach((p, i) => {
    const v = values[i];
    if (!p || v === null) return;
    const key = orgKey(p);
    byOrg.set(key, Math.max(byOrg.get(key) ?? 0, v));
  });
  return { valueUsd: round([...byOrg.values()].reduce((s, v) => s + v, 0)), unvaluedReason: null };
}
