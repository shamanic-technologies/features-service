import { Router, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import type { PublicChannel } from "../lib/channel-catalogue.js";
import {
  actorOf,
  checkLegRun,
  DeclarationError,
  legPricingOf,
  parseChannelInput,
  parseChannelPatch,
  parseLegInput,
  parseSalesPathInput,
  parseTriggerInput,
  parseTriggerPatch,
  requestedByOrgIdOf,
  isTriggerCoded,
  type DeclaredChannel,
  type DeclaredLeg,
  type DeclaredSalesPath,
  type LegPricing,
  type TriggerTypeRecord,
} from "../lib/channel-declarations.js";
import {
  insertChannel,
  insertLeg,
  insertSalesPath,
  insertTrigger,
  listDeclaredSalesPaths,
  listTriggerTypes,
  loadChannelCatalogue,
  takenChannelIdentities,
  updateChannel,
  updateLeg,
  updateTrigger,
  type LoadedCatalogue,
} from "../lib/channel-declarations-store.js";
import { combinationKeyOf } from "../lib/offer-sales-paths.js";
import { salesPathNamesFor } from "../lib/sales-path-names.js";
import { isOutboundChannel } from "../lib/channel-types.js";
import { storedCombinationKeyOf, storedLegKeyOf } from "../lib/funnel-legs.js";
import { invalidateChannelCatalogue } from "./public.js";

/**
 * RUN-TIME DECLARATIONS (`lib/channel-declarations.ts`, owner 2026-10-09): channels, legs on a channel,
 * trigger types and sales paths created as DATA by a staff caller (the dashboard Copilot through the
 * gateway). Service-key only: a channel is shared by every client. Every write records `createdBy` /
 * `updatedBy` and the optional `requestedByOrgId`. A declared channel or leg reaches a client read
 * (`/public/channels`, `/offers/:id/sales-paths`) only once published.
 */
const router = Router();

type Body = Record<string, unknown>;

interface LegView {
  legKey: string;
  fromStep: string | null;
  toStep: string;
  mode: string;
  triggerId: string | null;
  /** Created at run time (vs stated in code). */
  declared: boolean;
  published: boolean;
  /** Served to clients now: the leg AND its channel are published. */
  visibleToClients: boolean;
  pricing: LegPricing;
}

interface ChannelView {
  slug: string;
  name: string;
  declared: boolean;
  published: boolean;
  /** Served to clients now (published, and performs at least one published leg). */
  visibleToClients: boolean;
  /** The stored declaration; null on a channel stated in code. */
  declaration: DeclaredChannel | null;
  /** The catalogue entry as built from every leg (published or not); null while a declared channel performs no leg. */
  channel: PublicChannel | null;
  legs: LegView[];
}

function channelViews(cat: LoadedCatalogue, publicSlugs: ReadonlySet<string>, publicLegs: ReadonlySet<string>): ChannelView[] {
  const declaredBySlug = new Map(cat.declared.channels.map((c) => [c.slug, c]));
  const declaredLegs = new Map(cat.declared.legs.map((l) => [`${l.channelSlug}|${l.legKey}`, l]));
  const views: ChannelView[] = cat.channels.map((c) => {
    const declaration = declaredBySlug.get(c.slug) ?? null;
    const published = declaration ? declaration.published : true;
    const legs = c.stepTransitions.map((t): LegView => {
      const d = declaredLegs.get(`${c.slug}|${t.legKey}`);
      return {
        legKey: t.legKey,
        fromStep: t.from?.key ?? null,
        toStep: t.to.key,
        mode: t.mode,
        triggerId: t.triggerId,
        declared: d !== undefined,
        published: d ? d.published : published,
        visibleToClients: publicLegs.has(`${c.slug}|${t.legKey}`),
        pricing: legPricingOf(c, t.legKey),
      };
    });
    return { slug: c.slug, name: c.name, declared: declaration !== null, published, visibleToClients: publicSlugs.has(c.slug), declaration, channel: c, legs };
  });
  // A declared channel performing no leg yet is not in the catalogue: still listed, with no legs.
  for (const d of cat.declared.channels) {
    if (!views.some((v) => v.slug === d.slug)) {
      views.push({ slug: d.slug, name: d.name, declared: true, published: d.published, visibleToClients: false, declaration: d, channel: null, legs: [] });
    }
  }
  return views;
}

async function loadViews(): Promise<{ views: ChannelView[]; cat: LoadedCatalogue }> {
  const [cat, pub] = await Promise.all([loadChannelCatalogue({ publishedOnly: false }), loadChannelCatalogue({ publishedOnly: true })]);
  const publicSlugs = new Set(pub.channels.map((c) => c.slug));
  const publicLegs = new Set(pub.channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${t.legKey}`)));
  return { views: channelViews(cat, publicSlugs, publicLegs), cat };
}

async function channelView(slug: string): Promise<ChannelView | null> {
  return (await loadViews()).views.find((v) => v.slug === slug) ?? null;
}

const triggerView = (t: TriggerTypeRecord) => ({ ...t, coded: isTriggerCoded(t) });

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof DeclarationError) {
    res.status(err.status).json({ error: err.message, reason: err.reason });
    return;
  }
  // A unique violation raced past the pre-check (two writes of the same slug/id/name at once).
  if ((err as { code?: string })?.code === "23505") {
    res.status(409).json({ error: (err as Error).message, reason: "already_exists" });
    return;
  }
  console.error(`[features-service] declarations: ${what} failed:`, err);
  res.status(500).json({ error: "Internal server error" });
}

// ── Channels ────────────────────────────────────────────────────────────────────────────────────────

router.get("/internal/declarations/channels", apiKeyOnly, async (_req, res) => {
  try {
    res.json({ channels: (await loadViews()).views });
  } catch (err) {
    fail(res, err, "list channels");
  }
});

router.get("/internal/declarations/channels/:slug", apiKeyOnly, async (req, res) => {
  try {
    const view = await channelView(req.params.slug);
    if (!view) return void res.status(404).json({ error: `no channel ${req.params.slug}`, reason: "channel_not_found" });
    res.json(view);
  } catch (err) {
    fail(res, err, "get channel");
  }
});

router.post("/internal/declarations/channels", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const taken = await takenChannelIdentities();
    const input = parseChannelInput(body, taken.slugs, taken.names);
    await insertChannel(input, createdBy, requestedByOrgId);
    console.log(`[features-service] declarations: channel ${input.slug} declared by ${createdBy}`);
    res.status(201).json(await channelView(input.slug));
  } catch (err) {
    fail(res, err, "create channel");
  }
});

router.patch("/internal/declarations/channels/:slug", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const updatedBy = actorOf(body, "updatedBy");
    const { views } = await loadViews();
    const view = views.find((v) => v.slug === req.params.slug);
    if (!view) return void res.status(404).json({ error: `no channel ${req.params.slug}`, reason: "channel_not_found" });
    if (!view.declaration) {
      return void res.status(409).json({ error: `${view.slug} is stated in code (src/seed/features.ts): change it there`, reason: "channel_coded" });
    }
    const taken = await takenChannelIdentities();
    const patch = parseChannelPatch(body, view.declaration, taken.names);
    await updateChannel(view.slug, patch, updatedBy, view.declaration);
    invalidateChannelCatalogue();
    console.log(`[features-service] declarations: channel ${view.slug} updated by ${updatedBy}: ${Object.keys(patch).join(", ")}`);
    res.json(await channelView(view.slug));
  } catch (err) {
    fail(res, err, "update channel");
  }
});

// ── Legs ────────────────────────────────────────────────────────────────────────────────────────────

router.get("/internal/declarations/legs", apiKeyOnly, async (req, res) => {
  const channelSlug = typeof req.query.channelSlug === "string" ? req.query.channelSlug : undefined;
  try {
    const { views } = await loadViews();
    res.json({
      legs: views.filter((v) => !channelSlug || v.slug === channelSlug).flatMap((v) => v.legs.map((l) => ({ channelSlug: v.slug, channelName: v.name, ...l }))),
    });
  } catch (err) {
    fail(res, err, "list legs");
  }
});

router.post("/internal/declarations/channels/:slug/legs", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const [{ views }, triggers] = await Promise.all([loadViews(), listTriggerTypes()]);
    const view = views.find((v) => v.slug === req.params.slug);
    if (!view) return void res.status(404).json({ error: `no channel ${req.params.slug}`, reason: "channel_not_found" });
    const input = parseLegInput(body, { slug: view.slug, managed: view.channel?.managed ?? false, legKeys: new Set(view.legs.map((l) => l.legKey)) }, triggers);
    await insertLeg(view.slug, input, createdBy, requestedByOrgId);
    console.log(`[features-service] declarations: leg ${view.slug} ${input.legKey} (${input.mode}${input.triggerId ? ` on ${input.triggerId}` : ""}) declared by ${createdBy}`);
    const after = await channelView(view.slug);
    res.status(201).json({ leg: after?.legs.find((l) => l.legKey === input.legKey) ?? null, channel: after });
  } catch (err) {
    fail(res, err, "create leg");
  }
});

router.patch("/internal/declarations/channels/:slug/legs/:legKey", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const updatedBy = actorOf(body, "updatedBy");
    const [{ views, cat }, triggers] = await Promise.all([loadViews(), listTriggerTypes()]);
    const view = views.find((v) => v.slug === req.params.slug);
    if (!view) return void res.status(404).json({ error: `no channel ${req.params.slug}`, reason: "channel_not_found" });
    const legKey = isOutboundChannel(view.slug) ? storedLegKeyOf(req.params.legKey) : req.params.legKey;
    const leg = view.legs.find((l) => l.legKey === legKey);
    if (!leg) return void res.status(404).json({ error: `${view.slug} performs no leg ${req.params.legKey}`, reason: "leg_not_found" });
    const stored: DeclaredLeg | undefined = cat.declared.legs.find((l) => l.channelSlug === view.slug && l.legKey === legKey);
    if (!stored) return void res.status(409).json({ error: `${view.slug} ${legKey} is stated in code: change it there`, reason: "leg_coded" });
    for (const frozen of ["fromStep", "toStep", "legKey"]) {
      if (body[frozen] !== undefined) throw new DeclarationError(400, "field_immutable", `${frozen} cannot change: declare a new leg instead`);
    }
    const patch: Partial<Pick<DeclaredLeg, "published" | "mode" | "triggerId">> = {};
    if (body.published !== undefined) {
      if (typeof body.published !== "boolean") throw new DeclarationError(400, "published_invalid", "published must be a boolean");
      patch.published = body.published;
    }
    if (body.mode !== undefined || body.triggerId !== undefined) {
      // The guarantee re-runs on every change of how the leg runs.
      Object.assign(patch, checkLegRun(body.mode ?? stored.mode, body.triggerId === undefined ? stored.triggerId : body.triggerId, triggers));
    }
    if (Object.keys(patch).length === 0) throw new DeclarationError(400, "nothing_to_update", "the body changes nothing");
    await updateLeg(view.slug, legKey, patch);
    invalidateChannelCatalogue();
    console.log(`[features-service] declarations: leg ${view.slug} ${legKey} updated by ${updatedBy}: ${Object.keys(patch).join(", ")}`);
    const after = await channelView(view.slug);
    res.json({ leg: after?.legs.find((l) => l.legKey === legKey) ?? null, channel: after });
  } catch (err) {
    fail(res, err, "update leg");
  }
});

// ── Trigger types ───────────────────────────────────────────────────────────────────────────────────

router.get("/internal/declarations/trigger-types", apiKeyOnly, async (_req, res) => {
  try {
    res.json({ triggerTypes: (await listTriggerTypes()).map(triggerView) });
  } catch (err) {
    fail(res, err, "list trigger types");
  }
});

router.get("/internal/declarations/trigger-types/:id", apiKeyOnly, async (req, res) => {
  try {
    const t = (await listTriggerTypes()).find((x) => x.id === req.params.id);
    if (!t) return void res.status(404).json({ error: `no trigger type ${req.params.id}`, reason: "trigger_not_found" });
    res.json(triggerView(t));
  } catch (err) {
    fail(res, err, "get trigger type");
  }
});

router.post("/internal/declarations/trigger-types", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const input = parseTriggerInput(body, await listTriggerTypes());
    const created = await insertTrigger(input, createdBy, requestedByOrgId);
    invalidateChannelCatalogue();
    console.log(`[features-service] declarations: trigger type ${input.id} (${input.kind}) declared by ${createdBy}`);
    res.status(201).json(triggerView(created));
  } catch (err) {
    fail(res, err, "create trigger type");
  }
});

router.patch("/internal/declarations/trigger-types/:id", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const updatedBy = actorOf(body, "updatedBy");
    const current = (await listTriggerTypes()).find((x) => x.id === req.params.id);
    if (!current) return void res.status(404).json({ error: `no trigger type ${req.params.id}`, reason: "trigger_not_found" });
    const updated = await updateTrigger(current.id, parseTriggerPatch(body, current));
    invalidateChannelCatalogue();
    console.log(`[features-service] declarations: trigger type ${current.id} updated by ${updatedBy}`);
    res.json(triggerView(updated));
  } catch (err) {
    fail(res, err, "update trigger type");
  }
});

// ── Sales paths ─────────────────────────────────────────────────────────────────────────────────────

async function salesPathViews(paths: readonly DeclaredSalesPath[]) {
  const [{ views }, names] = await Promise.all([loadViews(), salesPathNamesFor(paths.map((p) => p.combinationKey))]);
  return paths.map((p) => {
    const legs = p.legs.map((l) => {
      const channel = views.find((v) => v.slug === l.channelSlug);
      const leg = channel?.legs.find((x) => x.legKey === l.legKey);
      return { ...l, channelName: channel?.name ?? null, ...(leg ? { fromStep: leg.fromStep, toStep: leg.toStep, mode: leg.mode, triggerId: leg.triggerId, visibleToClients: leg.visibleToClients, pricing: leg.pricing } : { visibleToClients: false }) };
    });
    return { ...p, name: names.get(p.combinationKey) ?? null, visibleToClients: legs.every((l) => l.visibleToClients), legs };
  });
}

router.get("/internal/declarations/sales-paths", apiKeyOnly, async (_req, res) => {
  try {
    res.json({ salesPaths: await salesPathViews(await listDeclaredSalesPaths()) });
  } catch (err) {
    fail(res, err, "list sales paths");
  }
});

router.get("/internal/declarations/sales-paths/:combinationKey", apiKeyOnly, async (req, res) => {
  try {
    const key = storedCombinationKeyOf(req.params.combinationKey);
    const path = (await listDeclaredSalesPaths()).find((p) => p.combinationKey === key);
    if (!path) return void res.status(404).json({ error: `no declared sales path ${req.params.combinationKey}`, reason: "sales_path_not_found" });
    res.json((await salesPathViews([path]))[0]);
  } catch (err) {
    fail(res, err, "get sales path");
  }
});

router.post("/internal/declarations/sales-paths", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Body;
  try {
    const createdBy = actorOf(body);
    const requestedByOrgId = requestedByOrgIdOf(body);
    const [cat, existing] = await Promise.all([loadChannelCatalogue({ publishedOnly: false }), listDeclaredSalesPaths()]);
    const { combinationKey, legs } = parseSalesPathInput(body, cat.channels, combinationKeyOf);
    if (existing.some((p) => p.combinationKey === combinationKey)) {
      throw new DeclarationError(409, "sales_path_exists", `the sales path ${combinationKey} is already declared`);
    }
    const created = await insertSalesPath(combinationKey, legs, createdBy, requestedByOrgId);
    console.log(`[features-service] declarations: sales path ${combinationKey} declared by ${createdBy}`);
    res.status(201).json((await salesPathViews([created]))[0]);
  } catch (err) {
    fail(res, err, "create sales path");
  }
});

export default router;
