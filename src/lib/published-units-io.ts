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
import { servedCachedWrappedJson, buildScopeKey, type SnapshotJson } from "./view-cache.js";
import { routeResponseShapeFingerprint } from "./response-shape.js";
import { mapWithConcurrency } from "./concurrency.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { fetchBrandLegEconomics } from "./brand-leg-economics-client.js";
import { offerLifetimeRevenue } from "./offer-lifetime-revenue.js";
import { outcomeCatalogueFigures, type OutcomeCatalogueFigures } from "./published-unit-value.js";
import { fetchSalesFunnelCampaigns } from "./sales-funnel-campaigns-client.js";
import { legMaturity } from "./maturity.js";
import type { CatalogueModel } from "./agent-catalogue.js";
import {
  addInputCosts,
  expectedReturnOf,
  type ExpectedReturn,
  type UnitValue,
  bulkVisitCredits,
  runAggregateOf,
  type RunAggregate,
  creditOfRow,
  creditsByOccurrence,
  engagementsOf,
  publishedUnitsOf,
  type LedgerOccurrence,
  type PublishedOutcomeKey,
  type PublishedUnitsBody,
  type PublishedAccountingInputs,
  type UnitSource,
  type StoredBulkRun,
  BULK_RUN_COST_SAMPLE_ROWS,
  bulkRunCostKeyOf,
  bulkRunRebuildReason,
} from "./published-units.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

/**
 * A producer this page reads answered an error (SOCIAL-OUTCOMES-1107: newsletter_email_sent read a bare "Failed to read"
 * while runs-service answered 500). The route serves its name, path and status so the page says WHO is down.
 */
export class PublishedUnitsProducerError extends Error {
  constructor(
    public readonly producer: string,
    public readonly path: string,
    public readonly status: number | null,
    public readonly detail: string,
  ) {
    super(`${producer} ${path} ${status ?? "unreachable"}: ${detail}`);
    this.name = "PublishedUnitsProducerError";
  }
}

async function getJson(service: string, base: string, key: string, path: string): Promise<unknown> {
  const route = path.split("?")[0]!;
  let res: Response;
  try {
    res = await fetchWithRetry(`${env(base)}${path}`, { headers: { "x-api-key": env(key) } }, { timeoutMs: 120_000 });
  } catch (err) {
    throw new PublishedUnitsProducerError(service, route, null, (err as Error).message.slice(0, 300));
  }
  if (!res.ok) throw new PublishedUnitsProducerError(service, route, res.status, (await res.text()).slice(0, 300));
  return res.json();
}

const runsGet = (path: string) => getJson("runs-service", "RUNS_SERVICE_URL", "RUNS_SERVICE_API_KEY", path);
const socialGet = (path: string) => getJson("social-service", "SOCIAL_SERVICE_URL", "SOCIAL_SERVICE_API_KEY", path);
const metaGet = (path: string) => getJson("meta-service", "META_SERVICE_URL", "META_SERVICE_API_KEY", path);
const newsletterGet = (path: string) => getJson("transactional-email-service", "TRANSACTIONAL_EMAIL_SERVICE_URL", "TRANSACTIONAL_EMAIL_SERVICE_API_KEY", path);

interface ServedOccurrence extends LedgerOccurrence {
  tags?: { brandIds?: string[]; campaignId?: string | null } | null;
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
      metrics: m?.metrics ?? null,
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
  /** social-service's vocabulary `post | quote | repost | comment`; absent = a post (SOCIAL-OUTCOMES-1107). */
  kind?: string | null;
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
      metrics: p.metrics,
      kind: p.kind ?? null,
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
  unitsDeclared: number;
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
      ledger: r.unitsRunId ? { runId: r.unitsRunId, outcomeKey: "newsletter_email_sent", subjectId: null, bulkFingerprint: String(r.unitsDeclared) } : null,
    }));
}

const ROWS: Record<PublishedOutcomeKey, (orgId: string, brandId: string) => Promise<UnitSource[]>> = {
  threads_post_published: threadsRows,
  x_post_published: xRows,
  linkedin_post_published: linkedinRows,
  newsletter_email_sent: newsletterRows,
};

// ---------------------------------------------------------------- bulk runs (a newsletter release: one run, ~20k Units)

/**
 * A bulk run's total, kept in `feature_view_snapshots` (view `published-unit-run`, derived and rebuildable) with the
 * fingerprint it was built at. Reading a release's Units off the ledger takes minutes (88k Units took 132 s then
 * 411 s, 2026-11-06), so it is built once per fingerprint by the sweep below and by a read that finds it missing,
 * never on every open. The fingerprint is the producer's count of Units declared AND the ledger's money on a sample of
 * the run's rows (NEWSLETTER-COST-1107-FEATURES, `bulkRunRebuildReason`): a re-price in runs-service rebuilds it.
 */
const RUN_VIEW = "published-unit-run";

async function loadRunAggregate(scopeKey: string): Promise<StoredBulkRun | null> {
  try {
    const [row] = await db
      .select({ bodyText: featureViewSnapshots.bodyText })
      .from(featureViewSnapshots)
      .where(and(eq(featureViewSnapshots.view, RUN_VIEW), eq(featureViewSnapshots.scopeKey, scopeKey)))
      .limit(1);
    if (!row || typeof row.bodyText !== "string") return null;
    return JSON.parse(row.bodyText) as StoredBulkRun;
  } catch (err) {
    console.error(`[features-service] published unit run store read failed (${scopeKey}), building it now:`, err);
    return null;
  }
}

async function storeRunAggregate(scopeKey: string, orgId: string, value: StoredBulkRun): Promise<void> {
  const text = JSON.stringify(value);
  const now = new Date();
  try {
    await db
      .insert(featureViewSnapshots)
      .values({ view: RUN_VIEW, scopeKey, orgId, body: { storedAs: "body_text" }, bodyText: text, computedAt: now, lastReadAt: now })
      .onConflictDoUpdate({ target: [featureViewSnapshots.view, featureViewSnapshots.scopeKey], set: { bodyText: text, computedAt: now, lastReadAt: now } });
  } catch (err) {
    console.error(`[features-service] published unit run store write failed (${scopeKey}):`, err);
  }
}

/**
 * The ledger money key of a bulk run: its first `BULK_RUN_COST_SAMPLE_ROWS` produced and consumed occurrences (one page
 * each, ~2 s; a 1000-row consumed page took 17-31 s in prod). Null when unreadable (logged): the stored total is kept.
 */
async function bulkRunCostKey(runId: string, outcomeKey: string): Promise<string | null> {
  try {
    const page = async (params: Record<string, string>) => {
      const q = new URLSearchParams({ runIds: runId, ...params, limit: String(BULK_RUN_COST_SAMPLE_ROWS) });
      const body = (await runsGet(`/internal/outcome-occurrences?${q}`)) as { occurrences?: ServedOccurrence[] };
      if (!Array.isArray(body.occurrences)) throw new Error("runs-service outcome-occurrences: no occurrences array");
      return body.occurrences;
    };
    const [produced, consumed] = await Promise.all([page({ outcomeKey, direction: "produced" }), page({ direction: "consumed" })]);
    return bulkRunCostKeyOf(outcomeKey, produced, consumed);
  } catch (err) {
    console.error(`[features-service] published unit run ${runId}|${outcomeKey}: ledger money key unreadable, stored total kept: ${(err as Error).message}`);
    return null;
  }
}

const runBuilds = new Map<string, Promise<RunAggregate>>();

/**
 * The bulk run's total: stored, else built from the ledger (one build in flight per run). A page read
 * (`waitForFresh: false`) never waits on a rebuild once a total is stored: a release still declaring its Units moves its
 * fingerprint every minute, and a rebuild is minutes; it serves the stored total and the rebuild runs behind (the sweep,
 * which also checks the ledger money, catches it within 10 minutes). Only a run never built is built on the read.
 */
export async function bulkRunAggregate(orgId: string, runId: string, outcomeKey: string, fingerprint: string, opts: { waitForFresh?: boolean; costKey?: string | null } = {}): Promise<RunAggregate> {
  const scopeKey = `${runId}|${outcomeKey}`;
  const stored = await loadRunAggregate(scopeKey);
  const reason = bulkRunRebuildReason(stored, { fingerprint, costKey: opts.costKey ?? null }, Date.now());
  if (stored && reason === null) return stored.agg;
  if (stored && opts.waitForFresh === false) {
    if (!runBuilds.has(scopeKey)) void buildRunAggregate(orgId, runId, outcomeKey, fingerprint, scopeKey).catch((err: Error) => console.error(`[features-service] published unit run ${scopeKey}: background rebuild failed: ${err.message}`));
    return stored.agg;
  }
  if (stored) console.log(`[features-service] published unit run ${scopeKey}: rebuilding (${reason})`);
  return buildRunAggregate(orgId, runId, outcomeKey, fingerprint, scopeKey, opts.costKey);
}

function buildRunAggregate(orgId: string, runId: string, outcomeKey: string, fingerprint: string, scopeKey: string, knownCostKey?: string | null): Promise<RunAggregate> {
  let build = runBuilds.get(scopeKey);
  if (!build) {
    build = (async () => {
      // The money key is read BEFORE the rows: a re-price landing during the build moves the next key, never hides.
      const costKey = knownCostKey ?? (await bulkRunCostKey(runId, outcomeKey));
      const [produced, consumed] = await Promise.all([occurrences({ runIds: runId, outcomeKey, direction: "produced" }), occurrences({ runIds: runId, direction: "consumed" })]);
      const agg = runAggregateOf(outcomeKey, produced, consumed);
      await storeRunAggregate(scopeKey, orgId, { fingerprint, costKey, builtAt: new Date().toISOString(), agg });
      return agg;
    })().finally(() => runBuilds.delete(scopeKey));
    runBuilds.set(scopeKey, build);
  }
  return build;
}

/**
 * Every newsletter release of the fleet with Units gets its run total built ahead of any page (every brand, every
 * org): a minute after boot, then every 10 minutes, one run at a time; a run whose Units count and ledger money key
 * have not moved (and built within the ceiling) is not read again.
 */
export async function sweepBulkRuns(): Promise<{ checked: number }> {
  const body = (await newsletterGet("/internal/mailing-list-releases")) as { releases?: Release[] };
  if (!Array.isArray(body.releases)) throw new Error("transactional-email-service mailing-list-releases: no releases array");
  const runs = body.releases.filter((r) => r.unitsRunId && r.emailsSent > 0);
  for (const r of runs) {
    const costKey = await bulkRunCostKey(r.unitsRunId!, "newsletter_email_sent");
    await bulkRunAggregate(r.orgId, r.unitsRunId!, "newsletter_email_sent", String(r.unitsDeclared), { costKey });
  }
  return { checked: runs.length };
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startBulkRunSweep(): void {
  if (sweepTimer) return;
  const tick = () =>
    void sweepBulkRuns().catch((err: Error) => console.error(`[features-service] published unit run sweep failed: ${err.message}`));
  setTimeout(tick, 60_000).unref?.();
  sweepTimer = setInterval(tick, 10 * 60_000);
  sweepTimer.unref?.();
}

// ---------------------------------------------------------------- the ledger

async function ledgerOf(orgId: string, sources: readonly UnitSource[], pricing: "gross" | "net") {
  const handles = sources.flatMap((s) => (s.ledger ? [s.ledger] : []));
  const single = handles.filter((h) => h.bulkFingerprint === undefined);
  const bulk = handles.filter((h) => h.bulkFingerprint !== undefined);
  const byKey = new Map<string, string[]>();
  for (const h of single) byKey.set(h.outcomeKey, [...(byKey.get(h.outcomeKey) ?? []), h.runId]);
  const keys = [...new Set(handles.map((h) => h.outcomeKey))];
  const singleRuns = [...new Set(single.map((h) => h.runId))];
  const [units, consumedOnRuns, bulkAggs, unitConsumptions] = await Promise.all([
    // One-Unit runs (a post each) are read 500 runs per call: one call per run took 42 s for 38 Threads posts on a loaded box.
    Promise.all([...byKey].map(([outcomeKey, runIds]) => occurrencesOver(runIds, "runIds", { outcomeKey, direction: "produced" }))).then((x) => x.flat()),
    // What each Unit's production order consumed (its inputs' cost: full absorption).
    occurrencesOver(singleRuns, "runIds", { direction: "consumed" }),
    Promise.all(bulk.map((h) => bulkRunAggregate(orgId, h.runId, h.outcomeKey, h.bulkFingerprint!, { waitForFresh: false }).then((agg) => [h.runId, agg] as const))).then((x) => new Map(x)),
    // What consumed the Units: every consumption of the outcome in the org (a click is rare: far fewer rows than the Units).
    handles.length ? Promise.all(keys.map((outcomeKey) => occurrences({ orgId, outcomeKey, direction: "consumed" }))).then((x) => x.flat()) : Promise.resolve([] as ServedOccurrence[]),
  ]);
  const visitRuns = [...new Set(unitConsumptions.filter((c) => (c.consumption?.consumingOutcomes ?? []).some((p) => p.outcomeKey === "website_visit")).map((c) => c.runId))];
  const visitsProduced = await occurrencesOver(visitRuns, "runIds", { outcomeKey: "website_visit", direction: "produced" });
  const bySvc = new Map<string, string[]>();
  for (const v of visitsProduced) bySvc.set(v.subjectService, [...(bySvc.get(v.subjectService) ?? []), v.subjectId]);
  const visitConsumptions = (
    await Promise.all([...bySvc].map(([svc, ids]) => occurrencesOver(ids, "subjectIds", { subjectService: svc, outcomeKey: "website_visit", direction: "consumed" })))
  ).flat();
  const credits = creditsByOccurrence(units, unitConsumptions, visitsProduced, visitConsumptions, pricing);
  addInputCosts(credits, units, consumedOnRuns, pricing);
  const bulkVisits = bulkVisitCredits(new Set(bulk.map((h) => h.runId)), unitConsumptions, visitsProduced, visitConsumptions);
  const unitsByRun = new Map<string, ServedOccurrence[]>();
  for (const u of units) unitsByRun.set(u.runId, [...(unitsByRun.get(u.runId) ?? []), u]);
  // Visits are attributed only where the org's ledger ever credited one to a Unit of the outcome (a tracked link click):
  // none = the outcome carries no click signal, so visits read null with a reason, never a measured 0 (SOCIAL-OUTCOMES-1107).
  const visitsMeasured = unitConsumptions.some((c) => c.direction === "consumed" && (c.consumption?.consumingOutcomes ?? []).some((p) => p.outcomeKey === "website_visit"));
  const campaignOf = (src: UnitSource): string | null => {
    if (!src.ledger) return null;
    const onRun = (unitsByRun.get(src.ledger.runId) ?? []).filter((o) => o.outcomeKey === src.ledger!.outcomeKey);
    const own = src.ledger.subjectId ? onRun.filter((o) => o.subjectId === src.ledger!.subjectId) : [];
    const tagged = (own.length ? own : onRun).find((o) => typeof o.tags?.campaignId === "string" && o.tags.campaignId);
    return tagged?.tags?.campaignId ?? null;
  };
  const creditOf = (src: UnitSource) => {
    if (src.ledger?.bulkFingerprint !== undefined) {
      const agg = bulkAggs.get(src.ledger.runId)!;
      const v = bulkVisits.get(src.ledger.runId) ?? { visits: 0, signups: 0 };
      return { spentUsd: pricing === "net" ? agg.netUsd : agg.grossUsd, visits: v.visits, signups: v.signups };
    }
    return creditOfRow(src, unitsByRun, credits);
  };
  return { creditOf, visitsMeasured, campaignOf };
}

/** The brand's Units of one published outcome, computed now. */
export async function computePublishedUnits(orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, pricing: "gross" | "net"): Promise<PublishedUnitsBody> {
  const sources = await ROWS[outcomeKey](orgId, brandId);
  const { creditOf, visitsMeasured, campaignOf } = await ledgerOf(orgId, sources, pricing);
  const withCampaigns = sources.map((s) => ({ ...s, campaignId: campaignOf(s) }));
  const [valuation, targets] = await Promise.all([valuationOf(orgId, brandId, outcomeKey, withCampaigns), targetCampaignsOf(orgId, brandId, outcomeKey)]);
  const accounting: PublishedAccountingInputs | undefined = valuation.page
    ? {
        figures: valuation.page.figures.figures,
        step: valuation.page.figures.step,
        lifetimeRevenueUsd: valuation.page.ltrUsd,
        lifetimeRevenueSource: valuation.page.source,
        expectedCostSource: valuation.page.figures.cost?.costSource ?? null,
        targets: targets.filter((t) => t.target === outcomeKey || (valuation.page!.figures.step !== null && t.target === valuation.page!.figures.step)),
        windowDays: valuation.page.figures.figures.next?.legKey ? legMaturity(valuation.page.figures.figures.next.legKey).durationDays : 0,
        today: new Date().toISOString().slice(0, 10),
      }
    : undefined;
  return publishedUnitsOf(outcomeKey, withCampaigns, creditOf, { unitValueOf: valuation.valueOf, expected: valuation.expected, visitsMeasured, accounting });
}

/**
 * The brand's funnel campaigns (any status) with the step each targets (campaign-service's `target`, else its funnel's
 * last step) and the unit campaign ids its runs are tagged with: the outcome is a Target only when one names it.
 * Unreadable = no target known, logged loud (the report then says `outcome_is_no_campaign_target`, never a 502).
 */
async function targetCampaignsOf(orgId: string, brandId: string, outcomeKey: string): Promise<Array<{ campaignId: string; target: string | null; unitCampaignIds: string[] }>> {
  try {
    const rows = await fetchSalesFunnelCampaigns(brandId, null, { orgId });
    return rows.map((r) => ({ campaignId: r.id, target: r.target ?? null, unitCampaignIds: r.units.map((u) => u.campaignId) }));
  } catch (err) {
    console.error(`[features-service] published units ${brandId} ${outcomeKey}: funnel campaigns unreadable, no Target known: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------- value (SOCIAL-OUTCOMES-1107)

/** Test seam: the catalogue model on a lifetime revenue (the shadow plan's model). */
let loadModel: (ltr: number | null, source: "offer_stated" | "fleet_median" | null) => Promise<CatalogueModel> = async (ltr, source) =>
  (await import("../routes/agent-catalogue.js")).loadCatalogueModelForLifetimeRevenue(ltr, source);
export function __setPublishedUnitsModelLoader(f: typeof loadModel): void {
  loadModel = f;
}

/**
 * Each Unit valued on the offer of the campaign that produced it (its lifetime revenue, stated else the fleet median:
 * every offer has one); a Unit naming no campaign stating an offer (a hand post, a newsletter) on the fleet median. The
 * page's expected return reads the offer most of OURS Units were valued on, else the fleet median. A read that fails
 * leaves the value null with `value_unreadable` (logged loud), never a 502 of the page and never a guessed value.
 */
interface PageValuation {
  valueOf: (s: UnitSource) => UnitValue;
  expected: ExpectedReturn;
  /** The page's figures (the offer most of OURS Units were valued on, else the fleet median), for the report. */
  page: { figures: OutcomeCatalogueFigures; ltrUsd: number | null; source: "offer_stated" | "fleet_median" | null } | null;
}

async function valuationOf(orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, sources: readonly UnitSource[]): Promise<PageValuation> {
  const unreadable: UnitValue = { valuePerUnitUsd: null, step: null, offerId: null, lifetimeRevenueSource: null, unavailableReason: "value_unreadable" };
  try {
    const needsOffers = sources.some((s) => s.campaignId);
    const [campaigns, econ] = needsOffers
      ? await Promise.all([fetchBrandCampaignRows(brandId, undefined, { orgId }), fetchBrandLegEconomics(brandId, orgId)])
      : [[], { offers: [] as Array<{ offerId: string; lifetimeRevenueUsd: number | null }> }];
    const offerOfCampaign = new Map(campaigns.map((c) => [c.id, c.offerId ?? null] as const));
    const offers = new Map(econ.offers.map((o) => [o.offerId, o.lifetimeRevenueUsd] as const));
    const offerOf = (s: UnitSource): string | null => {
      const o = s.campaignId ? (offerOfCampaign.get(s.campaignId) ?? null) : null;
      return o && offers.has(o) ? o : null;
    };
    const figuresByOffer = new Map<string, Promise<{ figures: OutcomeCatalogueFigures; source: "offer_stated" | "fleet_median" | null; ltrUsd: number | null }>>();
    const figuresFor = (offerId: string | null) => {
      const key = offerId ?? "";
      if (!figuresByOffer.has(key))
        figuresByOffer.set(
          key,
          offerLifetimeRevenue(offerId ? offers.get(offerId) : null).then(async (ltr) => ({ figures: outcomeCatalogueFigures(await loadModel(ltr.usd, ltr.source), outcomeKey), source: ltr.source, ltrUsd: ltr.usd })),
        );
      return figuresByOffer.get(key)!;
    };
    const offerIds = [...new Set(sources.map(offerOf))];
    const resolved = new Map(await Promise.all(offerIds.map(async (o) => [o ?? "", { offerId: o, ...(await figuresFor(o)) }] as const)));
    const valueOf = (s: UnitSource): UnitValue => {
      const r = resolved.get(offerOf(s) ?? "")!;
      return { valuePerUnitUsd: r.figures.valuePerUnitUsd, step: r.figures.step, offerId: r.offerId, lifetimeRevenueSource: r.source, unavailableReason: r.figures.unavailableReason };
    };
    const oursByOffer = new Map<string, number>();
    for (const s of sources) if (s.performedBy === "ours") oursByOffer.set(offerOf(s) ?? "", (oursByOffer.get(offerOf(s) ?? "") ?? 0) + s.units);
    const top = [...oursByOffer].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
    const pageFigures = resolved.get(top) ?? { offerId: null, ...(await figuresFor(null)) };
    return {
      valueOf,
      expected: expectedReturnOf(pageFigures.figures.valuePerUnitUsd, pageFigures.figures.cost, pageFigures.figures.unavailableReason),
      page: { figures: pageFigures.figures, ltrUsd: pageFigures.ltrUsd, source: pageFigures.source },
    };
  } catch (err) {
    console.error(`[features-service] published units ${brandId} ${outcomeKey}: value unreadable, served null: ${(err as Error).message}`);
    return { valueOf: () => unreadable, expected: expectedReturnOf(null, null, "value_unreadable"), page: null };
  }
}

/**
 * ONE GOLD CELL per (org, brand, outcome, pricing) (MON-PAGE-SPEED-1111): a newsletter release is tens of thousands of
 * Units, read off the ledger page by page. It used to be held in the SERVING process's memory and re-read there every
 * 10 minutes: every deploy or restart emptied it, so the first read after one waited the whole ledger (6.6 s on our
 * Threads page, prod 2026-11-11) and every re-read ran on the serving event loop. The Gold layer persists it across
 * deploys, computes it in the refresher and serves it at once whatever its age, re-read behind the answer at most every
 * {@link FRESH_MS} and only when the brand's facts moved (`lib/view-cache.ts`).
 */
const FRESH_MS = 2 * 60_000;

/** The route's whole answer `{ brandId, pricing, ...units }` as the exact text `res.json` sends (wrapped once per stored body). */
export async function readPublishedUnits(orgId: string, brandId: string, outcomeKey: PublishedOutcomeKey, pricing: "gross" | "net"): Promise<SnapshotJson> {
  return servedCachedWrappedJson({
    view: "published-units",
    scopeKey: buildScopeKey(brandId, { orgId, outcomeKey, pricing }),
    orgId,
    ttlMs: FRESH_MS,
    responseShape: routeResponseShapeFingerprint("/brands/{brandId}/published-units/{outcomeKey}"),
    compute: async () => ({ ...(await computePublishedUnits(orgId, brandId, outcomeKey, pricing)), computedAt: new Date().toISOString() }),
  }, { brandId, pricing });
}

/** Test seam (nothing is held in this process any more). */
export function __resetPublishedUnits(): void {}
