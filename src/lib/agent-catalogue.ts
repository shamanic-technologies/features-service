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
 * ── WHERE A PATH STARTS, AND EVERY LEG A CHANNEL (owner 2026-10-11) ─────────────────────────────────
 *
 * A PROACTIVE path goes from Start to Paid client, always: its first leg is from nothing (an ad producing a
 * website visit, or Start -> Lead found, the leg that FINDS the lead). An outbound path therefore reads
 * Start -> Lead found -> Positive reply -> ... and its id begins `start_to_lead_found+`. The id it had before
 * (from `lead_found_to_*`) is an ALIAS (`pathAliases`), so a stored id or name keeps resolving.
 * A REACTIVE path starts with its TRIGGER (owner 2026-10-11): its first leg's pipes answer one trigger (`pathTrigger`),
 * served by slug and name ("Positive Reply") in place of the trigger step, in the line and the path items.
 *
 * Every leg of a path is a leg some channel performs; a leg nobody performs is no path leg (owner 2026-10-11:
 * "des pipes sans channel ... ça ne devrait pas être possible"). The customer's own work is a `Your Team`
 * channel like any other.
 *
 * A SALES FUNNEL IS A STRAIGHT LINE: ONE CHANNEL PER LEG (owner 2026-10-11, supersedes the sourcing "pool"). On
 * Start -> Lead found the funnel names ONE sourcing channel: an origin (Apollo Cold Filters, Apollo Buying Signals,
 * LinkedIn Engagement Signals, Your CRM Contacts) or Lead Sourcing, where human-service picks the origins per brand
 * (`lib/sourcing-origins.ts`). Each is a normal pipe with its own figures, and the funnel's id names it like every
 * other leg (`start_to_lead_found@<sourcing slug>+...`). A sourcing pipe only feeds an outreach channel that takes
 * it (`SOURCING_ORIGINS_BY_CHANNEL`): Your CRM Contacts feeds cold email and cold WhatsApp, cold WhatsApp takes no
 * other origin.
 * A funnel id from BEFORE the sourcing leg was named (it starts out of Lead found) is that funnel with LEAD SOURCING
 * on its sourcing leg (`funnelById` resolves it, `legacyFunnelIdAliasOf`): the multi-source funnels moved to Lead
 * Sourcing (owner's migration), and every stored id (campaign-service, billing caps) keeps resolving. Their NAME
 * moved with them (`lib/lead-sourcing-key-migration.ts`).
 * COST: the sourcing leg is a pipe with its OWN cost (owner 2026-10-11): a source runs only when the outreach run asks
 * for a lead, as its own unit run (the `on_demand` trigger), and is measured on its own runs and the leads it found
 * (`lib/on-demand-pipe-fleet.ts`); the outreach pipe's measured cost is its outreach alone (fleet reads name its own
 * slug, `runsOwnFeatureSlugsParam`). So a funnel adds the source's cost per lead x the leads one paying client needs,
 * and two funnels that differ only by their source price differently.
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
 * ── MEASURED vs ESTIMATED (owner 2026-10-10: we sell a MEASURED cost per outcome, never an invented one) ──
 *
 *   A figure is MEASURED only when every input is a measured fleet outcome. Everything else it rests on is
 *   listed in `estimates` (`rate:<legKey>` for a leg rate that is a stated fleet median, an industry default
 *   or a declared rate; `lifetime_revenue` for the fleet median of STATED lifetime revenues; `step_value` for
 *   a step's value, which always ends on that stated lifetime revenue).
 *   FUNNEL / PATH  `status: "estimated"` as soon as one rate the cost per paying client uses is not measured
 *                  (only an entry leg's conversion out of Lead found is a measured fleet rate today, and the
 *                  entry rate is never used by the cost), so every multi-leg funnel reads `estimated` today.
 *   PIPE / STEP / CHANNEL / WORKFLOW  the COST is measured (`status: "measured"`); the ROI divides a step
 *                  value, so `roiBasis: "estimated"`.
 *   EXPECTED (owner 2026-10-11 "A ROI and a % Conversion are never blank (quitte à poser une hypothèse)"; 2026-10-12
 *   FUNNEL-EXPECTED-ROI-1012): every funnel ALSO serves `expected`, the same formula where every missing input takes
 *   an assumption, each named with its basis (`lib/expected-return.ts` words: measured < stated < fleet < default):
 *     pipe cost per outcome  mature workflow (`workflow`, measured) > seeded default for (leg, channel) (`default`)
 *                            > market benchmark (`benchmark`, default) > the pipe's early flash figure (`flash`,
 *                            fleet) > another channel's mature price on the same leg, the highest (`same_leg_fleet`,
 *                            fleet). The customer's own team costs nothing. One rule for every pipe, no slug.
 *     leg rate               the path's rate (brand measured / stated > fleet median > default, measured pipe)
 *                            > an entry leg's cold-email default (`DEFAULT_ENTRY_RATE_PCT`) > the seeded leg default.
 *     lifetime revenue       the offer's stated value (stated) or the fleet median (fleet).
 *   `basis` = the weakest input. Null only with a named `unavailableReason`. The measured/estimated figures above
 *   never move: on a priced funnel `expected` equals them.
 *
 *   RANKING (`byRoi`): tier first, measured > estimated > customer_time > learning, then ROI desc: a fully
 *   measured figure is never out-ranked by an estimate, however high the estimate.
 *
 * Pure: no IO, no clock.
 */
import { CHANNEL_STEPS, isDeclaredStepKey, type ChannelStepKey } from "./acquisition-channels.js";
import type { PublicChannel } from "./channel-catalogue.js";
import { DEFAULT_ENTRY_RATE_PCT, defaultLegRatePct } from "./default-leg-rates.js";
import type { ExpectedBasis } from "./expected-return.js";
import { fleetMedianApplies, legPairKey, type FleetArrowMedians } from "./effective-conversion-rates.js";
import { FUNNEL_LEGS, legacyFunnelIdAliasOf, servedLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import { DEFAULT_COST_PER_OUTCOME_USD, combinationKeyOf } from "./offer-sales-paths.js";
import { SALES_PATH_COST_BENCHMARKS } from "./sales-path-cost-benchmarks.js";
import { faceOf, stableHash, type Face } from "./catalogue-faces.js";
import { STEP_SIGNAL } from "./value-added.js";
import { PLAY_SEPARATOR, playIdOf, splitPlayId, splitPlaySlug } from "./plays.js";
import { CHANNEL_TRIGGER_TYPES, INLINE_TRIGGER_IDS } from "./channel-triggers.js";
import { LEAD_SOURCING_SLUG, SOURCE_LEG_KEY, SOURCING_ORIGINS_BY_CHANNEL, isSourcingChannel } from "./sourcing-origins.js";

/**
 * PURE: the value a pipe ADDS per outcome (owner 2026-10-11, `lib/value-added.ts`): its outcome step's value minus
 * the value of the step it takes people over at. A step the engine values nothing at (from nothing, Lead found)
 * subtracts $0. Null when a value it needs is unknown.
 */
export function valueAddedTo(valueOf: (step: string) => number | null, fromStep: string | null, toStep: string): number | null {
  const to = valueOf(toStep);
  if (to == null) return null;
  if (!fromStep || !STEP_SIGNAL[fromStep]) return to;
  const from = valueOf(fromStep);
  return from == null ? null : to - from;
}

// ── Glyphs ────────────────────────────────────────────────────────────────────────────────────────

/** One Phosphor icon per family (the dashboard maps Phosphor names) + a colour derived from the name. */
export const FAMILY_GLYPHS = { step: null, sales_path: "waves", channel: null, pipe: "bird", sales_funnel: null, workflow: "flow-arrow", trigger: "lightning" } as const;

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
  /**
   * `<channel slug>|<stored leg key>` of every pipe holding at least one ACTIVE workflow (`workflow_leg_assignments`,
   * keys through `storedLegKeyOf`). A platform pipe with a workflow can run (owner 2026-10-12: whether a pipe runs
   * follows from facts, never a staff click). Absent = none known (the pipe then runs only if its channel is managed).
   */
  workflowPipeKeys?: ReadonlySet<string>;
  declaredSteps: readonly DeclaredStepInput[];
  /** Pipe id -> fleet measurement. Absent = nothing measured. */
  measurements: ReadonlyMap<string, PipeMeasurement>;
  fleetMedians: FleetArrowMedians;
  /** The fleet median lifetime revenue of an offer, USD (or ONE offer's own, on a per-offer read). Null = nothing anywhere states one. */
  lifetimeRevenueUsd: number | null;
  /** What that lifetime revenue rests on: `stated` (the offer's own) or `fleet` (a fleet median). Default `fleet`. */
  lifetimeRevenueBasis?: ExpectedBasis;
  /**
   * A PER-OFFER read (`?offerId=`): the offer's brand's own rate of a leg where it HAS one (measured on its
   * own leads / CRM, or stated by the customer), keyed `${fromStep}>${toStep}`; a leg absent here keeps
   * the fleet rate. Absent on the fleet catalogue.
   */
  offerRates?: ReadonlyMap<string, { ratePct: number; source: "offer_measured" | "offer_stated" | "offer_team_measured" }>;
  /** The trigger types stored (`channel_trigger_types`: the coded ones and those declared at run time). The coded
   *  list (`lib/channel-triggers.ts`) is read in any case: it is what boot upserts. */
  triggers?: ReadonlyArray<{ id: string; label: string }>;
  /**
   * PLAYS (owner 2026-10-13, `lib/plays.ts`): per pipe id that catalogues plays, its DEFAULT play (what its bare id
   * runs) and its other plays, each with the measurement of its best allowed workflow. A pipe absent here has no play
   * but its own (every assigned workflow, as always). The default play's measurement IS the pipe's (`measurements`).
   */
  plays?: ReadonlyMap<string, { default: PlayInput | null; others: readonly PlayInput[] }>;
}

/** One play of a pipe as the catalogue prices it. */
export interface PlayInput {
  strategyId: string;
  strategyName: string;
  /** Its best allowed workflow (`pickLegPrice` over the pipe's workflows minus those the strategy excludes). */
  measurement: PipeMeasurement | null;
  /** ACTIVE workflows assigned to the pipe that the strategy allows. 0 = nothing can run it: never runnable. */
  allowedActiveWorkflowCount: number;
  /** Dynasty slugs the strategy excludes on this pipe. */
  excludedDynasties: readonly string[];
}

/** The play a pipe object stands for (null = a pipe cataloguing no play: every assigned workflow). */
export interface CataloguePlayInfo {
  /** The pipe the play runs on (its own id for the default play). */
  basePipeId: string;
  strategyId: string;
  strategyName: string;
  isDefault: boolean;
  allowedActiveWorkflowCount: number;
  excludedDynasties: readonly string[];
}

/** A trigger as a reactive path or funnel starts with it: its unique slug and unique name. */
export interface TriggerRef {
  slug: string;
  name: string;
}

// ── Model ─────────────────────────────────────────────────────────────────────────────────────────

export type EconomicsStatus = "measured" | "estimated" | "learning" | "customer_time";

export interface Economics {
  status: EconomicsStatus;
  costUsd: number | null;
  roi: number | null;
  /** Why it is `learning` (detail reads). Null when measured. */
  reason: string | null;
  /** What the figures rest on that is NOT a measured fleet outcome (see the header). Empty = all measured. */
  estimates: string[];
}

/** The basis of an ROI: `estimated` when anything it rests on is not measured; null with no ROI. */
export const roiBasisOf = (e: Economics): "measured" | "estimated" | null => (e.roi === null ? null : e.estimates.length > 0 ? "estimated" : "measured");

/** A step value always ends on the fleet median of STATED lifetime revenues: an ROI built on it is estimated. */
export const STEP_VALUE_ESTIMATES: readonly string[] = ["step_value"];

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
  /** At least one ACTIVE workflow is assigned to this pipe (`CatalogueInputs.workflowPipeKeys`). */
  hasWorkflow: boolean;
  published: boolean;
  economics: Economics;
  measurement: PipeMeasurement | null;
  /** The cost per outcome an EXPECTED figure takes for this pipe (see the header). Null on a customer-team pipe
   *  (costs us nothing) and on a platform pipe nothing prices. */
  expectedCost: ExpectedPipeCost | null;
  /** The play this object is (`lib/plays.ts`): a pipe's default play on the pipe itself, another play on a play variant
   *  (`model.plays`, id `<pipe id>~<strategy id>`). Null on a pipe cataloguing no play. */
  play: CataloguePlayInfo | null;
}

/** Where an expected pipe cost comes from (see the header). */
export type ExpectedCostSource = "workflow" | "default" | "benchmark" | "flash" | "same_leg_fleet";

export interface ExpectedPipeCost {
  costPerOutcomeUsd: number;
  source: ExpectedCostSource;
  basis: ExpectedBasis;
}

export interface CataloguePath {
  /** Its legs joined by `+`. A proactive path starts on a leg from nothing (Start). */
  id: string;
  legKeys: string[];
  steps: string[];
  /**
   * `proactive`: the path starts on an entry leg (from nothing, or from Lead found). `reactive` (owner
   * 2026-10-10, "an additional Sales Funnel, reactive only"): it starts on a TRIGGER step, its first leg
   * worked by a reactive pipe (Positive reply -> Meeting booked -> ... -> Paid client); nothing of ours
   * produced the trigger step, the funnel on it only answers it.
   */
  type: "proactive" | "reactive";
  /** The rate of each leg (null on an entry leg out of nothing). */
  rates: Array<{ legKey: string; ratePct: number | null; source: CatalogueRateSource }>;
}

/** One leg of a funnel: the ONE pipe working it (owner 2026-10-11: one channel per leg, the sourcing leg included). */
export interface FunnelLeg {
  legKey: string;
  pipe: CataloguePipe | null;
}

/** PURE: the pipe working a funnel leg, as a list (never more than one; empty only on a leg being built). */
export const legPipes = (l: FunnelLeg): CataloguePipe[] => (l.pipe ? [l.pipe] : []);

/** The step a sourcing pipe reaches: the hand-off to the outreach pipe that asked for the lead. */
export const SOURCED_STEP = "lead_found";

/** The Lead Sourcing pipe's part of a funnel id: what a funnel id from before the sourcing leg was named starts with. */
export const LEAD_SOURCING_FUNNEL_PART = `${SOURCE_LEG_KEY}@${LEAD_SOURCING_SLUG}`;

/** PURE: the funnel id a LEGACY id names (`lib/funnel-legs.ts`, owner 2026-10-11), or null. */
export { legacyFunnelIdAliasOf };

/** PURE: a pipe that answers an INLINE trigger: it runs inside the run that fires it (a source answering the lead
 *  request of the outreach run that needs the lead), so it draws on no budget of its own. */
const answersInline = (p: CataloguePipe): boolean => p.triggerId !== null && INLINE_TRIGGER_IDS.has(p.triggerId);

/** PURE: may this pipe hand its outcome to `next`? A sourcing pipe feeds only an outreach channel that takes it. */
export function pipeFeeds(p: CataloguePipe, next: CataloguePipe): boolean {
  if (p.toStep !== SOURCED_STEP || !isSourcingChannel(p.channelSlug)) return true;
  const accepted = SOURCING_ORIGINS_BY_CHANNEL[next.channelSlug];
  return accepted === undefined || accepted.includes(p.channelSlug);
}

export interface CatalogueFunnel {
  id: string;
  pathId: string;
  legs: FunnelLeg[];
  channelSlugs: string[];
  economics: Economics;
  expected: ExpectedFunnelEconomics;
}

/** One leg of an expected funnel figure: its rate and its pipe's cost, each with what it rests on. */
export interface ExpectedFunnelLeg {
  legKey: string;
  /** Null on the entry leg (its rate prices nothing). */
  ratePct: number | null;
  rateSource: CatalogueRateSource | "default_entry" | null;
  rateBasis: ExpectedBasis | null;
  outcomesNeededPerPayingClient: number | null;
  pipeId: string | null;
  /** 0 on a leg the customer's own team works. Null when unpriced. */
  costPerOutcomeUsd: number | null;
  costSource: ExpectedCostSource | "customer_team" | null;
  costBasis: ExpectedBasis | null;
}

/** The EXPECTED cost per paying client and roi of a funnel (see the header). */
export interface ExpectedFunnelEconomics {
  costUsd: number | null;
  roi: number | null;
  basis: ExpectedBasis | null;
  /** Why there is no figure: `no_lifetime_revenue`, `leg_unrated:<leg>`, `pipe_unpriced:<pipe id>`, `leg_without_pipe:<leg>`,
   *  `customer_time_only` (nothing of ours costs anything: no return multiple). Null with a figure. */
  unavailableReason: string | null;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueBasis: ExpectedBasis | null;
  legs: ExpectedFunnelLeg[];
}

export interface CatalogueModel {
  steps: Map<string, CatalogueStep>;
  pipes: Map<string, CataloguePipe>;
  paths: Map<string, CataloguePath>;
  /** A path's id before it started at Start (its legs without the sourcing leg) -> its id. */
  pathAliases: Map<string, string>;
  /** Trigger slug -> its slug and name. */
  triggers: Map<string, TriggerRef>;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueBasis: ExpectedBasis;
  channels: readonly PublicChannel[];
  /** Every NON-default play of a pipe, keyed `<pipe id>~<strategy id>` (`lib/plays.ts`): a pipe object of its own,
   *  same channel and leg, priced on its best allowed workflow. Never listed among the pipes. */
  plays: Map<string, CataloguePipe>;
}

export const pipeIdOf = (channelSlug: string, servedLegKey: string): string => `${channelSlug}|${servedLegKey}`;
export const pathIdOf = (legKeys: readonly string[]): string => legKeys.join("+");
/** The stored name key of a sales path (`lib/catalogue-names.ts` family `sales_path`). */
export const salesPathNameKeyOf = (pathId: string): string => `path:${pathId}`;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const LEARNING = (reason: string): Economics => ({ status: "learning", costUsd: null, roi: null, reason, estimates: [] });
const CUSTOMER_TIME = (): Economics => ({ status: "customer_time", costUsd: null, roi: null, reason: null, estimates: [] });

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
      const economics = pipeEconomicsOf(c.operatedBy, measurement, valueOf, respelled ? "lead_found" : (t.from?.key ?? null), toStep);
      const played = inputs.plays?.get(id)?.default ?? null;
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
        hasWorkflow: inputs.workflowPipeKeys?.has(`${c.slug}|${storedLegKeyOf(t.legKey)}`) ?? false,
        published: inputs.publishedPipeIds.has(id),
        economics,
        measurement,
        expectedCost: null,
        play: played ? playInfoOf(id, played, true) : null,
      });
    }
  }
  return out;
}

const playInfoOf = (basePipeId: string, p: PlayInput, isDefault: boolean): CataloguePlayInfo => ({
  basePipeId,
  strategyId: p.strategyId,
  strategyName: p.strategyName,
  isDefault,
  allowedActiveWorkflowCount: p.allowedActiveWorkflowCount,
  excludedDynasties: p.excludedDynasties,
});

/** PURE: a pipe's (or a play's) economics from its best workflow's measurement (see the header). */
function pipeEconomicsOf(
  operatedBy: "platform" | "customer",
  measurement: PipeMeasurement | null,
  valueOf: (step: string) => number | null,
  fromStep: string | null,
  toStep: string,
): Economics {
  if (operatedBy === "customer") return CUSTOMER_TIME();
  if (measurement?.basis === "mature" && usable(measurement.costPerOutcomeUsd)) {
    // The value it ADDS (`lib/value-added.ts`): its outcome's value minus the value of the step it takes people
    // over at (a reactive pipe answering Positive replies); from nothing / Lead found that is $0.
    const value = valueAddedTo(valueOf, fromStep, toStep);
    return {
      status: "measured",
      costUsd: round2(measurement.costPerOutcomeUsd),
      roi: value == null ? null : round2(value / measurement.costPerOutcomeUsd),
      reason: null,
      estimates: value == null ? [] : [...STEP_VALUE_ESTIMATES],
    };
  }
  return LEARNING(measurement?.basis === "flash" ? "no_mature_workflow_yet" : "no_fleet_history");
}

/** PURE: the non-default plays of every pipe, each a pipe object of its own (`CatalogueModel.plays`). */
function buildPlayVariants(inputs: CatalogueInputs, pipes: ReadonlyMap<string, CataloguePipe>, valueOf: (step: string) => number | null): Map<string, CataloguePipe> {
  const out = new Map<string, CataloguePipe>();
  for (const [pipeId, plays] of inputs.plays ?? []) {
    const base = pipes.get(pipeId);
    if (!base) continue;
    for (const p of plays.others) {
      const id = playIdOf(pipeId, p.strategyId);
      out.set(id, {
        ...base,
        id,
        measurement: p.measurement,
        economics: pipeEconomicsOf(base.operatedBy, p.measurement, valueOf, base.fromStep, base.toStep),
        hasWorkflow: p.allowedActiveWorkflowCount > 0,
        expectedCost: null,
        play: playInfoOf(pipeId, p, false),
      });
    }
  }
  return out;
}

/** PURE: the rate of a non-entry leg between two steps (fleet median > default incl. declared). */
/** Where a leg rate comes from. `offer_*` only on a per-offer read (the offer's brand's own rate). */
export type CatalogueRateSource = "fleet_median" | "default" | "measured_pipe" | "offer_measured" | "offer_stated" | "offer_team_measured" | null;

/** A rate that is a measured outcome (never an estimate): the fleet's measured conversion, or the brand's own measured one. */
export const isMeasuredRate = (source: CatalogueRateSource): boolean => source === "measured_pipe" || source === "offer_measured" || source === "offer_team_measured";

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

/** PURE: the cost per outcome an EXPECTED figure takes for a platform pipe (see the header); null on the customer's
 *  team and when nothing prices it. */
export function expectedPipeCost(p: CataloguePipe, all: Iterable<CataloguePipe>): ExpectedPipeCost | null {
  if (p.operatedBy === "customer") return null;
  if (p.measurement?.basis === "mature" && usable(p.measurement.costPerOutcomeUsd)) return { costPerOutcomeUsd: p.measurement.costPerOutcomeUsd, source: "workflow", basis: "measured" };
  const key = `${p.computedLegKey}|${p.channelSlug}`;
  const seeded = DEFAULT_COST_PER_OUTCOME_USD.get(key);
  if (usable(seeded)) return { costPerOutcomeUsd: seeded, source: "default", basis: "default" };
  const benchmark = SALES_PATH_COST_BENCHMARKS.get(key)?.costPerOutcomeUsd;
  if (usable(benchmark)) return { costPerOutcomeUsd: benchmark, source: "benchmark", basis: "default" };
  if (p.measurement?.basis === "flash" && usable(p.measurement.costPerOutcomeUsd)) return { costPerOutcomeUsd: p.measurement.costPerOutcomeUsd, source: "flash", basis: "fleet" };
  // Another channel's mature price on the same leg (same from and to step), the highest: an assumption that never flatters.
  let sibling: number | null = null;
  for (const q of all) {
    if (q.id === p.id || q.operatedBy !== "platform" || q.fromStep !== p.fromStep || q.toStep !== p.toStep) continue;
    const c = q.measurement?.basis === "mature" ? q.measurement.costPerOutcomeUsd : null;
    if (usable(c) && (sibling === null || c > sibling)) sibling = c;
  }
  return sibling === null ? null : { costPerOutcomeUsd: sibling, source: "same_leg_fleet", basis: "fleet" };
}

const BASIS_RANK: Record<ExpectedBasis, number> = { measured: 0, stated: 1, fleet: 2, default: 3 };
const weakest = (bases: ReadonlyArray<ExpectedBasis | null>): ExpectedBasis | null =>
  bases.reduce<ExpectedBasis | null>((w, b) => (b === null ? w : w === null || BASIS_RANK[b] > BASIS_RANK[w] ? b : w), null);

/** The basis of a path leg rate in the words of `lib/expected-return.ts`. */
export const rateBasisOf = (source: CatalogueRateSource | "default_entry"): ExpectedBasis | null =>
  source === "measured_pipe" || source === "offer_measured" || source === "offer_team_measured"
    ? "measured"
    : source === "offer_stated"
      ? "stated"
      : source === "fleet_median"
        ? "fleet"
        : source === "default" || source === "default_entry"
          ? "default"
          : null;

/**
 * PURE: the EXPECTED economics of one funnel (see the header): `funnelEconomics`' formula where every missing input
 * takes its assumption, each leg naming what it rests on. Never null without a reason.
 */
export function expectedFunnelEconomics(
  path: CataloguePath,
  legs: readonly FunnelLeg[],
  lifetimeRevenueUsd: number | null,
  lifetimeRevenueBasis: ExpectedBasis,
  takeoverValueUsd: number | null = 0,
): ExpectedFunnelEconomics {
  const out: ExpectedFunnelLeg[] = [];
  let needed: number | null = 1;
  let cost = 0;
  let platformLegs = 0;
  let reason: string | null = usable(lifetimeRevenueUsd) ? null : "no_lifetime_revenue";
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const pipe = legs[i].pipe;
    const legKey = path.legKeys[i];
    const leg: ExpectedFunnelLeg = {
      legKey,
      ratePct: null,
      rateSource: null,
      rateBasis: null,
      outcomesNeededPerPayingClient: needed === null ? null : round2(needed),
      pipeId: pipe?.id ?? null,
      costPerOutcomeUsd: null,
      costSource: null,
      costBasis: null,
    };
    if (!pipe) reason ??= `leg_without_pipe:${legKey}`;
    else if (pipe.operatedBy === "customer") Object.assign(leg, { costPerOutcomeUsd: 0, costSource: "customer_team" });
    else {
      platformLegs += 1;
      const c = pipe.expectedCost;
      if (!c) reason ??= `pipe_unpriced:${pipe.id}`;
      else {
        Object.assign(leg, { costPerOutcomeUsd: round2(c.costPerOutcomeUsd), costSource: c.source, costBasis: c.basis });
        if (needed !== null) cost += c.costPerOutcomeUsd * needed;
      }
    }
    if (i > 0) {
      const r = path.rates[i];
      const from = pipe?.fromStep ?? null;
      const to = pipe?.toStep ?? null;
      let rate: { ratePct: number; source: CatalogueRateSource | "default_entry" } | null = usable(r.ratePct) && r.source ? { ratePct: r.ratePct, source: r.source } : null;
      if (!rate && from === SOURCED_STEP && to && usable(DEFAULT_ENTRY_RATE_PCT[to as ChannelStepKey])) rate = { ratePct: DEFAULT_ENTRY_RATE_PCT[to as ChannelStepKey]!, source: "default_entry" };
      if (!rate && from && to) {
        const d = defaultLegRatePct(from as ChannelStepKey, to as ChannelStepKey);
        if (usable(d)) rate = { ratePct: d, source: "default" };
      }
      if (rate) {
        Object.assign(leg, { ratePct: rate.ratePct, rateSource: rate.source, rateBasis: rateBasisOf(rate.source) });
        if (needed !== null) needed /= rate.ratePct / 100;
      } else {
        reason ??= `leg_unrated:${legKey}`;
        needed = null;
      }
    }
    out.unshift(leg);
  }
  if (reason === null && (platformLegs === 0 || !(cost > 0))) reason = "customer_time_only";
  const ltrBasis = usable(lifetimeRevenueUsd) ? lifetimeRevenueBasis : null;
  if (reason !== null || needed === null) {
    return { costUsd: null, roi: null, basis: null, unavailableReason: reason ?? "leg_unrated", lifetimeRevenueUsd, lifetimeRevenueBasis: ltrBasis, legs: out };
  }
  const added = takeoverValueUsd === null ? null : lifetimeRevenueUsd! - neededAtTakeover(out) * takeoverValueUsd;
  const basis = weakest([ltrBasis, ...out.slice(1).map((l) => l.rateBasis), ...out.map((l) => l.costBasis)]);
  return {
    costUsd: round2(cost),
    roi: added === null ? null : round2(added / cost),
    basis,
    unavailableReason: added === null ? "takeover_step_unvalued" : null,
    lifetimeRevenueUsd,
    lifetimeRevenueBasis: ltrBasis,
    legs: out,
  };
}

/** People reaching the funnel's first leg's outcome per paying client (the takeover count `funnelEconomics` uses). */
const neededAtTakeover = (legs: readonly ExpectedFunnelLeg[]): number => {
  // `funnelEconomics` divides `needed` by every rate down to leg 1: the count at leg 0's outcome.
  let needed = 1;
  for (let i = legs.length - 1; i >= 1; i -= 1) needed /= (legs[i].ratePct as number) / 100;
  return needed;
};

/** PURE: the whole model. */
export function buildCatalogueModel(inputs: CatalogueInputs): CatalogueModel {
  // A per-offer read prices a leg on the offer's brand's own rate where it has one, else the fleet's.
  const rateOf = (from: string, to: string): { ratePct: number | null; source: CatalogueRateSource } =>
    inputs.offerRates?.get(`${from}>${to}`) ?? legRateOf(inputs.fleetMedians, from, to);
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
    else addArrow(p.fromStep, p.toStep, rateOf(p.fromStep, p.toStep).ratePct);
  }
  for (const l of FUNNEL_LEGS) if (l.fromStep) addArrow(l.fromStep.key, l.toStep.key, rateOf(l.fromStep.key, l.toStep.key).ratePct);
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
  for (const p of pipes.values()) p.expectedCost = expectedPipeCost(p, pipes.values());
  const plays = buildPlayVariants(inputs, pipes, (s) => stepValue(s).value);
  for (const p of plays.values()) p.expectedCost = expectedPipeCost(p, pipes.values());

  // Paths: chains of the legs pipes perform, from Start (a leg from nothing) to Paid client, no step twice. A leg
  // no channel performs is no path leg (see the header). A path ALWAYS ends at Paid client (owner 2026-10-13: "une
  // campagne valide doit tjs finir par paid client"; a one-leg "Start -> Email sent" path was withdrawn).
  type PathLeg = { legKey: string; fromStep: string | null; toStep: string };
  const legsByFrom = new Map<string, Map<string, PathLeg>>();
  const addLeg = (l: PathLeg) => {
    const from = l.fromStep ?? "∅";
    const byLeg = legsByFrom.get(from) ?? new Map<string, PathLeg>();
    if (!byLeg.has(l.legKey)) byLeg.set(l.legKey, l);
    legsByFrom.set(from, byLeg);
  };
  for (const p of pipes.values()) addLeg(p);
  const paths = new Map<string, CataloguePath>();
  const pathAliases = new Map<string, string>();
  const reactiveOnly = (legKey: string) => {
    const on = [...pipes.values()].filter((p) => p.legKey === legKey);
    return on.length > 0 && on.every((p) => p.mode === "reactive");
  };
  const walk = (step: string, chain: PathLeg[], seen: Set<string>, type: CataloguePath["type"] = "proactive") => {
    if (step === "paid_client") {
      // A path out of nothing whose first leg only reactive pipes work starts on their trigger: it is reactive.
      if (chain[0].fromStep === null && reactiveOnly(chain[0].legKey)) type = "reactive";
      const legKeys = chain.map((l) => l.legKey);
      const id = pathIdOf(legKeys);
      if (chain[0].toStep === SOURCED_STEP && chain.length > 1) pathAliases.set(pathIdOf(legKeys.slice(1)), id);
      paths.set(id, {
        id,
        legKeys,
        type,
        steps: [chain[0].fromStep ?? "start", ...chain.map((l) => l.toStep)].filter((s) => s !== "start"),
        rates: chain.map((l, i) => {
          if (i === 0) return { legKey: l.legKey, ratePct: null, source: null };
          // A leg out of Lead found: the brand's own rate (per-offer read) where it has one, else the best mature
          // pipe's measured conversion.
          if (l.fromStep === SOURCED_STEP) {
            const own = inputs.offerRates?.get(`${l.fromStep}>${l.toStep}`);
            if (own) return { legKey: l.legKey, ratePct: own.ratePct, source: own.source };
            const r = measuredEntryRate(pipes.values(), l.legKey);
            return { legKey: l.legKey, ratePct: r, source: r === null ? null : ("measured_pipe" as const) };
          }
          const r = rateOf(l.fromStep!, l.toStep);
          return { legKey: l.legKey, ratePct: r.ratePct, source: r.source };
        }),
      });
      return;
    }
    if (chain.length >= 12) return;
    for (const leg of (legsByFrom.get(step) ?? new Map<string, PathLeg>()).values()) {
      if (seen.has(leg.toStep)) continue;
      walk(leg.toStep, [...chain, leg], new Set([...seen, leg.toStep]), type);
    }
  };
  walk("∅", [], new Set());
  // REACTIVE paths (owner 2026-10-10): from every trigger step a reactive pipe leaves, through that pipe's
  // leg first, then any chain to Paid client. Their ids start on the reactive leg, so they never collide with
  // a proactive path (which starts on an entry leg).
  for (const p of pipes.values()) {
    if (p.mode !== "reactive" || p.fromStep === null || p.fromStep === SOURCED_STEP || p.toStep === SOURCED_STEP) continue;
    const first: PathLeg = { legKey: p.legKey, fromStep: p.fromStep, toStep: p.toStep };
    walk(p.toStep, [first], new Set([p.fromStep, p.toStep]), "reactive");
  }

  const triggers = new Map<string, TriggerRef>(
    [...CHANNEL_TRIGGER_TYPES, ...(inputs.triggers ?? [])].map((t) => [t.id, { slug: t.id, name: t.label }]),
  );
  return {
    steps,
    pipes,
    paths,
    pathAliases,
    triggers,
    lifetimeRevenueUsd: inputs.lifetimeRevenueUsd,
    lifetimeRevenueBasis: inputs.lifetimeRevenueBasis ?? "fleet",
    channels: inputs.channels,
    plays,
  };
}

// ── Funnels ───────────────────────────────────────────────────────────────────────────────────────

/** PURE: every pipe performing one leg of a path. */
export const pipesOnLeg = (model: CatalogueModel, legKey: string): CataloguePipe[] => [...model.pipes.values()].filter((p) => p.legKey === legKey);

/** A channel as a leg serves it: its slug, display name, and whether WE run it (else the customer's own team). */
export interface LegChannel {
  id: string;
  name: string;
  runByUs: boolean;
}
export const legChannelOf = (p: CataloguePipe): LegChannel => ({ id: p.channelSlug, name: p.channelName, runByUs: p.operatedBy === "platform" });

/** PURE: the steps a path leg goes between (null from = Start), read off the pipes performing it. */
export function legStepsOf(model: CatalogueModel, legKey: string): { fromStep: string | null; toStep: string } {
  const p = pipesOnLeg(model, legKey)[0];
  if (!p) throw new Error(`[features-service] catalogue: no pipe performs the path leg ${legKey}`);
  return { fromStep: p.fromStep, toStep: p.toStep };
}

/**
 * PURE: the economics of one funnel (see the header formula). A leg's rate is the path's rate of that leg; a
 * leg no pipe of ours works, or one the customer's team works, costs us nothing.
 */
export function funnelEconomics(
  path: CataloguePath,
  legs: readonly FunnelLeg[],
  lifetimeRevenueUsd: number | null,
  /** The value of a person at the step the funnel takes people over at (its first leg's start; $0 from nothing /
   *  Lead found, `lib/value-added.ts`). Null = that step is unvalued: no roi. */
  takeoverValueUsd: number | null = 0,
): Economics {
  if (!usable(lifetimeRevenueUsd)) return LEARNING("no_lifetime_revenue");
  let needed = 1;
  let cost = 0;
  let platformLegs = 0;
  const estimates: string[] = [];
  // Every leg's pipe adds its own cost, the sourcing leg included (see the header).
  const first = 0;
  for (let i = legs.length - 1; i >= first; i -= 1) {
    const pipe = legs[i].pipe;
    if (pipe?.operatedBy === "platform") {
      platformLegs += 1;
      if (pipe.economics.status !== "measured" || pipe.measurement?.costPerOutcomeUsd == null) return LEARNING(`pipe_learning:${pipe.id}`);
      cost += pipe.measurement.costPerOutcomeUsd * needed;
    }
    if (i === first) break;
    const rate = path.rates[i].ratePct;
    if (!usable(rate)) return LEARNING(`leg_unrated:${path.legKeys[i]}`);
    // Only a measured fleet conversion is a measured rate; a stated median, a default or a declared rate is not.
    if (!isMeasuredRate(path.rates[i].source)) estimates.unshift(`rate:${path.legKeys[i]}`);
    needed /= rate / 100;
  }
  if (platformLegs === 0 || !(cost > 0)) return CUSTOMER_TIME();
  const costEstimated = estimates.length > 0;
  // Per paying client, the value it ADDS: the client, minus what the people it took over were already worth there
  // (`needed` = people reaching its first leg's outcome per paying client).
  const added = takeoverValueUsd === null ? null : lifetimeRevenueUsd - needed * takeoverValueUsd;
  return {
    status: costEstimated ? "estimated" : "measured",
    costUsd: round2(cost),
    roi: added === null ? null : round2(added / cost),
    reason: null,
    estimates: [...estimates, "lifetime_revenue"],
  };
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

/**
 * PURE: the funnel id of a pick (the offer read's combination key: a platform pipe `@<slug>`, a leg the customer's
 * own team works bare). Every leg is in it, the sourcing leg included (see the header).
 */
export const funnelIdOf = (legs: readonly FunnelLeg[]): string =>
  combinationKeyOf(legs.map((l) => ({ legKey: l.legKey, channelSlug: l.pipe?.operatedBy === "platform" ? funnelSlugPart(l.pipe) : null })));

/** A platform pipe's part of a funnel id: its slug, `~<strategy>` on a non-default play (`lib/plays.ts`). */
const funnelSlugPart = (p: CataloguePipe): string => (p.play && !p.play.isDefault ? `${p.channelSlug}${PLAY_SEPARATOR}${p.play.strategyId}` : p.channelSlug);

/**
 * PURE: a pipe or a play by id. A play id naming the pipe's DEFAULT strategy is the pipe itself (its bare id is the
 * default play); a strategy the pipe does not catalogue is no play: null.
 */
export function pipeOrPlayById(model: CatalogueModel, id: string): CataloguePipe | null {
  const direct = model.pipes.get(id) ?? model.plays.get(id);
  if (direct) return direct;
  const { pipeId, strategyId } = splitPlayId(id);
  const base = strategyId ? model.pipes.get(pipeId) : undefined;
  return base?.play?.isDefault && base.play.strategyId === strategyId ? base : null;
}

/** PURE: every play of a pipe, default first (one entry, the pipe itself, when it catalogues none). */
export const playsOfPipe = (model: CatalogueModel, pipe: CataloguePipe): CataloguePipe[] => [
  pipe,
  ...[...model.plays.values()].filter((v) => v.play?.basePipeId === pipe.id).sort((a, b) => (a.id < b.id ? -1 : 1)),
];

/** PURE: a funnel id with every `~<strategy>` naming its pipe's DEFAULT play dropped (the default play is the bare pipe). */
function canonicalFunnelId(model: CatalogueModel, id: string): string {
  return id
    .split("+")
    .map((part) => {
      const at = part.indexOf("@");
      if (at < 0) return part;
      const { slug, strategyId } = splitPlaySlug(part.slice(at + 1));
      if (!strategyId) return part;
      const base = model.pipes.get(pipeIdOf(slug, part.slice(0, at)));
      return base?.play?.isDefault && base.play.strategyId === strategyId ? `${part.slice(0, at)}@${slug}` : part;
    })
    .join("+");
}

/**
 * PURE: every funnel of a path: ONE pipe per leg (a platform pipe, or the customer's own team's), the sourcing leg
 * included; a sourcing pipe only before an outreach pipe that takes it (`pipeFeeds`). Deduplicated by id. A leg no
 * pipe works makes no funnel. Capped at `cap`.
 */
export function funnelsOfPath(model: CatalogueModel, path: CataloguePath, cap = 2000): CatalogueFunnel[] {
  const options: FunnelLeg[][] = path.legKeys.map((legKey) => {
    const onLeg = pipesOnLeg(model, legKey);
    const platform = onLeg.filter((p) => p.operatedBy === "platform");
    // Every non-default play of a platform pipe is its own option on the leg: a funnel differing only by a strategy
    // is another funnel (owner 2026-10-13).
    const variants = [...model.plays.values()].filter((v) => v.legKey === legKey).sort((a, b) => (a.id < b.id ? -1 : 1));
    const customer = onLeg.filter((p) => p.operatedBy === "customer").slice(0, 1);
    return [...platform, ...variants, ...customer].map((pipe) => ({ legKey, pipe }));
  });
  if (options.some((o) => o.length === 0)) return [];
  const out = new Map<string, CatalogueFunnel>();
  const walk = (i: number, acc: FunnelLeg[]) => {
    if (out.size >= cap) return;
    if (i === options.length) {
      const id = funnelIdOf(acc);
      if (!out.has(id)) {
        const slugs = [...new Set(acc.flatMap((l) => legPipes(l).map((p) => p.channelSlug)))];
        const takeover = funnelFirstStep(acc);
        const takeoverValue = takeover && STEP_SIGNAL[takeover] ? (model.steps.get(takeover)?.valueUsd ?? null) : 0;
        out.set(id, {
          id,
          pathId: path.id,
          legs: acc,
          channelSlugs: slugs,
          economics: funnelEconomics(path, acc, model.lifetimeRevenueUsd, takeoverValue),
          expected: expectedFunnelEconomics(path, acc, model.lifetimeRevenueUsd, model.lifetimeRevenueBasis, takeoverValue),
        });
      }
      return;
    }
    const before = acc[acc.length - 1]?.pipe;
    for (const o of options[i]) if (!before || !o.pipe || pipeFeeds(before, o.pipe)) walk(i + 1, [...acc, o]);
  };
  walk(0, []);
  return [...out.values()];
}

/** PURE: the step a funnel's first leg starts from (null = Start: the funnel finds its own people). */
export const funnelFirstStep = (legs: readonly FunnelLeg[]): string | null => (legs[0] ? (legPipes(legs[0])[0]?.fromStep ?? null) : null);

// ── Runnable: what we run TODAY (owner rule: a customer surface never presents what we do not run) ──

/**
 * PURE: a pipe we can run today, from FACTS (owner 2026-10-12, never a staff click): run by the customer's own team
 * (nothing of ours to run: always), or a platform pipe we run (a MANAGED channel: `MANAGED_CHANNEL_SLUGS` + live
 * sourcing origins) or holding an ACTIVE workflow. A platform pipe with neither (LinkedIn posting, ads, agencies) is
 * listed but campaign-service answers 409 `no_workflow` on launch. `published` is true for every declaration since
 * 2026-10-12 (created live); it stays only as staff's unpublish switch.
 */
export const pipeRunnable = (p: CataloguePipe): boolean =>
  p.published && (p.operatedBy === "customer" || (p.play !== null && p.play.allowedActiveWorkflowCount === 0 ? false : p.managed || p.hasWorkflow));

/**
 * PURE: a sales funnel's TYPE (owner 2026-10-10): `proactive` when at least one of its pipes is proactive
 * (own budget, worked every tick), else `reactive` (every pipe waits on a trigger; a bare leg is the buyer's).
 * Served on every funnel row and detail so campaign-service / billing relay it and nobody re-grades pipe modes.
 */
export type FunnelType = "proactive" | "reactive";
export const funnelTypeOf = (f: Pick<CatalogueFunnel, "legs">): FunnelType =>
  f.legs.some((l) => legPipes(l).some((p) => p.mode === "proactive")) ? "proactive" : "reactive";

/**
 * PURE: a MIXED funnel (owner 2026-10-10): a proactive pipe AND a reactive pipe WE run (platform-operated,
 * e.g. AI meeting booking on a reply). The funnel's budget caps every pipe, so the reactive one can starve
 * the proactive part. A reactive pipe the customer's own team works spends nothing of ours: not a mix.
 */
// A pipe answering an INLINE trigger is not counted: a source answers the outreach run's request for a lead inside
// that run and spends no budget of its own, so it cannot starve the proactive part.
export const funnelMixed = (f: Pick<CatalogueFunnel, "legs">): boolean =>
  f.legs.some((l) => l.pipe?.mode === "proactive") &&
  f.legs.some((l) => l.pipe?.mode === "reactive" && l.pipe.operatedBy === "platform" && !answersInline(l.pipe));

/** PURE: a funnel we can run today: one kind (never mixed), every leg worked by a runnable pipe. */
export const funnelRunnable = (f: CatalogueFunnel): boolean =>
  !funnelMixed(f) && f.legs.every((l) => legPipes(l).some(pipeRunnable));

/** PURE: a channel we can run today: at least one of its pipes is runnable. */
export const channelRunnable = (model: CatalogueModel, slug: string): boolean =>
  [...model.pipes.values()].some((p) => p.channelSlug === slug && pipeRunnable(p));

/** PURE: a sales path we can run today: at least one of its funnels is runnable. */
export const pathRunnable = (model: CatalogueModel, path: CataloguePath): boolean => funnelsOfPath(model, path).some(funnelRunnable);

/** PURE: a sales path by id or by the id it had before it started at Start (`pathAliases`), or null. */
export const pathById = (model: CatalogueModel, id: string): CataloguePath | null =>
  model.paths.get(id) ?? model.paths.get(model.pathAliases.get(id) ?? "") ?? null;

/**
 * PURE: a funnel by id (any path), or null. Its id names every leg (`funnelIdOf`). A LEGACY id (from before the
 * sourcing leg was named: it starts out of Lead found) resolves to its Lead Sourcing funnel (`legacyFunnelIdAliasOf`);
 * the funnel returned carries its CURRENT id.
 */
export function funnelById(model: CatalogueModel, id: string): CatalogueFunnel | null {
  const exact = (key: string): CatalogueFunnel | null => {
    const legKeys = key.split("+").map((part) => part.split("@")[0]);
    const path = model.paths.get(pathIdOf(legKeys));
    if (!path) return null;
    return funnelsOfPath(model, path).find((f) => f.id === key) ?? null;
  };
  const canonical = canonicalFunnelId(model, id);
  const found = exact(canonical);
  if (found) return found;
  const alias = legacyFunnelIdAliasOf(canonical);
  return alias ? exact(alias) : null;
}

/** PURE: a path's economics = its best funnel in the ranking's order (a measured one before any estimate,
 *  then highest roi); else learning. */
export function pathEconomics(model: CatalogueModel, path: CataloguePath): Economics & { bestFunnelId: string | null } {
  const funnels = funnelsOfPath(model, path);
  const priced = funnels
    .filter((f) => (f.economics.status === "measured" || f.economics.status === "estimated") && f.economics.roi !== null)
    .sort(byRoi((f) => f.economics, (f) => f.id));
  if (priced.length > 0) return { ...priced[0].economics, bestFunnelId: priced[0].id };
  if (funnels.length > 0 && funnels.every((f) => f.economics.status === "customer_time")) return { ...CUSTOMER_TIME(), bestFunnelId: null };
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
  if (pipes.length > 0 && pipes.every((p) => p.economics.status === "customer_time")) return { ...CUSTOMER_TIME(), bestPipeId: null };
  return { ...LEARNING("no_measured_pipe"), bestPipeId: null };
}

/** PURE: a step's economics = the cheapest measured pipe producing it; roi = value / cost. */
export function stepEconomics(model: CatalogueModel, key: string): Economics {
  const step = model.steps.get(key);
  const producing = [...model.pipes.values()].filter((p) => p.toStep === key && p.economics.status === "measured" && p.measurement?.costPerOutcomeUsd != null);
  if (producing.length === 0) return LEARNING("no_measured_pipe");
  const cheapest = producing.reduce((a, b) => (b.measurement!.costPerOutcomeUsd! < a.measurement!.costPerOutcomeUsd! ? b : a));
  const cost = cheapest.measurement!.costPerOutcomeUsd!;
  // The value the cheapest producing pipe ADDS (`lib/value-added.ts`), as its own roi reads.
  const added = valueAddedTo((s) => model.steps.get(s)?.valueUsd ?? null, cheapest.fromStep, key);
  const roi = step?.valueUsd == null || added === null ? null : round2(added / cost);
  return { status: "measured", costUsd: round2(cost), roi, reason: null, estimates: roi === null ? [] : [...STEP_VALUE_ESTIMATES] };
}

// ── Text and filters ──────────────────────────────────────────────────────────────────────────────

export const stepLabel = (model: CatalogueModel, key: string): string => model.steps.get(key)?.label ?? key;

/** PURE: the trigger a pipe answers, by slug and name; null on a proactive pipe. Fails LOUD on a trigger no row
 *  names (boot's `assertLegTriggersDeclared` makes that impossible). */
export function pipeTrigger(model: CatalogueModel, pipe: CataloguePipe): TriggerRef | null {
  if (pipe.triggerId === null) return null;
  const t = model.triggers.get(pipe.triggerId);
  if (!t) throw new Error(`[features-service] catalogue: pipe ${pipe.id} names the trigger ${pipe.triggerId}, which no trigger type states`);
  return t;
}

/** PURE: the trigger a REACTIVE path starts with (the one its first leg's pipes answer); null on a proactive path. */
export function pathTrigger(model: CatalogueModel, path: CataloguePath): TriggerRef | null {
  if (path.type !== "reactive") return null;
  const first = pipesOnLeg(model, path.legKeys[0]).find((p) => p.mode === "reactive" && p.triggerId !== null);
  if (!first) throw new Error(`[features-service] catalogue: reactive path ${path.id} has no reactive pipe on its first leg`);
  return pipeTrigger(model, first);
}

/**
 * PURE: the trigger a funnel starts with: its first pipe's when that pipe is reactive (a reactive path, or a path out
 * of Start whose leg this funnel works with a reactive pipe: "Email Pushed Via API -> Email Sending -> Positive reply",
 * on the leg organic publishing works proactively); null when its first pipe is proactive.
 */
export function funnelTrigger(model: CatalogueModel, f: Pick<CatalogueFunnel, "pathId" | "legs">): TriggerRef | null {
  const first = f.legs[0]?.pipe;
  if (!model.paths.get(f.pathId) || !first || first.mode !== "reactive") return null;
  return pipeTrigger(model, first);
}

/** PURE: "Start -> Lead found -> Positive reply -> Paid client"; a reactive path starts with its trigger
 *  ("Positive Reply -> Meeting booked -> ..."), in place of its trigger step. */
export const pathLine = (model: CatalogueModel, path: CataloguePath): string => {
  const trigger = pathTrigger(model, path);
  const steps = path.steps.map((s) => stepLabel(model, s));
  // A reactive path out of a trigger STEP replaces that step with the trigger; one out of nothing (a step-less
  // trigger, "Email Pushed Via API -> Positive reply -> ...") puts the trigger in place of Start.
  const fromStep = legStepsOf(model, path.legKeys[0]).fromStep;
  return (trigger ? [trigger.name, ...(fromStep === null ? steps : steps.slice(1))] : ["Start", ...steps]).join(" → ");
};

/** PURE: "Cold Email: Lead found -> Positive reply". */
export const pipeLine = (model: CatalogueModel, pipe: CataloguePipe): string =>
  `${pipe.channelName}: ${pipe.fromStep ? stepLabel(model, pipe.fromStep) : "Start"} → ${stepLabel(model, pipe.toStep)}`;

/** PURE: who works each leg, in order ("Apollo Cold Filters + CRM Contacts → Sales Cold Email → your team"). */
export const funnelLine = (funnel: CatalogueFunnel): string =>
  funnel.legs
    .map((l) => legPipes(l).map((p) => (p.operatedBy === "customer" ? "your team" : p.channelName)).join(" + "))
    .join(" → ");

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

/** The ranking tier of a status: a fully measured figure is never out-ranked by an estimate. */
const STATUS_TIER: Record<EconomicsStatus, number> = { measured: 0, estimated: 1, customer_time: 2, learning: 3 };

/** PURE: order rows by status tier (measured > estimated > customer_time > learning), then roi desc (null
 *  last), then the tie-break text. */
export function byRoi<T>(
  econ: (row: T) => Economics,
  tie: (row: T) => string,
  /** Paths and funnels: a PROACTIVE one ranks before a REACTIVE one in the same status tier. A reactive cost
   *  per paying client leaves out what produced its trigger step, so its roi is not comparable. */
  typeOf?: (row: T) => "proactive" | "reactive",
): (a: T, b: T) => number {
  return (a, b) => {
    const ea = econ(a);
    const eb = econ(b);
    if (STATUS_TIER[ea.status] !== STATUS_TIER[eb.status]) return STATUS_TIER[ea.status] - STATUS_TIER[eb.status];
    if (typeOf && typeOf(a) !== typeOf(b)) return typeOf(a) === "proactive" ? -1 : 1;
    if (ea.roi !== null && eb.roi !== null && ea.roi !== eb.roi) return eb.roi - ea.roi;
    if ((ea.roi === null) !== (eb.roi === null)) return ea.roi === null ? 1 : -1;
    return tie(a).localeCompare(tie(b));
  };
}

/** The faces of funnel names, re-exported for the route. */
export { faceOf, type Face };
