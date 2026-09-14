/**
 * WHAT ACTUALLY RAN, read from the ledger that recorded it.
 *
 * A campaign's `workflow_slug` on campaign-service's own row is the workflow it was CONFIGURED with
 * at creation. The bandit picks a (workflow, audience) cell per trigger and hands it straight to the
 * execution call without ever writing it back, so that column is a FALLBACK and nothing more — and a
 * consumer badging it as "running now" states a configuration where a reader expects a fact. Measured
 * in prod 2026-09-14, campaign `f7b1b610…`: the row said `sales-cold-email-outreach-rudder-v3`, frozen
 * on 2026-09-06, while **rudder had never served a single lead** and lithium-v6 had served 2,439 of
 * them, most recently that morning.
 *
 * ── NOTHING IS STORED HERE, AND THAT IS THE WHOLE POINT ─────────────────────────────────────────
 *
 * The history already exists, exactly, twice over. campaign-service opens a run per trigger and
 * runs-service persists `campaign_id` + `workflow_slug` + `audience_id` + `started_at` on it at WRITE
 * time — the bandit's own choice, frozen by the service that made it. Prod, the same campaign: 3,473
 * trigger runs since 2026-09-06, `workflow_slug` non-null on **178,046 of 178,046** fleet-wide over 30
 * days. So this reads that ledger; it does not open a third copy of a fact two services already hold,
 * and there is no bronze/silver/gold to add.
 *
 * ── IT IS READ LIVE, NEVER FROM THE GOLD SNAPSHOT ───────────────────────────────────────────────
 *
 * Same rule, and the same reason, as the brand's ECONOMICS on this route: a figure whose whole job is
 * to say what is happening RIGHT NOW cannot be served from a cell that may be half an hour stale. The
 * evidence fan-out stays cached; this does not.
 *
 * ── A TRIGGER RUN IS `service_name='campaign-service'` AND NOTHING ELSE ──────────────────────────
 *
 * Every descendant of a trigger (workflow, lead-service, apollo, instantly …) inherits the same
 * `campaign_id`, so an unfiltered read answers ~28k rows for one campaign and says the same thing
 * 8 times over. campaign-service names its own run after the campaign, so `task_name = campaign_id`
 * on **178,046 of 178,046** of them — one row per trigger, which is one pick.
 *
 * ── `audienceId: null` IS A REAL STATE ──────────────────────────────────────────────────────────
 *
 * The audience write-tag is younger than the workflow one: fleet-wide it covers 94-97% of triggers in
 * the last three weeks and ~40% in July. So an older pick states its workflow and no audience, and
 * that is reported as `null` — never substituted, never guessed from a neighbouring run.
 *
 * A trigger stating NO workflow answers nothing about a pick and is dropped rather than carried as a
 * half-row (zero such rows in prod over 30 days).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { dynastyOfSlug } from "./workflow-scope.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";

/** How many picks a read states. Bounded so a debug panel cannot ask for a campaign's whole history. */
export const OBSERVED_PICKS_DEFAULT = 50;
export const OBSERVED_PICKS_MAX = 200;
/** One call per identity member; a brand's largest identity with runs is 17 members in prod. */
const MEMBER_CONCURRENCY = 6;

/** One trigger run as runs-service stores it — the raw half, before any dynasty is resolved. */
export interface TriggerRun {
  campaignId: string;
  workflowSlug: string;
  audienceId: string | null;
  startedAt: string;
}

/** One pick the bandit made, named in the vocabulary every other row on this body speaks. */
export interface ObservedPick {
  /** The identity member the trigger ran under — a family has several, and they interleave. */
  campaignId: string;
  /** The VERSIONED slug runs-service froze. Kept so a reader can join back to the ledger. */
  workflowSlug: string;
  /** Its dynasty — the key `rank` / `scopeRank` / `recommendedWorkflowDynastySlug` all speak. */
  workflowDynastySlug: string;
  /** Null when the catalogue describes no version of it (a retired lineage answers with its slug). */
  workflowDynastyName: string | null;
  /** Null when this trigger predates the audience write-tag. Never substituted. */
  audienceId: string | null;
  startedAt: string;
}

export interface ObservedPicks {
  /** The most recent pick across the WHOLE identity. Null when the campaign has never triggered. */
  last: ObservedPick | null;
  /** The most recent picks, newest first, at most the requested limit. */
  recent: ObservedPick[];
  /** True when the identity has more triggers than the limit states — the list is a window. */
  truncated: boolean;
}

/**
 * PURE: the identity's trigger runs, newest first, named by dynasty and cut to `limit`.
 *
 * A slug the catalogue does not describe is ITS OWN dynasty of one (`dynastyOfSlug`'s rule, shared
 * with `?groupBy=workflow` and the drill-down) — so a RETIRED lineage, which is exactly the workflow
 * a "what actually ran" question is most often about, answers with its real key rather than vanishing.
 */
export function buildObservedPicks(
  runs: readonly TriggerRun[],
  workflows: readonly WorkflowMetadata[],
  limit: number,
): ObservedPicks {
  const toDynasty = dynastyOfSlug(workflows as WorkflowMetadata[]);
  const nameOf = new Map(workflows.map((w) => [w.workflowDynastySlug, w.workflowDynastyName]));

  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const picks: ObservedPick[] = sorted.map((r) => {
    const workflowDynastySlug = toDynasty(r.workflowSlug);
    return {
      campaignId: r.campaignId,
      workflowSlug: r.workflowSlug,
      workflowDynastySlug,
      workflowDynastyName: nameOf.get(workflowDynastySlug) ?? null,
      audienceId: r.audienceId,
      startedAt: r.startedAt,
    };
  });

  return { last: picks[0] ?? null, recent: picks.slice(0, limit), truncated: picks.length > limit };
}

/**
 * The identity's trigger runs, one runs-service call per member.
 *
 * runs-service takes no campaign LIST, so a family fans out — the same shape `/audience-stats` and the
 * campaign grain already use for email-gateway, and bounded by the same reasoning: a trigger carries
 * exactly ONE campaign, so the union counts nobody twice. Each member is asked for `limit` rows, so the
 * merge is exact rather than a sample of whichever member answered first.
 *
 * Fail-loud: the caller decides whether a failure nulls a block or fails a page.
 */
export async function fetchCampaignTriggerRuns(
  campaignIds: readonly string[],
  headers: { orgId: string; userId?: string; runId?: string; brandId?: string },
  limit: number,
): Promise<TriggerRun[]> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.brandId) reqHeaders["x-brand-id"] = headers.brandId;

  const perMember = await mapWithConcurrency(campaignIds, MEMBER_CONCURRENCY, async (campaignId) => {
    const params = new URLSearchParams({
      campaignId,
      serviceName: "campaign-service",
      limit: String(limit),
    });
    const response = await fetchWithRetry(`${url}/v1/runs?${params}`, { headers: reqHeaders });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`runs-service /v1/runs failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as {
      runs?: Array<{
        campaignId?: string | null;
        workflowSlug?: string | null;
        audienceId?: string | null;
        startedAt?: string | null;
      }>;
    };
    if (!Array.isArray(data.runs)) {
      throw new Error("runs-service /v1/runs returned no runs array");
    }
    const rows: TriggerRun[] = [];
    for (const run of data.runs) {
      // A trigger stating no workflow answers nothing about a pick; a row with no start cannot be
      // placed on the timeline. Neither is carried as a half-row.
      if (!run.workflowSlug || !run.startedAt) continue;
      rows.push({
        campaignId: run.campaignId ?? campaignId,
        workflowSlug: run.workflowSlug,
        audienceId: run.audienceId ?? null,
        startedAt: run.startedAt,
      });
    }
    return rows;
  });

  return perMember.flat();
}

/**
 * FAIL-SOFT, with a loud log — display enrichment, exactly like the spend cost-parents read and the
 * conversion-count tiles. A runs blip states `observedPicks: null` ("we could not read this") rather
 * than 502-ing a page whose every other figure is correct, and it never degrades to the CONFIGURED
 * workflow, which is the number this whole block exists to stop a consumer from badging.
 */
export async function fetchCampaignTriggerRunsSoft(
  campaignIds: readonly string[],
  headers: { orgId: string; userId?: string; runId?: string; brandId?: string },
  limit: number,
): Promise<TriggerRun[] | null> {
  try {
    return await fetchCampaignTriggerRuns(campaignIds, headers, limit);
  } catch (error) {
    console.error("[features-service] observed picks read failed:", error);
    return null;
  }
}
