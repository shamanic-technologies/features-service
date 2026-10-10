/**
 * THE CATALOGUE AN AGENT WALKS, IN THE OWNER'S WORDS (owner 2026-10-10, "chat first"; binding vocabulary).
 *
 * A user tells the agent "post on LinkedIn every day"; the agent narrows, level by level:
 *   Steps -> Sales Paths -> Channels -> Pipes -> Sales Funnels -> Workflows (-> Campaigns, next).
 * Each level is a short list (id, name, one line, average cost, average ROI) the agent filters, then a
 * detail read per id. This module is the PURE model; `routes/agent-catalogue.ts` reads the inputs.
 *
 * ── THE VOCABULARY, MAPPED ON WHAT THIS SERVICE ALREADY SERVED ─────────────────────────────────────
 *
 *   STEP          a stage (`CHANNEL_STEPS`, + steps declared at run time). Id = the step key.
 *   PIPE          ONE channel x ONE leg. Was the "campaign" of `/public/channels`
 *                 `stepTransitions[].campaignName` and `/offers/:id/sales-paths` `campaigns[]`; its name is
 *                 the same stored row (`campaign:<slug>|<legKey>`). Id = `<channel slug>|<leg key>`.
 *   SALES PATH    a chain of legs ending on Paid client, with NO channel. Was `pathKey` on the offer read
 *                 (never named before). Id = its leg keys joined by `+`, in the served spelling.
 *   SALES FUNNEL  a sales path with ONE pipe per leg. Was the named "combination" of the offer read
 *                 (Victory, Sol...); same identity (`combinationKeyOf`, a platform leg `@<slug>`, a leg the
 *                 customer's own team works bare) and the same name. Campaign-service and billing-service
 *                 will key a campaign on this id.
 *   brand-service's "sales funnels" (`website_purchases`, `sales_meetings_from_reply`...) are a DIFFERENT,
 *   older thing (the declared funnels a brand sells through) and keep their name everywhere else.
 *
 * ── WHERE A PATH STARTS ─────────────────────────────────────────────────────────────────────────
 *
 * A path's first leg is an ENTRY leg: from nothing (an ad producing a website visit), or from Lead found (an
 * outbound channel working a found lead: Lead found -> Positive reply). The leg that FINDS the lead
 * (Start -> Lead found, a sourcing pipe) feeds every path starting on Lead found and is not itself a leg of
 * any path: that is how every funnel named before today is keyed (Victory starts on the cold-email leg), and
 * a name never moves. Sourcing pipes are listed as pipes.
 *
 * ── AVERAGE COST, ROI, LEARNING (fleet grain, no identity) ──────────────────────────────────────
 *
 *   value(Paid client)  = the fleet median lifetime revenue of an offer (`lib/offer-lifetime-revenue.ts`)
 *   value(step s)       = max over the legs s -> t of  rate(s -> t)/100 x value(t)
 *                         rate = fleet median of the stated rates (when >= MIN_FLEET_MEDIAN_BRANDS brands)
 *                         > seeded industry default (`lib/default-leg-rates.ts`, + declared leg rates);
 *                         an entry leg out of Lead found has no stated rate: the best MATURE pipe's measured
 *                         conversion (outcomes / people worked) prices it.
 *   PIPE   cost = the best workflow's MATURE fleet cost per outcome of the leg's step (`lib/maturity.ts`,
 *          the rule `/public/stats/outcome-prices` follows); roi = value(to step) / cost. A pipe with no
 *          mature workflow is `learning` (cost and roi null), a pipe the customer's own team works is
 *          `customer_time` (it costs us nothing; no roi).
 *   STEP   cost = the cheapest measured pipe producing it; roi = value / cost.
 *   CHANNEL cost and roi of its best measured pipe (highest roi).
 *   FUNNEL cost per paying client = sum over its platform pipes of cost x outcomes needed per paying client
 *          (needed(Paid client) = 1, needed(from) = needed(to) / rate); roi = value(Paid client) / that cost.
 *          `learning` as soon as one platform pipe or one rate is unmeasured, never a guessed figure.
 *   PATH   cost and roi of its best measured funnel; `learning` when none is measured.
 *   WORKFLOW (on one pipe) its own mature cost per outcome; roi = value(to step) / cost; else `learning`.
 *
 * Pure: no IO, no clock.
 */
import { CHANNEL_STEPS, isDeclaredStepKey, type ChannelStepKey } from "./acquisition-channels.js";
import type { PublicChannel } from "./channel-catalogue.js";
import { defaultLegRatePct } from "./default-leg-rates.js";
import { fleetMedianApplies, legPairKey, type FleetArrowMedians } from "./effective-conversion-rates.js";
import { FUNNEL_LEGS, servedLegKeyOf } from "./funnel-legs.js";
import { combinationKeyOf } from "./offer-sales-paths.js";
import { faceOf, stableHash, type Face } from "./catalogue-faces.js";

// ── Glyphs ────────────────────────────────────────────────────────────────────────────────────────

/** One Phosphor icon per family (the dashboard maps Phosphor names) + a colour derived from the name. */
export const FAMILY_GLYPHS = { step: null, sales_path: "waves", channel: null, pipe: "bird", sales_funnel: null, workflow: "flow-arrow" } as const;

const GLYPH_COLORS = ["#E0784B", "#8E6CD8", "#3FA27E", "#D6A21E", "#3D7FD0", "#D9577A", "#9C6B3E", "#5E9E3A", "#2F9DB3", "#C2563A"];

/** PURE: the colour a name shows its family glyph in (stable: a hash of the name). */
export const glyphColorOf = (name: string): string => GLYPH_COLORS[stableHash(name.toLowerCase()) % GLYPH_COLORS.length];

/**
 * The catalogue serves PHOSPHOR icon names only (owner 2026-10-10). Some channel seeds state an
 * icon in another set's spelling (`mail`, `share-2`, `mic`, ...), which `/public/channels` and
 * `/features` keep serving as stored; the catalogue translates them to the Phosphor name of the
 * same picture so a reader keys ONE vocabulary. A name not listed is already Phosphor.
 */
export const NON_PHOSPHOR_ICONS: Readonly<Record<string, string>> = {
  "at-sign": "at",
  award: "medal",
  contact: "address-book",
  facebook: "facebook-logo",
  filter: "funnel",
  "help-circle": "question",
  inbox: "tray",
  instagram: "instagram-logo",
  linkedin: "linkedin-logo",
  list: "list-bullets",
  mail: "envelope",
  "message-circle": "chat-circle",
  "message-square": "chat-text",
  mic: "microphone",
  radar: "target",
  search: "magnifying-glass",
  "share-2": "share-network",
  sparkles: "sparkle",
  "trending-up": "trend-up",
  youtube: "youtube-logo",
};

/** PURE: a stored icon name as the catalogue serves it (Phosphor). */
export const phosphorIconOf = (icon: string): string => NON_PHOSPHOR_ICONS[icon] ?? icon;

/** A step's Phosphor icon (a declared step states its own). */
export const STEP_ICONS: Readonly<Record<string, string>> = {
  lead_found: "user-focus",
  conversation: "chat-circle-text",
  website_visit: "cursor-click",
  booking_call: "phone-call",
  meeting_booked: "calendar-check",
  meeting_attended: "handshake",
  signup: "user-plus",
  form_submitted: "note-pencil",
  purchase: "shopping-cart",
  paid_client: "currency-dollar",
};

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────────

export interface DeclaredStepInput {
  key: string;
  label: string;
  description: string;
  shortDescription: string;
  icon: string;
  towardStep: string;
  towardRatePct: number;
  producedBy: string | null;
}

/** What the fleet measured for one pipe (the best workflow, `pickLegPrice`). Keyed by pipe id. */
export interface PipeMeasurement {
  /** `mature` = priced on mature evidence; `flash` = early figures only (not a price: `learning`). */
  basis: "mature" | "flash" | null;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
  workflowDynastySlug: string | null;
}

export interface CatalogueInputs {
  /** Every channel, published or not (`loadChannelCatalogue({publishedOnly:false})`). */
  channels: readonly PublicChannel[];
  /** Pipe ids a client read shows (published channel AND leg). Others are listed with `draft: true`. */
  publishedPipeIds: ReadonlySet<string>;
  declaredSteps: readonly DeclaredStepInput[];
  /** Pipe id -> fleet measurement. Absent = nothing measured. */
  measurements: ReadonlyMap<string, PipeMeasurement>;
  fleetMedians: FleetArrowMedians;
  /** The fleet median lifetime revenue of an offer, USD. Null = nothing anywhere states one. */
  lifetimeRevenueUsd: number | null;
}

// ── Model ─────────────────────────────────────────────────────────────────────────────────────────

export type EconomicsStatus = "measured" | "learning" | "customer_time";

export interface Economics {
  status: EconomicsStatus;
  costUsd: number | null;
  roi: number | null;
  /** Why it is `learning` (detail reads). Null when measured. */
  reason: string | null;
}

export interface CatalogueStep {
  key: string;
  label: string;
  description: string;
  shortDescription: string;
  icon: string;
  declared: boolean;
  /** What reaching the step is worth on the way to a paid client, USD (fleet). Null when no route to Paid client is rated. */
  valueUsd: number | null;
  /** Where its value comes from: the best next step and its rate. Null on Paid client and when unvalued. */
  valueVia: { toStep: string; ratePct: number } | null;
  producedBy: string | null;
}

export interface CataloguePipe {
  id: string;
  channelSlug: string;
  channelName: string;
  /** The leg in its served spelling (an outbound channel's entry leg reads `lead_found_to_*`). */
  legKey: string;
  /** The leg as computed on (`start_to_*` for an outbound entry leg): what campaign-service and the ladders key on. */
  computedLegKey: string;
  fromStep: string | null;
  toStep: string;
  mode: "proactive" | "reactive";
  triggerId: string | null;
  operatedBy: "platform" | "customer";
  managed: boolean;
  published: boolean;
  economics: Economics;
  measurement: PipeMeasurement | null;
}

export interface CataloguePath {
  id: string;
  legKeys: string[];
  steps: string[];
  /** The rate of each leg (null on an entry leg out of nothing). */
  rates: Array<{ legKey: string; ratePct: number | null; source: "fleet_median" | "default" | "measured_pipe" | null }>;
}

/** One leg of a funnel: the pipe working it, or null when no channel performs the leg (the buyer or the
 *  customer's team does it with nothing of ours on it: a visitor signing up). */
export interface FunnelLeg {
  legKey: string;
  pipe: CataloguePipe | null;
}

export interface CatalogueFunnel {
  id: string;
  pathId: string;
  legs: FunnelLeg[];
  channelSlugs: string[];
  economics: Economics;
}

export interface CatalogueModel {
  steps: Map<string, CatalogueStep>;
  pipes: Map<string, CataloguePipe>;
  paths: Map<string, CataloguePath>;
  lifetimeRevenueUsd: number | null;
  channels: readonly PublicChannel[];
}

export const pipeIdOf = (channelSlug: string, servedLegKey: string): string => `${channelSlug}|${servedLegKey}`;
export const pathIdOf = (legKeys: readonly string[]): string => legKeys.join("+");
/** The stored name key of a sales path (`lib/catalogue-names.ts` family `sales_path`). */
export const salesPathNameKeyOf = (pathId: string): string => `path:${pathId}`;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const LEARNING = (reason: string): Economics => ({ status: "learning", costUsd: null, roi: null, reason });

const ENTRY_FROM = (from: string | null): boolean => from === null || from === "lead_found";

/** PURE: every pipe of the catalogue, with its fleet economics. `valueOf` prices the roi. */
function buildPipes(inputs: CatalogueInputs, valueOf: (step: string) => number | null): Map<string, CataloguePipe> {
  const out = new Map<string, CataloguePipe>();
  for (const c of inputs.channels) {
    for (const t of c.stepTransitions) {
      const legKey = servedLegKeyOf(c.slug, t.legKey);
      const respelled = legKey !== t.legKey;
      const id = pipeIdOf(c.slug, legKey);
      const measurement = inputs.measurements.get(id) ?? null;
      const toStep = t.to.key;
      let economics: Economics;
      if (c.operatedBy === "customer") economics = { status: "customer_time", costUsd: null, roi: null, reason: null };
      else if (measurement?.basis === "mature" && usable(measurement.costPerOutcomeUsd)) {
        const value = valueOf(toStep);
        economics = { status: "measured", costUsd: round2(measurement.costPerOutcomeUsd), roi: value == null ? null : round2(value / measurement.costPerOutcomeUsd), reason: null };
      } else economics = LEARNING(measurement?.basis === "flash" ? "no_mature_workflow_yet" : "no_fleet_history");
      out.set(id, {
        id,
        channelSlug: c.slug,
        channelName: c.name,
        legKey,
        computedLegKey: t.legKey,
        fromStep: respelled ? "lead_found" : (t.from?.key ?? null),
        toStep,
        mode: t.mode,
        triggerId: t.triggerId,
        operatedBy: c.operatedBy,
        managed: c.managed,
        published: inputs.publishedPipeIds.has(id),
        economics,
        measurement,
      });
    }
  }
  return out;
}

/** PURE: the rate of a non-entry leg between two steps (fleet median > default incl. declared). */
export function legRateOf(medians: FleetArrowMedians, from: string, to: string): { ratePct: number | null; source: "fleet_median" | "default" | null } {
  const median = medians.get(legPairKey(from, to));
  if (median && fleetMedianApplies(median) && median.ratePct !== null) return { ratePct: median.ratePct, source: "fleet_median" };
  const def = defaultLegRatePct(from as ChannelStepKey, to as ChannelStepKey);
  return def === null ? { ratePct: null, source: null } : { ratePct: def, source: "default" };
}

/** PURE: the measured conversion of an entry leg out of Lead found (best mature pipe), or null. */
function measuredEntryRate(pipes: Iterable<CataloguePipe>, legKey: string): number | null {
  let best: number | null = null;
  for (const p of pipes) {
    if (p.legKey !== legKey || p.measurement?.basis !== "mature") continue;
    const r = p.measurement.conversionRatePct;
    if (usable(r) && (best === null || r > best)) best = r;
  }
  return best;
}

/** PURE: the whole model. */
export function buildCatalogueModel(inputs: CatalogueInputs): CatalogueModel {
  // Step defs: coded + declared (registered into CHANNEL_STEPS by the catalogue load).
  const declared = new Map(inputs.declaredSteps.map((d) => [d.key, d]));
  const stepKeys = new Set<string>([...Object.keys(CHANNEL_STEPS), ...declared.keys()]);

  // Pipes first WITHOUT roi (values need the entry-leg rates the pipes measure), then the values, then roi.
  const bare = buildPipes(inputs, () => null);

  // Arrows s -> t with a rate: every non-entry leg a pipe performs, every entry leg out of Lead found the
  // fleet measured, and every declared step's toward arrow.
  const arrows = new Map<string, Array<{ to: string; ratePct: number }>>();
  const addArrow = (from: string, to: string, ratePct: number | null) => {
    if (ratePct === null || !(ratePct > 0)) return;
    const list = arrows.get(from) ?? [];
    if (!list.some((a) => a.to === to)) list.push({ to, ratePct });
    arrows.set(from, list);
  };
  for (const p of bare.values()) {
    if (p.fromStep === null) continue;
    if (p.fromStep === "lead_found") addArrow("lead_found", p.toStep, measuredEntryRate(bare.values(), p.legKey));
    else addArrow(p.fromStep, p.toStep, legRateOf(inputs.fleetMedians, p.fromStep, p.toStep).ratePct);
  }
  for (const l of FUNNEL_LEGS) if (l.fromStep) addArrow(l.fromStep.key, l.toStep.key, legRateOf(inputs.fleetMedians, l.fromStep.key, l.toStep.key).ratePct);
  for (const d of inputs.declaredSteps) addArrow(d.key, d.towardStep, d.towardRatePct);

  const values = new Map<string, { value: number | null; via: { toStep: string; ratePct: number } | null }>();
  const valueOf = (step: string, seen: Set<string> = new Set()): number | null => {
    if (step === "paid_client") return inputs.lifetimeRevenueUsd;
    const known = values.get(step);
    if (known) return known.value;
    if (seen.has(step)) return null;
    const nextSeen = new Set([...seen, step]);
    let best: { value: number; via: { toStep: string; ratePct: number } } | null = null;
    for (const a of arrows.get(step) ?? []) {
      const v = valueOf(a.to, nextSeen);
      if (v === null) continue;
      const candidate = (a.ratePct / 100) * v;
      if (!best || candidate > best.value) best = { value: candidate, via: { toStep: a.to, ratePct: a.ratePct } };
    }
    // Only memoise a complete answer (a cycle cut short is not the step's value).
    if (seen.size === 0) values.set(step, { value: best?.value ?? null, via: best?.via ?? null });
    return best?.value ?? null;
  };
  const stepValue = (step: string) => {
    const v = valueOf(step);
    return { value: v, via: values.get(step)?.via ?? null };
  };

  const steps = new Map<string, CatalogueStep>();
  for (const key of stepKeys) {
    const def = (CHANNEL_STEPS as Record<string, { label: string; description: string; shortDescription: string }>)[key];
    const d = declared.get(key);
    if (!def && !d) continue;
    const { value, via } = stepValue(key);
    steps.set(key, {
      key,
      label: d?.label ?? def.label,
      description: d?.description ?? def.description,
      shortDescription: d?.shortDescription ?? def.shortDescription,
      icon: d?.icon ?? STEP_ICONS[key] ?? "circle",
      declared: d !== undefined || isDeclaredStepKey(key),
      valueUsd: value === null ? null : round2(value),
      valueVia: via,
      producedBy: d?.producedBy ?? null,
    });
  }

  const pipes = buildPipes(inputs, (s) => stepValue(s).value);

  // Paths: chains of served legs from an entry leg to Paid client, no step twice; the sourcing leg (-> Lead
  // found) is never a path leg (see the header).
  type PathLeg = { legKey: string; fromStep: string | null; toStep: string };
  const legsByFrom = new Map<string, Map<string, PathLeg>>();
  const addLeg = (l: PathLeg) => {
    if (l.toStep === "lead_found") return;
    const from = ENTRY_FROM(l.fromStep) ? "∅" : l.fromStep!;
    const byLeg = legsByFrom.get(from) ?? new Map<string, PathLeg>();
    if (!byLeg.has(l.legKey)) byLeg.set(l.legKey, l);
    legsByFrom.set(from, byLeg);
  };
  for (const p of pipes.values()) addLeg(p);
  // A funnel leg no channel performs (a visitor signing up) is still a leg of a path, worked by nobody of ours.
  for (const l of FUNNEL_LEGS) if (l.fromStep) addLeg({ legKey: l.legKey, fromStep: l.fromStep.key, toStep: l.toStep.key });
  const paths = new Map<string, CataloguePath>();
  const walk = (step: string, chain: PathLeg[], seen: Set<string>) => {
    if (step === "paid_client") {
      const legKeys = chain.map((l) => l.legKey);
      const id = pathIdOf(legKeys);
      paths.set(id, {
        id,
        legKeys,
        steps: [chain[0].fromStep ?? "start", ...chain.map((l) => l.toStep)].filter((s) => s !== "start"),
        rates: chain.map((l, i) => {
          if (i === 0) {
            if (l.fromStep === "lead_found") {
              const r = measuredEntryRate(pipes.values(), l.legKey);
              return { legKey: l.legKey, ratePct: r, source: r === null ? null : ("measured_pipe" as const) };
            }
            return { legKey: l.legKey, ratePct: null, source: null };
          }
          const r = legRateOf(inputs.fleetMedians, l.fromStep!, l.toStep);
          return { legKey: l.legKey, ratePct: r.ratePct, source: r.source };
        }),
      });
      return;
    }
    if (chain.length >= 12) return;
    for (const leg of (legsByFrom.get(step) ?? new Map<string, PathLeg>()).values()) {
      if (seen.has(leg.toStep)) continue;
      walk(leg.toStep, [...chain, leg], new Set([...seen, leg.toStep]));
    }
  };
  walk("∅", [], new Set());

  return { steps, pipes, paths, lifetimeRevenueUsd: inputs.lifetimeRevenueUsd, channels: inputs.channels };
}

// ── Funnels ───────────────────────────────────────────────────────────────────────────────────────

/** PURE: every pipe performing one leg of a path. */
export const pipesOnLeg = (model: CatalogueModel, legKey: string): CataloguePipe[] => [...model.pipes.values()].filter((p) => p.legKey === legKey);

/**
 * PURE: the economics of one funnel (see the header formula). A leg's rate is the path's rate of that leg; a
 * leg no pipe of ours works, or one the customer's team works, costs us nothing.
 */
export function funnelEconomics(path: CataloguePath, legs: readonly FunnelLeg[], lifetimeRevenueUsd: number | null): Economics {
  if (!usable(lifetimeRevenueUsd)) return LEARNING("no_lifetime_revenue");
  let needed = 1;
  let cost = 0;
  let platformLegs = 0;
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const pipe = legs[i].pipe;
    if (pipe?.operatedBy === "platform") {
      platformLegs += 1;
      if (pipe.economics.status !== "measured" || pipe.measurement?.costPerOutcomeUsd == null) return LEARNING(`pipe_learning:${pipe.id}`);
      cost += pipe.measurement.costPerOutcomeUsd * needed;
    }
    if (i === 0) break;
    const rate = path.rates[i].ratePct;
    if (!usable(rate)) return LEARNING(`leg_unrated:${path.legKeys[i]}`);
    needed /= rate / 100;
  }
  if (platformLegs === 0 || !(cost > 0)) return { status: "customer_time", costUsd: null, roi: null, reason: null };
  return { status: "measured", costUsd: round2(cost), roi: round2(lifetimeRevenueUsd / cost), reason: null };
}

/** PURE: outcomes of each leg's step needed per paying client (null after a 0% / unrated leg). */
export function outcomesNeededPerPayingClient(path: CataloguePath): Array<number | null> {
  const out: Array<number | null> = new Array(path.legKeys.length).fill(null);
  let needed: number | null = 1;
  for (let i = path.legKeys.length - 1; i >= 0; i -= 1) {
    out[i] = needed === null ? null : round2(needed);
    if (i === 0) break;
    const rate = path.rates[i].ratePct;
    needed = needed !== null && usable(rate) ? needed / (rate / 100) : null;
  }
  return out;
}

/** PURE: the funnel id of a pick (the offer read's combination key: a platform pipe `@<slug>`, any other leg bare). */
export const funnelIdOf = (legs: readonly FunnelLeg[]): string =>
  combinationKeyOf(legs.map((l) => ({ legKey: l.legKey, channelSlug: l.pipe?.operatedBy === "platform" ? l.pipe.channelSlug : null })));

/**
 * PURE: every funnel of a path (one pipe per leg; a leg no channel performs stays bare), deduplicated by id
 * (two customer-team channels on one leg are one funnel). Capped at `cap`.
 */
export function funnelsOfPath(model: CatalogueModel, path: CataloguePath, cap = 2000): CatalogueFunnel[] {
  const options: FunnelLeg[][] = path.legKeys.map((legKey) => {
    const onLeg = pipesOnLeg(model, legKey);
    const platform = onLeg.filter((p) => p.operatedBy === "platform");
    const customer = onLeg.filter((p) => p.operatedBy === "customer").slice(0, 1);
    const picks = [...platform, ...customer].map((pipe) => ({ legKey, pipe }));
    return picks.length > 0 ? picks : [{ legKey, pipe: null }];
  });
  const out = new Map<string, CatalogueFunnel>();
  const walk = (i: number, acc: FunnelLeg[]) => {
    if (out.size >= cap) return;
    if (i === options.length) {
      const id = funnelIdOf(acc);
      if (!out.has(id)) {
        const slugs = [...new Set(acc.flatMap((l) => (l.pipe ? [l.pipe.channelSlug] : [])))];
        out.set(id, { id, pathId: path.id, legs: acc, channelSlugs: slugs, economics: funnelEconomics(path, acc, model.lifetimeRevenueUsd) });
      }
      return;
    }
    for (const o of options[i]) walk(i + 1, [...acc, o]);
  };
  walk(0, []);
  return [...out.values()];
}

/** PURE: a funnel by id (any path), or null. */
export function funnelById(model: CatalogueModel, id: string): CatalogueFunnel | null {
  const legKeys = id.split("+").map((part) => part.split("@")[0]);
  const path = model.paths.get(pathIdOf(legKeys));
  if (!path) return null;
  return funnelsOfPath(model, path).find((f) => f.id === id) ?? null;
}

/** PURE: a path's economics = its best measured funnel (highest roi); else learning. */
export function pathEconomics(model: CatalogueModel, path: CataloguePath): Economics & { bestFunnelId: string | null } {
  const funnels = funnelsOfPath(model, path);
  const measured = funnels.filter((f) => f.economics.status === "measured" && f.economics.roi !== null).sort((a, b) => b.economics.roi! - a.economics.roi! || a.id.localeCompare(b.id));
  if (measured.length > 0) return { ...measured[0].economics, bestFunnelId: measured[0].id };
  if (funnels.length > 0 && funnels.every((f) => f.economics.status === "customer_time")) return { status: "customer_time", costUsd: null, roi: null, reason: null, bestFunnelId: null };
  return { ...LEARNING("no_measured_funnel"), bestFunnelId: null };
}

/**
 * PURE: a channel's economics = its best measured pipe; else its customer-time or learning status. `legKeys`
 * narrows it to the pipes on those legs (a channel listed for a path is figured on that path's legs, never on
 * a pipe the path does not use).
 */
export function channelEconomics(model: CatalogueModel, slug: string, legKeys: ReadonlySet<string> | null = null): Economics & { bestPipeId: string | null } {
  const pipes = [...model.pipes.values()].filter((p) => p.channelSlug === slug && (!legKeys || legKeys.has(p.legKey)));
  const measured = pipes.filter((p) => p.economics.status === "measured").sort((a, b) => (b.economics.roi ?? -1) - (a.economics.roi ?? -1) || a.id.localeCompare(b.id));
  if (measured.length > 0) return { ...measured[0].economics, bestPipeId: measured[0].id };
  if (pipes.length > 0 && pipes.every((p) => p.economics.status === "customer_time")) return { status: "customer_time", costUsd: null, roi: null, reason: null, bestPipeId: null };
  return { ...LEARNING("no_measured_pipe"), bestPipeId: null };
}

/** PURE: a step's economics = the cheapest measured pipe producing it; roi = value / cost. */
export function stepEconomics(model: CatalogueModel, key: string): Economics {
  const step = model.steps.get(key);
  const producing = [...model.pipes.values()].filter((p) => p.toStep === key && p.economics.status === "measured" && p.measurement?.costPerOutcomeUsd != null);
  if (producing.length === 0) return LEARNING("no_measured_pipe");
  const cost = Math.min(...producing.map((p) => p.measurement!.costPerOutcomeUsd!));
  return { status: "measured", costUsd: round2(cost), roi: step?.valueUsd == null ? null : round2(step.valueUsd / cost), reason: null };
}

// ── Text and filters ──────────────────────────────────────────────────────────────────────────────

export const stepLabel = (model: CatalogueModel, key: string): string => model.steps.get(key)?.label ?? key;

/** PURE: "Lead found -> Positive reply -> Meeting booked -> Paid client"; a path from nothing reads "Start -> ...". */
export const pathLine = (model: CatalogueModel, path: CataloguePath): string =>
  [...(path.steps[0] === "lead_found" ? [] : ["Start"]), ...path.steps.map((s) => stepLabel(model, s))].join(" → ");

/** PURE: "Cold Email: Lead found -> Positive reply". */
export const pipeLine = (model: CatalogueModel, pipe: CataloguePipe): string =>
  `${pipe.channelName}: ${pipe.fromStep ? stepLabel(model, pipe.fromStep) : "Start"} → ${stepLabel(model, pipe.toStep)}`;

/** PURE: who works each leg, in order ("Sales Cold Email → AI Meeting Booking → your team"). */
export const funnelLine = (funnel: CatalogueFunnel): string =>
  funnel.legs.map((l) => (!l.pipe || l.pipe.operatedBy === "customer" ? "your team" : l.pipe.channelName)).join(" → ");

/** PURE: case-insensitive "every word of q appears in one of the texts". Empty q matches everything. */
export function matchesQuery(q: string | undefined, texts: ReadonlyArray<string | null | undefined>): boolean {
  if (!q || q.trim() === "") return true;
  const hay = texts.filter((t): t is string => typeof t === "string").join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** PURE: order rows by roi desc (null last), then measured before learning, then the tie-break text. */
export function byRoi<T>(econ: (row: T) => Economics, tie: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const ea = econ(a);
    const eb = econ(b);
    if (ea.roi !== null && eb.roi !== null && ea.roi !== eb.roi) return eb.roi - ea.roi;
    if ((ea.roi === null) !== (eb.roi === null)) return ea.roi === null ? 1 : -1;
    const rank = (s: EconomicsStatus) => (s === "measured" ? 0 : s === "customer_time" ? 1 : 2);
    return rank(ea.status) - rank(eb.status) || tie(a).localeCompare(tie(b));
  };
}

/** The faces of funnel names, re-exported for the route. */
export { faceOf, type Face };
