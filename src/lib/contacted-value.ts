/**
 * WHAT A CONTACTED LEAD WHO HAS NOT CONVERTED YET IS ALREADY WORTH — in expectation.
 *
 * A delivery is a step of no funnel, so it prices nothing on its own (#863). But a contacted lead has a
 * known chance of reaching a funnel's first step, and the brand owner asks of the people sitting in
 * the "Contacted" column: given the brand's own conversion ladder and client value, what is somebody we
 * emailed worth BEFORE they do anything? That value now COUNTS in the pipeline (see below).
 *
 *   value(contacted lead) = LTR × P(paid client | contacted)
 *   P(paid client | contacted) = orP over the ENTRY ROUTES r of  P(r | contacted) × P(paid client | r)
 *
 * - The entry routes are exactly the engine's engagement routes (click, positive reply) on the funnels
 *   this brand is priced on, and `P(paid client | r) × LTR` IS the engine's own path value for r — the
 *   same `resolvePaths` ladder, the same restriction to the priced funnels' legs, the same LTR. So a
 *   contacted lead that clicks tomorrow moves from `P(click | contacted) × pathValue` to `pathValue`,
 *   never onto a different price.
 * - The routes are combined as independent shots at one close (`combineIndependent`), exactly as the
 *   engine combines a lead that fired both.
 * - A route the lead was ruled out of by a human (`deadSignals`) contributes nothing.
 *
 * ── P(entry step | contacted): WHERE IT IS MEASURED ────────────────────────────────────────────────
 *
 *   1. BRAND — on the brand's own MATURE cohort, by the ROUTE's own leg rule (`lib/maturity.ts`: the
 *      click route is the `start_to_website_visit` leg, the reply route `start_to_conversation`): leads
 *      SERVED (run-start clock) before UTC midnight of `today − duration` (21 days: a cold email's
 *      clicks and replies keep landing for weeks after it is sent, so counting last week's serves would
 *      read the rate low). Leads with no serve date are left out of the rate (their age is unknown). The
 *      bar is the leg's own MATURE-outcome count (`outcomesRequired`: 10 visits, 1 positive reply), not a
 *      bar on the denominator like the between-step arrows.
 *   2. FLEET — the cross-org rate on the same channels (email-gateway public recipient stats, every
 *      brand's lifetime, pooled). A measurement of the same arrow on everybody's outreach.
 *   3. Neither → that route reads null, and a lead with no route priced reads null with a named reason.
 *      Never a 0 and never a default.
 *
 * ── WHO IS PRICED ──────────────────────────────────────────────────────────────────────────────────
 *
 * A lead is "contacted only" when it was contacted, did not bounce or unsubscribe (those cannot convert
 * — `cannot_convert`), and reached NO conversion signal at all — no click, no reply of any class, no
 * meeting, no signup, no form, no sale (`engaged`: its value, if any, is the pipeline's). An opener is
 * still contacted-only: an open is a delivery milestone, not a funnel leg.
 *
 * ── IT IS PIPELINE, AND IT EXPIRES ─────────────────────────────────────────────────────────────────
 *
 * The per-lead value is the engine's own `contactedLeadValue` — the byte-same function the pipeline
 * prices a contacted-only lead with (`computeRevenue`'s `contacted` pricing), so this read states
 * exactly what these leads add to the brand's pipeline and ROI. A lead with no email SENT in the last
 * `CONTACTED_VALUE_EXPIRY_DAYS` (30) days — counted from the provider's per-step sent event, never the
 * contacted or first-send date — is worth 0 (`expired`). A lead not sent anything yet counts while
 * pending, bounded to 30 days after hand-off. The TOTAL is the pipeline's per-company rule:
 * Σ over organisations of the most valuable member.
 */
import {
  combineIndependent,
  contactedExpiryCutoffIso,
  contactedExpired,
  contactedLeadValue,
  CONTACTED_VALUE_EXPIRY_DAYS,
  ENGAGED_SIGNALS,
  type ContactedPricing,
  type EnginePerson,
  type ResolvedPath,
} from "./revenue-engine.js";
import { legMaturity, maturityCutoffIso, servedInMatureCohort } from "./maturity.js";

export { ENGAGED_SIGNALS };

/** The funnel step each entry route lands on, in the catalogue's own wording. */
const ROUTE_STEP: Record<string, string> = {
  clicked: "Website visit",
  positiveReply: "Positive reply",
};

/** The LEG each entry route IS — whose maturity rule (`lib/maturity.ts`) its brand rate is measured on. */
const ROUTE_LEG: Record<string, string> = {
  clicked: "start_to_website_visit",
  positiveReply: "start_to_conversation",
};

export type EntryRateSource = "brand_measured" | "fleet_measured";

export type ContactedValueUnmeasuredReason =
  /** The brand has no economics at all (cold start). */
  | "no_economics"
  /** The brand states no value for a client (lifetime revenue 0 or absent). */
  | "no_client_value"
  /** No funnel the brand is priced on is entered through a click or a positive reply. */
  | "no_entry_path"
  /** An entry path exists but no source measures how often a contacted lead reaches it. */
  | "no_entry_rate";

export interface EntryCounts {
  contacted: number;
  reached: number;
}

export interface ContactedEntryRoute {
  /** The engine signal of the route (`clicked` / `positiveReply`). */
  signal: string;
  /** The funnel step the route lands on. */
  step: string;
  /** P(this step | contacted), 0..100, from `entryRateSource`. Null when no source measures it. */
  entryRatePct: number | null;
  entryRateSource: EntryRateSource | null;
  /** The brand's mature cohort: leads served before this route's own cutoff, and how many reached the step. */
  brand: EntryCounts;
  /** The route's leg maturity duration (`lib/maturity.ts`). */
  maturityDays: number;
  /** The route's own cutoff: leads served before this instant count toward the brand rate. */
  matureBefore: string;
  /** Mature outcomes the brand needs on this route before its own rate is used (the leg's bar). */
  minBrandOutcomes: number;
  /** The fleet's pooled counts on the same channels. Null when that read failed. */
  fleet: EntryCounts | null;
  /** P(paid client | this step), 0..100 — the engine's own ladder for the step. */
  paidClientGivenStepPct: number;
  /** What a lead standing on this step is worth — the engine's own path value. */
  valueAtStepUsd: number;
}

export interface ContactedLeadValue {
  leadId: string;
  /**
   * LTR × P(paid client | contacted) — the SAME value this lead carries in the pipeline. `0` once it has
   * EXPIRED (`expired`). Null exactly when the response's `unmeasuredReason` is set.
   */
  expectedValueUsd: number | null;
  /** True when the last send is older than `expiryDays` days (or, never sent, it was handed off longer ago): worth nothing. */
  expired: boolean;
}

export interface ContactedValueResult {
  /** The client value every figure is priced on (the same LTR the pipeline uses). */
  lifetimeRevenueUsd: number | null;
  /** P(paid client | contacted), 0..100, for a lead no human ruled out of any route. */
  contactedToPaidClientPct: number | null;
  /** LTR × that probability — every contacted-only lead's value unless a human ruled out a route. */
  perLeadExpectedValueUsd: number | null;
  /**
   * Σ over organisations of the MOST valuable contacted-only member — the pipeline's own per-company
   * rule (1 organisation = 1 client), so this is exactly what these leads add to the pipeline.
   */
  totalExpectedValueUsd: number | null;
  unmeasuredReason: ContactedValueUnmeasuredReason | null;
  routes: ContactedEntryRoute[];
  /** The EARLIEST route cutoff (each route states its own on `routes[]`). */
  matureBefore: string;
  /** The LONGEST route duration (each route states its own on `routes[]`). */
  maturityDays: number;
  /** A contacted lead whose last send is older than this many days is worth nothing. */
  expiryDays: number;
  /** Leads whose last send is strictly before this instant have expired. */
  lastSentOnOrAfter: string;
  /** The LARGEST route bar (each route states its own on `routes[]`). */
  minBrandOutcomes: number;
  population: {
    contactedOnly: number;
    organizations: number;
    /** Contacted leads that engaged (their value, if any, is the pipeline's). */
    engaged: number;
    /** Contacted leads that bounced or unsubscribed. */
    cannotConvert: number;
    /** Contacted-only leads with no email sent in the last `expiryDays` days — valued at 0. */
    expired: number;
  };
  /** One row per contacted-only lead, ordered by lead id. */
  leads: ContactedLeadValue[];
}

/** The extremes of the two entry routes' leg rules — what the response's single-valued fields state. */
function entryRuleExtremes(now: Date): { matureBefore: string; maturityDays: number; minBrandOutcomes: number } {
  const rules = Object.values(ROUTE_LEG).map((legKey) => legMaturity(legKey));
  const maturityDays = Math.max(...rules.map((r) => r.durationDays));
  return {
    maturityDays,
    matureBefore: maturityCutoffIso(maturityDays, now),
    minBrandOutcomes: Math.max(...rules.map((r) => r.outcomesRequired)),
  };
}

/** Pooled fleet counts per entry signal (null = the fleet read failed). */
export type FleetEntryCounts = Record<string, EntryCounts> | null;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** PURE. The whole figure, from inputs the engine already uses. */
export function priceContactedLeads(input: {
  /** The engine's paths for this brand (already restricted to the priced funnels' legs). */
  paths: readonly ResolvedPath[];
  /** Deduped persons with every overlay applied (signals, dates, dead signals). */
  persons: readonly EnginePerson[];
  /** LTR, or null at cold start. */
  lifetimeRevenueUsd: number | null;
  fleet: FleetEntryCounts;
  now?: Date;
}): ContactedValueResult {
  const nowForCutoff = input.now ?? new Date();
  const ltr = input.lifetimeRevenueUsd;

  // ── Population
  let engaged = 0;
  let cannotConvert = 0;
  const contactedOnly: EnginePerson[] = [];
  for (const p of input.persons) {
    if (!p.signals.contacted) continue;
    if (ENGAGED_SIGNALS.some((s) => p.signals[s])) {
      engaged += 1;
      continue;
    }
    if (p.signals.bounced || p.signals.unsubscribed) {
      cannotConvert += 1;
      continue;
    }
    contactedOnly.push(p);
  }
  contactedOnly.sort((a, b) => (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0));

  // ── Entry routes: the engine's engagement routes, each with its entry rate, measured on the route's
  // OWN leg rule — its duration cuts the cohort (on the serve clock), its bar gates the brand's own rate.
  // A lead with no serve date is left out of a RATE: its age is unknown.
  type WorkingRoute = ContactedEntryRoute & { _pathValue: number; _p: number | null };
  const routes: WorkingRoute[] = input.paths
    .filter((path) => path.engagementRoute && ROUTE_STEP[path.signal] !== undefined)
    .map((path) => {
      const rule = legMaturity(ROUTE_LEG[path.signal]);
      const routeCutoff = maturityCutoffIso(rule.durationDays, nowForCutoff);
      const mature = input.persons.filter(
        (p) => Boolean(p.signals.contacted) && p.servedAt != null && servedInMatureCohort(p.servedAt, routeCutoff),
      );
      const brand = { contacted: mature.length, reached: mature.filter((p) => p.signals[path.signal]).length };
      const fleet = input.fleet ? (input.fleet[path.signal] ?? { contacted: 0, reached: 0 }) : null;
      let entryRatePct: number | null = null;
      let entryRateSource: EntryRateSource | null = null;
      if (brand.contacted > 0 && brand.reached >= rule.outcomesRequired) {
        entryRatePct = (brand.reached / brand.contacted) * 100;
        entryRateSource = "brand_measured";
      } else if (fleet && fleet.contacted > 0 && fleet.reached <= fleet.contacted) {
        entryRatePct = (fleet.reached / fleet.contacted) * 100;
        entryRateSource = "fleet_measured";
      }
      return {
        signal: path.signal,
        step: ROUTE_STEP[path.signal],
        entryRatePct: entryRatePct === null ? null : round(entryRatePct),
        entryRateSource,
        brand,
        fleet,
        maturityDays: rule.durationDays,
        matureBefore: routeCutoff,
        minBrandOutcomes: rule.outcomesRequired,
        paidClientGivenStepPct: ltr && ltr > 0 ? round((path.expectedRevenueUsd / ltr) * 100) : 0,
        valueAtStepUsd: round(path.expectedRevenueUsd),
        _pathValue: path.expectedRevenueUsd,
        _p: entryRatePct === null ? null : entryRatePct / 100,
      };
    });

  const unmeasuredReason: ContactedValueUnmeasuredReason | null =
    ltr === null
      ? "no_economics"
      : !(ltr > 0)
        ? "no_client_value"
        : routes.length === 0
          ? "no_entry_path"
          : routes.every((r) => r._p === null)
            ? "no_entry_rate"
            : null;

  // ONE pricing, the engine's: the byte-same function the pipeline prices these leads with.
  const now = input.now ?? new Date();
  const pricing: ContactedPricing = {
    entryRatePct: Object.fromEntries(routes.filter((r) => r._p !== null).map((r) => [r.signal, r._p! * 100])),
    lastSentOnOrAfter: contactedExpiryCutoffIso(now),
  };
  const isExpired = (p: EnginePerson): boolean => contactedExpired(p, pricing.lastSentOnOrAfter);
  const valueOf = (person: EnginePerson): number | null =>
    unmeasuredReason !== null ? null : contactedLeadValue(person, input.paths, ltr!, pricing);

  const leads: ContactedLeadValue[] = contactedOnly.map((p) => {
    const v = valueOf(p);
    return {
      leadId: p.leadId,
      expectedValueUsd: v === null ? null : round(v),
      expired: isExpired(p),
    };
  });

  // Company-level total, the pipeline's own rule: an organisation is worth its most valuable member.
  const byOrg = new Map<string, number>();
  contactedOnly.forEach((p) => {
    const v = valueOf(p);
    if (v === null) return;
    const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
    byOrg.set(key, Math.max(byOrg.get(key) ?? 0, v));
  });
  const totalExpectedValueUsd =
    unmeasuredReason !== null ? null : round([...byOrg.values()].reduce((sum, v) => sum + v, 0));

  const perLead = unmeasuredReason !== null ? null : combineIndependent(
    routes.filter((r) => r._p !== null).map((r) => r._p! * r._pathValue),
    ltr!,
  );

  return {
    lifetimeRevenueUsd: ltr,
    contactedToPaidClientPct: perLead === null ? null : round((perLead / ltr!) * 100),
    perLeadExpectedValueUsd: perLead === null ? null : round(perLead),
    totalExpectedValueUsd,
    unmeasuredReason,
    routes: routes.map(({ _pathValue, _p, ...r }) => r),
    // Both entry legs carry one rule today; a route list states each route's own, these the extremes.
    matureBefore: entryRuleExtremes(nowForCutoff).matureBefore,
    maturityDays: entryRuleExtremes(nowForCutoff).maturityDays,
    expiryDays: CONTACTED_VALUE_EXPIRY_DAYS,
    lastSentOnOrAfter: pricing.lastSentOnOrAfter,
    minBrandOutcomes: entryRuleExtremes(nowForCutoff).minBrandOutcomes,
    population: {
      contactedOnly: contactedOnly.length,
      organizations: new Set(contactedOnly.map((p) => (p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`))).size,
      engaged,
      cannotConvert,
      expired: contactedOnly.filter(isExpired).length,
    },
    leads,
  };
}

/** PURE. Sum email-gateway's per-group fleet recipient stats into entry counts per engine signal. */
export function fleetEntryCountsOf(groups: Iterable<Record<string, number>>): Record<string, EntryCounts> {
  let contacted = 0;
  let clicked = 0;
  let replied = 0;
  for (const g of groups) {
    contacted += Number(g.recipientsContacted) || 0;
    clicked += Number(g.recipientsClicked) || 0;
    replied += Number(g.recipientsRepliesPositive) || 0;
  }
  return {
    clicked: { contacted, reached: clicked },
    positiveReply: { contacted, reached: replied },
  };
}
