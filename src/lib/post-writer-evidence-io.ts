/**
 * THE IO OF A POST PIPE'S WRITER EVIDENCE (THREADS-IDEAS-AB; pure rule `lib/post-writer-evidence.ts`). Every read is a
 * producer's served read, api key only, no identity:
 *   - content-generation-service `GET /internal/thread-generations` (what wrote each post: run, template dynasty, model),
 *     the whole feed, keyset-paged oldest first, held 2 minutes and shared by every pipe;
 *   - runs-service `GET /internal/runs/subtree-costs` (each writing run's whole subtree cost, billed basis) and
 *     `GET /internal/outcome-occurrences` (the run's `post_published`, the `website_visit`s consuming it, the signups
 *     consuming those visits);
 *   - social-service `GET /internal/post-metrics` (each post's latest views and engagement, keyed by its publishing run).
 * Which pipe a generation belongs to = its feature + the leg its workflow DYNASTY is assigned on (`workflow_leg_assignments`),
 * never a slug literal. Any read failing throws: the build keeps its previous answer (fail loud, never a silent zero).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { pipeLegKeyOf } from "./funnel-legs.js";
import { listLegAssignments } from "./workflow-leg-assignments.js";
import type { PostGeneration, RunCredit } from "./post-writer-evidence.js";

export interface FeedGeneration extends PostGeneration {
  orgId: string;
  campaignId: string | null;
  workflowSlug: string | null;
  featureSlug: string | null;
}

const FEED_HELD_MS = 2 * 60_000;
let feedHeld: { at: number; rows: FeedGeneration[] } | null = null;
let feedFlight: Promise<FeedGeneration[]> | null = null;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

/** PURE. One served generation, checked (a malformed row fails the read loud). */
export function generationOf(raw: unknown): FeedGeneration {
  const g = raw as Record<string, unknown>;
  if (typeof g.generationId !== "string" || typeof g.createdAt !== "string" || typeof g.model !== "string" || typeof g.orgId !== "string") {
    throw new Error(`content-generation-service thread-generations: malformed generation ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const t = g.templateDynasty as { slug?: unknown; name?: unknown } | null | undefined;
  return {
    generationId: g.generationId,
    createdAt: g.createdAt,
    runId: typeof g.runId === "string" && g.runId ? g.runId : null,
    templateDynasty: t && typeof t.slug === "string" ? { slug: t.slug, name: typeof t.name === "string" ? t.name : t.slug } : null,
    model: g.model,
    orgId: g.orgId,
    campaignId: typeof g.campaignId === "string" && g.campaignId ? g.campaignId : null,
    workflowSlug: typeof g.workflowSlug === "string" && g.workflowSlug ? g.workflowSlug : null,
    featureSlug: typeof g.featureSlug === "string" && g.featureSlug ? g.featureSlug : null,
  };
}

async function readFeed(): Promise<FeedGeneration[]> {
  const base = env("CONTENT_GENERATION_SERVICE_URL");
  const key = env("CONTENT_GENERATION_SERVICE_API_KEY");
  const rows: FeedGeneration[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const q = new URLSearchParams({ since: "1970-01-01T00:00:00.000Z", limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetchWithRetry(`${base}/internal/thread-generations?${q}`, { headers: { "x-api-key": key } }, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`content-generation-service thread-generations ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { generations?: unknown[]; nextCursor?: string | null; hasMore?: boolean };
    if (!Array.isArray(body.generations)) throw new Error("content-generation-service thread-generations: no generations array");
    rows.push(...body.generations.map(generationOf));
    if (!body.hasMore || !body.nextCursor || body.nextCursor === cursor) break;
    cursor = body.nextCursor;
  }
  return rows;
}

/** The whole post-generation feed, held 2 minutes, one read in flight. */
export async function readPostGenerations(): Promise<FeedGeneration[]> {
  if (feedHeld && Date.now() - feedHeld.at < FEED_HELD_MS) return feedHeld.rows;
  feedFlight ??= readFeed()
    .then((rows) => {
      feedHeld = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      feedFlight = null;
    });
  return feedFlight;
}

/**
 * PURE. The generations of ONE pipe: its feature, and a workflow whose dynasty (the longest assigned dynasty the slug is,
 * or is a version `<dynasty>-…` of) is assigned on this leg. A generation stating no workflow is on no pipe.
 */
export function generationsOfPipe(
  generations: readonly FeedGeneration[],
  assignments: ReadonlyArray<{ featureSlug: string; legKey: string; workflowDynastySlug: string }>,
  featureSlug: string,
  legKey: string,
): FeedGeneration[] {
  const own = assignments.filter((a) => a.featureSlug === featureSlug);
  const legOf = (slug: string): string | null => {
    let best: { len: number; leg: string } | null = null;
    for (const a of own) {
      const d = a.workflowDynastySlug;
      if ((slug === d || slug.startsWith(`${d}-`)) && (!best || d.length > best.len)) best = { len: d.length, leg: pipeLegKeyOf(featureSlug, a.legKey) };
    }
    return best?.leg ?? null;
  };
  return generations.filter((g) => g.featureSlug === featureSlug && g.workflowSlug !== null && legOf(g.workflowSlug) === legKey);
}

async function runsGet(path: string): Promise<unknown> {
  const res = await fetchWithRetry(`${env("RUNS_SERVICE_URL")}${path}`, { headers: { "x-api-key": env("RUNS_SERVICE_API_KEY") } }, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`runs-service ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export interface Occurrence {
  id: string;
  runId: string;
  direction: "produced" | "consumed";
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  consumption: { sourceOccurrenceId: string | null; consumingOutcomes: Array<{ outcomeKey: string | null }> } | null;
}

/** Every occurrence matching `params`, all pages. */
async function occurrences(params: Record<string, string>): Promise<Occurrence[]> {
  const out: Occurrence[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ ...params, limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const body = (await runsGet(`/internal/outcome-occurrences?${q}`)) as { occurrences?: Occurrence[]; nextCursor?: string | null };
    if (!Array.isArray(body.occurrences)) throw new Error("runs-service outcome-occurrences: no occurrences array");
    out.push(...body.occurrences);
    if (!body.nextCursor || body.nextCursor === cursor) break;
    cursor = body.nextCursor;
  }
  return out;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Occurrences over a list of ids (≤ 500 per call), concurrency 4. */
async function occurrencesOver(ids: readonly string[], idParam: "runIds" | "subjectIds", params: Record<string, string>): Promise<Occurrence[]> {
  const parts = await mapWithConcurrency(chunks([...new Set(ids)], 500), 4, (c) => occurrences({ ...params, [idParam]: c.join(",") }));
  return parts.flat();
}

const consumesInto = (o: Occurrence, key: string) => (o.consumption?.consumingOutcomes ?? []).some((c) => c.outcomeKey === key);

/**
 * PURE. What the ledger credits to each writing run: its post (`post_published` it produced), the visits consuming that
 * post, the signups consuming those visits (counted once per visit occurrence: one person, one post).
 */
export function ledgerCredits(
  runIds: readonly string[],
  published: readonly Occurrence[],
  postConsumptions: readonly Occurrence[],
  visitsProduced: readonly Occurrence[],
  visitConsumptions: readonly Occurrence[],
): Map<string, { published: boolean; visits: number; signups: number }> {
  const out = new Map(runIds.map((r) => [r, { published: false, visits: 0, signups: 0 }]));
  const postRun = new Map<string, string>();
  for (const o of published) {
    const e = out.get(o.runId);
    if (!e || o.direction !== "produced" || o.outcomeKey !== "post_published") continue;
    e.published = true;
    postRun.set(o.id, o.runId);
  }
  // A visit run consumed a post: its produced website_visit is that post's visit.
  const visitRunPost = new Map<string, string>();
  for (const o of postConsumptions) {
    const src = o.consumption?.sourceOccurrenceId;
    if (o.direction === "consumed" && o.outcomeKey === "post_published" && src && postRun.has(src) && consumesInto(o, "website_visit")) visitRunPost.set(o.runId, src);
  }
  const visitPost = new Map<string, string>();
  for (const o of visitsProduced) {
    const post = visitRunPost.get(o.runId);
    if (!post || o.direction !== "produced" || o.outcomeKey !== "website_visit") continue;
    visitPost.set(o.id, post);
    out.get(postRun.get(post)!)!.visits += 1;
  }
  const signed = new Set<string>();
  for (const o of visitConsumptions) {
    const src = o.consumption?.sourceOccurrenceId;
    if (o.direction === "consumed" && o.outcomeKey === "website_visit" && src && visitPost.has(src) && consumesInto(o, "signup")) signed.add(src);
  }
  for (const v of signed) out.get(postRun.get(visitPost.get(v)!)!)!.signups += 1;
  return out;
}

/** Each writing run's whole subtree cost (billed USD), per (org, campaign) of its generations. */
async function readRunSpend(gens: readonly FeedGeneration[]): Promise<Map<string, number>> {
  const scopes = [...new Map(gens.filter((g) => g.campaignId).map((g) => [`${g.orgId}|${g.campaignId}`, { orgId: g.orgId, campaignId: g.campaignId! }])).values()];
  const out = new Map<string, number>();
  await mapWithConcurrency(scopes, 2, async (s) => {
    const q = new URLSearchParams({ orgId: s.orgId, campaignId: s.campaignId, serviceName: "workflow", taskName: "execute-workflow" });
    const body = (await runsGet(`/internal/runs/subtree-costs?${q}`)) as { runs?: Array<{ id: string; actualCostInUsdCents?: string }> };
    if (!Array.isArray(body.runs)) throw new Error("runs-service subtree-costs: no runs array");
    for (const r of body.runs) {
      if (typeof r.actualCostInUsdCents !== "string") throw new Error(`runs-service subtree-costs stated no actualCostInUsdCents for run ${r.id}`);
      out.set(r.id, Number(r.actualCostInUsdCents) / 100);
    }
  });
  return out;
}

/** Each post's latest views + engagement, keyed by its publishing run (social-service, per campaign). */
async function readPostMetrics(campaignIds: readonly string[]): Promise<Map<string, { views: number; engagements: number }>> {
  const base = env("SOCIAL_SERVICE_URL");
  const key = env("SOCIAL_SERVICE_API_KEY");
  const out = new Map<string, { views: number; engagements: number }>();
  await mapWithConcurrency([...new Set(campaignIds)], 2, async (campaignId) => {
    const q = new URLSearchParams({ campaignId, limit: "500" });
    const res = await fetchWithRetry(`${base}/internal/post-metrics?${q}`, { headers: { "x-api-key": key } }, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`social-service post-metrics ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { posts?: Array<{ publishRunId?: string; metrics?: { views?: number | null }; engagement?: number | null }> };
    if (!Array.isArray(body.posts)) throw new Error("social-service post-metrics: no posts array");
    // The read answers the newest 500 only: say so rather than undercount silently.
    if (body.posts.length >= 500) console.error(`[features-service] post writer evidence: social-service post-metrics answered its 500-post cap for campaign ${campaignId}, older posts read 0 views`);
    for (const p of body.posts) {
      if (!p.publishRunId) continue;
      // A count the platform has not reported yet (null) adds nothing: the sum is of the counts known.
      out.set(p.publishRunId, { views: p.metrics?.views ?? 0, engagements: p.engagement ?? 0 });
    }
  });
  return out;
}

/**
 * The generations of one pipe and what the ledger credits to each writing run; null = the pipe's writer records no posts
 * (no generation of the feed is on it). Throws on any unreadable read.
 */
export async function readPostPipeEvidence(featureSlug: string, legKey: string): Promise<{ generations: FeedGeneration[]; creditOf: (runId: string) => RunCredit } | null> {
  const [feed, assignments] = await Promise.all([readPostGenerations(), listLegAssignments({ featureSlug })]);
  const gens = generationsOfPipe(feed, assignments, featureSlug, legKey);
  if (gens.length === 0) return null;
  const runIds = [...new Set(gens.flatMap((g) => (g.runId ? [g.runId] : [])))];
  const [spend, metrics, published] = await Promise.all([
    readRunSpend(gens),
    readPostMetrics(gens.flatMap((g) => (g.campaignId ? [g.campaignId] : []))),
    occurrencesOver(runIds, "runIds", { outcomeKey: "post_published", direction: "produced" }),
  ]);
  // The visits consuming each post (per subject service), then the signups consuming each visit.
  const bySvc = new Map<string, string[]>();
  for (const o of published) bySvc.set(o.subjectService, [...(bySvc.get(o.subjectService) ?? []), o.subjectId]);
  const postConsumptions = (await Promise.all([...bySvc].map(([svc, ids]) => occurrencesOver(ids, "subjectIds", { subjectService: svc, outcomeKey: "post_published", direction: "consumed" })))).flat();
  const visitRuns = [...new Set(postConsumptions.filter((o) => consumesInto(o, "website_visit")).map((o) => o.runId))];
  const visitsProduced = visitRuns.length ? await occurrencesOver(visitRuns, "runIds", { outcomeKey: "website_visit", direction: "produced" }) : [];
  const leadsBySvc = new Map<string, string[]>();
  for (const o of visitsProduced) leadsBySvc.set(o.subjectService, [...(leadsBySvc.get(o.subjectService) ?? []), o.subjectId]);
  const visitConsumptions = (await Promise.all([...leadsBySvc].map(([svc, ids]) => occurrencesOver(ids, "subjectIds", { subjectService: svc, outcomeKey: "website_visit", direction: "consumed" })))).flat();
  const ledger = ledgerCredits(runIds, published, postConsumptions, visitsProduced, visitConsumptions);
  const missingSpend = runIds.filter((r) => !spend.has(r));
  if (missingSpend.length) console.error(`[features-service] post writer evidence ${featureSlug}|${legKey}: runs-service lists no subtree cost for ${missingSpend.length} writing run(s) (e.g. ${missingSpend[0]}): they read $0`);
  return {
    generations: gens,
    creditOf: (runId) => {
      const l = ledger.get(runId) ?? { published: false, visits: 0, signups: 0 };
      const m = metrics.get(runId) ?? { views: 0, engagements: 0 };
      return { spentUsd: spend.get(runId) ?? 0, published: l.published, views: m.views, engagements: m.engagements, visits: l.visits, signups: l.signups };
    },
  };
}

/** Test seam. */
export function __resetPostGenerations(): void {
  feedHeld = null;
  feedFlight = null;
}
