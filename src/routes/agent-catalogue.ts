import { leadStateFamilyOf, leadStateRankOf } from "../lib/lead-states.js";
import { Router, type Request, type Response } from "express";
import { isOutcomeSubjectKind, OUTCOME_SUBJECT_KINDS, type OutcomeSubjectKind } from "../lib/outcome-subject.js";
import { apiKeyOnly } from "../middleware/auth.js";
import { GLYPH_COLORS, MARK_FAMILIES, MARK_ICONS } from "../lib/catalogue-marks.js";
import { marksFor } from "../lib/catalogue-marks-store.js";
import {
  valueAddedTo,
  buildCatalogueModel,
  byRoi,
  isMeasuredRate,
  roiBasisOf,
  STEP_VALUE_ESTIMATES,
  channelEconomics,
  channelRunnable,
  funnelRunnable,
  funnelMixed,
  funnelTypeOf,
  pathRunnable,
  pipeRunnable,
  FAMILY_GLYPHS,
  funnelById,
  funnelFirstStep,
  funnelTrigger,
  pathTrigger,
  funnelIdOf,
  legChannelOf,
  legPipes,
  legStepsOf,
  pathById,
  pipesOnLeg,
  funnelLine,
  outcomesNeededPerPayingClient,
  funnelsOfPath,
  glyphColorOf,
  legRateOf,
  matchesQuery,
  pathEconomics,
  pathIdOf,
  pathLine,
  phosphorIconOf,
  pipeIdOf,
  pipeIdentityOf,
  pipeLine,
  pipeOrPlayById,
  playsOfPipe,
  salesPathNameKeyOf,
  stepEconomics,
  stepLabel,
  type CatalogueFunnel,
  type CatalogueModel,
  type CatalogueStep,
  type CataloguePath,
  type CataloguePipe,
  type Economics,
  type FunnelLeg,
  type PipeMeasurement,
  type PlayInput,
  TRIGGER_HEAD,
  triggerHeadOf,
  triggerHeadedPath,
  triggerHeadedPathId,
  triggerHeadRefusal,
  type TriggerHeadRefusal,
} from "../lib/agent-catalogue.js";
import { faceOf, faceSvg } from "../lib/catalogue-faces.js";
import { getPipeStats, type PipeStatsPipe, type PipeStatsScope } from "../lib/pipe-stats.js";
import { matchChannelStepKey, CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import { codedStepLifecycleRungOf, isStepLifecycleRung, lifecycleRankOf, LIFECYCLE_RUNG_VALUES, servedLifecycleLadder, type StepLifecycleRung } from "../lib/lifecycle-ladder.js";
import {
  insertLeg,
  insertLegRate,
  insertSalesPath,
  insertSalesPathChain,
  insertStep,
  updateDeclaredStep,
  listDeclaredSalesPathChains,
  listDeclaredSalesPaths,
  listDeclaredSteps,
  listTriggerCatalogue,
  listTriggerTypes,
  loadChannelCatalogue,
  registerStepDeclarations,
  retireLeg,
  retireSalesPath,
  retireTrigger,
  type LoadedCatalogue,
} from "../lib/channel-declarations-store.js";
import { campaignsOnTrigger, campaignsRunningFunnel, fetchFleetCampaignRows, fetchFleetLegCampaignsFor, type FleetCampaignRef } from "../lib/fleet-leg-campaigns.js";
import { actorOf, DeclarationError, isTriggerCoded, parseLegInput, refuseCustomer, requestedByOrgIdOf, runnableOnlyOf, type TriggerTypeRecord } from "../lib/channel-declarations.js";
import { allNamesByKey, renameFunnelsToDescriptiveNames, salesPathNamesFor, SalesPathNamePoolExhaustedError, seedPipeTriggerOf } from "../lib/sales-path-names.js";
import { funnelTriggerLabel } from "../lib/funnel-descriptions.js";
import { pluralLabelOf, triggerOutcomeKeyOf, triggerTypeOf, triggerValueOf } from "../lib/outcome-vocabulary.js";
import { canonicalTriggerId, IncludeInlineQueryError, includeInlineOf, isEntryDoor, triggerCallable } from "../lib/channel-triggers.js";
import { funnelShortDescription, type ShortDescriptionUnavailableReason } from "../lib/funnel-short-descriptions.js";
import { triggerCondition } from "../lib/trigger-conditions.js";
import { LEAD_SOURCING_SLUG, SOURCE_LEG_KEY } from "../lib/sourcing-origins.js";

/** The Lead Sourcing pipe, named in the one-channel-per-leg refusal. */
const LEAD_SOURCING_PIPE_ID = `${LEAD_SOURCING_SLUG}|${SOURCE_LEG_KEY}`;
import { campaignNameKeyOf } from "../lib/offer-sales-paths.js";
import { getBrandEffectiveRates, getFleetLifetimeRevenueMedian, legPairKey, peekFleetStatedMedians } from "../lib/effective-conversion-rates.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { fetchTeamCrmLegRates } from "../lib/team-crm-leg-rates.js";
import { fetchOfferSteps, OfferStepsOfferNotFoundError, OfferStepsUnreadableError, type OfferSteps } from "../lib/offer-steps-client.js";
import { ALWAYS_PRESENT_STEPS, missingStepsOf, setAsideCountByStep, splitByOfferSteps } from "../lib/offer-step-fit.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { awaitWarmStore, StoreNotComputedError } from "../lib/await-warm-store.js";
import { pipeLegKeyOf, servedCombinationKeyOf, servedLegKeyOf, storedCombinationKeyOf, storedLegKeyOf } from "../lib/funnel-legs.js";
import { listLegAssignments, listRunnableLegAssignments } from "../lib/workflow-leg-assignments.js";
import { invalidateChannelCatalogue, fleetLegPrice, fleetPlayPrices, readLegWorkflowRanking } from "./public.js";
import type { LegPrice } from "../lib/outcome-prices.js";
import type { LegAssignmentRow } from "../lib/workflow-leg-assignments.js";
import { updateTacticSubject } from "../lib/plays-store.js";
import { clearDefaultPlay, insertPlay, retirePlay, insertStrategy, insertTactic, invalidatePlayCatalogue, listVerdicts, listWriterVerdicts, loadPlayCatalogue, proposeStrategyEdit, storeStrategyEdit, updateTacticClientLine, updateTacticDescription } from "../lib/plays-store.js";
import { kickTacticJudgments, SWEEP_EVERY_MS } from "../lib/tactic-judgments.js";
import { defaultStrategyOf, excludedDynasties, playBlockOf, playIdOf, splitPlayId, subjectOfTactic, tacticJudgingOf, tacticNameOf, TACTIC_SUBJECTS, workflowStrategyOf, type TacticSubject, type PlayCatalogue, type Strategy, type Tactic } from "../lib/plays.js";
import { pgErrorOf } from "../lib/pg-error.js";

/**
 * THE AGENT CATALOGUE (owner 2026-10-10, "chat first"; the model and every formula: `lib/agent-catalogue.ts`).
 *
 * Context-window-sized reads: per object (step, sales path, channel, pipe, sales funnel, workflow) a LIST the
 * agent filters (`q` text search, the "contains at least one of" filters, `limit` default 10, max 25), each
 * row id + name + icon + one line + average cost + average ROI (or `learning`), a page staying ~2k tokens;
 * then a DETAIL read per id. Creates are DATA (owner 2026-10-09): a step, a pipe, a sales path, a sales
 * funnel; each new object gets a never-given name of its family on creation (`lib/catalogue-names.ts`).
 *
 * Service-key only (`/internal/catalogue/*`): the agent runs in a service, every client sees the same
 * catalogue; draft objects (a declared leg not yet published) are listed with `draft: true`. The face SVG of
 * a funnel name is public (`/public/catalogue/faces/:name.svg`), the dashboard shows it as an image.
 *
 * Names are assigned ON FIRST SIGHT (the rows a page shows, never the whole combinatory) and on creation:
 * a path or a funnel is persisted and named the first time something uses it.
 */
const router = Router();

type Body = Record<string, unknown>;

// ── Fleet pipe measurements (off the request path) ────────────────────────────────────────────────

const MEASUREMENTS_FRESH_MS = 15 * 60_000;
const MEASUREMENT_TIMEOUT_MS = 120_000;
const MEASUREMENT_CONCURRENCY = 3;
/** First read after boot waits on the first build up to this long, then 503 `catalogue_economics_not_computed_yet`. */
const MEASUREMENTS_BOOT_WAIT_MS = 150_000;

interface MeasurementStore {
  byPipe: Map<string, PipeMeasurement>;
  /** Every NON-default play's measurement, keyed by play id (`lib/plays.ts`). A pipe's default play is `byPipe`. */
  byPlay: Map<string, PipeMeasurement>;
  /** Pipes whose fleet read failed: served `learning` with reason `measurement_unreadable`, logged loud. */
  unreadable: Set<string>;
  computedAt: string;
  /** The fleet lifetime-revenue median the figures were built with, kept beside them so a fresh process can serve
   *  it before its own fleet sweep ends (null on a store built before this field existed). No leg-rate median
   *  since 2026-10-14 (a stored copy still carrying `arrows` has them ignored). */
  fleet: { lifetimeRevenue: { usd: number | null; offerCount: number } } | null;
}

/**
 * THE PERSISTED WARM COPY (2026-10-10: after each deploy, catalogue reads waited up to 150 s on the rebuild
 * and chat-service's 30 s calls timed out three times in a row). Every build is stored
 * (`lib/fleet-cell-store.ts`); a fresh process installs the stored copy on its first read and rebuilds
 * BEHIND it, swapping when the new build is ready. A read waits on a build only when no copy was ever
 * stored (the very first boot): never served empty, never blocked while a copy exists.
 */
const FIGURES_CELL_KEY = "agent-catalogue-figures";

interface StoredFigures {
  computedAt: string;
  byPipe: Array<[string, PipeMeasurement]>;
  byPlay?: Array<[string, PipeMeasurement]>;
  unreadable: string[];
  fleet: { lifetimeRevenue: { usd: number | null; offerCount: number } } | null;
}

export function serializeFigures(v: MeasurementStore): string {
  const out: StoredFigures = {
    computedAt: v.computedAt,
    byPipe: [...v.byPipe],
    byPlay: [...v.byPlay],
    unreadable: [...v.unreadable],
    fleet: v.fleet ? { lifetimeRevenue: v.fleet.lifetimeRevenue } : null,
  };
  return JSON.stringify(out);
}

export function parseFigures(text: string): MeasurementStore {
  const s = JSON.parse(text) as StoredFigures;
  if (!Array.isArray(s.byPipe) || !Array.isArray(s.unreadable) || typeof s.computedAt !== "string") throw new Error("not a stored catalogue figures cell");
  return {
    byPipe: new Map(s.byPipe),
    byPlay: new Map(s.byPlay ?? []),
    unreadable: new Set(s.unreadable),
    computedAt: s.computedAt,
    fleet: s.fleet ? { lifetimeRevenue: s.fleet.lifetimeRevenue } : null,
  };
}

let persistedLoad: Promise<void> | null = null;

/** Install the stored copy when this process holds none (single-flight; a failed read is logged and the
 *  process builds as before). */
function installPersistedFigures(): Promise<void> {
  if (measurementStore) return Promise.resolve();
  persistedLoad ??= (async () => {
    const stored = await loadFleetCell(FIGURES_CELL_KEY);
    if (!stored || measurementStore) return;
    try {
      measurementStore = { value: parseFigures(stored.text), at: stored.computedAt };
      console.log(`[features-service] agent catalogue: serving the stored figures of ${new Date(stored.computedAt).toISOString()} while this process rebuilds`);
    } catch (error) {
      console.error("[features-service] agent catalogue: stored figures unreadable, rebuilding before serving:", error);
    }
  })().finally(() => {
    persistedLoad = null;
  });
  return persistedLoad;
}

let measurementStore: { value: MeasurementStore; at: number } | null = null;
let measurementWarm: Promise<void> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => timer && clearTimeout(timer));
}

async function computeMeasurements(): Promise<MeasurementStore> {
  const cat = await loadChannelCatalogue({ publishedOnly: false });
  const pipes = cat.channels.flatMap((c) =>
    c.operatedBy === "platform" ? c.stepTransitions.map((t) => ({ slug: c.slug, computedLegKey: t.legKey, id: pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)) })) : [],
  );
  const byPipe = new Map<string, PipeMeasurement>();
  const byPlay = new Map<string, PipeMeasurement>();
  const unreadable = new Set<string>();
  const plays = await loadPlayCatalogue();
  const nameOf = tacticNameOf(plays);
  // A pipe whose read fails in THIS build keeps the measurement of the build it replaces (the last computed
  // figure, same rule as the whole store): one transient fleet-read timeout must not turn a measured pipe
  // learning for a whole fresh window, nor be persisted for the next process (2026-10-10: Lumen read
  // `measurement_unreadable` after a restart). Only a pipe never measured reads unreadable.
  const previous = measurementStore?.value.byPipe ?? new Map<string, PipeMeasurement>();
  const previousPlays = measurementStore?.value.byPlay ?? new Map<string, PipeMeasurement>();
  const measured = (price: LegPrice): PipeMeasurement => ({ basis: price.basis, costPerOutcomeUsd: price.costPerOutcomeUsd, conversionRatePct: price.conversionRatePct, workflowDynastySlug: price.workflowDynastySlug });
  await mapWithConcurrency(pipes, MEASUREMENT_CONCURRENCY, async (p) => {
    // A pipe cataloguing plays prices each on its best ALLOWED workflow; its default play is the pipe's own figure.
    const catalogued = plays.playsByPipe.get(p.id) ?? [];
    try {
      if (catalogued.length === 0) {
        byPipe.set(p.id, measured(await withTimeout(fleetLegPrice(p.slug, p.computedLegKey), MEASUREMENT_TIMEOUT_MS, `pipe ${p.id}`)));
        return;
      }
      const strategiesInOrder = [defaultStrategyOf(plays, p.id), ...catalogued.filter((x) => !x.isDefault).map((x) => plays.strategies.get(x.strategyId) ?? null)];
      const prices = await withTimeout(
        fleetPlayPrices(p.slug, p.computedLegKey, (dynasties) => strategiesInOrder.map((st) => new Set(excludedDynasties(st && workflowStrategyOf(plays, st), dynasties, plays.tacticsByDynasty, nameOf).keys()))),
        MEASUREMENT_TIMEOUT_MS,
        `pipe ${p.id}`,
      );
      byPipe.set(p.id, measured(prices[0]));
      catalogued.filter((x) => !x.isDefault).forEach((x, i) => byPlay.set(playIdOf(p.id, x.strategyId), measured(prices[i + 1])));
    } catch (error) {
      for (const x of catalogued) {
        const id = playIdOf(p.id, x.strategyId);
        const lastPlay = previousPlays.get(id);
        if (!x.isDefault && lastPlay) byPlay.set(id, lastPlay);
      }
      const last = previous.get(p.id);
      if (last) {
        byPipe.set(p.id, last);
        console.error(`[features-service] agent catalogue: fleet measurement of pipe ${p.id} failed; it keeps its last computed measurement:`, error);
        return;
      }
      unreadable.add(p.id);
      console.error(`[features-service] agent catalogue: fleet measurement of pipe ${p.id} failed; it reads learning (measurement_unreadable):`, error);
    }
  });
  // The median beside the figures (a background build may wait on the fleet sweep; a read never does).
  const lifetimeRevenue = await getFleetLifetimeRevenueMedian();
  return { byPipe, byPlay, unreadable, computedAt: new Date().toISOString(), fleet: { lifetimeRevenue } };
}

/** Rebuild in the background when absent or past its fresh window (single-flight). */
export function warmCatalogueMeasurements(): Promise<void> {
  if (measurementStore && Date.now() - measurementStore.at < MEASUREMENTS_FRESH_MS) return Promise.resolve();
  if (measurementWarm) return measurementWarm;
  measurementWarm = computeMeasurements()
    .then(async (value) => {
      const at = Date.now();
      measurementStore = { value, at };
      await storeFleetCell(FIGURES_CELL_KEY, serializeFigures(value), at);
    })
    .catch((error) => console.error("[features-service] agent catalogue measurements warm failed, keeping the previous value:", error))
    .finally(() => {
      measurementWarm = null;
    });
  return measurementWarm;
}

/**
 * A play write (a play catalogued, a pipe's default set) changes which workflows a play may pick, so the figures priced
 * on the previous plays are stale: rebuild them now (behind the served copy), never 15 min later. A build already in
 * flight read the OLD plays, so the rebuild waits for it and runs after (RANKING-SOURCE-LEG-1014: Lead Sourcing's
 * default read `bestWorkflowSlug: samaya` while its new strategy allowed only scheat).
 */
let playWriteRefresh: Promise<void> | null = null;
export function refreshCatalogueMeasurementsAfterPlayWrite(): Promise<void> {
  const stale = () => {
    if (measurementStore) measurementStore = { ...measurementStore, at: 0 };
  };
  stale();
  const refresh = (measurementWarm ?? Promise.resolve()).then(() => {
    stale();
    return warmCatalogueMeasurements();
  });
  const tracked: Promise<void> = refresh.finally(() => {
    if (playWriteRefresh === tracked) playWriteRefresh = null;
  });
  playWriteRefresh = tracked;
  return tracked;
}

/** Test seams. */
export function __setCatalogueMeasurementsForTest(byPipe: Map<string, PipeMeasurement>, byPlay?: Map<string, PipeMeasurement>): void {
  measurementStore = { value: { byPipe, byPlay: byPlay ?? new Map(), unreadable: new Set(), computedAt: new Date(0).toISOString(), fleet: null }, at: Date.now() };
}
export async function __awaitCatalogueMeasurementsForTest(): Promise<void> {
  while (playWriteRefresh || measurementWarm) await (playWriteRefresh ?? measurementWarm);
}
export function __resetCatalogueMeasurements(): void {
  measurementStore = null;
  measurementWarm = null;
  persistedLoad = null;
}

// The served spelling of a pipe's leg (an outbound channel's entry leg reads `lead_found_to_*`).
const servedPipeLegKey = (slug: string, legKey: string): string => servedLegKeyOf(slug, legKey);

// ── The model, per request ────────────────────────────────────────────────────────────────────────

interface Loaded {
  model: CatalogueModel;
  measurements: MeasurementStore;
  names: Map<string, string>;
  cat: LoadedCatalogue;
}

/** The fleet lifetime-revenue median a read prices on: this process's own when computed, else the stored copy's,
 *  else (the very first boot only) the sweep itself. */
async function fleetMediansFor(stored: MeasurementStore["fleet"]): Promise<NonNullable<MeasurementStore["fleet"]>> {
  const own = peekFleetStatedMedians();
  if (own) return { lifetimeRevenue: own.lifetimeRevenue };
  if (stored) return { lifetimeRevenue: stored.lifetimeRevenue };
  return { lifetimeRevenue: await getFleetLifetimeRevenueMedian() };
}

/**
 * A PER-OFFER read (2026-10-10: the signup's "Your campaign" step and payment wall priced the proposed funnel
 * on the FLEET estimate, while the old flow showed THIS offer's return on the client value the visitor
 * typed). `?offerId=&brandId=` + the `x-org-id` header: the same formula as the catalogue, with the OFFER's
 * lifetime revenue (stated, else the fleet median, `lib/offer-lifetime-revenue.ts`) and its brand's own leg
 * rates where it has them (measured on its leads / CRM, or stated), else the fleet's. Pipe costs stay the
 * fleet's measured ones. Null when the read names no offer.
 */
export interface OfferContext {
  offerId: string;
  brandId: string;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: "offer_stated" | "fleet_median" | null;
  rates: Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" | "offer_team_measured" }>;
  /** The steps the offer's business has (owner 2026-10-12, `lib/offer-step-fit.ts`): a funnel through a step it does not have is SET ASIDE. */
  steps: OfferSteps;
}

async function offerContextOf(req: Request): Promise<OfferContext | null> {
  const offerId = typeof req.query.offerId === "string" && req.query.offerId !== "" ? req.query.offerId : null;
  if (!offerId) return null;
  const brandId = typeof req.query.brandId === "string" && req.query.brandId !== "" ? req.query.brandId : null;
  const orgId = typeof req.headers["x-org-id"] === "string" ? req.headers["x-org-id"] : null;
  if (!brandId) throw new BadQuery("brand_required", "a per-offer read (offerId) also names its brandId");
  if (!orgId) throw new BadQuery("org_required", "a per-offer read needs the x-org-id header (the offer's org)");
  const legEconomics = await fetchBrandLegEconomics(brandId, orgId);
  const offer = legEconomics.offers.find((o) => o.offerId === offerId);
  if (!offer) throw new DeclarationError(404, "offer_not_found", `offer ${offerId} is not an offer of brand ${brandId}`);
  // Every leg the customer's own team works (a step to a step): its rate may be read off the brand's tools.
  const teamLegs = (await loadChannelCatalogue({ publishedOnly: false })).channels
    .filter((c) => c.operatedBy === "customer")
    .flatMap((c) => c.stepTransitions.filter((t) => t.from !== null).map((t) => ({ fromStep: t.from!.key, toStep: t.to.key })));
  const header = (k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string) : undefined);
  const [ltr, effective, teamRates, steps] = await Promise.all([
    offerLifetimeRevenue(offer.lifetimeRevenueUsd),
    getBrandEffectiveRates(brandId, orgId, legEconomics),
    fetchTeamCrmLegRates(orgId, brandId, teamLegs),
    fetchOfferSteps(brandId, offerId, { orgId, userId: header("x-user-id"), runId: header("x-run-id") }),
  ]);
  const rates = new Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" | "offer_team_measured" }>();
  for (const r of effective.legs) {
    if (r.effectiveRatePct === null || (r.source !== "measured" && r.source !== "manual")) continue;
    rates.set(legPairKey(r.fromStep, r.toStep), { ratePct: r.effectiveRatePct, source: r.source === "measured" ? "offer_measured" : "offer_stated" });
  }
  // A leg the brand's effective rates leave unrated: the team's own history on it (`lib/team-crm-leg-rates.ts`).
  for (const [leg, r] of teamRates) if (!rates.has(leg) && r.ratePct > 0) rates.set(leg, { ratePct: r.ratePct, source: "offer_team_measured" });
  return { offerId, brandId, lifetimeRevenueUsd: ltr.usd, lifetimeRevenueSource: ltr.source, rates, steps };
}

/**
 * What the offer stated about its steps, served beside every per-offer list/detail (owner 2026-10-12):
 * `stated:false` = never said (nothing set aside); `alwaysPresent` = the steps counted present by definition.
 */
const offerStepsEcho = (o: OfferContext, m: CatalogueModel) => ({
  stated: o.steps.stated,
  steps: o.steps.steps ? o.steps.steps.map((k) => ({ id: k, name: stepLabel(m, k) })) : null,
  statedAt: o.steps.statedAt,
  alwaysPresent: ALWAYS_PRESENT_STEPS.map((k) => ({ id: k, name: stepLabel(m, k) })),
});

/** The steps a set-aside row lacks, `{id, name}` like a path detail's steps. */
const missingStepsWire = (m: CatalogueModel, keys: readonly string[]) => keys.map((k) => ({ id: k, name: stepLabel(m, k) }));

/** `setAsideByStep`: each missing step with how many set-aside rows it accounts for (the question to ask the client first). */
const setAsideByStepWire = (m: CatalogueModel, setAside: ReadonlyArray<{ missingSteps: readonly string[] }>) =>
  setAsideCountByStep(setAside).map((c) => ({ id: c.step, name: stepLabel(m, c.step), setAsideCount: c.setAsideCount }));

/** The `offer` block a per-offer read answers with (null on the fleet catalogue). */
const offerEcho = (o: OfferContext | null) =>
  o ? { offerId: o.offerId, brandId: o.brandId, lifetimeRevenueUsd: o.lifetimeRevenueUsd, lifetimeRevenueSource: o.lifetimeRevenueSource, ownRateLegs: o.rates.size } : null;

async function loadModel(offer: OfferContext | null = null): Promise<Loaded> {
  await installPersistedFigures();
  void warmCatalogueMeasurements();
  const [measurements, all, pub, declaredSteps, names, triggers, assignments, playCatalogue, chains, statedFunnels] = await Promise.all([
    awaitWarmStore(() => measurementStore?.value ?? null, warmCatalogueMeasurements, MEASUREMENTS_BOOT_WAIT_MS, "catalogue economics"),
    loadChannelCatalogue({ publishedOnly: false }),
    loadChannelCatalogue({ publishedOnly: true }),
    listDeclaredSteps(),
    allNamesByKey(),
    listTriggerCatalogue(),
    // What can RUN (PLAY-SEED-LADDER-1022): a pipe / play is runnable on workflows workflow-service still executes,
    // merges pooled, never on an assignment row alone (the leg read campaign-service seeds from serves only those).
    listRunnableLegAssignments(),
    loadPlayCatalogue(),
    listDeclaredSalesPathChains(),
    listDeclaredSalesPaths(),
  ]);
  const workflowPipeKeys = new Set(assignments.filter((a) => a.state === "active").map((a) => `${a.featureSlug}|${pipeLegKeyOf(a.featureSlug, a.legKey)}`));
  const { lifetimeRevenue: ltr } = await fleetMediansFor(measurements.fleet);
  const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
  const model = buildCatalogueModel({
    channels: all.channels,
    publishedPipeIds,
    workflowPipeKeys,
    declaredSteps,
    measurements: measurements.byPipe,
    lifetimeRevenueUsd: offer ? offer.lifetimeRevenueUsd : ltr.usd,
    lifetimeRevenueBasis: offer?.lifetimeRevenueSource === "offer_stated" ? "stated" : "fleet",
    ...(offer ? { offerRates: offer.rates } : {}),
    triggers,
    plays: playInputsOf(playCatalogue, assignments, measurements.byPlay),
    retiredPlays: playCatalogue.retiredByPipe,
    triggerHeadedPaths: statedTriggerHeadedPaths(chains, statedFunnels),
  });
  for (const id of measurements.unreadable) {
    const p = model.pipes.get(id);
    if (p && p.economics.status === "learning") p.economics = { ...p.economics, reason: "measurement_unreadable" };
  }
  return { model, measurements, names, cat: all };
}

const nameKeyOfPipe = (p: Pick<CataloguePipe, "channelSlug" | "legKey">): string => campaignNameKeyOf(p.channelSlug, p.legKey);

/**
 * The trigger-headed paths stated through the creates (owner 2026-10-15): a sales path created with a trigger, and the
 * path of a sales funnel created with one (its combination key starts `trigger:`). Deduped by id.
 */
function statedTriggerHeadedPaths(
  chains: ReadonlyArray<{ pathId: string; legKeys: string[] }>,
  funnels: ReadonlyArray<{ combinationKey: string }>,
): Array<{ triggerId: string; legKeys: string[] }> {
  const out = new Map<string, { triggerId: string; legKeys: string[] }>();
  for (const c of chains) {
    const head = triggerHeadOf(c.pathId);
    if (head) out.set(c.pathId, { triggerId: head.triggerId, legKeys: head.rest.split("+") });
  }
  for (const f of funnels) {
    const head = triggerHeadOf(servedCombinationKeyOf(f.combinationKey));
    if (!head) continue;
    const legKeys = head.rest.split("+").map((part) => part.split("@")[0]);
    out.set(triggerHeadedPathId(head.triggerId, legKeys), { triggerId: head.triggerId, legKeys });
  }
  return [...out.values()];
}

/** The status and words of a refused trigger head (`triggerHeadRefusal`). */
const triggerHeadError = (reason: TriggerHeadRefusal, triggerId: string, legKeys: readonly string[]): DeclarationError =>
  reason === "trigger_not_found"
    ? new DeclarationError(404, reason, `no trigger ${triggerId} (GET /internal/catalogue/triggers)`)
    : reason === "trigger_without_step"
      ? new DeclarationError(400, reason, `${triggerId} starts from no step, so no leg can follow it here; pick a trigger with a step (GET /internal/catalogue/triggers: fromStep)`)
      : reason === "trigger_step_mismatch"
        ? new DeclarationError(400, reason, `${legKeys[0]} does not leave from the step ${triggerId} starts from: the first leg must leave from it`)
        : new DeclarationError(400, reason, `${legKeys.join("+")}: the legs must chain from the trigger's step to paid_client, each performed by a channel (GET /internal/catalogue/pipes)`);

/**
 * Each cataloguing pipe's plays as the model prices them (`lib/plays.ts`): the default play and the others, each with
 * what its strategy excludes among the workflows ASSIGNED to the pipe, read LIVE (a verdict stored a minute ago
 * already counts), and its measurement from the last figures build.
 */
function playInputsOf(c: PlayCatalogue, assignments: readonly LegAssignmentRow[], byPlay: ReadonlyMap<string, PipeMeasurement>): Map<string, { default: PlayInput | null; others: PlayInput[] }> {
  const nameOf = tacticNameOf(c);
  const judgingOf = tacticJudgingLookup(c);
  const out = new Map<string, { default: PlayInput | null; others: PlayInput[] }>();
  for (const [pipeId, list] of c.playsByPipe) {
    const [slug, leg] = [pipeId.slice(0, pipeId.indexOf("|")), pipeId.slice(pipeId.indexOf("|") + 1)];
    const onPipe = assignments.filter((a) => a.featureSlug === slug && pipeLegKeyOf(slug, a.legKey) === pipeLegKeyOf(slug, leg));
    const inputOf = (strategyId: string): PlayInput | null => {
      const st = c.strategies.get(strategyId);
      if (!st) return null;
      const excluded = excludedDynasties(workflowStrategyOf(c, st), onPipe.map((a) => a.workflowDynastySlug), c.tacticsByDynasty, nameOf);
      const active = onPipe.filter((a) => a.state === "active").map((a) => a.workflowDynastySlug);
      return {
        block: playBlockOf(workflowStrategyOf(c, st), active, c.tacticsByDynasty, judgingOf, nameOf),
        strategyId,
        strategyName: st.name,
        strategyDescription: st.description,
        measurement: byPlay.get(playIdOf(pipeId, strategyId)) ?? null,
        allowedActiveWorkflowCount: onPipe.filter((a) => a.state === "active" && !excluded.has(a.workflowDynastySlug)).length,
        allowedActiveDynasties: [...new Set(onPipe.filter((a) => a.state === "active" && !excluded.has(a.workflowDynastySlug)).map((a) => a.workflowDynastySlug))].sort(),
        excludedDynasties: [...excluded.keys()].sort(),
      };
    };
    const def = list.find((p) => p.isDefault);
    out.set(pipeId, {
      default: def ? inputOf(def.strategyId) : null,
      others: list.filter((p) => !p.isDefault).map((p) => inputOf(p.strategyId)).filter((p): p is PlayInput => p !== null),
    });
  }
  return out;
}

// ── Query parsing ─────────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

class BadQuery extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function limitOf(req: Request): number {
  const raw = req.query.limit;
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new BadQuery("limit_unrecognised", `limit must be a whole number in 1..${MAX_LIMIT}`);
  return n;
}

/** A comma list. For an id list (`ids`), a `+` sent unencoded arrives as a space (form decoding) and is put
 *  back: an id never holds a space. A step list keeps its spaces (labels: "Meeting booked"). */
function listOf(req: Request, field: string, ids = true): string[] | null {
  const raw = req.query[field];
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new BadQuery(`${field}_unrecognised`, `${field} must be a comma-separated list`);
  return raw
    .split(",")
    .map((s) => (ids ? s.trim().replace(/ /g, "+") : s.trim()))
    .filter(Boolean);
}

const qOf = (req: Request): string | undefined => (typeof req.query.q === "string" ? req.query.q : undefined);

/** `?runnable=true` keeps only what we run today (a customer surface); absent or `false` keeps everything. */
function runnableOf(req: Request): boolean {
  const raw = req.query.runnable;
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new BadQuery("runnable_unrecognised", "runnable must be true or false");
}

/** A step named by key or label ("LinkedIn post", "linkedin_post", "Positive reply"). */
function resolveStep(model: CatalogueModel, raw: string): string | null {
  const key = matchChannelStepKey(raw);
  if (key && model.steps.has(key)) return key;
  const lower = raw.trim().toLowerCase();
  for (const s of model.steps.values()) if (s.label.toLowerCase() === lower || s.key === lower) return s.key;
  return null;
}

// ── Wire helpers ──────────────────────────────────────────────────────────────────────────────────

/**
 * `costPer` = the unit of `costUsd` in words, ON THE ROW ("per positive reply", "per paying client"), null
 * when there is no cost. A list's `costUnit` alone let an agent quote a channel's cost per positive reply
 * as "per paying client" (prod 2026-10-10): every figure carries its own unit.
 */
const econWire = (e: Economics, per: string | null) => ({ costUsd: e.costUsd, costPer: e.costUsd === null ? null : per, roi: e.roi, roiBasis: roiBasisOf(e), status: e.status });
const econDetail = (e: Economics, per: string | null) => ({ ...econWire(e, per), learningReason: e.reason, estimates: e.estimates });

const PER_PAYING_CLIENT = "per paying client";

/**
 * A funnel's EXPECTED figure (owner 2026-10-11 "A ROI and a % Conversion are never blank"; `lib/agent-catalogue.ts`
 * header): the row carries the headline, the detail adds each leg's rate and cost with what it rests on.
 */
const expectedRowOf = (e: CatalogueFunnel["expected"]) => ({
  status: "expected" as const,
  costUsd: e.costUsd,
  costPer: e.costUsd === null ? null : PER_PAYING_CLIENT,
  roi: e.roi,
  basis: e.basis,
  unavailableReason: e.unavailableReason,
});
const expectedDetailOf = (e: CatalogueFunnel["expected"]) => ({ ...expectedRowOf(e), lifetimeRevenueUsd: e.lifetimeRevenueUsd, lifetimeRevenueBasis: e.lifetimeRevenueBasis, legs: e.legs });
/** "per positive reply": the outcome a per-outcome cost is counted in (the step's label, lower case). */
const perStep = (m: CatalogueModel, stepKey: string): string =>
  stepKey === "paid_client" ? PER_PAYING_CLIENT : `per ${stepLabel(m, stepKey).toLowerCase()}`;
/** A channel's cost is its best pipe's: per that pipe's outcome. */
const perChannel = (m: CatalogueModel, bestPipeId: string | null): string | null => {
  const p = bestPipeId ? m.pipes.get(bestPipeId) : undefined;
  return p ? perStep(m, p.toStep) : null;
};

function page<T>(rows: T[], limit: number) {
  return { total: rows.length, truncated: rows.length > limit, rows: rows.slice(0, limit) };
}

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof OfferStepsUnreadableError) return void res.status(502).json({ error: err.message, reason: "offer_steps_unreadable" });
  if (err instanceof OfferStepsOfferNotFoundError) return void res.status(404).json({ error: err.message, reason: "offer_not_found" });
  if (err instanceof PipeStatsUnreadableError) return void res.status(502).json({ error: err.message, reason: "pipe_stats_unreadable" });
  if (err instanceof BadQuery) return void res.status(400).json({ error: err.message, reason: err.reason });
  if (err instanceof IncludeInlineQueryError) return void res.status(400).json({ error: err.message, reason: err.reason });
  if (err instanceof DeclarationError) return void res.status(err.status).json({ error: err.message, reason: err.reason });
  if (err instanceof StoreNotComputedError) return void res.status(503).json({ error: err.message, reason: "catalogue_economics_not_computed_yet" });
  if (err instanceof SalesPathNamePoolExhaustedError) return void res.status(502).json({ error: err.message, reason: "name_family_exhausted" });
  // drizzle-orm >= 0.44 wraps the driver error in DrizzleQueryError: read the postgres error.
  const pg = pgErrorOf(err);
  if (pg.code === "23505") return void res.status(409).json({ error: String(pg.message ?? (err as Error).message), reason: "already_exists" });
  console.error(`[features-service] agent catalogue: ${what} failed:`, err);
  res.status(500).json({ error: "Internal server error" });
}

/** Name the given keys (assigning the unnamed ones), returning key -> name. */
async function named(keys: string[], known: Map<string, string>): Promise<Map<string, string>> {
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length === 0) return known;
  const fresh = await salesPathNamesFor(missing);
  return new Map([...known, ...fresh]);
}

const pathRowOf = (m: CatalogueModel, p: CataloguePath, name: string) => {
  const e = pathEconomics(m, p);
  return { id: p.id, name, icon: FAMILY_GLYPHS.sales_path, color: glyphColorOf(name), line: pathLine(m, p), type: p.type, trigger: pathTrigger(m, p), ...econWire(e, PER_PAYING_CLIENT), runnable: pathRunnable(m, p) };
};

const pipeRowOf = (m: CatalogueModel, p: CataloguePipe, name: string) => ({
  ...pipeIdentityOf(p.channelSlug, p.legKey, name),
  line: pipeLine(m, p),
  mode: p.mode,
  ...econWire(p.economics, perStep(m, p.toStep)),
  runnable: pipeRunnable(p),
  ...(p.published ? {} : { draft: true }),
});

/** A reactive funnel's trigger in customer words (`lib/funnel-descriptions.ts`); null on a proactive one. */
const funnelCopy = (model: CatalogueModel, f: CatalogueFunnel) => ({
  // A trigger-headed funnel reads its head trigger's name (owner 2026-10-15); every other one, its first pipe's.
  triggerLabel: f.headTriggerId ? (model.triggers.get(f.headTriggerId)?.name ?? null) : funnelTriggerLabel(f, (k) => stepLabel(model, k), (id) => model.triggers.get(id)?.name ?? null),
  trigger: funnelTrigger(model, f),
});

const funnelRowOf = (f: CatalogueFunnel, name: string, copy: ReturnType<typeof funnelCopy>) => ({
  id: f.id,
  name,
  face: faceOf(name).svgPath,
  line: funnelLine(f),
  ...copy,
  type: funnelTypeOf(f),
  ...econWire(f.economics, PER_PAYING_CLIENT),
  expected: expectedRowOf(f.expected),
  runnable: funnelRunnable(f),
  mixed: funnelMixed(f),
  ...(funnelPublished(f) ? {} : { draft: true }),
});

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────

/** A step's place on the ONE lifecycle ladder (`lib/lifecycle-ladder.ts`): rung key (or `none`) and its rank. */
const lifecycleWire = (s: CatalogueStep) => ({ lifecycleRung: s.lifecycleRung, lifecycleRank: lifecycleRankOf(s.lifecycleRung), subjectKind: s.subjectKind, leadState: s.leadState, leadStateFamily: leadStateFamilyOf(s.leadState), leadStateRank: leadStateRankOf(s.leadState) });

router.get("/internal/catalogue/steps", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const { model } = await loadModel();
    const rows = [...model.steps.values()]
      .filter((s) => matchesQuery(q, [s.label, s.key, s.shortDescription, s.description, s.producedBy]))
      .map((s) => ({ s, e: stepEconomics(model, s.key) }))
      .sort((a, b) => (b.s.valueUsd ?? -1) - (a.s.valueUsd ?? -1) || a.s.key.localeCompare(b.s.key))
      .map(({ s, e }) => ({ id: s.key, name: s.label, pluralName: pluralLabelOf(s.label), icon: s.icon, line: s.shortDescription, valueUsd: s.valueUsd, ...econWire(e, perStep(model, s.key)), ...lifecycleWire(s), ...(s.declared ? { declared: true } : {}) }));
    res.json({ object: "step", costUnit: "per_outcome", order: "value_desc", lifecycleLadder: servedLifecycleLadder(), ...page(rows, limit) });
  } catch (err) {
    fail(res, err, "list steps");
  }
});

router.get("/internal/catalogue/steps/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model } = await loadModel();
    const key = resolveStep(model, req.params.id);
    const s = key ? model.steps.get(key) : undefined;
    if (!s) return void res.status(404).json({ error: `no step ${req.params.id}`, reason: "step_not_found" });
    const producing = [...model.pipes.values()].filter((p) => p.toStep === s.key);
    const paths = [...model.paths.values()].filter((p) => p.steps.includes(s.key));
    res.json({
      object: "step",
      id: s.key,
      name: s.label,
      pluralName: pluralLabelOf(s.label),
      icon: s.icon,
      description: s.description,
      line: s.shortDescription,
      declared: s.declared,
      producedBy: s.producedBy,
      ...lifecycleWire(s),
      valueUsd: s.valueUsd,
      valueVia: s.valueVia ? { toStep: s.valueVia.toStep, toStepName: stepLabel(model, s.valueVia.toStep), ratePct: s.valueVia.ratePct } : null,
      valueBasis: "fleet median lifetime revenue x the best rated route to Paid client",
      lifetimeRevenueUsd: model.lifetimeRevenueUsd,
      ...econDetail(stepEconomics(model, s.key), perStep(model, s.key)),
      costUnit: "per_outcome",
      producingPipeIds: producing.map((p) => p.id),
      salesPathCount: paths.length,
    });
  } catch (err) {
    fail(res, err, "get step");
  }
});

// ── Sales paths ───────────────────────────────────────────────────────────────────────────────────

router.get("/internal/catalogue/sales-paths", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const containsRaw = listOf(req, "containsSteps", false);
    const runnable = runnableOf(req);
    const offer = await offerContextOf(req);
    const { model, names } = await loadModel(offer);
    let contains: string[] | null = null;
    if (containsRaw) {
      contains = containsRaw.map((raw) => {
        const key = resolveStep(model, raw);
        if (!key) throw new BadQuery("step_not_found", `no step ${raw}`);
        return key;
      });
    }
    const matching = [...model.paths.values()]
      .filter((p) => !contains || p.steps.some((s) => contains!.includes(s)))
      .filter((p) => !runnable || pathRunnable(model, p))
      .filter((p) => matchesQuery(q, [pathLine(model, p), names.get(salesPathNameKeyOf(p.id)), p.id]))
      .map((p) => ({ p, e: pathEconomics(model, p) }))
      .sort(byRoi((x) => x.e, (x) => x.p.id, (x) => x.p.type));
    // Per offer (owner 2026-10-12): a path through a step the offer's business does not have is SET ASIDE.
    const { kept: candidates, setAside } = offer ? splitByOfferSteps(matching, (x) => x.p.steps, offer.steps) : { kept: matching, setAside: [] };
    const shown = candidates.slice(0, limit);
    const shownAside = setAside.slice(0, limit);
    const n = await named([...shown, ...shownAside.map((x) => x.item)].map((x) => salesPathNameKeyOf(x.p.id)), names);
    const rows = shown.map((x) => pathRowOf(model, x.p, n.get(salesPathNameKeyOf(x.p.id))!));
    res.json({
      object: "sales_path",
      costUnit: "per_paying_client",
      order: "roi_desc",
      total: candidates.length,
      truncated: candidates.length > limit,
      rows,
      ...(offer
        ? {
            offer: offerEcho(offer),
            offerSteps: offerStepsEcho(offer, model),
            setAside: {
              total: setAside.length,
              truncated: setAside.length > limit,
              rows: shownAside.map((x) => ({ id: x.item.p.id, name: n.get(salesPathNameKeyOf(x.item.p.id))!, line: pathLine(model, x.item.p), missingSteps: missingStepsWire(model, x.missingSteps) })),
            },
            setAsideByStep: setAsideByStepWire(model, setAside),
          }
        : {}),
    });
  } catch (err) {
    fail(res, err, "list sales paths");
  }
});

router.get("/internal/catalogue/sales-paths/:id", apiKeyOnly, async (req, res) => {
  try {
    const offer = await offerContextOf(req);
    const { model, names } = await loadModel(offer);
    const path = pathById(model, req.params.id);
    if (!path) return void res.status(404).json({ error: `no sales path ${req.params.id}`, reason: "sales_path_not_found" });
    const n = await named([salesPathNameKeyOf(path.id)], names);
    const name = n.get(salesPathNameKeyOf(path.id))!;
    const e = pathEconomics(model, path);
    const funnels = funnelsOfPath(model, path);
    res.json({
      object: "sales_path",
      id: path.id,
      name,
      icon: FAMILY_GLYPHS.sales_path,
      color: glyphColorOf(name),
      line: pathLine(model, path),
      type: path.type,
      trigger: pathTrigger(model, path),
      steps: path.steps.map((s) => ({ id: s, name: stepLabel(model, s) })),
      legs: path.legKeys.map((legKey, i) => ({
        legKey,
        ...legStepsOf(model, legKey),
        ratePct: path.rates[i].ratePct,
        rateSource: path.rates[i].source,
        // Only a measured fleet conversion is measured; a stated median, a default or a declared rate is an estimate.
        rateMeasured: isMeasuredRate(path.rates[i].source),
        pipeIds: pipesOnLeg(model, legKey).map((p) => p.id),
        // Every leg a channel (owner 2026-10-11): the channels performing it, never empty.
        channels: pipesOnLeg(model, legKey).map((p) => ({ ...legChannelOf(p), runnable: pipeRunnable(p) })),
      })),
      ...econDetail(e, PER_PAYING_CLIENT),
      costUnit: "per_paying_client",
      bestSalesFunnelId: e.bestFunnelId,
      runnable: pathRunnable(model, path),
      salesFunnelCount: funnels.length,
      lifetimeRevenueUsd: model.lifetimeRevenueUsd,
      ...(offer ? offerFitOf(model, offer, path.steps) : {}),
    });
  } catch (err) {
    fail(res, err, "get sales path");
  }
});

// ── Channels ──────────────────────────────────────────────────────────────────────────────────────

router.get("/internal/catalogue/channels", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const forPaths = listOf(req, "forPaths");
    const legKeys = listOf(req, "legKeys");
    const runnable = runnableOf(req);
    const { model } = await loadModel();
    let legs: Set<string> | null = null;
    if (forPaths) {
      legs = new Set();
      for (const id of forPaths) {
        const p = pathById(model, id);
        if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
        p.legKeys.forEach((l) => legs!.add(l));
      }
    }
    if (legKeys) legs = legs ? new Set(legKeys.filter((l) => legs!.has(l))) : new Set(legKeys);
    const rows = model.channels
      .filter((c) => !legs || [...model.pipes.values()].some((p) => p.channelSlug === c.slug && legs!.has(p.legKey)))
      .filter((c) => !runnable || channelRunnable(model, c.slug))
      .filter((c) => matchesQuery(q, [c.name, c.slug, c.shortDescription, c.description, c.channelType]))
      .map((c) => ({ c, e: channelEconomics(model, c.slug, legs) }))
      .sort(byRoi((x) => x.e, (x) => x.c.slug))
      .map(({ c, e }) => ({ id: c.slug, name: c.name, icon: phosphorIconOf(c.icon), line: c.shortDescription, ...econWire(e, perChannel(model, e.bestPipeId)), runnable: channelRunnable(model, c.slug) }));
    res.json({ object: "channel", costUnit: "per_outcome", order: "roi_desc", ...page(rows, limit) });
  } catch (err) {
    fail(res, err, "list channels");
  }
});

router.get("/internal/catalogue/channels/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model, names } = await loadModel();
    const c = model.channels.find((x) => x.slug === req.params.id);
    if (!c) return void res.status(404).json({ error: `no channel ${req.params.id}`, reason: "channel_not_found" });
    const pipes = [...model.pipes.values()].filter((p) => p.channelSlug === c.slug);
    const n = await named(pipes.map(nameKeyOfPipe), names);
    const e = channelEconomics(model, c.slug);
    res.json({
      object: "channel",
      id: c.slug,
      name: c.name,
      icon: phosphorIconOf(c.icon),
      line: c.shortDescription,
      description: c.description,
      channelType: c.channelType,
      operatedBy: c.operatedBy,
      performedBy: c.performedBy,
      managed: c.managed,
      runnable: channelRunnable(model, c.slug),
      ...econDetail(e, perChannel(model, e.bestPipeId)),
      costUnit: "per_outcome",
      bestPipeId: e.bestPipeId,
      pipes: pipes.map((p) => pipeRowOf(model, p, n.get(nameKeyOfPipe(p))!)),
    });
  } catch (err) {
    fail(res, err, "get channel");
  }
});

// ── Pipes ─────────────────────────────────────────────────────────────────────────────────────────

router.get("/internal/catalogue/pipes", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const paths = listOf(req, "paths");
    const channels = listOf(req, "channels");
    const legKeys = listOf(req, "legKeys");
    const runnable = runnableOf(req);
    const { model, names } = await loadModel();
    let legs: Set<string> | null = legKeys ? new Set(legKeys) : null;
    if (paths) {
      const onPaths = new Set<string>();
      for (const id of paths) {
        const p = pathById(model, id);
        if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
        p.legKeys.forEach((l) => onPaths.add(l));
      }
      legs = legs ? new Set([...legs].filter((l) => onPaths.has(l))) : onPaths;
    }
    const candidates = [...model.pipes.values()]
      .filter((p) => !legs || legs.has(p.legKey))
      .filter((p) => !channels || channels.includes(p.channelSlug))
      .filter((p) => !runnable || pipeRunnable(p))
      .filter((p) => matchesQuery(q, [pipeLine(model, p), names.get(nameKeyOfPipe(p)), p.id]))
      .sort(byRoi((p) => p.economics, (p) => p.id));
    const shown = candidates.slice(0, limit);
    const n = await named(shown.map(nameKeyOfPipe), names);
    res.json({
      object: "pipe",
      costUnit: "per_outcome",
      order: "roi_desc",
      total: candidates.length,
      truncated: candidates.length > limit,
      rows: shown.map((p) => pipeRowOf(model, p, n.get(nameKeyOfPipe(p))!)),
    });
  } catch (err) {
    fail(res, err, "list pipes");
  }
});

function pipeDetail(model: CatalogueModel, p: CataloguePipe, name: string) {
  const to = model.steps.get(p.toStep);
  return {
    object: "pipe",
    id: p.id,
    name,
    icon: FAMILY_GLYPHS.pipe,
    color: glyphColorOf(name),
    line: pipeLine(model, p),
    channelSlug: p.channelSlug,
    channelName: p.channelName,
    legKey: p.legKey,
    fromStep: p.fromStep,
    toStep: p.toStep,
    mode: p.mode,
    triggerId: p.triggerId,
    operatedBy: p.operatedBy,
    managed: p.managed,
    runnable: pipeRunnable(p),
    notRunnableReason: notRunnableOf(p)?.reason ?? null,
    notRunnableDetail: notRunnableOf(p)?.detail ?? null,
    draft: !p.published,
    ...econDetail(p.economics, perStep(model, p.toStep)),
    costUnit: "per_outcome",
    toStepValueUsd: to?.valueUsd ?? null,
    bestWorkflowSlug: p.measurement?.workflowDynastySlug ?? null,
    measuredBasis: p.measurement?.basis ?? null,
    conversionRatePct: p.measurement?.conversionRatePct ?? null,
    play: playOf(p),
    // ROI PER PLAY (owner 2026-10-13): every play of the pipe with its own figure, default first.
    plays: playsOfPipe(model, model.pipes.get(p.play?.basePipeId ?? p.id) ?? p).map((x) => playRowOf(model, x)),
  };
}

/** The play a pipe object is (`lib/plays.ts`); null on a pipe cataloguing no play. */
const playOf = (p: CataloguePipe) =>
  p.play
    ? {
        pipeId: p.play.basePipeId,
        strategyId: p.play.strategyId,
        strategyName: p.play.strategyName,
        strategyDescription: p.play.strategyDescription,
        default: p.play.isDefault,
        allowedActiveWorkflowCount: p.play.allowedActiveWorkflowCount,
        excludedWorkflowDynastySlugs: p.play.excludedDynasties,
      }
    : null;

/**
 * Why a pipe object is not runnable, for an agent to act on (owner 2026-10-14): a play blocked on its strategy says
 * whether Jev is still judging, failing to judge, or judged every workflow out (`lib/plays.ts` `playBlockOf`).
 */
function notRunnableOf(p: CataloguePipe): { reason: string; detail: string } | null {
  if (pipeRunnable(p)) return null;
  if (!p.published) return { reason: "unpublished", detail: "Staff hid this pipe: nothing runs it." };
  if (p.play?.block) return p.play.block;
  return { reason: "no_workflow", detail: "No active workflow of ours works this pipe yet, so a campaign on it cannot be launched." };
}

/** One play of a pipe as listed: its id (what a sales funnel names), its strategy, its own figures. */
const playRowOf = (m: CatalogueModel, p: CataloguePipe) => ({
  object: "play" as const,
  id: p.id,
  pipeId: p.play?.basePipeId ?? p.id,
  strategyId: p.play?.strategyId ?? null,
  strategyName: p.play?.strategyName ?? null,
  strategyDescription: p.play?.strategyDescription ?? null,
  default: p.play?.isDefault ?? true,
  ...econWire(p.economics, perStep(m, p.toStep)),
  bestWorkflowSlug: p.measurement?.workflowDynastySlug ?? null,
  measuredBasis: p.measurement?.basis ?? null,
  allowedActiveWorkflowCount: p.play?.allowedActiveWorkflowCount ?? null,
  // WHICH active workflows the play may run (owner ask 2026-10-14: an agent learned it only after launching). Null on a
  // pipe cataloguing no play (every assigned workflow).
  allowedWorkflowDynastySlugs: p.play ? [...p.play.allowedActiveDynasties] : null,
  runnable: pipeRunnable(p),
  notRunnableReason: notRunnableOf(p)?.reason ?? null,
  notRunnableDetail: notRunnableOf(p)?.detail ?? null,
});

/**
 * `?stats=true` (owner 2026-10-12, the staff Pipe page): the pipe's own volumes, net spend, cost per outcome, ROI since
 * inception and their daily history (`lib/pipe-stats.ts`), fleet-wide, or narrowed to `brandId` / `offerId` (an offer
 * of that brand). Null scope params = the fleet. An offer without its brand is refused (400 `brand_required`).
 */
class PipeStatsUnreadableError extends Error {}

/** A producer the stats read needs failed: 502 `pipe_stats_unreadable`, named, never a bare 500. */
async function readPipeStats(...args: Parameters<typeof getPipeStats>) {
  try {
    return await getPipeStats(...args);
  } catch (err) {
    console.error(`[features-service] agent catalogue: pipe stats of ${args[0]} unreadable:`, err);
    throw new PipeStatsUnreadableError((err as Error).message);
  }
}

function pipeStatsScopeOf(req: Request): PipeStatsScope | null {
  if (req.query.stats !== "true") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const brandId = str(req.query.brandId);
  const offerId = str(req.query.offerId);
  if (offerId && !brandId) throw new BadQuery("brand_required", "an offer-scoped pipe stats read also names its brandId");
  return { kind: offerId ? "offer" : brandId ? "brand" : "fleet", brandId, offerId };
}

/** A customer-team pipe's PLATFORM neighbours: those bringing people to its `from` step, and those on its own leg. */
function legNeighboursOf(model: Awaited<ReturnType<typeof loadModel>>["model"], p: CataloguePipe): PipeStatsPipe["legNeighbours"] {
  if (p.operatedBy !== "customer" || p.fromStep === null) return undefined;
  const platform = [...model.pipes.values()].filter((q) => q.operatedBy === "platform");
  const ref = (q: CataloguePipe) => ({ channelSlug: q.channelSlug, computedLegKey: q.computedLegKey });
  return {
    producingPipes: platform.filter((q) => q.toStep === p.fromStep).map(ref),
    ourPipesOnLeg: platform.filter((q) => q.fromStep === p.fromStep && q.toStep === p.toStep).map(ref),
  };
}

/** A PLATFORM pipe whose leg also has a customer-team pipe: those team channels and the leg's platform neighbours. */
function teamCoLegOf(model: Awaited<ReturnType<typeof loadModel>>["model"], p: CataloguePipe): PipeStatsPipe["teamCoLeg"] {
  if (p.operatedBy !== "platform") return undefined;
  const all = [...model.pipes.values()];
  const team = all.filter((q) => q.operatedBy === "customer" && q.fromStep === p.fromStep && q.toStep === p.toStep);
  if (team.length === 0) return undefined;
  const platform = all.filter((q) => q.operatedBy === "platform");
  const ref = (q: CataloguePipe) => ({ channelSlug: q.channelSlug, computedLegKey: q.computedLegKey });
  return {
    teamChannelSlugs: [...new Set(team.map((q) => q.channelSlug))],
    producingPipes: p.fromStep === null ? [] : platform.filter((q) => q.toStep === p.fromStep).map(ref),
    ourPipesOnLeg: platform.filter((q) => q.fromStep === p.fromStep && q.toStep === p.toStep).map(ref),
  };
}

router.get("/internal/catalogue/pipes/:id", apiKeyOnly, async (req, res) => {
  try {
    const scope = pipeStatsScopeOf(req);
    const { model, names } = await loadModel();
    // A PLAY id (`<pipe id>~<strategy id>`) answers like its pipe, as that play (campaign-service reads a funnel's
    // legs through here).
    const p = pipeOrPlayById(model, req.params.id);
    if (!p) return void res.status(404).json({ error: `no pipe ${req.params.id}`, reason: "pipe_not_found" });
    const n = await named([nameKeyOfPipe(p)], names);
    const detail = pipeDetail(model, p, n.get(nameKeyOfPipe(p))!);
    if (!scope) return void res.json(detail);
    const stats = await readPipeStats(
      p.id,
      {
        channelSlug: p.channelSlug,
        computedLegKey: p.computedLegKey,
        fromStep: p.fromStep,
        toStep: p.toStep,
        fromStepLabel: p.fromStep ? stepLabel(model, p.fromStep) : null,
        toStepLabel: stepLabel(model, p.toStep),
        triggerId: p.triggerId,
        operatedBy: p.operatedBy,
        legNeighbours: legNeighboursOf(model, p),
        teamCoLeg: teamCoLegOf(model, p),
      },
      scope,
      valueAddedTo((st) => model.steps.get(st)?.valueUsd ?? null, p.fromStep, p.toStep),
    );
    res.json({ ...detail, stats });
  } catch (err) {
    fail(res, err, "get pipe");
  }
});

// ── Sales funnels ─────────────────────────────────────────────────────────────────────────────────

/**
 * One page of sales funnels. `forceRunnable` = the PUBLIC read (owner 2026-10-10, the signup's
 * "Your campaign" step): only what we can run today, and runnable implies published, so a draft or
 * a mixed funnel never reaches a signed-out visitor whatever the query says.
 */
async function listSalesFunnels(req: Request, res: Response, forceRunnable: boolean): Promise<void> {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const paths = listOf(req, "paths");
    const containsChannels = listOf(req, "containsChannels");
    const runnable = forceRunnable || runnableOf(req);
    // Per-offer pricing only on the service-key read (it needs the offer's org).
    const offer = forceRunnable ? null : await offerContextOf(req);
    const { model, names } = await loadModel(offer);
    const onPaths: CataloguePath[] = paths
      ? paths.map((id) => {
          const p = pathById(model, id);
          if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
          return p;
        })
      : [...model.paths.values()];
    const matching = onPaths
      .flatMap((p) => funnelsOfPath(model, p))
      .filter((f) => !containsChannels || f.channelSlugs.some((s) => containsChannels.includes(s)))
      .filter((f) => !runnable || funnelRunnable(f))
      .filter((f) => matchesQuery(q, [funnelLine(f), names.get(f.id), f.id]))
      .sort(byRoi((f: CatalogueFunnel) => f.economics, (f) => f.id, (f) => funnelTypeOf(f)));
    // Per offer (owner 2026-10-12): a funnel through a step the offer's business does not have is SET ASIDE, never proposed.
    const { kept: candidates, setAside } = offer
      ? splitByOfferSteps(matching, (f) => model.paths.get(f.pathId)!.steps, offer.steps)
      : { kept: matching, setAside: [] };
    const shown = candidates.slice(0, limit);
    const shownAside = setAside.slice(0, limit);
    const n = await named([...shown.map((f) => f.id), ...shownAside.map((x) => x.item.id)], names);
    res.json({
      object: "sales_funnel",
      costUnit: "per_paying_client",
      order: "roi_desc",
      total: candidates.length,
      truncated: candidates.length > limit,
      rows: shown.map((f) => funnelRowOf(f, n.get(f.id)!, funnelCopy(model, f))),
      ...(offer
        ? {
            offer: offerEcho(offer),
            offerSteps: offerStepsEcho(offer, model),
            setAside: {
              total: setAside.length,
              truncated: setAside.length > limit,
              rows: shownAside.map((x) => ({ id: x.item.id, name: n.get(x.item.id)!, line: funnelLine(x.item), missingSteps: missingStepsWire(model, x.missingSteps) })),
            },
            setAsideByStep: setAsideByStepWire(model, setAside),
          }
        : {}),
    });
  } catch (err) {
    fail(res, err, "list sales funnels");
  }
}

router.get("/internal/catalogue/sales-funnels", apiKeyOnly, (req, res) => listSalesFunnels(req, res, false));

/** Public: the runnable sales funnels only (same rows, same filters, `runnable` forced on). */
router.get("/public/catalogue/sales-funnels", (req, res) => listSalesFunnels(req, res, true));

async function funnelDetail(model: CatalogueModel, f: CatalogueFunnel, names: Map<string, string>, offer: OfferContext | null = null) {
  const copy = funnelCopy(model, f);
  const name = names.get(f.id)!;
  const path = model.paths.get(f.pathId)!;
  const needed = outcomesNeededPerPayingClient(path);
  return {
    object: "sales_funnel",
    id: f.id,
    name,
    face: faceOf(name),
    line: funnelLine(f),
    ...copy,
    type: funnelTypeOf(f),
    salesPathId: path.id,
    salesPathName: names.get(salesPathNameKeyOf(path.id)) ?? null,
    legs: f.legs.map((l, i) => ({
      legKey: l.legKey,
      ...legStepsOf(model, l.legKey),
      // Every leg ONE channel (owner 2026-10-11), the sourcing leg included.
      channels: legPipes(l).map(legChannelOf),
      pipes: legPipes(l).map((p) => ({ id: p.id, name: names.get(nameKeyOfPipe(p)) ?? null, channelSlug: p.channelSlug, runnable: pipeRunnable(p) })),
      ratePct: path.rates[i].ratePct,
      rateSource: path.rates[i].source,
      rateMeasured: isMeasuredRate(path.rates[i].source),
      outcomesNeededPerPayingClient: needed[i],
      pipe: l.pipe
        ? { id: l.pipe.id, name: names.get(nameKeyOfPipe(l.pipe)) ?? null, line: pipeLine(model, l.pipe), mode: l.pipe.mode, ...econWire(l.pipe.economics, perStep(model, l.pipe.toStep)) }
        : null,
    })),
    ...econDetail(f.economics, PER_PAYING_CLIENT),
    expected: expectedDetailOf(f.expected),
    costUnit: "per_paying_client",
    lifetimeRevenueUsd: model.lifetimeRevenueUsd,
    lifetimeRevenueSource: offer ? offer.lifetimeRevenueSource : "fleet_median_stated",
    ...(offer ? offerFitOf(model, offer, path.steps) : {}),
    runnable: funnelRunnable(f),
  mixed: funnelMixed(f),
    draft: !funnelPublished(f),
  };
}

/** A per-offer detail: the offer, its stated steps, and whether this funnel/path is set aside for a step it lacks. */
function offerFitOf(model: CatalogueModel, offer: OfferContext, steps: readonly string[]) {
  const missing = missingStepsOf(steps, offer.steps);
  return { offer: offerEcho(offer), offerSteps: offerStepsEcho(offer, model), setAside: missing.length > 0, missingSteps: missingStepsWire(model, missing) };
}

const funnelPublished = (f: CatalogueFunnel): boolean => f.legs.every((l) => legPipes(l).some((p) => p.published));
const funnelPipes = (f: CatalogueFunnel): CataloguePipe[] => f.legs.flatMap(legPipes);

router.get("/internal/catalogue/sales-funnels/:id", apiKeyOnly, async (req, res) => {
  try {
    const offer = await offerContextOf(req);
    const { model, names } = await loadModel(offer);
    const f = funnelById(model, req.params.id);
    if (!f) return void res.status(404).json({ error: `no sales funnel ${req.params.id}`, reason: "sales_funnel_not_found" });
    const n = await named([f.id, salesPathNameKeyOf(f.pathId), ...funnelPipes(f).map(nameKeyOfPipe)], names);
    res.json(await funnelDetail(model, f, n, offer));
  } catch (err) {
    fail(res, err, "get sales funnel");
  }
});

// ── Workflows (on one pipe) ───────────────────────────────────────────────────────────────────────

async function workflowRows(model: CatalogueModel, pipe: CataloguePipe) {
  const ranking = await readLegWorkflowRanking(pipe.channelSlug, pipe.computedLegKey);
  if (!ranking) return null;
  // A play lists only the workflows its strategy allows (`lib/plays.ts`).
  const excluded = new Set(pipe.play?.excludedDynasties ?? []);
  // The value the pipe ADDS per outcome (`valueAddedTo`, `lib/value-added.ts`), every workflow on it alike.
  const value = valueAddedTo((st) => model.steps.get(st)?.valueUsd ?? null, pipe.fromStep, pipe.toStep);
  return ranking.rows.filter((r) => !excluded.has(r.workflowDynastySlug)).map((r) => {
    const name = r.workflowDynastyName ?? r.workflowDynastySlug;
    const mature = r.isMature === true && r.basis === "mature" && r.costPerOutcomeUsd !== null && r.costPerOutcomeUsd > 0;
    const e: Economics = mature
      ? {
          status: "measured",
          costUsd: Math.round(r.costPerOutcomeUsd! * 100) / 100,
          roi: value === null ? null : Math.round((value / r.costPerOutcomeUsd!) * 100) / 100,
          reason: null,
          estimates: value === null ? [] : [...STEP_VALUE_ESTIMATES],
        }
      : { status: "learning", costUsd: null, roi: null, reason: r.outcomes > 0 ? "not_mature_yet" : "no_outcome_yet", estimates: [] };
    return { r, name, e };
  });
}

/** A workflow's own mark; the family glyph only for a row with no dynasty slug (never happens on a listed row). */
const markOrGlyph = (mark: { icon: string; color: string } | undefined, name: string) =>
  mark ?? { icon: FAMILY_GLYPHS.workflow, color: glyphColorOf(name) };

router.get("/internal/catalogue/workflows", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const pipeId = typeof req.query.pipe === "string" ? req.query.pipe.replace(/ /g, "+") : null;
    if (!pipeId) throw new BadQuery("pipe_required", "pipe is required (a pipe id, `<channel slug>|<leg key>`)");
    const { model } = await loadModel();
    const pipe = pipeOrPlayById(model, pipeId);
    if (!pipe) return void res.status(404).json({ error: `no pipe ${pipeId}`, reason: "pipe_not_found" });
    const rows = pipe.operatedBy === "customer" ? [] : await workflowRows(model, pipe);
    if (rows === null) return void res.status(503).json({ error: `the workflow ranking of ${pipeId} is not computed yet`, reason: "workflow_ranking_not_computed_yet" });
    const matched = rows.filter((x) => matchesQuery(q, [x.name, x.r.workflowDynastySlug]));
    // Each workflow's OWN mark (MARKS-1022), the one the leg ranking and the Research pages serve for it.
    const marks = await marksFor("workflow", matched.map((x) => x.r.workflowDynastySlug));
    const listed = matched
      .map((x) => ({
        id: x.r.workflowDynastySlug,
        name: x.name,
        ...markOrGlyph(marks.get(x.r.workflowDynastySlug), x.name),
        line: `${x.r.outcomes} outcomes from ${x.r.contacted} people, ${x.r.assignment}${x.r.moneyGoesHere ? ", holds the money" : ""}`,
        ...econWire(x.e, perStep(model, pipe.toStep)),
      }));
    res.json({ object: "workflow", pipeId, costUnit: "per_outcome", order: "fleet_rank", ...page(listed, limit) });
  } catch (err) {
    fail(res, err, "list workflows");
  }
});

router.get("/internal/catalogue/workflows/:id", apiKeyOnly, async (req, res) => {
  try {
    const pipeId = typeof req.query.pipe === "string" ? req.query.pipe.replace(/ /g, "+") : null;
    if (!pipeId) throw new BadQuery("pipe_required", "pipe is required (the pipe the workflow runs on)");
    const [{ model }, plays] = await Promise.all([loadModel(), loadPlayCatalogue()]);
    const pipe = pipeOrPlayById(model, pipeId);
    if (!pipe) return void res.status(404).json({ error: `no pipe ${pipeId}`, reason: "pipe_not_found" });
    const rows = await workflowRows(model, pipe);
    if (rows === null) return void res.status(503).json({ error: `the workflow ranking of ${pipeId} is not computed yet`, reason: "workflow_ranking_not_computed_yet" });
    const x = rows.find((w) => w.r.workflowDynastySlug === req.params.id);
    if (!x) return void res.status(404).json({ error: `no workflow ${req.params.id} on ${pipeId}`, reason: "workflow_not_found" });
    const marks = await marksFor("workflow", [x.r.workflowDynastySlug]);
    res.json({
      object: "workflow",
      id: x.r.workflowDynastySlug,
      name: x.name,
      ...markOrGlyph(marks.get(x.r.workflowDynastySlug), x.name),
      pipeId,
      rank: x.r.rank,
      assignment: x.r.assignment,
      selectable: x.r.selectable,
      isMature: x.r.isMature,
      basis: x.r.basis,
      outcomes: x.r.outcomes,
      contacted: x.r.contacted,
      spentUsd: x.r.spentUsd,
      conversionRatePct: x.r.conversionRatePct,
      holdsTheMoney: x.r.moneyGoesHere,
      ...econDetail(x.e, perStep(model, pipe.toStep)),
      costUnit: "per_outcome",
      // Every tactic Jev judged on this workflow's CURRENT version (`lib/plays.ts`); absent = not judged yet.
      tactics: [...plays.tactics.values()].map((t) => ({ id: t.id, name: t.name, follows: plays.tacticsByDynasty.get(x.r.workflowDynastySlug)?.get(t.id) ?? null })),
    });
  } catch (err) {
    fail(res, err, "get workflow");
  }
});

// ── Triggers (what starts a reactive pipe) ────────────────────────────────────────────────────────

/**
 * TRIGGERS (owner 2026-10-11, the staff Triggers section): every trigger type a reactive pipe may name
 * (`lib/channel-triggers.ts` coded + the ones declared at run time, `channel_trigger_types`), in the
 * catalogue's display order, each with the reactive pipes that name it. No economics: a trigger costs
 * nothing, the pipes it starts carry the figures. `icon` is the family glyph (`lightning`), `eventIcon`
 * the trigger type's own picture.
 */
const triggerRowOf = (m: CatalogueModel, t: TriggerTypeRecord, pipeCount: number) => ({
  id: t.id,
  name: t.label,
  // Owner 2026-10-15 (`lib/outcome-vocabulary.ts`): an OUTCOME trigger reports `outcomeKey` and carries that outcome's
  // value; a CONDITION trigger is computed by us (no outcome of its own, no value). `callable` = a caller may fire it.
  type: triggerTypeOf(t),
  outcomeKey: triggerOutcomeKeyOf(t),
  callable: triggerCallable(t),
  // Null always with a reason (TRIGGER-CATALOGUE-GAPS-1016): a condition, an outcome the model lacks, or no rated route.
  ...triggerValueOf(t, (k) => m.steps.get(k)?.valueUsd),
  icon: FAMILY_GLYPHS.trigger,
  color: glyphColorOf(t.label),
  eventIcon: phosphorIconOf(t.icon),
  line: t.description,
  fromStep: t.fromStep,
  fromStepName: t.fromStep ? stepLabel(m, t.fromStep) : null,
  firedBy: t.firedBy,
  // Fireable today, read like the pipe guard reads it (`isTriggerCoded`): a declared `reported`/`delay`/`poll` trigger is
  // fired by campaign-service's generic door, never the stored `false` every declaration is written with (HOT-LEAD-PROPOSAL-1019).
  coded: isTriggerCoded(t),
  kind: t.kind,
  origin: t.origin,
  pipeCount,
});

const pipesOfTrigger = (m: CatalogueModel, id: string): CataloguePipe[] =>
  [...m.pipes.values()].filter((p) => p.mode === "reactive" && p.triggerId === id).sort(byRoi((p) => p.economics, (p) => p.id));

router.get("/internal/catalogue/triggers", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const includeInline = includeInlineOf(req.query.includeInline);
    const [{ model }, triggers] = await Promise.all([loadModel(), listTriggerCatalogue()]);
    const rows = triggers
      // Entry doors only (`isEntryDoor`): an inline trigger is our services asking each other, never offered.
      .filter((t) => includeInline || isEntryDoor(t))
      .filter((t) => matchesQuery(q, [t.label, t.id, t.description, t.firedBy, t.fromStep ? stepLabel(model, t.fromStep) : null]))
      .map((t) => triggerRowOf(model, t, pipesOfTrigger(model, t.id).length));
    res.json({ object: "trigger", order: "catalogue", ...page(rows, limit) });
  } catch (err) {
    fail(res, err, "list triggers");
  }
});

router.get("/internal/catalogue/triggers/:id", apiKeyOnly, async (req, res) => {
  try {
    const [{ model, names }, triggers] = await Promise.all([loadModel(), listTriggerCatalogue()]);
    // A merged id (`TRIGGER_ID_MERGES`) answers the one trigger of its fact.
    const t = triggers.find((x) => x.id === canonicalTriggerId(req.params.id));
    if (!t) return void res.status(404).json({ error: `no trigger ${req.params.id}`, reason: "trigger_not_found" });
    const pipes = pipesOfTrigger(model, t.id);
    const n = await named(pipes.map(nameKeyOfPipe), names);
    res.json({
      object: "trigger",
      ...triggerRowOf(model, t, pipes.length),
      params: t.params,
      pipes: pipes.map((p) => pipeRowOf(model, p, n.get(nameKeyOfPipe(p))!)),
    });
  } catch (err) {
    fail(res, err, "get trigger");
  }
});

// ── Creates ───────────────────────────────────────────────────────────────────────────────────────

const STEP_KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const ICON_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const bad = (reason: string, message: string) => new DeclarationError(400, reason, message);

function text(body: Body, field: string, max: number): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") throw bad(`${field}_required`, `${field} is required (a non-empty string)`);
  if (v.trim().length > max) throw bad(`${field}_too_long`, `${field} is longer than ${max} characters`);
  return v.trim();
}

function lifecycleRungOf(raw: unknown): StepLifecycleRung {
  if (!isStepLifecycleRung(raw)) throw bad("lifecycle_rung_invalid", `lifecycleRung must be one of ${LIFECYCLE_RUNG_VALUES.join(", ")}, got ${JSON.stringify(raw)}`);
  return raw;
}

function subjectKindOf(raw: unknown): OutcomeSubjectKind {
  if (!isOutcomeSubjectKind(raw)) throw bad("subject_kind_invalid", `subjectKind must be one of ${OUTCOME_SUBJECT_KINDS.join(", ")}, got ${JSON.stringify(raw)}`);
  return raw;
}

function ratePct(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100) throw bad(`${field}_invalid`, `${field} must be a percentage in (0, 100]`);
  return raw;
}

router.post("/internal/catalogue/steps", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    refuseCustomer(body, "a new outcome", "a new outcome is a feature request, built with the backend that fills it");
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const key = text(body, "key", 48);
    if (!STEP_KEY_RE.test(key)) throw bad("step_key_invalid", `key must be snake_case (a-z, 0-9, _), got ${JSON.stringify(key)}`);
    const { steps } = await registerStepDeclarations();
    if (Object.hasOwn(CHANNEL_STEPS, key) || steps.some((s) => s.key === key)) throw new DeclarationError(409, "step_exists", `a step ${key} already exists`);
    const label = text(body, "label", 60);
    const labels = new Set([...Object.values(CHANNEL_STEPS).map((s) => s.label.toLowerCase()), ...steps.map((s) => s.label.toLowerCase())]);
    if (labels.has(label.toLowerCase())) throw new DeclarationError(409, "step_label_taken", `a step is already labelled ${JSON.stringify(label)}`);
    const icon = text(body, "icon", 64);
    if (!ICON_RE.test(icon)) throw bad("icon_invalid", `icon must be a Phosphor icon name (kebab-case), got ${JSON.stringify(icon)}`);
    const towardRaw = text(body, "towardStep", 64);
    const towardStep = matchChannelStepKey(towardRaw) ?? steps.find((s) => s.key === towardRaw)?.key ?? null;
    if (!towardStep) throw new DeclarationError(404, "toward_step_not_found", `towardStep ${towardRaw} is no step`);
    const towardRatePct = ratePct(body.towardRatePct, "towardRatePct");
    const producedBy = body.producedBy === undefined || body.producedBy === null ? null : text(body, "producedBy", 200);
    const lifecycleRung = body.lifecycleRung === undefined || body.lifecycleRung === null ? null : lifecycleRungOf(body.lifecycleRung);
    // What one occurrence is about: the cost ledger's one per-outcome fact (COST-ACCOUNTING-1023), stated on every new outcome.
    if (body.subjectKind === undefined || body.subjectKind === null) throw bad("subjectKind_required", `subjectKind is required: ${OUTCOME_SUBJECT_KINDS.join(" or ")}`);
    const subjectKind = subjectKindOf(body.subjectKind);
    const created = await insertStep({
      key,
      label,
      description: text(body, "description", 500),
      shortDescription: text(body, "shortDescription", 80),
      icon,
      towardStep,
      towardRatePct,
      producedBy,
      lifecycleRung,
      subjectKind,
      createdBy,
      requestedByOrgId,
    });
    await registerStepDeclarations();
    invalidateChannelCatalogue();
    console.log(`[features-service] agent catalogue: step ${key} declared by ${createdBy} (toward ${towardStep} at ${towardRatePct}%)`);
    const { model } = await loadModel();
    const s = model.steps.get(created.key)!;
    res.status(201).json({ object: "step", id: s.key, name: s.label, icon: s.icon, line: s.shortDescription, valueUsd: s.valueUsd, declared: true, producedBy: s.producedBy, ...lifecycleWire(s) });
  } catch (err) {
    fail(res, err, "create step");
  }
});

/** States a DECLARED step's lifecycle rung and/or subject kind (a coded step's are code: `lib/lifecycle-ladder.ts`, `lib/outcome-subject.ts`). */
router.patch("/internal/catalogue/steps/:id", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    refuseCustomer(body, "a step", "a step's place on the lifecycle ladder is ours to state");
    const updatedBy = actorOf(body);
    const hasRung = body.lifecycleRung !== undefined && body.lifecycleRung !== null;
    const hasKind = body.subjectKind !== undefined && body.subjectKind !== null;
    if (!hasRung && !hasKind) throw bad("lifecycleRung_required", "lifecycleRung or subjectKind is required");
    const set = { ...(hasRung ? { lifecycleRung: lifecycleRungOf(body.lifecycleRung) } : {}), ...(hasKind ? { subjectKind: subjectKindOf(body.subjectKind) } : {}) };
    const key = req.params.id;
    if (codedStepLifecycleRungOf(key) !== null) throw new DeclarationError(409, "step_coded", `${key} is a coded step: its lifecycle rung and subject kind are set in code`);
    const updated = await updateDeclaredStep(key, set);
    if (!updated) throw new DeclarationError(404, "step_not_found", `no declared step ${key}`);
    await registerStepDeclarations();
    invalidateChannelCatalogue();
    console.log(`[features-service] agent catalogue: step ${key} set ${JSON.stringify(set)} by ${updatedBy}`);
    const { model } = await loadModel();
    const s = model.steps.get(key)!;
    res.json({ object: "step", id: s.key, name: s.label, declared: true, ...lifecycleWire(s) });
  } catch (err) {
    fail(res, err, "update step");
  }
});

router.post("/internal/catalogue/pipes", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    refuseCustomer(body, "a new pipe", "a customer composes the pipes we run (GET /internal/catalogue/pipes?runnable=true); a new one is a feature request");
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    if (typeof body.channelSlug !== "string") throw bad("channel_slug_required", "channelSlug is required");
    await registerStepDeclarations();
    const [cat, triggers] = await Promise.all([loadChannelCatalogue({ publishedOnly: false }), listTriggerCatalogue()]);
    const channel = cat.channels.find((c) => c.slug === body.channelSlug);
    const declaredChannel = cat.declared.channels.find((c) => c.slug === body.channelSlug);
    if (!channel && !declaredChannel) return void res.status(404).json({ error: `no channel ${body.channelSlug}`, reason: "channel_not_found" });
    const slug = (channel?.slug ?? declaredChannel?.slug)!;
    const operatedBy = (channel?.operatedBy ?? declaredChannel?.operatedBy)!;
    const input = parseLegInput(body, { slug, managed: channel?.managed ?? false, operatedBy, legKeys: new Set((channel?.stepTransitions ?? []).map((t) => t.legKey)) }, triggers);
    // A leg out of a real step converts at a rate: the seeded default, else the caller states it.
    let statedRate: number | null = null;
    if (input.fromStep !== null && input.fromStep !== "lead_found" && legRateOf(input.fromStep, input.toStep).ratePct === null) {
      if (body.conversionRatePct === undefined) {
        throw bad("conversion_rate_required", `no rate is known for ${input.fromStep} -> ${input.toStep}: state conversionRatePct (the share of people at ${input.fromStep} who reach ${input.toStep})`);
      }
      statedRate = ratePct(body.conversionRatePct, "conversionRatePct");
    }
    await insertLeg(slug, input, createdBy, requestedByOrgId);
    if (statedRate !== null) await insertLegRate({ fromStep: input.fromStep!, toStep: input.toStep, ratePct: statedRate }, createdBy);
    invalidateChannelCatalogue();
    const after = await loadModel();
    const id = [...after.model.pipes.values()].find((p) => p.channelSlug === slug && p.computedLegKey === input.legKey)?.id;
    const pipe = id ? after.model.pipes.get(id) : undefined;
    if (!pipe) throw new Error(`pipe ${slug} ${input.legKey} was stored but is not in the catalogue`);
    const n = await named([nameKeyOfPipe(pipe)], after.names);
    console.log(`[features-service] agent catalogue: pipe ${pipe.id} declared by ${createdBy}, named ${n.get(nameKeyOfPipe(pipe))}`);
    res.status(201).json(pipeDetail(after.model, pipe, n.get(nameKeyOfPipe(pipe))!));
  } catch (err) {
    fail(res, err, "create pipe");
  }
});

/**
 * RETIRE A PIPE CREATED BY MISTAKE (MCP-PIPE-GAPS-1015): a DECLARED pipe no campaign uses and no declared sales funnel
 * names leaves every catalogue read (its row kept: who created it, who retired it, why). Refused, never forced: a pipe
 * stated in code (409 `pipe_coded`), a pipe any campaign of any org runs or ran (409 `pipe_in_use`, every status: a
 * stopped campaign can be restarted), a pipe a declared sales funnel names (409 `pipe_in_sales_funnel`). The campaign
 * read is FAIL-LOUD (502): an unreadable answer never retires. Declaring the same leg again revives it.
 */
router.post("/internal/catalogue/pipes/:id/retire", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const retiredBy = actorOf(body, "retiredBy");
    if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.trim().length > 500)) throw bad("note_invalid", "note must be a string of at most 500 characters");
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;
    const { model, names, cat } = await loadModel();
    const p = model.pipes.get(req.params.id);
    if (!p) return void res.status(404).json({ error: `no pipe ${req.params.id} (a play id is not a pipe: retire its pipe)`, reason: "pipe_not_found" });
    const stored = cat.declared.legs.find((l) => l.channelSlug === p.channelSlug && pipeLegKeyOf(l.channelSlug, l.legKey) === p.computedLegKey);
    if (!stored) throw new DeclarationError(409, "pipe_coded", `${p.id} is stated in code, not declared: it cannot be retired here`);
    const funnels = (await listDeclaredSalesPaths())
      .map((d) => servedCombinationKeyOf(d.combinationKey))
      .filter((key) =>
        key.split("+").some((part) => {
          const at = part.indexOf("@");
          if (at < 0) return false;
          const slug = part.slice(at + 1).split("~")[0];
          return slug === p.channelSlug && pipeLegKeyOf(slug, part.slice(0, at)) === p.computedLegKey;
        }),
      );
    if (funnels.length > 0) {
      throw new DeclarationError(409, "pipe_in_sales_funnel", `${p.id} is a leg of ${funnels.length} declared sales funnel(s) (${funnels.slice(0, 3).join(", ")}): it stays`);
    }
    let campaigns: Awaited<ReturnType<typeof fetchFleetLegCampaignsFor>>[number];
    try {
      [campaigns] = await fetchFleetLegCampaignsFor([[{ channelSlug: p.channelSlug, computedLegKey: p.computedLegKey }]]);
    } catch (err) {
      console.error(`[features-service] agent catalogue: retire ${p.id} refused, campaign read failed:`, err);
      return void res.status(502).json({ error: `could not read which campaigns use ${p.id}, so it is not retired`, reason: "campaigns_unreadable" });
    }
    if (campaigns.length > 0) {
      throw new DeclarationError(409, "pipe_in_use", `${p.id} is used by ${campaigns.length} campaign(s) (${campaigns.slice(0, 3).map((c) => c.campaignId).join(", ")}): a pipe a campaign uses is never retired`);
    }
    const done = await retireLeg(stored.channelSlug, stored.legKey, retiredBy, note);
    if (!done) throw new Error(`[features-service] declared leg ${stored.channelSlug} ${stored.legKey} vanished while being retired`);
    invalidateChannelCatalogue();
    const name = names.get(nameKeyOfPipe(p)) ?? null;
    console.log(`[features-service] agent catalogue: pipe ${p.id} (${name}) retired by ${retiredBy}${note ? `: ${note}` : ""}`);
    res.json({ object: "pipe", id: p.id, name, retired: true, retiredAt: done.retiredAt, retiredBy, note });
  } catch (err) {
    fail(res, err, "retire pipe");
  }
});

/**
 * The retire body a trigger or funnel retire takes: who (staff identity), why (at most 500 characters), and
 * `allowStoppedCampaigns` (default false): a STOPPED campaign blocks the retire like a running one (it can be restarted)
 * unless staff states it knows them (a test whose campaign already ran keeps its history in campaign-service, so it
 * cannot be deleted first). An ONGOING campaign always blocks.
 */
function retireBodyOf(body: Body): { retiredBy: string; note: string | null; allowStopped: boolean } {
  const retiredBy = actorOf(body, "retiredBy");
  if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.trim().length > 500)) throw bad("note_invalid", "note must be a string of at most 500 characters");
  if (body.allowStoppedCampaigns !== undefined && typeof body.allowStoppedCampaigns !== "boolean") throw bad("allow_stopped_campaigns_invalid", "allowStoppedCampaigns must be a boolean");
  return { retiredBy, note: typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null, allowStopped: body.allowStoppedCampaigns === true };
}

/** The campaigns that block a retire: every one, or (when staff allows stopped ones) every one not stopped. */
const blockingCampaigns = (cs: readonly FleetCampaignRef[], allowStopped: boolean): FleetCampaignRef[] =>
  allowStopped ? cs.filter((c) => c.status !== "stopped") : [...cs];

/** Every campaign row of every org, or null after answering 502 (an unreadable answer never retires). */
async function fleetCampaignRowsOr502(res: Response, what: string): Promise<unknown[] | null> {
  try {
    return await fetchFleetCampaignRows();
  } catch (err) {
    console.error(`[features-service] agent catalogue: retire ${what} refused, campaign read failed:`, err);
    res.status(502).json({ error: `could not read which campaigns use ${what}, so it is not retired`, reason: "campaigns_unreadable" });
    return null;
  }
}

const quoteCampaigns = (cs: readonly FleetCampaignRef[]): string => cs.slice(0, 3).map((c) => `${c.campaignId} (${c.status ?? "unknown status"})`).join(", ");

/**
 * RETIRE A SALES FUNNEL DECLARED BY MISTAKE (CATALOGUE-RETIRE-1016): a DECLARED funnel no campaign of any org runs or ran
 * (every status: a stopped campaign can be restarted) leaves every catalogue read; its row is kept (who declared it, who
 * retired it, why). A trigger-headed funnel then lists nowhere; a funnel the pipes compose on their own (no trigger head)
 * is still composable from its pipes and answers `stillComposable: true`. Refused, never forced: 404
 * `sales_funnel_not_declared`, 409 `sales_funnel_in_use` (a stopped campaign too, unless `allowStoppedCampaigns: true`;
 * a running one always), 502 `campaigns_unreadable`. Declaring it again revives it.
 */
router.post("/internal/catalogue/sales-funnels/:id/retire", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    refuseCustomer(body, "retiring a sales funnel", "a customer stops its own campaign; the catalogue is ours");
    const { retiredBy, note, allowStopped } = retireBodyOf(body);
    const key = storedCombinationKeyOf(req.params.id);
    const declared = (await listDeclaredSalesPaths()).find((d) => d.combinationKey === key);
    if (!declared) return void res.status(404).json({ error: `no declared sales funnel ${req.params.id} (only a declared funnel is retired here)`, reason: "sales_funnel_not_declared" });
    const served = servedCombinationKeyOf(key);
    const rows = await fleetCampaignRowsOr502(res, served);
    if (!rows) return;
    const all = campaignsRunningFunnel(rows, [...new Set([served, key, req.params.id])]);
    const using = blockingCampaigns(all, allowStopped);
    if (using.length > 0) {
      throw new DeclarationError(409, "sales_funnel_in_use", `${served} is run by ${using.length} campaign(s) (${quoteCampaigns(using)}): a sales funnel a campaign runs or ran is never retired; delete a stopped campaign that never ran first (campaign-service DELETE /sales-funnel-campaigns/{id}), or state allowStoppedCampaigns: true when only stopped campaigns remain`);
    }
    const { names } = await loadModel();
    const name = names.get(served) ?? null;
    const done = await retireSalesPath(key, retiredBy, note);
    if (!done) throw new Error(`[features-service] declared sales funnel ${key} vanished while being retired`);
    invalidateChannelCatalogue();
    const after = await loadModel();
    const stillComposable = funnelById(after.model, served) !== null;
    console.log(`[features-service] agent catalogue: sales funnel ${served} (${name}) retired by ${retiredBy}${note ? `: ${note}` : ""}${stillComposable ? " (still composable from its pipes)" : ""}`);
    res.json({ object: "sales_funnel", id: served, name, retired: true, retiredAt: done.retiredAt, retiredBy, note, stillComposable, stoppedCampaigns: all });
  } catch (err) {
    fail(res, err, "retire sales funnel");
  }
});

/**
 * RETIRE A TRIGGER DECLARED BY MISTAKE (CATALOGUE-RETIRE-1016): a DECLARED trigger nothing uses leaves every catalogue read
 * (trigger lists, the channel catalogue, every validation); its row is kept. Refused, never forced: 404
 * `trigger_not_found`; 409 `trigger_coded` (stated in code), `trigger_on_pipe` (a pipe answers it: retire the pipe first),
 * `trigger_heads_sales_funnel` (a declared sales funnel or path starts on it: retire that first), `trigger_in_use` (any
 * campaign of any org runs on it, every status); 502 `campaigns_unreadable`. Declaring the same id again revives it.
 */
router.post("/internal/catalogue/triggers/:id/retire", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    refuseCustomer(body, "retiring a trigger", "the trigger catalogue is ours");
    const { retiredBy, note, allowStopped } = retireBodyOf(body);
    const id = req.params.id;
    const t = (await listTriggerTypes()).find((x) => x.id === id);
    if (!t) return void res.status(404).json({ error: `no trigger ${id}`, reason: "trigger_not_found" });
    if (t.origin !== "declared") throw new DeclarationError(409, "trigger_coded", `${id} is stated in code, not declared: it cannot be retired here`);
    const { model, cat } = await loadModel();
    const pipes = [...model.pipes.values()].filter((p) => p.triggerId === id).map((p) => p.id);
    const legs = cat.declared.legs.filter((l) => l.triggerId === id).map((l) => `${l.channelSlug}|${l.legKey}`);
    const onPipes = [...new Set([...pipes, ...legs])];
    if (onPipes.length > 0) throw new DeclarationError(409, "trigger_on_pipe", `${id} is answered by ${onPipes.length} pipe(s) (${onPipes.slice(0, 3).join(", ")}): retire those first`);
    const head = `${TRIGGER_HEAD}${id}+`;
    const [funnels, chains] = await Promise.all([listDeclaredSalesPaths(), listDeclaredSalesPathChains()]);
    const headed = [...funnels.map((f) => servedCombinationKeyOf(f.combinationKey)), ...chains.map((c) => c.pathId)].filter((k) => k.startsWith(head));
    if (headed.length > 0) throw new DeclarationError(409, "trigger_heads_sales_funnel", `${id} heads ${headed.length} declared sales funnel(s) or path(s) (${headed.slice(0, 3).join(", ")}): retire those first`);
    const rows = await fleetCampaignRowsOr502(res, id);
    if (!rows) return;
    const all = campaignsOnTrigger(rows, id);
    const using = blockingCampaigns(all, allowStopped);
    if (using.length > 0) {
      throw new DeclarationError(409, "trigger_in_use", `${id} is run on by ${using.length} campaign(s) (${quoteCampaigns(using)}): a trigger a campaign runs or ran on is never retired (allowStoppedCampaigns: true lets stopped ones through, never a running one)`);
    }
    const done = await retireTrigger(id, retiredBy, note);
    if (!done) throw new Error(`[features-service] declared trigger ${id} vanished while being retired`);
    invalidateChannelCatalogue();
    console.log(`[features-service] agent catalogue: trigger ${id} (${t.label}) retired by ${retiredBy}${note ? `: ${note}` : ""}`);
    res.json({ object: "trigger", id, name: t.label, retired: true, retiredAt: done.retiredAt, retiredBy, note, stoppedCampaigns: all });
  } catch (err) {
    fail(res, err, "retire trigger");
  }
});

/**
 * FUNNEL-NAMES-1016 (owner 2026-10-16): every sales funnel still named with a word takes the name that says what it does
 * (`lib/funnel-names.ts`); old words are retired. Dry run unless `apply: true`; the body's `firstKeys` (the funnel ids
 * customers run, read from campaign-service by the caller) are named first. Answers every rename with the new name and
 * the funnel's short description. Idempotent: a second run renames nothing.
 */
router.post("/internal/catalogue/sales-funnels/descriptive-names", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    if (body.apply !== undefined && typeof body.apply !== "boolean") throw bad("apply_invalid", "apply must be a boolean");
    const firstKeys = body.firstKeys === undefined ? [] : body.firstKeys;
    if (!Array.isArray(firstKeys) || firstKeys.some((k) => typeof k !== "string")) throw bad("first_keys_invalid", "firstKeys must be a list of funnel ids");
    const { model, cat } = await loadModel();
    const triggers = new Map(
      cat.channels.flatMap((c) =>
        c.stepTransitions.flatMap((t) => (t.triggerId ? [[`${c.slug}|${servedPipeLegKey(c.slug, t.legKey)}`, t.triggerId] as const, [`${c.slug}|${t.legKey}`, t.triggerId] as const] : [])),
      ),
    );
    const triggerOf = (slug: string, legKey: string) => triggers.get(`${slug}|${legKey}`) ?? seedPipeTriggerOf(slug, legKey);
    const plan = await renameFunnelsToDescriptiveNames({ apply: body.apply === true, firstKeys: firstKeys as string[], triggerOf });
    const renames = plan.map((r) => {
      const f = funnelById(model, r.combinationKey);
      return { ...r, shortDescription: f ? funnelShortDescriptionOf(model, f).shortDescription : null };
    });
    res.json({ applied: body.apply === true, count: renames.length, renames });
  } catch (err) {
    fail(res, err, "rename sales funnels");
  }
});

router.post("/internal/catalogue/sales-paths", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const raw = body.legKeys;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((l) => typeof l !== "string")) throw bad("leg_keys_required", "legKeys is required: the legs in order, each a leg some pipe performs");
    const { model, names } = await loadModel();
    // A path HEADED by a trigger (owner 2026-10-15): the trigger + the legs from its step, proactive pipes included.
    const headTrigger = typeof body.triggerId === "string" && body.triggerId.trim() !== "" ? body.triggerId.trim() : null;
    if (headTrigger) {
      const refusal = triggerHeadRefusal(model, headTrigger, raw as string[]);
      if (refusal) throw triggerHeadError(refusal, headTrigger, raw as string[]);
    }
    const path = headTrigger ? triggerHeadedPath(model, headTrigger, raw as string[]) : pathById(model, pathIdOf(raw as string[]));
    if (!path) {
      throw bad("path_invalid", `${pathIdOf(raw as string[])} is not a sales path: the legs must chain from Start (a leg from nothing) to paid_client, or from a trigger step through a reactive pipe (a reactive path), each performed by a channel (GET /internal/catalogue/pipes)`);
    }
    // A CUSTOMER path (`runnableOnly`): every leg is worked by at least one pipe we run today, else nothing could run it.
    if (runnableOnlyOf(body)) {
      const idle = path.legKeys.find((k) => !pipesOnLeg(model, k).some(pipeRunnable));
      if (idle !== undefined) {
        throw bad("leg_not_runnable", `${idle}: no pipe we run today works this leg, so a customer sales path cannot use it (GET /internal/catalogue/pipes?runnable=true&legKeys=${idle}); ask for it with a feature request`);
      }
    }
    const { id, legKeys } = path;
    const declared = await listDeclaredSalesPathChains();
    const existed = declared.some((d) => d.pathId === id) || names.has(salesPathNameKeyOf(id));
    if (!declared.some((d) => d.pathId === id)) await insertSalesPathChain(id, legKeys, createdBy, requestedByOrgId);
    const n = await named([salesPathNameKeyOf(id)], names);
    console.log(`[features-service] agent catalogue: sales path ${id} ${existed ? "re-declared" : "declared"} by ${createdBy}, named ${n.get(salesPathNameKeyOf(id))}`);
    res.status(existed ? 200 : 201).json({ created: !existed, ...pathRowOf(model, path, n.get(salesPathNameKeyOf(id))!) });
  } catch (err) {
    fail(res, err, "create sales path");
  }
});

router.post("/internal/catalogue/sales-funnels", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const raw = body.pipeIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((l) => typeof l !== "string")) {
      throw bad("pipe_ids_required", "pipeIds is required: exactly one pipe id per leg of a sales path, in order (the sourcing leg included: one source, or Lead Sourcing)");
    }
    // EVERY LEG A CHANNEL (owner 2026-10-11): a leg is named by the pipe working it, never bare. A leg the customer's
    // own team works is its `Your Team` pipe.
    const bare = (raw as string[]).findIndex((entry) => !entry.includes("|"));
    // A pipe id or a PLAY id (`<pipe id>~<strategy id>`, `GET /internal/catalogue/plays?pipe=`): a funnel is a straight
    // line of plays (owner 2026-10-13); a bare pipe id is its default play.
    if (bare >= 0) {
      throw bad("bare_leg_refused", `pipeIds[${bare}]: ${raw[bare]} is a leg, not a pipe. Every leg is worked by a channel: name its pipe (GET /internal/catalogue/pipes?legKeys=${raw[bare]}), a Your Team pipe when the customer's own team works it`);
    }
    const { model, names } = await loadModel();
    const picked = (raw as string[]).map((entry, i) => {
      const p = pipeOrPlayById(model, entry);
      if (!p) throw new DeclarationError(404, "pipe_not_found", `pipeIds[${i}]: no pipe or play ${entry} (GET /internal/catalogue/plays?pipe=)`);
      return p;
    });
    // A CUSTOMER composes only what we run today (owner 2026-10-16, standard vocabulary: an outside agent on a
    // customer key does what the Copilot does). The caller says who it acts for (`runnableOnly: true`, set by the
    // gateway for a non-staff key); WHAT runs is decided here, by the same `pipeRunnable` every list filters on.
    if (runnableOnlyOf(body)) {
      const notRun = picked.findIndex((p) => !pipeRunnable(p));
      if (notRun >= 0) {
        const why = notRunnableOf(picked[notRun])!;
        throw new DeclarationError(
          400,
          "pipe_not_runnable",
          `pipeIds[${notRun}]: ${picked[notRun].id} is not something we run today (${why.reason}: ${why.detail}). A customer sales funnel uses only runnable pipes (GET /internal/catalogue/pipes?runnable=true); ask for this one with a feature request`,
        );
      }
    }
    // ONE CHANNEL PER LEG (owner 2026-10-11): a sales funnel is a straight line. Two pipes on one leg, or a leg of
    // the path no pipe names (the sourcing leg included), is refused, never completed or pooled for the caller.
    const twice = picked.findIndex((p, i) => picked.findIndex((q) => q.legKey === p.legKey) !== i);
    if (twice >= 0) {
      throw bad("one_channel_per_leg", `pipeIds[${twice}]: ${picked[twice].id} works the leg ${picked[twice].legKey} a pipe before it already works. A sales funnel names ONE channel per leg; on Start -> Lead found pick one source, or Lead Sourcing (pipe ${LEAD_SOURCING_PIPE_ID}) to let us pick the sources`);
    }
    const legs: FunnelLeg[] = picked.map((p) => ({ legKey: p.legKey, pipe: p }));
    // A funnel HEADED by a trigger (owner 2026-10-15): every pipe answers it, proactive ones included, so a reactive
    // funnel reuses the proactive pipes and their workflows. A first pipe already answering that trigger IS the
    // existing reactive funnel: its own id, no head.
    const rawTrigger = typeof body.triggerId === "string" && body.triggerId.trim() !== "" ? body.triggerId.trim() : null;
    const headTrigger = rawTrigger && picked[0].triggerId !== rawTrigger ? rawTrigger : null;
    if (headTrigger) {
      const legKeys = picked.map((p) => p.legKey);
      const refusal = triggerHeadRefusal(model, headTrigger, legKeys);
      if (refusal) throw triggerHeadError(refusal, headTrigger, legKeys);
      const path = triggerHeadedPath(model, headTrigger, legKeys)!;
      model.paths.set(path.id, path);
    }
    const id = headTrigger ? `${TRIGGER_HEAD}${headTrigger}+${funnelIdOf(legs)}` : funnelIdOf(legs);
    const funnel = funnelById(model, id);
    if (!funnel || funnel.id !== id) {
      const path = pathById(model, pathIdOf(picked.map((p) => p.legKey)));
      if (path && path.legKeys.length > picked.length) {
        const named = new Set(picked.map((p) => p.legKey));
        const missing = path.legKeys.filter((k) => !named.has(k));
        throw bad("leg_without_channel", `${missing.join(", ")}: every leg of the sales path is worked by ONE channel; name its pipe (GET /internal/catalogue/pipes?legKeys=${missing[0]}), on Start -> Lead found one source or Lead Sourcing`);
      }
      throw bad("funnel_invalid", `${id} is no sales funnel: the pipes must work, in order, every leg of a sales path, each pipe feeding the next (GET /internal/catalogue/sales-paths)`);
    }
    const combinationKey = storedCombinationKeyOf(funnel.id);
    const existing = await listDeclaredSalesPaths();
    const declared = existing.some((d) => d.combinationKey === combinationKey);
    const existed = declared || names.has(funnel.id);
    if (!declared) {
      await insertSalesPath(
        combinationKey,
        funnel.legs.map((l) => ({ channelSlug: l.pipe?.channelSlug ?? null, legKey: l.pipe?.computedLegKey ?? l.legKey })),
        createdBy,
        requestedByOrgId,
      );
    }
    const n = await named([funnel.id, salesPathNameKeyOf(funnel.pathId), ...funnelPipes(funnel).map(nameKeyOfPipe)], names);
    console.log(`[features-service] agent catalogue: sales funnel ${funnel.id} ${existed ? "re-declared" : "declared"} by ${createdBy}, named ${n.get(funnel.id)}`);
    res.status(existed ? 200 : 201).json({ created: !existed, ...(await funnelDetail(model, funnel, n)) });
  } catch (err) {
    fail(res, err, "create sales funnel");
  }
});

// ── Tactics, strategies, plays (owner 2026-10-13, `lib/plays.ts`) ──────────────────────────────────

/**
 * A TACTIC is a yes/no tag Jev puts on every workflow version (judged once on the tactic's description); a STRATEGY
 * requires and excludes tactics; a PLAY is a pipe x a strategy. Not the dashboard's "Strategy page" (audience and
 * workflow ranking): another word for another thing. Names and descriptions are unique (409 on a taken one).
 */
const tacticRowOf = (c: PlayCatalogue, t: Tactic) => {
  const appliesTo = subjectOfTactic(t);
  const judged = [...c.tacticsByDynasty.values()].filter((m) => m.has(t.id));
  const writers = [...c.tacticsByWriter.entries()].filter(([k, m]) => k.startsWith(`${appliesTo}|`) && m.has(t.id)).map(([, m]) => m);
  return {
    object: "tactic" as const,
    id: t.id,
    name: t.name,
    description: t.description,
    // What it tags (BEST-TPL-LLM-1022): a workflow version, a template dynasty or an LLM (a writer model alias).
    appliesTo,
    // Template dynasties / LLM aliases judged on it (null on a workflow tactic).
    writersJudged: appliesTo === "workflow" ? null : writers.length,
    writersFollowing: appliesTo === "workflow" ? null : writers.filter((m) => m.get(t.id) === true).length,
    // The plain line a client reads on a message this tactic's workflows wrote (null = not shown to clients).
    clientLine: t.clientLine ?? null,
    // On each workflow's CURRENT version (the one a run executes).
    workflowsJudged: judged.length,
    workflowsFollowing: judged.filter((m) => m.get(t.id) === true).length,
    // Complete, still judging, or FAILING with Jev's reason (owner 2026-10-14): never "pending" forever.
    judging: tacticJudgingOf(t, c.sweepsByTactic.get(t.id), SWEEP_EVERY_MS),
  };
};

/** tactic id -> its served judging state (null for an unknown id). */
const tacticJudgingLookup = (c: PlayCatalogue) => (id: string) => {
  const t = c.tactics.get(id);
  return t ? tacticJudgingOf(t, c.sweepsByTactic.get(id), SWEEP_EVERY_MS) : null;
};

const strategyRowOf = (c: PlayCatalogue, st: Strategy) => ({
  object: "strategy" as const,
  id: st.id,
  name: st.name,
  description: st.description,
  requires: st.requiresTacticIds.map((id) => ({ id, name: c.tactics.get(id)?.name ?? id })),
  excludes: st.excludesTacticIds.map((id) => ({ id, name: c.tactics.get(id)?.name ?? id })),
  pipeIds: [...c.playsByPipe].filter(([, ps]) => ps.some((x) => x.strategyId === st.id)).map(([pipeId]) => pipeId).sort(),
});

router.get("/internal/catalogue/tactics", apiKeyOnly, async (req, res) => {
  try {
    const q = qOf(req);
    const c = await loadPlayCatalogue();
    const rows = [...c.tactics.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((t) => matchesQuery(q, [t.name, t.id, t.description])).map((t) => tacticRowOf(c, t));
    res.json({ object: "tactic", order: "id", ...page(rows, limitOf(req)) });
  } catch (err) {
    fail(res, err, "list tactics");
  }
});

router.get("/internal/catalogue/tactics/:id", apiKeyOnly, async (req, res) => {
  try {
    const c = await loadPlayCatalogue();
    const t = c.tactics.get(req.params.id);
    if (!t) return void res.status(404).json({ error: `no tactic ${req.params.id}`, reason: "tactic_not_found" });
    const verdicts = (await listVerdicts(t.id)).sort((a, b) => (a.workflowSlug < b.workflowSlug ? -1 : 1));
    const writerVerdicts = subjectOfTactic(t) === "workflow" ? [] : (await listWriterVerdicts(t.id)).sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1));
    res.json({
      ...tacticRowOf(c, t),
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      updatedBy: t.updatedBy ?? null,
      updatedAt: t.updatedAt ?? null,
      // Every workflow VERSION judged, with Jev's probability and the model release that answered. A verdict judged on an
      // older description (the tactic was edited) still serves until the sweep re-judges it: `onCurrentDescription:false`.
      verdicts: verdicts.map((v) => ({ workflowSlug: v.workflowSlug, workflowDynastySlug: v.workflowDynastySlug, version: v.version, versionActive: v.versionActive, follows: v.verdict, probability: v.probability, model: v.model, judgedAt: v.judgedAt, onCurrentDescription: v.judgedDescription === t.description })),
      // A template / LLM tactic: every template dynasty (judged on its head) or writer model alias judged (BEST-TPL-LLM-1022).
      writerVerdicts: writerVerdicts.map((v) => ({ subject: v.subjectKind, key: v.subjectKey, judgedOn: v.subjectVersion, follows: v.verdict, probability: v.probability, model: v.model, judgedAt: v.judgedAt, onCurrentDescription: v.judgedDescription === t.description })),
    });
  } catch (err) {
    fail(res, err, "get tactic");
  }
});

router.post("/internal/catalogue/tactics", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const appliesTo = body.appliesTo === undefined ? "workflow" : body.appliesTo;
    if (typeof appliesTo !== "string" || !(TACTIC_SUBJECTS as readonly string[]).includes(appliesTo)) {
      throw new DeclarationError(400, "applies_to_invalid", `appliesTo must be one of ${TACTIC_SUBJECTS.join(", ")}`);
    }
    const t = await insertTactic({ name: text(body, "name", 60), description: text(body, "description", 500), createdBy: actorOf(body), clientLine: body.clientLine === undefined ? null : text(body, "clientLine", 80), appliesTo: appliesTo as TacticSubject });
    console.log(`[features-service] agent catalogue: ${t.appliesTo} tactic ${t.id} declared by ${t.createdBy}; Jev judges every ${t.appliesTo} on it`);
    void kickTacticJudgments();
    res.status(201).json(tacticRowOf(await loadPlayCatalogue(), t));
  } catch (err) {
    fail(res, err, "create tactic");
  }
});

/**
 * Edit a tactic's description (owner 2026-10-14). Unique like a new one (409 `tactic_description_taken`); the name and
 * id never move. Jev re-judges every workflow version on the new words, in place: each old verdict serves until its
 * replacement lands, so no strategy sees a workflow as unjudged mid-edit. The same text = 200 `changed:false`.
 */
router.patch("/internal/catalogue/tactics/:id", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    // The subject (RESEARCH-WF-FIGURES-1022): workflow | template | llm. With a description, both are edited.
    if (body.appliesTo !== undefined) {
      const appliesTo = body.appliesTo;
      if (typeof appliesTo !== "string" || !(TACTIC_SUBJECTS as readonly string[]).includes(appliesTo)) {
        throw new DeclarationError(400, "applies_to_invalid", `appliesTo must be one of ${TACTIC_SUBJECTS.join(", ")}`);
      }
      const moved = await updateTacticSubject({ id: req.params.id, appliesTo: appliesTo as TacticSubject, updatedBy: actorOf(body, "updatedBy") });
      if (moved.changed) {
        console.log(`[features-service] agent catalogue: tactic ${moved.tactic.id} moved from ${moved.previousAppliesTo} to ${moved.tactic.appliesTo} by ${moved.tactic.updatedBy}; Jev judges it on its new subject`);
        if (body.description === undefined) void kickTacticJudgments().then(() => kickTacticJudgments()).then(() => refreshCatalogueMeasurementsAfterPlayWrite());
      }
      if (body.description === undefined && body.clientLine === undefined) {
        return void res.json({ ...tacticRowOf(await loadPlayCatalogue(), moved.tactic), changed: moved.changed, previousAppliesTo: moved.previousAppliesTo, previousDescription: moved.tactic.description, updatedBy: moved.tactic.updatedBy ?? null, updatedAt: moved.tactic.updatedAt ?? null });
      }
    }
    // The client line alone (WRITTEN-BY-1019): client copy, nothing re-judged. With a description, both are edited.
    if (body.clientLine !== undefined) {
      const line = await updateTacticClientLine({ id: req.params.id, clientLine: text(body, "clientLine", 80), updatedBy: actorOf(body, "updatedBy") });
      if (body.description === undefined) {
        return void res.json({ ...tacticRowOf(await loadPlayCatalogue(), line.tactic), changed: line.changed, previousDescription: line.tactic.description, updatedBy: line.tactic.updatedBy ?? null, updatedAt: line.tactic.updatedAt ?? null });
      }
    }
    const { tactic, changed, previousDescription } = await updateTacticDescription({ id: req.params.id, description: text(body, "description", 500), updatedBy: actorOf(body, "updatedBy") });
    if (changed) {
      console.log(`[features-service] agent catalogue: tactic ${tactic.id} description edited by ${tactic.updatedBy} (was ${JSON.stringify(previousDescription)}); Jev re-judges every workflow version on it`);
      // A sweep already in flight read the OLD text: the kick queues a rerun after it, so kick twice, then rebuild the
      // pipe figures on the new verdicts (a verdict that flips moves which workflows a play may pick).
      void kickTacticJudgments()
        .then(() => kickTacticJudgments())
        .then(() => refreshCatalogueMeasurementsAfterPlayWrite());
    }
    res.json({ ...tacticRowOf(await loadPlayCatalogue(), tactic), changed, previousDescription, updatedBy: tactic.updatedBy ?? null, updatedAt: tactic.updatedAt ?? null });
  } catch (err) {
    fail(res, err, "edit tactic");
  }
});

router.get("/internal/catalogue/strategies", apiKeyOnly, async (req, res) => {
  try {
    const q = qOf(req);
    const c = await loadPlayCatalogue();
    const rows = [...c.strategies.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((st) => matchesQuery(q, [st.name, st.id, st.description])).map((st) => strategyRowOf(c, st));
    res.json({ object: "strategy", order: "id", ...page(rows, limitOf(req)) });
  } catch (err) {
    fail(res, err, "list strategies");
  }
});

router.get("/internal/catalogue/strategies/:id", apiKeyOnly, async (req, res) => {
  try {
    const c = await loadPlayCatalogue();
    const st = c.strategies.get(req.params.id);
    if (!st) return void res.status(404).json({ error: `no strategy ${req.params.id}`, reason: "strategy_not_found" });
    res.json({ ...strategyRowOf(c, st), createdBy: st.createdBy, createdAt: st.createdAt, updatedBy: st.updatedBy ?? null, updatedAt: st.updatedAt ?? null });
  } catch (err) {
    fail(res, err, "get strategy");
  }
});

/** A list of tactic ids in a create body (absent = none). */
function tacticIds(body: Body, field: string): string[] {
  const v = body[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) throw bad(`${field}_invalid`, `${field} must be a list of tactic ids`);
  return [...new Set((v as string[]).map((x) => x.trim()))];
}

router.post("/internal/catalogue/strategies", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const st = await insertStrategy({
      name: text(body, "name", 60),
      description: text(body, "description", 500),
      requiresTacticIds: tacticIds(body, "requires"),
      excludesTacticIds: tacticIds(body, "excludes"),
      createdBy: actorOf(body),
    });
    console.log(`[features-service] agent catalogue: strategy ${st.id} declared by ${st.createdBy}`);
    res.status(201).json(strategyRowOf(await loadPlayCatalogue(), st));
  } catch (err) {
    fail(res, err, "create strategy");
  }
});

/** An optional list of tactic ids in an edit body (absent = unchanged). */
function optionalTacticIds(body: Body, field: string): string[] | undefined {
  return body[field] === undefined ? undefined : tacticIds(body, field);
}

/**
 * STAFF: edit a strategy's rule (`requires`, `excludes`: each a full list, absent = unchanged) and/or `description`
 * (STRATEGY-EDIT-PUBLIC-1014, 2026-10-14: a new tactic leaked into older strategies naming nothing about it). An edit
 * changes what every campaign of every play on it runs, so the gateway mounts it staff-only (like a pipe's default
 * play). Same rules as a create (unique description and rule, known tactics, never both, at least one); name and id
 * never move. Refused 409 `default_play_runs_nothing` when the strategy is a pipe's DEFAULT play and the new rule
 * allows none of its active workflows. Plays' allowed workflows and figures rebuild at once. Nothing new = `changed:false`.
 */
router.patch("/internal/catalogue/strategies/:id", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const updatedBy = actorOf(body, "updatedBy");
    const requires = optionalTacticIds(body, "requires");
    const excludes = optionalTacticIds(body, "excludes");
    const description = body.description === undefined ? undefined : text(body, "description", 500);
    if (requires === undefined && excludes === undefined && description === undefined) throw bad("edit_empty", "send at least one of requires, excludes, description");
    const { current, next, changed } = await proposeStrategyEdit({ id: req.params.id, requiresTacticIds: requires, excludesTacticIds: excludes, description, updatedBy });
    let st = current;
    if (changed) {
      invalidatePlayCatalogue();
      const [c, assignments] = await Promise.all([loadPlayCatalogue(), listRunnableLegAssignments()]);
      for (const [pipeId, ps] of c.playsByPipe) {
        if (ps.some((p) => p.isDefault && p.strategyId === next.id)) assertStrategyRunsOnPipe(c, assignments, pipeId, next, `it is the pipe's default play, so every campaign of the pipe would have nothing to run`);
      }
      st = await storeStrategyEdit(next, updatedBy);
      console.log(
        `[features-service] agent catalogue: strategy ${st.id} edited by ${updatedBy} (requires ${JSON.stringify(current.requiresTacticIds)} -> ${JSON.stringify(st.requiresTacticIds)}, excludes ${JSON.stringify(current.excludesTacticIds)} -> ${JSON.stringify(st.excludesTacticIds)}${st.description !== current.description ? ", description changed" : ""}); plays rebuild`,
      );
      void refreshCatalogueMeasurementsAfterPlayWrite();
    }
    const c = await loadPlayCatalogue();
    const ref = (ids: string[]) => ids.map((id) => ({ id, name: c.tactics.get(id)?.name ?? id }));
    res.json({
      ...strategyRowOf(c, st),
      changed,
      previous: { requires: ref(current.requiresTacticIds), excludes: ref(current.excludesTacticIds), description: current.description },
      createdBy: st.createdBy,
      createdAt: st.createdAt,
      updatedBy: st.updatedBy ?? null,
      updatedAt: st.updatedAt ?? null,
    });
  } catch (err) {
    fail(res, err, "edit strategy");
  }
});

/** `?pipe=` (a pipe id): that pipe's plays, default first. Without it: every catalogued play of every pipe. */
router.get("/internal/catalogue/plays", apiKeyOnly, async (req, res) => {
  try {
    const pipeId = typeof req.query.pipe === "string" && req.query.pipe !== "" ? req.query.pipe.replace(/ /g, "+") : null;
    const { model } = await loadModel();
    let bases: CataloguePipe[];
    if (pipeId) {
      const p = model.pipes.get(pipeId);
      if (!p) return void res.status(404).json({ error: `no pipe ${pipeId}`, reason: "pipe_not_found" });
      bases = [p];
    } else {
      bases = [...model.pipes.values()].filter((p) => p.play !== null);
    }
    const rows = bases.flatMap((p) => playsOfPipe(model, p)).map((x) => playRowOf(model, x));
    res.json({ object: "play", order: "pipe_then_default_first", ...page(rows, limitOf(req)) });
  } catch (err) {
    fail(res, err, "list plays");
  }
});

/**
 * The sales funnels carrying a play (owner 2026-10-14): an agent that just catalogued a play reads the funnels it can
 * launch on it, runnable or not (the customer lists keep runnable funnels only, so a fresh play's funnels were nowhere
 * to read and an agent hand-built the id). Mixed funnels left out (never runnable). Best ROI first, at most `limit`.
 */
async function funnelsCarrying(model: CatalogueModel, names: Map<string, string>, p: CataloguePipe, limit = 10) {
  const all = [...model.paths.values()]
    .filter((path) => path.legKeys.includes(p.legKey))
    .flatMap((path) => funnelsOfPath(model, path))
    .filter((f) => f.legs.some((l) => legPipes(l).some((x) => x.id === p.id)))
    // A MIXED funnel is never runnable, whatever the play: never proposed.
    .filter((f) => !funnelMixed(f))
    .sort(byRoi((f: CatalogueFunnel) => f.economics, (f) => f.id, (f) => funnelTypeOf(f)));
  const shown = all.slice(0, limit);
  const n = await named(shown.map((f) => f.id), names);
  return {
    total: all.length,
    truncated: all.length > limit,
    rows: shown.map((f) => {
      const blocked = funnelPipes(f).map(notRunnableOf).find((x) => x !== null) ?? null;
      return { id: f.id, name: n.get(f.id)!, line: funnelLine(f), type: funnelTypeOf(f), runnable: funnelRunnable(f), notRunnableReason: funnelRunnable(f) ? null : (blocked?.reason ?? null) };
    }),
  };
}

/**
 * The workflows a play may run, each with its fleet figure on the pipe's leg (mature cost per outcome, else learning),
 * and the pipe DEFAULT play's pick beside it (owner ask 2026-10-14): an agent sees what the play would run, and how it
 * compares with what the pipe runs today, before it launches anything. A workflow with no fleet history on the leg reads
 * `learning` / `no_outcome_yet`. Null `allowedWorkflows` on a pipe cataloguing no play; a ranking not computed yet
 * leaves the figures out (`figuresUnavailableReason`), never the list.
 */
async function allowedWorkflowsOf(model: CatalogueModel, p: CataloguePipe) {
  const base = model.pipes.get(p.play?.basePipeId ?? p.id) ?? p;
  const defaultPick = { playId: base.id, bestWorkflowSlug: base.measurement?.workflowDynastySlug ?? null, measuredBasis: base.measurement?.basis ?? null, ...econWire(base.economics, perStep(model, base.toStep)) };
  if (!p.play) return { allowedWorkflows: null, defaultPlayPick: defaultPick, figuresUnavailableReason: null };
  const rows = p.operatedBy === "customer" ? [] : await workflowRows(model, p);
  const byDynasty = new Map((rows ?? []).map((x) => [x.r.workflowDynastySlug, x]));
  const allowedWorkflows = p.play.allowedActiveDynasties.map((d) => {
    const x = byDynasty.get(d);
    const e: Economics = x?.e ?? { status: "learning", costUsd: null, roi: null, reason: "no_outcome_yet", estimates: [] };
    return { id: d, name: x?.name ?? d, ...econWire(e, perStep(model, p.toStep)), isDefaultPlayPick: d === defaultPick.bestWorkflowSlug };
  });
  return { allowedWorkflows, defaultPlayPick: defaultPick, figuresUnavailableReason: rows === null ? "workflow_ranking_not_computed_yet" : null };
}

router.get("/internal/catalogue/plays/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model, names } = await loadModel();
    const p = pipeOrPlayById(model, req.params.id);
    if (!p) return void res.status(404).json({ error: `no play ${req.params.id}`, reason: "play_not_found" });
    res.json({ ...playRowOf(model, p), learningReason: p.economics.reason, estimates: p.economics.estimates, excludedWorkflowDynastySlugs: p.play?.excludedDynasties ?? [], ...(await allowedWorkflowsOf(model, p)), salesFunnels: await funnelsCarrying(model, names, p) });
  } catch (err) {
    fail(res, err, "get play");
  }
});

/**
 * A pipe's DEFAULT play is what every campaign naming no strategy runs: making a strategy the default is refused while
 * it allows no ACTIVE workflow assigned to the pipe, judged NOW (a workflow not judged on a tactic the strategy names is
 * not allowed): the switch would leave every running campaign of the pipe with nothing to run.
 */
async function assertDefaultPlayRuns(pipeId: string, strategyId: string): Promise<void> {
  invalidatePlayCatalogue();
  const [c, assignments] = await Promise.all([loadPlayCatalogue(), listRunnableLegAssignments()]);
  const st = c.strategies.get(strategyId);
  if (!st) throw new DeclarationError(404, "strategy_not_found", `no strategy ${strategyId} (GET /internal/catalogue/strategies)`);
  assertStrategyRunsOnPipe(c, assignments, pipeId, st, "as the default play, every campaign of the pipe would have nothing to run");
}

/** Refused 409 `default_play_runs_nothing` while `st` allows none of the pipe's ACTIVE workflows, judged now. */
function assertStrategyRunsOnPipe(c: PlayCatalogue, assignments: readonly LegAssignmentRow[], pipeId: string, st: Strategy, consequence: string): void {
  const [slug, leg] = [pipeId.slice(0, pipeId.indexOf("|")), pipeId.slice(pipeId.indexOf("|") + 1)];
  const active = assignments.filter((a) => a.featureSlug === slug && pipeLegKeyOf(slug, a.legKey) === pipeLegKeyOf(slug, leg) && a.state === "active").map((a) => a.workflowDynastySlug);
  const excluded = excludedDynasties(workflowStrategyOf(c, st), active, c.tacticsByDynasty, tacticNameOf(c));
  if (active.every((d) => excluded.has(d))) {
    throw new DeclarationError(
      409,
      "default_play_runs_nothing",
      `the strategy ${st.id} allows none of the ${active.length} active workflow(s) of ${pipeId} yet (${[...excluded.values()].join("; ") || "no active workflow"}): ${consequence}`,
    );
  }
}

/**
 * Catalogue a play on a pipe (`{pipeId, strategyId, createdBy, default?}`): plays are per pipe, never invented per
 * campaign. A pipe that catalogues no play yet takes one too: its default stays "every assigned workflow" and the play
 * narrows it. A pipe's DEFAULT play is set by staff only (`PUT /internal/catalogue/pipes/:pipeId/default-play`).
 */
router.post("/internal/catalogue/plays", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const pipeId = text(body, "pipeId", 200);
    const strategyId = text(body, "strategyId", 100);
    const before = await loadModel();
    const pipe = before.model.pipes.get(pipeId);
    if (!pipe) throw new DeclarationError(404, "pipe_not_found", `no pipe ${pipeId}`);
    if (pipe.operatedBy !== "platform") throw bad("pipe_not_ours", `${pipeId} is worked by the customer's own team: no workflow of ours runs it, so no strategy chooses one`);
    const { created } = await insertPlay({ pipeId, strategyId, createdBy });
    const { model, names } = await loadModel();
    const play = pipeOrPlayById(model, playIdOf(pipeId, strategyId));
    if (!play) throw new Error(`play ${pipeId}~${strategyId} was stored but is not in the catalogue`);
    console.log(`[features-service] agent catalogue: play ${play.id} ${created ? "declared" : "re-declared"} by ${createdBy}`);
    if (created) void refreshCatalogueMeasurementsAfterPlayWrite();
    res.status(created ? 201 : 200).json({ created, ...playRowOf(model, play), salesFunnels: await funnelsCarrying(model, names, play) });
  } catch (err) {
    fail(res, err, "create play");
  }
});

/**
 * STAFF: make a strategy the pipe's DEFAULT play (`{strategyId, decidedBy}`), what every campaign naming no strategy on
 * the pipe runs. Fleet-wide, so never on the public creates (`POST plays` is open to every client through the gateway).
 * One transaction: the play is catalogued if new, the previous default stays a play of the pipe. Refused 409
 * `default_play_runs_nothing` while the strategy allows none of the pipe's active workflows.
 */
router.put("/internal/catalogue/pipes/:pipeId/default-play", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const decidedBy = text(body, "decidedBy", 200);
    const strategyId = text(body, "strategyId", 100);
    const pipeId = req.params.pipeId;
    const before = await loadModel();
    const pipe = before.model.pipes.get(pipeId);
    if (!pipe) throw new DeclarationError(404, "pipe_not_found", `no pipe ${pipeId}`);
    if (pipe.operatedBy !== "platform") throw bad("pipe_not_ours", `${pipeId} is worked by the customer's own team: no workflow of ours runs it, so no strategy chooses one`);
    await assertDefaultPlayRuns(pipeId, strategyId);
    const { created, defaultChanged } = await insertPlay({ pipeId, strategyId, createdBy: decidedBy, isDefault: true });
    const { model } = await loadModel();
    const play = model.pipes.get(pipeId);
    if (!play) throw new Error(`pipe ${pipeId} vanished from the catalogue`);
    console.log(`[features-service] agent catalogue: ${pipeId} default play ${defaultChanged ? "set to" : "already"} ${strategyId} by ${decidedBy}${created ? " (play catalogued)" : ""}`);
    if (created || defaultChanged) void refreshCatalogueMeasurementsAfterPlayWrite();
    res.json({ created, defaultChanged, ...playRowOf(model, play) });
  } catch (err) {
    fail(res, err, "create play");
  }
});

/**
 * STAFF: the pipe has NO default play any more (`{decidedBy}`; owner 2026-10-20, DOTTEREL-NO-DEFAULT-1020): every
 * campaign naming no strategy on the pipe runs every assigned workflow, ranked as usual. The previous default stays a
 * play of the pipe. Re-stating it changes nothing (`changed:false`).
 */
router.delete("/internal/catalogue/pipes/:pipeId/default-play", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const decidedBy = text(body, "decidedBy", 200);
    const pipeId = req.params.pipeId;
    const before = await loadModel();
    const pipe = before.model.pipes.get(pipeId);
    if (!pipe) throw new DeclarationError(404, "pipe_not_found", `no pipe ${pipeId}`);
    if (pipe.operatedBy !== "platform") throw bad("pipe_not_ours", `${pipeId} is worked by the customer's own team: no workflow of ours runs it, so no strategy chooses one`);
    const { changed, previousStrategyId } = await clearDefaultPlay(pipeId);
    const { model } = await loadModel();
    const after = model.pipes.get(pipeId);
    if (!after) throw new Error(`pipe ${pipeId} vanished from the catalogue`);
    console.log(`[features-service] agent catalogue: ${pipeId} default play ${changed ? `cleared (was ${previousStrategyId})` : "already none"} by ${decidedBy}`);
    if (changed) void refreshCatalogueMeasurementsAfterPlayWrite();
    res.json({ changed, previousStrategyId, ...playRowOf(model, after) });
  } catch (err) {
    fail(res, err, "clear default play");
  }
});

/**
 * STAFF: RETIRE a non-default play from its pipe (`{retiredBy, note?}`; owner 2026-10-22, PLAY-RETIRE-1022: the
 * "Valid only" and "Valid + Catch-all" plays belong on Lead Sourcing, not on the Sales Cold Email pipe). Every campaign
 * whose funnel names the play runs the pipe's DEFAULT play from then on (no client action, no unit held: its funnel id
 * reads as the bare pipe on every read, `resolvePlay` / `pipeOrPlayById` / `canonicalFunnelId`); the catalogue lists
 * the play no more, the row is kept. The DEFAULT play (bare pipe id, or the strategy the pipe defaults to) is refused 409
 * `default_play_not_retirable`. Re-cataloguing it (`POST plays`) revives it. Answers what the pipe now runs.
 */
router.post("/internal/catalogue/plays/:id/retire", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const retiredBy = actorOf(body, "retiredBy");
    if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.trim().length > 500)) throw bad("note_invalid", "note must be a string of at most 500 characters");
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;
    const { pipeId, strategyId } = splitPlayId(req.params.id);
    const before = await loadModel();
    const pipe = before.model.pipes.get(pipeId);
    if (!pipe) throw new DeclarationError(404, "pipe_not_found", `no pipe ${pipeId}`);
    if (!strategyId) {
      throw new DeclarationError(409, "default_play_not_retirable", `${pipeId} is the pipe's DEFAULT play: change or clear the default first (PUT or DELETE /internal/catalogue/pipes/{pipeId}/default-play)`);
    }
    const { changed, retiredAt } = await retirePlay({ pipeId, strategyId, retiredBy, note });
    const { model } = await loadModel();
    const now = model.pipes.get(pipeId);
    if (!now) throw new Error(`pipe ${pipeId} vanished from the catalogue`);
    console.log(`[features-service] agent catalogue: play ${req.params.id} ${changed ? "retired" : "already retired"} by ${retiredBy}${note ? ` (${note})` : ""}: its campaigns run the default play of ${pipeId}`);
    if (changed) void refreshCatalogueMeasurementsAfterPlayWrite();
    res.json({ changed, retiredPlayId: playIdOf(pipeId, strategyId), retiredAt, runsNow: playRowOf(model, now) });
  } catch (err) {
    fail(res, err, "retire play");
  }
});

// ── Step vocabulary (public: the customer dashboard's Outcomes icons) ──────────────────────────────

/**
 * Every catalogue step's key, name and Phosphor icon, nothing economic (owner 2026-10-11: the
 * customer's Outcomes entries wear the icon the staff Steps section shows). Built on the same model
 * as `GET /internal/catalogue/steps` without the measurements (icon and name never depend on them),
 * so each row is byte-equal to the staff read's `id`/`name`/`icon` for that step.
 */
/** Every icon and colour a workflow / template mark can take (MARKS-1022), so a reader can draw every one it may be served. */
router.get("/public/catalogue/mark-icons", (_req, res) => {
  res.json({ icons: MARK_ICONS, colors: GLYPH_COLORS, families: MARK_FAMILIES });
});

router.get("/public/catalogue/steps", async (_req, res) => {
  try {
    const [all, pub, declaredSteps] = await Promise.all([
      loadChannelCatalogue({ publishedOnly: false }),
      loadChannelCatalogue({ publishedOnly: true }),
      listDeclaredSteps(),
    ]);
    const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
    const model = buildCatalogueModel({ channels: all.channels, publishedPipeIds, declaredSteps, measurements: new Map(), lifetimeRevenueUsd: null });
    const rows = [...model.steps.values()].sort((a, b) => a.key.localeCompare(b.key)).map((s) => ({ key: s.key, name: s.label, pluralName: pluralLabelOf(s.label), icon: s.icon, ...lifecycleWire(s) }));
    res.set("Cache-Control", "public, max-age=300").json({ object: "step", total: rows.length, lifecycleLadder: servedLifecycleLadder(), rows });
  } catch (err) {
    fail(res, err, "list public steps");
  }
});

// ── Faces (public: the dashboard shows the image) ─────────────────────────────────────────────────

router.get("/public/catalogue/faces/:file", (req, res) => {
  const m = /^(.{1,60})\.svg$/.exec(req.params.file);
  if (!m) return void res.status(400).json({ error: "the face path is /public/catalogue/faces/<name>.svg", reason: "face_path_invalid" });
  res.set("Content-Type", "image/svg+xml").set("Cache-Control", "public, max-age=86400").send(faceSvg(m[1]));
});

/**
 * THE CUSTOMER COPY OF SALES FUNNELS BY ID, for the org-scoped funnel campaign read
 * (`routes/sales-funnel-campaigns.ts`): name, face, type, trigger label (the SAME one its catalogue row
 * serves), path. Built on the catalogue's STRUCTURE only (channels, legs, steps),
 * never on its fleet figures, so a read never waits on the economics build. An id the catalogue does not know
 * maps to null (logged by the caller).
 */
export interface FunnelCopy {
  name: string | null;
  face: string | null;
  type: "proactive" | "reactive";
  triggerLabel: string | null;
  /** One short customer sentence: what we do in this funnel (owner 2026-10-14, `lib/funnel-short-descriptions.ts`);
   *  null + `shortDescriptionUnavailableReason` when no leg of it is ours. */
  shortDescription: string | null;
  shortDescriptionUnavailableReason: ShortDescriptionUnavailableReason | null;
  path: FunnelPathView;
  /** The step the funnel's first leg starts from (null = from nothing): where a campaign on it takes people over
   *  unless one of its own units produces that step (`lib/value-added.ts`). */
  firstStep: string | null;
}

/**
 * A funnel's PATH as the dashboard draws it (owner 2026-10-11): `items` in reading order, a step, then the ONE channel
 * working the leg, then the leg's next step, and so on to Paid client. A proactive funnel starts at Start ("Start ->
 * Lead Sourcing -> Lead found -> Sales Cold Email Outreach -> Positive reply -> Your Team Closing Calls -> Paid
 * client"); a reactive one with its TRIGGER item (`kind: "trigger"`, unique slug + name, "Positive Reply") in place of
 * its trigger step. EVERY two steps have exactly one channel between them (owner 2026-10-11: a sales funnel is a
 * straight line), `runByUs` false on the customer's own team's. `legs` states the same per leg, structured.
 */
export interface FunnelPathView {
  /** A reactive funnel's first item is its TRIGGER (owner 2026-10-11: "[⚡ Positive Reply] -> [AI Meeting Booking] ->
   *  Meeting booked -> ..."), in place of its trigger step; a proactive one's is Start. */
  items: Array<
    | { kind: "trigger"; slug: string; name: string }
    | { kind: "step"; key: string; label: string }
    | { kind: "channel"; slug: string; name: string; runByUs: boolean }
  >;
  legs: Array<{
    legKey: string;
    fromStep: string;
    toStep: string;
    /** At least one channel of the leg is ours. */
    runByUs: boolean;
    /** The leg's one channel. */
    channelSlug: string | null;
    channelName: string | null;
    channels: Array<{ slug: string; name: string; runByUs: boolean }>;
  }>;
}

const START_STEP = { kind: "step" as const, key: "start", label: "Start" };

/** PURE: the path view of a funnel: one channel per leg. */
export function funnelPathView(model: CatalogueModel, f: CatalogueFunnel): FunnelPathView {
  const step = (key: string | null) => (key === null ? START_STEP : { kind: "step" as const, key, label: stepLabel(model, key) });
  const items: FunnelPathView["items"] = [];
  const trigger = funnelTrigger(model, f);
  const legs: FunnelPathView["legs"] = f.legs.map((l, i) => {
    const { fromStep, toStep } = legStepsOf(model, l.legKey);
    if (i === 0) items.push(trigger ? { kind: "trigger", ...trigger } : step(fromStep));
    const channels = legPipes(l).map((p) => ({ slug: p.channelSlug, name: p.channelName, runByUs: p.operatedBy === "platform" }));
    for (const c of channels) items.push({ kind: "channel", ...c });
    items.push(step(toStep));
    return {
      legKey: l.legKey,
      fromStep: fromStep ?? "start",
      toStep,
      runByUs: channels.some((c) => c.runByUs),
      channelSlug: l.pipe?.channelSlug ?? null,
      channelName: l.pipe?.channelName ?? null,
      channels,
    };
  });
  return { items, legs };
}

/** PURE: the funnel's short customer sentence, read off its path view (one channel per leg). */
export function funnelShortDescriptionOf(model: CatalogueModel, f: CatalogueFunnel): ReturnType<typeof funnelShortDescription> {
  const view = funnelPathView(model, f);
  const bySlug = new Map(model.channels.map((c) => [c.slug, c] as const));
  const first = f.legs[0]?.pipe ?? null;
  // A funnel HEADED by a condition instance answers the people of that condition, whatever its first pipe answers
  // ("trigger:signup_not_paid_5_min+signup_to_paid_client@ai-follow-up-email": signups who have not paid yet).
  const headCondition = f.headTriggerId && triggerCondition(f.headTriggerId) ? f.headTriggerId : null;
  return funnelShortDescription({
    reactive: headCondition !== null || first?.mode === "reactive",
    triggerId: headCondition ?? (first?.mode === "reactive" ? first.triggerId : null),
    legs: view.legs.map((l) => ({
      fromStep: l.fromStep === "start" ? null : l.fromStep,
      toStep: l.toStep,
      channel: l.channelSlug ? (bySlug.get(l.channelSlug) ?? null) : null,
      runByUs: l.runByUs,
    })),
  });
}

export async function funnelCopiesFor(ids: readonly string[]): Promise<{
  copies: Map<string, FunnelCopy | null>;
  pipeSteps: Map<string, { fromStep: string | null; toStep: string }>;
  /** A funnel campaign's path: its funnel's (one channel per leg). */
  pathOf: (id: string) => FunnelPathView | null;
}> {
  const [all, pub, declaredSteps, names, triggers, assignments, playCatalogue] = await Promise.all([
    loadChannelCatalogue({ publishedOnly: false }),
    loadChannelCatalogue({ publishedOnly: true }),
    listDeclaredSteps(),
    allNamesByKey(),
    listTriggerCatalogue(),
    listLegAssignments(),
    loadPlayCatalogue(),
  ]);
  const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
  // The PLAYS too (structure only, no measurement): a funnel through a non-default play (`<pipe>~<strategy>`) is its
  // own funnel, so a model without them knows no such id and a running campaign on it read as "not in the catalogue".
  const model = buildCatalogueModel({
    channels: all.channels,
    publishedPipeIds,
    declaredSteps,
    measurements: new Map(),
    lifetimeRevenueUsd: null,
    triggers,
    plays: playInputsOf(playCatalogue, assignments, new Map()),
    retiredPlays: playCatalogue.retiredByPipe,
  });
  const found = new Map(ids.flatMap((id) => {
    const f = funnelById(model, id);
    return f ? [[id, f] as const] : [];
  }));
  const out = new Map<string, FunnelCopy | null>(ids.map((id) => [id, null]));
  for (const [id, f] of found) {
    const name = names.get(f.id) ?? null;
    const short = funnelShortDescriptionOf(model, f);
    out.set(id, {
      name,
      face: name ? faceOf(name).svgPath : null,
      type: funnelTypeOf(f),
      triggerLabel: funnelTriggerLabel(f, (k) => stepLabel(model, k), (id) => model.triggers.get(id)?.name ?? null),
      shortDescription: short.shortDescription,
      shortDescriptionUnavailableReason: short.reason,
      path: funnelPathView(model, f),
      firstStep: funnelFirstStep(f.legs),
    });
  }
  // Every pipe's steps, so a caller knows which step each of a campaign's units produces (`lib/value-added.ts`).
  const pipeSteps = new Map([...model.pipes.values()].map((p) => [p.id, { fromStep: p.fromStep, toStep: p.toStep }] as const));
  const pathOf = (id: string) => {
    const f = found.get(id);
    return f ? funnelPathView(model, f) : null;
  };
  return { copies: out, pipeSteps, pathOf };
}

export default router;

/**
 * The catalogue's side of a LIVED sales path (`lib/lived-sales-paths.ts`): every step key the catalogue
 * knows (coded and declared, so a timeline label equal to a declared step is placed), and, per lived path
 * id the catalogue also knows, its name and EXPECTED economics (the same figures `/internal/catalogue/sales-paths`
 * serves), so a reader compares planned vs lived on one row. Never mints a name: a lived path the catalogue
 * has not named reads `name: null`. The expected half is fail-soft (`expectedUnavailableReason`): the lived
 * figures never wait on, nor fail with, the fleet economics build.
 */
export interface ExpectedPathFigures {
  salesPathId: string;
  name: string | null;
  status: string;
  costUsd: number | null;
  roi: number | null;
  roiBasis: "measured" | "estimated" | null;
}

export async function catalogueForLivedPaths(): Promise<{
  stepKeys: string[];
  expectedOf: (pathId: string) => ExpectedPathFigures | null;
  expectedUnavailableReason: string | null;
}> {
  try {
    const { model, names } = await loadModel();
    const expectedOf = (id: string): ExpectedPathFigures | null => {
      const p = pathById(model, id);
      if (!p) return null;
      const e = pathEconomics(model, p);
      return { salesPathId: p.id, name: names.get(salesPathNameKeyOf(p.id)) ?? null, status: e.status, costUsd: e.costUsd, roi: e.roi, roiBasis: roiBasisOf(e) };
    };
    return { stepKeys: [...model.steps.keys()], expectedOf, expectedUnavailableReason: null };
  } catch (error) {
    console.error(`[features-service] lived sales paths: catalogue economics unreadable, expected figures omitted: ${(error as Error).message}`);
    const [all, declaredSteps] = await Promise.all([loadChannelCatalogue({ publishedOnly: false }), listDeclaredSteps()]);
    const model = buildCatalogueModel({ channels: all.channels, publishedPipeIds: new Set(), declaredSteps, measurements: new Map(), lifetimeRevenueUsd: null, triggers: [] });
    return {
      stepKeys: [...model.steps.keys()],
      expectedOf: () => null,
      expectedUnavailableReason: error instanceof StoreNotComputedError ? "catalogue_economics_not_computed_yet" : "catalogue_economics_unreadable",
    };
  }
}
