/**
 * A CUSTOMER-TEAM PIPE MEASURED ON THE PEOPLE WE BROUGHT IT (owner 2026-10-12: "check quand ils ont eu une positive
 * reply qu'on leur a apportée, mais qu'on n'a pas eu ce pipe AI Meeting Booking qui a tourné dessus, et voir dans leur
 * CRM combien de meetings booked sur ces positive replies ont été enregistrés").
 *
 * The customer-team pipe's own population (`lib/pipe-stats.ts`, crm-service leg reach) is the people our campaigns
 * NEVER contacted. This is its sibling population on the same pipe: the people OUR campaigns brought to the pipe's
 * `from` step that none of OUR pipes on the same leg acted on (left to the customer's team), and how many of them
 * reached its `to` step, on or after the day they reached `from` (same day counts; an undated end counts). Beside it,
 * our own pipes' rate on the people they DID act on, under the same rule, so the page compares like with like.
 *
 * ONE rule for every leg whose `from` step our campaigns produce, never a per-channel branch:
 *   - "our campaigns that produce `from`" = the campaigns of every PLATFORM pipe whose `to` step is this pipe's `from`
 *     (e.g. every cold-email pipe for `conversation`), narrowed to the scope (brand, offer of that brand);
 *   - who reached `from`: a step our sending observes (`conversation` = positive reply, `website_visit` = click) is
 *     read off the lead snapshot of those campaigns (lead-service compact rows, dated by email-gateway's first event,
 *     the CRM-evidenced reply date when earlier); a step a human or the brand's tools state (meeting booked, signup,
 *     sale...) is lead-service's attributed outcome of that step. Any other step: `from_step_not_produced_by_our_campaigns`;
 *   - "acted on by our pipes" = lead-service's follow-up ledger (`actedCount > 0`) of every PLATFORM pipe's campaigns
 *     on the same leg for the brand (any offer: a person our AI answered is never "left to their team");
 *   - who reached `to`: lead-service's attributed outcome of that step (the brand's CRM facts and staff statements,
 *     the SAME read our AI pipe's own outcomes count), matched on the lead. A `to` step with no attributed outcome:
 *     `to_step_not_recorded_for_our_leads`.
 * Unmeasurable = both volumes null + a reason, never 0. A brand held by two orgs: its people are deduped by lead.
 */
import { fetchFleetLegCampaignsFor, type FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { fetchScopePersons } from "./crm-only-repliers.js";
import { fetchEventTimestamps } from "./email-status-client.js";
import { fetchFollowupActionRows } from "./followup-actions-client.js";
import { fetchStepOutcomes, type StepOutcomeRow } from "./step-outcomes-client.js";
import { OUTCOME_EVENT_OF_STEP } from "./funnel-campaign-activity.js";
import { outsideInteractiveView } from "./lead-copy.js";
import { mapWithConcurrency } from "./concurrency.js";
import { buildPipeStats, type PipeStatsConversionRate, type PipeStatsVolume } from "./pipe-stats.js";

/** A step our own sending observes, and the lead-snapshot signal + email-gateway date that state it. */
const SNAPSHOT_SIGNAL_OF_STEP: Readonly<Record<string, "positiveReply" | "clicked">> = { conversation: "positiveReply", website_visit: "clicked" };

/** A pipe of the catalogue, as this read needs it. */
export interface LegPipeRef {
  channelSlug: string;
  computedLegKey: string;
}

export interface OurLeadsToTeamPipe {
  fromStep: string | null;
  toStep: string;
  fromStepLabel: string | null;
  toStepLabel: string;
  /** PLATFORM pipes whose `to` step is this pipe's `from` step: their campaigns bring people to `from`. */
  producingPipes: readonly LegPipeRef[];
  /** PLATFORM pipes on the SAME leg: a person one of them acted on is not left to the customer's team. */
  ourPipesOnLeg: readonly LegPipeRef[];
  /** ONE platform pipe on the leg whose own people are also counted (`focus*` figures): the platform pipe's page
   *  reads "team alone vs team + this pipe" (`lib/pipe-team-impact.ts`). Absent = none. */
  focusPipes?: readonly LegPipeRef[];
}

export type OurLeadsToTeamReason =
  | "leg_has_no_from_step"
  | "from_step_not_produced_by_our_campaigns"
  | "to_step_not_recorded_for_our_leads"
  | "no_campaign_of_ours_brings_people_to_from";

/** One person our campaigns brought to `from`: when (null = undated). */
export interface BroughtPerson {
  leadId: string;
  fromAt: string | null;
}

export interface OurPipesRate {
  /** People our pipes on the leg acted on (of those our campaigns brought to `from`, plus any they acted on beyond). */
  actedOn: number | null;
  /** Of them, reached `to` on or after the day they reached `from` (the same rule as the team side). */
  outcomes: number | null;
  ratePct: number | null;
  unavailableReason: "no_input_yet" | "volume_not_measured" | null;
}

export interface OurLeadsToTeam {
  population: "people_our_campaigns_brought_to_from_not_acted_on_by_our_pipes";
  available: boolean;
  unavailableReason: OurLeadsToTeamReason | null;
  /** How `from` was read: our sending's own evidence, or lead-service's attributed outcomes. */
  fromEvidence: "lead_snapshot" | "attributed_outcomes" | null;
  /** How `to` was read (lead-service's attributed outcomes: the brand's CRM facts and staff statements). */
  toEvidence: "attributed_outcomes" | null;
  /** The outcome sources evidencing `to` for the people counted (`tracker` = the brand's tools, `manual` = a statement). */
  toSources: string[];
  /** Channel slugs of the pipes whose campaigns bring people to `from`. */
  producingChannels: string[];
  /** Channel slugs of our pipes on the same leg (their action excludes a person). */
  ourChannelsOnLeg: string[];
  brandsCounted: number;
  /** Every person our campaigns brought to `from` in the scope (left to their team + acted on by our pipes). */
  broughtToFrom: number | null;
  /** Of `broughtToFrom`, those our pipes on the leg acted on (not in this population). */
  actedOnByOurPipes: number | null;
  firstActivityDay: string | null;
  /** `leftToTeam` (input) then `outcomes`. */
  volumes: PipeStatsVolume[];
  conversionRates: PipeStatsConversionRate[];
  history: Array<{ date: string; volumes: Record<string, number | null>; conversionRates: Record<string, number | null> }>;
  /** Our pipes on the same leg, on the people they acted on: the rate to read beside this one. */
  ourPipesRate: OurPipesRate;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const dayOf = (iso: string | null): string | null => (iso && DAY_RE.test(iso) ? iso.slice(0, 10) : null);
const minIso = (a: string | null, b: string | null): string | null => (a && b ? (a < b ? a : b) : (a ?? b));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** PURE: the day a person reached `to` on or after the day they reached `from`; null = undated; undefined = never. */
export function reachedToAt(fromAt: string | null, toAts: ReadonlyArray<string | null> | undefined): string | null | undefined {
  if (!toAts || toAts.length === 0) return undefined;
  const fromDay = dayOf(fromAt);
  let best: string | null | undefined;
  for (const at of toAts) {
    const d = dayOf(at);
    if (d === null) {
      if (best === undefined) best = null;
      continue;
    }
    if (fromDay !== null && d < fromDay) continue;
    if (best === undefined || best === null || d < best) best = d;
  }
  return best;
}

/** Dated counts of one volume: per UTC day, plus the count in no day. */
export interface DatedCount {
  daily: Map<string, number>;
  undated: number;
}

export interface BrandFigures {
  left: DatedCount;
  reached: DatedCount;
  broughtToFrom: number;
  actedOnByOurPipes: number;
  ourPipesRate: OurPipesRate;
  /** The people the FOCUS pipe's campaigns in scope acted on (dated by the day they reached `from`), and those of them
   *  who reached `to` under the same rule. Empty without a focus pipe. */
  focusActed: DatedCount;
  focusReached: DatedCount;
}

/** PURE: one brand's left-to-their-team volumes and our pipes' rate, from per-person facts. */
export function ourLeadsToTeamFigures(input: {
  brought: ReadonlyArray<BroughtPerson>;
  /** Lead -> when ANY of our pipes on the leg first acted on them, for the brand (null = undated): excluded. */
  acted: ReadonlyMap<string, string | null>;
  /** Of `acted`, the leads acted on by our pipes' campaigns IN SCOPE: our pipes' rate. */
  actedInScope: ReadonlySet<string>;
  /** Lead -> every date it reached `to` (null = undated). */
  toAtByLead: ReadonlyMap<string, ReadonlyArray<string | null>>;
  /** Of `acted`, the leads the FOCUS pipe's campaigns in scope acted on. */
  focusActedInScope?: ReadonlySet<string>;
}): BrandFigures {
  const left: DatedCount = { daily: new Map(), undated: 0 };
  const reached: DatedCount = { daily: new Map(), undated: 0 };
  const add = (v: DatedCount, day: string | null) => {
    if (day === null) v.undated++;
    else v.daily.set(day, (v.daily.get(day) ?? 0) + 1);
  };
  // One person once (two orgs, two rows): the earliest dated `from` wins.
  const fromAtOf = new Map<string, string | null>();
  for (const b of input.brought) fromAtOf.set(b.leadId, fromAtOf.has(b.leadId) ? minIso(fromAtOf.get(b.leadId)!, b.fromAt) : b.fromAt);
  let actedOfBrought = 0;
  for (const [leadId, fromAt] of fromAtOf) {
    if (input.acted.has(leadId)) {
      actedOfBrought++;
      continue;
    }
    add(left, dayOf(fromAt));
    const to = reachedToAt(fromAt, input.toAtByLead.get(leadId));
    if (to !== undefined) add(reached, to);
  }
  // A person our pipes acted on but no producing campaign in scope brought: dated by the first action on them.
  const fromAtOfActed = (leadId: string) => (fromAtOf.has(leadId) ? fromAtOf.get(leadId)! : (input.acted.get(leadId) ?? null));
  let ourOutcomes = 0;
  for (const leadId of input.actedInScope) if (reachedToAt(fromAtOfActed(leadId), input.toAtByLead.get(leadId)) !== undefined) ourOutcomes++;
  const focusActed: DatedCount = { daily: new Map(), undated: 0 };
  const focusReached: DatedCount = { daily: new Map(), undated: 0 };
  for (const leadId of input.focusActedInScope ?? []) {
    const fromAt = fromAtOfActed(leadId);
    add(focusActed, dayOf(fromAt));
    const to = reachedToAt(fromAt, input.toAtByLead.get(leadId));
    if (to !== undefined) add(focusReached, to);
  }
  const actedOn = input.actedInScope.size;
  return {
    left,
    reached,
    broughtToFrom: fromAtOf.size,
    actedOnByOurPipes: actedOfBrought,
    ourPipesRate: { actedOn, outcomes: ourOutcomes, ratePct: actedOn > 0 ? round2((ourOutcomes / actedOn) * 100) : null, unavailableReason: actedOn > 0 ? null : "no_input_yet" },
    focusActed,
    focusReached,
  };
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** PURE: the served block, from the per-brand figures (summed) or a reason. */
export function buildOurLeadsToTeam(
  p: Pick<OurLeadsToTeamPipe, "fromStepLabel" | "toStepLabel">,
  meta: { fromEvidence: OurLeadsToTeam["fromEvidence"]; producingChannels: string[]; ourChannelsOnLeg: string[]; toSources: string[] },
  perBrand: ReadonlyArray<BrandFigures> | null,
  reason: OurLeadsToTeamReason | null,
  today: string,
): OurLeadsToTeam {
  const measured = perBrand !== null && reason === null;
  const sum = (pick: (f: BrandFigures) => DatedCount) => {
    const daily = new Map<string, number>();
    let undated = 0;
    for (const f of perBrand ?? []) {
      const v = pick(f);
      for (const [d, n] of v.daily) daily.set(d, (daily.get(d) ?? 0) + n);
      undated += v.undated;
    }
    return { daily, undated };
  };
  const total = (pick: (f: BrandFigures) => number) => (perBrand ?? []).reduce((a, f) => a + pick(f), 0);
  const from = measured ? sum((f) => f.left) : { daily: null, undated: 0 };
  const to = measured ? sum((f) => f.reached) : { daily: null, undated: 0 };
  const figures = buildPipeStats({
    volumes: [
      { key: "leftToTeam", label: `${p.fromStepLabel ?? "People"} we brought, left to their team`, role: "input", datedBy: measured ? "event_day" : null, ...from },
      { key: "outcomes", label: `${p.toStepLabel} (their team, on our leads)`, role: "outcome", datedBy: measured ? "event_day" : null, ...to },
    ],
    outcomeKey: "outcomes",
    spendByDay: new Map(),
    valuePerOutcomeUsd: null,
    today,
  });
  const actedOn = measured ? total((f) => f.ourPipesRate.actedOn ?? 0) : null;
  const ourOutcomes = measured ? total((f) => f.ourPipesRate.outcomes ?? 0) : null;
  return {
    population: "people_our_campaigns_brought_to_from_not_acted_on_by_our_pipes",
    available: measured,
    unavailableReason: measured ? null : reason,
    fromEvidence: meta.fromEvidence,
    toEvidence: meta.fromEvidence === null ? null : "attributed_outcomes",
    toSources: meta.toSources,
    producingChannels: meta.producingChannels,
    ourChannelsOnLeg: meta.ourChannelsOnLeg,
    brandsCounted: measured ? perBrand!.length : 0,
    broughtToFrom: measured ? total((f) => f.broughtToFrom) : null,
    actedOnByOurPipes: measured ? total((f) => f.actedOnByOurPipes) : null,
    firstActivityDay: figures.firstActivityDay,
    volumes: figures.volumes,
    conversionRates: figures.conversionRates,
    history: figures.history.map((h) => ({ date: h.date, volumes: h.volumes, conversionRates: h.conversionRates })),
    ourPipesRate:
      actedOn === null || ourOutcomes === null
        ? { actedOn: null, outcomes: null, ratePct: null, unavailableReason: "volume_not_measured" }
        : { actedOn, outcomes: ourOutcomes, ratePct: actedOn > 0 ? round2((ourOutcomes / actedOn) * 100) : null, unavailableReason: actedOn > 0 ? null : "no_input_yet" },
  };
}

/** Lead -> every date of `rows` (null = undated). */
function datesByLead(rows: readonly StepOutcomeRow[]): Map<string, Array<string | null>> {
  const out = new Map<string, Array<string | null>>();
  for (const r of rows) out.set(r.leadId, [...(out.get(r.leadId) ?? []), r.occurredAt]);
  return out;
}

/** The people our campaigns `ids` (one org's, one brand's) brought to a snapshot step, dated. */
async function snapshotBrought(orgId: string, brandId: string, ids: readonly string[], signal: "positiveReply" | "clicked"): Promise<BroughtPerson[]> {
  const persons = (await fetchScopePersons(brandId, [...ids], { orgId })).filter((p) => p.signals[signal]);
  const emails = sortedUnique(persons.map((p) => p.email?.trim().toLowerCase() ?? "").filter((e) => e !== ""));
  const dates = await fetchEventTimestamps(brandId, undefined, emails, { orgId });
  return persons.map((p) => {
    const email = p.email?.trim().toLowerCase() ?? "";
    const evidenced = dates.get(email)?.[signal] ?? null;
    const own = signal === "positiveReply" ? (p.signalDates?.positiveReply ?? p.crmPositiveReplyAt ?? null) : null;
    return { leadId: p.leadId, fromAt: minIso(evidenced, own) };
  });
}

/** What the leg's two populations rest on: per-brand figures, or the reason they cannot be measured. */
export interface LegPopulations {
  meta: { fromEvidence: OurLeadsToTeam["fromEvidence"]; producingChannels: string[]; ourChannelsOnLeg: string[]; toSources: string[] };
  perBrand: BrandFigures[] | null;
  reason: OurLeadsToTeamReason | null;
}

/** IO: the block for one customer-team pipe and one scope (see the header). Fail-loud on any producer failure. */
export async function fetchOurLeadsToTeam(
  p: OurLeadsToTeamPipe,
  scope: { brandId: string | null; offerId: string | null },
  today: string = new Date().toISOString().slice(0, 10),
): Promise<OurLeadsToTeam> {
  const { meta, perBrand, reason } = await fetchLegPopulations(p, scope);
  return buildOurLeadsToTeam(p, meta, perBrand, reason, today);
}

/** IO: per brand in scope, the people our campaigns brought to `from`, who our pipes (and the focus pipe) acted on,
 *  and who reached `to` (see the header). Fail-loud on any producer failure. */
export async function fetchLegPopulations(
  p: OurLeadsToTeamPipe,
  scope: { brandId: string | null; offerId: string | null },
): Promise<LegPopulations> {
  const producingChannels = sortedUnique(p.producingPipes.map((q) => q.channelSlug));
  const ourChannelsOnLeg = sortedUnique(p.ourPipesOnLeg.map((q) => q.channelSlug));
  const signal = p.fromStep ? SNAPSHOT_SIGNAL_OF_STEP[p.fromStep] : undefined;
  const fromEvent = p.fromStep ? OUTCOME_EVENT_OF_STEP[p.fromStep] : undefined;
  const toEvent = OUTCOME_EVENT_OF_STEP[p.toStep];
  const fromEvidence: OurLeadsToTeam["fromEvidence"] = signal ? "lead_snapshot" : fromEvent ? "attributed_outcomes" : null;
  const meta = { fromEvidence, producingChannels, ourChannelsOnLeg, toSources: [] as string[] };
  const refuse = (reason: OurLeadsToTeamReason): LegPopulations => ({ meta, perBrand: null, reason });
  if (p.fromStep === null) return refuse("leg_has_no_from_step");
  if (!signal && !fromEvent) return refuse("from_step_not_produced_by_our_campaigns");
  if (!toEvent) return refuse("to_step_not_recorded_for_our_leads");

  const [producing, onLeg, focus] = await fetchFleetLegCampaignsFor([p.producingPipes, p.ourPipesOnLeg, p.focusPipes ?? []]);
  const inScope = (c: FleetLegCampaign) => c.brandId !== null && (scope.brandId === null || c.brandId === scope.brandId) && (scope.offerId === null || c.offerId === scope.offerId);
  // brand -> org -> producing campaign ids in scope.
  const brands = new Map<string, Map<string, string[]>>();
  for (const c of producing.filter(inScope)) {
    const orgs = brands.get(c.brandId!) ?? new Map<string, string[]>();
    orgs.set(c.orgId, [...(orgs.get(c.orgId) ?? []), c.campaignId]);
    brands.set(c.brandId!, orgs);
  }
  if (brands.size === 0) return refuse("no_campaign_of_ours_brings_people_to_from");
  const toSources = new Set<string>();
  const perBrand = await outsideInteractiveView(() =>
    mapWithConcurrency([...brands], 1, async ([brandId, orgs]) => {
      const brandOnLeg = onLeg.filter((c) => c.brandId === brandId);
      const actingIds = sortedUnique(brandOnLeg.map((c) => c.campaignId));
      const actingInScope = new Set(brandOnLeg.filter(inScope).map((c) => c.campaignId));
      const focusInScope = new Set(focus.filter((c) => c.brandId === brandId && inScope(c)).map((c) => c.campaignId));
      const scopeIds = new Set([...orgs.values()].flat());
      const [brought, actionRows, toRows] = await Promise.all([
        signal
          ? mapWithConcurrency([...orgs], 1, ([orgId, ids]) => snapshotBrought(orgId, brandId, ids, signal)).then((xs) => xs.flat())
          : fetchStepOutcomes(brandId, fromEvent!).then((rows) =>
              rows.filter((r) => (scope.offerId === null ? true : r.campaignId !== null && scopeIds.has(r.campaignId))).map((r) => ({ leadId: r.leadId, fromAt: r.occurredAt })),
            ),
        actingIds.length > 0 ? fetchFollowupActionRows(brandId, actingIds) : Promise.resolve([]),
        fetchStepOutcomes(brandId, toEvent),
      ]);
      const acted = new Map<string, string | null>();
      const actedInScope = new Set<string>();
      const focusActedInScope = new Set<string>();
      for (const r of actionRows) {
        if (r.actedCount <= 0) continue;
        acted.set(r.leadId, acted.has(r.leadId) ? minIso(acted.get(r.leadId)!, r.firstActedAt) : r.firstActedAt);
        if (actingInScope.has(r.actingCampaignId)) actedInScope.add(r.leadId);
        if (focusInScope.has(r.actingCampaignId)) focusActedInScope.add(r.leadId);
      }
      const broughtIds = new Set(brought.map((b) => b.leadId));
      for (const r of toRows) if (broughtIds.has(r.leadId) || acted.has(r.leadId)) toSources.add(r.source);
      return ourLeadsToTeamFigures({ brought, acted, actedInScope, toAtByLead: datesByLead(toRows), focusActedInScope });
    }),
  );
  return { meta: { ...meta, toSources: sortedUnique(toSources) }, perBrand, reason: null };
}
