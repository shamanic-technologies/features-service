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
/** Tries of a version's whole-history dated read before it is asked month by month. */
const WHOLE_READ_ATTEMPTS = 2;
/** The first month a run can have started in (runs-service's ledger starts 2026-02-02; one month of margin). */
const HISTORY_FIRST_MONTH = "2026-01";

/** A runs-service read that failed; `status` null = no HTTP answer (connection refused, timeout). */
class RunsReadError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** Every [first instant of a month, first instant of the next) from `firstMonth` (YYYY-MM) through the month of `now`. */
export function monthWindows(firstMonth: string, now: Date): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let y = Number(firstMonth.slice(0, 4));
  let m = Number(firstMonth.slice(5, 7));
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    out.push([`${y}-${String(m).padStart(2, "0")}-01T00:00:00.000Z`, `${ny}-${String(nm).padStart(2, "0")}-01T00:00:00.000Z`]);
    y = ny;
    m = nm;
  }
  return out;
}

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
  // A big org's dated read can hit runs-service's statement timeout on a busy box (500, 2 runs of 7 on 2026-10-19), and a
  // deploy can restart runs-service mid-run (connection refused, 2026-10-24): the run is one-off and off any request, so
  // it waits and asks again before failing loud.
  const get = async (path: string, params: URLSearchParams, orgId: string, attempts = RUNS_ATTEMPTS): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      let status: number | null = null;
      try {
        const res = await fetchWithRetry(`${baseUrl}${path}?${params}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } });
        if (res.ok) return res.json();
        status = res.status;
        failure = `${res.status}: ${await res.text()}`;
        if (res.status < 500) throw new RunsReadError(`runs-service ${path} (org ${orgId}) failed (${failure})`, res.status);
      } catch (err) {
        if (err instanceof RunsReadError) throw err;
        failure = (err as Error).message;
      }
      if (attempt >= attempts) throw new RunsReadError(`runs-service ${path} (org ${orgId}) failed (${failure}) after ${attempt} attempt(s)`, status);
      console.warn(`[fleet-index-backfill] runs-service ${path} (org ${orgId}) failed (${failure.slice(0, 120)}), attempt ${attempt}/${attempts}; retrying`);
      await new Promise((r) => setTimeout(r, RUNS_RETRY_WAIT_MS * attempt));
    }
  };
  // One version's dated spend: the whole history in one read; when runs-service cannot answer it in time (statement
  // timeout on a big org), the same read month by month (run-start windows, disjoint: each run lands in one day).
  const datedBuckets = async (params: URLSearchParams, orgId: string): Promise<Array<Record<string, unknown>>> => {
    const bucketsOf = (data: unknown): Array<Record<string, unknown>> => {
      const b = (data as { buckets?: unknown }).buckets;
      if (!Array.isArray(b)) throw new Error("runs-service /v1/stats/costs/timeseries returned no buckets array");
      return b as Array<Record<string, unknown>>;
    };
    try {
      return bucketsOf(await get("/v1/stats/costs/timeseries", params, orgId, WHOLE_READ_ATTEMPTS));
    } catch (err) {
      if (!(err instanceof RunsReadError) || (err.status !== null && err.status < 500)) throw err;
      console.warn(`[fleet-index-backfill] org ${orgId}: whole-history dated read failed, reading month by month`);
      const out: Array<Record<string, unknown>> = [];
      for (const [after, before] of monthWindows(HISTORY_FIRST_MONTH, new Date())) {
        const p = new URLSearchParams(params);
        p.set("startedAfter", after);
        p.set("startedBefore", before);
        out.push(...bucketsOf(await get("/v1/stats/costs/timeseries", p, orgId)));
      }
      return out;
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
    return (await datedBuckets(params, r.orgId)).map((b): DatedSlugSpend => {
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

/** One leg's dated spend on the three bases the PUBLIC vendor history reads (PUBLIC-VENDOR-COST-1031). */
export interface DatedSlugSpendBases {
  /** Billed, comped rows included (the incurred basis), from the SAME vendor read: the population check. */
  gross: DatedSlugSpend[];
  vendor: DatedSlugSpend[];
  unpriced: DatedSlugSpend[];
}

/**
 * Spend per workflow version and run-start UTC day on each leg's campaigns at real VENDOR cost, its unpriced twin and its
 * billed figure, read off runs-service's vendor timeseries grouped per version (one read per org x campaign chunk). The
 * same row set as `readDatedSlugSpend`; FAIL-LOUD.
 */
export async function readDatedSlugSpendBases(
  featureSlug: string,
  legs: ReadonlyArray<{ legKey: string; campaigns: ReadonlyArray<{ campaignId: string; orgId: string }> }>,
  spendSlugs: "own" | "fed" = "own",
): Promise<DatedSlugSpendBases> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const featureSlugs = runsSpendSlugsParam(featureSlug, effectiveSpendSlugs(featureSlug, spendSlugs));
  const reads = legs.flatMap((leg) => {
    const byOrg = new Map<string, string[]>();
    for (const c of leg.campaigns) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c.campaignId]);
    return [...byOrg].flatMap(([orgId, ids]) => chunk([...new Set(ids)].sort(), RUNS_CAMPAIGN_IDS_PER_REQUEST).map((c) => ({ legKey: leg.legKey, orgId, ids: c })));
  });
  const rows = await mapWithConcurrency(reads, 1, async (r) => {
    const params = new URLSearchParams({ interval: "day", tz: "UTC", groupBy: "workflowSlug", orgId: r.orgId, featureSlugs, campaignIds: r.ids.join(",") });
    for (let attempt = 1; ; attempt++) {
      const res = await fetchWithRetry(`${baseUrl}/internal/stats/costs/timeseries/vendor?${params}`, { headers: { "x-api-key": apiKey } }, { timeoutMs: 300_000 });
      if (res.ok) {
        const body = (await res.json()) as { buckets?: Array<Record<string, unknown>> };
        if (!Array.isArray(body.buckets)) throw new Error("runs-service vendor timeseries returned no buckets array");
        return body.buckets.map((b) => ({ ...r, b }));
      }
      const failure = `${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status < 500 || attempt >= RUNS_ATTEMPTS) throw new Error(`runs-service vendor timeseries (org ${r.orgId}) failed (${failure})`);
      console.warn(`[fleet-index-backfill] vendor timeseries (org ${r.orgId}) failed (${failure}), attempt ${attempt}/${RUNS_ATTEMPTS}; retrying`);
      await new Promise((w) => setTimeout(w, RUNS_RETRY_WAIT_MS * attempt));
    }
  });
  const out: DatedSlugSpendBases = { gross: [], vendor: [], unpriced: [] };
  for (const { legKey, b } of rows.flat()) {
    const slug = b.workflowSlug;
    if (typeof slug !== "string" || !slug) continue;
    if (typeof b.period !== "string") throw new Error("runs-service vendor timeseries bucket missing period");
    const at = { legKey, workflowSlug: slug, day: b.period.slice(0, 10), runCount: Number(b.runCount ?? 0) };
    out.gross.push({ ...at, spentCents: Number(selectCostCentsString(b, "totalCostInUsdCents", "gross", "incurred")) });
    out.vendor.push({ ...at, spentCents: Number(selectCostCentsString(b, "totalCostInUsdCents", "vendor")) });
    out.unpriced.push({ ...at, spentCents: Number(selectCostCentsString(b, "totalCostInUsdCents", "vendorUnpriced")) });
  }
  return out;
}

/** The meeting pipe's per (campaign, version, day) spend on the three bases (`readMeetingHistoryInputs`' row set). */
export async function readMeetingSpendBases(
  campaigns: ReadonlyArray<{ campaignId: string; orgId: string }>,
): Promise<{ gross: MeetingHistoryInputs["spend"]; vendor: MeetingHistoryInputs["spend"]; unpriced: MeetingHistoryInputs["spend"] }> {
  const bases = await readDatedSlugSpendBases(
    MEETING_BOOKING_FEATURE_SLUG,
    campaigns.map((c) => ({ legKey: c.campaignId, campaigns: [{ campaignId: c.campaignId, orgId: c.orgId }] })),
  );
  const of = (xs: DatedSlugSpend[]) => xs.map((d) => ({ campaignId: d.legKey, workflowSlug: d.workflowSlug, day: d.day, spentCents: d.spentCents }));
  return { gross: of(bases.gross), vendor: of(bases.vendor), unpriced: of(bases.unpriced) };
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
      .map((p) => ({ brandId, source: "acted_person", leadId: p.leadId, event: "acted_person_meeting", occurredAt: p.signalDates?.meeting ?? null }));
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
  const body = (await res.json()) as { attributedMeetings?: Array<{ brandId: string; source: string; leadId?: string | null; event: string; occurredAt: string | null }> };
  if (!Array.isArray(body.attributedMeetings)) throw new Error("lead-service meeting-attribution: no attributedMeetings");
  return body.attributedMeetings.map((m) => {
    if (typeof m.source !== "string") throw new Error("lead-service meeting-attribution: a meeting row has no source");
    return { brandId: m.brandId, source: m.source, leadId: m.leadId ?? null, event: m.event, occurredAt: m.occurredAt };
  });
}
