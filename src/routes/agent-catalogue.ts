import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
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
  SOURCED_STEP,
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
  pipeLine,
  salesPathNameKeyOf,
  stepEconomics,
  stepLabel,
  type CatalogueFunnel,
  type CatalogueModel,
  type CataloguePath,
  type CataloguePipe,
  type Economics,
  type FunnelLeg,
  type PipeMeasurement,
} from "../lib/agent-catalogue.js";
import { faceOf, faceSvg } from "../lib/catalogue-faces.js";
import { matchChannelStepKey, CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import {
  insertLeg,
  insertLegRate,
  insertSalesPath,
  insertSalesPathChain,
  insertStep,
  listDeclaredSalesPathChains,
  listDeclaredSalesPaths,
  listDeclaredSteps,
  listTriggerTypes,
  loadChannelCatalogue,
  registerStepDeclarations,
  type LoadedCatalogue,
} from "../lib/channel-declarations-store.js";
import { actorOf, DeclarationError, parseLegInput, requestedByOrgIdOf } from "../lib/channel-declarations.js";
import { allNamesByKey, salesPathNamesFor, SalesPathNamePoolExhaustedError } from "../lib/sales-path-names.js";
import { funnelTriggerLabel } from "../lib/funnel-descriptions.js";
import { campaignNameKeyOf } from "../lib/offer-sales-paths.js";
import { getBrandEffectiveRates, getFleetArrowMedians, getFleetLifetimeRevenueMedian, legPairKey, peekFleetStatedMedians, type FleetArrowMedians } from "../lib/effective-conversion-rates.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { awaitWarmStore, StoreNotComputedError } from "../lib/await-warm-store.js";
import { servedLegKeyOf, storedCombinationKeyOf } from "../lib/funnel-legs.js";
import { invalidateChannelCatalogue, fleetLegPrice, readLegWorkflowRanking } from "./public.js";

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
  /** Pipes whose fleet read failed: served `learning` with reason `measurement_unreadable`, logged loud. */
  unreadable: Set<string>;
  computedAt: string;
  /** The fleet medians the figures were built with, kept beside them so a fresh process can serve them
   *  before its own fleet sweep ends (null on a store built before this field existed). */
  fleet: { arrows: FleetArrowMedians; lifetimeRevenue: { usd: number | null; offerCount: number } } | null;
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
  unreadable: string[];
  fleet: { arrows: Array<[string, { ratePct: number | null; brandCount: number }]>; lifetimeRevenue: { usd: number | null; offerCount: number } } | null;
}

export function serializeFigures(v: MeasurementStore): string {
  const out: StoredFigures = {
    computedAt: v.computedAt,
    byPipe: [...v.byPipe],
    unreadable: [...v.unreadable],
    fleet: v.fleet ? { arrows: [...v.fleet.arrows], lifetimeRevenue: v.fleet.lifetimeRevenue } : null,
  };
  return JSON.stringify(out);
}

export function parseFigures(text: string): MeasurementStore {
  const s = JSON.parse(text) as StoredFigures;
  if (!Array.isArray(s.byPipe) || !Array.isArray(s.unreadable) || typeof s.computedAt !== "string") throw new Error("not a stored catalogue figures cell");
  return {
    byPipe: new Map(s.byPipe),
    unreadable: new Set(s.unreadable),
    computedAt: s.computedAt,
    fleet: s.fleet ? { arrows: new Map(s.fleet.arrows), lifetimeRevenue: s.fleet.lifetimeRevenue } : null,
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
  const unreadable = new Set<string>();
  // A pipe whose read fails in THIS build keeps the measurement of the build it replaces (the last computed
  // figure, same rule as the whole store): one transient fleet-read timeout must not turn a measured pipe
  // learning for a whole fresh window, nor be persisted for the next process (2026-10-10: Lumen read
  // `measurement_unreadable` after a restart). Only a pipe never measured reads unreadable.
  const previous = measurementStore?.value.byPipe ?? new Map<string, PipeMeasurement>();
  await mapWithConcurrency(pipes, MEASUREMENT_CONCURRENCY, async (p) => {
    try {
      const price = await withTimeout(fleetLegPrice(p.slug, p.computedLegKey), MEASUREMENT_TIMEOUT_MS, `pipe ${p.id}`);
      byPipe.set(p.id, { basis: price.basis, costPerOutcomeUsd: price.costPerOutcomeUsd, conversionRatePct: price.conversionRatePct, workflowDynastySlug: price.workflowDynastySlug });
    } catch (error) {
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
  // The medians beside the figures (a background build may wait on the fleet sweep; a read never does).
  const [arrows, lifetimeRevenue] = await Promise.all([getFleetArrowMedians(), getFleetLifetimeRevenueMedian()]);
  return { byPipe, unreadable, computedAt: new Date().toISOString(), fleet: { arrows, lifetimeRevenue } };
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

/** Test seams. */
export function __setCatalogueMeasurementsForTest(byPipe: Map<string, PipeMeasurement>): void {
  measurementStore = { value: { byPipe, unreadable: new Set(), computedAt: new Date(0).toISOString(), fleet: null }, at: Date.now() };
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

/** The fleet medians a read prices on: this process's own when computed, else the stored copy's, else (the
 *  very first boot only) the sweep itself. */
async function fleetMediansFor(stored: MeasurementStore["fleet"]): Promise<NonNullable<MeasurementStore["fleet"]>> {
  const own = peekFleetStatedMedians();
  if (own) return { arrows: own.arrows, lifetimeRevenue: own.lifetimeRevenue };
  if (stored) return stored;
  const [arrows, lifetimeRevenue] = await Promise.all([getFleetArrowMedians(), getFleetLifetimeRevenueMedian()]);
  return { arrows, lifetimeRevenue };
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
  rates: Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" }>;
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
  const [ltr, effective] = await Promise.all([offerLifetimeRevenue(offer.lifetimeRevenueUsd), getBrandEffectiveRates(brandId, orgId, legEconomics)]);
  const rates = new Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" }>();
  for (const r of effective.legs) {
    if (r.effectiveRatePct === null || (r.source !== "measured" && r.source !== "manual")) continue;
    rates.set(legPairKey(r.fromStep, r.toStep), { ratePct: r.effectiveRatePct, source: r.source === "measured" ? "offer_measured" : "offer_stated" });
  }
  return { offerId, brandId, lifetimeRevenueUsd: ltr.usd, lifetimeRevenueSource: ltr.source, rates };
}

/** The `offer` block a per-offer read answers with (null on the fleet catalogue). */
const offerEcho = (o: OfferContext | null) =>
  o ? { offerId: o.offerId, brandId: o.brandId, lifetimeRevenueUsd: o.lifetimeRevenueUsd, lifetimeRevenueSource: o.lifetimeRevenueSource, ownRateLegs: o.rates.size } : null;

async function loadModel(offer: OfferContext | null = null): Promise<Loaded> {
  await installPersistedFigures();
  void warmCatalogueMeasurements();
  const [measurements, all, pub, declaredSteps, names, triggers] = await Promise.all([
    awaitWarmStore(() => measurementStore?.value ?? null, warmCatalogueMeasurements, MEASUREMENTS_BOOT_WAIT_MS, "catalogue economics"),
    loadChannelCatalogue({ publishedOnly: false }),
    loadChannelCatalogue({ publishedOnly: true }),
    listDeclaredSteps(),
    allNamesByKey(),
    listTriggerTypes(),
  ]);
  const { arrows: medians, lifetimeRevenue: ltr } = await fleetMediansFor(measurements.fleet);
  const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
  const model = buildCatalogueModel({
    channels: all.channels,
    publishedPipeIds,
    declaredSteps,
    measurements: measurements.byPipe,
    fleetMedians: medians,
    lifetimeRevenueUsd: offer ? offer.lifetimeRevenueUsd : ltr.usd,
    ...(offer ? { offerRates: offer.rates } : {}),
    triggers,
  });
  for (const id of measurements.unreadable) {
    const p = model.pipes.get(id);
    if (p && p.economics.status === "learning") p.economics = { ...p.economics, reason: "measurement_unreadable" };
  }
  return { model, measurements, names, cat: all };
}

const nameKeyOfPipe = (p: Pick<CataloguePipe, "channelSlug" | "legKey">): string => campaignNameKeyOf(p.channelSlug, p.legKey);

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
  if (err instanceof BadQuery) return void res.status(400).json({ error: err.message, reason: err.reason });
  if (err instanceof DeclarationError) return void res.status(err.status).json({ error: err.message, reason: err.reason });
  if (err instanceof StoreNotComputedError) return void res.status(503).json({ error: err.message, reason: "catalogue_economics_not_computed_yet" });
  if (err instanceof SalesPathNamePoolExhaustedError) return void res.status(502).json({ error: err.message, reason: "name_family_exhausted" });
  if ((err as { code?: string })?.code === "23505") return void res.status(409).json({ error: (err as Error).message, reason: "already_exists" });
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
  id: p.id,
  name,
  icon: FAMILY_GLYPHS.pipe,
  color: glyphColorOf(name),
  line: pipeLine(m, p),
  mode: p.mode,
  ...econWire(p.economics, perStep(m, p.toStep)),
  runnable: pipeRunnable(p),
  ...(p.published ? {} : { draft: true }),
});

/** A reactive funnel's trigger in customer words (`lib/funnel-descriptions.ts`); null on a proactive one. */
const funnelCopy = (model: CatalogueModel, f: CatalogueFunnel) => ({ triggerLabel: funnelTriggerLabel(f, (k) => stepLabel(model, k)), trigger: funnelTrigger(model, f) });

const funnelRowOf = (f: CatalogueFunnel, name: string, copy: ReturnType<typeof funnelCopy>) => ({
  id: f.id,
  name,
  face: faceOf(name).svgPath,
  line: funnelLine(f),
  ...copy,
  type: funnelTypeOf(f),
  ...econWire(f.economics, PER_PAYING_CLIENT),
  runnable: funnelRunnable(f),
  mixed: funnelMixed(f),
  ...(funnelPublished(f) ? {} : { draft: true }),
});

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────

router.get("/internal/catalogue/steps", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const { model } = await loadModel();
    const rows = [...model.steps.values()]
      .filter((s) => matchesQuery(q, [s.label, s.key, s.shortDescription, s.description, s.producedBy]))
      .map((s) => ({ s, e: stepEconomics(model, s.key) }))
      .sort((a, b) => (b.s.valueUsd ?? -1) - (a.s.valueUsd ?? -1) || a.s.key.localeCompare(b.s.key))
      .map(({ s, e }) => ({ id: s.key, name: s.label, icon: s.icon, line: s.shortDescription, valueUsd: s.valueUsd, ...econWire(e, perStep(model, s.key)), ...(s.declared ? { declared: true } : {}) }));
    res.json({ object: "step", costUnit: "per_outcome", order: "value_desc", ...page(rows, limit) });
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
      icon: s.icon,
      description: s.description,
      line: s.shortDescription,
      declared: s.declared,
      producedBy: s.producedBy,
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
    const { model, names } = await loadModel();
    let contains: string[] | null = null;
    if (containsRaw) {
      contains = containsRaw.map((raw) => {
        const key = resolveStep(model, raw);
        if (!key) throw new BadQuery("step_not_found", `no step ${raw}`);
        return key;
      });
    }
    const candidates = [...model.paths.values()]
      .filter((p) => !contains || p.steps.some((s) => contains!.includes(s)))
      .filter((p) => !runnable || pathRunnable(model, p))
      .filter((p) => matchesQuery(q, [pathLine(model, p), names.get(salesPathNameKeyOf(p.id)), p.id]))
      .map((p) => ({ p, e: pathEconomics(model, p) }))
      .sort(byRoi((x) => x.e, (x) => x.p.id, (x) => x.p.type));
    const shown = candidates.slice(0, limit);
    const n = await named(shown.map((x) => salesPathNameKeyOf(x.p.id)), names);
    const rows = candidates.map((x, i) => (i < limit ? pathRowOf(model, x.p, n.get(salesPathNameKeyOf(x.p.id))!) : null)).filter(Boolean);
    res.json({ object: "sales_path", costUnit: "per_paying_client", order: "roi_desc", total: candidates.length, truncated: candidates.length > limit, rows });
  } catch (err) {
    fail(res, err, "list sales paths");
  }
});

router.get("/internal/catalogue/sales-paths/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model, names } = await loadModel();
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
    draft: !p.published,
    ...econDetail(p.economics, perStep(model, p.toStep)),
    costUnit: "per_outcome",
    toStepValueUsd: to?.valueUsd ?? null,
    bestWorkflowSlug: p.measurement?.workflowDynastySlug ?? null,
    measuredBasis: p.measurement?.basis ?? null,
    conversionRatePct: p.measurement?.conversionRatePct ?? null,
  };
}

router.get("/internal/catalogue/pipes/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model, names } = await loadModel();
    const p = model.pipes.get(req.params.id);
    if (!p) return void res.status(404).json({ error: `no pipe ${req.params.id}`, reason: "pipe_not_found" });
    const n = await named([nameKeyOfPipe(p)], names);
    res.json(pipeDetail(model, p, n.get(nameKeyOfPipe(p))!));
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
    const candidates = onPaths
      .flatMap((p) => funnelsOfPath(model, p))
      .filter((f) => !containsChannels || f.channelSlugs.some((s) => containsChannels.includes(s)))
      .filter((f) => !runnable || funnelRunnable(f))
      .filter((f) => matchesQuery(q, [funnelLine(f), names.get(f.id), f.id]))
      .sort(byRoi((f: CatalogueFunnel) => f.economics, (f) => f.id, (f) => funnelTypeOf(f)));
    const shown = candidates.slice(0, limit);
    const n = await named(shown.map((f) => f.id), names);
    res.json({
      object: "sales_funnel",
      costUnit: "per_paying_client",
      order: "roi_desc",
      total: candidates.length,
      truncated: candidates.length > limit,
      rows: shown.map((f) => funnelRowOf(f, n.get(f.id)!, funnelCopy(model, f))),
      ...(offer ? { offer: offerEcho(offer) } : {}),
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
      // Every leg a channel (owner 2026-10-11). The sourcing leg holds several (its pool, `pipe` null there).
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
    costUnit: "per_paying_client",
    lifetimeRevenueUsd: model.lifetimeRevenueUsd,
    lifetimeRevenueSource: offer ? offer.lifetimeRevenueSource : "fleet_median_stated",
    ...(offer ? { offer: offerEcho(offer) } : {}),
    runnable: funnelRunnable(f),
  mixed: funnelMixed(f),
    draft: !funnelPublished(f),
  };
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
  // The value the pipe ADDS per outcome (`valueAddedTo`, `lib/value-added.ts`), every workflow on it alike.
  const value = valueAddedTo((st) => model.steps.get(st)?.valueUsd ?? null, pipe.fromStep, pipe.toStep);
  return ranking.rows.map((r) => {
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

router.get("/internal/catalogue/workflows", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const pipeId = typeof req.query.pipe === "string" ? req.query.pipe.replace(/ /g, "+") : null;
    if (!pipeId) throw new BadQuery("pipe_required", "pipe is required (a pipe id, `<channel slug>|<leg key>`)");
    const { model } = await loadModel();
    const pipe = model.pipes.get(pipeId);
    if (!pipe) return void res.status(404).json({ error: `no pipe ${pipeId}`, reason: "pipe_not_found" });
    const rows = pipe.operatedBy === "customer" ? [] : await workflowRows(model, pipe);
    if (rows === null) return void res.status(503).json({ error: `the workflow ranking of ${pipeId} is not computed yet`, reason: "workflow_ranking_not_computed_yet" });
    const listed = rows
      .filter((x) => matchesQuery(q, [x.name, x.r.workflowDynastySlug]))
      .map((x) => ({
        id: x.r.workflowDynastySlug,
        name: x.name,
        icon: FAMILY_GLYPHS.workflow,
        color: glyphColorOf(x.name),
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
    const { model } = await loadModel();
    const pipe = model.pipes.get(pipeId);
    if (!pipe) return void res.status(404).json({ error: `no pipe ${pipeId}`, reason: "pipe_not_found" });
    const rows = await workflowRows(model, pipe);
    if (rows === null) return void res.status(503).json({ error: `the workflow ranking of ${pipeId} is not computed yet`, reason: "workflow_ranking_not_computed_yet" });
    const x = rows.find((w) => w.r.workflowDynastySlug === req.params.id);
    if (!x) return void res.status(404).json({ error: `no workflow ${req.params.id} on ${pipeId}`, reason: "workflow_not_found" });
    res.json({
      object: "workflow",
      id: x.r.workflowDynastySlug,
      name: x.name,
      icon: FAMILY_GLYPHS.workflow,
      color: glyphColorOf(x.name),
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
    });
  } catch (err) {
    fail(res, err, "get workflow");
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

function ratePct(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100) throw bad(`${field}_invalid`, `${field} must be a percentage in (0, 100]`);
  return raw;
}

router.post("/internal/catalogue/steps", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
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
    const created = await insertStep({
      key,
      label,
      description: text(body, "description", 500),
      shortDescription: text(body, "shortDescription", 80),
      icon,
      towardStep,
      towardRatePct,
      producedBy,
      createdBy,
      requestedByOrgId,
    });
    await registerStepDeclarations();
    invalidateChannelCatalogue();
    console.log(`[features-service] agent catalogue: step ${key} declared by ${createdBy} (toward ${towardStep} at ${towardRatePct}%)`);
    const { model } = await loadModel();
    const s = model.steps.get(created.key)!;
    res.status(201).json({ object: "step", id: s.key, name: s.label, icon: s.icon, line: s.shortDescription, valueUsd: s.valueUsd, declared: true, producedBy: s.producedBy });
  } catch (err) {
    fail(res, err, "create step");
  }
});

router.post("/internal/catalogue/pipes", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    if (typeof body.channelSlug !== "string") throw bad("channel_slug_required", "channelSlug is required");
    await registerStepDeclarations();
    const [cat, triggers] = await Promise.all([loadChannelCatalogue({ publishedOnly: false }), listTriggerTypes()]);
    const channel = cat.channels.find((c) => c.slug === body.channelSlug);
    const declaredChannel = cat.declared.channels.find((c) => c.slug === body.channelSlug);
    if (!channel && !declaredChannel) return void res.status(404).json({ error: `no channel ${body.channelSlug}`, reason: "channel_not_found" });
    const slug = (channel?.slug ?? declaredChannel?.slug)!;
    const input = parseLegInput(body, { slug, managed: channel?.managed ?? false, legKeys: new Set((channel?.stepTransitions ?? []).map((t) => t.legKey)) }, triggers);
    // A leg out of a real step converts at a rate: the fleet's or the seeded default, else the caller states it.
    let statedRate: number | null = null;
    if (input.fromStep !== null && input.fromStep !== "lead_found" && legRateOf(new Map(), input.fromStep, input.toStep).ratePct === null) {
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

router.post("/internal/catalogue/sales-paths", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const raw = body.legKeys;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((l) => typeof l !== "string")) throw bad("leg_keys_required", "legKeys is required: the legs in order, each a leg some pipe performs");
    const { model, names } = await loadModel();
    const path = pathById(model, pathIdOf(raw as string[]));
    if (!path) {
      throw bad("path_invalid", `${pathIdOf(raw as string[])} is not a sales path: the legs must chain from Start (a leg from nothing) to paid_client, or from a trigger step through a reactive pipe (a reactive path), each performed by a channel (GET /internal/catalogue/pipes)`);
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
      throw bad("pipe_ids_required", "pipeIds is required: one pipe id per leg of a sales path, in order (the sourcing leg may name several, or none: a funnel holds every source)");
    }
    // EVERY LEG A CHANNEL (owner 2026-10-11): a leg is named by the pipe working it, never bare. A leg the customer's
    // own team works is its `Your Team` pipe.
    const bare = (raw as string[]).findIndex((entry) => !entry.includes("|"));
    if (bare >= 0) {
      throw bad("bare_leg_refused", `pipeIds[${bare}]: ${raw[bare]} is a leg, not a pipe. Every leg is worked by a channel: name its pipe (GET /internal/catalogue/pipes?legKeys=${raw[bare]}), a Your Team pipe when the customer's own team works it`);
    }
    const { model, names } = await loadModel();
    const picked = (raw as string[]).map((entry, i) => {
      const p = model.pipes.get(entry);
      if (!p) throw new DeclarationError(404, "pipe_not_found", `pipeIds[${i}]: no pipe ${entry}`);
      return p;
    });
    // The sourcing pool is every source on the leg, whatever the caller named (`funnelIdOf` leaves it out).
    const legs: FunnelLeg[] = picked.filter((p) => p.toStep !== SOURCED_STEP).map((p) => ({ legKey: p.legKey, pipe: p }));
    const funnel = legs.length > 0 ? funnelById(model, funnelIdOf(legs)) : null;
    if (!funnel) {
      throw bad("funnel_invalid", `${funnelIdOf(legs)} is no sales funnel: the pipes must work, in order, the legs of a sales path (GET /internal/catalogue/sales-paths)`);
    }
    const combinationKey = storedCombinationKeyOf(funnel.id);
    const existing = await listDeclaredSalesPaths();
    const declared = existing.some((d) => d.combinationKey === combinationKey);
    const existed = declared || names.has(funnel.id);
    if (!declared) {
      await insertSalesPath(
        combinationKey,
        funnel.legs.filter((l) => !l.pool).map((l) => ({ channelSlug: l.pipe?.channelSlug ?? null, legKey: l.pipe?.computedLegKey ?? l.legKey })),
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

// ── Step vocabulary (public: the customer dashboard's Outcomes icons) ──────────────────────────────

/**
 * Every catalogue step's key, name and Phosphor icon, nothing economic (owner 2026-10-11: the
 * customer's Outcomes entries wear the icon the staff Steps section shows). Built on the same model
 * as `GET /internal/catalogue/steps` without the measurements (icon and name never depend on them),
 * so each row is byte-equal to the staff read's `id`/`name`/`icon` for that step.
 */
router.get("/public/catalogue/steps", async (_req, res) => {
  try {
    const [all, pub, declaredSteps] = await Promise.all([
      loadChannelCatalogue({ publishedOnly: false }),
      loadChannelCatalogue({ publishedOnly: true }),
      listDeclaredSteps(),
    ]);
    const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
    const model = buildCatalogueModel({ channels: all.channels, publishedPipeIds, declaredSteps, measurements: new Map(), fleetMedians: new Map(), lifetimeRevenueUsd: null });
    const rows = [...model.steps.values()].sort((a, b) => a.key.localeCompare(b.key)).map((s) => ({ key: s.key, name: s.label, icon: s.icon }));
    res.set("Cache-Control", "public, max-age=300").json({ object: "step", total: rows.length, rows });
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
  path: FunnelPathView;
  /** The step the funnel's first leg starts from (null = from nothing): where a campaign on it takes people over
   *  unless one of its own units produces that step (`lib/value-added.ts`). */
  firstStep: string | null;
}

/**
 * A funnel's PATH as the dashboard draws it (owner 2026-10-11): `items` in reading order, a step, then the channel(s)
 * working the leg, then the leg's next step, and so on to Paid client. A proactive funnel starts at Start ("Start ->
 * Apollo Cold Filters + LinkedIn Engagement -> Lead found -> Sales Cold Email Outreach -> Positive reply -> Your Team
 * Closing Calls -> Paid client"); a reactive one with its TRIGGER item (`kind: "trigger"`, unique slug + name, "Positive
 * Reply") in place of its trigger step. EVERY two steps have at least one channel
 * between them ("il faut que tu fasses apparaître tous les channels utilisés entre chaque leg"), `runByUs` false on
 * the customer's own team's. The sourcing leg lists the campaign's own sources when `sourceSlugs` names some, else
 * every runnable source. `legs` states the same per leg, structured.
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
    /** The leg's one channel; null on the sourcing leg, which `channels` lists (several). */
    channelSlug: string | null;
    channelName: string | null;
    channels: Array<{ slug: string; name: string; runByUs: boolean }>;
  }>;
}

const START_STEP = { kind: "step" as const, key: "start", label: "Start" };

/** PURE: the path view of a funnel. `sourceSlugs` = the sources a campaign on it runs (its sourcing leg shows those). */
export function funnelPathView(model: CatalogueModel, f: CatalogueFunnel, sourceSlugs: readonly string[] = []): FunnelPathView {
  const step = (key: string | null) => (key === null ? START_STEP : { kind: "step" as const, key, label: stepLabel(model, key) });
  const items: FunnelPathView["items"] = [];
  const trigger = funnelTrigger(model, f);
  const legs: FunnelPathView["legs"] = f.legs.map((l, i) => {
    const { fromStep, toStep } = legStepsOf(model, l.legKey);
    if (i === 0) items.push(trigger ? { kind: "trigger", ...trigger } : step(fromStep));
    let pipes = legPipes(l);
    if (l.pool) {
      const own = pipes.filter((p) => sourceSlugs.includes(p.channelSlug));
      pipes = own.length > 0 ? own : pipes.filter(pipeRunnable);
    }
    const channels = pipes.map((p) => ({ slug: p.channelSlug, name: p.channelName, runByUs: p.operatedBy === "platform" }));
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

export async function funnelCopiesFor(ids: readonly string[]): Promise<{
  copies: Map<string, FunnelCopy | null>;
  pipeSteps: Map<string, { fromStep: string | null; toStep: string }>;
  /** A funnel campaign's path: its funnel's, its sourcing leg showing the sources the campaign runs. */
  pathOf: (id: string, sourceSlugs: readonly string[]) => FunnelPathView | null;
}> {
  const [all, pub, declaredSteps, names, triggers] = await Promise.all([
    loadChannelCatalogue({ publishedOnly: false }),
    loadChannelCatalogue({ publishedOnly: true }),
    listDeclaredSteps(),
    allNamesByKey(),
    listTriggerTypes(),
  ]);
  const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
  const model = buildCatalogueModel({ channels: all.channels, publishedPipeIds, declaredSteps, measurements: new Map(), fleetMedians: new Map(), lifetimeRevenueUsd: null, triggers });
  const found = new Map(ids.flatMap((id) => {
    const f = funnelById(model, id);
    return f ? [[id, f] as const] : [];
  }));
  const out = new Map<string, FunnelCopy | null>(ids.map((id) => [id, null]));
  for (const [id, f] of found) {
    const name = names.get(f.id) ?? null;
    out.set(id, { name, face: name ? faceOf(name).svgPath : null, type: funnelTypeOf(f), triggerLabel: funnelTriggerLabel(f, (k) => stepLabel(model, k)), path: funnelPathView(model, f), firstStep: funnelFirstStep(f.legs) });
  }
  // Every pipe's steps, so a caller knows which step each of a campaign's units produces (`lib/value-added.ts`).
  const pipeSteps = new Map([...model.pipes.values()].map((p) => [p.id, { fromStep: p.fromStep, toStep: p.toStep }] as const));
  const pathOf = (id: string, sourceSlugs: readonly string[]) => {
    const f = found.get(id);
    return f ? funnelPathView(model, f, sourceSlugs) : null;
  };
  return { copies: out, pipeSteps, pathOf };
}

export default router;
