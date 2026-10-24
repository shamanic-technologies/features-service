/**
 * THE READS OF THE FLEET INDEX HISTORY (INDEX-HISTORY-BACKFILL-1019; pure half `fleet-index-history.ts`). One run, off any
 * request: every (org, brand) pair's persons and timelines one pair at a time (the fleet person cell's own walk), every
 * leg workflow version's spend per run-start day, the leg assignment history, the workflow catalogue. FAIL-LOUD: a read
 * that fails fails the run (a history missing a brand would be a wrong history, not a partial one).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflowLegAssignmentChanges } from "../db/schema.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { effectiveSpendSlugs, runsSpendSlugsParam } from "./feature-scope.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchFleetLegCampaigns } from "./fleet-leg-campaigns.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { outsideInteractiveView } from "./lead-copy.js";
import { selectCostCentsString } from "./pricing.js";
import { fetchDynastyMerges, fetchPublicWorkflows } from "./public-stats-clients.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";
import { dedupPersonsByLead } from "./revenue-engine.js";
import { indexTimelines } from "./serving-row-credit.js";
import { fetchServingRowJourneys } from "./serving-row-journeys.js";
import { addPairPersons, type AssignmentChange, type DatedSlugSpend, type HistoryLeg, type PersonHistory, type WorkflowVersion } from "./fleet-index-history.js";
import { fetchFollowupActionRows } from "./followup-actions-client.js";
import { MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, readActedPersons, STEP_REACHED } from "./meeting-leg-fleet.js";
import type { MeetingFact, MeetingHistoryInputs } from "./meeting-pipe-history.js";

const RUNS_CONCURRENCY = 2;
const RUNS_ATTEMPTS = 4;
const RUNS_RETRY_WAIT_MS = 20_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Each leg's campaigns (every org), keyed on the computation leg key. */
export async function readHistoryLegs(featureSlug: string, legKeys: readonly string[]): Promise<Array<HistoryLeg & { campaigns: Array<{ campaignId: string; orgId: string }> }>> {
  return Promise.all(
    legKeys.map(async (legKey) => {
      const campaigns = await fetchFleetLegCampaigns(featureSlug, legKey);
      return { legKey, campaignIds: new Set(campaigns.map((c) => c.campaignId)), campaigns: campaigns.map((c) => ({ campaignId: c.campaignId, orgId: c.orgId })) };
    }),
  );
}

/** Every pair's persons into `history`, one pair at a time (a big brand's walk is ~100 MB). */
export async function readPersonHistory(featureSlug: string, history: PersonHistory, legs: readonly HistoryLeg[], log: (line: string) => void): Promise<number> {
  const memberships = await fetchFeatureMemberships(featureSlug);
  const pairs = new Map<string, { orgId: string; brandId: string }>();
  for (const m of memberships) if (m.orgId && m.brandId) pairs.set(`${m.orgId}:${m.brandId}`, { orgId: m.orgId, brandId: m.brandId });
  let n = 0;
  await outsideInteractiveView(async () => {
    for (const p of pairs.values()) {
      const [rows, journeys] = await Promise.all([fetchLeadsForRevenue(p.brandId, undefined, { orgId: p.orgId }), fetchServingRowJourneys(p.brandId, { orgId: p.orgId })]);
      const persons = dedupPersonsByLead(rows);
      addPairPersons(history, persons, indexTimelines(journeys), legs);
      n += 1;
      log(`pair ${n}/${pairs.size} ${p.orgId}:${p.brandId}: ${persons.length} persons`);
    }
  });
  return pairs.size;
}

interface RunsCostGroup {
  dimensions: Record<string, string | null>;
}

/** Spend per workflow version and run-start UTC day on each leg's campaigns (incurred basis, the ranking's). */
export async function readDatedSlugSpend(
  featureSlug: string,
  legs: ReadonlyArray<{ legKey: string; campaigns: ReadonlyArray<{ campaignId: string; orgId: string }> }>,
  /** `own` = the pipe's own runs (the ranking's basis); `fed` = with the sourcing its leads cost (the outcome prices'). */
  spendSlugs: "own" | "fed" = "own",
): Promise<DatedSlugSpend[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const featureSlugs = runsSpendSlugsParam(featureSlug, effectiveSpendSlugs(featureSlug, spendSlugs));
  const reads = legs.flatMap((leg) => {
    const byOrg = new Map<string, string[]>();
    for (const c of leg.campaigns) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c.campaignId]);
    return [...byOrg].flatMap(([orgId, ids]) => chunk([...new Set(ids)].sort(), RUNS_CAMPAIGN_IDS_PER_REQUEST).map((c) => ({ legKey: leg.legKey, orgId, ids: c })));
  });
  // A big org's dated read can hit runs-service's statement timeout on a busy box (500, 2 runs of 7 on 2026-10-19):
  // the run is one-off and off any request, so it waits and asks again before failing loud.
  const get = async (path: string, params: URLSearchParams, orgId: string): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchWithRetry(`${baseUrl}${path}?${params}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } });
      if (res.ok) return res.json();
      const body = await res.text();
      if (res.status < 500 || attempt >= RUNS_ATTEMPTS) throw new Error(`runs-service ${path} (org ${orgId}) failed (${res.status}) after ${attempt} attempt(s): ${body}`);
      console.warn(`[fleet-index-backfill] runs-service ${path} (org ${orgId}) answered ${res.status}, attempt ${attempt}/${RUNS_ATTEMPTS}; retrying`);
      await new Promise((r) => setTimeout(r, RUNS_RETRY_WAIT_MS * attempt));
    }
  };
  // Which versions spent on these campaigns, then each version's spend per run-start day.
  const slugReads = (
    await mapWithConcurrency(reads, RUNS_CONCURRENCY, async (r) => {
      const data = (await get("/v1/stats/costs", new URLSearchParams({ groupBy: "workflowSlug", featureSlugs, campaignIds: r.ids.join(",") }), r.orgId)) as { groups?: RunsCostGroup[] };
      if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
      return data.groups.map((g) => g.dimensions.workflowSlug).filter((s): s is string => Boolean(s) && s !== "__total__").map((slug) => ({ ...r, slug }));
    })
  ).flat();
  const out = await mapWithConcurrency(slugReads, RUNS_CONCURRENCY, async (r) => {
    const params = new URLSearchParams({ interval: "day", tz: "UTC", workflowSlug: r.slug, featureSlugs, campaignIds: r.ids.join(",") });
    const data = (await get("/v1/stats/costs/timeseries", params, r.orgId)) as { buckets?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.buckets)) throw new Error("runs-service /v1/stats/costs/timeseries returned no buckets array");
    return data.buckets.map((b): DatedSlugSpend => {
      if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries bucket missing period");
      return {
        legKey: r.legKey,
        workflowSlug: r.slug,
        day: b.period.slice(0, 10),
        spentCents: Number(selectCostCentsString(b, "totalCostInUsdCents", "gross", "incurred")),
        runCount: Number(b.runCount ?? 0),
      };
    });
  });
  return out.flat();
}

/** Every leg-assignment change of the legs, re-keyed on the computation leg key. */
export async function readAssignmentChanges(featureSlug: string, legKeys: readonly string[]): Promise<AssignmentChange[]> {
  const stored = new Map(legKeys.map((k) => [servedLegKeyOf(featureSlug, k), k]));
  const rows = await db
    .select()
    .from(workflowLegAssignmentChanges)
    .where(and(eq(workflowLegAssignmentChanges.featureSlug, featureSlug), inArray(workflowLegAssignmentChanges.legKey, [...stored.keys(), ...legKeys])));
  return rows.map((r) => ({
    legKey: stored.get(r.legKey) ?? r.legKey,
    workflowDynastySlug: r.workflowDynastySlug,
    toState: r.toState,
    decidedAt: r.decidedAt.toISOString(),
  }));
}

/**
 * Every version of the channel's workflows, each with the instants workflow-service records for it: created, and
 * stopped being executable (`executableUntil`, null while it still is; WF-VERSION-DATES-1019). FAIL-LOUD on a version without them: who could be picked on a
 * past day is read off those two instants, never guessed.
 */
export async function readWorkflowVersions(featureSlug: string): Promise<WorkflowVersion[]> {
  const workflows = (await fetchPublicWorkflows(featureSlug, "all", true)) as Array<WorkflowMetadata & { createdAt?: string | null; executableUntil?: string | null }>;
  return workflows.map((w) => {
    if (!w.createdAt || w.executableUntil === undefined) throw new Error(`workflow-service states no createdAt / executableUntil for ${w.workflowSlug}`);
    return {
      workflowSlug: w.workflowSlug,
      workflowDynastySlug: w.workflowDynastySlug,
      workflowDynastyName: w.workflowDynastyName ?? null,
      createdAt: w.createdAt,
      executableUntil: w.executableUntil,
    };
  });
}

/**
 * The AI Meeting Booking pipe's dated inputs (MEETING-COST-METHODS-1024, `lib/meeting-pipe-history.ts`): its campaigns,
 * workflow versions and assignment changes, each campaign's spend per version and run-start day, every act of its workers
 * with its first date, and every meeting fact lead-service holds (dated). FAIL-LOUD.
 */
export async function readMeetingHistoryInputs(): Promise<MeetingHistoryInputs> {
  const campaigns = await fetchFleetLegCampaigns(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY);
  const [workflows, assignmentChanges, meetings, merges] = await Promise.all([
    readWorkflowVersions(MEETING_BOOKING_FEATURE_SLUG),
    readAssignmentChanges(MEETING_BOOKING_FEATURE_SLUG, [MEETING_BOOKING_LEG_KEY]),
    readMeetingFacts(),
    fetchDynastyMerges(MEETING_BOOKING_FEATURE_SLUG),
  ]);
  // Each campaign read as its own "leg": the spend rows come back keyed on the campaign.
  const dated = await readDatedSlugSpend(
    MEETING_BOOKING_FEATURE_SLUG,
    campaigns.map((c) => ({ legKey: c.campaignId, campaigns: [{ campaignId: c.campaignId, orgId: c.orgId }] })),
  );
  const byBrand = new Map<string, { orgId: string; ids: string[] }>();
  for (const c of campaigns) if (c.brandId) byBrand.set(c.brandId, { orgId: c.orgId, ids: [...(byBrand.get(c.brandId)?.ids ?? []), c.campaignId] });
  const perBrand = await mapWithConcurrency([...byBrand], 2, async ([brandId, { orgId, ids }]) => {
    const acts = (await fetchFollowupActionRows(brandId, ids))
      .filter((r) => r.actedCount > 0)
      .map((r) => ({ brandId, campaignId: r.actingCampaignId, leadId: r.leadId, firstActedAt: r.firstActedAt }));
    // A person acted on reached "meeting booked" on the live pipe's own reading (the engine's signals, matched by
    // email too); its date is that signal's (`signalDates.meeting`), undated = in no past day.
    const persons = acts.length ? await readActedPersons(orgId, brandId, new Set(acts.map((a) => a.leadId))) : [];
    const booked: MeetingFact[] = persons
      .filter((p) => STEP_REACHED.meeting_booked !== "acted" && (STEP_REACHED.meeting_booked as (x: typeof p) => boolean)(p))
      .map((p) => ({ brandId, leadId: p.leadId, event: "acted_person_meeting", occurredAt: p.signalDates?.meeting ?? null }));
    return { acts, booked };
  });
  return {
    campaigns,
    workflows,
    assignmentChanges,
    merges,
    meetings: [...meetings, ...perBrand.flatMap((b) => b.booked)],
    acts: perBrand.flatMap((b) => b.acts),
    spend: dated.map((d) => ({ campaignId: d.legKey, workflowSlug: d.workflowSlug, day: d.day, spentCents: d.spentCents })),
  };
}

/** Every meeting fact lead-service holds (booked or attended, every brand and cause), with its date. */
async function readMeetingFacts(): Promise<MeetingFact[]> {
  const res = await fetchWithRetry(`${process.env.LEAD_SERVICE_URL}/internal/meeting-attribution`, { headers: { "x-api-key": process.env.LEAD_SERVICE_API_KEY ?? "" } }, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`lead-service /internal/meeting-attribution ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { attributedMeetings?: Array<{ brandId: string; leadId?: string | null; event: string; occurredAt: string | null }> };
  if (!Array.isArray(body.attributedMeetings)) throw new Error("lead-service meeting-attribution: no attributedMeetings");
  return body.attributedMeetings.map((m) => ({ brandId: m.brandId, leadId: m.leadId ?? null, event: m.event, occurredAt: m.occurredAt }));
}
