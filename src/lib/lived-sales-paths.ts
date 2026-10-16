/**
 * LIVED SALES PATHS (owner 2026-10-12, "which way a paid client really came"): the sales path each person
 * ACTUALLY went through, per offer, with what it cost and returned, ranked overall and per sales funnel.
 * The EXPECTED ranking (`/offers/:id/sales-paths`, the catalogue's path economics) projects a return from
 * per-leg rates; this one is measured on the people, since inception, never a window. Pure: IO lives in
 * `lived-sales-paths-io.ts`.
 *
 * Rules:
 *   - GRAIN = person x offer (lead-service's timeline grain). A person on two offers lives two journeys and
 *     counts once on each, on its own path. A fact with no offer joins the person's only offer; a person on
 *     several offers leaves it unplaced (counted, never guessed).
 *   - STEPS = the timeline facts whose label IS a catalogue step key (coded or declared, so a new step such
 *     as `industry_update_video` is placed with no code change), plus the two timeline words that name a
 *     step differently (`interested` = Positive reply, `form_filled` = Form submitted). Ordered by date
 *     (undated last, in catalogue order), each step once. A person a campaign ACTED on before any step
 *     (our email) entered at Lead found; a person whose first fact is a step entered there (an engagement
 *     with the video).
 *   - PATH = Start -> the person's steps -> Paid client, in the catalogue's path id spelling (served leg
 *     keys `+`-joined), so a lived path and a catalogue path with the same id ARE the same way. Everyone who
 *     lived the same steps is on the same path, paid or not: its paid clients are the ones who paid, its
 *     cost is everyone's. (Ranking only the payers' own cost would make every path look free.)
 *   - PAID CLIENT = a `paid_client` fact that is OURS (`attributable === true`, the same "priced to our
 *     outreach" predicate the brand's measured return uses). Worth its stated amount, else the offer's
 *     lifetime revenue; neither = the path's revenue is unknown (null + reason), never $0.
 *   - COST: every campaign's committed spend is split EQUALLY across the people x offers it acted on
 *     (entry spend shared across the people it reached; a later pipe's spend across the people it worked).
 *     A campaign that acted on nobody (a sourcing unit) spreads over the people of its sales funnel
 *     campaign; spend with no campaign, or whose funnel reached nobody, is `unattributedCostUsd` with its
 *     reason, so Σ paths + unattributed = the brand's spend exactly.
 *   - STATUS: a path with a paid client and spend is `measured` (roi = revenue / cost); with no paid client
 *     it is `learning`, roi null, never a fake 0 or infinity.
 */

export const PAID_CLIENT = "paid_client";
export const LEAD_FOUND = "lead_found";

/** Timeline words that name a catalogue step under another spelling. Every other label is placed only when it IS a step key. */
export const TIMELINE_LABEL_STEP_ALIASES: Readonly<Record<string, string>> = {
  interested: "conversation",
  form_filled: "form_submitted",
};

export interface JourneyFact {
  label: string;
  /** lead-service's fact source (`reply`, `outreach`, `crm`, ...); absent when the producer states none. */
  source?: string;
  occurredAt: string | null;
  campaignId: string | null;
  /** Ours (true), not ours (false), nobody could tell (null). */
  attributable: boolean | null;
  /** Stated amount on a sale, cents; null when none. */
  valueCents: number | null;
}

export interface JourneyAct {
  /** Null when the act names no campaign: it still says somebody of ours acted, it carries no spend. */
  campaignId: string | null;
  firstActedAt: string | null;
  /** lead-service's act kind (`email` = our sends, `followup` = a follow-up pipe acted); absent = unstated. */
  kind?: string;
}

/** One person x offer as the timeline holds it (offer null = facts with no offer). */
export interface Journey {
  leadId: string;
  offerId: string | null;
  facts: JourneyFact[];
  acts: JourneyAct[];
}

export interface FunnelCampaignRef {
  funnelCampaignId: string;
  salesFunnelId: string;
  salesFunnelName: string | null;
}

export interface LivedPathInputs {
  journeys: Journey[];
  /** Committed spend per campaign id, USD (exact). Key `null` = spend recorded with no campaign. */
  costByCampaign: Map<string | null, number>;
  /** Unit campaign id -> its sales funnel campaign. */
  funnelOfCampaign: Map<string, FunnelCampaignRef>;
  /** Every catalogue step key, in catalogue order (coded then declared). */
  stepKeys: readonly string[];
  /** Read one offer only (its people, after the offer-less facts were placed); null/absent = every offer. */
  onlyOfferId?: string | null;
  /** Offer id -> lifetime revenue per paying client (null = none). */
  lifetimeRevenueOf: (offerId: string | null) => number | null;
}

export type LivedPathStatus = "measured" | "learning";

export interface LivedPathRow {
  pathId: string;
  steps: string[];
  leads: number;
  paidClients: number;
  /** Paid clients on this path that were NOT ours (customer's own channel, or nobody could tell): counted, never priced. */
  notOurPaidClients: number;
  revenueUsd: number | null;
  costUsd: number;
  roi: number | null;
  status: LivedPathStatus;
  /** Why `roi` is null on a measured path / why revenue is unknown. */
  unavailableReason: "no_spend" | "paid_client_unpriced" | null;
  rank: number;
}

export interface LivedTotals {
  leads: number;
  /** Distinct PEOPLE on the paths (a person on two offers is one person here, two `leads`). */
  people: number;
  /** Distinct people one of our emails was SENT to (an `email` act): the brand's `outcomes.sending.recipientsSent`. */
  peopleEmailed: number;
  paidClients: number;
  notOurPaidClients: number;
  revenueUsd: number | null;
  /** Spend placed on people (Σ paths). */
  costUsd: number;
  /** Spend no person carries, by reason. */
  unattributedCostUsd: number;
  unattributedCost: Array<{ reason: "no_campaign" | "acted_on_nobody"; campaignId: string | null; costUsd: number }>;
  /** = costUsd + unattributedCostUsd = the scope's whole committed spend. */
  totalCostUsd: number;
  roi: number | null;
  /** Facts with no offer on a person of several offers: not placed on any journey. */
  unplacedFacts: number;
  /** People x offers with no fact of ours and no act of ours (the customer's own CRM): not a lived path of ours. */
  excludedJourneys: number;
}

export interface LivedFunnelGroup {
  funnelCampaignId: string | null;
  salesFunnelId: string | null;
  salesFunnelName: string | null;
  totals: Omit<LivedTotals, "unattributedCost" | "unattributedCostUsd" | "totalCostUsd" | "unplacedFacts" | "excludedJourneys" | "people" | "peopleEmailed">;
  paths: LivedPathRow[];
}

export interface LivedPathsResult {
  totals: LivedTotals;
  paths: LivedPathRow[];
  funnels: LivedFunnelGroup[];
}

const time = (iso: string | null): number => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

/** PURE: the catalogue path id of a lived route (Start -> steps -> Paid client). */
export function livedPathIdOf(steps: readonly string[]): string {
  const chain = [null, ...steps, PAID_CLIENT];
  const legs: string[] = [];
  for (let i = 1; i < chain.length; i++) legs.push(`${chain[i - 1] ?? "start"}_to_${chain[i]}`);
  return legs.join("+");
}

/** PURE: the step a timeline label places the person on, or null when it is no step. */
export function stepOfLabel(label: string, stepKeys: ReadonlySet<string>): string | null {
  const step = TIMELINE_LABEL_STEP_ALIASES[label] ?? label;
  return stepKeys.has(step) ? step : null;
}

/**
 * PURE: fold the facts with no offer into the person's only offer. A person on several offers keeps them
 * unplaced (returned count); a person with no offer at all keeps one offer-less journey.
 */
export function placeOfferlessFacts(journeys: readonly Journey[]): { journeys: Journey[]; unplacedFacts: number } {
  const byLead = new Map<string, Journey[]>();
  for (const j of journeys) byLead.set(j.leadId, [...(byLead.get(j.leadId) ?? []), j]);
  const out: Journey[] = [];
  let unplacedFacts = 0;
  for (const list of byLead.values()) {
    const offerless = list.filter((j) => j.offerId === null);
    const offered = list.filter((j) => j.offerId !== null);
    if (offerless.length === 0) {
      out.push(...offered);
    } else if (offered.length === 0) {
      out.push(...offerless);
    } else if (offered.length === 1) {
      const only = offered[0];
      out.push({
        ...only,
        facts: [...only.facts, ...offerless.flatMap((j) => j.facts)],
        acts: [...only.acts, ...offerless.flatMap((j) => j.acts)],
      });
    } else {
      out.push(...offered);
      unplacedFacts += offerless.reduce((n, j) => n + j.facts.length, 0);
    }
  }
  return { journeys: out, unplacedFacts };
}

/** PURE: the ordered steps one journey lived (Paid client excluded: it ends every path). */
export function livedStepsOf(j: Journey, stepKeys: readonly string[]): string[] {
  const keys = new Set(stepKeys);
  const order = new Map(stepKeys.map((k, i) => [k, i]));
  const placed = j.facts
    .map((f) => ({ step: stepOfLabel(f.label, keys), at: time(f.occurredAt) }))
    .filter((p): p is { step: string; at: number } => p.step !== null && p.step !== PAID_CLIENT)
    .sort((a, b) => a.at - b.at || (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0));
  const steps: string[] = [];
  for (const p of placed) if (!steps.includes(p.step)) steps.push(p.step);
  const firstStepAt = placed.length > 0 ? placed[0].at : Number.POSITIVE_INFINITY;
  const firstActAt = Math.min(...j.acts.map((a) => time(a.firstActedAt)), Number.POSITIVE_INFINITY);
  const actedFirst = j.acts.length > 0 && (placed.length === 0 || firstActAt < firstStepAt || (firstActAt === firstStepAt && !Number.isFinite(firstStepAt)));
  if (actedFirst && steps[0] !== LEAD_FOUND) return [LEAD_FOUND, ...steps.filter((s) => s !== LEAD_FOUND)];
  return steps;
}

/** A journey is ours when one of our campaigns acted on the person or one of its facts is ours. */
const isOurs = (j: Journey): boolean => j.acts.length > 0 || j.facts.some((f) => f.attributable === true || f.campaignId !== null);

const journeyKey = (j: Journey): string => `${j.leadId}|${j.offerId ?? ""}`;

interface Placed {
  key: string;
  journey: Journey;
  steps: string[];
  pathId: string;
  paid: number;
  notOurPaid: number;
  revenueUsd: number | null;
  costUsd: number;
  funnel: FunnelCampaignRef | null;
}

/** The campaigns a journey was acted on by: its acts, and the campaign of every fact. */
const campaignsOf = (j: Journey): Set<string> => {
  const set = new Set<string>(j.acts.flatMap((a) => (a.campaignId ? [a.campaignId] : [])));
  for (const f of j.facts) if (f.campaignId) set.add(f.campaignId);
  return set;
};

/** The entry campaign: the first one that acted (dated first, then id). */
function entryCampaignOf(j: Journey): string | null {
  const dated = [
    ...j.acts.flatMap((a) => (a.campaignId ? [{ c: a.campaignId, at: time(a.firstActedAt) }] : [])),
    ...j.facts.filter((f) => f.campaignId).map((f) => ({ c: f.campaignId as string, at: time(f.occurredAt) })),
  ].sort((a, b) => a.at - b.at || a.c.localeCompare(b.c));
  return dated[0]?.c ?? null;
}

function rankPaths(rows: Omit<LivedPathRow, "rank">[]): LivedPathRow[] {
  const tier = (r: Omit<LivedPathRow, "rank">) => (r.status === "measured" ? (r.roi !== null ? 0 : 1) : 2);
  return [...rows]
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        (b.roi ?? 0) - (a.roi ?? 0) ||
        b.paidClients - a.paidClients ||
        b.leads - a.leads ||
        a.pathId.localeCompare(b.pathId),
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

function aggregate(placed: readonly Placed[]): { totals: LivedFunnelGroup["totals"]; paths: LivedPathRow[] } {
  const byPath = new Map<string, Placed[]>();
  for (const p of placed) byPath.set(p.pathId, [...(byPath.get(p.pathId) ?? []), p]);
  const rows: Omit<LivedPathRow, "rank">[] = [];
  for (const [pathId, list] of byPath) {
    const paidClients = list.reduce((n, p) => n + p.paid, 0);
    const notOurPaidClients = list.reduce((n, p) => n + p.notOurPaid, 0);
    const revenueUsd = list.some((p) => p.revenueUsd === null) ? null : list.reduce((s, p) => s + (p.revenueUsd ?? 0), 0);
    const costUsd = list.reduce((s, p) => s + p.costUsd, 0);
    const measured = paidClients > 0;
    const roi = measured && revenueUsd !== null && costUsd > 0 ? revenueUsd / costUsd : null;
    rows.push({
      pathId,
      steps: list[0].steps,
      leads: list.length,
      paidClients,
      notOurPaidClients,
      revenueUsd,
      costUsd,
      roi,
      status: measured ? "measured" : "learning",
      unavailableReason: !measured ? null : revenueUsd === null ? "paid_client_unpriced" : costUsd > 0 ? null : "no_spend",
    });
  }
  const paidClients = placed.reduce((n, p) => n + p.paid, 0);
  const revenueUsd = placed.some((p) => p.revenueUsd === null) ? null : placed.reduce((s, p) => s + (p.revenueUsd ?? 0), 0);
  const costUsd = placed.reduce((s, p) => s + p.costUsd, 0);
  return {
    totals: {
      leads: placed.length,
      paidClients,
      notOurPaidClients: placed.reduce((n, p) => n + p.notOurPaid, 0),
      revenueUsd,
      costUsd,
      roi: paidClients > 0 && revenueUsd !== null && costUsd > 0 ? revenueUsd / costUsd : null,
    },
    paths: rankPaths(rows),
  };
}

/** PURE: the lived paths of one scope. */
export function computeLivedPaths(inputs: LivedPathInputs): LivedPathsResult {
  const { journeys: placedJourneys, unplacedFacts } = placeOfferlessFacts(inputs.journeys);
  const inScope = inputs.onlyOfferId ? placedJourneys.filter((j) => j.offerId === inputs.onlyOfferId) : placedJourneys;
  const ours = inScope.filter(isOurs);
  const excludedJourneys = inScope.length - ours.length;

  const placed: Placed[] = ours.map((j) => {
    const steps = livedStepsOf(j, inputs.stepKeys);
    const paidFacts = j.facts.filter((f) => f.label === PAID_CLIENT);
    const ourPaid = paidFacts.find((f) => f.attributable === true) ?? null;
    let revenueUsd: number | null = 0;
    if (ourPaid) {
      revenueUsd = ourPaid.valueCents !== null ? ourPaid.valueCents / 100 : inputs.lifetimeRevenueOf(j.offerId);
    }
    const entry = entryCampaignOf(j);
    return {
      key: journeyKey(j),
      journey: j,
      steps,
      pathId: livedPathIdOf(steps),
      paid: ourPaid ? 1 : 0,
      notOurPaid: !ourPaid && paidFacts.length > 0 ? 1 : 0,
      revenueUsd,
      costUsd: 0,
      funnel: entry ? (inputs.funnelOfCampaign.get(entry) ?? null) : null,
    };
  });

  // Who each campaign acted on, and who each funnel campaign holds.
  const actedOn = new Map<string, Placed[]>();
  const inFunnel = new Map<string, Set<Placed>>();
  for (const p of placed) {
    for (const c of campaignsOf(p.journey)) {
      actedOn.set(c, [...(actedOn.get(c) ?? []), p]);
      const f = inputs.funnelOfCampaign.get(c);
      if (f) inFunnel.set(f.funnelCampaignId, new Set([...(inFunnel.get(f.funnelCampaignId) ?? []), p]));
    }
  }

  const unattributed: LivedTotals["unattributedCost"] = [];
  let totalCostUsd = 0;
  for (const [campaignId, costUsd] of inputs.costByCampaign) {
    totalCostUsd += costUsd;
    if (costUsd === 0) continue;
    if (campaignId === null) {
      unattributed.push({ reason: "no_campaign", campaignId: null, costUsd });
      continue;
    }
    const own = actedOn.get(campaignId);
    const funnel = inputs.funnelOfCampaign.get(campaignId);
    const share = own && own.length > 0 ? own : funnel ? [...(inFunnel.get(funnel.funnelCampaignId) ?? [])] : [];
    if (share.length === 0) {
      unattributed.push({ reason: "acted_on_nobody", campaignId, costUsd });
      continue;
    }
    for (const p of share) p.costUsd += costUsd / share.length;
  }
  unattributed.sort((a, b) => b.costUsd - a.costUsd || (a.campaignId ?? "").localeCompare(b.campaignId ?? ""));
  const unattributedCostUsd = unattributed.reduce((s, u) => s + u.costUsd, 0);

  const whole = aggregate(placed);
  const byFunnel = new Map<string, Placed[]>();
  for (const p of placed) {
    const k = p.funnel?.funnelCampaignId ?? "";
    byFunnel.set(k, [...(byFunnel.get(k) ?? []), p]);
  }
  const funnels: LivedFunnelGroup[] = [...byFunnel.entries()]
    .map(([, list]) => {
      const f = list[0].funnel;
      const { totals, paths } = aggregate(list);
      return { funnelCampaignId: f?.funnelCampaignId ?? null, salesFunnelId: f?.salesFunnelId ?? null, salesFunnelName: f?.salesFunnelName ?? null, totals, paths };
    })
    .sort((a, b) => (a.funnelCampaignId === null ? 1 : 0) - (b.funnelCampaignId === null ? 1 : 0) || (b.totals.roi ?? -1) - (a.totals.roi ?? -1) || b.totals.leads - a.totals.leads);

  const people = new Set(placed.map((p) => p.journey.leadId)).size;
  const peopleEmailed = new Set(placed.filter((p) => p.journey.acts.some((a) => a.kind === "email")).map((p) => p.journey.leadId)).size;
  return {
    totals: { ...whole.totals, people, peopleEmailed, unattributedCostUsd, unattributedCost: unattributed, totalCostUsd, unplacedFacts, excludedJourneys },
    paths: whole.paths,
    funnels,
  };
}
