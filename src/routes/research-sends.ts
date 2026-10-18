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
import type { ReportingBrand } from "../lib/research/meetings.js";
import type { GenerationRun, WorkflowRun } from "../lib/research/catalog.js";
import { meetingReportingOf } from "../lib/meeting-population.js";
import { rememberMeetingReporting } from "../lib/meeting-reporting-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";

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

/**
 * What one email cost in per-email sending charges, per send month (`YYYY-MM`) and step, fleet-wide: runs-service's
 * task-units rollup over instantly-service's `email-send-step-N` runs, billed cents ÷ runs (one run per email sent). Held an
 * hour. A grouped read by COST NAME over the leg's campaigns has no rollup at runs-service and timed out (30 s, 2026-10-18).
 */
let perEmailHeld: { at: number; value: Map<string, number> } | null = null;
export async function readPerEmailPrices(): Promise<Map<string, number>> {
  if (perEmailHeld && Date.now() - perEmailHeld.at < 60 * 60_000) return perEmailHeld.value;
  const names = [...PER_EMAIL_COST_NAMES].join(",");
  const body = await getJson<TaskUnitsBody>(
    `${process.env.RUNS_SERVICE_URL}/internal/stats/costs/task-units?serviceName=instantly-service&costNames=${names}&groupBy=month,taskName,costName`,
    process.env.RUNS_SERVICE_API_KEY,
    "runs-service task-units (per-email charges)",
  );
  // per (month, step) run counts once (a run carries one row per cost name), cents summed over the names
  const runs = new Map<string, number>();
  const cents = new Map<string, number>();
  for (const g of body.groups) {
    const k = `${g.month}|${g.taskName}`;
    runs.set(k, Math.max(runs.get(k) ?? 0, Number(g.runCount)));
    cents.set(k, (cents.get(k) ?? 0) + Number(g.billedCostInUsdCents));
  }
  const byMonth = new Map<string, { runs: number; cents: number }>();
  for (const [k, r] of runs) {
    const m = k.slice(0, 7);
    const t = byMonth.get(m) ?? { runs: 0, cents: 0 };
    t.runs += r;
    t.cents += cents.get(k) ?? 0;
    byMonth.set(m, t);
  }
  const value = new Map([...byMonth].filter(([, t]) => t.runs > 0).map(([m, t]) => [m, t.cents / 100 / t.runs]));
  perEmailHeld = { at: Date.now(), value };
  return value;
}

/** The leg's spend of runs started before the cutoff (incurred, the ranking's basis), on the read's pricing. */
export async function readLegSpendTotal(featureSlug: string, campaignIds: readonly string[], pricing: Pricing, cutoffIso: string | null): Promise<number> {
  const base = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const ids = [...new Set(campaignIds)].sort();
  let total = 0;
  for (let i = 0; i < ids.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    const params = new URLSearchParams({ groupBy: "workflowSlug", featureSlugs: runsSpendSlugsParam(featureSlug, "own"), campaignIds: ids.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST).join(",") });
    if (cutoffIso) params.set("startedBefore", startedBeforeParam(cutoffIso));
    const res = await fetchWithRetry(runsCostsUrl(base, "public", pricing, params), { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error(`runs-service research leg spend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { groups?: CostGroup[] };
    if (!Array.isArray(body.groups)) throw new Error("runs-service research leg spend: no groups array");
    for (const g of body.groups) {
      if (!g.dimensions.workflowSlug || g.dimensions.workflowSlug === "__total__") continue;
      total += Number(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred")) / 100;
    }
  }
  return total;
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

/**
 * The brands that REPORT their meetings (any live meeting row lead-service attributes), each with the meetings booked
 * after a positive reply to our outreach, by month, and what it was charged on cold email and meeting booking, by month.
 * Null when either read fails (logged): the study says so.
 */
export async function readReportingBrands(): Promise<ReportingBrand[] | null> {
  try {
    const res = await fetchWithRetry(`${process.env.LEAD_SERVICE_URL}/internal/meeting-attribution`, { headers: { "x-api-key": process.env.LEAD_SERVICE_API_KEY ?? "" } }, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`lead-service /internal/meeting-attribution ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { attributedMeetings?: Array<{ conversionEventId: string; brandId: string; event: string; occurredAt: string | null; positiveReply: unknown }> };
    if (!Array.isArray(body.attributedMeetings)) throw new Error("lead-service meeting-attribution: no attributedMeetings");
    // WHO a meeting figure is measured on is ONE rule (`lib/meeting-population.ts`, MEETING-POPULATION-1018).
    const reporting = meetingReportingOf(body);
    rememberMeetingReporting(reporting);
    const brands = new Map<string, ReportingBrand>(reporting.reportingBrandIds.map((id) => [id, { brandId: id, meetingsByMonth: {}, spendByMonth: {} }]));
    const seen = new Set<string>();
    for (const m of body.attributedMeetings) {
      const b = brands.get(m.brandId);
      if (!b) continue;
      if (m.event !== "meeting_booked" || !m.positiveReply || !m.occurredAt || seen.has(m.conversionEventId)) continue;
      seen.add(m.conversionEventId);
      const ym = m.occurredAt.slice(0, 7);
      b.meetingsByMonth[ym] = (b.meetingsByMonth[ym] ?? 0) + 1;
    }
    await mapWithConcurrency([...brands.values()], 2, async (b) => {
      const q = new URLSearchParams({ interval: "month", brandId: b.brandId, featureSlugs: "sales-cold-email-outreach,ai-meeting-booking" });
      const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs/timeseries?${q}`, { headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" } });
      if (!r.ok) throw new Error(`runs-service brand spend timeseries ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const t = (await r.json()) as { buckets?: Array<{ period: string } & Record<string, unknown>> };
      for (const k of t.buckets ?? []) {
        const usd = Number(selectCostCentsString(k, "totalCostInUsdCents", "gross", "incurred")) / 100;
        b.spendByMonth[k.period.slice(0, 7)] = (b.spendByMonth[k.period.slice(0, 7)] ?? 0) + usd;
      }
    });
    return [...brands.values()];
  } catch (err) {
    console.error("[features-service] research meeting-cost inputs unreadable, its study states it:", err);
    return null;
  }
}

/**
 * The last execute-workflow runs of every workflow on a leg (the catalogue's "last runs"), newest first, with what each
 * run's whole subtree cost as billed (null on the vendor basis: the run list states no vendor cost). One read per org
 * (runs-service lists runs per org), 200 newest runs of the org's leg campaigns; an org that cannot be read lists none.
 */
export async function readWorkflowRuns(campaigns: ReadonlyArray<{ campaignId: string; orgId: string }>, dynastyOf: (slug: string) => string, basis: "user" | "actual"): Promise<WorkflowRun[]> {
  const byOrg = new Map<string, string[]>();
  for (const c of campaigns) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c.campaignId]);
  const out: WorkflowRun[] = [];
  await mapWithConcurrency([...byOrg], 3, async ([orgId, ids]) => {
    try {
      const q = new URLSearchParams({ campaignIds: [...new Set(ids)].slice(0, 500).join(","), taskName: "execute-workflow", limit: "200", include: "subtreeCost" });
      const res = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/v1/runs?${q}`, { headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "x-org-id": orgId } });
      if (!res.ok) throw new Error(`runs-service /v1/runs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { runs?: Array<{ workflowSlug: string | null; status: string; startedAt: string; completedAt: string | null; totalCostInUsdCents?: string }> };
      for (const r of body.runs ?? []) {
        if (!r.workflowSlug) continue;
        out.push({ workflowSlug: r.workflowSlug, dynasty: dynastyOf(r.workflowSlug), status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, costUsd: basis === "user" && r.totalCostInUsdCents ? Number(r.totalCostInUsdCents) / 100 : null });
      }
    } catch (err) {
      console.error(`[features-service] research catalogue: last runs of org ${orgId} unreadable, listed none:`, err);
    }
  });
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** The 10 newest sequences of every template and of every model on a leg's campaigns (our copy of content-generation's feed). */
export async function readGenerationRuns(campaignIds: readonly string[]): Promise<GenerationRun[]> {
  if (!campaignIds.length) return [];
  const rows = await pg<Array<{ created_at: Date; model: string; prompt_type: string | null; workflow_slug: string | null }>>`
    SELECT DISTINCT generation_id, created_at, model, prompt_type, workflow_slug FROM (
      SELECT g.*, row_number() OVER (PARTITION BY prompt_type ORDER BY created_at DESC) AS rt, row_number() OVER (PARTITION BY model ORDER BY created_at DESC) AS rm
      FROM generation_sequence_copy g WHERE campaign_id = ANY(${pg.array([...campaignIds])})
    ) x WHERE rt <= 10 OR rm <= 10
  `;
  return rows
    .map((r) => ({ createdAt: new Date(r.created_at).toISOString(), model: r.model, promptType: r.prompt_type, workflowSlug: r.workflow_slug }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * The page-wide counts the Research hub prints (the snapshot's `volume` + `maturation.excludedEmails`): every email sent
 * on the two cold email legs since inception (our copy of the outreach facts), the clients they were sent for, the emails
 * our own sender sent on the website-visit leg (the ones a visit can come from), per month; and the emails of sequences
 * first written on or after their leg's cutoff (too young to count yet).
 */
export async function readVolume(
  reply: { campaignIds: readonly string[]; cutoffIso: string | null },
  visit: { campaignIds: readonly string[]; cutoffIso: string | null },
): Promise<{ emails: number; orgs: number; linkedEmails: number; byMonth: Array<{ month: string; emails: number }>; excludedEmails: number }> {
  const all = [...new Set([...reply.campaignIds, ...visit.campaignIds])];
  if (!all.length) return { emails: 0, orgs: 0, linkedEmails: 0, byMonth: [], excludedEmails: 0 };
  const far = "9999-12-31T00:00:00Z";
  const rows = await pg<Array<{ month: string; emails: string; linked: string; excluded: string; orgs: string }>>`
    WITH s AS (
      SELECT instantly_campaign_id AS t, lead_email AS e, campaign_id, org_id, occurred_at, transport
      FROM outreach_fact_copy WHERE type = 'email_sent' AND NOT withdrawn AND campaign_id = ANY(string_to_array(${(all).join(',')}, ','))
    ), th AS (SELECT t, e, min(occurred_at) AS first_at FROM s GROUP BY 1, 2)
    SELECT to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*) AS emails,
           count(*) FILTER (WHERE s.transport = 'smtp' AND s.campaign_id = ANY(string_to_array(${([...visit.campaignIds, ""]).join(',')}, ','))) AS linked,
           count(*) FILTER (WHERE
             (s.campaign_id = ANY(string_to_array(${([...reply.campaignIds, ""]).join(',')}, ',')) AND th.first_at >= ${reply.cutoffIso ?? far}::timestamptz)
             OR (s.campaign_id = ANY(string_to_array(${([...visit.campaignIds, ""]).join(',')}, ',')) AND th.first_at >= ${visit.cutoffIso ?? far}::timestamptz)) AS excluded,
           count(DISTINCT s.org_id) AS orgs
    FROM s JOIN th ON th.t = s.t AND th.e = s.e GROUP BY 1 ORDER BY 1
  `;
  const orgs = await pg<Array<{ n: string }>>`
    SELECT count(DISTINCT org_id) AS n FROM outreach_fact_copy WHERE type = 'email_sent' AND NOT withdrawn AND campaign_id = ANY(string_to_array(${(all).join(',')}, ','))
  `;
  return {
    emails: rows.reduce((a, r) => a + Number(r.emails), 0),
    orgs: Number(orgs[0]?.n ?? 0),
    linkedEmails: rows.reduce((a, r) => a + Number(r.linked), 0),
    byMonth: rows.map((r) => ({ month: r.month, emails: Number(r.emails) })),
    excludedEmails: rows.reduce((a, r) => a + Number(r.excluded), 0),
  };
}
