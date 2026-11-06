/**
 * THE IO OF THE PUBLISHED UNITS READ (OUTCOME-FINEST-1106; pure rule `lib/published-units.ts`). Hard-coded per outcome
 * (owner 2026-11-06): each outcome's rows come from the service that holds its creatives, service key only, filtered on
 * the org + brand each row states; the ledger figures from runs-service.
 *   - threads_post_published: meta-service `GET /internal/threads/measurable-posts` (every Threads MAIN post of the brand,
 *     ours and imported hand posts; the outcome each one declares is its own `outcomeKey`), views/engagement from
 *     social-service `GET /internal/post-metrics`;
 *   - x_post_published / linkedin_post_published: social-service `GET /internal/account-posts` (every post of the
 *     brand's connected X / LinkedIn accounts, hand posts included, with their counts);
 *   - newsletter_email_sent: transactional-email-service `GET /internal/mailing-list-releases` (one row per release, its
 *     emails sent = its Units; a release stating no brand is the org's newsletter and lists on each of its brands).
 *   - the ledger: runs-service `GET /internal/outcome-occurrences` (each row's produced Units with their cost, the visits
 *     consuming them, the signups consuming those visits).
 * Any read failing throws (fail loud, never a silent zero).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  addInputCosts,
  creditOfRow,
  creditsByOccurrence,
  engagementsOf,
  publishedUnitsOf,
  type LedgerOccurrence,
  type PublishedOutcomeKey,
  type PublishedUnitsBody,
  type UnitSource,
} from "./published-units.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

async function getJson(service: string, base: string, key: string, path: string): Promise<unknown> {
  const res = await fetchWithRetry(`${env(base)}${path}`, { headers: { "x-api-key": env(key) } }, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`${service} ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const runsGet = (path: string) => getJson("runs-service", "RUNS_SERVICE_URL", "RUNS_SERVICE_API_KEY", path);
const socialGet = (path: string) => getJson("social-service", "SOCIAL_SERVICE_URL", "SOCIAL_SERVICE_API_KEY", path);
const metaGet = (path: string) => getJson("meta-service", "META_SERVICE_URL", "META_SERVICE_API_KEY", path);
const newsletterGet = (path: string) => getJson("transactional-email-service", "TRANSACTIONAL_EMAIL_SERVICE_URL", "TRANSACTIONAL_EMAIL_SERVICE_API_KEY", path);

interface ServedOccurrence extends LedgerOccurrence {
  tags?: { brandIds?: string[] } | null;
  declaredAt?: string;
  performer?: { kind?: string | null } | null;
}

/** Every occurrence matching `params`, all pages. */
async function occurrences(params: Record<string, string>): Promise<ServedOccurrence[]> {
  const out: ServedOccurrence[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 2000; page++) {
    const q = new URLSearchParams({ ...params, limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const body = (await runsGet(`/internal/outcome-occurrences?${q}`)) as { occurrences?: ServedOccurrence[]; nextCursor?: string | null };
    if (!Array.isArray(body.occurrences)) throw new Error("runs-service outcome-occurrences: no occurrences array");
    out.push(...body.occurrences);
    if (!body.nextCursor || body.nextCursor === cursor) break;
    cursor = body.nextCursor;
  }
  return out;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Every occurrence on each of these runs, one paged read per run, 6 runs at a time: a newsletter release run holds tens of
 * thousands of Units, read one after the other they took 132 s (2026-11-06); in parallel a fraction of it.
 */
async function occurrencesOnRuns(runIds: readonly string[], params: Record<string, string>): Promise<ServedOccurrence[]> {
  const parts = await mapWithConcurrency([...new Set(runIds)], 6, (runId) => occurrences({ ...params, runIds: runId }));
  return parts.flat();
}

async function occurrencesOver(ids: readonly string[], idParam: "runIds" | "subjectIds", params: Record<string, string>): Promise<ServedOccurrence[]> {
  if (ids.length === 0) return [];
  const parts = await mapWithConcurrency(chunks([...new Set(ids)], 500), 4, (c) => occurrences({ ...params, [idParam]: c.join(",") }));
  return parts.flat();
}

// ---------------------------------------------------------------- rows per outcome

const ENGAGEMENT_COUNTS = ["likes", "replies", "reposts", "quotes"] as const;

interface ThreadsPost {
  id: string;
  orgId: string;
  brandId: string;
  accountUsername: string;
  permalink: string | null;
  text: string;
  performedBy: "ours" | "client_team";
  outcomeKey: string;
  outcomeRunId: string;
  publishedAt: string;
}

async function threadsRows(orgId: string, brandId: string): Promise<UnitSource[]> {
  const posts: ThreadsPost[] = [];
  let after: { publishedAt: string; id: string } | null = null;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ since: "2020-01-01T00:00:00.000Z", limit: "1000" });
    if (after) {
      q.set("afterPublishedAt", after.publishedAt);
      q.set("afterId", after.id);
    }
    const body = (await metaGet(`/internal/threads/measurable-posts?${q}`)) as { posts?: ThreadsPost[] };
    if (!Array.isArray(body.posts)) throw new Error("meta-service measurable-posts: no posts array");
    posts.push(...body.posts);
    if (body.posts.length < 1000) break;
    const last = body.posts[body.posts.length - 1]!;
    after = { publishedAt: last.publishedAt, id: last.id };
  }
  const own = posts.filter((p) => p.orgId === orgId && p.brandId === brandId);
  const metrics = (await socialGet(`/internal/post-metrics?${new URLSearchParams({ brandId, subjectService: "meta-service", limit: "500" })}`)) as {
    posts?: Array<{ subjectId: string; publishRunId: string; metrics?: Record<string, number | null>; engagement?: number | null }>;
  };
  if (!Array.isArray(metrics.posts)) throw new Error("social-service post-metrics: no posts array");
  if (metrics.posts.length >= 500) console.error(`[features-service] published units: social-service post-metrics answered its 500-post cap for brand ${brandId}, older Threads posts read no views`);
  const bySubject = new Map(metrics.posts.map((m) => [m.subjectId, m] as const));
  return own.map((p) => {
    const m = bySubject.get(p.id);
    return {
      id: p.id,
      publishedAt: p.publishedAt,
      account: p.accountUsername,
      performedBy: p.performedBy,
      text: p.text,
      url: p.permalink,
      units: 1,
      views: m?.metrics?.views ?? null,
      engagements: m ? (m.engagement ?? null) : null,
      ledger: { runId: p.outcomeRunId, outcomeKey: p.outcomeKey, subjectId: p.id },
    };
  });
}

interface AccountPost {
  id: string;
  platform: string;
  orgId: string;
  brandId: string;
  username: string;
  text: string | null;
  permalink: string | null;
  publishedAt: string;
  performedBy: "ours" | "client_team";
  ourSubjectId: string | null;
  outcomeKey: string;
  unitRunId: string | null;
  metrics: Record<string, number | null>;
}

/** Every post of the brand's connected accounts on one network, hand posts included (social-service account posts). */
async function accountPostRows(orgId: string, brandId: string, platform: "x" | "linkedin"): Promise<UnitSource[]> {
  const body = (await socialGet(`/internal/account-posts?${new URLSearchParams({ orgId, brandId, limit: "500" })}`)) as { posts?: AccountPost[] };
  if (!Array.isArray(body.posts)) throw new Error("social-service account-posts: no posts array");
  if (body.posts.length >= 500) console.error(`[features-service] published units: social-service account-posts answered its 500-post cap for brand ${brandId}, older posts are not listed`);
  return body.posts
    .filter((p) => p.platform === platform && p.orgId === orgId && p.brandId === brandId)
    .map((p) => ({
      id: p.id,
      publishedAt: p.publishedAt,
      account: p.username,
      performedBy: p.performedBy,
      text: p.text,
      url: p.permalink,
      units: 1,
      views: p.metrics.views ?? null,
      engagements: engagementsOf(p.metrics, ENGAGEMENT_COUNTS),
      ledger: p.unitRunId ? { runId: p.unitRunId, outcomeKey: p.outcomeKey, subjectId: p.ourSubjectId ?? p.id } : null,
    }));
}

const xRows = (orgId: string, brandId: string) => accountPostRows(orgId, brandId, "x");
// LINKEDIN-ACCOUNTS-1106 (social-service v0.1.13): a connected LinkedIn account imports its page's whole history.
const linkedinRows = (orgId: string, brandId: string) => accountPostRows(orgId, brandId, "linkedin");

interface Release {
  releaseId: string;
  listSlug: string;
  subject: string | null;
  orgId: string;
  brandIds: string[];
  unitsRunId: string | null;
  emailsSent: number;
  firstSentAt: string | null;
  createdAt: string;
}

async function newsletterRows(orgId: string, brandId: string): Promise<UnitSource[]> {
  const body = (await newsletterGet("/internal/mailing-list-releases")) as { releases?: Release[] };
  if (!Array.isArray(body.releases)) throw new Error("transactional-email-service mailing-list-releases: no releases array");
  return body.releases
    .filter((r) => r.orgId === orgId && (r.brandIds.length === 0 || r.brandIds.includes(brandId)) && r.emailsSent > 0)
    .map((r) => ({
      id: r.releaseId,
      publishedAt: r.firstSentAt ?? r.createdAt,
      account: r.listSlug,
      performedBy: "ours" as const,
      text: r.subject,
      url: null,
      units: r.emailsSent,
      views: null,
      engagements: null,
      ledger: r.unitsRunId ? { runId: r.unitsRunId, outcomeKey: "newsletter_email_sent", subjectId: null } : null,
    }));
}

const ROWS: Record<PublishedOutcomeKey, (orgId: string, brandId: string) => Promise<UnitSource[]>> = {
  threads_post_published: threadsRows,
  x_post_published: xRows,
  linkedin_post_published: linkedinRows,
  newsletter_email_sent: newsletterRows,
};

// ---------------------------------------------------------------- the ledger

async function ledgerOf(orgId: string, sources: readonly UnitSource[], pricing: "gross" | "net") {
  const handles = sources.flatMap((s) => (s.ledger ? [s.ledger] : []));
  const byKey = new Map<string, string[]>();
  for (const h of handles) byKey.set(h.outcomeKey, [...(byKey.get(h.outcomeKey) ?? []), h.runId]);
  const allRuns = [...new Set(handles.map((h) => h.runId))];
  const [units, consumedOnRuns] = await Promise.all([
    Promise.all([...byKey].map(([outcomeKey, runIds]) => occurrencesOnRuns(runIds, { outcomeKey, direction: "produced" }))).then((x) => x.flat()),
    // What each Unit's production order consumed (its inputs' cost: full absorption).
    occurrencesOnRuns(allRuns, { direction: "consumed" }),
  ]);
  // What consumed the Units: every consumption of the outcome in the org (a click is rare: far fewer rows than the Units).
  const unitConsumptions = units.length
    ? (await Promise.all([...byKey.keys()].map((outcomeKey) => occurrences({ orgId, outcomeKey, direction: "consumed" })))).flat()
    : [];
  const visitRuns = [...new Set(unitConsumptions.filter((c) => (c.consumption?.consumingOutcomes ?? []).some((p) => p.outcomeKey === "website_visit")).map((c) => c.runId))];
  const visitsProduced = await occurrencesOver(visitRuns, "runIds", { outcomeKey: "website_visit", direction: "produced" });
  const bySvc = new Map<string, string[]>();
  for (const v of visitsProduced) bySvc.set(v.subjectService, [...(bySvc.get(v.subjectService) ?? []), v.subjectId]);
  const visitConsumptions = (
    await Promise.all([...bySvc].map(([svc, ids]) => occurrencesOver(ids, "subjectIds", { subjectService: svc, outcomeKey: "website_visit", direction: "consumed" })))
  ).flat();
  const credits = creditsByOccurrence(units, unitConsumptions, visitsProduced, visitConsumptions, pricing);
  addInputCosts(credits, units, consumedOnRuns, pricing);
  const unitsByRun = new Map<string, LedgerOccurrence[]>();
  for (const u of units) unitsByRun.set(u.runId, [...(unitsByRun.get(u.runId) ?? []), u]);
  return (src: UnitSource) => creditOfRow(src, unitsByRun, credits);
}

/** The brand's Units of one published outcome, computed now. */
export async function computePublishedUnits(orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, pricing: "gross" | "net"): Promise<PublishedUnitsBody> {
  const sources = await ROWS[outcomeKey](orgId, brandId);
  const creditOf = await ledgerOf(orgId, sources, pricing);
  return publishedUnitsOf(outcomeKey, sources, creditOf);
}

/**
 * Held per (org, brand, outcome, pricing): a newsletter release is tens of thousands of Units, read off the ledger page by
 * page. Fresh for 2 minutes; up to 6 hours old it is served at once and re-read behind the answer; older, the caller
 * waits for the read. A key asked in the last day is re-read every 10 minutes. One read in flight per key.
 */
const FRESH_MS = 2 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
/** A key asked in the last day is re-read every 10 minutes, so a page never waits on a newsletter's whole ledger. */
const WARM_FOR_MS = 24 * 60 * 60_000;
const WARM_EVERY_MS = 10 * 60_000;
const asked = new Map<string, { at: number; args: [string, string, PublishedOutcomeKey, "gross" | "net"] }>();
let warmer: NodeJS.Timeout | null = null;
function keepWarm(key: string, args: [string, string, PublishedOutcomeKey, "gross" | "net"]): void {
  asked.set(key, { at: Date.now(), args });
  if (warmer) return;
  warmer = setInterval(() => {
    for (const [k, a] of asked) {
      if (Date.now() - a.at > WARM_FOR_MS) {
        asked.delete(k);
        continue;
      }
      if (flights.has(k)) continue;
      void readPublishedUnitsNow(k, ...a.args).catch((err: Error) => console.error(`[features-service] published units ${k}: warm re-read failed: ${err.message}`));
    }
  }, WARM_EVERY_MS);
  warmer.unref?.();
}
const held = new Map<string, { at: number; body: PublishedUnitsBody & { computedAt: string } }>();
const flights = new Map<string, Promise<PublishedUnitsBody & { computedAt: string }>>();

function readPublishedUnitsNow(key: string, orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, pricing: "gross" | "net") {
  let f = flights.get(key);
  if (!f) {
    f = computePublishedUnits(orgId, brandId, outcomeKey, pricing)
      .then((body) => {
        const out = { ...body, computedAt: new Date().toISOString() };
        held.set(key, { at: Date.now(), body: out });
        return out;
      })
      .finally(() => flights.delete(key));
    flights.set(key, f);
  }
  return f;
}

export async function readPublishedUnits(orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, pricing: "gross" | "net") {
  const key = `${orgId}|${brandId}|${outcomeKey}|${pricing}`;
  keepWarm(key, [orgId, brandId, outcomeKey, pricing]);
  const start = () => readPublishedUnitsNow(key, orgId, brandId, outcomeKey, pricing);
  const h = held.get(key);
  const age = h ? Date.now() - h.at : Infinity;
  if (h && age < FRESH_MS) return h.body;
  if (h && age < STALE_MS) {
    start().catch((err: Error) => console.error(`[features-service] published units ${key}: background re-read failed: ${err.message}`));
    return h.body;
  }
  return start();
}

/** Test seam. */
export function __resetPublishedUnits(): void {
  held.clear();
  flights.clear();
  asked.clear();
  if (warmer) clearInterval(warmer);
  warmer = null;
}
