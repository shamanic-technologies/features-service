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
import { generationBuckets, generationStudies, type ModelName, type VersionShare } from "../lib/research/generations.js";
import { templateDynastyIndex, type TemplateDynastyIndex } from "../lib/research/template-dynasties.js";
import { readLiveTemplateDynasties, readTemplateDynasties, readTemplateTexts, readWriterModelAliases } from "../lib/writer-catalogue-client.js";
import { withLiveTemplateStatus } from "../lib/research/live-template-status.js";
import { servedLegKeyOf } from "../lib/funnel-legs.js";
import { dynastyLastWriters, dynastyWriters, versionWriters, type DynastyWriter, type WriterReason } from "../lib/research/writers.js";
import { readModelIds } from "../lib/model-ids-client.js";
import { llmDynastyIndex, readLlmDynastiesSoft, type LlmDynastyIndex } from "../lib/llm-dynasties.js";
import { fetchWorkflowDefinitions } from "../lib/workflow-definitions-client.js";
import type { LegWorkflowRankingRow } from "../lib/leg-workflow-ranking.js";
import { candidatePartsOf, deprecatedPartsOf, inFlashOrder, pipePerformance, servedNowOf, type PerformanceServedNow, type PipePerformance, type VersionWriter } from "../lib/research/performance.js";
import type { GenerationCostInput, RunCostUnavailableReason } from "../lib/research/run-cost.js";
import { pickPipeWriters } from "./leg-writer-ranking.js";
import { pipeCatalog, withWorkflowFigures, type CatalogTemplate, type GenerationRun, type ResearchCatalog, type WorkflowRun } from "../lib/research/catalog.js";
import { readTemplateTactics, withTemplateTactics } from "../lib/template-tactics.js";
import { withPerformanceMarks, withResearchCatalogMarks } from "../lib/catalogue-mark-serving.js";
import type { ResearchBucket } from "../lib/research/studies.js";
import type { FleetPersonBucket } from "../lib/fleet-positive-repliers.js";
import { researchConclusions, researchMeasuredStudies } from "../lib/research/conclusions.js";
import type { ResearchFile, ResearchPipeId, ResearchStudy, ResearchView } from "../lib/research/types.js";
import { fetchFleetLegSlugEvidence, readLegWorkflowRanking } from "./public.js";
import { bestMeetingPipePick } from "../lib/fleet-indexes.js";
import { readFleetIndexSeries } from "../lib/fleet-index-store.js";
import { MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG, meetingResearchPoints, meetingSeriesOf } from "../lib/research/pipe-series.js";
import { fetchFleetCampaignRows } from "../lib/fleet-leg-campaigns.js";
import { isReplyPipe } from "../lib/campaign-next-steps.js";
import { fetchReplyDelayDistribution } from "../lib/campaign-next-steps-io.js";
import { fetchOutcomeLedgerTotals, type OutcomeLedgerTotals } from "../lib/outcome-cost-totals-client.js";
import { estimateStudy, LLM_DIMENSION, TEMPLATE_DIMENSION, workflowEstimateStudy, type WorkflowEstimateGroup } from "../lib/research/workflow-estimate.js";
import { estimateReplayStudy, type ReplayBucket } from "../lib/research/estimate-replay.js";
import { outcomeCostByClientStudy, type ClientCostRow } from "../lib/research/outcome-cost-by-client.js";
import { rollUpByOrg, rollUpOutcomeUnitCosts, workflowUnitCosts } from "../lib/outcome-unit-costs.js";
import { fetchOutcomeLedgerByWorkflow } from "../lib/outcome-cost-totals-client.js";
import { workflowLedgerStudy } from "../lib/research/workflow-ledger.js";
import { COVERAGE_BAR_PCT } from "../lib/research/outcome-cost.js";
import { listDeclaredSteps } from "../lib/channel-declarations-store.js";
import { CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import { pipeLegKeyOf } from "../lib/funnel-legs.js";
import type { ReplyDelayRead } from "../lib/research/reply-delay.js";
import { readBookedAfterReply, readGenerationCosts, readGenerationRuns, readJevInputs, orgChunks, readLegSpendTotal, readMeetingAttribution, readOrgWindowSpend, readOpensArms, readPerEmailPrices, readReplyAuthors, readReportingBrands, readSendGroups, readVolume, readWorkflowRuns } from "./research-sends.js";
import { fetchFleetReplierCountries } from "../lib/fleet-positive-repliers.js";
import { fetchBrandsBasic, fetchOrgName, fetchOrgUserEmails } from "../lib/accounts-client.js";
import { isStaffOnlyOrg } from "../lib/showcase-clients.js";
import { countryMeetingStudy, countryStudies } from "../lib/research/countries.js";
import { readNicheGrades } from "../lib/research/niche-grades.js";
import { nicheStudies } from "../lib/research/niche.js";
import { otherPipesOf, otherPipeTerms, type OtherPipe } from "../lib/research/other-pipes.js";
import { STUDIED_PIPES } from "../lib/research/assemble.js";
import { loadChannelCatalogue } from "../lib/channel-declarations-store.js";
import { listLegAssignments } from "../lib/workflow-leg-assignments.js";
import { internalPipeToStep } from "../lib/pipe-kind.js";

const router = Router();

const COLD_EMAIL = "sales-cold-email-outreach";
const REPLY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";
const FRESH_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const STORE_TIMEOUT_MS = 2 * 60_000;
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

/**
 * A window that ENDED more than a day ago is read once a day (its runs are started; a late actualization is rare and
 * lands within the day): each build would otherwise re-read every month since February. Open windows are read every build.
 */
const CLOSED_WINDOW_HOLD_MS = 24 * 60 * 60_000;
const closedWindows = new Map<string, { at: number; groups: CostGroup[] }>();
async function closedWindowSpend(featureSlug: string, orgId: string, ids: readonly string[], pricing: Pricing, from: string, to: string, now: Date): Promise<CostGroup[]> {
  const closed = Date.parse(to) < now.getTime() - 24 * 60 * 60_000;
  const key = `${featureSlug}|${pricing}|${orgId}|${from}|${to}|${ids.join(",")}`;
  const held = closedWindows.get(key);
  if (closed && held && now.getTime() - held.at < CLOSED_WINDOW_HOLD_MS) return held.groups;
  const groups = await readOrgWindowSpend(featureSlug, orgId, ids, pricing, { from, to });
  if (closed) closedWindows.set(key, { at: now.getTime(), groups });
  return groups;
}

export async function fetchDatedSpend(featureSlug: string, campaigns: ReadonlyArray<{ campaignId: string; orgId: string }>, pricing: Pricing, cutoffIso: string | null, now: Date): Promise<DatedSpendRow[]> {
  const chunks = orgChunks(campaigns);
  const reads = spendWindows(now, cutoffIso).flatMap((w) => chunks.map(({ orgId, ids }) => ({ w, orgId, c: ids })));
  // the vendor-priced twin one read at a time (runs-service's heavy aggregation), the billed one three at a time
  const rows = await mapWithConcurrency(reads, pricing === "gross" ? 3 : 1, async ({ w, orgId, c }) => {
    const groups = await closedWindowSpend(featureSlug, orgId, c, pricing, w.from, w.to, now);
    return groups.flatMap((g): DatedSpendRow[] => {
      const slug = g.dimensions.workflowSlug;
      if (!slug || slug === "__total__") return [];
      const cents = Number(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred"));
      return cents ? [{ workflowSlug: slug, orgId, month: w.month, beforeCutoff: w.beforeCutoff, spentUsd: cents / 100 }] : [];
    });
  });
  return rows.flat();
}

/** A dynasty's name as the page shows it: workflow-service's name less the channel's words ("Rampart"). */
function shortName(name: string): string {
  return name.replace(/^(Sales Cold Email Outreach|Ai Meeting Booking)\s+/i, "") || name;
}
function labelFor(workflows: readonly WorkflowMetadata[]): (dynasty: string) => string {
  const names = new Map<string, string>();
  for (const w of workflows) if (w.workflowDynastyName && !names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  return (dynasty) => {
    const name = names.get(dynasty);
    return name ? shortName(name) : dynasty;
  };
}

interface ColdEmailPipeRead {
  input: ColdEmailPipeInput;
  unpricedUsd: number;
  campaignIds: string[];
  cutoffIso: string | null;
  persons: FleetPersonBucket[];
  split: { screened: boolean; signal: "positiveReply" | "clicked" | "other"; cutoffDay: string | null };
  campaigns: Array<{ campaignId: string; orgId: string; brandId: string | null; offerId: string | null }>;
  /** Dynasty → workflow-service's name. */
  names: Map<string, string>;
  /** The pipe's dated spend rows (per workflow version, org, month): today's per-client figure reads them. */
  spend: DatedSpendRow[];
}

/**
 * One pipe's evidence. The two cold email pipes read it as they always did; every other pipe (WA-PIPE-RESEARCH-1023) reads
 * the SAME evidence through `opts` (its own channel; no dated spend, which only spreads bars over months; a ranking not
 * built yet lists the bars alone instead of failing the file).
 */
async function coldEmailPipe(legKey: string, basis: Basis, now: Date, opts: { featureSlug?: string; datedSpend?: boolean; requireRanking?: boolean; view?: ResearchView } = {}): Promise<ColdEmailPipeRead> {
  const featureSlug = opts.featureSlug ?? COLD_EMAIL;
  const pricing: Pricing = basis === "actual" ? "vendor" : "gross";
  // The vendor-cost twin is read one aggregation at a time: runs-service's vendor-priced fleet read takes ~16 s on a leg
  // (0.15 s billed) and timed out when asked several at once (2026-10-18).
  const [ev, ranking] = await Promise.all([
    fetchFleetLegSlugEvidence(featureSlug, legKey, "own", pricing),
    basis === "user" ? readLegWorkflowRanking(featureSlug, legKey, RANKING_WAIT_MS) : Promise.resolve(null),
  ]);
  const unpriced = basis === "actual" ? await fetchFleetLegSlugEvidence(featureSlug, legKey, "own", "vendorUnpriced") : null;
  if (basis === "user" && !ranking && opts.requireRanking !== false) throw new Error(`leg workflow ranking ${featureSlug}|${legKey} not built yet`);
  const campaignIds = ev.campaigns.map((c) => c.campaignId);
  const [persons, spend] = await Promise.all([
    fetchFleetPersonBuckets(featureSlug, new Set(campaignIds)),
    opts.datedSpend === false ? Promise.resolve([] as DatedSpendRow[]) : fetchDatedSpend(featureSlug, ev.campaigns, pricing, ev.cutoffIso, now),
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
      view: opts.view,
      readDay: now.toISOString().slice(0, 10),
    },
    unpricedUsd: [...unpricedBySlug.values()].reduce((a, b) => a + b, 0),
    campaignIds,
    cutoffIso: ev.cutoffIso,
    persons,
    campaigns: ev.campaigns.map((c) => ({ campaignId: c.campaignId, orgId: c.orgId, brandId: c.brandId, offerId: c.offerId ?? null })),
    names: new Map(ev.workflows.filter((w) => w.workflowDynastyName).map((w) => [w.workflowDynastySlug, w.workflowDynastyName])),
    spend,
    split: { screened, signal: rule.outcomeSignal === "positiveReply" ? "positiveReply" : rule.outcomeSignal === "clicked" ? "clicked" : "other", cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null },
  };
}

/** chat-service's names and tiers of every concrete model id we wrote with (cheap = Flash, strong / frontier = Pro). */
async function readModelNames(): Promise<Map<string, ModelName>> {
  return new Map((await readModelIds()).map((m) => [m.modelId, { label: m.displayName, tier: m.capabilityTier === "cheap" ? "Flash" : "Pro" } as ModelName]));
}

/**
 * What every cold email workflow's runnable version writes with now (RESEARCH-PAGES-ALL-1018). Unreadable = every
 * workflow states `workflow_definitions_unreadable` (logged), never a guessed template.
 */
async function readDynastyWriters(featureSlug: string = COLD_EMAIL): Promise<{ now: Map<string, DynastyWriter>; last: Map<string, DynastyWriter>; byVersion: Map<string, VersionWriter> } | WriterReason> {
  try {
    const [definitions, models] = await Promise.all([fetchWorkflowDefinitions(featureSlug), readModelIds()]);
    const last = dynastyLastWriters(definitions, models);
    return { now: dynastyWriters(definitions, models), last, byVersion: versionWriters(definitions, models, last) };
  } catch (error) {
    console.error("[features-service] research catalogue: what the workflows write with now could not be read this time:", error);
    return "workflow_definitions_unreadable";
  }
}

/**
 * Every workflow the leg ranking lists, each with a page (TPL-TACTICS-ROWS-1022: ONE source of workflows for the
 * Workflows list and the catalogue, so every ranking row finds its page and its icon); `runnable` = a run may still pick it.
 */
export function runnableWorkflowsOf(rows: readonly Pick<LegWorkflowRankingRow, "workflowDynastySlug" | "workflowDynastyName" | "selectable">[] | null) {
  if (!rows) return null;
  return rows.map((r) => ({ key: r.workflowDynastySlug, label: r.workflowDynastyName ? shortName(r.workflowDynastyName) : r.workflowDynastySlug, name: r.workflowDynastyName || null, runnable: r.selectable }));
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
  /** Per-MODEL bars, the detail of each LLM dynasty bar (LLM-DYNASTY-1022-FS). */
  modelVersions: Array<ResearchBucket & { dynastyKey: string }>;
  /** Model id / alias → its LLM bar key (dynasty slug, else model key). */
  llmKeyOf: (id: string) => string;
  /** LLM bar key → its label. */
  llmLabelOf: (key: string) => string;
  mainOf: (dynasty: string) => { model: string | null; template: string | null };
  templateVersions: ResearchBucket[];
  templateFiguresByVersion: Map<string, Map<string, VersionShare>>;
  templateVersionFiguresByVersion: Map<string, Map<string, VersionShare>>;
  modelFiguresByVersion: Map<string, Map<string, VersionShare>>;
  modelVersionFiguresByVersion: Map<string, Map<string, VersionShare>>;
  workflowVersionTotals: Map<string, VersionShare>;
}

const NO_GEN: CatalogGen = {
  templates: [],
  models: [],
  modelLabel: (id) => id,
  modelVersions: [],
  llmKeyOf: (id) => id,
  llmLabelOf: (key) => key,
  mainOf: () => ({ model: null, template: null }),
  templateVersions: [],
  templateFiguresByVersion: new Map(),
  templateVersionFiguresByVersion: new Map(),
  modelFiguresByVersion: new Map(),
  modelVersionFiguresByVersion: new Map(),
  workflowVersionTotals: new Map(),
};

/**
 * PURE. The model and template (dynasty, else version) most of a dynasty's people (people emailed) were written with. The
 * model is tallied per LLM bar (`llmKeyOf`: its LLM dynasty), and the winner is named by its most used model id.
 */
function mainsByDynasty(persons: readonly FleetPersonBucket[], dynastyOf: ReadonlyMap<string, string>, screened: boolean, templateKeyOf: (id: string) => string, llmKeyOf: (id: string) => string = (id) => id) {
  const tally = new Map<string, { models: Map<string, number>; templates: Map<string, number> }>();
  for (const b of persons) {
    if (!b.generation) continue;
    const d = dynastyOf.get(b.workflowSlug) ?? b.workflowSlug;
    const t = tally.get(d) ?? { models: new Map(), templates: new Map() };
    tally.set(d, t);
    const c = (screened ? b.screenedContacted : b.contacted) || 0.0001;
    t.models.set(b.generation.model, (t.models.get(b.generation.model) ?? 0) + c);
    const lk = `llm:${llmKeyOf(b.generation.model)}`;
    t.models.set(lk, (t.models.get(lk) ?? 0) + c);
    if (b.generation.promptType) {
      const k = templateKeyOf(b.generation.promptType);
      t.templates.set(k, (t.templates.get(k) ?? 0) + c);
    }
  }
  const top = (m: Map<string, number> | undefined) => (m && m.size ? [...m].sort((a, b) => b[1] - a[1])[0]![0] : null);
  const topModel = (m: Map<string, number> | undefined) => {
    if (!m) return null;
    const bar = top(new Map([...m].filter(([k]) => k.startsWith("llm:"))));
    if (!bar) return null;
    return top(new Map([...m].filter(([k]) => !k.startsWith("llm:") && `llm:${llmKeyOf(k)}` === bar)));
  };
  return (dynasty: string) => ({ model: topModel(tally.get(dynasty)?.models), template: top(tally.get(dynasty)?.templates) });
}

/** The studies of what wrote the emails; none while the fleet person cell carries no generation yet (its ids stay waiting). */
async function generationInputs(
  reply: ColdEmailPipeRead,
  visit: ColdEmailPipeRead,
  note: string,
  dynasties: { reply: TemplateDynastyIndex; visit: TemplateDynastyIndex; llm: LlmDynastyIndex },
): Promise<GenerationPart> {
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
    templateDynasties: pipe === POSITIVE_REPLY_PIPE ? dynasties.reply : dynasties.visit,
    llmDynasties: dynasties.llm,
    view: r.input.view,
  });
  const partOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead): CatalogGen => {
    const g = generationBuckets(inputOf(pipe, r));
    const dyn = pipe === POSITIVE_REPLY_PIPE ? dynasties.reply : dynasties.visit;
    return {
      templates: g.tpl.rows,
      models: g.llm.rows,
      modelLabel: g.modelLabel,
      modelVersions: g.llmModels,
      llmKeyOf: g.llmKeyOf,
      llmLabelOf: g.llmLabelOf,
      mainOf: mainsByDynasty(r.persons, r.input.dynastyOf, r.split.screened, dyn.keyOf, g.llmKeyOf),
      templateVersions: g.tplVersions,
      templateFiguresByVersion: g.tplFiguresByVersion,
      templateVersionFiguresByVersion: g.tplVersionFiguresByVersion,
      modelFiguresByVersion: g.llmFiguresByVersion,
      modelVersionFiguresByVersion: g.llmModelFiguresByVersion,
      workflowVersionTotals: g.workflowVersionTotals,
    };
  };
  return {
    studies: [...generationStudies(inputOf(POSITIVE_REPLY_PIPE, reply)), ...generationStudies(inputOf(WEBSITE_VISIT_PIPE, visit))],
    reply: partOf(POSITIVE_REPLY_PIPE, reply),
    visit: partOf(WEBSITE_VISIT_PIPE, visit),
    templateTexts,
  };
}

/** The studies read on each email sent; null while our copy of the outreach facts holds no send of these legs yet. */
type SpendScope = { campaignIds: string[]; campaigns: ReadonlyArray<{ campaignId: string; orgId: string }>; cutoffIso: string | null };
async function sendsInputs(reply: SpendScope, visit: SpendScope, pricing: Pricing, view: ResearchView, now: Date) {
  // The flash view reads every send to date (MATURITY-VIEW-1023): no cutoff, the opens split cut at the read.
  if (view === "flash") {
    reply = { ...reply, cutoffIso: null };
    visit = { ...visit, cutoffIso: null };
  }
  const opensCutoff = view === "flash" ? now.toISOString() : reply.cutoffIso;
  const [rg, vg] = await Promise.all([readSendGroups(reply.campaignIds, reply.cutoffIso), readSendGroups(visit.campaignIds, visit.cutoffIso)]);
  if (!rg.length && !vg.length) return null;
  const prices = Object.fromEntries(await readPerEmailPrices());
  // On the vendor basis the per-email charges are scaled by the leg's vendor ÷ billed spend (the rollup states billed).
  const splitOf = async (r: SpendScope) => {
    const total = await readLegSpendTotal(COLD_EMAIL, r.campaigns, pricing, r.cutoffIso);
    if (pricing === "gross") return { totalUsd: total, perEmailUsdByMonth: prices };
    const billed = await readLegSpendTotal(COLD_EMAIL, r.campaigns, "gross", r.cutoffIso);
    const k = billed > 0 ? total / billed : 0;
    return { totalUsd: total, perEmailUsdByMonth: Object.fromEntries(Object.entries(prices).map(([m, v]) => [m, v * k])) };
  };
  const rs = await splitOf(reply);
  const vs = await splitOf(visit);
  const opens = opensCutoff ? await readOpensArms(opensCutoff) : null;
  return { reply: { groups: rg, spend: rs }, visit: { groups: vg, spend: vs }, opens };
}

/**
 * "How long before a first positive reply?" (TTFPR-RESEARCH-STUDY-1021): lead-service's one figure (first message, any
 * channel -> first positive reply, since inception) over EVERY org's campaigns whose leg ends on a positive reply
 * (`isReplyPipe`, the campaign page's own test), as ONE group so its percentiles are the fleet's. Fails loud.
 */
/**
 * The orgs the country study leaves out (RESEARCH-COUNTRY-1021: our own and staff test accounts): every org of the two
 * cold email legs whose every member is staff (`isStaffOnlyOrg`, billing-service's `staff_test_org` rule). Throws when a
 * member list cannot be read (the study then says it is not readable, never counts a staff org as a client).
 */
async function readOurOrgIds(orgIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await mapWithConcurrency([...new Set(orgIds)], 6, async (orgId) => {
    if (isStaffOnlyOrg(await fetchOrgUserEmails(orgId))) out.add(orgId);
  });
  return out;
}

/** Every country study (two per cold email pipe + meetings), or each one saying it is not readable. */
async function countryStudiesOf(reply: ColdEmailPipeRead, visit: ColdEmailPipeRead, note: string, booked: Promise<{ reportingBrandIds: Set<string>; booked: Set<string> } | null>): Promise<ResearchStudy[]> {
  try {
    const [ours, replierCountries, meetings] = await Promise.all([
      readOurOrgIds([...reply.campaigns, ...visit.campaigns].map((c) => c.orgId)),
      fetchFleetReplierCountries(COLD_EMAIL),
      booked,
    ]);
    const pipe = (id: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead) =>
      countryStudies({ terms: termsOf(id, r.input, note), legKey: r.input.legKey, cells: r.input.cells, persons: r.persons, split: r.split, excludedOrgIds: ours, view: r.input.view });
    const repliers = [...replierCountries].map(([k, country]) => {
      const [orgId = "", brandId = "", leadId = ""] = k.split("|");
      return { orgId, brandId, leadId, country };
    });
    return [
      ...pipe(POSITIVE_REPLY_PIPE, reply),
      ...pipe(WEBSITE_VISIT_PIPE, visit),
      countryMeetingStudy({ repliers, reportingBrandIds: meetings?.reportingBrandIds ?? null, booked: meetings?.booked ?? new Set(), excludedOrgIds: ours }),
    ];
  } catch (err) {
    console.error("[features-service] research: the country studies could not be built this time:", err);
    const reason = "The accounts or the fleet person cell could not be read this time; the study comes back on the next refresh.";
    const no = (id: string, pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE | null, goal: "rate" | "roi", question: string): ResearchStudy => ({
      id,
      pipe,
      ...(pipe ? {} : { outcome: "meeting" as const }),
      topic: "country",
      goal,
      question,
      status: "not_enough_data",
      headline: "Not readable right now.",
      winner: null,
      crowned: false,
      verdict: { kind: "noise", reason },
      result: null,
      charts: [],
      conclusion: [reason],
    });
    return [
      no(`${POSITIVE_REPLY_PIPE}-country-rate`, POSITIVE_REPLY_PIPE, "rate", "Which prospect country gets the most positive replies?"),
      no(`${POSITIVE_REPLY_PIPE}-country-roi`, POSITIVE_REPLY_PIPE, "roi", "Which prospect country gets the cheapest positive reply?"),
      no(`${WEBSITE_VISIT_PIPE}-country-rate`, WEBSITE_VISIT_PIPE, "rate", "Which prospect country gets the most website visits?"),
      no(`${WEBSITE_VISIT_PIPE}-country-roi`, WEBSITE_VISIT_PIPE, "roi", "Which prospect country gets the cheapest website visit?"),
      no("meeting-country-rate", null, "rate", "Which prospect country books the most meetings after a positive reply?"),
    ];
  }
}

/**
 * PURE. Each campaign's declared output = the `to` step of its stated (channel, leg) in the catalogue, never inferred
 * from a key's spelling; every step a catalogue pipe ends on. A campaign stating no leg, or a leg the catalogue does not
 * list, has no output (its spend is unattributed).
 */
export function campaignOutputsOf(
  rows: readonly unknown[],
  channels: ReadonlyArray<{ slug: string; stepTransitions: ReadonlyArray<{ legKey: string; to: { key: string } }> }>,
): { outputOf: (campaignId: string) => string | null; pipeOutputs: Set<string> } {
  const toOf = new Map<string, string>();
  const pipeOutputs = new Set<string>();
  for (const c of channels) {
    for (const t of c.stepTransitions) {
      toOf.set(`${c.slug}|${pipeLegKeyOf(c.slug, t.legKey)}`, t.to.key);
      pipeOutputs.add(t.to.key);
    }
  }
  const byCampaign = new Map<string, string>();
  for (const raw of rows) {
    const r = raw as { id?: unknown; featureSlug?: unknown; legKey?: unknown };
    if (typeof r.id !== "string" || typeof r.featureSlug !== "string" || typeof r.legKey !== "string") continue;
    const to = toOf.get(`${r.featureSlug}|${pipeLegKeyOf(r.featureSlug, r.legKey)}`);
    if (to) byCampaign.set(r.id, to);
  }
  return { outputOf: (id) => byCampaign.get(id) ?? null, pipeOutputs };
}

/**
 * PURE. One row per client (org): its ledger roll-up of the positive reply beside today's figure (its reply pipes'
 * spend ÷ its positive replies, the person cell's). `labelOf(org)` names the client.
 */
export function clientCostRowsOf(
  byOrg: ReadonlyMap<string, { units: ReadonlyMap<string, import("../lib/outcome-unit-costs.js").OutcomeUnitCost> }>,
  coverageByOrg: ReadonlyMap<string, number | null>,
  persons: ReadonlyArray<{ orgId: string; positiveReplies: number }>,
  spend: ReadonlyArray<{ orgId: string; spentUsd: number }>,
  labelOf: (orgId: string) => string,
): ClientCostRow[] {
  const replies = new Map<string, number>();
  for (const p of persons) replies.set(p.orgId, (replies.get(p.orgId) ?? 0) + p.positiveReplies);
  const spent = new Map<string, number>();
  for (const s of spend) spent.set(s.orgId, (spent.get(s.orgId) ?? 0) + s.spentUsd);
  const orgs = new Set([...byOrg.keys(), ...[...replies].filter(([, v]) => v > 0).map(([o]) => o)]);
  return [...orgs].map((orgId) => ({
    orgId,
    label: labelOf(orgId),
    ledger: byOrg.get(orgId)?.units.get("conversation") ?? null,
    coveragePct: coverageByOrg.get(orgId) ?? null,
    todaySpendUsd: spent.get(orgId) ?? 0,
    todayReplies: replies.get(orgId) ?? 0,
  }));
}

/** The per-workflow ledger study of the positive reply pipe, beside its ranking (COST-ACCOUNTING-1023-P4). */
async function workflowLedgerStudyOf(
  ledger: { totals: OutcomeLedgerTotals | null; outputOf: (c: string) => string | null; pipeOutputs: ReadonlySet<string> },
  input: ColdEmailPipeInput,
) {
  const byWorkflow = ledger.totals
    ? await fetchOutcomeLedgerByWorkflow("gross").catch((err): null => {
        console.error("[features-service] research: the outcome ledger by workflow is unreadable this time (its study says so):", err);
        return null;
      })
    : null;
  if (!ledger.totals || !byWorkflow) return workflowLedgerStudy({ pipe: POSITIVE_REPLY_PIPE, rows: null, floorReason: null });
  const fleet = rollUpOutcomeUnitCosts(ledger.totals.produced, ledger.totals.consumed, ledger.outputOf, ledger.pipeOutputs).units.get("conversation");
  if (!fleet) return workflowLedgerStudy({ pipe: POSITIVE_REPLY_PIPE, rows: [], floorReason: null });
  const dyn = (slug: string | null) => (slug ? (input.dynastyOf.get(slug) ?? slug) : null);
  const rows = workflowUnitCosts(
    "conversation",
    byWorkflow.produced.map((r) => ({ ...r, workflowSlug: dyn(r.workflowSlug) })),
    byWorkflow.sourced.map((c) => ({ ...c, sourceWorkflowSlug: dyn(c.sourceWorkflowSlug) })),
    ledger.outputOf,
    fleet,
  );
  const ranking = new Map((input.rankingRows ?? []).map((r) => [r.workflowDynastySlug, r]));
  // Only this pipe's workflows: a send another pipe made (a follow-up, a PR email) is no cold email workflow's figure.
  const ownDynasties = new Set([...input.dynastyOf.values(), ...ranking.keys()]);
  const cov = ledger.totals.coveragePct;
  const missing = Math.max(ledger.totals.daysMissing, byWorkflow.daysMissing);
  const floorReason =
    cov === null || cov < COVERAGE_BAR_PCT || missing > 0
      ? `The ledger holds ${cov === null ? "an unknown share" : `${Math.round(cov)}%`} of the outcome spend (support apart)${missing > 0 ? `, ${missing} days still computing` : ""}: every figure is a floor.`
      : null;
  return workflowLedgerStudy({
    pipe: POSITIVE_REPLY_PIPE,
    floorReason,
    rows: rows.filter((r) => ownDynasties.has(r.workflowSlug) && r.ownCostUsd > 0).map((r) => {
      const rank = ranking.get(r.workflowSlug);
      return { key: r.workflowSlug, label: input.labelOf(r.workflowSlug), outcomes: r.outcomes, ownCostUsd: r.ownCostUsd, unitCostUsd: r.unitCostUsd, todayCostUsd: rank?.costPerOutcomeUsd ?? null, todayBasis: rank ? rank.basis : null };
    }),
  });
}

/** The per-client study; a client is named by the brand most of its people were contacted for (brand-service names). */
async function clientCostStudyOf(
  ledger: { totals: OutcomeLedgerTotals | null; outputOf: (c: string) => string | null; pipeOutputs: ReadonlySet<string> },
  persons: ReadonlyArray<{ orgId: string; brandId: string; contacted: number; positiveReplies: number }>,
  spend: ReadonlyArray<{ orgId: string; spentUsd: number }>,
) {
  if (!ledger.totals) return outcomeCostByClientStudy(null, 0);
  const t = ledger.totals;
  const byOrg = rollUpByOrg(t.produced, t.consumed, ledger.outputOf, ledger.pipeOutputs);
  const brandOf = new Map<string, Map<string, number>>();
  for (const p of persons) {
    const m = brandOf.get(p.orgId) ?? new Map<string, number>();
    m.set(p.brandId, (m.get(p.brandId) ?? 0) + p.contacted);
    brandOf.set(p.orgId, m);
  }
  const mainBrand = new Map([...brandOf].map(([o, m]) => [o, [...m].sort((a, b) => b[1] - a[1])[0]![0]] as [string, string]));
  const names = await fetchBrandsBasic([...mainBrand.values()]).catch((err) => {
    console.error("[features-service] research: brand names unreadable, clients named by their org:", err);
    return new Map<string, { name: string | null }>();
  });
  // A client none of whose people the reply pipe holds (its replies came another way) is named by its org record.
  const unnamed = [...byOrg.keys()].filter((o) => !mainBrand.has(o));
  const orgNames = new Map(
    await Promise.all(
      unnamed.map(async (o) => [o, await fetchOrgName(o).catch((err): null => {
        console.error(`[features-service] research: org ${o} name unreadable:`, err);
        return null;
      })] as [string, string | null]),
    ),
  );
  const labelOf = (org: string) => {
    const b = mainBrand.get(org);
    const name = b ? names.get(b)?.name : orgNames.get(org);
    const more = (brandOf.get(org)?.size ?? 1) - 1;
    return name ? `${name}${more > 0 ? ` +${more}` : ""}` : "Unnamed client";
  };
  return outcomeCostByClientStudy(clientCostRowsOf(byOrg, t.coverageByOrg, persons, spend, labelOf), t.daysMissing);
}

/**
 * PURE. The reply pipe's people per workflow DYNASTY (every version pooled), by serve day, with each dynasty's lifetime
 * billed spend (its ranking row's flash gross spend). A bucket with no serve day has no age: left out, never counted as mature.
 */
export function workflowEstimateGroupsOf(
  persons: ReadonlyArray<{ workflowSlug: string; servedDay: string; contacted: number; positiveReplies: number }>,
  dynastyOf: ReadonlyMap<string, string>,
  rows: ReadonlyArray<{ workflowDynastySlug: string; basis: "mature" | "flash"; spentUsd: number; figuresByView?: { flash: { spentUsd: { value: number | null } } } }>,
  labelOf: (dynasty: string) => string,
  now: Date,
): WorkflowEstimateGroup[] {
  const today = Date.parse(now.toISOString().slice(0, 10));
  const by = new Map<string, WorkflowEstimateGroup>();
  for (const p of persons) {
    if (!p.servedDay) continue;
    const d = dynastyOf.get(p.workflowSlug) ?? p.workflowSlug;
    const g = by.get(d) ?? { key: d, label: labelOf(d), slices: [], outcomes: 0, spendUsd: 0 };
    g.slices.push({ contacted: p.contacted, ageDays: (today - Date.parse(p.servedDay)) / 86_400_000 + 0.5 });
    g.outcomes += p.positiveReplies;
    by.set(d, g);
  }
  for (const r of rows) {
    const g = by.get(r.workflowDynastySlug);
    // Lifetime GROSS incurred spend, the measured workflow study's own basis (its flash half): never the net billed
    // figure, which read Ballad $94 beside its measured $141 (probe 2026-10-23).
    if (g) g.spendUsd = r.figuresByView?.flash.spentUsd.value ?? (r.basis === "flash" ? r.spentUsd : 0);
  }
  return [...by.values()];
}

type EstimatePerson = { workflowSlug: string; servedDay: string; contacted: number; positiveReplies: number };
type SpendRow = { workflowDynastySlug: string; basis: "mature" | "flash"; spentUsd: number; figuresByView?: { flash: { spentUsd: { value: number | null } } } };

/**
 * PURE. The reply pipe's people per PART (a template dynasty, an LLM dynasty: `partOf`, null = no writer on record), by
 * serve day (PERF-ESTIMATE-DISCUSS-1024). Spend: each workflow dynasty's lifetime gross spend (the workflow card's) shared
 * on its people, so the parts add up to the workflows. A person with no writer is left out and counted, never spread.
 */
export function partEstimateGroupsOf<P extends EstimatePerson>(
  persons: readonly P[],
  partOf: (p: P) => { key: string; label: string } | null,
  dynastyOf: ReadonlyMap<string, string>,
  rows: readonly SpendRow[],
  now: Date,
): { groups: WorkflowEstimateGroup[]; peopleLeftOut: number } {
  const today = Date.parse(now.toISOString().slice(0, 10));
  const dyn = (slug: string) => dynastyOf.get(slug) ?? slug;
  const spendOf = new Map(rows.map((r) => [r.workflowDynastySlug, r.figuresByView?.flash.spentUsd.value ?? (r.basis === "flash" ? r.spentUsd : 0)]));
  const people = new Map<string, number>();
  for (const p of persons) people.set(dyn(p.workflowSlug), (people.get(dyn(p.workflowSlug)) ?? 0) + p.contacted);
  const by = new Map<string, WorkflowEstimateGroup>();
  let peopleLeftOut = 0;
  for (const p of persons) {
    if (!p.servedDay) continue;
    const part = partOf(p);
    if (!part) {
      peopleLeftOut += p.contacted;
      continue;
    }
    const d = dyn(p.workflowSlug);
    const g = by.get(part.key) ?? { key: part.key, label: part.label, slices: [], outcomes: 0, spendUsd: 0 };
    g.slices.push({ contacted: p.contacted, ageDays: (today - Date.parse(p.servedDay)) / 86_400_000 + 0.5 });
    g.outcomes += p.positiveReplies;
    const all = people.get(d) ?? 0;
    if (all > 0) g.spendUsd += ((spendOf.get(d) ?? 0) * p.contacted) / all;
    by.set(part.key, g);
  }
  return { groups: [...by.values()], peopleLeftOut };
}

/** PURE. The replay's buckets of one part (ESTIMATE-REPLAY-1024): every served person bucket with its reply day. */
export function replayBucketsOf<P extends EstimatePerson & { positiveReplyDay?: string | null }>(persons: readonly P[], partOf: (p: P) => { key: string; label: string } | null): ReplayBucket[] {
  return persons.flatMap((p) => {
    const part = p.servedDay ? partOf(p) : null;
    return part ? [{ ...part, servedDay: p.servedDay, contacted: p.contacted, positiveReplies: p.positiveReplies, positiveReplyDay: p.positiveReplyDay ?? null }] : [];
  });
}

async function readReplyDelay(): Promise<ReplyDelayRead> {
  const rows = await fetchFleetCampaignRows();
  const ids = [
    ...new Set(
      rows.flatMap((raw) => {
        const c = raw as { id?: unknown; legKey?: unknown };
        return typeof c.id === "string" && typeof c.legKey === "string" && isReplyPipe(c.legKey) ? [c.id] : [];
      }),
    ),
  ];
  if (ids.length === 0) {
    return { campaigns: 0, metric: { sampleSize: 0, medianMs: null, averageMs: null, percentilesMs: { p10: null, p25: null, p50: null, p75: null, p90: null }, distribution: [], dailyDistribution: [] } };
  }
  return { campaigns: ids.length, metric: await fetchReplyDelayDistribution(ids) };
}

/** The whole file, computed IN THIS PROCESS (the refresher, or the server when it is off). */
export async function computeResearch(basis: Basis, view: ResearchView = "mature", now = new Date()): Promise<ResearchBuild> {
  const meetingRule = legMaturity(MEETING_BOOKING_LEG_KEY);
  // Every other pipe of the catalogue holding a workflow (WA-PIPE-RESEARCH-1023): unreadable = the three alone, logged.
  const otherPipesP = readOtherPipes().catch((err): OtherPipe[] => {
    console.error("[features-service] research: the channel catalogue or the workflow assignments could not be read, the other pipes are left out this build:", err);
    return [];
  });
  // Each pipe's template dynasties (never throws: unreadable = every version on its own page, said so).
  // And the LLM dynasties (chat-service, LLM-DYNASTY-1022-FS; unreadable = every model on its own page, said so).
  const dynastiesP = Promise.all([readTemplateDynasties(COLD_EMAIL, REPLY_LEG), readTemplateDynasties(COLD_EMAIL, VISIT_LEG), readLlmDynastiesSoft("research")]).then(([r, v, l]) => ({
    reply: templateDynastyIndex(r),
    visit: templateDynastyIndex(v),
    llm: llmDynastyIndex(l),
  }));
  // The two legs in turn on the vendor basis (one heavy aggregation at a time), together on the billed one.
  const legs =
    basis === "actual"
      ? (async () => {
          const r = await coldEmailPipe(REPLY_LEG, basis, now, { view });
          return [r, await coldEmailPipe(VISIT_LEG, basis, now, { view })] as const;
        })()
      : Promise.all([coldEmailPipe(REPLY_LEG, basis, now, { view }), coldEmailPipe(VISIT_LEG, basis, now, { view })]);
  const [[reply, visit], meetingRanking, meetingFleet, beforeAfter, recordedBest, recordedMedian] = await Promise.all([
    legs,
    basis === "user" ? readLegWorkflowRanking(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, RANKING_WAIT_MS) : Promise.resolve(null),
    basis === "user" ? getInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked") : Promise.resolve(null),
    fetchMeetingBookingBeforeAfter(),
    basis === "user" ? readFleetIndexSeries(MEETING_RESEARCH_BEST_SLUG) : Promise.resolve([]),
    basis === "user" ? readFleetIndexSeries(MEETING_RESEARCH_MEDIAN_SLUG) : Promise.resolve([]),
  ]);
  // The meeting pipe's two articles over time: the days recorded so far, today's computed live (MB-INDEX-PIPES-1018).
  const meetingSeries =
    meetingRanking && meetingFleet
      ? meetingSeriesOf(
          recordedBest,
          recordedMedian,
          { day: now.toISOString().slice(0, 10), points: meetingResearchPoints(bestMeetingPipePick({ rows: meetingRanking.rows, pooled: meetingFleet.pooled }), meetingFleet.byOrg) },
          (d) => meetingRanking.rows.find((r) => r.workflowDynastySlug === d)?.workflowDynastyName ?? d,
        )
      : null;
  // ONE read of lead-service's meeting attribution, shared by the meeting-cost and country studies.
  const attribution = readMeetingAttribution();
  attribution.catch(() => undefined);
  // The outcome ledger (COST-ACCOUNTING-1023-P2): every outcome section's every-path cost. Unreadable = its studies say so.
  const ledgerP = Promise.all([
    fetchOutcomeLedgerTotals(basis === "actual" ? "vendor" : "gross").catch((err): OutcomeLedgerTotals | null => {
      console.error("[features-service] research: runs-service's outcome ledger totals unreadable this time (the cost studies say so):", err);
      return null;
    }),
    listDeclaredSteps().catch((err) => {
      console.error("[features-service] research: declared steps unreadable, step keys printed as is:", err);
      return [];
    }),
    // Which step each campaign's leg ends on (its declared output, rule 3) and every step a catalogue pipe ends on.
    // Unreadable = the ledger read is unusable this build (its studies say not readable), never a guessed output.
    Promise.all([fetchFleetCampaignRows(), loadChannelCatalogue({ publishedOnly: false })]).catch((err): null => {
      console.error("[features-service] research: campaigns or channel catalogue unreadable, the outcome cost studies say not readable:", err);
      return null;
    }),
  ]).then(([totals, declared, pipes]) => {
    const names = new Map<string, string>([...Object.entries(CHANNEL_STEPS).map(([k, v]) => [k, v.label] as [string, string]), ...declared.map((d) => [d.key, d.label] as [string, string])]);
    const { outputOf, pipeOutputs } = pipes ? campaignOutputsOf(pipes[0], pipes[1].channels) : { outputOf: () => null, pipeOutputs: new Set<string>() };
    return { totals: pipes ? totals : null, labelOf: (k: string) => names.get(k) ?? k, outputOf, pipeOutputs };
  });
  const [sends, jev, replies, gens, reportingBrands, volume, replyDelay, countries, niche] = await Promise.all([
    sendsInputs(reply, visit, basis === "actual" ? "vendor" : "gross", view, now),
    readJevInputs(),
    readReplyAuthors(),
    // A study family whose producer read fails stays waiting (logged), never fails the whole file.
    dynastiesP.then((d) => generationInputs(reply, visit, ruleNote(reply.input, visit.input), d)).catch((err): GenerationPart => {
      console.error("[features-service] research: the studies of what wrote the emails could not be built this time:", err);
      return { studies: [], reply: NO_GEN, visit: NO_GEN, templateTexts: new Map() };
    }),
    basis === "user" ? readReportingBrands(attribution) : Promise.resolve(null),
    readVolume(reply, visit).catch((err) => {
      console.error("[features-service] research: page-wide counts unreadable this time:", err);
      return null;
    }),
    readReplyDelay().catch((err): null => {
      console.error("[features-service] research: time to a first positive reply unreadable this time (the study says so):", err);
      return null;
    }),
    countryStudiesOf(reply, visit, ruleNote(reply.input, visit.input), readBookedAfterReply(attribution)),
    // Each client's niche grade (RESEARCH-NICHE-1021): judged once by Jev, stored; unreadable = the studies say so.
    readNicheGrades([...reply.campaigns, ...visit.campaigns]).catch((err): null => {
      console.error("[features-service] research: the clients' niche grades could not be read this time (the studies say so):", err);
      return null;
    }),
  ]);
  const nicheNote = ruleNote(reply.input, visit.input);
  const niche_ = nicheStudies({
    reply: { terms: termsOf(POSITIVE_REPLY_PIPE, reply.input, nicheNote), legKey: reply.input.legKey, cells: reply.input.cells, persons: reply.persons, split: reply.split, view },
    visit: { terms: termsOf(WEBSITE_VISIT_PIPE, visit.input, nicheNote), legKey: visit.input.legKey, cells: visit.input.cells, persons: visit.persons, split: visit.split, view },
    grades: niche,
    ...(basis === "user"
      ? { meetings: { brands: reportingBrands, outcomesRequired: legMaturity("start_to_meeting_booked").outcomesRequired, note: nicheNote } }
      : {}),
  });
  const workflowsWithPeople = new Set(
    [reply, visit].flatMap((r) => workflowBuckets(r.input).filter((b) => b.figures.contacted > 0).map((b) => b.key)),
  ).size;
  const noRunStart = Math.round(
    [reply, visit].reduce((a, r) => a + r.persons.filter((b) => !b.servedDay).reduce((x, b) => x + (r.split.screened ? b.screenedContacted : b.contacted), 0), 0),
  );
  // The estimated workflow study (COST-ACCOUNTING-1023-P3): billed basis only (it divides the ranking's billed spend).
  const estimateStudies = reply.input.rankingRows
    ? [
        workflowEstimateStudy({
          pipe: POSITIVE_REPLY_PIPE,
          groups: workflowEstimateGroupsOf(reply.persons, reply.input.dynastyOf, reply.input.rankingRows, reply.input.labelOf, now),
          dayBins: replyDelay ? replyDelay.metric.dailyDistribution : null,
          outcomesRequired: reply.input.outcomesRequired,
        }),
      ]
    : [];
  // The template and LLM estimates beside the workflow's, and the replay of all three (PERF-ESTIMATE-DISCUSS-1024).
  if (reply.input.rankingRows) {
    const rows = reply.input.rankingRows;
    const dayBins = replyDelay ? replyDelay.metric.dailyDistribution : null;
    const tplDyn = (await dynastiesP).reply;
    const workflowOf = (p: FleetPersonBucket) => {
      const d = reply.input.dynastyOf.get(p.workflowSlug) ?? p.workflowSlug;
      return { key: d, label: reply.input.labelOf(d) };
    };
    const templateOf = (p: FleetPersonBucket) => {
      const t = p.generation?.promptType;
      return t ? { key: tplDyn.keyOf(t), label: tplDyn.labelOf(tplDyn.keyOf(t)) } : null;
    };
    const llmOf = (p: FleetPersonBucket) => (p.generation ? { key: gens.reply.llmKeyOf(p.generation.model), label: gens.reply.llmLabelOf(gens.reply.llmKeyOf(p.generation.model)) } : null);
    for (const [dim, partOf] of [
      [TEMPLATE_DIMENSION, templateOf],
      [LLM_DIMENSION, llmOf],
    ] as const) {
      const { groups, peopleLeftOut } = partEstimateGroupsOf(reply.persons, partOf, reply.input.dynastyOf, rows, now);
      estimateStudies.push(estimateStudy(dim, { pipe: POSITIVE_REPLY_PIPE, groups, peopleLeftOut, dayBins, outcomesRequired: reply.input.outcomesRequired }));
    }
    estimateStudies.push(
      estimateReplayStudy({
        pipe: POSITIVE_REPLY_PIPE,
        dims: [
          { label: "Workflows", buckets: replayBucketsOf(reply.persons, workflowOf) },
          { label: "Templates", buckets: replayBucketsOf(reply.persons, templateOf) },
          { label: "LLMs", buckets: replayBucketsOf(reply.persons, llmOf) },
        ],
        dayBins,
        outcomesRequired: reply.input.outcomesRequired,
        now,
      }),
    );
  }
  // The ledger beside today's figure, per client (COST-ACCOUNTING-1023-P4): billed basis only (today's figure is billed).
  const ledger = await ledgerP;
  const ledgerStudies = basis === "user" ? [await clientCostStudyOf(ledger, reply.persons, reply.spend)] : [];
  if (basis === "user" && reply.input.rankingRows) estimateStudies.push(await workflowLedgerStudyOf(ledger, reply.input));
  const file = assembleResearch({
    replyDelay,
    estimateStudies,
    ledgerStudies,
    outcomeLedger: ledger,
    sends,
    generationStudies: gens.studies,
    countryStudies: countries,
    nicheStudies: niche_,
    volume: volume ? { ...volume, workflows: workflowsWithPeople, noRunStart } : null,
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
      series: meetingSeries,
    },
    beforeAfter,
    meetingOutcomesRequired: meetingRule.outcomesRequired,
    otherPipes: await otherPipesP,
  });
  // The catalogue: one page per workflow, template and model, per pipe, from the same bars.
  const note = ruleNote(reply.input, visit.input);
  // Every workflow a run may still pick has a page (the actual basis reads the ranking only for this list).
  const rankingOf = async (r: ColdEmailPipeRead) =>
    r.input.rankingRows ??
    (await readLegWorkflowRanking(COLD_EMAIL, r.input.legKey, RANKING_WAIT_MS).then(
      (x) => x?.rows ?? null,
      (err) => {
        console.error(`[features-service] research catalogue: leg ranking ${r.input.legKey} unreadable, only the bars are listed:`, err);
        return null;
      },
    ));
  const [replyRuns, visitRuns, replyGens, visitGens, replyCosts, visitCosts, replyRanking, visitRanking, writers] = await Promise.all([
    readWorkflowRuns(reply.campaigns, (slug) => reply.input.dynastyOf.get(slug) ?? slug, basis),
    readWorkflowRuns(visit.campaigns, (slug) => visit.input.dynastyOf.get(slug) ?? slug, basis),
    readGenerationRuns(reply.campaignIds).catch(() => []),
    readGenerationRuns(visit.campaignIds).catch(() => []),
    pipeGenerationCosts(basis, reply.campaignIds),
    pipeGenerationCosts(basis, visit.campaignIds),
    rankingOf(reply),
    rankingOf(visit),
    readDynastyWriters(),
  ]);
  const servedModels = await readModelIds().catch((err): "model_ids_unreadable" => {
    console.error("[features-service] research catalogue: chat-service model ids unreadable this time:", err);
    return "model_ids_unreadable";
  });
  // The text of every template a workflow writes with now, beside the ones its people were written with.
  // Every version's template too: a deprecated workflow's page names the template its newest writing version used.
  const dynasties = await dynastiesP;
  const dynastyVersions = [...dynasties.reply.dynasties, ...dynasties.visit.dynasties].flatMap((d) => d.versions);
  const nowTemplates = [
    ...(typeof writers === "string" ? [] : [...writers.now.values(), ...writers.last.values()].flatMap((w) => (w.ok && w.template ? [w.template] : []))),
    ...dynastyVersions,
  ];
  const nowTexts = await readTemplateTexts(nowTemplates).catch((err) => {
    console.error("[features-service] research catalogue: template texts unreadable this time:", err);
    return new Map<string, string>();
  });
  const allTexts = new Map([...gens.templateTexts, ...nowTexts]);
  const writerOf = typeof writers === "string" ? writers : (d: string) => writers.now.get(d) ?? null;
  const lastWriterOf = typeof writers === "string" ? writers : (d: string) => writers.last.get(d) ?? null;
  const catalogOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead, g: CatalogGen, runs: WorkflowRun[], gensRuns: GenerationRun[], ranking: readonly LegWorkflowRankingRow[] | null, genCosts: Awaited<ReturnType<typeof pipeGenerationCosts>>) =>
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
      templateDynasties: pipe === POSITIVE_REPLY_PIPE ? dynasties.reply : dynasties.visit,
      llmDynasties: dynasties.llm,
      modelVersions: g.modelVersions,
      templateVersions: g.templateVersions,
      generationRuns: gensRuns,
      generationCosts: genCosts,
      templateTexts: new Set(allTexts.keys()),
      runnableWorkflows: runnableWorkflowsOf(ranking),
      writerOf,
      lastWriterOf,
      servedModels,
      workflowReturns: ranking
        ? {
            roiOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.roiMultiple])),
            moneyGoesHere: ranking.find((x) => x.moneyGoesHere)?.workflowDynastySlug ?? null,
            // A ranking cell persisted before TPL-ROI-OWN-1022 carries no terms: unknown until its next rebuild.
            pipelineOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.pipelineUsd ?? null])),
            billedOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.billedSpendUsd ?? null])),
          }
        : undefined,
      templateFiguresByVersion: g.templateFiguresByVersion,
      templateVersionFiguresByVersion: g.templateVersionFiguresByVersion,
      modelFiguresByVersion: g.modelFiguresByVersion,
      modelVersionFiguresByVersion: g.modelVersionFiguresByVersion,
      workflowVersionTotals: g.workflowVersionTotals,
    });
  // The Performance tab (RESEARCH-PERFORMANCE-1023): every (workflow, template, LLM) combination of each pipe, same evidence.
  const performanceOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead, g: CatalogGen, ranking: readonly LegWorkflowRankingRow[] | null, pipeCatalogue: ResearchCatalog[string], aliasStatus: AliasStatus): PipePerformance => {
    const t = termsOf(pipe, r.input, note);
    const onBars = (bars: ResearchBucket[]) => pipePerformance({
      pipe,
      noun: t.noun,
      nounPlural: t.nounPlural,
      featureSlug: COLD_EMAIL,
      legKey: r.input.legKey,
      cells: r.input.cells,
      persons: r.persons,
      split: r.split,
      // The Workflows tab's bars: each workflow's rows add up to its bar (one figure per pipe on both tabs).
      bars,
      dynastyOf: (slug) => r.input.dynastyOf.get(slug) ?? slug,
      workflowLabelOf: r.input.labelOf,
      workflowNameOf: (d) => r.names.get(d) ?? null,
      writerOfVersion: typeof writers === "string" ? undefined : (slug) => writers.byVersion.get(slug) ?? null,
      templateDynasties: pipe === POSITIVE_REPLY_PIPE ? dynasties.reply : dynasties.visit,
      llmDynasties: dynasties.llm,
      llmKeyOf: g.llmKeyOf,
      llmLabelOf: g.llmLabelOf,
      workflowReturns: ranking
        ? {
            roiOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.roiMultiple])),
            moneyGoesHere: ranking.find((x) => x.moneyGoesHere)?.workflowDynastySlug ?? null,
            pipelineOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.pipelineUsd ?? null])),
            billedOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.billedSpendUsd ?? null])),
          }
        : undefined,
      ...partsOf(pipeCatalogue, aliasStatus),
      unpricedBilledUsd: r.unpricedUsd,
      now,
    });
    // The Workflows tab's bars on the view; the order on the flash ones (PERF-ORDER-FLASH-1023).
    const shown = onBars(workflowBuckets(r.input));
    return view === "flash" ? shown : inFlashOrder(shown, onBars(workflowBuckets({ ...r.input, view: "flash" })));
  };
  const catalog: ResearchCatalog = {
    [POSITIVE_REPLY_PIPE]: withWorkflowFigures(catalogOf(POSITIVE_REPLY_PIPE, reply, gens.reply, replyRuns, replyGens, replyRanking, replyCosts), replyRanking, view),
    [WEBSITE_VISIT_PIPE]: withWorkflowFigures(catalogOf(WEBSITE_VISIT_PIPE, visit, gens.visit, visitRuns, visitGens, visitRanking, visitCosts), visitRanking, view),
    [MEETING_BOOKING_PIPE]: { workflows: [], templates: [], models: [] },
  };
  // Each pipe reads its OWN writer LLM statuses (LLM-STATUS-PER-PIPE-1023).
  const [replyAliases, visitAliases] = await Promise.all([readAliasStatus(COLD_EMAIL, reply.input.legKey), readAliasStatus(COLD_EMAIL, visit.input.legKey)]);
  const performance: ResearchPerformance = {
    [POSITIVE_REPLY_PIPE]: performanceOf(POSITIVE_REPLY_PIPE, reply, gens.reply, replyRanking, catalog[POSITIVE_REPLY_PIPE], replyAliases),
    [WEBSITE_VISIT_PIPE]: performanceOf(WEBSITE_VISIT_PIPE, visit, gens.visit, visitRanking, catalog[WEBSITE_VISIT_PIPE], visitAliases),
    // The meeting pipe's writer is a chat /complete call: no sequence names its template, so no combination yet.
    [MEETING_BOOKING_PIPE]: {
      pipe: MEETING_BOOKING_PIPE,
      figuresBasis: "workflow_bars",
      rowOrder: "cost_per_outcome",
      orderView: "flash",
      rowsCover: "all_valid_combinations",
      featureSlug: null,
      legKey: null,
      outcomeNoun: "meeting",
      outcomeNounPlural: "meetings",
      rows: [],
      totals: null,
      series: null,
      unpricedBilledUsd: 0,
      unavailableReason: "no_writer_recorded_on_pipe",
    },
  };
  // Every listed page's text: a version's under its id, a dynasty's (its head's) under the dynasty's slug.
  const listed = new Set(Object.values(catalog).flatMap((c) => c.templates.flatMap((t) => [t.key, ...t.versions.map((v) => v.key)])));
  const headTexts = Object.values(catalog).flatMap((c) =>
    c.templates.flatMap((t) => (t.dynasty?.head && allTexts.has(t.dynasty.head.key) ? [[t.key, allTexts.get(t.dynasty.head.key)!] as [string, string]] : [])),
  );
  // Every other pipe's tabs, one pipe at a time on the vendor basis (its heaviest aggregation), two on the billed one.
  const others = await mapWithConcurrency(await otherPipesP, basis === "actual" ? 1 : 2, (p) =>
    withTimeout(otherPipeSection(p, basis, now, { llm: dynasties.llm, servedModels, writersOf: readDynastyWriters }, view), OTHER_PIPE_TIMEOUT_MS, `research pipe ${p.entry.id}`).catch((err) => {
      console.error(`[features-service] research: pipe ${p.entry.id} could not be read this build, its tabs read Learning:`, err);
      return emptySection(p);
    }),
  );
  const otherTexts: Array<[string, string]> = [];
  for (const o of others) {
    catalog[o.id] = o.catalog;
    performance[o.id] = o.performance;
    otherTexts.push(...o.texts);
  }
  // The other pipes' texts first: a key the studied pipes also list keeps their entry (the sort is stable).
  const texts = Object.fromEntries([...otherTexts, ...[...allTexts].filter(([k]) => listed.has(k)), ...headTexts].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { file, catalog, texts, performance };
}

const OTHER_PIPE_TIMEOUT_MS = 3 * 60_000;

type AliasStatus = ReadonlyMap<string, "active" | "deprecated"> | null;

/** What can no longer run on the pipe, and every combination a run may pick today (RESEARCH-ALL-COMBOS-1023). */
function partsOf(catalog: ResearchCatalog[string], aliasStatus: AliasStatus) {
  const deprecated = deprecatedPartsOf(catalog, aliasStatus);
  return { deprecated, candidates: candidatePartsOf(catalog, deprecated) };
}

/** content-generation's status per writer alias ON THIS PIPE (LLM-STATUS-PER-PIPE-1023); unreadable = null (an LLM with aliases is then never called deprecated). */
async function readAliasStatus(featureSlug: string, legKey: string): Promise<AliasStatus> {
  try {
    return new Map((await readWriterModelAliases(featureSlug, servedLegKeyOf(featureSlug, legKey))).map((a) => [a.alias, a.status]));
  } catch (err) {
    console.error("[features-service] research performance: writer alias statuses unreadable, only an LLM served under no alias reads deprecated this time:", err);
    return null;
  }
}

/** The pipes the file serves beside the three studied ones: the published catalogue's pipes holding a workflow. */
async function readOtherPipes(): Promise<OtherPipe[]> {
  const [cat, assignments] = await Promise.all([loadChannelCatalogue({ publishedOnly: true }), listLegAssignments()]);
  return otherPipesOf(cat.channels, assignments, STUDIED_PIPES);
}

interface OtherSection {
  id: string;
  catalog: ResearchCatalog[string];
  performance: PipePerformance;
  texts: Array<[string, string]>;
}

const noWriterPerformance = (p: OtherPipe, noun: string, nounPlural: string): PipePerformance => ({
  pipe: p.entry.id,
  figuresBasis: "workflow_bars",
  rowOrder: "cost_per_outcome",
  orderView: "flash",
  rowsCover: "all_valid_combinations",
  featureSlug: p.featureSlug,
  legKey: p.legKey,
  outcomeNoun: noun,
  outcomeNounPlural: nounPlural,
  rows: [],
  totals: null,
  series: null,
  unpricedBilledUsd: 0,
  unavailableReason: "no_writer_recorded_on_pipe",
});

/** A pipe whose evidence could not be read this build: listed, every tab empty (Learning), never hidden. */
function emptySection(p: OtherPipe): OtherSection {
  const t = otherPipeTerms(p.entry, legMaturity(p.legKey), null);
  return { id: p.entry.id, catalog: { workflows: [], templates: [], models: [] }, performance: noWriterPerformance(p, t.noun, t.nounPlural), texts: [] };
}

/**
 * One other pipe's tabs, read like the cold email pipes' (WA-PIPE-RESEARCH-1023): its leg workflow ranking (each
 * workflow's bar IS its row), its people filed under the template and LLM that wrote them (the leg writer ranking's
 * evidence), its template dynasties, what its workflows write with now. An INTERNAL pipe (it acts on people another
 * campaign holds) has no per-person evidence here: its workflows are its ranking rows, its writers its definitions.
 */
/**
 * MODEL-RUN-COST-1024. Every generation a model wrote on one pipe's campaigns with its completion's LLM cost, for the
 * model pages' run-cost figures; billed basis only (the vendor cost of a run is not read: `not_on_vendor_basis`), an
 * unreadable copy says so on every page (`run_costs_unreadable`), never fails the file.
 */
async function pipeGenerationCosts(basis: Basis, campaignIds: readonly string[]): Promise<GenerationCostInput[] | RunCostUnavailableReason> {
  if (basis === "actual") return "not_on_vendor_basis";
  return readGenerationCosts(campaignIds).catch((err): RunCostUnavailableReason => {
    console.error("[features-service] research catalogue: generation run costs unreadable this time:", err);
    return "run_costs_unreadable";
  });
}

async function otherPipeSection(
  p: OtherPipe,
  basis: Basis,
  now: Date,
  shared: { llm: LlmDynastyIndex; servedModels: Awaited<ReturnType<typeof readModelIds>> | "model_ids_unreadable"; writersOf: typeof readDynastyWriters },
  view: ResearchView = "mature",
): Promise<OtherSection> {
  const { featureSlug, legKey } = p;
  const internal = (await internalPipeToStep(featureSlug, legKey)) !== null;
  const rule = legMaturity(legKey);
  const [read, tplRead, writers, ranking] = await Promise.all([
    internal ? Promise.resolve(null) : coldEmailPipe(legKey, basis, now, { featureSlug, datedSpend: false, requireRanking: false, view }),
    readTemplateDynasties(featureSlug, legKey),
    shared.writersOf(featureSlug),
    readLegWorkflowRanking(featureSlug, legKey, RANKING_WAIT_MS).then(
      (x) => x?.rows ?? null,
      (err) => {
        console.error(`[features-service] research: leg ranking ${featureSlug}|${legKey} unreadable, only the bars are listed:`, err);
        return null;
      },
    ),
  ]);
  const terms = otherPipeTerms(p.entry, rule, read?.input.cutoffDay ?? null);
  const tplDyn = templateDynastyIndex(tplRead);
  const rankingNames = new Map((ranking ?? []).filter((r) => r.workflowDynastyName).map((r) => [r.workflowDynastySlug, r.workflowDynastyName]));
  // An internal pipe: its ranking rows are its bars (billed basis), like the meeting booking pipe's.
  const input: ColdEmailPipeInput = read?.input ?? {
    legKey,
    durationDays: rule.durationDays,
    outcomesRequired: rule.outcomesRequired,
    cutoffDay: null,
    cells: [],
    dynastyOf: new Map(),
    labelOf: (d) => rankingNames.get(d) ?? d,
    rankingRows: basis === "user" ? ranking : null,
    view,
    readDay: now.toISOString().slice(0, 10),
  };
  const persons = read?.persons ?? [];
  const split = read?.split ?? { screened: false, signal: "other" as const, cutoffDay: null };
  const nameOf = (d: string) => read?.names.get(d) ?? rankingNames.get(d) ?? null;
  const hasGen = persons.some((b) => b.generation);
  const [models, generationRuns, generationCosts, workflowRuns] = await Promise.all([
    hasGen ? readModelNames() : Promise.resolve(new Map<string, ModelName>()),
    read ? readGenerationRuns(read.campaignIds).catch(() => []) : Promise.resolve([]),
    pipeGenerationCosts(basis, read?.campaignIds ?? []),
    read ? readWorkflowRuns(read.campaigns, (slug) => input.dynastyOf.get(slug) ?? slug, basis) : Promise.resolve([]),
  ]);
  const g = hasGen ? generationBuckets({ legKey, cells: input.cells, persons, split, models, templateDynasties: tplDyn, llmDynasties: shared.llm, view }) : null;
  const gen: CatalogGen = g
    ? {
        templates: g.tpl.rows,
        models: g.llm.rows,
        modelLabel: g.modelLabel,
        modelVersions: g.llmModels,
        llmKeyOf: g.llmKeyOf,
        llmLabelOf: g.llmLabelOf,
        mainOf: mainsByDynasty(persons, input.dynastyOf, split.screened, tplDyn.keyOf, g.llmKeyOf),
        templateVersions: g.tplVersions,
        templateFiguresByVersion: g.tplFiguresByVersion,
        templateVersionFiguresByVersion: g.tplVersionFiguresByVersion,
        modelFiguresByVersion: g.llmFiguresByVersion,
        modelVersionFiguresByVersion: g.llmModelFiguresByVersion,
        workflowVersionTotals: g.workflowVersionTotals,
      }
    : NO_GEN;
  const writerOf = typeof writers === "string" ? writers : (d: string) => writers.now.get(d) ?? null;
  const lastWriterOf = typeof writers === "string" ? writers : (d: string) => writers.last.get(d) ?? null;
  const nowTemplates = [
    ...(typeof writers === "string" ? [] : [...writers.now.values(), ...writers.last.values()].flatMap((w) => (w.ok && w.template ? [w.template] : []))),
    ...tplDyn.dynasties.flatMap((d) => d.versions),
    ...persons.flatMap((b) => (b.generation?.promptType ? [b.generation.promptType] : [])),
  ];
  const texts = nowTemplates.length
    ? await readTemplateTexts([...new Set(nowTemplates)]).catch((err) => {
        console.error(`[features-service] research: template texts of ${p.entry.id} unreadable this time:`, err);
        return new Map<string, string>();
      })
    : new Map<string, string>();
  const returns = ranking
    ? {
        roiOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.roiMultiple])),
        moneyGoesHere: ranking.find((x) => x.moneyGoesHere)?.workflowDynastySlug ?? null,
        pipelineOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.pipelineUsd ?? null])),
        billedOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.billedSpendUsd ?? null])),
      }
    : undefined;
  const bars = workflowBuckets(input);
  const catalog = withWorkflowFigures(
    pipeCatalog({
      terms,
      workflows: bars,
      templates: gen.templates,
      models: gen.models,
      nameOf,
      mainOf: gen.mainOf,
      modelLabel: gen.modelLabel,
      dynastyOf: (slug) => input.dynastyOf.get(slug) ?? slug,
      workflowRuns,
      templateDynasties: tplDyn,
      llmDynasties: shared.llm,
      modelVersions: gen.modelVersions,
      templateVersions: gen.templateVersions,
      generationRuns,
      generationCosts,
      templateTexts: new Set(texts.keys()),
      runnableWorkflows: runnableWorkflowsOf(ranking),
      writerOf,
      lastWriterOf,
      servedModels: shared.servedModels,
      workflowReturns: returns,
      templateFiguresByVersion: gen.templateFiguresByVersion,
      templateVersionFiguresByVersion: gen.templateVersionFiguresByVersion,
      modelFiguresByVersion: gen.modelFiguresByVersion,
      modelVersionFiguresByVersion: gen.modelVersionFiguresByVersion,
      workflowVersionTotals: gen.workflowVersionTotals,
    }),
    ranking,
    view,
  );
  const performanceOn = (pipeBars: ResearchBucket[]) =>
    read && hasGen
      ? pipePerformance({
          pipe: p.entry.id,
          noun: terms.noun,
          nounPlural: terms.nounPlural,
          featureSlug,
          legKey,
          cells: input.cells,
          persons,
          split,
          bars: pipeBars,
          dynastyOf: (slug) => input.dynastyOf.get(slug) ?? slug,
          workflowLabelOf: input.labelOf,
          workflowNameOf: nameOf,
          writerOfVersion: typeof writers === "string" ? undefined : (slug) => writers.byVersion.get(slug) ?? null,
          templateDynasties: tplDyn,
          llmDynasties: shared.llm,
          llmKeyOf: gen.llmKeyOf,
          llmLabelOf: gen.llmLabelOf,
          workflowReturns: returns,
          ...partsOf(catalog, aliasStatus!),
          unpricedBilledUsd: read.unpricedUsd,
          now,
        })
      : noWriterPerformance(p, terms.noun, terms.nounPlural);
  const aliasStatus = read && hasGen ? await readAliasStatus(featureSlug, legKey) : null;
  // The bars on the view; the order on the flash ones (PERF-ORDER-FLASH-1023).
  const shownPerf = performanceOn(bars);
  const performance = view === "flash" || !read || !hasGen ? shownPerf : inFlashOrder(shownPerf, performanceOn(workflowBuckets({ ...input, view: "flash" })));
  // Every listed template page's text: a version's under its id, a dynasty's (its head's) under the dynasty's slug.
  const listed = new Set(catalog.templates.flatMap((t) => [t.key, ...t.versions.map((v) => v.key)]));
  const pageTexts: Array<[string, string]> = [
    ...[...texts].filter(([k]) => listed.has(k)),
    ...catalog.templates.flatMap((t) => (t.dynasty?.head && texts.has(t.dynasty.head.key) ? [[t.key, texts.get(t.dynasty.head.key)!] as [string, string]] : [])),
  ];
  return { id: p.entry.id, catalog, performance, texts: pageTexts };
}

/** The Performance tab of every Research pipe (RESEARCH-PERFORMANCE-1023). */
export type ResearchPerformance = Record<ResearchPipeId, PipePerformance>;

/** One build: the file, its catalogue and the text of every listed template. */
export interface ResearchBuild {
  file: ResearchFile;
  catalog: ResearchCatalog;
  texts: Record<string, string>;
  performance: ResearchPerformance;
}

// ── serving: last build, persisted; one background rebuild at a time per basis ─────────────────────────────

/** One build per cost basis × view (MATURITY-VIEW-1023), keyed `<basis>:<view>`. */
type BuildKey = `${Basis}:${ResearchView}`;
const keyOf = (basis: Basis, view: ResearchView): BuildKey => `${basis}:${view}`;
const store = new Map<BuildKey, { value: StoredBuild; computedAt: number }>();
/** A build as stored; a copy persisted before the catalogue existed holds the file alone (`catalog` null until the next build). */
type StoredBuild = { file: ResearchFile; catalog: ResearchCatalog | null; texts: Record<string, string> | null; performance?: ResearchPerformance | null };
const warming = new Map<BuildKey, Promise<void>>();
const failedAt = new Map<BuildKey, number>();
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const cellKey = (basis: Basis, view: ResearchView) => `research:${basis}:${view}`;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Ask the refresher (whose fleet cells are warm) to compute; compute here when it cannot. */
async function buildResearch(basis: Basis, view: ResearchView): Promise<ResearchBuild> {
  const base = refresherBaseUrl();
  if (!base) return computeResearch(basis, view);
  let res: Response;
  try {
    res = await fetch(`${base}/internal/research/compute?basis=${basis}&view=${view}`, { headers: { "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" } });
  } catch (error) {
    console.error(`[features-service] refresher unreachable for research ${basis}/${view}; computing locally:`, error);
    return computeResearch(basis, view);
  }
  if (res.ok) return (await res.json()) as ResearchBuild;
  // The refresher ran the build and it failed: never run it again on the serving loop (the retry is in 10 min).
  throw new Error(`refresher answered ${res.status} for research ${basis}: ${(await res.text()).slice(0, 300)}`);
}

/** The vendor-cost twin reads runs-service's heaviest aggregation per org: rebuilt every 6 hours, not every 15 minutes. */
const freshMsOf = (basis: Basis) => (basis === "actual" ? 6 * 60 * 60_000 : FRESH_MS);

/**
 * A build this code still serves as is: one stored before the Performance tab's current rules (RESEARCH-PERFORMANCE-1023,
 * `figuresBasis: workflow_bars`, rows in `rowOrder: cost_per_outcome` since PERF-COST-ORDER-1024) is rebuilt at once, never served for the 6 hours the vendor-cost twin stays fresh.
 */
export function isCurrentBuild(build: StoredBuild, view: ResearchView = "mature"): boolean {
  const p = build.performance?.[POSITIVE_REPLY_PIPE];
  return p?.figuresBasis === "workflow_bars" && p.rowOrder === "cost_per_outcome" && p.orderView === "flash" && p.rowsCover === "all_valid_combinations" && build.file.view === view;
}

export function warmResearch(basis: Basis, view: ResearchView = "mature"): Promise<void> {
  const key = keyOf(basis, view);
  const entry = store.get(key);
  if (entry && isCurrentBuild(entry.value, view) && Date.now() - entry.computedAt < freshMsOf(basis)) return Promise.resolve();
  // A failed build is not retried on every read (each read would re-ask runs-service's heaviest aggregation).
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  const inFlight = warming.get(key);
  if (inFlight) return inFlight;
  const p = withTimeout(buildResearch(basis, view), BUILD_TIMEOUT_MS, `research ${key}`)
    .then(async (value) => {
      const computedAt = Date.now();
      store.set(key, { value, computedAt });
      // A store that hangs must never hold the single flight (every later read would wait on it, nothing rebuilt).
      await withTimeout(storeFleetCell(cellKey(basis, view), JSON.stringify(value), computedAt), STORE_TIMEOUT_MS, `research ${key} store`);
    })
    .catch((error) => {
      failedAt.set(key, Date.now());
      console.error(`[features-service] research ${key} build failed, keeping the previous one (next try in 10 min):`, error);
    })
    .finally(() => warming.delete(key));
  warming.set(key, p);
  return p;
}

/**
 * How old the served build is, stated on every read (RESEARCH-STALE-1024, 2026-10-24: a build only started on a read, so the
 * first read after a quiet night served a copy 8 hours old with nothing on the page saying so). `stale` once the build is
 * older than TWICE its cadence (one cadence + one build + one loop tick never reaches it); `rebuilding` = a build is running.
 */
export interface ResearchFreshness {
  computedAt: string;
  refreshEveryMinutes: number;
  staleAfterMinutes: number;
  ageMinutes: number;
  stale: boolean;
  rebuilding: boolean;
}

/** PURE. */
export function researchFreshness(computedAtIso: string, refreshEveryMs: number, now: number, rebuilding: boolean): ResearchFreshness {
  const ageMinutes = Math.max(0, Math.floor((now - Date.parse(computedAtIso)) / 60_000));
  const refreshEveryMinutes = Math.round(refreshEveryMs / 60_000);
  const staleAfterMinutes = 2 * refreshEveryMinutes;
  return { computedAt: computedAtIso, refreshEveryMinutes, staleAfterMinutes, ageMinutes, stale: ageMinutes > staleAfterMinutes, rebuilding };
}

const freshnessOf = (file: ResearchFile, basis: Basis, view: ResearchView): ResearchFreshness =>
  researchFreshness(file.computedAt, freshMsOf(basis), Date.now(), warming.has(keyOf(basis, view)));

/**
 * Rebuilt on a CLOCK, never only on a read (RESEARCH-STALE-1024): every 5 minutes the billed basis, both views, one after
 * the other, each rebuilt when past its 15 min (single flight per key; a failure keeps the previous build, retried in 10 min).
 * The vendor-cost twin stays rebuilt on read (6 h, runs-service's heaviest aggregation), its age stated the same way.
 */
const LOOP_EVERY_MS = 5 * 60_000;
let loopRunning = false;
export async function refreshResearchOnce(): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  try {
    for (const view of ["mature", "flash"] as const) {
      await readResearchBuild("user", view);
      await warmResearch("user", view);
    }
  } finally {
    loopRunning = false;
  }
}
export function startResearchRefreshLoop(): void {
  const tick = () => void refreshResearchOnce().catch((err) => console.error("[features-service] research refresh loop failed:", err));
  setTimeout(tick, 120_000).unref();
  setInterval(tick, LOOP_EVERY_MS).unref();
}

/** The last build (the persisted copy on a fresh process); kicks a rebuild when stale. Null = never built. */
export async function readResearchBuild(basis: Basis, view: ResearchView = "mature"): Promise<StoredBuild | null> {
  const key = keyOf(basis, view);
  if (!store.has(key)) {
    // The mature view's first build after MATURITY-VIEW-1023 has no copy of its own yet: serve the copy stored before the
    // views (`research:<basis>`, rebuilt behind as not current) rather than a 503 while builds time out under load.
    const stored = (await loadFleetCell(cellKey(basis, view))) ?? (view === "mature" ? await loadFleetCell(`research:${basis}`) : null);
    if (stored && !store.has(key)) {
      try {
        const raw = JSON.parse(stored.text) as ResearchBuild | ResearchFile;
        const value: StoredBuild = "file" in raw ? raw : { file: raw, catalog: null, texts: null };
        store.set(key, { value, computedAt: stored.computedAt });
      } catch (error) {
        console.error(`[features-service] research ${key}: persisted copy unreadable, rebuilding:`, error);
      }
    }
  }
  void warmResearch(basis, view);
  return store.get(key)?.value ?? null;
}

/** The last file (see {@link readResearchBuild}). */
export async function readResearch(basis: Basis, view: ResearchView = "mature"): Promise<ResearchFile | null> {
  return (await readResearchBuild(basis, view))?.file ?? null;
}

/** Test seam. */
export function __resetResearch(): void {
  store.clear();
  warming.clear();
  failedAt.clear();
  closedWindows.clear();
  loopRunning = false;
}

/** `?view=`: absent = mature (MATURITY-VIEW-1023); anything else than mature / flash = null (400). */
const viewOf = (raw: unknown): ResearchView | null => (raw === undefined || raw === "" || raw === "mature" ? "mature" : raw === "flash" ? "flash" : null);
const badView = (res: import("express").Response) => res.status(400).json({ error: "view must be mature (default) or flash", reason: "view_unrecognised" });

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
    const view = viewOf(req.query.view);
    if (!view) return badView(res);
    const file = await readResearch(basis, view);
    if (!file) return notYet(res);
    res.json({ ...file, freshness: freshnessOf(file, basis, view) });
  } catch (error) {
    console.error("[features-service] research read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/conclusions", apiKeyOnly, async (req, res) => {
  const view = viewOf(req.query.view);
  if (!view) return badView(res);
  try {
    const file = await readResearch("user", view);
    if (!file) return notYet(res);
    res.json(researchConclusions(file));
  } catch (error) {
    console.error("[features-service] research conclusions failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/studies", apiKeyOnly, async (req, res) => {
  const view = viewOf(req.query.view);
  if (!view) return badView(res);
  try {
    const file = await readResearch("user", view);
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
  const view = viewOf(req.query.view);
  if (!view) return badView(res);
  try {
    const build = await readResearchBuild(basis, view);
    if (!build?.catalog) return notYet(res);
    // ONE figure per workflow (RESEARCH-WF-FIGURES-1022): each page takes the CURRENT ranking row's figures, the ones the
    // Workflows list prints, never the ranking its build held (up to 15 min older).
    const studied = new Set<string>(STUDIED_PIPES.map((x) => x.id));
    const others = build.file.pipes.filter((x) => !studied.has(x.id) && build.catalog?.[x.id]);
    const catalogued = build.file.pipes.filter((x) => build.catalog?.[x.id]);
    const [replyRanking, visitRanking, tacticsOf, otherRankings, liveDynasties] = await Promise.all([
      readLegWorkflowRanking(COLD_EMAIL, REPLY_LEG, 0),
      readLegWorkflowRanking(COLD_EMAIL, VISIT_LEG, 0),
      readTemplateTactics(),
      // Every other pipe's pages take its current ranking rows too (WA-PIPE-RESEARCH-1023); unreadable = the build's.
      Promise.all(others.map((x) => readLegWorkflowRanking(x.channel, x.leg, 0).catch(() => null))),
      // Each pipe's template statuses as content-generation states them now (TPL-STATUS-LIVE-1023); unreadable = the build's.
      Promise.all(catalogued.map((x) => readLiveTemplateDynasties(x.channel, x.leg))),
    ]);
    const liveOf = new Map(catalogued.map((x, i) => [x.id, liveDynasties[i]!]));
    // Each template page's tactics, read live like the workflow rows' (TPL-TACTICS-ROWS-1022), and its status (TPL-STATUS-LIVE-1023).
    const withTactics = <P extends { templates: CatalogTemplate[] }>(id: string, p: P): P => ({
      ...p,
      templates: withTemplateTactics(withLiveTemplateStatus(p.templates, liveOf.get(id) ?? null), tacticsOf),
    });
    res.json(
      await withResearchCatalogMarks(
        Object.fromEntries(
          Object.entries({
            ...build.catalog,
            ...Object.fromEntries(others.map((x, i) => [x.id, withWorkflowFigures(build.catalog![x.id]!, otherRankings[i]?.rows ?? null, view)])),
            [POSITIVE_REPLY_PIPE]: withWorkflowFigures(build.catalog[POSITIVE_REPLY_PIPE], replyRanking?.rows ?? null, view),
            [WEBSITE_VISIT_PIPE]: withWorkflowFigures(build.catalog[WEBSITE_VISIT_PIPE], visitRanking?.rows ?? null, view),
          }).map(([id, p]) => [id, withTactics(id, p)]),
        ) as ResearchCatalog,
      ),
    );
  } catch (error) {
    console.error("[features-service] research catalogue read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The combination the pipe runs TODAY, read LIVE at every Performance read (PERF-COST-ORDER-1024): the leg workflow
 * ranking's first workflow (what campaign-service runs) x the writer pick under the pipe's default play. A pipe whose
 * pick cannot be read says so on its own block (logged), never fails the tab.
 */
async function readServedNow(perf: PipePerformance): Promise<PerformanceServedNow> {
  const none = { workflow: null, template: null, llm: null };
  if (!perf.featureSlug || !perf.legKey) return servedNowOf(perf, { ...none, unavailableReason: "pipe_not_read" });
  try {
    const [ranking, picked] = await Promise.all([readLegWorkflowRanking(perf.featureSlug, perf.legKey, 0), pickPipeWriters(perf.featureSlug, perf.legKey, null, 0)]);
    if (!ranking) return servedNowOf(perf, { ...none, unavailableReason: "workflow_ranking_not_computed_yet" });
    if (!picked) return servedNowOf(perf, { ...none, unavailableReason: "writer_ranking_not_computed_yet" });
    const first = ranking.rows.find((r) => r.goesFirst) ?? null;
    const labelOf = (key: string, part: "workflow" | "template" | "llm") => perf.rows.find((r) => r[part]?.key === key)?.[part]?.label ?? null;
    const workflow = first ? { key: first.workflowDynastySlug, label: labelOf(first.workflowDynastySlug, "workflow") ?? first.workflowDynastyName ?? first.workflowDynastySlug } : null;
    const tplKey = picked.template ? (picked.template.templateDynastySlug ?? picked.template.key) : null;
    const template = picked.template && tplKey ? { key: tplKey, label: labelOf(tplKey, "template") ?? picked.template.label } : null;
    const llm = picked.llm ? { key: picked.llm.key, label: labelOf(picked.llm.key, "llm") ?? picked.llm.label } : null;
    return servedNowOf(perf, { workflow, template, llm, unavailableReason: null });
  } catch (error) {
    console.error(`[features-service] research performance: the served combination of ${perf.pipe} could not be read:`, error);
    return servedNowOf(perf, { ...none, unavailableReason: "served_pick_unreadable" });
  }
}

router.get("/internal/research/performance", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user (billed, default) or actual", reason: "basis_unrecognised" });
    return;
  }
  try {
    const view = viewOf(req.query.view);
    if (!view) return badView(res);
    const build = await readResearchBuild(basis, view);
    // A copy persisted before the Performance tab existed holds none: not computed yet until the next build.
    if (!build?.performance) return notYet(res);
    const marked = await withPerformanceMarks(build.performance);
    const pipes = Object.fromEntries(await Promise.all(Object.entries(marked).map(async ([id, perf]) => [id, { ...perf, servedNow: await readServedNow(perf) }] as const)));
    res.json({ computedAt: build.file.computedAt, freshness: freshnessOf(build.file, basis, view), costBasis: build.file.costBasis, view, pipes });
  } catch (error) {
    console.error("[features-service] research performance read failed:", error);
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
    const view = viewOf(req.query.view);
    if (!view) return badView(res);
    res.json(await computeResearch(basis, view));
  } catch (error) {
    console.error(`[features-service] research compute (${basis}) failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
