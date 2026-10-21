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
import {
  dynastyLegKeyOf,
  dynastyStatusOf,
  templateDynastyIndex,
  type TemplateDynasty,
  type TemplateDynastyIndex,
  type TemplateDynastyReason,
  type TemplateStatus,
} from "../lib/research/template-dynasties.js";
import { dynastyLastWriters, dynastyWriters, type DynastyWriter, type WriterReason } from "../lib/research/writers.js";
import { readModelIds } from "../lib/model-ids-client.js";
import { fetchWorkflowDefinitions } from "../lib/workflow-definitions-client.js";
import type { LegWorkflowRankingRow } from "../lib/leg-workflow-ranking.js";
import { pipeCatalog, type GenerationRun, type ResearchCatalog, type WorkflowRun } from "../lib/research/catalog.js";
import type { ResearchBucket } from "../lib/research/studies.js";
import type { FleetPersonBucket } from "../lib/fleet-positive-repliers.js";
import { researchConclusions, researchMeasuredStudies } from "../lib/research/conclusions.js";
import type { ResearchFile, ResearchStudy } from "../lib/research/types.js";
import { fetchFleetLegSlugEvidence, readLegWorkflowRanking } from "./public.js";
import { bestMeetingPipePick } from "../lib/fleet-indexes.js";
import { readFleetIndexSeries } from "../lib/fleet-index-store.js";
import { MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG, meetingResearchPoints, meetingSeriesOf } from "../lib/research/pipe-series.js";
import { fetchFleetCampaignRows } from "../lib/fleet-leg-campaigns.js";
import { isReplyPipe } from "../lib/campaign-next-steps.js";
import { fetchReplyDelayDistribution } from "../lib/campaign-next-steps-io.js";
import type { ReplyDelayRead } from "../lib/research/reply-delay.js";
import { readBookedAfterReply, readGenerationRuns, readJevInputs, readLegSpendTotal, readMeetingAttribution, readOpensArms, readPerEmailPrices, readReplyAuthors, readReportingBrands, readSendGroups, readVolume, readWorkflowRuns } from "./research-sends.js";
import { fetchFleetReplierCountries } from "../lib/fleet-positive-repliers.js";
import { fetchOrgUserEmails } from "../lib/accounts-client.js";
import { isStaffOnlyOrg } from "../lib/showcase-clients.js";
import { countryMeetingStudy, countryStudies } from "../lib/research/countries.js";
import { readNicheGrades } from "../lib/research/niche-grades.js";
import { nicheStudies } from "../lib/research/niche.js";

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

/**
 * Spend per workflow version over one run-start window, on ONE org's campaigns of the leg (incurred, like the ranking).
 * Read org by org with a single grouping key: the fleet aggregation co-grouping version AND campaign is runs-service's
 * vendor-priced one, which timed out under a deploy wave (2026-10-18); the single-key billed read answers in ~0.15 s.
 */
async function fetchWindowSpend(featureSlug: string, ids: readonly string[], pricing: Pricing, from: string, to: string): Promise<CostGroup[]> {
  const base = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({
    groupBy: "workflowSlug",
    featureSlugs: runsSpendSlugsParam(featureSlug, "own"),
    campaignIds: ids.join(","),
    startedAfter: from,
    startedBefore: startedBeforeParam(to),
  });
  const res = await fetchWithRetry(runsCostsUrl(base, "public", pricing, params), { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`runs-service dated research spend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(body.groups)) throw new Error("runs-service dated research spend: no groups array");
  return body.groups;
}

/**
 * A window that ENDED more than a day ago is read once a day (its runs are started; a late actualization is rare and
 * lands within the day): each build would otherwise re-read every month since February. Open windows are read every build.
 */
const CLOSED_WINDOW_HOLD_MS = 24 * 60 * 60_000;
const closedWindows = new Map<string, { at: number; groups: CostGroup[] }>();
async function closedWindowSpend(featureSlug: string, ids: readonly string[], pricing: Pricing, from: string, to: string, now: Date): Promise<CostGroup[]> {
  const closed = Date.parse(to) < now.getTime() - 24 * 60 * 60_000;
  const key = `${featureSlug}|${pricing}|${from}|${to}|${ids.join(",")}`;
  const held = closedWindows.get(key);
  if (closed && held && now.getTime() - held.at < CLOSED_WINDOW_HOLD_MS) return held.groups;
  const groups = await fetchWindowSpend(featureSlug, ids, pricing, from, to);
  if (closed) closedWindows.set(key, { at: now.getTime(), groups });
  return groups;
}

async function fetchDatedSpend(featureSlug: string, campaigns: ReadonlyArray<{ campaignId: string; orgId: string }>, pricing: Pricing, cutoffIso: string | null, now: Date): Promise<DatedSpendRow[]> {
  const byOrg = new Map<string, string[]>();
  for (const c of campaigns) byOrg.set(c.orgId, [...new Set([...(byOrg.get(c.orgId) ?? []), c.campaignId])]);
  const reads = spendWindows(now, cutoffIso).flatMap((w) =>
    [...byOrg].flatMap(([orgId, ids]) => {
      const sorted = [...ids].sort();
      const chunks: string[][] = [];
      for (let i = 0; i < sorted.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) chunks.push(sorted.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
      return chunks.map((c) => ({ w, orgId, c }));
    }),
  );
  // the vendor-priced twin one read at a time (runs-service's heavy aggregation), the billed one three at a time
  const rows = await mapWithConcurrency(reads, pricing === "gross" ? 3 : 1, async ({ w, orgId, c }) => {
    const groups = await closedWindowSpend(featureSlug, c, pricing, w.from, w.to, now);
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
    fetchDatedSpend(COLD_EMAIL, ev.campaigns, pricing, ev.cutoffIso, now),
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
    campaigns: ev.campaigns.map((c) => ({ campaignId: c.campaignId, orgId: c.orgId, brandId: c.brandId, offerId: c.offerId ?? null })),
    names: new Map(ev.workflows.filter((w) => w.workflowDynastyName).map((w) => [w.workflowDynastySlug, w.workflowDynastyName])),
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
async function readDynastyWriters(): Promise<{ now: Map<string, DynastyWriter>; last: Map<string, DynastyWriter> } | WriterReason> {
  try {
    const [definitions, models] = await Promise.all([fetchWorkflowDefinitions(COLD_EMAIL), readModelIds()]);
    return { now: dynastyWriters(definitions, models), last: dynastyLastWriters(definitions, models) };
  } catch (error) {
    console.error("[features-service] research catalogue: what the workflows write with now could not be read this time:", error);
    return "workflow_definitions_unreadable";
  }
}

/** The workflows a run may still pick on a leg: the leg ranking's selectable rows. */
function runnableWorkflowsOf(rows: readonly LegWorkflowRankingRow[] | null) {
  if (!rows) return null;
  return rows.filter((r) => r.selectable).map((r) => ({ key: r.workflowDynastySlug, label: r.workflowDynastyName ? shortName(r.workflowDynastyName) : r.workflowDynastySlug, name: r.workflowDynastyName || null }));
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

/**
 * One pipe's template dynasties, read from content-generation-service's deployed catalogue (TPL-DYNASTY-1021-FS2; api
 * key, no identity). Unreadable = every version is its own page this build, said on each (`template_dynasties_unreadable`).
 */
async function readTemplateDynasties(legKey: string): Promise<TemplateDynasty[] | TemplateDynastyReason> {
  try {
    const q = new URLSearchParams({ featureSlug: COLD_EMAIL, legKey: dynastyLegKeyOf(legKey) });
    const res = await fetchWithRetry(`${process.env.CONTENT_GENERATION_SERVICE_URL}/internal/template-dynasties?${q}`, {
      headers: { "x-api-key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`content-generation-service template-dynasties ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { dynasties?: Array<Partial<Omit<TemplateDynasty, "status">> & { status?: unknown; versions?: Array<{ type?: string; position?: number; status?: unknown; statusInDynasty?: unknown }> }> };
    if (!Array.isArray(body.dynasties)) throw new Error("content-generation-service template-dynasties: no dynasties array");
    return body.dynasties.map((d) => {
      if (typeof d.slug !== "string" || typeof d.name !== "string") throw new Error("content-generation-service template-dynasties: a dynasty without slug or name");
      const ordered = [...(d.versions ?? [])]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .flatMap((v) => {
          if (typeof v.type !== "string") return [];
          // A version's status IN this dynasty (head = its own, older = deprecated); `status` is the template's own,
          // active when it heads a dynasty on another pipe. Before content-generation served it: the template's own.
          const st = v.statusInDynasty !== undefined ? v.statusInDynasty : v.status;
          return [{ type: v.type, status: st === "active" || st === "deprecated" ? (st as TemplateStatus) : null }];
        });
      const versions = ordered.map((v) => v.type);
      return {
        ...dynastyStatusOf(d.status, ordered),
        versionStatuses: Object.fromEntries(ordered.map((v) => [v.type, v.status])),
        slug: d.slug,
        name: d.name,
        description: typeof d.description === "string" ? d.description : "",
        signature: typeof d.signature === "string" ? d.signature : null,
        identity: typeof d.identity === "string" ? d.identity : "",
        head: typeof d.head === "string" ? d.head : null,
        versions,
      };
    });
  } catch (error) {
    console.error(`[features-service] research: template dynasties of ${legKey} unreadable, every version is its own page this time:`, error);
    return "template_dynasties_unreadable";
  }
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
  templateVersions: ResearchBucket[];
  templateSpendByVersion: Map<string, Map<string, number>>;
  templateVersionSpendByVersion: Map<string, Map<string, number>>;
}

const NO_GEN: CatalogGen = {
  templates: [],
  models: [],
  modelLabel: (id) => id,
  mainOf: () => ({ model: null, template: null }),
  templateVersions: [],
  templateSpendByVersion: new Map(),
  templateVersionSpendByVersion: new Map(),
};

/** PURE. The model and template (dynasty, else version) most of a dynasty's people (people emailed) were written with. */
function mainsByDynasty(persons: readonly FleetPersonBucket[], dynastyOf: ReadonlyMap<string, string>, screened: boolean, templateKeyOf: (id: string) => string) {
  const tally = new Map<string, { models: Map<string, number>; templates: Map<string, number> }>();
  for (const b of persons) {
    if (!b.generation) continue;
    const d = dynastyOf.get(b.workflowSlug) ?? b.workflowSlug;
    const t = tally.get(d) ?? { models: new Map(), templates: new Map() };
    tally.set(d, t);
    const c = (screened ? b.screenedContacted : b.contacted) || 0.0001;
    t.models.set(b.generation.model, (t.models.get(b.generation.model) ?? 0) + c);
    if (b.generation.promptType) {
      const k = templateKeyOf(b.generation.promptType);
      t.templates.set(k, (t.templates.get(k) ?? 0) + c);
    }
  }
  const top = (m: Map<string, number> | undefined) => (m && m.size ? [...m].sort((a, b) => b[1] - a[1])[0]![0] : null);
  return (dynasty: string) => ({ model: top(tally.get(dynasty)?.models), template: top(tally.get(dynasty)?.templates) });
}

/** The studies of what wrote the emails; none while the fleet person cell carries no generation yet (its ids stay waiting). */
async function generationInputs(
  reply: ColdEmailPipeRead,
  visit: ColdEmailPipeRead,
  note: string,
  dynasties: { reply: TemplateDynastyIndex; visit: TemplateDynastyIndex },
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
  });
  const partOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead): CatalogGen => {
    const g = generationBuckets(inputOf(pipe, r));
    const dyn = pipe === POSITIVE_REPLY_PIPE ? dynasties.reply : dynasties.visit;
    return {
      templates: g.tpl.rows,
      models: g.llm.rows,
      modelLabel: g.modelLabel,
      mainOf: mainsByDynasty(r.persons, r.input.dynastyOf, r.split.screened, dyn.keyOf),
      templateVersions: g.tplVersions,
      templateSpendByVersion: g.tplSpendByVersion,
      templateVersionSpendByVersion: g.tplVersionSpendByVersion,
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
async function sendsInputs(reply: { campaignIds: string[]; cutoffIso: string | null }, visit: { campaignIds: string[]; cutoffIso: string | null }, pricing: Pricing) {
  const [rg, vg] = await Promise.all([readSendGroups(reply.campaignIds, reply.cutoffIso), readSendGroups(visit.campaignIds, visit.cutoffIso)]);
  if (!rg.length && !vg.length) return null;
  const prices = Object.fromEntries(await readPerEmailPrices());
  // On the vendor basis the per-email charges are scaled by the leg's vendor ÷ billed spend (the rollup states billed).
  const splitOf = async (r: { campaignIds: string[]; cutoffIso: string | null }) => {
    const total = await readLegSpendTotal(COLD_EMAIL, r.campaignIds, pricing, r.cutoffIso);
    if (pricing === "gross") return { totalUsd: total, perEmailUsdByMonth: prices };
    const billed = await readLegSpendTotal(COLD_EMAIL, r.campaignIds, "gross", r.cutoffIso);
    const k = billed > 0 ? total / billed : 0;
    return { totalUsd: total, perEmailUsdByMonth: Object.fromEntries(Object.entries(prices).map(([m, v]) => [m, v * k])) };
  };
  const rs = await splitOf(reply);
  const vs = await splitOf(visit);
  const opens = reply.cutoffIso ? await readOpensArms(reply.cutoffIso) : null;
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
      countryStudies({ terms: termsOf(id, r.input, note), legKey: r.input.legKey, cells: r.input.cells, persons: r.persons, split: r.split, excludedOrgIds: ours });
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
export async function computeResearch(basis: Basis, now = new Date()): Promise<ResearchBuild> {
  const meetingRule = legMaturity(MEETING_BOOKING_LEG_KEY);
  // Each pipe's template dynasties (never throws: unreadable = every version on its own page, said so).
  const dynastiesP = Promise.all([readTemplateDynasties(REPLY_LEG), readTemplateDynasties(VISIT_LEG)]).then(([r, v]) => ({
    reply: templateDynastyIndex(r),
    visit: templateDynastyIndex(v),
  }));
  // The two legs in turn on the vendor basis (one heavy aggregation at a time), together on the billed one.
  const legs =
    basis === "actual"
      ? (async () => {
          const r = await coldEmailPipe(REPLY_LEG, basis, now);
          return [r, await coldEmailPipe(VISIT_LEG, basis, now)] as const;
        })()
      : Promise.all([coldEmailPipe(REPLY_LEG, basis, now), coldEmailPipe(VISIT_LEG, basis, now)]);
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
  const [sends, jev, replies, gens, reportingBrands, volume, replyDelay, countries, niche] = await Promise.all([
    sendsInputs(reply, visit, basis === "actual" ? "vendor" : "gross"),
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
    reply: { terms: termsOf(POSITIVE_REPLY_PIPE, reply.input, nicheNote), legKey: reply.input.legKey, cells: reply.input.cells, persons: reply.persons, split: reply.split },
    visit: { terms: termsOf(WEBSITE_VISIT_PIPE, visit.input, nicheNote), legKey: visit.input.legKey, cells: visit.input.cells, persons: visit.persons, split: visit.split },
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
  const file = assembleResearch({
    replyDelay,
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
  const [replyRuns, visitRuns, replyGens, visitGens, replyRanking, visitRanking, writers] = await Promise.all([
    readWorkflowRuns(reply.campaigns, (slug) => reply.input.dynastyOf.get(slug) ?? slug, basis),
    readWorkflowRuns(visit.campaigns, (slug) => visit.input.dynastyOf.get(slug) ?? slug, basis),
    readGenerationRuns(reply.campaignIds).catch(() => []),
    readGenerationRuns(visit.campaignIds).catch(() => []),
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
  const catalogOf = (pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, r: ColdEmailPipeRead, g: CatalogGen, runs: WorkflowRun[], gensRuns: GenerationRun[], ranking: readonly LegWorkflowRankingRow[] | null) =>
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
      templateVersions: g.templateVersions,
      generationRuns: gensRuns,
      templateTexts: new Set(allTexts.keys()),
      runnableWorkflows: runnableWorkflowsOf(ranking),
      writerOf,
      lastWriterOf,
      servedModels,
      workflowReturns: ranking
        ? { roiOf: new Map(ranking.map((x) => [x.workflowDynastySlug, x.roiMultiple])), moneyGoesHere: ranking.find((x) => x.moneyGoesHere)?.workflowDynastySlug ?? null }
        : undefined,
      templateSpendByVersion: g.templateSpendByVersion,
      templateVersionSpendByVersion: g.templateVersionSpendByVersion,
    });
  const catalog: ResearchCatalog = {
    [POSITIVE_REPLY_PIPE]: catalogOf(POSITIVE_REPLY_PIPE, reply, gens.reply, replyRuns, replyGens, replyRanking),
    [WEBSITE_VISIT_PIPE]: catalogOf(WEBSITE_VISIT_PIPE, visit, gens.visit, visitRuns, visitGens, visitRanking),
    [MEETING_BOOKING_PIPE]: { workflows: [], templates: [], models: [] },
  };
  // Every listed page's text: a version's under its id, a dynasty's (its head's) under the dynasty's slug.
  const listed = new Set(Object.values(catalog).flatMap((c) => c.templates.flatMap((t) => [t.key, ...t.versions.map((v) => v.key)])));
  const headTexts = Object.values(catalog).flatMap((c) =>
    c.templates.flatMap((t) => (t.dynasty?.head && allTexts.has(t.dynasty.head.key) ? [[t.key, allTexts.get(t.dynasty.head.key)!] as [string, string]] : [])),
  );
  const texts = Object.fromEntries([...[...allTexts].filter(([k]) => listed.has(k)), ...headTexts].sort(([a], [b]) => (a < b ? -1 : 1)));
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
  if (!base) return computeResearch(basis);
  let res: Response;
  try {
    res = await fetch(`${base}/internal/research/compute?basis=${basis}`, { headers: { "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" } });
  } catch (error) {
    console.error(`[features-service] refresher unreachable for research ${basis}; computing locally:`, error);
    return computeResearch(basis);
  }
  if (res.ok) return (await res.json()) as ResearchBuild;
  // The refresher ran the build and it failed: never run it again on the serving loop (the retry is in 10 min).
  throw new Error(`refresher answered ${res.status} for research ${basis}: ${(await res.text()).slice(0, 300)}`);
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
