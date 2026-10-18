/**
 * THE IO HALF OF THE RESEARCH STUDIES READ ON EACH EMAIL SENT, AND OF THE TYPED JUDGMENT SECTION (LIVE-RESEARCH-1018).
 *
 *  - Our copy of instantly-service's outreach facts (`outreach_fact_copy`, `lib/outreach-facts-copy.ts`), grouped here in
 *    SQL: every email of a leg's mature cohort with the outcome credited to it (the last email before a positive reply on
 *    the thread; a human click to the email it was on), and every thread's open-tracking arm.
 *  - The leg's mature spend split by what it buys (runs-service, by cost name): the per-email sending charges and the rest.
 *  - Jev: runs-service `task-units`, lead-service and human-service screen stats.
 * Pure study writing: `lib/research/sends.ts`, `lib/research/jev.ts`.
 */
import { sql as pg } from "../db/index.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "../lib/pricing.js";
import { runsSpendSlugsParam } from "../lib/feature-scope.js";
import { startedBeforeParam } from "../lib/maturity.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "../lib/brand-spend-by-day-client.js";
import type { CostGroup } from "../lib/public-stats-clients.js";
import type { LegSpendSplit, OpensArm, SendGroup } from "../lib/research/sends.js";
import type { JevInput, JudgmentGroup, ScreenMonth } from "../lib/research/jev.js";

/**
 * The cost names charged PER EMAIL SENT (the sending mailbox and domain): the only spend a follow-up adds. Everything
 * else on a cold email run (the lead, writing the whole sequence, the upload) is bought once per person. Same list as
 * the nightly snapshot's (`extract.sh` PER_EMAIL_COSTS).
 */
const PER_EMAIL_COST_NAMES = new Set(["instantly-account-email-sent", "instantly-domain-email-sent", "instantly-email-send"]);

/** Every email of the leg's mature cohort (first email of the thread before `cutoffIso`), grouped. */
export async function readSendGroups(campaignIds: readonly string[], cutoffIso: string | null): Promise<SendGroup[]> {
  if (!campaignIds.length) return [];
  const cutoff = cutoffIso ?? "9999-12-31T00:00:00Z";
  const rows = await pg<
    Array<{ org_id: string | null; month: string; step: number; weekday: string | null; hour: string | null; screenable: boolean; emails: string; replies: string; clicks: string }>
  >`
    WITH s AS (
      SELECT instantly_campaign_id AS t, lead_email AS e, org_id, occurred_at, local_weekday, local_sent_at, transport,
             coalesce(step, row_number() OVER (PARTITION BY instantly_campaign_id, lead_email ORDER BY occurred_at))::int AS step
      FROM outreach_fact_copy
      WHERE type = 'email_sent' AND NOT withdrawn AND campaign_id = ANY(${pg.array([...campaignIds])})
    ),
    th AS (SELECT t, e, min(occurred_at) AS first_at FROM s GROUP BY 1, 2),
    pr AS (
      SELECT instantly_campaign_id AS t, lead_email AS e, min(occurred_at) AS at FROM outreach_fact_copy
      WHERE type = 'reply' AND NOT withdrawn AND reply_classification = 'positive' AND campaign_id = ANY(${pg.array([...campaignIds])})
      GROUP BY 1, 2
    ),
    ck AS (
      SELECT instantly_campaign_id AS t, lead_email AS e, min(occurred_at) AS at FROM outreach_fact_copy
      WHERE type = 'link_clicked' AND NOT withdrawn AND transport = 'smtp' AND campaign_id = ANY(${pg.array([...campaignIds])})
      GROUP BY 1, 2
    ),
    cr AS (
      SELECT DISTINCT ON (pr.t, pr.e) pr.t, pr.e, s.occurred_at AS sent_at FROM pr JOIN s ON s.t = pr.t AND s.e = pr.e AND s.occurred_at <= pr.at
      ORDER BY pr.t, pr.e, s.occurred_at DESC
    ),
    cc AS (
      SELECT DISTINCT ON (ck.t, ck.e) ck.t, ck.e, s.occurred_at AS sent_at FROM ck JOIN s ON s.t = ck.t AND s.e = ck.e AND s.occurred_at <= ck.at AND s.transport = 'smtp'
      ORDER BY ck.t, ck.e, s.occurred_at DESC
    )
    SELECT s.org_id, to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, s.step, s.local_weekday AS weekday,
           substr(s.local_sent_at, 12, 2) AS hour, (s.transport = 'smtp') AS screenable,
           count(*) AS emails,
           count(*) FILTER (WHERE cr.sent_at = s.occurred_at) AS replies,
           count(*) FILTER (WHERE cc.sent_at = s.occurred_at) AS clicks
    FROM s JOIN th ON th.t = s.t AND th.e = s.e
    LEFT JOIN cr ON cr.t = s.t AND cr.e = s.e
    LEFT JOIN cc ON cc.t = s.t AND cc.e = s.e
    WHERE th.first_at < ${cutoff}::timestamptz
    GROUP BY 1, 2, 3, 4, 5, 6
  `;
  return rows.map((r) => ({
    orgId: r.org_id ?? "",
    month: r.month,
    step: Number(r.step),
    weekday: r.weekday,
    hour: r.hour === null || r.hour === "" ? null : Number(r.hour),
    screenable: Boolean(r.screenable),
    emails: Number(r.emails),
    replies: Number(r.replies),
    clicks: Number(r.clicks),
  }));
}

/** Every cold email thread first written to before `cutoffIso`, by its open-tracking arm (the nightly script's pixel population). */
export async function readOpensArms(cutoffIso: string): Promise<{ on: OpensArm; off: OpensArm; unplaced: number } | null> {
  const rows = await pg<Array<{ arm: string | null; people: string; positive: string; replied: string; bounced: string; first_day: string | null; last_day: string | null }>>`
    WITH th AS (
      SELECT instantly_campaign_id AS t, lead_email AS e,
             min(occurred_at) FILTER (WHERE type = 'email_sent') AS first_at,
             max(open_tracking) AS arm,
             bool_or(type = 'reply' AND reply_classification = 'positive') AS positive,
             bool_or(type = 'reply' AND coalesce(reply_automated, false) = false AND reply_kind IS NOT NULL) AS replied,
             bool_or(type = 'email_bounced') AS bounced
      FROM outreach_fact_copy WHERE NOT withdrawn GROUP BY 1, 2
    )
    SELECT arm, count(*) AS people, count(*) FILTER (WHERE positive) AS positive, count(*) FILTER (WHERE replied) AS replied,
           count(*) FILTER (WHERE bounced) AS bounced,
           to_char(min(first_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first_day, to_char(max(first_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day
    FROM th WHERE first_at IS NOT NULL AND first_at < ${cutoffIso}::timestamptz GROUP BY 1
  `;
  const of = (arm: string): OpensArm => {
    const r = rows.find((x) => x.arm === arm);
    return r
      ? { people: Number(r.people), positive: Number(r.positive), replied: Number(r.replied), bounced: Number(r.bounced), firstDay: r.first_day, lastDay: r.last_day }
      : { people: 0, positive: 0, replied: 0, bounced: 0, firstDay: null, lastDay: null };
  };
  if (!rows.length) return null;
  // A fact copied before instantly-service stated the arm carries none: such a thread cannot be placed either.
  const unplaced = rows.filter((r) => r.arm !== "on" && r.arm !== "off").reduce((a, r) => a + Number(r.people), 0);
  return { on: of("on"), off: of("off"), unplaced };
}

/** Every cold email reply, by who wrote it (the reply classifier's current verdict). */
export async function readReplyAuthors(): Promise<JevInput["replies"]> {
  const rows = await pg<Array<{ person: string; ooo: string; other: string; orgs: string }>>`
    SELECT count(*) FILTER (WHERE NOT coalesce(reply_automated, false)) AS person,
           count(*) FILTER (WHERE reply_automated AND reply_kind ILIKE '%office%') AS ooo,
           count(*) FILTER (WHERE reply_automated AND reply_kind NOT ILIKE '%office%') AS other,
           count(DISTINCT org_id) FILTER (WHERE reply_automated) AS orgs
    FROM outreach_fact_copy WHERE type = 'reply' AND NOT withdrawn AND reply_kind IS NOT NULL
  `;
  const r = rows[0];
  if (!r || Number(r.person) + Number(r.ooo) + Number(r.other) === 0) return null;
  return { person: Number(r.person), outOfOffice: Number(r.ooo), otherAuto: Number(r.other), orgs: Number(r.orgs) };
}

/** The leg's spend of runs started before the cutoff, split into per-email sending charges and the rest. */
export async function readLegSpendSplit(featureSlug: string, campaignIds: readonly string[], pricing: Pricing, cutoffIso: string | null): Promise<LegSpendSplit> {
  const base = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const ids = [...new Set(campaignIds)].sort();
  let perEmail = 0;
  let total = 0;
  for (let i = 0; i < ids.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    const params = new URLSearchParams({ groupBy: "costName", featureSlugs: runsSpendSlugsParam(featureSlug, "own"), campaignIds: ids.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST).join(",") });
    if (cutoffIso) params.set("startedBefore", startedBeforeParam(cutoffIso));
    const res = await fetchWithRetry(runsCostsUrl(base, "public", pricing, params), { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error(`runs-service research spend split failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { groups?: CostGroup[] };
    if (!Array.isArray(body.groups)) throw new Error("runs-service research spend split: no groups array");
    for (const g of body.groups) {
      const name = g.dimensions.costName;
      if (!name || name === "__total__") continue;
      const usd = Number(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred")) / 100;
      total += usd;
      if (PER_EMAIL_COST_NAMES.has(name)) perEmail += usd;
    }
  }
  return { perEmailUsd: perEmail, perPersonUsd: total - perEmail };
}

async function getJson<T>(url: string, apiKey: string | undefined, what: string): Promise<T> {
  if (!apiKey) throw new Error(`${what}: api key not configured`);
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } }, { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface TaskUnitsBody {
  groups: Array<{ month?: string; taskName?: string; parentServiceName?: string | null; runCount: number; orgCount: number; quantity: string; billedCostInUsdCents: string }>;
  total: { runCount: number; orgCount: number; quantity: string; billedCostInUsdCents: string };
}

type ScreenCounts = { screened: number; passed: number; declined: number };

/** Every input of the typed judgment section; each part null when its producer could not be read (logged). */
export async function readJevInputs(): Promise<Omit<JevInput, "costBasis" | "readOn" | "replies">> {
  const runs = process.env.RUNS_SERVICE_URL;
  const soft = async <T>(p: Promise<T>, what: string): Promise<T | null> => {
    try {
      return await p;
    } catch (err) {
      console.error(`[features-service] research jev: ${what} unreadable, its study states it:`, err);
      return null;
    }
  };
  const [judg, reveal, lead, human] = await Promise.all([
    soft(
      getJson<TaskUnitsBody>(
        `${runs}/internal/stats/costs/task-units?serviceName=chat-service&taskNames=judgments,platform-judgments&costNamePrefix=typesafe-jev-&groupBy=month,taskName,parentServiceName`,
        process.env.RUNS_SERVICE_API_KEY,
        "runs-service task-units (judgments)",
      ),
      "judgment volume",
    ),
    soft(
      getJson<TaskUnitsBody>(
        `${runs}/internal/stats/costs/task-units?serviceName=apollo-service&taskNames=enrichment&costNames=apollo-credit&costSource=platform&since=2026-09-28`,
        process.env.RUNS_SERVICE_API_KEY,
        "runs-service task-units (reveals)",
      ),
      "reveal price",
    ),
    soft(
      getJson<{ distinct: { orgs: number; audiences: number }; months: Array<{ month: string; byProbability: Record<string, ScreenCounts> }> }>(
        `${process.env.LEAD_SERVICE_URL}/internal/candidate-screenings/stats`,
        process.env.LEAD_SERVICE_API_KEY,
        "lead-service candidate-screenings/stats",
      ),
      "lead-service screens",
    ),
    soft(
      getJson<{ totals: { distinctOrgs: number; distinctAudiences: number }; months: Array<{ month: string; buckets: Record<string, ScreenCounts> }> }>(
        `${process.env.HUMAN_SERVICE_URL}/internal/research/teaser-screenings`,
        process.env.HUMAN_SERVICE_API_KEY,
        "human-service research/teaser-screenings",
      ),
      "human-service screens",
    ),
  ]);
  const judgments: JudgmentGroup[] | null = judg
    ? judg.groups.map((g) => ({
        month: g.month ?? "",
        taskName: g.taskName ?? "",
        parentServiceName: g.parentServiceName ?? null,
        runCount: Number(g.runCount),
        quantity: Number(g.quantity),
        billedCents: Number(g.billedCostInUsdCents),
      }))
    : null;
  const pv = (c: ScreenCounts | undefined) => ({ passed: Number(c?.passed ?? 0), declined: Number(c?.declined ?? 0) });
  const screens: ScreenMonth[] | null =
    lead && human
      ? [
          ...human.months.map((m) => ({ month: m.month, buckets: { lt20: pv(m.buckets.below_0_2), lt50: pv(m.buckets["0_2_to_0_5"]), lt80: pv(m.buckets["0_5_to_0_8"]), ge80: pv(m.buckets["0_8_and_above"]) } })),
          ...lead.months.map((m) => ({
            month: m.month,
            buckets: { lt20: pv(m.byProbability.below_0_2), lt50: pv(m.byProbability.from_0_2_to_0_5), lt80: pv(m.byProbability.above_0_5_below_0_8), ge80: pv(m.byProbability.from_0_8) },
          })),
        ]
      : null;
  return {
    judgments,
    judgmentOrgs: judg ? Number(judg.total.orgCount) : 0,
    screens,
    screenOrgs: Math.max(lead?.distinct.orgs ?? 0, human?.totals.distinctOrgs ?? 0),
    screenAudiences: Math.max(lead?.distinct.audiences ?? 0, human?.totals.distinctAudiences ?? 0),
    reveal: reveal ? { credits: Number(reveal.total.quantity), billedCents: Number(reveal.total.billedCostInUsdCents) } : null,
  };
}
