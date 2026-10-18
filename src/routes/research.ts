/**
 * THE RESEARCH STUDIES, SERVED LIVE (LIVE-RESEARCH-1018, owner 2026-10-18: « on ne pourrait pas avoir les articles de
 * recherche lire les data live? »). Staff only (api-key; the gateway mounts it behind staff), fleet-wide, no identity.
 *
 *   GET /internal/research?basis=user|actual   the whole file the staff Research page renders (billed by default)
 *   GET /internal/research/conclusions          the CONCLUSION studies with their quotable facts (billed): social-service
 *   GET /internal/research/studies              every MEASURED study, `quotable` only on a conclusion (billed)
 *
 * Built OFF the request path like every fleet read here: the refresher (whose fleet cells are warm) computes, the
 * server serves the last build (persisted in the fleet cell store, so a fresh process never answers empty), and a
 * read past the fresh window kicks one background rebuild. Before the first build ever: 503 `research_not_computed_yet`.
 *
 * ONE evidence, ONE rule: a workflow's bar IS its row of the leg workflow ranking (`/public/stats/leg-workflow-ranking`),
 * and every other bar regroups the same per-version evidence (`fetchFleetLegSlugEvidence`), dated by the runs ledger and
 * the fleet person cell. Pure assembly: `lib/research/*`.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { refresherBaseUrl } from "../lib/view-refresher.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { legCutoffIso, legMaturity, startedBeforeParam } from "../lib/maturity.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "../lib/pricing.js";
import { runsSpendSlugsParam } from "../lib/feature-scope.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "../lib/brand-spend-by-day-client.js";
import { fetchFleetPersonBuckets } from "../lib/fleet-positive-repliers.js";
import { isScreenedVisitLeg } from "../lib/screened-visits.js";
import { fetchMeetingBookingBeforeAfter } from "../lib/meeting-booking-before-after.js";
import { getInternalPipeFleet, MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY } from "../lib/meeting-leg-fleet.js";
import type { CostGroup, WorkflowMetadata } from "../lib/public-stats-clients.js";
import { buildSlugCells, type DatedSpendRow } from "../lib/research/slug-cells.js";
import { assembleResearch, MEETING_BOOKING_PIPE, POSITIVE_REPLY_PIPE, ruleNote, termsOf, WEBSITE_VISIT_PIPE, workflowBuckets, type ColdEmailPipeInput } from "../lib/research/assemble.js";
import { generationBuckets, generationStudies, type ModelName } from "../lib/research/generations.js";
import { pipeCatalog, type GenerationRun, type ResearchCatalog, type WorkflowRun } from "../lib/research/catalog.js";
import type { ResearchBucket } from "../lib/research/studies.js";
import type { FleetPersonBucket } from "../lib/fleet-positive-repliers.js";
import { researchConclusions, researchMeasuredStudies } from "../lib/research/conclusions.js";
import type { ResearchFile, ResearchStudy } from "../lib/research/types.js";
import { fetchFleetLegSlugEvidence, readLegWorkflowRanking } from "./public.js";
import { readGenerationRuns, readJevInputs, readLegSpendSplit, readOpensArms, readReplyAuthors, readReportingBrands, readSendGroups, readWorkflowRuns } from "./research-sends.js";

const router = Router();

const COLD_EMAIL = "sales-cold-email-outreach";
const REPLY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";
const FRESH_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const RANKING_WAIT_MS = 10 * 60_000;
/** The first month runs carry cold email spend (the ledger starts in February 2026). */
const FIRST_MONTH = "2026-01";

type Basis = "user" | "actual";

const monthStart = (ym: string) => `${ym}-01T00:00:00.000Z`;
const nextMonth = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** PURE. The run-start windows the dated spend is read over: each month, the cutoff's month split at the cutoff. */
export function spendWindows(now: Date, cutoffIso: string | null): Array<{ month: string; from: string; to: string; beforeCutoff: boolean }> {
  const out: Array<{ month: string; from: string; to: string; beforeCutoff: boolean }> = [];
  const last = now.toISOString().slice(0, 7);
  for (let ym = FIRST_MONTH; ym <= last; ym = nextMonth(ym)) {
    const from = monthStart(ym);
    const to = monthStart(nextMonth(ym));
    if (cutoffIso && cutoffIso > from && cutoffIso < to) {
      out.push({ month: ym, from, to: cutoffIso, beforeCutoff: true });
      out.push({ month: ym, from: cutoffIso, to, beforeCutoff: false });
    } else {
      out.push({ month: ym, from, to, beforeCutoff: cutoffIso === null || to <= cutoffIso });
    }
  }
  return out;
}

/** Spend per (version, campaign) over one run-start window, every org's campaigns of the leg (incurred, like the ranking). */
async function fetchWindowSpend(featureSlug: string, ids: readonly string[], from: string, to: string): Promise<CostGroup[]> {
  const base = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({
    groupBy: "workflowSlug,campaignId",
    featureSlugs: runsSpendSlugsParam(featureSlug, "own"),
    campaignIds: ids.join(","),
    startedAfter: from,
    startedBefore: startedBeforeParam(to),
  });
  // The fleet aggregation that co-groups two keys is runs-service's service-auth one (the public one takes a single key);
  // it states the billed fields beside the vendor ones, so both bases read it (`selectCostCentsString` picks).
  const res = await fetchWithRetry(runsCostsUrl(base, "public", "vendor", params), { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`runs-service dated research spend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(body.groups)) throw new Error("runs-service dated research spend: no groups array");
  return body.groups;
}

/**
 * A window that ENDED more than a day ago is read once a day (its runs are started; a late actualization is rare and
 * lands within the day): the runs ledger's vendor-priced aggregation is heavy, and each build would otherwise re-read
 * every month since February. The open windows are read on every build.
 */
const CLOSED_WINDOW_HOLD_MS = 24 * 60 * 60_000;
const closedWindows = new Map<string, { at: number; groups: CostGroup[] }>();
async function closedWindowSpend(featureSlug: string, ids: readonly string[], from: string, to: string, now: Date): Promise<CostGroup[]> {
  const closed = Date.parse(to) < now.getTime() - 24 * 60 * 60_000;
  const key = `${featureSlug}|${from}|${to}|${ids.join(",")}`;
  const held = closedWindows.get(key);
  if (closed && held && now.getTime() - held.at < CLOSED_WINDOW_HOLD_MS) return held.groups;
  const groups = await fetchWindowSpend(featureSlug, ids, from, to);
  if (closed) closedWindows.set(key, { at: now.getTime(), groups });
  return groups;
}

async function fetchDatedSpend(featureSlug: string, campaignIds: readonly string[], pricing: Pricing, cutoffIso: string | null, now: Date): Promise<DatedSpendRow[]> {
  const ids = [...new Set(campaignIds)].sort();
  if (!ids.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) chunks.push(ids.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
  const reads = spendWindows(now, cutoffIso).flatMap((w) => chunks.map((c) => ({ w, c })));
  const rows = await mapWithConcurrency(reads, 1, async ({ w, c }) => {
    const groups = await closedWindowSpend(featureSlug, c, w.from, w.to, now);
    return groups.flatMap((g): DatedSpendRow[] => {
      const slug = g.dimensions.workflowSlug;
      const campaignId = g.dimensions.campaignId;
      if (!slug || !campaignId) return [];
      const cents = Number(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred"));
      return cents ? [{ workflowSlug: slug, campaignId, month: w.month, beforeCutoff: w.beforeCutoff, spentUsd: cents / 100 }] : [];
    });
  });
  return rows.flat();
}

/** A dynasty's name as the page shows it: workflow-service's name less the channel's words ("Rampart"). */
function labelFor(workflows: readonly WorkflowMetadata[]): (dynasty: string) => string {
  const names = new Map<string, string>();
  for (const w of workflows) if (w.workflowDynastyName && !names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  return (dynasty) => {
    const name = names.get(dynasty);
    if (!name) return dynasty;
    const short = name.replace(/^(Sales Cold Email Outreach|Ai Meeting Booking)\s+/i, "");
    return short || name;
  };
}

interface ColdEmailPipeRead {
  input: ColdEmailPipeInput;
  unpricedUsd: number;
  campaignIds: string[];
  cutoffIso: string | null;
  persons: FleetPersonBucket[];
  split: { screened: boolean; signal: "positiveReply" | "clicked" | "other"; cutoffDay: string | null };
  campaigns: Array<{ campaignId: string; orgId: string }>;
  /** Dynasty → workflow-service's name. */
  names: Map<string, string>;
}

async function coldEmailPipe(legKey: string, basis: Basis, now: Date): Promise<ColdEmailPipeRead> {
  const pricing: Pricing = basis === "actual" ? "vendor" : "gross";
  // The vendor-cost twin is read one aggregation at a time: runs-service's vendor-priced fleet read takes ~16 s on a leg
  // (0.15 s billed) and timed out when asked several at once (2026-10-18).
  const [ev, ranking] = await Promise.all([
    fetchFleetLegSlugEvidence(COLD_EMAIL, legKey, "own", pricing),
    basis === "user" ? readLegWorkflowRanking(COLD_EMAIL, legKey, RANKING_WAIT_MS) : Promise.resolve(null),
  ]);
  const unpriced = basis === "actual" ? await fetchFleetLegSlugEvidence(COLD_EMAIL, legKey, "own", "vendorUnpriced") : null;
  if (basis === "user" && !ranking) throw new Error(`leg workflow ranking ${COLD_EMAIL}|${legKey} not built yet`);
  const campaignIds = ev.campaigns.map((c) => c.campaignId);
  const [persons, spend] = await Promise.all([
    fetchFleetPersonBuckets(COLD_EMAIL, new Set(campaignIds)),
    fetchDatedSpend(COLD_EMAIL, campaignIds, pricing, ev.cutoffIso, now),
  ]);
  const rule = legMaturity(legKey);
  const screened = isScreenedVisitLeg(legKey);
  // The vendor basis leaves out WHOLE every version carrying billed spend no vendor cost prices (its priced part alone
  // would read as the whole), and states how much that was.
  const unpricedBySlug = new Map<string, number>();
  for (const g of unpriced?.flash.costGroups ?? []) {
    const slug = g.dimensions.workflowSlug;
    const cents = Number(g.totalCostInUsdCents);
    if (slug && cents > 0) unpricedBySlug.set(slug, (unpricedBySlug.get(slug) ?? 0) + cents / 100);
  }
  const keep = (g: { dimensions: Record<string, string | null> }) => !unpricedBySlug.has(g.dimensions.workflowSlug ?? "");
  const cells = buildSlugCells({
    legKey,
    screened,
    signal: rule.outcomeSignal === "positiveReply" ? "positiveReply" : rule.outcomeSignal === "clicked" ? "clicked" : "other",
    cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null,
    flash: { costGroups: ev.flash.costGroups.filter(keep), emailStats: ev.flash.emailStats },
    mature: ev.mature ? { costGroups: ev.mature.costGroups.filter(keep), emailStats: ev.mature.emailStats } : null,
    persons,
    spend: spend.filter((r) => !unpricedBySlug.has(r.workflowSlug)),
    orgOfCampaign: new Map(ev.campaigns.map((c) => [c.campaignId, c.orgId])),
  });
  return {
    input: {
      legKey,
      durationDays: rule.durationDays,
      outcomesRequired: rule.outcomesRequired,
      cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null,
      cells,
      dynastyOf: new Map(ev.workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug])),
      labelOf: labelFor(ev.workflows),
      rankingRows: ranking ? ranking.rows : null,
    },
    unpricedUsd: [...unpricedBySlug.values()].reduce((a, b) => a + b, 0),
    campaignIds,
    cutoffIso: ev.cutoffIso,
    persons,
    campaigns: ev.campaigns.map((c) => ({ campaignId: c.campaignId, orgId: c.orgId })),
    names: new Map(ev.workflows.filter((w) => w.workflowDynastyName).map((w) => [w.workflowDynastySlug, w.workflowDynastyName])),
    split: { screened, signal: rule.outcomeSignal === "positiveReply" ? "positiveReply" : rule.outcomeSignal === "clicked" ? "clicked" : "other", cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null },
  };
}

/** chat-service's names and tiers of every concrete model id we wrote with (cheap = Flash, strong / frontier = Pro). */
async function readModelNames(): Promise<Map<string, ModelName>> {
  const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/model-ids`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
  if (!res.ok) throw new Error(`chat-service model-ids ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { models?: Array<{ modelId: string; displayName: string; capabilityTier: string }> };
  if (!Array.isArray(body.models)) throw new Error("chat-service model-ids: no models array");
  return new Map(body.models.map((m) => [m.modelId, { label: m.displayName, tier: m.capabilityTier === "cheap" ? "Flash" : "Pro" } as ModelName]));
}

/** Each template's prompt text (content-generation-service, no identity), held 6 hours: a versioned template never changes. */
const templateTextHeld = new Map<string, { at: number; text: string | null }>();
async function readTemplateTexts(types: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapWithConcurrency([...new Set(types)], 4, async (type) => {
    const held = templateTextHeld.get(type);
    if (held && Date.now() - held.at < 6 * 60 * 60_000) {
      if (held.text) out.set(type, held.text);
      return;
    }
    const res = await fetchWithRetry(`${process.env.CONTENT_GENERATION_SERVICE_URL}/platform-prompts?type=${encodeURIComponent(type)}`, {
      headers: { "x-api-key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? "" },
    });
    const text = res.ok ? (((await res.json()) as { prompt?: string }).prompt ?? null) : null;
    if (!res.ok && res.status !== 404) throw new Error(`content-generation-service platform-prompts ${type} ${res.status}`);
    templateTextHeld.set(type, { at: Date.now(), text });
    if (text) out.set(type, text);
  });
  return out;
}

interface GenerationPart {
  studies: ResearchStudy[];
  /** Per pipe, the bars the catalogue lists (templates, models) and what each workflow's people were mostly written with. */
  reply: CatalogGen;
  visit: CatalogGen;
  templateTexts: Map<string, string>;
}
interface CatalogGen {
  templates: ResearchBucket[];
  models: ResearchBucket[];
  modelLabel: (id: string) => string;
  mainOf: (dynasty: string) => { model: string | null; template: string | null };
}

const NO_GEN: CatalogGen = { templates: [], models: [], modelLabel: (id) => id, mainOf: () => ({ model: null, template: null }) };

/** PURE. The model and template most of a dynasty's people (people emailed) were written with. */
function mainsByDynasty(persons: readonly FleetPersonBucket[], dynastyOf: ReadonlyMap<string, string>, screened: boolean) {
  const tally = new Map<string, { models: Map<string, number>; templates: Map<string, number> }>();
  for (const b of persons) {
    if (!b.generation) continue;
    const d = dynastyOf.get(b.workflowSlug) ?? b.workflowSlug;
    const t = tally.get(d) ?? { models: new Map(), templates: new Map() };
    tally.set(d, t);
    const c = (screened ? b.screenedContacted : b.contacted) || 0.0001;
    t.models.set(b.generation.model, (t.models.get(b.generation.model) ?? 0) + c);
    if (b.generation.promptType) t.templates.set(b.generation.promptType, (t.templates.get(b.generation.promptType) ?? 0) + c);
  }
  const top = (m: Map<string, number> | undefined) => (m && m.size ? [...m].sort((a, b) => b[1] - a[1])[0]![0] : null);
  return (dynasty: string) => ({ model: top(tally.get(dynasty)?.models), template: top(tally.get(dynasty)?.templates) });
}

/** The studies of what wrote the emails; none while the fleet person cell carries no generation yet (its ids stay waiting). */
async function generationInputs(reply: ColdEmailPipeRead, visit: ColdEmailPipeRead, note: string): Promise<GenerationPart> {
  if (![...reply.persons, ...visit.persons].some((b) => b.generation)) return { studies: [], reply: NO_GEN, visit: NO_GEN, templateTexts: new Map() };
  const types = [...reply.persons, ...visit.persons].map((b) => b.generation?.promptType).filter((x): x is string => Boolean(x));
  const [models, templateTexts] = await Promise.all([readModelNames(), readTemplateTexts(types)]);
  const inputOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead) => ({
    terms: termsOf(pipe, r.input, note),
    legKey: r.input.legKey,
    cells: r.input.cells,
    persons: r.persons,
    split: r.split,
    models,
    templateTexts,
    naming: pipe === POSITIVE_REPLY_PIPE,
  });
  const partOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead): CatalogGen => {
    const g = generationBuckets(inputOf(pipe, r));
    return { templates: g.tpl.rows, models: g.llm.rows, modelLabel: g.modelLabel, mainOf: mainsByDynasty(r.persons, r.input.dynastyOf, r.split.screened) };
  };
  return {
    studies: [...generationStudies(inputOf(POSITIVE_REPLY_PIPE, reply)), ...generationStudies(inputOf(WEBSITE_VISIT_PIPE, visit))],
    reply: partOf(POSITIVE_REPLY_PIPE, reply),
    visit: partOf(WEBSITE_VISIT_PIPE, visit),
    templateTexts,
  };
}

/** The studies read on each email sent; null while our copy of the outreach facts holds no send of these legs yet. */
async function sendsInputs(reply: { campaignIds: string[]; cutoffIso: string | null }, visit: { campaignIds: string[]; cutoffIso: string | null }, pricing: Pricing) {
  const [rg, vg] = await Promise.all([readSendGroups(reply.campaignIds, reply.cutoffIso), readSendGroups(visit.campaignIds, visit.cutoffIso)]);
  if (!rg.length && !vg.length) return null;
  const rs = await readLegSpendSplit(COLD_EMAIL, reply.campaignIds, pricing, reply.cutoffIso);
  const vs = await readLegSpendSplit(COLD_EMAIL, visit.campaignIds, pricing, visit.cutoffIso);
  const opens = reply.cutoffIso ? await readOpensArms(reply.cutoffIso) : null;
  return { reply: { groups: rg, spend: rs }, visit: { groups: vg, spend: vs }, opens };
}

/** The whole file, computed IN THIS PROCESS (the refresher, or the server when it is off). */
export async function computeResearch(basis: Basis, now = new Date()): Promise<ResearchBuild> {
  const meetingRule = legMaturity(MEETING_BOOKING_LEG_KEY);
  // The two legs in turn on the vendor basis (one heavy aggregation at a time), together on the billed one.
  const legs =
    basis === "actual"
      ? (async () => {
          const r = await coldEmailPipe(REPLY_LEG, basis, now);
          return [r, await coldEmailPipe(VISIT_LEG, basis, now)] as const;
        })()
      : Promise.all([coldEmailPipe(REPLY_LEG, basis, now), coldEmailPipe(VISIT_LEG, basis, now)]);
  const [[reply, visit], meetingRanking, meetingFleet, beforeAfter] = await Promise.all([
    legs,
    basis === "user" ? readLegWorkflowRanking(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, RANKING_WAIT_MS) : Promise.resolve(null),
    basis === "user" ? getInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked") : Promise.resolve(null),
    fetchMeetingBookingBeforeAfter(),
  ]);
  const [sends, jev, replies, gens, reportingBrands] = await Promise.all([
    sendsInputs(reply, visit, basis === "actual" ? "vendor" : "gross"),
    readJevInputs(),
    readReplyAuthors(),
    // A study family whose producer read fails stays waiting (logged), never fails the whole file.
    generationInputs(reply, visit, ruleNote(reply.input, visit.input)).catch((err): GenerationPart => {
      console.error("[features-service] research: the studies of what wrote the emails could not be built this time:", err);
      return { studies: [], reply: NO_GEN, visit: NO_GEN, templateTexts: new Map() };
    }),
    basis === "user" ? readReportingBrands() : Promise.resolve(null),
  ]);
  const file = assembleResearch({
    sends,
    generationStudies: gens.studies,
    reportingBrands,
    meetingOutcomeRequired: legMaturity("start_to_meeting_booked").outcomesRequired,
    jev: { ...jev, replies },
    costBasis: basis,
    now,
    unpricedBilledUsd: reply.unpricedUsd + visit.unpricedUsd,
    reply: reply.input,
    visit: visit.input,
    meeting: {
      outcomesRequired: meetingRule.outcomesRequired,
      rankingRows: meetingRanking ? meetingRanking.rows : null,
      unattributableCampaigns: meetingFleet ? meetingFleet.unattributableCampaignIds.length : 0,
    },
    beforeAfter,
    meetingOutcomesRequired: meetingRule.outcomesRequired,
  });
  // The catalogue: one page per workflow, template and model, per pipe, from the same bars.
  const note = ruleNote(reply.input, visit.input);
  const [replyRuns, visitRuns, replyGens, visitGens] = await Promise.all([
    readWorkflowRuns(reply.campaigns, (slug) => reply.input.dynastyOf.get(slug) ?? slug, basis),
    readWorkflowRuns(visit.campaigns, (slug) => visit.input.dynastyOf.get(slug) ?? slug, basis),
    readGenerationRuns(reply.campaignIds).catch(() => []),
    readGenerationRuns(visit.campaignIds).catch(() => []),
  ]);
  const catalogOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead, g: CatalogGen, runs: WorkflowRun[], gensRuns: GenerationRun[]) =>
    pipeCatalog({
      terms: termsOf(pipe, r.input, note),
      workflows: workflowBuckets(r.input),
      templates: g.templates,
      models: g.models,
      nameOf: (d) => r.names.get(d) ?? null,
      mainOf: g.mainOf,
      modelLabel: g.modelLabel,
      dynastyOf: (slug) => r.input.dynastyOf.get(slug) ?? slug,
      workflowRuns: runs,
      generationRuns: gensRuns,
      templateTexts: new Set(gens.templateTexts.keys()),
    });
  const catalog: ResearchCatalog = {
    [POSITIVE_REPLY_PIPE]: catalogOf(POSITIVE_REPLY_PIPE, reply, gens.reply, replyRuns, replyGens),
    [WEBSITE_VISIT_PIPE]: catalogOf(WEBSITE_VISIT_PIPE, visit, gens.visit, visitRuns, visitGens),
    [MEETING_BOOKING_PIPE]: { workflows: [], templates: [], models: [] },
  };
  const listed = new Set(Object.values(catalog).flatMap((c) => c.templates.map((t) => t.key)));
  const texts = Object.fromEntries([...gens.templateTexts].filter(([k]) => listed.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { file, catalog, texts };
}

/** One build: the file, its catalogue and the text of every listed template. */
export interface ResearchBuild {
  file: ResearchFile;
  catalog: ResearchCatalog;
  texts: Record<string, string>;
}

// ── serving: last build, persisted; one background rebuild at a time per basis ─────────────────────────────

const store = new Map<Basis, { value: StoredBuild; computedAt: number }>();
/** A build as stored; a copy persisted before the catalogue existed holds the file alone (`catalog` null until the next build). */
type StoredBuild = { file: ResearchFile; catalog: ResearchCatalog | null; texts: Record<string, string> | null };
const warming = new Map<Basis, Promise<void>>();
const failedAt = new Map<Basis, number>();
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const cellKey = (basis: Basis) => `research:${basis}`;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Ask the refresher (whose fleet cells are warm) to compute; compute here when it cannot. */
async function buildResearch(basis: Basis): Promise<ResearchBuild> {
  const base = refresherBaseUrl();
  if (base) {
    try {
      const res = await fetch(`${base}/internal/research/compute?basis=${basis}`, { headers: { "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" } });
      if (res.ok) return (await res.json()) as ResearchBuild;
      console.error(`[features-service] refresher answered ${res.status} for research ${basis}; computing locally`);
    } catch (error) {
      console.error(`[features-service] refresher unreachable for research ${basis}; computing locally:`, error);
    }
  }
  return computeResearch(basis);
}

/** The vendor-cost twin reads runs-service's heaviest aggregation per org: rebuilt every 6 hours, not every 15 minutes. */
const freshMsOf = (basis: Basis) => (basis === "actual" ? 6 * 60 * 60_000 : FRESH_MS);

export function warmResearch(basis: Basis): Promise<void> {
  const entry = store.get(basis);
  if (entry && Date.now() - entry.computedAt < freshMsOf(basis)) return Promise.resolve();
  // A failed build is not retried on every read (each read would re-ask runs-service's heaviest aggregation).
  if (Date.now() - (failedAt.get(basis) ?? 0) < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  const inFlight = warming.get(basis);
  if (inFlight) return inFlight;
  const p = withTimeout(buildResearch(basis), BUILD_TIMEOUT_MS, `research ${basis}`)
    .then(async (value) => {
      const computedAt = Date.now();
      store.set(basis, { value, computedAt });
      await storeFleetCell(cellKey(basis), JSON.stringify(value), computedAt);
    })
    .catch((error) => {
      failedAt.set(basis, Date.now());
      console.error(`[features-service] research ${basis} build failed, keeping the previous one (next try in 10 min):`, error);
    })
    .finally(() => warming.delete(basis));
  warming.set(basis, p);
  return p;
}

/** The last build (the persisted copy on a fresh process); kicks a rebuild when stale. Null = never built. */
export async function readResearchBuild(basis: Basis): Promise<StoredBuild | null> {
  if (!store.has(basis)) {
    const stored = await loadFleetCell(cellKey(basis));
    if (stored && !store.has(basis)) {
      try {
        const raw = JSON.parse(stored.text) as ResearchBuild | ResearchFile;
        const value: StoredBuild = "file" in raw ? raw : { file: raw, catalog: null, texts: null };
        store.set(basis, { value, computedAt: stored.computedAt });
      } catch (error) {
        console.error(`[features-service] research ${basis}: persisted copy unreadable, rebuilding:`, error);
      }
    }
  }
  void warmResearch(basis);
  return store.get(basis)?.value ?? null;
}

/** The last file (see {@link readResearchBuild}). */
export async function readResearch(basis: Basis): Promise<ResearchFile | null> {
  return (await readResearchBuild(basis))?.file ?? null;
}

/** Test seam. */
export function __resetResearch(): void {
  store.clear();
  warming.clear();
  failedAt.clear();
  closedWindows.clear();
}

const basisOf = (raw: unknown): Basis | null => (raw === undefined || raw === "" || raw === "user" || raw === "billed" ? "user" : raw === "actual" ? "actual" : null);

const notYet = (res: import("express").Response) =>
  res.status(503).json({ error: "The research studies have not been computed yet: the first build after this deploy is running.", reason: "research_not_computed_yet" });

router.get("/internal/research", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user (billed, default) or actual", reason: "basis_unrecognised" });
    return;
  }
  try {
    const file = await readResearch(basis);
    if (!file) return notYet(res);
    res.json(file);
  } catch (error) {
    console.error("[features-service] research read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/conclusions", apiKeyOnly, async (_req, res) => {
  try {
    const file = await readResearch("user");
    if (!file) return notYet(res);
    res.json(researchConclusions(file));
  } catch (error) {
    console.error("[features-service] research conclusions failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/studies", apiKeyOnly, async (_req, res) => {
  try {
    const file = await readResearch("user");
    if (!file) return notYet(res);
    res.json(researchMeasuredStudies(file));
  } catch (error) {
    console.error("[features-service] research studies failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/catalog", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user (billed, default) or actual", reason: "basis_unrecognised" });
    return;
  }
  try {
    const build = await readResearchBuild(basis);
    if (!build?.catalog) return notYet(res);
    res.json(build.catalog);
  } catch (error) {
    console.error("[features-service] research catalogue read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/templates", apiKeyOnly, async (_req, res) => {
  try {
    const build = await readResearchBuild("user");
    if (!build?.texts) return notYet(res);
    res.json(build.texts);
  } catch (error) {
    console.error("[features-service] research template texts read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** The refresher's compute door (the server asks it; never cached here: the caller stores the answer). */
router.get("/internal/research/compute", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user or actual" });
    return;
  }
  try {
    res.json(await computeResearch(basis));
  } catch (error) {
    console.error(`[features-service] research compute (${basis}) failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
