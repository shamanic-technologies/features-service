/**
 * ONE PIPE'S STATS SINCE INCEPTION, AND THEIR HISTORY (owner 2026-10-12, the staff Pipe page: "les volumes traités, le
 * ROI, le $ par outcome since inception en snapshot et en line chart over time"; amended the same day: "la différence
 * entre cross org, sa brand et son offer").
 *
 * ONE read for every pipe (no channel branch). The population is the pipe's campaigns (every org's campaigns whose
 * stated leg is the pipe's leg, `fetchFleetLegCampaigns`), narrowed to ONE brand or ONE offer of a brand when asked:
 * the three scopes are the same computation on a smaller campaign set, so fleet >= brand >= offer by construction.
 * What a pipe's volumes ARE follows the one measure rule every pipe already has (`fleetPipeFigures`, where its leg
 * STARTS, never its channel):
 *   - ENTRY pipe (from nothing / Lead found): persons contacted, and those reaching its `to` step (fleet person cell,
 *     `lib/fleet-positive-repliers.ts`), dated by the SERVE that took them (`datedBy: "serve_day"`);
 *   - INTERNAL pipe (from any other step: AI meeting booking, AI instant call): people handed to it, acted on by it,
 *     reaching its `to` step (lead-service follow-up ledger + attributed outcomes, `internalPipeWork`, the campaign
 *     page's rule), each dated by its own event (`event_day`). Never divided by leads another campaign found;
 *   - ON-DEMAND pipe (a source, run when another pipe asks): leads found (its trigger's ran events, UNDATED: the
 *     producer serves counts only), spend from the first recorded event on (the pipe price's window).
 *
 * MONEY = NET (what orgs pay: runs' net charged twin, comped spend absent), every cost row filed under the pipe's
 * campaigns on its own slug, per UTC day. Cost per outcome = spend ÷ outcomes, NULL while outcomes are 0 (never a
 * floor, never the spend); ROI = value the pipe ADDS per outcome (`valueAddedTo`, the catalogue's step values) ×
 * outcomes ÷ spend. NOT the catalogue headline: the headline prices the pipe on its BEST MATURE workflow on the
 * incurred basis; these figures are the WHOLE pipe (every workflow, flash, net).
 *
 * CONVERSION RATES (owner 2026-10-12, same page: "les taux de conversion since inception snapshot et over time"): between
 * every two CONSECUTIVE volumes, plus first volume -> outcome when there are three or more, in PERCENT (numerator ÷
 * denominator × 100, 2 decimals), each with its two counts. Denominator 0 = null + `no_input_yet`, an unmeasured
 * volume = null + `volume_not_measured`, never 0. Same cohort basis as the volumes: an entry pipe's two counts are the
 * SAME serve-dated people (a cohort rate); an internal pipe's counts are each dated by their own event, so a day's
 * cumulative rate compares events to that day (an outcome can land days after the hand-over), not one cohort.
 *
 * CUSTOMER-TEAM pipe (`operatedBy: customer`, every `your-team-*` channel; owner 2026-10-12, "comparer leur conv rate
 * historique avec ceux qu'on a traités nous-mêmes"): no campaign of ours works it, so its volumes come from the brand's
 * OWN tools (crm-service, `lib/team-leg-reach-client.ts`): the people of the brand who reached the pipe's `from` step and
 * whom our campaigns never contacted (the customer team's own leads), and how many of THOSE reached its `to` step, each
 * dated by its own event. Spend is none (the customer's time costs us nothing), so cost per outcome and ROI are null
 * with a reason. A brand the CRM cannot answer serves both volumes UNMEASURED (null) + `teamSource.unavailableReason`,
 * never 0. Offer scope = the brand's CRM (a CRM person carries no offer: `teamSource.offerNarrowed: false`); fleet
 * scope = the sum over every brand crm-service answers for. One rule for every customer-team pipe and leg.
 * Its SIBLING population (`ourLeadsToTeam`, `lib/team-on-our-leads.ts`; owner same day): the people OUR campaigns
 * brought to its `from` step that none of our pipes on the leg acted on, and how many reached `to`, beside our pipes'
 * own rate on the people they acted on. Additive: the volumes above keep their meaning.
 *
 * HISTORY: one point per UTC day from the first activity (spend or a dated volume) to today, every figure
 * CUMULATIVE as it stood that day. An undated count (in no day) enters on the LAST point only, so the snapshot IS
 * the last point by construction (`undated` states how many).
 */
import { fetchFleetLegCampaigns, type FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { fetchFleetServeDayCounts } from "./fleet-positive-repliers.js";
import { fetchFollowupActionRows, type FollowupActionRow } from "./followup-actions-client.js";
import { fetchStepOutcomes } from "./step-outcomes-client.js";
import { ACT_IS_OUTCOME_STEPS, OUTCOME_EVENT_OF_STEP, earliestOutcomeByLead, internalPipeWork } from "./funnel-campaign-activity.js";
import { fetchLeadsFound } from "./on-demand-pipe-fleet.js";
import { INLINE_TRIGGER_IDS } from "./channel-triggers.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCentsString } from "./pricing.js";
import { effectiveSpendSlugs, runsSpendSlugsParam } from "./feature-scope.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchTeamLegReach, fetchTeamLegReachBrands, type TeamLegReach } from "./team-leg-reach-client.js";
import { fetchLegPopulations, fetchOurLeadsToTeam, type LegPipeRef, type LegPopulations, type OurLeadsToTeam } from "./team-on-our-leads.js";
import { buildPipeTeamImpact, sumDated, type PipeTeamImpact } from "./pipe-team-impact.js";

export type PipeStatsKind = "entry" | "internal" | "on_demand" | "customer_team";
export type VolumeRole = "input" | "action" | "outcome";
export type DatedBy = "serve_day" | "event_day" | null;

export interface PipeStatsScope {
  kind: "fleet" | "brand" | "offer";
  brandId: string | null;
  offerId: string | null;
}

/** One volume of a pipe before it is cumulated: per UTC day, plus the count in no day. NULL `daily` = unmeasured. */
export interface VolumeInput {
  key: string;
  label: string;
  role: VolumeRole;
  datedBy: DatedBy;
  daily: Map<string, number> | null;
  undated: number;
}

export interface PipeStatsVolume {
  key: string;
  label: string;
  role: VolumeRole;
  datedBy: DatedBy;
  /** Since inception (dated + undated). Null = no producer counts it. */
  total: number | null;
  /** Of `total`, counted in no day (enters the history on its last point only). */
  undated: number;
}

export interface PipeStatsPoint {
  date: string;
  spendUsd: number;
  /** volume key -> cumulative count that day (null = unmeasured). */
  volumes: Record<string, number | null>;
  costPerOutcomeUsd: number | null;
  roi: number | null;
  /** conversion rate key -> cumulative rate that day, percent (null with no input yet or an unmeasured volume). */
  conversionRates: Record<string, number | null>;
}

export type ConversionRateUnavailableReason = "no_input_yet" | "volume_not_measured";

export interface PipeStatsConversionRate {
  key: string;
  fromKey: string;
  toKey: string;
  label: string;
  /** Count of `toKey` since inception (dated + undated). */
  numerator: number | null;
  /** Count of `fromKey` since inception (dated + undated). */
  denominator: number | null;
  /** numerator ÷ denominator × 100, 2 decimals. */
  ratePct: number | null;
  unavailableReason: ConversionRateUnavailableReason | null;
}

export interface PipeStatsFigures {
  firstActivityDay: string | null;
  volumes: PipeStatsVolume[];
  outcomeKey: string;
  spendUsd: number;
  costPerOutcomeUsd: number | null;
  costPerOutcomeUnavailableReason: "no_outcome_yet" | "outcome_not_measured" | "no_spend_recorded" | null;
  valuePerOutcomeUsd: number | null;
  roi: number | null;
  roiUnavailableReason: "step_unvalued" | "no_cost_per_outcome" | null;
  conversionRates: PipeStatsConversionRate[];
  history: PipeStatsPoint[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function ratios(spend: number, outcomes: number | null, valuePerOutcome: number | null) {
  let cost: number | null = null;
  let costReason: PipeStatsFigures["costPerOutcomeUnavailableReason"] = null;
  if (outcomes === null) costReason = "outcome_not_measured";
  else if (outcomes === 0) costReason = "no_outcome_yet";
  else if (spend <= 0) costReason = "no_spend_recorded";
  else cost = spend / outcomes;
  let roi: number | null = null;
  let roiReason: PipeStatsFigures["roiUnavailableReason"] = null;
  if (valuePerOutcome === null) roiReason = "step_unvalued";
  else if (cost === null) roiReason = "no_cost_per_outcome";
  else roi = (valuePerOutcome * outcomes!) / spend;
  return { cost: cost === null ? null : round2(cost), costReason, roi: roi === null ? null : round2(roi), roiReason };
}

/** PURE: which volume pairs are rated: every consecutive pair, then first -> last when that is not one of them. */
export function conversionPairs(volumes: readonly Pick<VolumeInput, "key" | "label">[]): Array<{ key: string; fromKey: string; toKey: string; label: string }> {
  const pair = (a: Pick<VolumeInput, "key" | "label">, b: Pick<VolumeInput, "key" | "label">) => ({ key: `${a.key}_to_${b.key}`, fromKey: a.key, toKey: b.key, label: `${a.label} → ${b.label}` });
  const out = volumes.slice(1).map((v, i) => pair(volumes[i]!, v));
  if (volumes.length >= 3) out.push(pair(volumes[0]!, volumes[volumes.length - 1]!));
  return out;
}

function rateOf(numerator: number | null, denominator: number | null): { ratePct: number | null; unavailableReason: ConversionRateUnavailableReason | null } {
  if (numerator === null || denominator === null) return { ratePct: null, unavailableReason: "volume_not_measured" };
  if (denominator === 0) return { ratePct: null, unavailableReason: "no_input_yet" };
  return { ratePct: round2((numerator / denominator) * 100), unavailableReason: null };
}

/** PURE: the snapshot and its cumulative daily history (see the header). `today` = the UTC day of the read. */
export function buildPipeStats(input: {
  volumes: VolumeInput[];
  outcomeKey: string;
  spendByDay: ReadonlyMap<string, number>;
  valuePerOutcomeUsd: number | null;
  today: string;
}): PipeStatsFigures {
  const days = new Set<string>();
  for (const [d, usd] of input.spendByDay) if (usd !== 0 && DAY_RE.test(d)) days.add(d);
  for (const v of input.volumes) for (const [d, n] of v.daily ?? []) if (n !== 0 && DAY_RE.test(d)) days.add(d);
  const first = days.size > 0 ? [...days].sort()[0]! : null;
  const anyUndated = input.volumes.some((v) => v.undated > 0);

  const pairs = conversionPairs(input.volumes);
  const history: PipeStatsPoint[] = [];
  const cum = new Map<string, number>(input.volumes.map((v) => [v.key, 0]));
  let spend = 0;
  if (first !== null || anyUndated) {
    const start = first !== null && first <= input.today ? first : input.today;
    for (let day = start; day <= input.today; day = nextDay(day)) {
      spend += input.spendByDay.get(day) ?? 0;
      const last = day === input.today;
      const volumes: Record<string, number | null> = {};
      for (const v of input.volumes) {
        if (v.daily === null) {
          volumes[v.key] = null;
          continue;
        }
        const n = cum.get(v.key)! + (v.daily.get(day) ?? 0);
        cum.set(v.key, n);
        volumes[v.key] = last ? n + v.undated : n;
      }
      const r = ratios(spend, volumes[input.outcomeKey] ?? null, input.valuePerOutcomeUsd);
      const conversionRates: Record<string, number | null> = {};
      for (const p of pairs) conversionRates[p.key] = rateOf(volumes[p.toKey] ?? null, volumes[p.fromKey] ?? null).ratePct;
      history.push({ date: day, spendUsd: round2(spend), volumes, costPerOutcomeUsd: r.cost, roi: r.roi, conversionRates });
    }
  }
  // Spend or counts dated after today (clock skew) still belong to the snapshot.
  for (const [d, usd] of input.spendByDay) if (DAY_RE.test(d) && d > input.today) spend += usd;
  const totals = new Map<string, number | null>(
    input.volumes.map((v) => [v.key, v.daily === null ? null : [...v.daily.values()].reduce((a, b) => a + b, 0) + v.undated]),
  );
  const outcomes = totals.get(input.outcomeKey) ?? null;
  const r = ratios(spend, outcomes, input.valuePerOutcomeUsd);
  return {
    firstActivityDay: first,
    volumes: input.volumes.map((v) => ({ key: v.key, label: v.label, role: v.role, datedBy: v.datedBy, total: totals.get(v.key) ?? null, undated: v.undated })),
    outcomeKey: input.outcomeKey,
    spendUsd: round2(spend),
    costPerOutcomeUsd: r.cost,
    costPerOutcomeUnavailableReason: r.costReason,
    valuePerOutcomeUsd: input.valuePerOutcomeUsd === null ? null : round2(input.valuePerOutcomeUsd),
    roi: r.roi,
    roiUnavailableReason: r.roiReason,
    conversionRates: pairs.map((p) => {
      const numerator = totals.get(p.toKey) ?? null;
      const denominator = totals.get(p.fromKey) ?? null;
      return { ...p, numerator, denominator, ...rateOf(numerator, denominator) };
    }),
    history,
  };
}

/** PURE: the campaigns of one scope. An offer scope keeps the brand's campaigns selling that offer. */
export function campaignsInScope(campaigns: readonly FleetLegCampaign[], scope: PipeStatsScope): FleetLegCampaign[] {
  return campaigns.filter((c) => (scope.brandId === null || c.brandId === scope.brandId) && (scope.offerId === null || c.offerId === scope.offerId));
}

/** PURE: split a `day -> count` map into dated days and the undated (`""`) count. */
function splitUndated(byDay: ReadonlyMap<string, number>): { daily: Map<string, number>; undated: number } {
  const daily = new Map<string, number>();
  let undated = 0;
  for (const [d, n] of byDay) {
    if (DAY_RE.test(d)) daily.set(d, (daily.get(d) ?? 0) + n);
    else undated += n;
  }
  return { daily, undated };
}

/** The pipe as this read needs it (from the agent catalogue). */
export interface PipeStatsPipe {
  channelSlug: string;
  /** The leg as computed on (`start_to_*` for an outbound entry leg). */
  computedLegKey: string;
  fromStep: string | null;
  toStep: string;
  fromStepLabel: string | null;
  toStepLabel: string;
  /** The pipe's trigger: an inline one makes it on-demand. */
  triggerId: string | null;
  /** `customer`: the customer's own team works the leg (`your-team-*`); its volumes come from their tools. */
  operatedBy: "platform" | "customer";
  /** Customer-team pipe: the PLATFORM pipes whose `to` is its `from` (they bring people to it) and those on its own
   *  leg (their action takes a person off the team), for `ourLeadsToTeam` (`lib/team-on-our-leads.ts`). */
  legNeighbours?: { producingPipes: readonly LegPipeRef[]; ourPipesOnLeg: readonly LegPipeRef[] };
  /** PLATFORM pipe whose leg (same `from`, same `to`) also has a customer-team pipe: those team channels and the leg's
   *  platform neighbours, for `teamImpact` (`lib/pipe-team-impact.ts`). Absent = no customer-team co-leg. */
  teamCoLeg?: { teamChannelSlugs: readonly string[]; producingPipes: readonly LegPipeRef[]; ourPipesOnLeg: readonly LegPipeRef[] };
}

/** PURE: the measure rule's kind (where the leg starts, its trigger), never the channel. */
export function pipeStatsKind(p: Pick<PipeStatsPipe, "fromStep" | "triggerId"> & Partial<Pick<PipeStatsPipe, "toStep">> & Partial<Pick<PipeStatsPipe, "operatedBy">>): PipeStatsKind {
  if (p.operatedBy === "customer") return "customer_team";
  // A SOURCING pipe (Start -> Lead found) is measured on the leads it found, whatever its mode: proactive since
  // 2026-10-12 (finds on its own), an inline trigger before.
  if ((p.fromStep === null && p.toStep === "lead_found") || (p.triggerId !== null && INLINE_TRIGGER_IDS.has(p.triggerId))) return "on_demand";
  if (p.fromStep !== null && p.fromStep !== "lead_found") return "internal";
  return "entry";
}

/** Which person count of the fleet cell reaches an entry pipe's `to` step (contacted, clicked, replied). */
const ENTRY_OUTCOME_INDEX: Readonly<Record<string, 1 | 2>> = { website_visit: 1, conversation: 2 };

async function entryVolumes(p: PipeStatsPipe, ids: ReadonlySet<string>): Promise<VolumeInput[]> {
  const byDay = await fetchFleetServeDayCounts(p.channelSlug, ids);
  const pick = (i: 0 | 1 | 2) => splitUndated(new Map([...byDay].map(([d, t]) => [d, t[i]])));
  const contacted = pick(0);
  const idx = ENTRY_OUTCOME_INDEX[p.toStep];
  const reached = idx === undefined ? null : pick(idx);
  return [
    { key: "contacted", label: "People contacted", role: "input", datedBy: "serve_day", ...contacted },
    { key: "outcomes", label: p.toStepLabel, role: "outcome", datedBy: reached ? "serve_day" : null, daily: reached?.daily ?? null, undated: reached?.undated ?? 0 },
  ];
}

async function internalVolumes(p: PipeStatsPipe, campaigns: readonly FleetLegCampaign[]): Promise<VolumeInput[]> {
  const byBrand = new Map<string, string[]>();
  for (const c of campaigns) if (c.brandId) byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c.campaignId]);
  const event = ACT_IS_OUTCOME_STEPS.has(p.toStep) ? null : (OUTCOME_EVENT_OF_STEP[p.toStep] ?? null);
  const countsReached = ACT_IS_OUTCOME_STEPS.has(p.toStep) || event !== null;
  const works = await mapWithConcurrency([...byBrand], 2, async ([brandId, ids]) => {
    const [rows, outcomes] = await Promise.all([
      fetchFollowupActionRows(brandId, ids) as Promise<FollowupActionRow[]>,
      event ? fetchStepOutcomes(brandId, event).then(earliestOutcomeByLead) : Promise.resolve(null),
    ]);
    return internalPipeWork(p.toStep, rows, outcomes);
  });
  const sum = (field: "handed" | "actedOn" | "reached") => {
    const daily = new Map<string, number>();
    let undated = 0;
    for (const w of works) {
      for (const d of w.daily) if (d[field] > 0) daily.set(d.date, (daily.get(d.date) ?? 0) + d[field]);
      undated += w.undated[field];
    }
    return { daily, undated };
  };
  const reached = sum("reached");
  return [
    { key: "handed", label: `${p.fromStepLabel ?? "People"} received`, role: "input", datedBy: "event_day", ...sum("handed") },
    { key: "actedOn", label: "Acted on", role: "action", datedBy: "event_day", ...sum("actedOn") },
    { key: "outcomes", label: p.toStepLabel, role: "outcome", datedBy: countsReached ? "event_day" : null, daily: countsReached ? reached.daily : null, undated: countsReached ? reached.undated : 0 },
  ];
}

async function onDemandVolumes(p: PipeStatsPipe, ids: ReadonlySet<string>): Promise<{ volumes: VolumeInput[]; since: string | null }> {
  const read = await fetchLeadsFound();
  const since = read.recordedSince;
  const found = read.counts.filter((c) => ids.has(c.campaignId)).reduce((a, c) => a + c.ran, 0);
  return { volumes: [{ key: "outcomes", label: p.toStepLabel, role: "outcome", datedBy: null, daily: new Map(), undated: found }], since };
}

/** Where a customer-team pipe's volumes come from, and why they are unmeasured when they are. */
export interface TeamSource {
  producer: "crm-service";
  population: "brand_people_reached_from_not_contacted_by_us";
  /** True when at least one brand of the scope answered. */
  available: boolean;
  /** Null when available; else the producer's reason (one brand) or `no_brand_answers` (fleet). */
  unavailableReason: string | null;
  /** Fleet: per producer reason, how many brands could not answer. */
  unavailableBrands: Record<string, number>;
  /** Brands summed into the volumes. */
  brandsCounted: number;
  /** Sources (the brand's tools) evidencing each end, unioned over the brands counted. */
  fromSources: string[];
  toSources: string[];
  /** Always false: a CRM person carries no offer, so an offer scope reads its brand's people. */
  offerNarrowed: false;
}

/** Most specific first: a step the brand's tools do not record, then not synced, then nothing connected, then no people. */
const TEAM_REASON_ORDER = ["from_step_not_recorded", "to_step_not_recorded", "step_not_in_crm_vocabulary", "not_synced", "no_connected_source", "no_people_scope"];
const reasonRank = (r: string): number => (TEAM_REASON_ORDER.indexOf(r) === -1 ? TEAM_REASON_ORDER.length : TEAM_REASON_ORDER.indexOf(r));

/** PURE: a scope's customer-team volumes from the producer's per-brand answers (see the header). */
export function customerTeamVolumes(
  p: Pick<PipeStatsPipe, "fromStepLabel" | "toStepLabel">,
  reaches: ReadonlyArray<TeamLegReach>,
  singleBrand: boolean,
): { volumes: VolumeInput[]; teamSource: TeamSource } {
  const answered = reaches.filter((r): r is Extract<TeamLegReach, { available: true }> => r.available);
  const unavailableBrands: Record<string, number> = {};
  for (const r of reaches) if (!r.available) unavailableBrands[r.reason] = (unavailableBrands[r.reason] ?? 0) + 1;
  const sum = (pick: (r: (typeof answered)[number]) => { daily: ReadonlyMap<string, number>; undated: number }) => {
    const daily = new Map<string, number>();
    let undated = 0;
    for (const r of answered) {
      const v = pick(r);
      for (const [d, n] of v.daily) daily.set(d, (daily.get(d) ?? 0) + n);
      undated += v.undated;
    }
    return { daily, undated };
  };
  const measured = answered.length > 0;
  const from = measured ? sum((r) => r.from) : { daily: null, undated: 0 };
  const to = measured ? sum((r) => r.to) : { daily: null, undated: 0 };
  // A brand two orgs hold answers once per org: the most SPECIFIC reason wins (an org with tools that do not record the
  // step says more than an empty org of the same brand).
  const reasons = reaches.filter((r): r is Extract<TeamLegReach, { available: false }> => !r.available).map((r) => r.reason);
  const firstReason = [...reasons].sort((a, b) => reasonRank(a) - reasonRank(b))[0] ?? "no_brand_answers";
  return {
    volumes: [
      { key: "reachedFrom", label: `${p.fromStepLabel ?? "People"} (their team)`, role: "input", datedBy: measured ? "event_day" : null, ...from },
      { key: "outcomes", label: `${p.toStepLabel} (their team)`, role: "outcome", datedBy: measured ? "event_day" : null, ...to },
    ],
    teamSource: {
      producer: "crm-service",
      population: "brand_people_reached_from_not_contacted_by_us",
      available: measured,
      unavailableReason: measured ? null : singleBrand ? firstReason : "no_brand_answers",
      unavailableBrands,
      brandsCounted: answered.length,
      fromSources: [...new Set(answered.flatMap((r) => r.fromSources))].sort(),
      toSources: [...new Set(answered.flatMap((r) => r.toSources))].sort(),
      offerNarrowed: false,
    },
  };
}

async function fetchCustomerTeamVolumes(p: PipeStatsPipe, scope: PipeStatsScope) {
  const fromStep = p.fromStep;
  if (fromStep === null) return customerTeamVolumes(p, [{ available: false, reason: "leg_has_no_from_step" }], true);
  const { steps, brands } = await fetchTeamLegReachBrands();
  // A brand two orgs hold is read once per org and summed (crm-service's people are per org).
  const asked = scope.brandId === null ? brands : brands.filter((b) => b.brandId === scope.brandId);
  if (asked.length === 0) return customerTeamVolumes(p, [{ available: false, reason: "no_people_scope" }], scope.brandId !== null);
  const reaches = await mapWithConcurrency(asked, 4, (b) => fetchTeamLegReach(b, steps, fromStep, p.toStep));
  return customerTeamVolumes(p, reaches, scope.brandId !== null);
}

/** NET spend per UTC day of `campaignIds` on the channel's own slug (runs-service, comped spend absent). Fail-loud. */
export async function fetchCampaignsNetSpendByDay(featureSlug: string, campaignIds: readonly string[], startedAfter: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const slugs = runsSpendSlugsParam(featureSlug, effectiveSpendSlugs(featureSlug, "own"));
  for (let i = 0; i < campaignIds.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    const params = new URLSearchParams({ interval: "day", featureSlugs: slugs, campaignIds: campaignIds.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST).join(",") });
    if (startedAfter) params.set("startedAfter", startedAfter);
    const response = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs/timeseries?${params}`, {
      headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY! },
    });
    if (!response.ok) throw new Error(`runs-service costs/timeseries (pipe stats ${featureSlug}) failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries returned no buckets array");
    for (const b of data.buckets) {
      if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries bucket missing period");
      const day = b.period.slice(0, 10);
      out.set(day, (out.get(day) ?? 0) + Number(selectCostCentsString(b, "totalCostInUsdCents", "net", "charged")) / 100);
    }
  }
  return out;
}

export interface PipeStatsBody extends PipeStatsFigures {
  scope: PipeStatsScope;
  kind: PipeStatsKind;
  basis: "since_inception";
  costBasis: "net_charged";
  campaignCount: number;
  /** An on-demand pipe's window opens on its first recorded event (spend before it is not counted); else null. */
  spendSince: string | null;
  /** Customer-team pipe only (else null): where its volumes come from, and why they are unmeasured. */
  teamSource: TeamSource | null;
  /** Customer-team pipe only (else null): the same pipe measured on the people OUR campaigns brought to its `from`
   *  step and our pipes on the leg left to the team, beside our pipes' rate (`lib/team-on-our-leads.ts`). */
  ourLeadsToTeam: OurLeadsToTeam | null;
  /** Platform pipe with a customer-team co-leg only (else null): "your team alone" vs "your team + this pipe" on the
   *  people our campaigns brought to `from`, and this pipe's impact (`lib/pipe-team-impact.ts`). */
  teamImpact: PipeTeamImpact | null;
  computedAt: string;
}

/** IO: the whole read for one pipe and one scope (see the header). */
export async function computePipeStats(p: PipeStatsPipe, scope: PipeStatsScope, valuePerOutcomeUsd: number | null): Promise<PipeStatsBody> {
  const all = await fetchFleetLegCampaigns(p.channelSlug, p.computedLegKey);
  const campaigns = campaignsInScope(all, scope);
  const ids = [...new Set(campaigns.map((c) => c.campaignId))].sort();
  const idSet = new Set(ids);
  const kind = pipeStatsKind(p);
  let volumes: VolumeInput[];
  let spendSince: string | null = null;
  let teamSource: TeamSource | null = null;
  let ourLeadsToTeam: OurLeadsToTeam | null = null;
  // A platform pipe sharing its leg with a customer team: the leg's populations, this pipe in focus (read beside the volumes).
  const coLeg = kind !== "customer_team" ? p.teamCoLeg : undefined;
  const populations: Promise<LegPopulations> | null = coLeg
    ? fetchLegPopulations(
        { fromStep: p.fromStep, toStep: p.toStep, fromStepLabel: p.fromStepLabel, toStepLabel: p.toStepLabel, producingPipes: coLeg.producingPipes, ourPipesOnLeg: coLeg.ourPipesOnLeg, focusPipes: [{ channelSlug: p.channelSlug, computedLegKey: p.computedLegKey }] },
        scope,
      )
    : null;
  // Settle it whatever the volumes do (no unhandled rejection), rethrown below: fail-loud like every pipe-stats read.
  populations?.catch(() => undefined);
  if (kind === "customer_team") {
    let team: Awaited<ReturnType<typeof fetchCustomerTeamVolumes>>;
    [team, ourLeadsToTeam] = await Promise.all([
      fetchCustomerTeamVolumes(p, scope),
      fetchOurLeadsToTeam({ ...p, producingPipes: p.legNeighbours?.producingPipes ?? [], ourPipesOnLeg: p.legNeighbours?.ourPipesOnLeg ?? [] }, scope),
    ]);
    ({ volumes, teamSource } = team);
  }
  else if (kind === "entry") volumes = await entryVolumes(p, idSet);
  else if (kind === "internal") volumes = await internalVolumes(p, campaigns);
  else ({ volumes, since: spendSince } = await onDemandVolumes(p, idSet));
  // On-demand with no recorded event yet: nothing found, nothing counted as spent on it.
  const spendByDay = ids.length === 0 || kind === "customer_team" || (kind === "on_demand" && spendSince === null) ? new Map<string, number>() : await fetchCampaignsNetSpendByDay(p.channelSlug, ids, spendSince);
  const today = new Date().toISOString().slice(0, 10);
  const figures = buildPipeStats({ volumes, outcomeKey: "outcomes", spendByDay, valuePerOutcomeUsd, today });
  let teamImpact: PipeTeamImpact | null = null;
  if (coLeg && populations) {
    const { perBrand, reason } = await populations;
    teamImpact = buildPipeTeamImpact({
      teamChannelSlugs: coLeg.teamChannelSlugs,
      fromStepLabel: p.fromStepLabel,
      toStepLabel: p.toStepLabel,
      reason,
      team: perBrand && { from: sumDated(perBrand.map((f) => f.left)), to: sumDated(perBrand.map((f) => f.reached)) },
      pipe: perBrand && { from: sumDated(perBrand.map((f) => f.focusActed)), to: sumDated(perBrand.map((f) => f.focusReached)) },
      spendByDay,
      today,
    });
  }
  return { scope, kind, basis: "since_inception", costBasis: "net_charged", campaignCount: ids.length, spendSince, teamSource, ourLeadsToTeam, teamImpact, computedAt: new Date().toISOString(), ...figures };
}

// ── Held per (pipe, scope), stale-while-revalidate (15 min fresh / 6 h stale, single-flight) ────────

const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const cells = new Map<string, { value: PipeStatsBody; at: number }>();
const inFlight = new Map<string, Promise<PipeStatsBody>>();

export async function getPipeStats(pipeId: string, p: PipeStatsPipe, scope: PipeStatsScope, valuePerOutcomeUsd: number | null): Promise<PipeStatsBody> {
  const key = `${pipeId}|${scope.brandId ?? ""}|${scope.offerId ?? ""}|${valuePerOutcomeUsd ?? ""}`;
  const refresh = (): Promise<PipeStatsBody> => {
    let pr = inFlight.get(key);
    if (!pr) {
      pr = computePipeStats(p, scope, valuePerOutcomeUsd)
        .then((value) => {
          cells.set(key, { value, at: Date.now() });
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pr);
    }
    return pr;
  };
  const cell = cells.get(key);
  const age = cell ? Date.now() - cell.at : Infinity;
  if (cell && age < FRESH_MS) return cell.value;
  if (cell && age < STALE_MS) {
    refresh().catch((err) => console.error(`[features-service] pipe stats ${key} refresh failed (serving the last value): ${(err as Error).message}`));
    return cell.value;
  }
  return refresh();
}

/** Test seam. */
export function __resetPipeStats(): void {
  cells.clear();
  inFlight.clear();
}
