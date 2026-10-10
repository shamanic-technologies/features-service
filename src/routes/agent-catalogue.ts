import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import {
  buildCatalogueModel,
  byRoi,
  channelEconomics,
  FAMILY_GLYPHS,
  funnelById,
  funnelIdOf,
  funnelLine,
  outcomesNeededPerPayingClient,
  funnelsOfPath,
  glyphColorOf,
  legRateOf,
  matchesQuery,
  pathEconomics,
  pathIdOf,
  pathLine,
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
import { campaignNameKeyOf } from "../lib/offer-sales-paths.js";
import { getFleetArrowMedians, getFleetLifetimeRevenueMedian } from "../lib/effective-conversion-rates.js";
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
  await mapWithConcurrency(pipes, MEASUREMENT_CONCURRENCY, async (p) => {
    try {
      const price = await withTimeout(fleetLegPrice(p.slug, p.computedLegKey), MEASUREMENT_TIMEOUT_MS, `pipe ${p.id}`);
      byPipe.set(p.id, { basis: price.basis, costPerOutcomeUsd: price.costPerOutcomeUsd, conversionRatePct: price.conversionRatePct, workflowDynastySlug: price.workflowDynastySlug });
    } catch (error) {
      unreadable.add(p.id);
      console.error(`[features-service] agent catalogue: fleet measurement of pipe ${p.id} failed; it reads learning (measurement_unreadable):`, error);
    }
  });
  return { byPipe, unreadable, computedAt: new Date().toISOString() };
}

/** Rebuild in the background when absent or past its fresh window (single-flight). */
export function warmCatalogueMeasurements(): Promise<void> {
  if (measurementStore && Date.now() - measurementStore.at < MEASUREMENTS_FRESH_MS) return Promise.resolve();
  if (measurementWarm) return measurementWarm;
  measurementWarm = computeMeasurements()
    .then((value) => {
      measurementStore = { value, at: Date.now() };
    })
    .catch((error) => console.error("[features-service] agent catalogue measurements warm failed, keeping the previous value:", error))
    .finally(() => {
      measurementWarm = null;
    });
  return measurementWarm;
}

/** Test seams. */
export function __setCatalogueMeasurementsForTest(byPipe: Map<string, PipeMeasurement>): void {
  measurementStore = { value: { byPipe, unreadable: new Set(), computedAt: new Date(0).toISOString() }, at: Date.now() };
}
export function __resetCatalogueMeasurements(): void {
  measurementStore = null;
  measurementWarm = null;
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

async function loadModel(): Promise<Loaded> {
  void warmCatalogueMeasurements();
  const [measurements, all, pub, declaredSteps, medians, ltr, names] = await Promise.all([
    awaitWarmStore(() => measurementStore?.value ?? null, warmCatalogueMeasurements, MEASUREMENTS_BOOT_WAIT_MS, "catalogue economics"),
    loadChannelCatalogue({ publishedOnly: false }),
    loadChannelCatalogue({ publishedOnly: true }),
    listDeclaredSteps(),
    getFleetArrowMedians(),
    getFleetLifetimeRevenueMedian(),
    allNamesByKey(),
  ]);
  const publishedPipeIds = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => pipeIdOf(c.slug, servedPipeLegKey(c.slug, t.legKey)))));
  const model = buildCatalogueModel({
    channels: all.channels,
    publishedPipeIds,
    declaredSteps,
    measurements: measurements.byPipe,
    fleetMedians: medians,
    lifetimeRevenueUsd: ltr.usd,
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

/** A step named by key or label ("LinkedIn post", "linkedin_post", "Positive reply"). */
function resolveStep(model: CatalogueModel, raw: string): string | null {
  const key = matchChannelStepKey(raw);
  if (key && model.steps.has(key)) return key;
  const lower = raw.trim().toLowerCase();
  for (const s of model.steps.values()) if (s.label.toLowerCase() === lower || s.key === lower) return s.key;
  return null;
}

// ── Wire helpers ──────────────────────────────────────────────────────────────────────────────────

const econWire = (e: Economics) => ({ costUsd: e.costUsd, roi: e.roi, status: e.status });
const econDetail = (e: Economics) => ({ costUsd: e.costUsd, roi: e.roi, status: e.status, learningReason: e.reason });

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
  return { id: p.id, name, icon: FAMILY_GLYPHS.sales_path, color: glyphColorOf(name), line: pathLine(m, p), ...econWire(e) };
};

const pipeRowOf = (m: CatalogueModel, p: CataloguePipe, name: string) => ({
  id: p.id,
  name,
  icon: FAMILY_GLYPHS.pipe,
  color: glyphColorOf(name),
  line: pipeLine(m, p),
  mode: p.mode,
  ...econWire(p.economics),
  ...(p.published ? {} : { draft: true }),
});

const funnelRowOf = (f: CatalogueFunnel, name: string) => ({
  id: f.id,
  name,
  face: faceOf(name).svgPath,
  line: funnelLine(f),
  ...econWire(f.economics),
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
      .map(({ s, e }) => ({ id: s.key, name: s.label, icon: s.icon, line: s.shortDescription, valueUsd: s.valueUsd, ...econWire(e), ...(s.declared ? { declared: true } : {}) }));
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
      ...econDetail(stepEconomics(model, s.key)),
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
      .filter((p) => matchesQuery(q, [pathLine(model, p), names.get(salesPathNameKeyOf(p.id)), p.id]))
      .map((p) => ({ p, e: pathEconomics(model, p) }))
      .sort(byRoi((x) => x.e, (x) => x.p.id));
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
    const path = model.paths.get(req.params.id);
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
      steps: path.steps.map((s) => ({ id: s, name: stepLabel(model, s) })),
      legs: path.legKeys.map((legKey, i) => ({
        legKey,
        ratePct: path.rates[i].ratePct,
        rateSource: path.rates[i].source,
        pipeIds: [...model.pipes.values()].filter((p) => p.legKey === legKey).map((p) => p.id),
      })),
      ...econDetail(e),
      costUnit: "per_paying_client",
      bestSalesFunnelId: e.bestFunnelId,
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
    const { model } = await loadModel();
    let legs: Set<string> | null = null;
    if (forPaths) {
      legs = new Set();
      for (const id of forPaths) {
        const p = model.paths.get(id);
        if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
        p.legKeys.forEach((l) => legs!.add(l));
      }
    }
    if (legKeys) legs = legs ? new Set(legKeys.filter((l) => legs!.has(l))) : new Set(legKeys);
    const rows = model.channels
      .filter((c) => !legs || [...model.pipes.values()].some((p) => p.channelSlug === c.slug && legs!.has(p.legKey)))
      .filter((c) => matchesQuery(q, [c.name, c.slug, c.shortDescription, c.description, c.channelType]))
      .map((c) => ({ c, e: channelEconomics(model, c.slug, legs) }))
      .sort(byRoi((x) => x.e, (x) => x.c.slug))
      .map(({ c, e }) => ({ id: c.slug, name: c.name, icon: c.icon, line: c.shortDescription, ...econWire(e) }));
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
      icon: c.icon,
      line: c.shortDescription,
      description: c.description,
      channelType: c.channelType,
      operatedBy: c.operatedBy,
      performedBy: c.performedBy,
      managed: c.managed,
      ...econDetail(e),
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
    const { model, names } = await loadModel();
    let legs: Set<string> | null = legKeys ? new Set(legKeys) : null;
    if (paths) {
      const onPaths = new Set<string>();
      for (const id of paths) {
        const p = model.paths.get(id);
        if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
        p.legKeys.forEach((l) => onPaths.add(l));
      }
      legs = legs ? new Set([...legs].filter((l) => onPaths.has(l))) : onPaths;
    }
    const candidates = [...model.pipes.values()]
      .filter((p) => !legs || legs.has(p.legKey))
      .filter((p) => !channels || channels.includes(p.channelSlug))
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
    draft: !p.published,
    ...econDetail(p.economics),
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

router.get("/internal/catalogue/sales-funnels", apiKeyOnly, async (req, res) => {
  try {
    const limit = limitOf(req);
    const q = qOf(req);
    const paths = listOf(req, "paths");
    const containsChannels = listOf(req, "containsChannels");
    const { model, names } = await loadModel();
    const onPaths: CataloguePath[] = paths
      ? paths.map((id) => {
          const p = model.paths.get(id);
          if (!p) throw new BadQuery("sales_path_not_found", `no sales path ${id}`);
          return p;
        })
      : [...model.paths.values()];
    const candidates = onPaths
      .flatMap((p) => funnelsOfPath(model, p))
      .filter((f) => !containsChannels || f.channelSlugs.some((s) => containsChannels.includes(s)))
      .filter((f) => matchesQuery(q, [funnelLine(f), names.get(f.id), f.id]))
      .sort(byRoi((f) => f.economics, (f) => f.id));
    const shown = candidates.slice(0, limit);
    const n = await named(shown.map((f) => f.id), names);
    res.json({
      object: "sales_funnel",
      costUnit: "per_paying_client",
      order: "roi_desc",
      total: candidates.length,
      truncated: candidates.length > limit,
      rows: shown.map((f) => funnelRowOf(f, n.get(f.id)!)),
    });
  } catch (err) {
    fail(res, err, "list sales funnels");
  }
});

function funnelDetail(model: CatalogueModel, f: CatalogueFunnel, names: Map<string, string>) {
  const name = names.get(f.id)!;
  const path = model.paths.get(f.pathId)!;
  const needed = outcomesNeededPerPayingClient(path);
  return {
    object: "sales_funnel",
    id: f.id,
    name,
    face: faceOf(name),
    line: funnelLine(f),
    salesPathId: path.id,
    salesPathName: names.get(salesPathNameKeyOf(path.id)) ?? null,
    legs: f.legs.map((l, i) => ({
      legKey: l.legKey,
      ratePct: path.rates[i].ratePct,
      outcomesNeededPerPayingClient: needed[i],
      pipe: l.pipe
        ? { id: l.pipe.id, name: names.get(nameKeyOfPipe(l.pipe)) ?? null, line: pipeLine(model, l.pipe), mode: l.pipe.mode, ...econWire(l.pipe.economics) }
        : null,
    })),
    ...econDetail(f.economics),
    costUnit: "per_paying_client",
    lifetimeRevenueUsd: model.lifetimeRevenueUsd,
    draft: !funnelPublished(f),
  };
}

const funnelPublished = (f: CatalogueFunnel): boolean => f.legs.every((l) => !l.pipe || l.pipe.published);
const funnelPipes = (f: CatalogueFunnel): CataloguePipe[] => f.legs.flatMap((l) => (l.pipe ? [l.pipe] : []));

router.get("/internal/catalogue/sales-funnels/:id", apiKeyOnly, async (req, res) => {
  try {
    const { model, names } = await loadModel();
    const f = funnelById(model, req.params.id);
    if (!f) return void res.status(404).json({ error: `no sales funnel ${req.params.id}`, reason: "sales_funnel_not_found" });
    const n = await named([f.id, salesPathNameKeyOf(f.pathId), ...funnelPipes(f).map(nameKeyOfPipe)], names);
    res.json(funnelDetail(model, f, n));
  } catch (err) {
    fail(res, err, "get sales funnel");
  }
});

// ── Workflows (on one pipe) ───────────────────────────────────────────────────────────────────────

async function workflowRows(model: CatalogueModel, pipe: CataloguePipe) {
  const ranking = await readLegWorkflowRanking(pipe.channelSlug, pipe.computedLegKey);
  if (!ranking) return null;
  const value = model.steps.get(pipe.toStep)?.valueUsd ?? null;
  return ranking.rows.map((r) => {
    const name = r.workflowDynastyName ?? r.workflowDynastySlug;
    const mature = r.isMature === true && r.basis === "mature" && r.costPerOutcomeUsd !== null && r.costPerOutcomeUsd > 0;
    const e: Economics = mature
      ? { status: "measured", costUsd: Math.round(r.costPerOutcomeUsd! * 100) / 100, roi: value === null ? null : Math.round((value / r.costPerOutcomeUsd!) * 100) / 100, reason: null }
      : { status: "learning", costUsd: null, roi: null, reason: r.outcomes > 0 ? "not_mature_yet" : "no_outcome_yet" };
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
        ...econWire(x.e),
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
      ...econDetail(x.e),
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
    const legKeys = raw as string[];
    const id = pathIdOf(legKeys);
    const path = model.paths.get(id);
    if (!path) {
      throw bad("path_invalid", `${id} is not a sales path: the legs must chain from an entry leg (from nothing or from Lead found) to paid_client, each performed by a pipe (GET /internal/catalogue/pipes)`);
    }
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
      throw bad("pipe_ids_required", "pipeIds is required: one entry per leg of a sales path, in order: a pipe id, or the leg key of a leg no channel performs");
    }
    const { model, names } = await loadModel();
    const legs: FunnelLeg[] = (raw as string[]).map((entry, i) => {
      if (!entry.includes("|")) return { legKey: entry, pipe: null };
      const p = model.pipes.get(entry);
      if (!p) throw new DeclarationError(404, "pipe_not_found", `pipeIds[${i}]: no pipe ${entry}`);
      return { legKey: p.legKey, pipe: p };
    });
    const funnel = funnelById(model, funnelIdOf(legs));
    if (!funnel) {
      throw bad("funnel_invalid", `${funnelIdOf(legs)} is no sales funnel: the legs must form a sales path (GET /internal/catalogue/sales-paths) and a bare leg is only for a leg no channel performs`);
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
    res.status(existed ? 200 : 201).json({ created: !existed, ...funnelDetail(model, funnel, n) });
  } catch (err) {
    fail(res, err, "create sales funnel");
  }
});

// ── Faces (public: the dashboard shows the image) ─────────────────────────────────────────────────

router.get("/public/catalogue/faces/:file", (req, res) => {
  const m = /^(.{1,60})\.svg$/.exec(req.params.file);
  if (!m) return void res.status(400).json({ error: "the face path is /public/catalogue/faces/<name>.svg", reason: "face_path_invalid" });
  res.set("Content-Type", "image/svg+xml").set("Cache-Control", "public, max-age=86400").send(faceSvg(m[1]));
});

export default router;
