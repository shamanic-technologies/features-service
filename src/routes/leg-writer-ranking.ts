/**
 * THE BEST TEMPLATE AND THE BEST LLM OF EVERY PIPE THAT WRITES (BEST-TPL-LLM-1022, owner 2026-10-22). The order is
 * `lib/leg-writer-ranking.ts` (the ONE leg order the workflows follow, on $/outcome); this file reads the evidence,
 * builds it off the request path and serves it.
 *
 *   GET /public/stats/leg-writer-ranking?featureSlug=&leg=[&strategyId=]   both rankings of one pipe (no identity)
 *   GET /internal/writer-pick?workflowSlug=[&campaignId=]                    what a run writes with (api key, workflow-service)
 *
 * Evidence = the Research page's template and model bars (`generationBuckets`): every person the pipe's campaigns emailed
 * is filed under the template and the model that wrote their sequence (content-generation-service's record, the fleet
 * person cell), each workflow version's spend, people and outcomes shared out on its people. So a template's or an
 * LLM's figures add up to the leg workflow ranking's evidence, and the Research page shows the same bars.
 *
 * A pipe's candidates: its template DYNASTIES (content-generation, active + head = selectable) and every LLM a writer
 * alias of content-generation names (active alias = selectable), plus anything that wrote on the pipe. Every pipe holding
 * a workflow assignment is covered by the same code (no per-pipe branch). A chat `/complete` writer records no sequence:
 * its people are filed under the LLM their acting run stated on lead-service's follow-up ledger (an entry pipe through
 * the fleet person cell, an internal pipe, `lib/pipe-kind.ts`, through `ledgerLlmBars`). A pipe with no writer recorded
 * at all says so (`writerEvidence: no_sequence_recorded_on_pipe`) and still picks: every candidate is LEARNING at $0, the
 * learning rule explores them in turn (WA-PIPE-RESEARCH-1023, supersedes "never a pick on zero evidence").
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { awaitWarmStore } from "../lib/await-warm-store.js";
import { isMatureCount, legMaturity } from "../lib/maturity.js";
import { pipeLegKeyOf, servedLegKeyOf } from "../lib/funnel-legs.js";
import { internalPipeToStep } from "../lib/pipe-kind.js";
import { isScreenedVisitLeg } from "../lib/screened-visits.js";
import { fetchFleetPersonBuckets } from "../lib/fleet-positive-repliers.js";
import { buildSlugCells } from "../lib/research/slug-cells.js";
import { generationBuckets, type ModelName } from "../lib/research/generations.js";
import { templateDynastyIndex, type TemplateDynasty } from "../lib/research/template-dynasties.js";
import { modelKey } from "../lib/research/format.js";
import { readModelIds, type ServedModel } from "../lib/model-ids-client.js";
import { readTemplateDynasties, readWriterModelAliases, type WriterModelAlias } from "../lib/writer-catalogue-client.js";
import { llmDynastyIndex, NO_LLM_DYNASTIES, readLlmDynastiesSoft, type LlmDynastyIndex } from "../lib/llm-dynasties.js";
import { rankWriters, type WriterCandidate, type WriterRanking, type WriterRankingRow } from "../lib/leg-writer-ranking.js";
import { listLegAssignments } from "../lib/workflow-leg-assignments.js";
import { getInternalPipeFleet } from "../lib/meeting-leg-fleet.js";
import { fetchFollowupLlmAliases } from "../lib/followup-actions-client.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { templateTacticsFrom, type TemplateTactics, type TemplateTacticsReason } from "../lib/template-tactics.js";
import { withTemplateRankingMarks } from "../lib/catalogue-mark-serving.js";
import { strategyOnSubject, strategyVerdict, tacticNameOf, writerSubjectKey, type PlayCatalogue, type Strategy } from "../lib/plays.js";
import { fetchPublicWorkflows } from "../lib/public-stats-clients.js";
import { fetchCampaignSalesFunnelId } from "../lib/fleet-leg-campaigns.js";
import { fetchFleetLegSlugEvidence } from "./public.js";
import { playOfLegRead } from "./workflow-projection.js";

const router = Router();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const FRESH_MS = 15 * 60_000;
const WARM_TIMEOUT_MS = 10 * 60_000;

/** Why a pipe's ranking picks nothing: its runs keep writing with what their workflow states. */
export type WriterEvidenceReason = "internal_pipe_not_measured_per_writer" | "no_sequence_recorded_on_pipe";

export interface TemplateRow extends WriterRankingRow {
  /** The template dynasty's own icon (Phosphor name) + colour (MARKS-1022), keyed on `key`; set at serve time. */
  icon?: string;
  color?: string;
  /** content-generation's dynasty slug (the key), its head (the version a run writes with); null = a version on its own. */
  templateDynastySlug: string | null;
  head: string | null;
  status: "active" | "deprecated" | null;
  /** The template tactics it follows (TPL-TACTICS-ROWS-1022), read live; null with `tacticsUnavailableReason`. */
  tactics: TemplateTactics | null;
  tacticsUnavailableReason: TemplateTacticsReason | null;
}

/** One model of an LLM dynasty row: its share of the row's figures, read on the row's basis (the models add up to it). */
export interface LlmModelDetail {
  key: string;
  label: string;
  modelIds: string[];
  /** The dynasty's head: what its slug runs now. */
  head: boolean;
  basis: "mature" | "flash";
  spentUsd: number;
  contacted: number;
  outcomes: number;
}

export interface LlmRow extends WriterRankingRow {
  /** chat-service's LLM dynasty slug (= `key`; LLM-DYNASTY-1022-FS); null = a model chat-service places in no dynasty (its own row). */
  llmDynastySlug: string | null;
  /** The dynasty's head model id (what a run writing with this row gets). */
  headModelId: string | null;
  /** content-generation writer aliases running this dynasty, active ones first (what a run sends as `model` today). */
  aliases: Array<{ alias: string; provider: string; status: "active" | "deprecated" }>;
  modelIds: string[];
  provider: string | null;
  /** Per model, its share of the row (every version chat-service lists, newest first, zero until it writes). */
  models: LlmModelDetail[];
}

/** One pipe's evidence, before any strategy: what is stored and served. */
export interface LegWriterRankingPayload {
  featureSlug: string;
  legKey: string;
  pipeId: string;
  computedAt: string | null;
  costBasis: "incurred";
  rankBasis: "cost_per_outcome";
  maturity: { durationDays: number; outcomesRequired: number; cutoffIso: string | null };
  /** `measured` = the pipe's people are filed under what wrote them; else why nothing is picked. */
  writerEvidence: "measured" | WriterEvidenceReason;
  templates: { candidates: Array<WriterCandidate & { templateDynastySlug: string | null; head: string | null; status: "active" | "deprecated" | null }>; unavailableReason: string | null };
  llms: {
    candidates: Array<WriterCandidate & { llmDynastySlug: string | null; headModelId: string | null; aliases: LlmRow["aliases"]; modelIds: string[]; provider: string | null; models: LlmModelDetail[] }>;
    unavailableReason: string | null;
    /** Set when chat-service's LLM dynasties could not be read this build: every model is its own row then (LLM-DYNASTY-1022-FS). */
    dynastiesUnavailableReason?: string | null;
  };
  /** People of the pipe's versions whose writer is not on record (left out of every bar, like the Research page). */
  leftOut: { templates: { contacted: number; outcomes: number }; llms: { contacted: number; outcomes: number } };
}

const ZERO = { spentUsd: 0, contacted: 0, outcomes: 0 };

/** PURE. The template candidates: every dynasty of the pipe (zero until it writes) + every bar that wrote on the pipe. */
export function templateCandidates(
  bars: ReadonlyArray<{ key: string; label: string; basis: "mature" | "flash"; figures: { spentUsd: number; contacted: number; outcomes: number } }>,
  dynasties: readonly TemplateDynasty[],
): LegWriterRankingPayload["templates"]["candidates"] {
  const byKey = new Map(bars.map((b) => [b.key, b]));
  const out: LegWriterRankingPayload["templates"]["candidates"] = [];
  for (const d of dynasties) {
    const bar = byKey.get(d.slug);
    byKey.delete(d.slug);
    const deprecated = d.status === "deprecated";
    out.push({
      key: d.slug,
      label: d.name,
      templateDynastySlug: d.slug,
      head: d.head,
      status: d.status,
      selectable: !deprecated && Boolean(d.head),
      notSelectableReason: deprecated ? "template_dynasty_deprecated" : d.head ? null : "template_dynasty_has_no_head",
      basis: bar?.basis ?? "flash",
      figures: bar ? { ...bar.figures } : { ...ZERO },
    });
  }
  // A version no dynasty of the pipe lists wrote here: listed with its figures, never picked (a run writes with a dynasty).
  for (const b of byKey.values()) {
    out.push({ key: b.key, label: b.label, templateDynastySlug: null, head: null, status: null, selectable: false, notSelectableReason: "no_dynasty_on_pipe", basis: b.basis, figures: { ...b.figures } });
  }
  return out;
}

type Bar = { key: string; label: string; basis: "mature" | "flash"; figures: { spentUsd: number; contacted: number; outcomes: number } };

/**
 * PURE. The LLM candidates, one per chat-service LLM DYNASTY (LLM-DYNASTY-1022-FS, every version's evidence pooled): every
 * dynasty a content-generation writer alias runs (zero until it writes) + every bar that wrote on the pipe. Which dynasty
 * an alias, a model id or a slug belongs to is chat-service's (`llmDyn`); a name it places in none keeps its own row keyed
 * on its model (`modelKey` of chat-service's name, else of the name). `modelBars` = the per-model detail (generationBuckets
 * `llmModels`, keyed `dynastyKey`); null on an internal pipe (its ledger names the alias, not the version: `models` empty).
 */
export function llmCandidates(
  bars: readonly Bar[],
  aliases: readonly WriterModelAlias[],
  models: readonly ServedModel[],
  llmDyn: LlmDynastyIndex = NO_LLM_DYNASTIES,
  modelBars: ReadonlyArray<Bar & { dynastyKey: string }> | null = [],
): LegWriterRankingPayload["llms"]["candidates"] {
  const servedOf = (name: string) => models.find((x) => x.modelId === name) ?? models.find((x) => x.aliases.includes(name)) ?? models.find((x) => x.formerAliases.includes(name));
  const keyOfName = (name: string) => {
    const d = llmDyn.dynastyOfName(name);
    if (d) return d.slug;
    const m = servedOf(name);
    return modelKey(m ? m.displayName || m.modelId : name);
  };
  type Acc = { label: string; aliases: LlmRow["aliases"]; modelIds: Set<string>; provider: string | null };
  const byKey = new Map<string, Acc>();
  for (const a of aliases) {
    const d = llmDyn.dynastyOfName(a.alias);
    const m = servedOf(a.alias);
    const key = keyOfName(a.alias);
    const acc = byKey.get(key) ?? { label: d?.name ?? (m?.displayName || a.alias), aliases: [], modelIds: new Set<string>(), provider: d?.provider || m?.provider || a.provider || null };
    acc.aliases.push({ alias: a.alias, provider: a.provider || m?.provider || d?.provider || "", status: a.status });
    if (m) acc.modelIds.add(m.modelId);
    byKey.set(key, acc);
  }
  const barOf = new Map(bars.map((b) => [b.key, b]));
  const keys = [...new Set([...byKey.keys(), ...barOf.keys()])];
  return keys.map((key) => {
    const acc = byKey.get(key);
    const bar = barOf.get(key);
    const d = llmDyn.bySlug(key);
    const sorted = [...(acc?.aliases ?? [])].sort((a, b) => (a.status === b.status ? (a.alias < b.alias ? -1 : 1) : a.status === "active" ? -1 : 1));
    const active = sorted.some((a) => a.status === "active");
    // A dynasty no name serves any more (DeepSeek Pro) keeps its history, never a pick.
    const runs = d ? d.servedToday : true;
    const basis = bar?.basis ?? "flash";
    const ownBars = (modelBars ?? []).filter((b) => b.dynastyKey === key);
    const detail: LlmModelDetail[] = [];
    if (d && modelBars) {
      for (const m of d.models) {
        const k = modelKey(m.displayName);
        const seen = detail.find((x) => x.key === k);
        if (seen) {
          if (!seen.modelIds.includes(m.modelId)) seen.modelIds.push(m.modelId);
          seen.head ||= m.modelId === d.headModelId;
          continue;
        }
        const b = ownBars.find((x) => x.key === k || x.key === modelKey(m.modelId));
        detail.push({ key: k, label: m.displayName, modelIds: [m.modelId], head: m.modelId === d.headModelId, basis, ...(b ? b.figures : ZERO) });
      }
    }
    for (const b of ownBars) if (!detail.some((x) => x.key === b.key)) detail.push({ key: b.key, label: b.label, modelIds: [], head: !d, basis, ...b.figures });
    const modelIds = new Set([...(acc?.modelIds ?? []), ...(d ? d.models.map((m) => m.modelId) : [])]);
    return {
      key,
      label: d?.name ?? bar?.label ?? acc?.label ?? key,
      llmDynastySlug: d?.slug ?? null,
      headModelId: d?.headModelId ?? null,
      aliases: sorted,
      modelIds: [...modelIds].sort(),
      provider: d?.provider || acc?.provider || null,
      models: detail,
      selectable: active && runs,
      notSelectableReason: !runs ? "llm_dynasty_not_served" : active ? null : acc ? "writer_alias_deprecated" : "no_writer_alias",
      basis,
      figures: bar ? { ...bar.figures } : { ...ZERO },
    };
  });
}

/**
 * PURE. An INTERNAL pipe's LLM bars (BEST-TPL-LLM-1022): its campaigns act on people another campaign holds, so each
 * campaign's spend is shared out on the people it acted on, and each person is filed under the LLM its latest act stated
 * on the follow-up ledger (`writerOf`, null = not on record: left out). Outcomes = the people of the LLM that reached the
 * pipe's step. Read MATURE once the outcomes reach the leg's bar on a leg that waits for nothing (the pipe's own rule:
 * an internal pipe has no dated cut), else everything to date, Learning.
 */
export function ledgerLlmBars(
  ran: ReadonlyArray<{ campaignId: string; spentUsd: number; acted: readonly string[]; reached: readonly string[] }>,
  writerOf: (campaignId: string, personKey: string) => { key: string; label: string } | null,
  legKey: string,
): { rows: Array<{ key: string; label: string; basis: "mature" | "flash"; figures: { spentUsd: number; contacted: number; outcomes: number } }>; leftOut: { contacted: number; outcomes: number }; recorded: number } {
  const by = new Map<string, { label: string; spentUsd: number; contacted: number; outcomes: number }>();
  const leftOut = { contacted: 0, outcomes: 0 };
  let recorded = 0;
  for (const c of ran) {
    if (c.acted.length === 0) continue;
    const share = c.spentUsd / c.acted.length;
    const reached = new Set(c.reached);
    for (const person of c.acted) {
      const w = writerOf(c.campaignId, person);
      const hit = reached.has(person) ? 1 : 0;
      if (!w) {
        leftOut.contacted += 1;
        leftOut.outcomes += hit;
        continue;
      }
      recorded += 1;
      const e = by.get(w.key) ?? { label: w.label, spentUsd: 0, contacted: 0, outcomes: 0 };
      e.spentUsd += share;
      e.contacted += 1;
      e.outcomes += hit;
      by.set(w.key, e);
    }
  }
  const waitsForNothing = legMaturity(legKey).durationDays === 0;
  const rows = [...by].map(([key, e]) => ({
    key,
    label: e.label,
    basis: (waitsForNothing && isMatureCount(e.outcomes, legKey) === true ? "mature" : "flash") as "mature" | "flash",
    figures: { spentUsd: e.spentUsd, contacted: e.contacted, outcomes: e.outcomes },
  }));
  return { rows, leftOut, recorded };
}

/** One pipe's evidence, computed in this process. */
export async function computeLegWriterRanking(featureSlug: string, rawLegKey: string): Promise<LegWriterRankingPayload> {
  const legKey = pipeLegKeyOf(featureSlug, rawLegKey);
  const rule = legMaturity(legKey);
  const pipeId = `${featureSlug}|${servedLegKeyOf(featureSlug, legKey)}`;
  const [dynastiesRead, aliasesRead, modelsRead, llmDynRead, internal] = await Promise.all([
    readTemplateDynasties(featureSlug, legKey),
    readWriterModelAliases().catch((error: Error) => error),
    readModelIds().catch((error: Error) => error),
    readLlmDynastiesSoft(`leg writer ranking ${featureSlug}|${rawLegKey}`),
    internalPipeToStep(featureSlug, legKey),
  ]);
  const llmDyn = llmDynastyIndex(llmDynRead);
  const dynasties = typeof dynastiesRead === "string" ? [] : dynastiesRead;
  const models = modelsRead instanceof Error ? [] : modelsRead;
  const aliases = aliasesRead instanceof Error ? [] : aliasesRead;
  if (aliasesRead instanceof Error) console.error(`[features-service] leg writer ranking ${pipeId}: writer aliases unreadable:`, aliasesRead.message);
  if (modelsRead instanceof Error) console.error(`[features-service] leg writer ranking ${pipeId}: chat-service models unreadable:`, modelsRead.message);
  const llmUnavailable = aliasesRead instanceof Error ? "writer_models_unreadable" : modelsRead instanceof Error ? "model_ids_unreadable" : null;
  const templateUnavailable = typeof dynastiesRead === "string" ? dynastiesRead : null;

  let bars: ReturnType<typeof generationBuckets> | null = null;
  let cutoffIso: string | null = null;
  let writerEvidence: LegWriterRankingPayload["writerEvidence"] = "measured";
  let internalLlm: ReturnType<typeof ledgerLlmBars> | null = null;
  if (internal) {
    // An internal pipe: the people its campaigns acted on, filed under the LLM the follow-up ledger states per act.
    const fleet = await getInternalPipeFleet(featureSlug, legKey, internal);
    const ran = fleet.ranCampaigns ?? [];
    const byBrand = new Map<string, string[]>();
    for (const c of ran) if (c.brandId) byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c.campaignId]);
    const aliases = new Map<string, string>();
    for (const [brandId, ids] of byBrand) for (const [k, v] of await fetchFollowupLlmAliases(brandId, ids)) aliases.set(k, v);
    const writerOf = (campaignId: string, person: string) => {
      const alias = aliases.get(`${campaignId}|${person.slice(person.indexOf(":") + 1)}`);
      if (!alias) return null;
      // Filed under the LLM DYNASTY the alias runs (chat-service's mapping), else the model it names.
      const d = llmDyn.dynastyOfName(alias);
      if (d) return { key: d.slug, label: d.name };
      const m = models.find((x) => x.modelId === alias) ?? models.find((x) => x.aliases.includes(alias)) ?? models.find((x) => x.formerAliases.includes(alias));
      return { key: modelKey(m?.displayName || alias), label: m?.displayName || alias };
    };
    internalLlm = ledgerLlmBars(ran, writerOf, legKey);
    if (internalLlm.recorded === 0) writerEvidence = "no_sequence_recorded_on_pipe";
  } else {
    const ev = await fetchFleetLegSlugEvidence(featureSlug, legKey, "own", "gross");
    cutoffIso = ev.cutoffIso;
    const persons = await fetchFleetPersonBuckets(featureSlug, new Set(ev.campaigns.map((c) => c.campaignId)));
    if (!persons.some((b) => b.generation)) writerEvidence = "no_sequence_recorded_on_pipe";
    const signal = rule.outcomeSignal === "positiveReply" ? "positiveReply" : rule.outcomeSignal === "clicked" ? "clicked" : "other";
    const split = { screened: isScreenedVisitLeg(legKey), signal, cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null } as const;
    // The same cells as the Research page (its dated spend only spreads the bars over months: the figures do not move).
    const cells = buildSlugCells({ legKey, ...split, flash: ev.flash, mature: ev.mature, persons, spend: [], orgOfCampaign: new Map(ev.campaigns.map((c) => [c.campaignId, c.orgId])) });
    const names = new Map(models.map((m) => [m.modelId, { label: m.displayName, tier: m.capabilityTier === "cheap" ? "Flash" : "Pro" } as ModelName]));
    bars = generationBuckets({ legKey, cells, persons, split, models: names, templateDynasties: templateDynastyIndex(dynastiesRead), llmDynasties: llmDyn });
  }
  const tplBars = bars?.tpl.rows ?? [];
  const llmBars = internalLlm?.rows ?? bars?.llm.rows ?? [];
  return {
    featureSlug,
    legKey,
    pipeId,
    computedAt: new Date().toISOString(),
    costBasis: "incurred",
    rankBasis: "cost_per_outcome",
    maturity: { durationDays: rule.durationDays, outcomesRequired: rule.outcomesRequired, cutoffIso },
    writerEvidence,
    templates: { candidates: templateCandidates(tplBars, dynasties), unavailableReason: templateUnavailable },
    llms: { candidates: llmCandidates(llmBars, aliases, models, llmDyn, internalLlm ? null : (bars?.llmModels ?? [])), unavailableReason: llmUnavailable, dynastiesUnavailableReason: llmDyn.unavailableReason },
    leftOut: { templates: bars?.tpl.leftOut ?? { contacted: 0, outcomes: 0 }, llms: internalLlm?.leftOut ?? bars?.llm.leftOut ?? { contacted: 0, outcomes: 0 } },
  };
}

// ── Build off the request path, persisted (the leg workflow ranking's pattern) ─────────────────────

const store = new Map<string, { value: LegWriterRankingPayload; computedAt: number }>();
const warming = new Map<string, Promise<void>>();
const cellKey = (key: string) => `leg-writer-ranking:${key}`;

export function warmLegWriterRanking(featureSlug: string, rawLegKey: string): Promise<void> {
  const legKey = pipeLegKeyOf(featureSlug, rawLegKey);
  const key = `${featureSlug}|${legKey}`;
  const entry = store.get(key);
  if (entry && Date.now() - entry.computedAt < FRESH_MS) return Promise.resolve();
  const inFlight = warming.get(key);
  if (inFlight) return inFlight;
  const warm = withTimeout(computeLegWriterRanking(featureSlug, legKey), WARM_TIMEOUT_MS, `leg writer ranking ${key}`)
    .then(async (value) => {
      // A rebuild that lost its writer evidence (the person cell or the sequence feed unreadable this time) never replaces
      // a measured build: workflow-service's runs THROW on a null pick (they state no writer of their own).
      const persisted = store.has(key) ? null : await loadFleetCell(cellKey(key)).catch(() => null);
      const prior = store.get(key)?.value ?? (persisted ? (JSON.parse(persisted.text) as LegWriterRankingPayload) : undefined);
      if (prior?.writerEvidence === "measured" && value.writerEvidence !== "measured") {
        console.error(`[features-service] leg writer ranking ${key}: rebuild read ${value.writerEvidence}, keeping the previous measured build`);
        return;
      }
      const computedAt = Date.now();
      store.set(key, { value, computedAt });
      await storeFleetCell(cellKey(key), JSON.stringify(value), computedAt);
    })
    .catch((error) => {
      console.error(`[features-service] leg writer ranking warm failed (${key}), keeping the previous value:`, error);
    })
    .finally(() => warming.delete(key));
  warming.set(key, warm);
  return warm;
}

/** The last build of one pipe (kicks a rebuild when stale); a pipe never built waits ≤ `waitMs`, then null. */
export async function readLegWriterRanking(featureSlug: string, rawLegKey: string, waitMs = 60_000): Promise<LegWriterRankingPayload | null> {
  const legKey = pipeLegKeyOf(featureSlug, rawLegKey);
  const key = `${featureSlug}|${legKey}`;
  if (!store.has(key)) {
    const stored = await loadFleetCell(cellKey(key));
    if (stored && !store.has(key)) {
      try {
        store.set(key, { value: JSON.parse(stored.text) as LegWriterRankingPayload, computedAt: stored.computedAt });
      } catch (error) {
        console.error(`[features-service] leg writer ranking ${key}: persisted copy unreadable, rebuilding:`, error);
      }
    }
  }
  if (store.has(key)) {
    void warmLegWriterRanking(featureSlug, legKey);
    return store.get(key)!.value;
  }
  try {
    return await awaitWarmStore(() => store.get(key)?.value ?? null, () => warmLegWriterRanking(featureSlug, legKey), waitMs, `leg writer ranking ${key}`);
  } catch (error) {
    console.error(`[features-service] leg writer ranking ${key} not built after ${Math.round(waitMs / 1000)}s:`, (error as Error).message);
    return null;
  }
}

/** Boot: warm every pipe holding a workflow assignment (one pipe at a time, behind `listen`). */
export async function warmEveryLegWriterRanking(): Promise<void> {
  const rows = await listLegAssignments();
  const pipes = [...new Map(rows.map((r) => [`${r.featureSlug}|${pipeLegKeyOf(r.featureSlug, r.legKey)}`, r])).values()];
  for (const r of pipes) await warmLegWriterRanking(r.featureSlug, r.legKey);
}

/** Test seam. */
export function __resetLegWriterRanking(): void {
  store.clear();
  warming.clear();
}

// ── Serving: one strategy applied on read ──────────────────────────────────────────────────────

export interface ServedWriterRanking {
  rows: Array<TemplateRow | LlmRow>;
  best: TemplateRow | LlmRow | null;
  excluded: WriterRanking["excluded"];
  /** Null when `best` is set; else why nothing is picked. */
  unavailableReason: string | null;
}

/**
 * PURE. A strategy's verdict on one template dynasty / one LLM dynasty, judged on its own key (the template dynasty's
 * slug, judged on its head's text; the LLM dynasty's slug, judged on its head model: LLM-DYNASTY-1022-FS).
 */
export function writerRuledOut(c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">, strategy: Strategy | null, kind: "template" | "llm") {
  if (!strategy) return undefined;
  const st = strategyOnSubject(strategy, kind, c.tactics);
  if (st.requiresTacticIds.length + st.excludesTacticIds.length === 0) return undefined;
  const nameOf = tacticNameOf(c as PlayCatalogue);
  return (key: string): string | null => strategyVerdict(st, c.tacticsByWriter.get(writerSubjectKey(kind, key)), nameOf).reason;
}

/** PURE. The payload ranked under a strategy (null = none). An LLM row keeps only the aliases the strategy allows. */
export function servedRankings(p: LegWriterRankingPayload, c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">, strategy: Strategy | null): { templates: ServedWriterRanking; llms: ServedWriterRanking } {
  const tplOf = new Map(p.templates.candidates.map((x) => [x.key, x]));
  const llmOf = new Map(p.llms.candidates.map((x) => [x.key, x]));
  const llmRule = writerRuledOut(c, strategy, "llm");
  const t = rankWriters(p.templates.candidates, writerRuledOut(c, strategy, "template"));
  const l = rankWriters(p.llms.candidates, llmRule);
  const tacticsOf = templateTacticsFrom(c);
  const tRows: TemplateRow[] = t.rows.map((r) => {
    const x = tplOf.get(r.key)!;
    const tactics = tacticsOf(r.key);
    return { ...r, templateDynastySlug: x.templateDynastySlug, head: x.head, status: x.status, tactics: tactics === "not_judged_yet" ? null : tactics, tacticsUnavailableReason: tactics === "not_judged_yet" ? tactics : null };
  });
  const lRows: LlmRow[] = l.rows.map((r) => {
    const x = llmOf.get(r.key)!;
    return { ...r, llmDynastySlug: x.llmDynastySlug ?? null, headModelId: x.headModelId ?? null, aliases: x.aliases, modelIds: x.modelIds, provider: x.provider, models: x.models ?? [] };
  });
  // `strategy_excludes_every_candidate`: a run could have written with one of them, the strategy ruled every such one
  // out (workflow-service refuses to write). `no_selectable_candidate`: nothing a run may write with, strategy or not.
  // A pipe with no writer on record yet still picks (WA-PIPE-RESEARCH-1023, owner 2026-10-23: the WhatsApp workflows read
  // their pipe's best template and LLM, « Learning when there is no outcome yet »): every candidate is then LEARNING at
  // $0, and the learning rule IS the exploration (rank 1 goes first, the next one once it has spent). Supersedes
  // BEST-TPL-LLM-1022's "never a pick on zero evidence": a pipe nobody may write for could never record a writer.
  const why = (unavailable: string | null, best: unknown, rows: unknown[], excluded: ReadonlyArray<{ key: string }>, selectable: (key: string) => boolean) =>
    best
      ? null
      : (unavailable ?? (excluded.some((x) => selectable(x.key)) ? "strategy_excludes_every_candidate" : rows.length === 0 && excluded.length === 0 ? "no_candidate" : "no_selectable_candidate"));
  const pick = (rows: Array<TemplateRow | LlmRow>, best: WriterRankingRow | null) => (best ? (rows.find((r) => r.key === best.key) ?? null) : null);
  const tBest = pick(tRows, t.best);
  const lBest = pick(lRows, l.best);
  return {
    templates: { rows: tRows, best: tBest, excluded: t.excluded, unavailableReason: why(p.templates.unavailableReason, tBest, tRows, t.excluded, (k) => tplOf.get(k)?.selectable === true) },
    llms: { rows: lRows, best: lBest, excluded: l.excluded, unavailableReason: why(p.llms.unavailableReason, lBest, lRows, l.excluded, (k) => llmOf.get(k)?.selectable === true) },
  };
}

function bad(res: Response, status: number, reason: string, error: string) {
  res.status(status).json({ error, reason });
}

router.get("/public/stats/leg-writer-ranking", async (req: Request, res: Response) => {
  const featureSlug = typeof req.query.featureSlug === "string" ? req.query.featureSlug : "";
  const leg = typeof req.query.leg === "string" ? req.query.leg : "";
  const strategyId = typeof req.query.strategyId === "string" && req.query.strategyId ? req.query.strategyId : null;
  if (!featureSlug || !leg) return bad(res, 400, "feature_and_leg_required", "featureSlug and leg are required");
  try {
    const catalogue = await loadPlayCatalogue();
    const strategy = strategyId ? (catalogue.strategies.get(strategyId) ?? null) : null;
    if (strategyId && !strategy) return bad(res, 404, "strategy_not_found", `no strategy ${strategyId}`);
    const p = await readLegWriterRanking(featureSlug, leg, 0);
    if (!p) return bad(res, 503, "writer_ranking_not_computed_yet", `the writer ranking of ${featureSlug}|${leg} is being built; retry in a few minutes`);
    // Each template dynasty's own icon + colour (MARKS-1022); LLM rows carry none (the dashboard draws the provider's logo).
    const served = await withTemplateRankingMarks(servedRankings(p, catalogue, strategy));
    res.json({ featureSlug: p.featureSlug, legKey: p.legKey, pipeId: p.pipeId, computedAt: p.computedAt, costBasis: p.costBasis, rankBasis: p.rankBasis, maturity: p.maturity, writerEvidence: p.writerEvidence, strategyId, leftOut: p.leftOut, ...served });
  } catch (error) {
    console.error("[features-service] leg writer ranking read failed:", error);
    bad(res, 500, "internal_error", "Internal server error");
  }
});

/** The pipe a workflow version runs on: its dynasty's ONE active leg (owner 2026-10-19, one leg per workflow). */
async function pipeOfWorkflow(workflowSlug: string): Promise<{ featureSlug: string; legKey: string; dynasty: string } | null> {
  const rows = (await listLegAssignments()).filter((r) => r.state === "active");
  const features = [...new Set(rows.map((r) => r.featureSlug))];
  // The feature whose dynasties prefix the slug first (`<dynasty>-vN`), then the rest: a version is listed by one feature.
  const likely = (f: string) => rows.some((r) => r.featureSlug === f && (workflowSlug === r.workflowDynastySlug || workflowSlug.startsWith(`${r.workflowDynastySlug}-`)));
  for (const f of [...features.filter(likely), ...features.filter((f) => !likely(f))]) {
    const w = (await fetchPublicWorkflows(f, "all")).find((x) => x.workflowSlug === workflowSlug || x.workflowDynastySlug === workflowSlug);
    if (!w) continue;
    const a = rows.find((r) => r.featureSlug === f && r.workflowDynastySlug === w.workflowDynastySlug);
    return a ? { featureSlug: f, legKey: a.legKey, dynasty: w.workflowDynastySlug } : null;
  }
  return null;
}

router.get("/internal/writer-pick", apiKeyOnly, async (req: Request, res: Response) => {
  const workflowSlug = typeof req.query.workflowSlug === "string" ? req.query.workflowSlug : "";
  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId ? req.query.campaignId : null;
  if (!workflowSlug) return bad(res, 400, "workflow_slug_required", "workflowSlug is required");
  try {
    const pipe = await pipeOfWorkflow(workflowSlug);
    if (!pipe) return bad(res, 404, "workflow_not_on_a_pipe", `${workflowSlug} is active on no pipe (GET /internal/workflow-leg-assignments)`);
    let salesFunnelId: string | null = null;
    if (campaignId) {
      // The campaign UNIT's own sales funnel names the play (the leg ladder's rule), so its strategy narrows the writers.
      const unit = await fetchCampaignSalesFunnelId(campaignId);
      if (!unit.found) return bad(res, 404, "campaign_not_found", `campaign-service lists no campaign ${campaignId}`);
      salesFunnelId = unit.salesFunnelId;
    }
    const [catalogue, played, p] = await Promise.all([loadPlayCatalogue(), playOfLegRead(pipe.featureSlug, pipe.legKey, salesFunnelId), readLegWriterRanking(pipe.featureSlug, pipe.legKey, 30_000)]);
    if (!p) return bad(res, 503, "writer_ranking_not_computed_yet", `the writer ranking of ${pipe.featureSlug}|${pipe.legKey} is being built: keep the workflow's own template and LLM`);
    const strategy = played ? (catalogue.strategies.get(played.answer.strategyId) ?? null) : null;
    // A play the pipe does not catalogue rules out every workflow on the ladder; here it rules out every writer too.
    const unknownPlay = played !== null && !strategy;
    const served = servedRankings(p, catalogue, strategy);
    const t = unknownPlay ? null : (served.templates.best as TemplateRow | null);
    const l = unknownPlay ? null : (served.llms.best as LlmRow | null);
    // The run calls the DYNASTY SLUG when content-generation accepts it (LLM-DYNASTY-1022-CG: every name chat-service
    // accepts, slugs included); else an active legacy alias of the same dynasty (chat-service runs the same head).
    const activeAliases = l?.aliases.filter((a) => a.status === "active") ?? [];
    const alias = activeAliases.find((a) => a.alias === l?.llmDynastySlug) ?? activeAliases[0] ?? null;
    const figures = (r: WriterRankingRow) => ({ place: r.place, costPerOutcomeUsd: r.costPerOutcomeUsd, explorePriceUsd: r.explorePriceUsd, isMature: r.isMature, spentUsd: r.spentUsd, outcomes: r.outcomes, contacted: r.contacted });
    res.json({
      workflowSlug,
      workflowDynastySlug: pipe.dynasty,
      featureSlug: pipe.featureSlug,
      legKey: p.legKey,
      pipeId: p.pipeId,
      strategyId: strategy?.id ?? null,
      computedAt: p.computedAt,
      template: t ? { templateDynastySlug: t.templateDynastySlug, head: t.head, name: t.label, ...figures(t) } : null,
      templateUnavailableReason: t ? null : unknownPlay ? "play_not_catalogued_on_pipe" : served.templates.unavailableReason,
      // `llmDynastySlug` names the dynasty rank 1 is (LLM-DYNASTY-1022-FS: chat-service runs its head when called by the slug).
      llm: l && alias ? { model: alias.alias, llmDynastySlug: l.llmDynastySlug, headModelId: l.headModelId, provider: alias.provider || l.provider, modelKey: l.key, label: l.label, ...figures(l) } : null,
      llmUnavailableReason: l && alias ? null : unknownPlay ? "play_not_catalogued_on_pipe" : served.llms.unavailableReason,
    });
  } catch (error) {
    console.error(`[features-service] writer pick ${workflowSlug} failed:`, error);
    bad(res, 502, "writer_pick_unreadable", `the writer pick could not be read: ${(error as Error).message}`);
  }
});

export default router;
