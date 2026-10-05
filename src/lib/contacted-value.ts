/**
 * WHAT A CONTACTED LEAD WHO HAS NOT CONVERTED YET IS ALREADY WORTH — in expectation.
 *
 * A delivery is a step of no funnel, so it prices nothing on its own (#863). But a contacted lead has a
 * known chance of reaching a funnel's first step, and the brand owner asks of the people sitting in
 * the "Contacted" column: what is somebody we emailed worth BEFORE they do anything? That value COUNTS
 * in the pipeline (see below).
 *
 *   value(contacted lead) = combineIndependent over the ENTRY ROUTES r of P(r | contacted, g) × pathValue(r)
 *
 * - The entry routes are exactly the engine's engagement routes (click, positive reply) on the funnels
 *   this brand is priced on, and `pathValue(r)` IS the engine's own path value for r — the same
 *   `resolvePaths` ladder, the same restriction to the priced funnels' legs, the same LTR. So a
 *   contacted lead that clicks tomorrow moves from `P(click | contacted) × pathValue` to `pathValue`,
 *   never onto a different price.
 * - A route the lead was ruled out of by a human (`deadSignals`) contributes nothing.
 *
 * ── P(entry step | contacted): THE WORKFLOWS THAT SERVED THE LEADS (owner 2026-10-05) ──────────────
 *
 * Priced with the SAME per-workflow cost-per-outcome estimates the workflow ranking serves, weighted by
 * the workflows that actually served the leads. Per group g = (campaignId, workflowSlug) of contacted
 * persons (every contacted person, engaged or bounced included: the spend bought all of them):
 *
 *   costPerContactUsd_g = committed spend_g ÷ contacted_g
 *   P(r | contacted, g) = min(1, costPerContactUsd_g ÷ costPerOutcomeUsd(g's workflow, leg(r)))
 *
 * so Σ over g's leads of P = spend_g ÷ $/outcome: expected outcomes are dollars ÷ the price of one. The
 * price is the leg-keyed workflow-projection ladder's `resolved.costPerOutcomeUsd` for the workflow's
 * dynasty — what `/offers/:offerId/sales-paths` reads — so a campaign 100% on one workflow reproduces
 * the sales path's ROI exactly. Every workflow has one even with 0 outcomes (the cascade floor). A
 * group the ladder does not price, or runs recorded no spend for, has NO rate on that route (null +
 * `unpricedReason`), never a fallback number. A person with no campaign or no workflow is unattributed.
 *
 * ── WHO IS PRICED ──────────────────────────────────────────────────────────────────────────────────
 *
 * A lead is "contacted only" when it was contacted, did not bounce or unsubscribe (`cannot_convert`),
 * and reached NO conversion signal at all (`engaged`: its value, if any, is the pipeline's). An opener
 * is still contacted-only: an open is a delivery milestone, not a funnel leg.
 *
 * ── IT IS PIPELINE, AND IT EXPIRES ─────────────────────────────────────────────────────────────────
 *
 * The per-lead value is the engine's own `contactedLeadValue` — the byte-same function the pipeline
 * prices a contacted-only lead with (`computeRevenue`'s `contacted` pricing). A lead with no email SENT
 * in the last `CONTACTED_VALUE_EXPIRY_DAYS` (30) days is worth 0 (`expired`); a lead not sent anything
 * yet counts while pending, bounded to 30 days after hand-off. The TOTAL is the pipeline's per-company
 * rule: Σ over organisations of the most valuable member.
 */
import {
  contactedExpiryCutoffIso,
  contactedExpired,
  contactedGroupKey,
  contactedLeadValue,
  CONTACTED_VALUE_EXPIRY_DAYS,
  ENGAGED_SIGNALS,
  type ContactedPricing,
  type EnginePerson,
  type ResolvedPath,
} from "./revenue-engine.js";

export { ENGAGED_SIGNALS };

/** The funnel step each entry route lands on, in the catalogue's own wording. */
const ROUTE_STEP: Record<string, string> = {
  clicked: "Website visit",
  positiveReply: "Positive reply",
};

/** The LEG each entry route IS — whose workflow-projection ladder prices it. */
const ROUTE_LEG: Record<string, string> = {
  clicked: "start_to_website_visit",
  positiveReply: "start_to_conversation",
};

export type ContactedValueUnmeasuredReason =
  /** The brand has no economics at all (cold start). */
  | "no_economics"
  /** The brand states no value for a client (lifetime revenue 0 or absent). */
  | "no_client_value"
  /** No funnel the brand is priced on is entered through a click or a positive reply. */
  | "no_entry_path"
  /** An entry path exists but no (campaign × workflow) group has a priced rate on it. */
  | "no_entry_rate";

export interface ContactedEntryRoute {
  /** The engine signal of the route (`clicked` / `positiveReply`). */
  signal: string;
  /** The funnel step the route lands on. */
  step: string;
  /** The leg the route IS (the ladder that prices it). */
  legKey: string;
  /** P(paid client | this step), 0..100 — the engine's own ladder for the step. */
  paidClientGivenStepPct: number;
  /** What a lead standing on this step is worth — the engine's own path value. */
  valueAtStepUsd: number;
}

/** What the ladder says one outcome of a route's leg costs on a group's workflow. */
export interface ContactedRoutePrice {
  costPerOutcomeUsd: number | null;
  /** Why there is no price (ladder status/reason, workflow absent, campaign unknown…). Null when priced. */
  unpricedReason: string | null;
}

/** PURE input: one (campaign × workflow) group's spend and per-route prices, resolved by the route. */
export interface ContactedGroupInput {
  campaignId: string;
  workflowSlug: string;
  offerId: string | null;
  featureSlug: string | null;
  workflowDynastySlug: string | null;
  /** Committed spend runs recorded on (campaign, workflow); null = runs recorded none. */
  committedSpentUsd: number | null;
  /** Keyed by engine signal. */
  prices: Readonly<Record<string, ContactedRoutePrice>>;
}

export interface ContactedWorkflowRoute {
  signal: string;
  legKey: string;
  costPerOutcomeUsd: number | null;
  unpricedReason: string | null;
  /** P(this step | contacted, group), 0..100 = min(100, 100 × costPerContact ÷ costPerOutcome). */
  entryRatePct: number | null;
  /** contacted × P: the outcomes this group's spend buys at the workflow's price. */
  expectedOutcomes: number | null;
}

export interface ContactedWorkflowGroup {
  campaignId: string;
  offerId: string | null;
  featureSlug: string | null;
  workflowSlug: string;
  workflowDynastySlug: string | null;
  /** Contacted persons of the group (deduped; engaged and bounced included). */
  contacted: number;
  committedSpentUsd: number | null;
  costPerContactUsd: number | null;
  routes: ContactedWorkflowRoute[];
}

export interface ContactedLeadValue {
  leadId: string;
  /**
   * The SAME value this lead carries in the pipeline. `0` once it has EXPIRED. Null when the response's
   * `unmeasuredReason` is set, or the lead's group has no priced route (unattributed / unpriced): the
   * pipeline counts such a lead as nothing.
   */
  expectedValueUsd: number | null;
  /** True when the last send is older than `expiryDays` days (or, never sent, it was handed off longer ago). */
  expired: boolean;
}

export interface ContactedValueResult {
  /** The client value every figure is priced on (the same LTR the pipeline uses). */
  lifetimeRevenueUsd: number | null;
  /** Mean expected value over the PRICED, non-expired contacted-only leads. */
  perLeadExpectedValueUsd: number | null;
  /** Σ over organisations of the MOST valuable contacted-only member — what these leads add to the pipeline. */
  totalExpectedValueUsd: number | null;
  unmeasuredReason: ContactedValueUnmeasuredReason | null;
  routes: ContactedEntryRoute[];
  /** One row per (campaign × workflow) group of contacted persons: the rate each lead is priced on. */
  workflows: ContactedWorkflowGroup[];
  /** A contacted lead whose last send is older than this many days is worth nothing. */
  expiryDays: number;
  /** Leads whose last send is strictly before this instant have expired. */
  lastSentOnOrAfter: string;
  population: {
    contactedOnly: number;
    organizations: number;
    /** Contacted leads that engaged (their value, if any, is the pipeline's). */
    engaged: number;
    /** Contacted leads that bounced or unsubscribed. */
    cannotConvert: number;
    /** Contacted-only leads with no email sent in the last `expiryDays` days — valued at 0. */
    expired: number;
    /** Contacted-only leads with no campaign or no workflow on their serve: no group, no value. */
    unattributed: number;
    /** Contacted-only leads whose group has no priced route: no value. */
    unpriced: number;
  };
  /** One row per contacted-only lead, ordered by lead id. */
  leads: ContactedLeadValue[];
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** PURE. The entry routes the priced paths carry, each with the leg whose ladder prices it. */
export function contactedEntryLegs(paths: readonly ResolvedPath[]): Array<{ signal: string; legKey: string }> {
  return paths
    .filter((p) => p.engagementRoute && ROUTE_LEG[p.signal] !== undefined)
    .map((p) => ({ signal: p.signal, legKey: ROUTE_LEG[p.signal] }));
}

/** PURE. Contacted persons per (campaign × workflow) group, in first-seen order. Unattributed persons are in none. */
export function contactedGroupsOf(
  persons: readonly EnginePerson[],
): Map<string, { campaignId: string; workflowSlug: string; contacted: number }> {
  const groups = new Map<string, { campaignId: string; workflowSlug: string; contacted: number }>();
  for (const p of persons) {
    if (!p.signals.contacted) continue;
    const key = contactedGroupKey(p.campaignId, p.workflowSlug);
    if (key === null) continue;
    const g = groups.get(key) ?? { campaignId: p.campaignId!, workflowSlug: p.workflowSlug!, contacted: 0 };
    g.contacted += 1;
    groups.set(key, g);
  }
  return groups;
}

/** PURE. The engine's `ContactedPricing.entryRatePctByGroup`, read off the served `workflows[]`. */
export function contactedEntryRatesByGroup(
  workflows: readonly ContactedWorkflowGroup[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const w of workflows) {
    const rates: Record<string, number> = {};
    for (const r of w.routes) if (r.entryRatePct !== null) rates[r.signal] = r.entryRatePct;
    if (Object.keys(rates).length > 0) out[contactedGroupKey(w.campaignId, w.workflowSlug)!] = rates;
  }
  return out;
}

/** PURE. One group's row: cost per contact over each route's price, capped at 100%. */
function priceGroup(
  g: { campaignId: string; workflowSlug: string; contacted: number },
  input: ContactedGroupInput | undefined,
  legs: ReadonlyArray<{ signal: string; legKey: string }>,
): ContactedWorkflowGroup {
  const spend = input?.committedSpentUsd ?? null;
  const costPerContactUsd = spend !== null && g.contacted > 0 ? spend / g.contacted : null;
  return {
    campaignId: g.campaignId,
    offerId: input?.offerId ?? null,
    featureSlug: input?.featureSlug ?? null,
    workflowSlug: g.workflowSlug,
    workflowDynastySlug: input?.workflowDynastySlug ?? null,
    contacted: g.contacted,
    committedSpentUsd: spend,
    costPerContactUsd,
    routes: legs.map(({ signal, legKey }) => {
      const price = input?.prices[signal] ?? null;
      const cost = price?.costPerOutcomeUsd ?? null;
      const unpricedReason =
        input === undefined
          ? "group_not_priced"
          : cost === null
            ? (price?.unpricedReason ?? "workflow_unpriced")
            : !(cost > 0)
              ? "non_positive_cost_per_outcome"
              : costPerContactUsd === null
                ? "no_spend_recorded"
                : null;
      const p = unpricedReason === null ? Math.min(1, costPerContactUsd! / cost!) : null;
      return {
        signal,
        legKey,
        costPerOutcomeUsd: cost,
        unpricedReason,
        entryRatePct: p === null ? null : p * 100,
        expectedOutcomes: p === null ? null : g.contacted * p,
      };
    }),
  };
}

/** PURE. The whole figure, from inputs the engine already uses. */
export function priceContactedLeads(input: {
  /** The engine's paths for this brand (already restricted to the priced funnels' legs). */
  paths: readonly ResolvedPath[];
  /** Deduped persons with every overlay applied (signals, dates, dead signals). */
  persons: readonly EnginePerson[];
  /** LTR, or null at cold start. */
  lifetimeRevenueUsd: number | null;
  /** The BRAND grain: each (campaign × workflow) group's spend and per-route ladder prices. */
  groups?: readonly ContactedGroupInput[];
  /**
   * The OFFER grain: the brand cell's `workflows[]` rows, borrowed as is (a group is one campaign, so the
   * offer's leads are priced on exactly the rates the pipeline prices them on). `null` = the brand cell
   * is unreadable or unmeasured: every lead reads unpriced.
   */
  entryRatesFrom?: readonly ContactedWorkflowGroup[] | null;
  now?: Date;
}): ContactedValueResult {
  const ltr = input.lifetimeRevenueUsd;
  const now = input.now ?? new Date();

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

  // ── Entry routes: the engine's engagement routes on the priced funnels.
  const legs = contactedEntryLegs(input.paths);
  const pathValue = new Map(input.paths.filter((p) => p.engagementRoute).map((p) => [p.signal, p.expectedRevenueUsd]));
  const routes: ContactedEntryRoute[] = legs.map(({ signal, legKey }) => ({
    signal,
    step: ROUTE_STEP[signal],
    legKey,
    paidClientGivenStepPct: ltr && ltr > 0 ? round((pathValue.get(signal)! / ltr) * 100) : 0,
    valueAtStepUsd: round(pathValue.get(signal)!),
  }));

  // ── Groups: measured here (brand) or borrowed (offer).
  const seen = contactedGroupsOf(input.persons);
  let workflows: ContactedWorkflowGroup[];
  if (input.entryRatesFrom !== undefined) {
    const byKey = new Map((input.entryRatesFrom ?? []).map((w) => [contactedGroupKey(w.campaignId, w.workflowSlug)!, w]));
    workflows = [...seen.keys()].map((k) => byKey.get(k)).filter((w): w is ContactedWorkflowGroup => w !== undefined);
  } else {
    const byKey = new Map((input.groups ?? []).map((g) => [contactedGroupKey(g.campaignId, g.workflowSlug)!, g]));
    workflows = [...seen.entries()].map(([k, g]) => priceGroup(g, byKey.get(k), legs));
  }

  const pricing: ContactedPricing = {
    entryRatePctByGroup: contactedEntryRatesByGroup(workflows),
    lastSentOnOrAfter: contactedExpiryCutoffIso(now),
  };
  const routeSignals = new Set(legs.map((l) => l.signal));
  const pricedGroup = (p: EnginePerson): "unattributed" | "unpriced" | "priced" => {
    const key = contactedGroupKey(p.campaignId, p.workflowSlug);
    if (key === null) return "unattributed";
    const rates = pricing.entryRatePctByGroup[key];
    return rates && Object.keys(rates).some((s) => routeSignals.has(s)) ? "priced" : "unpriced";
  };

  const unmeasuredReason: ContactedValueUnmeasuredReason | null =
    ltr === null
      ? "no_economics"
      : !(ltr > 0)
        ? "no_client_value"
        : routes.length === 0
          ? "no_entry_path"
          : !workflows.some((w) => w.routes.some((r) => routeSignals.has(r.signal) && r.entryRatePct !== null))
            ? "no_entry_rate"
            : null;

  const isExpired = (p: EnginePerson): boolean => contactedExpired(p, pricing.lastSentOnOrAfter);
  // ONE pricing, the engine's: the byte-same function the pipeline prices these leads with.
  const valueOf = (p: EnginePerson): number | null => {
    if (unmeasuredReason !== null) return null;
    if (isExpired(p)) return 0;
    if (pricedGroup(p) !== "priced") return null;
    return contactedLeadValue(p, input.paths, ltr!, pricing);
  };

  const values = contactedOnly.map((p) => ({ p, v: valueOf(p) }));
  const leads: ContactedLeadValue[] = values.map(({ p, v }) => ({
    leadId: p.leadId,
    expectedValueUsd: v === null ? null : round(v),
    expired: isExpired(p),
  }));

  // Company-level total, the pipeline's own rule: an organisation is worth its most valuable member.
  const byOrg = new Map<string, number>();
  for (const { p, v } of values) {
    if (v === null) continue;
    const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
    byOrg.set(key, Math.max(byOrg.get(key) ?? 0, v));
  }
  const totalExpectedValueUsd = unmeasuredReason !== null ? null : [...byOrg.values()].reduce((s, v) => s + v, 0);

  const live = values.filter(({ p, v }) => v !== null && !isExpired(p)).map(({ v }) => v!);
  const perLeadExpectedValueUsd =
    unmeasuredReason !== null || live.length === 0 ? null : live.reduce((s, v) => s + v, 0) / live.length;

  return {
    lifetimeRevenueUsd: ltr,
    perLeadExpectedValueUsd,
    totalExpectedValueUsd,
    unmeasuredReason,
    routes,
    workflows,
    expiryDays: CONTACTED_VALUE_EXPIRY_DAYS,
    lastSentOnOrAfter: pricing.lastSentOnOrAfter,
    population: {
      contactedOnly: contactedOnly.length,
      organizations: new Set(contactedOnly.map((p) => (p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`))).size,
      engaged,
      cannotConvert,
      expired: contactedOnly.filter(isExpired).length,
      unattributed: contactedOnly.filter((p) => pricedGroup(p) === "unattributed").length,
      unpriced: contactedOnly.filter((p) => pricedGroup(p) === "unpriced").length,
    },
    leads,
  };
}
