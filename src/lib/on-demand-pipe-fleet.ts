/**
 * AN ON-DEMAND PIPE'S FLEET FIGURES, PER WORKFLOW (owner 2026-10-11: a sourcing pipe's spend is its OWN cost and ROI,
 * so funnels that differ only by their source price differently).
 *
 * A pipe whose trigger is INLINE (`on_demand`, `lib/channel-triggers.ts`: the sourcing channels, an origin or Lead
 * Sourcing) runs only when another pipe asks for it, each ask its OWN unit run (campaign-service
 * `POST /internal/on-demand-runs`). Like every pipe it is measured per workflow, on its UNITS (the leg's campaigns,
 * `fetchFleetLegCampaigns`), each unit credited to the workflow it runs:
 *   - OUTCOMES: the leads it found = the `ran` events of the inline triggers per unit (campaign-service
 *     `GET /internal/trigger-events/ran-counts`: lead-service records one per lead served under the unit; `on_demand`
 *     since 2026-10-11, `lead_requested` before, the same ask under its former name).
 *   - SPEND: every cost row of the unit's channel filed under the unit (its own slug, `runsOwnFeatureSlugsParam`;
 *     the serve and everything bought under it carry the unit's campaign), from the first recorded event on, so both
 *     halves cover the SAME window (runs-service `costs/timeseries?groupBy=campaignId&startedAfter=`, incurred basis).
 *   - `contacted` = the outcomes (a lead found is a person in hand: the pipe's conversion is not a rate it chooses).
 * The leg's maturity rule applies as for any pipe (`lib/maturity.ts`; Start -> Lead found: mature the day it is bought,
 * judged on 10 leads). Held 15 min fresh / 6 h stale, single-flight. FAIL-LOUD on a cold cell.
 */
import { fetchFleetLegCampaigns } from "./fleet-leg-campaigns.js";
import { fetchPublicWorkflows } from "./public-stats-clients.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { runsOwnFeatureSlugsParam } from "./feature-scope.js";
import { INLINE_TRIGGER_IDS } from "./channel-triggers.js";

const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

export interface OnDemandPipeFleet {
  byDynasty: Array<[string, LegMaturityFigures]>;
  campaignCount: number;
  /** When the window opens (the first recorded inline-trigger event), null = nothing recorded yet. */
  since: string | null;
  /** Leads found by a unit running no workflow of the channel: counted nowhere, logged. */
  unattributedLeads: number;
}

/** One unit's ran events (campaign-service). */
export interface RanCount {
  campaignId: string;
  ran: number;
}

/** PURE. Roll each unit's spend and found leads up to the dynasty of the workflow it runs. */
export function onDemandPipeFigures(input: {
  legKey: string;
  dynastyOfSlug: ReadonlyMap<string, string>;
  dynasties: readonly string[];
  /** Cents spent per unit, since the window opened. */
  centsByCampaign: ReadonlyMap<string, number>;
  ranCounts: readonly RanCount[];
  workflowOfCampaign: ReadonlyMap<string, string | null>;
}): { byDynasty: Map<string, LegMaturityFigures>; unattributedLeads: number } {
  const dynastyOf = (campaignId: string): string | null | undefined => {
    if (!input.workflowOfCampaign.has(campaignId)) return undefined; // not a unit of this leg
    const slug = input.workflowOfCampaign.get(campaignId);
    return (slug && input.dynastyOfSlug.get(slug)) || null;
  };
  const cents = new Map<string, number>();
  for (const [campaignId, c] of input.centsByCampaign) {
    const d = dynastyOf(campaignId);
    if (d) cents.set(d, (cents.get(d) ?? 0) + c);
  }
  const leads = new Map<string, number>();
  let unattributedLeads = 0;
  for (const r of input.ranCounts) {
    const d = dynastyOf(r.campaignId);
    if (d === undefined) continue;
    if (d === null) {
      unattributedLeads += r.ran;
      continue;
    }
    leads.set(d, (leads.get(d) ?? 0) + r.ran);
  }
  const byDynasty = new Map<string, LegMaturityFigures>();
  for (const dynasty of input.dynasties) {
    const found = leads.get(dynasty) ?? 0;
    const figures = outcomeFigures((cents.get(dynasty) ?? 0) / 100, found, found);
    // A 0-day leg: the mature evidence IS the evidence (`lib/maturity.ts`).
    byDynasty.set(dynasty, legMaturityFigures(input.legKey, figures, figures));
  }
  return { byDynasty, unattributedLeads };
}

export async function fetchRanCounts(triggerId: string): Promise<{ recordedSince: string | null; counts: RanCount[] }> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/internal/trigger-events/ran-counts?${new URLSearchParams({ triggerId })}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) throw new Error(`campaign-service ran-counts ${triggerId} failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { counts?: unknown; recordedSince?: unknown };
  if (!Array.isArray(body.counts)) throw new Error(`campaign-service ran-counts ${triggerId} returned no counts array`);
  return {
    recordedSince: typeof body.recordedSince === "string" ? body.recordedSince : null,
    counts: body.counts.flatMap((c) => {
      const row = c as { campaignId?: unknown; ran?: unknown };
      return typeof row.campaignId === "string" && typeof row.ran === "number" ? [{ campaignId: row.campaignId, ran: row.ran }] : [];
    }),
  };
}

/** Cents spent per campaign of `campaignIds` on the channel's own slug, runs started at or after `since` (incurred). */
async function fetchCentsByCampaignSince(featureSlug: string, campaignIds: readonly string[], since: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < campaignIds.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    const params = new URLSearchParams({
      interval: "day",
      groupBy: "campaignId",
      featureSlugs: runsOwnFeatureSlugsParam(featureSlug),
      campaignIds: campaignIds.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST).join(","),
      startedAfter: since,
    });
    const response = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs/timeseries?${params}`, {
      headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY! },
    });
    if (!response.ok) throw new Error(`runs-service costs/timeseries (on-demand pipe ${featureSlug}) failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { buckets?: Array<{ campaignId?: string | null; totalCostInUsdCents?: string; refundedCostInUsdCents?: string }> };
    if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries returned no buckets array");
    for (const b of data.buckets) {
      if (!b.campaignId || typeof b.totalCostInUsdCents !== "string") continue;
      // INCURRED, like every fleet figure: what it cost to find the lead, billed or comped.
      const cents = Number(b.totalCostInUsdCents) + Number(b.refundedCostInUsdCents ?? 0);
      out.set(b.campaignId, (out.get(b.campaignId) ?? 0) + cents);
    }
  }
  return out;
}

async function computeOnDemandPipeFleet(featureSlug: string, legKey: string): Promise<OnDemandPipeFleet> {
  const [campaigns, workflows, ...reads] = await Promise.all([
    fetchFleetLegCampaigns(featureSlug, legKey),
    fetchPublicWorkflows(featureSlug, "all"),
    ...[...INLINE_TRIGGER_IDS].map((t) => fetchRanCounts(t)),
  ]);
  const ranCounts = reads.flatMap((r) => r.counts);
  const starts = reads.map((r) => r.recordedSince).filter((s): s is string => s !== null).sort();
  const since = starts[0] ?? null;
  const ids = campaigns.map((c) => c.campaignId);
  const centsByCampaign = since && ids.length > 0 ? await fetchCentsByCampaignSince(featureSlug, ids, since) : new Map<string, number>();
  const { byDynasty, unattributedLeads } = onDemandPipeFigures({
    legKey,
    dynastyOfSlug: new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug] as const)),
    dynasties: [...new Set(workflows.map((w) => w.workflowDynastySlug))],
    centsByCampaign,
    ranCounts,
    workflowOfCampaign: new Map(campaigns.map((c) => [c.campaignId, c.workflowSlug ?? null] as const)),
  });
  if (unattributedLeads > 0) {
    console.warn(`[features-service] on-demand pipe ${featureSlug}|${legKey}: ${unattributedLeads} lead(s) found by units running no workflow of the channel are counted nowhere`);
  }
  return { byDynasty: [...byDynasty], campaignCount: campaigns.length, since, unattributedLeads };
}

const cells = new Map<string, { value: OnDemandPipeFleet; at: number }>();
const inFlight = new Map<string, Promise<OnDemandPipeFleet>>();

/** The figures of one on-demand pipe (see the header), stale-while-revalidate. */
export async function getOnDemandPipeFleet(featureSlug: string, legKey: string): Promise<OnDemandPipeFleet> {
  const key = `${featureSlug}|${legKey}`;
  const refresh = (): Promise<OnDemandPipeFleet> => {
    let p = inFlight.get(key);
    if (!p) {
      p = computeOnDemandPipeFleet(featureSlug, legKey)
        .then((value) => {
          cells.set(key, { value, at: Date.now() });
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  };
  const cell = cells.get(key);
  const age = cell ? Date.now() - cell.at : Infinity;
  if (cell && age < FRESH_MS) return cell.value;
  if (cell && age < STALE_MS) {
    refresh().catch((err) => console.error(`[features-service] on-demand pipe ${key} refresh failed (serving the last value): ${(err as Error).message}`));
    return cell.value;
  }
  return refresh();
}

/** Test seam. */
export function __resetOnDemandPipeFleet(): void {
  cells.clear();
  inFlight.clear();
}
