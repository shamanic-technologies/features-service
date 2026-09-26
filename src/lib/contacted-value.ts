/**
 * WHAT A CONTACTED LEAD WHO HAS NOT CONVERTED YET IS ALREADY WORTH — in expectation, and SEPARATE from
 * the pipeline.
 *
 * The pipeline prices a lead only once it reached a leg of a funnel (a website visit, a positive
 * reply…): a delivery is a step of no funnel, so an email that reached somebody who has not engaged is
 * worth $0 there, on purpose (#863). That stays true. This module answers a DIFFERENT question the brand
 * owner asks of the people sitting in the "Contacted" column: given the brand's own conversion ladder
 * and client value, what is somebody we emailed worth BEFORE they do anything?
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
 *   1. BRAND — on the brand's own MATURE cohort: leads first contacted before UTC midnight of
 *      `today − OUTCOME_LAG_DAYS` (a cold email's clicks and replies keep landing ~two weeks after it
 *      is sent, so counting last week's sends would read the rate low). Undated leads are left out of
 *      the rate (their age is unknown). The bar is on the OUTCOMES (`LEARNING_OUTCOMES_REQUIRED`, 10),
 *      not on the denominator like the between-step arrows: an entry arrow converts a few percent at
 *      most, so ten contacted with zero clicks is chance, not a 0% rate.
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
 * The TOTAL is company-level: people of one organisation are combined as independent shots at one
 * client (the same bound the engine applies per organisation), then summed over organisations.
 */
import { combineIndependent, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import { LEARNING_OUTCOMES_REQUIRED, OUTCOME_LAG_DAYS } from "./learning-phase.js";
import { maturityCutoffIso } from "./roi-maturity.js";

/** Signals that mean the lead did something beyond receiving the email. */
export const ENGAGED_SIGNALS = [
  "clicked",
  "positiveReply",
  "negativeReply",
  "neutralReply",
  "meeting",
  "meetingAttended",
  "closeWin",
  "signup",
  "formSubmission",
] as const;

/** The funnel step each entry route lands on, in the catalogue's own wording. */
const ROUTE_STEP: Record<string, string> = {
  clicked: "Website visit",
  positiveReply: "Positive reply",
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
  /** The brand's mature cohort: dated leads first contacted before `matureBefore`, and how many reached the step. */
  brand: EntryCounts;
  /** The fleet's pooled counts on the same channels. Null when that read failed. */
  fleet: EntryCounts | null;
  /** P(paid client | this step), 0..100 — the engine's own ladder for the step. */
  paidClientGivenStepPct: number;
  /** What a lead standing on this step is worth — the engine's own path value. */
  valueAtStepUsd: number;
}

export interface ContactedLeadValue {
  leadId: string;
  /** LTR × P(paid client | contacted). Null exactly when the response's `unmeasuredReason` is set. */
  expectedValueUsd: number | null;
}

export interface ContactedValueResult {
  /** The client value every figure is priced on (the same LTR the pipeline uses). */
  lifetimeRevenueUsd: number | null;
  /** P(paid client | contacted), 0..100, for a lead no human ruled out of any route. */
  contactedToPaidClientPct: number | null;
  /** LTR × that probability — every contacted-only lead's value unless a human ruled out a route. */
  perLeadExpectedValueUsd: number | null;
  /** Σ over organisations of the combined value of that organisation's contacted-only leads. */
  totalExpectedValueUsd: number | null;
  unmeasuredReason: ContactedValueUnmeasuredReason | null;
  routes: ContactedEntryRoute[];
  /** The brand cohort's cutoff: leads first contacted before this instant count toward the brand rate. */
  matureBefore: string;
  maturityDays: number;
  minBrandOutcomes: number;
  population: {
    contactedOnly: number;
    organizations: number;
    /** Contacted leads that engaged (their value, if any, is the pipeline's). */
    engaged: number;
    /** Contacted leads that bounced or unsubscribed. */
    cannotConvert: number;
  };
  /** One row per contacted-only lead, ordered by lead id. */
  leads: ContactedLeadValue[];
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
  const matureBefore = maturityCutoffIso(OUTCOME_LAG_DAYS, input.now ?? new Date());
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

  // ── Entry routes: the engine's engagement routes, each with its entry rate.
  const mature = input.persons.filter((p) => {
    const at = p.signalDates?.contacted ?? null;
    return Boolean(p.signals.contacted) && at !== null && at < matureBefore;
  });
  type WorkingRoute = ContactedEntryRoute & { _pathValue: number; _p: number | null };
  const routes: WorkingRoute[] = input.paths
    .filter((path) => path.engagementRoute && ROUTE_STEP[path.signal] !== undefined)
    .map((path) => {
      const brand = { contacted: mature.length, reached: mature.filter((p) => p.signals[path.signal]).length };
      const fleet = input.fleet ? (input.fleet[path.signal] ?? { contacted: 0, reached: 0 }) : null;
      let entryRatePct: number | null = null;
      let entryRateSource: EntryRateSource | null = null;
      if (brand.contacted > 0 && brand.reached >= LEARNING_OUTCOMES_REQUIRED) {
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

  const valueOf = (person: EnginePerson): number | null => {
    if (unmeasuredReason !== null) return null;
    const dead = new Set(person.deadSignals ?? []);
    const evs = routes.filter((r) => r._p !== null && !dead.has(r.signal)).map((r) => r._p! * r._pathValue);
    return combineIndependent(evs, ltr!);
  };

  const leads: ContactedLeadValue[] = contactedOnly.map((p) => {
    const v = valueOf(p);
    return { leadId: p.leadId, expectedValueUsd: v === null ? null : round(v) };
  });

  // Company-level total: one organisation = one client at most.
  const byOrg = new Map<string, number[]>();
  contactedOnly.forEach((p, i) => {
    const v = leads[i].expectedValueUsd;
    if (v === null) return;
    const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
    const list = byOrg.get(key) ?? [];
    list.push(valueOf(p)!);
    byOrg.set(key, list);
  });
  const totalExpectedValueUsd =
    unmeasuredReason !== null ? null : round([...byOrg.values()].reduce((sum, evs) => sum + combineIndependent(evs, ltr!), 0));

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
    matureBefore,
    maturityDays: OUTCOME_LAG_DAYS,
    minBrandOutcomes: LEARNING_OUTCOMES_REQUIRED,
    population: {
      contactedOnly: contactedOnly.length,
      organizations: new Set(contactedOnly.map((p) => (p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`))).size,
      engaged,
      cannotConvert,
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
