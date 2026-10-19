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
import { executableDynasties, fetchPublicWorkflows } from "./public-stats-clients.js";
import { dedupPersonsByLead } from "./revenue-engine.js";
import { indexTimelines } from "./serving-row-credit.js";
import { fetchServingRowJourneys } from "./serving-row-journeys.js";
import { addPairPersons, type AssignmentChange, type DatedSlugSpend, type HistoryLeg, type PersonHistory, type WorkflowVersion } from "./fleet-index-history.js";

const RUNS_CONCURRENCY = 4;

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
): Promise<DatedSlugSpend[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const featureSlugs = runsSpendSlugsParam(featureSlug, effectiveSpendSlugs(featureSlug, "own"));
  const reads = legs.flatMap((leg) => {
    const byOrg = new Map<string, string[]>();
    for (const c of leg.campaigns) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c.campaignId]);
    return [...byOrg].flatMap(([orgId, ids]) => chunk([...new Set(ids)].sort(), RUNS_CAMPAIGN_IDS_PER_REQUEST).map((c) => ({ legKey: leg.legKey, orgId, ids: c })));
  });
  const get = async (path: string, params: URLSearchParams, orgId: string): Promise<unknown> => {
    const res = await fetchWithRetry(`${baseUrl}${path}?${params}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } });
    if (!res.ok) throw new Error(`runs-service ${path} (org ${orgId}) failed (${res.status}): ${await res.text()}`);
    return res.json();
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

/** Every version of the channel's workflows, and the dynasties workflow-service can run today. */
export async function readWorkflowVersions(featureSlug: string): Promise<{ versions: WorkflowVersion[]; runnableToday: Set<string> }> {
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  return {
    versions: workflows.map((w) => ({ workflowSlug: w.workflowSlug, workflowDynastySlug: w.workflowDynastySlug, workflowDynastyName: w.workflowDynastyName ?? null })),
    runnableToday: executableDynasties(workflows),
  };
}
