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
 * HISTORY: one point per UTC day from the first activity (spend or a dated volume) to today, every figure
 * CUMULATIVE as it stood that day. An undated count (in no day) enters on the LAST point only, so the snapshot IS
 * the last point by construction (`undated` states how many).
 */
import { fetchFleetLegCampaigns, type FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { fetchFleetServeDayCounts } from "./fleet-positive-repliers.js";
import { fetchFollowupActionRows, type FollowupActionRow } from "./followup-actions-client.js";
import { fetchStepOutcomes } from "./step-outcomes-client.js";
import { ACT_IS_OUTCOME_STEPS, OUTCOME_EVENT_OF_STEP, earliestOutcomeByLead, internalPipeWork } from "./funnel-campaign-activity.js";
import { fetchRanCounts } from "./on-demand-pipe-fleet.js";
import { INLINE_TRIGGER_IDS } from "./channel-triggers.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCentsString } from "./pricing.js";
import { effectiveSpendSlugs, runsSpendSlugsParam } from "./feature-scope.js";
import { mapWithConcurrency } from "./concurrency.js";

export type PipeStatsKind = "entry" | "internal" | "on_demand";
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
      history.push({ date: day, spendUsd: round2(spend), volumes, costPerOutcomeUsd: r.cost, roi: r.roi });
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
}

/** PURE: the measure rule's kind (where the leg starts, its trigger), never the channel. */
export function pipeStatsKind(p: Pick<PipeStatsPipe, "fromStep" | "triggerId">): PipeStatsKind {
  if (p.triggerId !== null && INLINE_TRIGGER_IDS.has(p.triggerId)) return "on_demand";
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
  const reads = await Promise.all([...INLINE_TRIGGER_IDS].map((t) => fetchRanCounts(t)));
  const since = reads.map((r) => r.recordedSince).filter((s): s is string => s !== null).sort()[0] ?? null;
  const found = reads.flatMap((r) => r.counts).filter((c) => ids.has(c.campaignId)).reduce((a, c) => a + c.ran, 0);
  return { volumes: [{ key: "outcomes", label: p.toStepLabel, role: "outcome", datedBy: null, daily: new Map(), undated: found }], since };
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
  if (kind === "entry") volumes = await entryVolumes(p, idSet);
  else if (kind === "internal") volumes = await internalVolumes(p, campaigns);
  else ({ volumes, since: spendSince } = await onDemandVolumes(p, idSet));
  // On-demand with no recorded event yet: nothing found, nothing counted as spent on it.
  const spendByDay = ids.length === 0 || (kind === "on_demand" && spendSince === null) ? new Map<string, number>() : await fetchCampaignsNetSpendByDay(p.channelSlug, ids, spendSince);
  const figures = buildPipeStats({ volumes, outcomeKey: "outcomes", spendByDay, valuePerOutcomeUsd, today: new Date().toISOString().slice(0, 10) });
  return { scope, kind, basis: "since_inception", costBasis: "net_charged", campaignCount: ids.length, spendSince, computedAt: new Date().toISOString(), ...figures };
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
