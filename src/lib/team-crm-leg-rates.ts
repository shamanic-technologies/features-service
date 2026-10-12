/**
 * A brand's OWN historical rate on each leg its team works, read from its tools (crm-service leg reach,
 * `lib/team-leg-reach-client.ts`; owner 2026-10-12: "tu devrais avoir un taux historique sur la base des données
 * que tu as"). Feeds the per-offer catalogue read (`routes/agent-catalogue.ts` `offerContextOf`) where the brand's
 * effective rates (`getBrandEffectiveRates`) have NO measured or stated rate for the leg: a customer-team leg the
 * catalogue declared (Lead found -> Paid client, ...) then prices on the team's own history, never a blank.
 *
 * Rate = people who reached TO (filed on the day they reached FROM when crm-service serves the cohort, else on their
 * own day) / people who reached FROM, over every day + undated. Population = crm-service's (the brand's people who
 * reached FROM and whom our campaigns never contacted). Below `MIN_MEASURED_FROM_REACHED` people at FROM there is no
 * rate (the same bar as every measured rate). A leg crm-service cannot answer is skipped with its reason.
 *
 * FAIL-SOFT, loud: an enrichment of an estimate. A failed read logs and answers no rate (the leg keeps its
 * fleet/default rate, named); it never 502s the catalogue. Cached per (org, brand) for 5 min (the history moves
 * on the scale of days).
 */
import { MIN_MEASURED_FROM_REACHED } from "./effective-conversion-rates.js";
import { fetchTeamLegReach, fetchTeamLegReachBrands, type TeamLegReach } from "./team-leg-reach-client.js";
import { mapWithConcurrency } from "./concurrency.js";

export interface TeamCrmLegRate {
  ratePct: number;
  fromPeople: number;
  toPeople: number;
}

const sum = (e: { daily: ReadonlyMap<string, number>; undated: number }): number => [...e.daily.values()].reduce((a, b) => a + b, 0) + e.undated;

/** PURE: the rate one leg-reach answer states, or null (unavailable, or fewer than the bar at FROM). */
export function teamCrmRateOf(reach: TeamLegReach): TeamCrmLegRate | null {
  if (!reach.available) return null;
  const fromPeople = sum(reach.from);
  if (fromPeople < MIN_MEASURED_FROM_REACHED) return null;
  const toPeople = sum(reach.toByFromDay ?? reach.to);
  return { ratePct: (100 * toPeople) / fromPeople, fromPeople, toPeople };
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Map<string, TeamCrmLegRate> }>();

/** Test seam. */
export function __resetTeamCrmLegRates(): void {
  cache.clear();
}

/**
 * IO: the brand's own rate per leg (`${from}>${to}` -> rate) over the given legs, for the ONE org asking (crm-service's
 * people are per org). Fail-soft (see the header).
 */
export async function fetchTeamCrmLegRates(
  orgId: string,
  brandId: string,
  legs: ReadonlyArray<{ fromStep: string; toStep: string }>,
): Promise<Map<string, TeamCrmLegRate>> {
  const key = `${orgId}|${brandId}|${legs.map((l) => `${l.fromStep}>${l.toStep}`).sort().join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const out = new Map<string, TeamCrmLegRate>();
  try {
    const { steps, brands } = await fetchTeamLegReachBrands();
    const brand = brands.find((b) => b.brandId === brandId && b.orgId === orgId);
    if (brand) {
      const uniq = [...new Map(legs.map((l) => [`${l.fromStep}>${l.toStep}`, l])).values()];
      await mapWithConcurrency(uniq, 4, async (l) => {
        const r = teamCrmRateOf(await fetchTeamLegReach(brand, steps, l.fromStep, l.toStep));
        if (r) out.set(`${l.fromStep}>${l.toStep}`, r);
      });
    }
  } catch (err) {
    console.error(`[features-service] team CRM leg rates for brand ${brandId} (org ${orgId}) unreadable, legs keep their fleet/default rate: ${(err as Error).message}`);
    return out;
  }
  cache.set(key, { at: Date.now(), value: out });
  return out;
}
