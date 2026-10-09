/**
 * DECLARATIONS ARE DATA (owner 2026-10-09): a channel, a leg on a channel, a trigger type and a sales path
 * are created on the fly by a staff caller (the dashboard Copilot), never "via a PR". Code is only owed for
 * a CAPABILITY nothing reaches yet (a vendor we have not integrated, a detector nobody runs).
 *
 * This module is PURE: it validates a declaration against what exists and merges the stored declarations
 * into the rows the ONE catalogue builder reads (`buildChannelCatalogue`), so a declared channel is parsed,
 * typed and guarded exactly like a seeded one. IO lives in `channel-declarations-store.ts`.
 *
 * ── WHO MAY WRITE, AND WHO SEES IT ─────────────────────────────────────────────────────────────────
 *
 * STAFF ONLY (service key, `/internal/declarations/*`): a channel is shared by every client, so a write
 * changes what every org can buy. `requestedByOrgId` records which client asked (provenance, never scope).
 * A declared channel or leg is INVISIBLE to every client read (`/public/channels`, the offer sales paths)
 * until staff PUBLISHES it; the internal reads list everything with `published` stated.
 *
 * ── THE TRIGGER GUARANTEE SURVIVES GOING LIVE ──────────────────────────────────────────────────────
 *
 * A leg can only name a trigger something actually FIRES. Seeded legs are checked on boot
 * (`assertLegTriggersDeclared`); a DECLARED leg is checked at creation: a reactive leg on a trigger nothing
 * fires is REFUSED (409 `trigger_not_fired`), never stored to wait forever for an event nobody sends.
 *
 * A declared trigger type is `coded: false` unless a service runs a GENERIC detector for its KIND
 * (`GENERIC_DETECTOR_KINDS`). Three kinds:
 *  - `event`: a service detects something on a lead and rings campaign-service. Only the coded list in
 *    `channel-triggers.ts` names a real detector; a declared `event` is a statement of need.
 *  - `delay`: "N days after step X, if nothing happened". The due time and the "nothing happened" check
 *    belong to campaign-service, which owns the trigger EVENTS and their due times.
 *  - `poll`: "a new item appeared at this source". The polling loop and its cursor belong to campaign-service
 *    too (same door, same events table), reading the source through treg.
 * campaign-service runs the `delay` and `poll` detectors since #601 (deployed 2026-10-10), so both kinds are
 * in the set and every declared trigger of those kinds is coded. Their params are validated HERE with the
 * detector's own rules (`parseDelayParams`, `parsePollParams`), so a malformed declaration never reaches it.
 * A declared `event` stays uncoded: no generic detector can know what an arbitrary event means.
 *
 * ── PRICE ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * A declared leg costs exactly what any leg costs (runs cost rows per campaign, per-campaign stats): nothing
 * is priced off the declaration itself. Its price SOURCE is stated (`legPricingOf`): the workflow ladder on a
 * channel we run, a sourced market benchmark, the customer's own time (no cost), else `learning` with a null
 * figure. Never a made-up number.
 */
import {
  CHANNEL_OPERATORS,
  CHANNEL_PERFORMERS,
  CHANNEL_STEPS,
  matchChannelStepKey,
  type ChannelFamily,
  type ChannelOperator,
  type ChannelPerformer,
  type ChannelStepKey,
} from "./acquisition-channels.js";
import { CHANNEL_TRIGGER_TYPES, LEG_MODES, channelTriggerType, type LegMode } from "./channel-triggers.js";
import { legKeyFor, storedLegKeyOf } from "./funnel-legs.js";
import { CHANNEL_TYPES, isOutboundChannel, type ChannelType } from "./channel-types.js";
import type { CatalogueFeatureRow, PublicChannel } from "./channel-catalogue.js";
import { SALES_PATH_COST_BENCHMARKS } from "./sales-path-cost-benchmarks.js";
import { MANAGED_CHANNEL_SLUGS } from "./channel-leg-minimums.js";

// ── Stored shapes ───────────────────────────────────────────────────────────────────────────────────

export interface DeclaredChannel {
  slug: string;
  name: string;
  description: string;
  shortDescription: string;
  icon: string;
  channelType: DeclarableChannelType;
  operatedBy: ChannelOperator;
  performedBy: ChannelPerformer;
  dailyOperatingCostCents: number;
  minimumCommitmentDays: number;
  maxDaysToFirstProduction: number;
  displayOrder: number;
  published: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
  createdBy: string;
  requestedByOrgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeclaredLeg {
  channelSlug: string;
  legKey: string;
  fromStep: ChannelStepKey | null;
  toStep: ChannelStepKey;
  mode: LegMode;
  triggerId: string | null;
  published: boolean;
  createdBy: string;
  requestedByOrgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TRIGGER_KINDS = ["event", "delay", "poll"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The kinds a service fires GENERICALLY for any declared trigger of that kind. Empty today: see the header. */
export const GENERIC_DETECTOR_KINDS: ReadonlySet<TriggerKind> = new Set<TriggerKind>(["delay", "poll"]);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** campaign-service's ceiling on one poll call (`POLL_MAX_MICRO_CEILING`, micro-USD). */
export const POLL_MAX_MICRO_CEILING = 1_000_000;

const badParams = (reason: string, message: string) => new DeclarationError(400, reason, message);

/** PURE: `delay` params `{afterStep, days}`, the shape campaign-service's `parseDelayParams` reads. */
export function parseDelayParams(raw: unknown): { afterStep: ChannelStepKey; days: number } {
  if (!isRecord(raw)) throw badParams("params_required", "a delay trigger states params {afterStep, days}");
  const afterStep = step(raw.afterStep, "params.afterStep");
  if (typeof raw.days !== "number" || !Number.isInteger(raw.days) || raw.days < 1) {
    throw badParams("delay_days_invalid", "params.days must be a whole number of days >= 1");
  }
  return { afterStep, days: raw.days };
}

/**
 * PURE: `poll` params `{source, everyMinutes}`, campaign-service's `parsePollParams` rules (#601): `source`
 * is ONE treg call `{endpoint, method?, query?, body?, items, itemId?, maxMicro}`, given as an object or as
 * JSON text; stored as JSON text (what the detector parses). Every violation is a named 400.
 */
export function parsePollParams(raw: unknown): { source: string; everyMinutes: number } {
  if (!isRecord(raw)) throw badParams("params_required", "a poll trigger states params {source, everyMinutes}");
  const { everyMinutes } = raw;
  if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5) {
    throw badParams("poll_every_minutes_invalid", "params.everyMinutes must be a whole number >= 5");
  }
  let source: unknown = raw.source;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw badParams("poll_source_invalid", "params.source must be a JSON treg call {endpoint, method?, query?, body?, items, itemId?, maxMicro}");
    }
  }
  if (!isRecord(source)) throw badParams("poll_source_invalid", "params.source must be a treg call object");
  const { endpoint, method = "GET", query, body, items, itemId, maxMicro } = source;
  const fail = (detail: string) => badParams("poll_source_invalid", `params.source.${detail}`);
  if (typeof endpoint !== "string" || !/^[A-Za-z0-9_.-]+$/.test(endpoint)) throw fail("endpoint must be a treg endpoint id");
  if (method !== "GET" && method !== "POST") throw fail("method must be GET or POST");
  if (query !== undefined && (!isRecord(query) || Object.values(query).some((v) => typeof v !== "string"))) throw fail("query must be an object of strings");
  if (body !== undefined && !isRecord(body)) throw fail("body must be an object");
  if (typeof items !== "string") throw fail("items must be a dot path ('' = the answer itself)");
  if (itemId !== undefined && (typeof itemId !== "string" || itemId.length === 0)) throw fail("itemId must be a dot path");
  if (typeof maxMicro !== "number" || !Number.isInteger(maxMicro) || maxMicro < 1 || maxMicro > POLL_MAX_MICRO_CEILING) {
    throw fail(`maxMicro must be a whole number of micro-USD in 1..${POLL_MAX_MICRO_CEILING}`);
  }
  const extra = Object.keys(source).filter((k) => !["endpoint", "method", "query", "body", "items", "itemId", "maxMicro"].includes(k));
  if (extra.length > 0) throw fail(`has unknown fields: ${extra.join(", ")}`);
  return { source: JSON.stringify(source), everyMinutes };
}

export interface TriggerTypeRecord {
  id: string;
  label: string;
  description: string;
  icon: string;
  fromStep: string | null;
  firedBy: string;
  coded: boolean;
  origin: "code" | "declared";
  kind: TriggerKind;
  params: Record<string, unknown> | null;
  displayOrder: number;
  createdBy: string | null;
  requestedByOrgId: string | null;
}

export interface DeclaredSalesPathLeg {
  channelSlug: string;
  legKey: string;
}

export interface DeclaredSalesPath {
  combinationKey: string;
  legs: DeclaredSalesPathLeg[];
  createdBy: string;
  requestedByOrgId: string | null;
  createdAt: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────

/** A refused declaration: the HTTP status and the named reason the route answers with. */
export class DeclarationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "DeclarationError";
  }
}

const bad = (reason: string, message: string) => new DeclarationError(400, reason, message);

// ── Field readers (no default: a missing field is refused, never filled) ─────────────────────────────

type Body = Record<string, unknown>;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TRIGGER_ID_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
// A Phosphor icon token (kebab-case), the only vocabulary the dashboard maps.
const ICON_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function text(body: Body, field: string, max = 500): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") throw bad(`${field}_required`, `${field} is required (a non-empty string)`);
  if (v.trim().length > max) throw bad(`${field}_too_long`, `${field} is longer than ${max} characters`);
  return v.trim();
}

function optionalText(body: Body, field: string, max = 500): string | undefined {
  return body[field] === undefined ? undefined : text(body, field, max);
}

function wholeNumber(body: Body, field: string, min: number): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw bad(`${field}_invalid`, `${field} must be a whole number >= ${min}`);
  return v;
}

function icon(body: Body, field = "icon"): string {
  const v = text(body, field, 64);
  if (!ICON_RE.test(v)) throw bad("icon_invalid", `icon must be a Phosphor icon name (kebab-case), got ${JSON.stringify(v)}`);
  return v;
}

/** Who made the write: a staff identity, recorded on every row. */
export function actorOf(body: Body, field: "createdBy" | "updatedBy" = "createdBy"): string {
  return text(body, field, 200);
}

export function requestedByOrgIdOf(body: Body): string | null {
  const v = body.requestedByOrgId;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "") throw bad("requested_by_org_id_invalid", "requestedByOrgId must be an org id or null");
  return v.trim();
}

function step(raw: unknown, field: string): ChannelStepKey {
  const key = typeof raw === "string" ? matchChannelStepKey(raw) : null;
  if (!key) throw bad("step_unrecognised", `${field} must be one of ${Object.keys(CHANNEL_STEPS).join(", ")}, got ${JSON.stringify(raw)}`);
  return key;
}

// ── Channels ────────────────────────────────────────────────────────────────────────────────────────

/** The channel types a declared channel may take: the acquisition ones (fundraising, hiring and tools are not channels). */
export const DECLARABLE_CHANNEL_TYPES = ["sourcing", "outbound", "conversion", "paid", "earned", "pr"] as const satisfies readonly ChannelType[];
export type DeclarableChannelType = (typeof DECLARABLE_CHANNEL_TYPES)[number];

/** The deprecated `family` the stored blob still states, read off the one typology. */
const FAMILY_OF_TYPE: Record<DeclarableChannelType, ChannelFamily> = {
  sourcing: "sourcing",
  outbound: "outbound_one_to_one",
  conversion: "conversion",
  paid: "paid_reach",
  earned: "earned",
  pr: "earned",
};

export interface ChannelInput {
  slug: string;
  name: string;
  description: string;
  shortDescription: string;
  icon: string;
  channelType: DeclarableChannelType;
  operatedBy: ChannelOperator;
  performedBy: ChannelPerformer;
  dailyOperatingCostCents: number;
  minimumCommitmentDays: number;
  maxDaysToFirstProduction: number;
}

function checkOperatorRules(c: Pick<ChannelInput, "operatedBy" | "performedBy" | "dailyOperatingCostCents">): void {
  // Same rules the catalogue parser enforces on a seeded blob, answered as a 400 instead of a 500 later.
  if (c.operatedBy === "customer" && c.performedBy !== "person") {
    throw bad("customer_channel_must_be_person", "a customer-operated channel must be performed by a person");
  }
  if (c.operatedBy === "customer" && c.dailyOperatingCostCents !== 0) {
    throw bad("customer_channel_daily_cost", "a customer-operated channel states a daily operating cost of 0");
  }
}

/** PURE: read a create-channel body. `takenSlugs`/`takenNames` = every feature and declared channel. */
export function parseChannelInput(body: Body, takenSlugs: ReadonlySet<string>, takenNames: ReadonlySet<string>): ChannelInput {
  const slug = text(body, "slug", 64);
  if (!SLUG_RE.test(slug)) throw bad("slug_invalid", `slug must be kebab-case (a-z, 0-9, -), got ${JSON.stringify(slug)}`);
  if (takenSlugs.has(slug)) throw new DeclarationError(409, "channel_exists", `a feature or channel ${slug} already exists`);
  const name = text(body, "name", 120);
  if (takenNames.has(name.toLowerCase())) throw new DeclarationError(409, "channel_name_taken", `a feature or channel is already named ${JSON.stringify(name)}`);
  const channelType = body.channelType;
  if (!(DECLARABLE_CHANNEL_TYPES as readonly unknown[]).includes(channelType)) {
    throw bad("channel_type_unrecognised", `channelType must be one of ${DECLARABLE_CHANNEL_TYPES.join(", ")}`);
  }
  if (!(CHANNEL_OPERATORS as readonly unknown[]).includes(body.operatedBy)) throw bad("operated_by_unrecognised", `operatedBy must be one of ${CHANNEL_OPERATORS.join(", ")}`);
  if (!(CHANNEL_PERFORMERS as readonly unknown[]).includes(body.performedBy)) throw bad("performed_by_unrecognised", `performedBy must be one of ${CHANNEL_PERFORMERS.join(", ")}`);
  const input: ChannelInput = {
    slug,
    name,
    description: text(body, "description", 2000),
    shortDescription: text(body, "shortDescription", 80),
    icon: icon(body),
    channelType: channelType as DeclarableChannelType,
    operatedBy: body.operatedBy as ChannelOperator,
    performedBy: body.performedBy as ChannelPerformer,
    dailyOperatingCostCents: wholeNumber(body, "dailyOperatingCostCents", 0),
    minimumCommitmentDays: wholeNumber(body, "minimumCommitmentDays", 1),
    maxDaysToFirstProduction: wholeNumber(body, "maxDaysToFirstProduction", 0),
  };
  checkOperatorRules(input);
  return input;
}

export type ChannelPatch = Partial<
  Pick<DeclaredChannel, "name" | "description" | "shortDescription" | "icon" | "dailyOperatingCostCents" | "minimumCommitmentDays" | "maxDaysToFirstProduction" | "published">
>;

/** PURE: read an update-channel body. The slug, type and operator are the channel's identity: never patched. */
export function parseChannelPatch(body: Body, current: DeclaredChannel, takenNames: ReadonlySet<string>): ChannelPatch {
  for (const frozen of ["slug", "channelType", "operatedBy", "performedBy"]) {
    if (body[frozen] !== undefined) throw bad("field_immutable", `${frozen} cannot change: declare a new channel instead`);
  }
  const patch: ChannelPatch = {};
  const name = optionalText(body, "name", 120);
  if (name !== undefined && name !== current.name) {
    if (takenNames.has(name.toLowerCase())) throw new DeclarationError(409, "channel_name_taken", `a feature or channel is already named ${JSON.stringify(name)}`);
    patch.name = name;
  }
  const description = optionalText(body, "description", 2000);
  if (description !== undefined) patch.description = description;
  const shortDescription = optionalText(body, "shortDescription", 80);
  if (shortDescription !== undefined) patch.shortDescription = shortDescription;
  if (body.icon !== undefined) patch.icon = icon(body);
  if (body.dailyOperatingCostCents !== undefined) patch.dailyOperatingCostCents = wholeNumber(body, "dailyOperatingCostCents", 0);
  if (body.minimumCommitmentDays !== undefined) patch.minimumCommitmentDays = wholeNumber(body, "minimumCommitmentDays", 1);
  if (body.maxDaysToFirstProduction !== undefined) patch.maxDaysToFirstProduction = wholeNumber(body, "maxDaysToFirstProduction", 0);
  if (body.published !== undefined) {
    if (typeof body.published !== "boolean") throw bad("published_invalid", "published must be a boolean");
    patch.published = body.published;
  }
  checkOperatorRules({ ...current, ...patch });
  if (Object.keys(patch).length === 0) throw bad("nothing_to_update", "the body changes nothing");
  return patch;
}

// ── Trigger types ───────────────────────────────────────────────────────────────────────────────────

export interface TriggerInput {
  id: string;
  label: string;
  description: string;
  icon: string;
  kind: TriggerKind;
  fromStep: ChannelStepKey | null;
  params: Record<string, unknown> | null;
  firedBy: string;
}

/** Whether a trigger of this origin and kind is FIRED by a service today. */
export const isTriggerCoded = (t: Pick<TriggerTypeRecord, "origin" | "coded" | "kind">): boolean =>
  t.origin === "code" ? t.coded : GENERIC_DETECTOR_KINDS.has(t.kind);

/** PURE: read a create-trigger body. A declared trigger is never coded on its own say-so. */
export function parseTriggerInput(body: Body, existing: readonly TriggerTypeRecord[]): TriggerInput {
  const id = text(body, "id", 64);
  if (!TRIGGER_ID_RE.test(id)) throw bad("trigger_id_invalid", `id must be snake_case (a-z, 0-9, _), got ${JSON.stringify(id)}`);
  if (existing.some((t) => t.id === id) || CHANNEL_TRIGGER_TYPES.some((t) => t.id === id)) {
    throw new DeclarationError(409, "trigger_exists", `a trigger type ${id} already exists`);
  }
  if (body.coded !== undefined) throw bad("coded_not_declarable", "coded is not declared: a trigger is coded once a service fires its kind");
  const kind = body.kind;
  if (!(TRIGGER_KINDS as readonly unknown[]).includes(kind)) throw bad("trigger_kind_unrecognised", `kind must be one of ${TRIGGER_KINDS.join(", ")}`);
  let fromStep: ChannelStepKey | null = null;
  let params: Record<string, unknown> | null = null;
  let firedBy: string;
  if (kind === "event") {
    fromStep = body.fromStep == null ? null : step(body.fromStep, "fromStep");
    if (fromStep && existing.some((t) => t.kind === "event" && t.fromStep === fromStep)) {
      const twin = existing.find((t) => t.kind === "event" && t.fromStep === fromStep)!;
      throw new DeclarationError(409, "trigger_exists_for_step", `the trigger ${twin.id} already fires when a lead reaches ${fromStep}`);
    }
    // Nothing fires a declared event: the service that will is named by the request, or stays unknown.
    firedBy = body.firedBy === undefined ? "not_built" : text(body, "firedBy", 64);
  } else if (kind === "delay") {
    const delay = parseDelayParams(body.params);
    fromStep = delay.afterStep;
    params = delay;
    firedBy = "campaign-service";
  } else {
    params = parsePollParams(body.params);
    firedBy = "campaign-service";
  }
  return { id, label: text(body, "label", 80), description: text(body, "description", 500), icon: icon(body), kind: kind as TriggerKind, fromStep, params, firedBy };
}

export type TriggerPatch = Partial<Pick<TriggerTypeRecord, "label" | "description" | "icon">>;

/** PURE: a declared trigger's wording may change; its id, kind and parameters are what legs rely on. */
export function parseTriggerPatch(body: Body, current: TriggerTypeRecord): TriggerPatch {
  if (current.origin === "code") throw new DeclarationError(409, "trigger_coded", `${current.id} is stated in code: change it in lib/channel-triggers.ts`);
  for (const frozen of ["id", "kind", "params", "fromStep", "coded", "firedBy"]) {
    if (body[frozen] !== undefined) throw bad("field_immutable", `${frozen} cannot change: declare a new trigger instead`);
  }
  const patch: TriggerPatch = {};
  const label = optionalText(body, "label", 80);
  if (label !== undefined) patch.label = label;
  const description = optionalText(body, "description", 500);
  if (description !== undefined) patch.description = description;
  if (body.icon !== undefined) patch.icon = icon(body);
  if (Object.keys(patch).length === 0) throw bad("nothing_to_update", "the body changes nothing");
  return patch;
}

// ── Legs ────────────────────────────────────────────────────────────────────────────────────────────

/** What the leg validation needs to know about the channel it lands on. */
export interface LegChannelContext {
  slug: string;
  managed: boolean;
  /** Every leg key the channel already performs (seeded blob + declared), stored spelling. */
  legKeys: ReadonlySet<string>;
}

export interface LegInput {
  legKey: string;
  fromStep: ChannelStepKey | null;
  toStep: ChannelStepKey;
  mode: LegMode;
  triggerId: string | null;
}

/**
 * THE GUARANTEE, AT CREATION: a proactive leg names no trigger; a reactive leg names exactly one, it exists,
 * and something FIRES it today. A trigger nothing fires is refused with 409 `trigger_not_fired`, on every
 * channel (a leg nobody can start is not a leg anybody can buy).
 */
export function checkLegRun(mode: unknown, triggerId: unknown, triggers: readonly TriggerTypeRecord[]): { mode: LegMode; triggerId: string | null } {
  if (!(LEG_MODES as readonly unknown[]).includes(mode)) throw bad("mode_unrecognised", `mode must be one of ${LEG_MODES.join(", ")}`);
  if (mode === "proactive") {
    if (triggerId != null) throw bad("proactive_leg_has_trigger", "a proactive leg runs on its own budget and names no trigger");
    return { mode: "proactive", triggerId: null };
  }
  if (typeof triggerId !== "string" || triggerId === "") throw bad("trigger_required", "a reactive leg names the trigger that asks for it (triggerId)");
  const codedType = channelTriggerType(triggerId);
  const trigger = codedType ? { kind: "event" as const, origin: "code" as const, coded: codedType.coded } : triggers.find((t) => t.id === triggerId);
  if (!trigger) throw new DeclarationError(404, "trigger_not_found", `no trigger type ${triggerId}`);
  if (!isTriggerCoded(trigger)) {
    throw new DeclarationError(
      409,
      "trigger_not_fired",
      `nothing fires ${triggerId} yet (${trigger.kind === "event" ? `no service detects it` : `campaign-service runs no ${trigger.kind} detector`}): a leg on it would wait forever`,
    );
  }
  return { mode: "reactive", triggerId };
}

/** PURE: read a create-leg body for `channel`. */
export function parseLegInput(body: Body, channel: LegChannelContext, triggers: readonly TriggerTypeRecord[]): LegInput {
  const fromStep = body.fromStep === null ? null : body.fromStep === undefined ? undefined : step(body.fromStep, "fromStep");
  // Stated, never defaulted: an absent `from` read as "from nothing" would publish an entry leg by omission.
  if (fromStep === undefined) throw bad("from_step_required", "fromStep is required (null = from nothing)");
  const toStep = step(body.toStep, "toStep");
  if (fromStep === toStep) throw bad("leg_goes_nowhere", `a leg from ${toStep} to itself moves nobody`);
  const run = checkLegRun(body.mode, body.triggerId, triggers);
  const legKey = legKeyFor({ from: fromStep, to: toStep });
  // An outbound channel's `lead_found_to_*` IS its computed `start_to_*` entry leg (wave 2).
  const computed = isOutboundChannel(channel.slug) ? storedLegKeyOf(legKey) : legKey;
  if (channel.legKeys.has(computed)) throw new DeclarationError(409, "leg_exists", `${channel.slug} already performs ${legKey}`);
  return { legKey, fromStep, toStep, ...run };
}

// ── Merge into the catalogue ────────────────────────────────────────────────────────────────────────

/** The stored blob a declared channel states, exactly the shape a seeded feature's `acquisitionChannel` holds. */
function blobOf(c: DeclaredChannel, legs: readonly DeclaredLeg[]): Record<string, unknown> {
  return {
    family: FAMILY_OF_TYPE[c.channelType],
    operatedBy: c.operatedBy,
    performedBy: c.performedBy,
    stepTransitions: legs.map(transitionOf),
    terms: {
      dailyOperatingCostCents: c.dailyOperatingCostCents,
      minimumCommitmentDays: c.minimumCommitmentDays,
      maxDaysToFirstProduction: c.maxDaysToFirstProduction,
    },
  };
}

const transitionOf = (l: DeclaredLeg) => ({ from: l.fromStep, to: l.toStep, mode: l.mode, triggerId: l.triggerId });

export interface MergedCatalogueInput {
  rows: CatalogueFeatureRow[];
  shortDescriptionOf: (slug: string) => string;
  channelTypeOfSlug: (slug: string) => ChannelType;
  triggerOf: (id: string) => { coded: boolean } | null;
}

/**
 * PURE: the feature rows with every declaration merged in. `publishedOnly` (every client read): a declared
 * channel only when published, a declared leg only when it AND its channel are. A declared channel with no
 * visible leg is not a channel yet (the parser refuses a channel performing nothing), so it is left out.
 */
export function mergeDeclarations(
  featureRows: readonly CatalogueFeatureRow[],
  declared: { channels: readonly DeclaredChannel[]; legs: readonly DeclaredLeg[]; triggers: readonly TriggerTypeRecord[] },
  opts: { publishedOnly: boolean },
  base: { shortDescriptionOf: (slug: string) => string; channelTypeOfSlug: (slug: string) => ChannelType },
): MergedCatalogueInput {
  const visibleLegs = declared.legs.filter((l) => !opts.publishedOnly || l.published);
  const legsOf = (slug: string) => visibleLegs.filter((l) => l.channelSlug === slug);
  const rows: CatalogueFeatureRow[] = featureRows.map((row) => {
    const extra = legsOf(row.slug);
    if (extra.length === 0 || row.acquisitionChannel == null) return row;
    const blob = row.acquisitionChannel as Record<string, unknown>;
    return { ...row, acquisitionChannel: { ...blob, stepTransitions: [...(blob.stepTransitions as unknown[]), ...extra.map(transitionOf)] } };
  });
  const declaredBySlug = new Map<string, DeclaredChannel>();
  for (const c of declared.channels) {
    if (opts.publishedOnly && !c.published) continue;
    const legs = legsOf(c.slug);
    if (legs.length === 0) continue;
    declaredBySlug.set(c.slug, c);
    rows.push({ slug: c.slug, name: c.name, description: c.description, icon: c.icon, displayOrder: c.displayOrder, acquisitionChannel: blobOf(c, legs), supersededBySlug: null });
  }
  const declaredTriggers = new Map(declared.triggers.filter((t) => t.origin === "declared").map((t) => [t.id, t]));
  return {
    rows,
    shortDescriptionOf: (slug) => declaredBySlug.get(slug)?.shortDescription ?? base.shortDescriptionOf(slug),
    channelTypeOfSlug: (slug) => declaredBySlug.get(slug)?.channelType ?? base.channelTypeOfSlug(slug),
    // The coded list is authoritative for its own ids; a declared trigger resolves from the table.
    triggerOf: (id) => {
      const coded = channelTriggerType(id);
      if (coded) return { coded: coded.coded };
      const t = declaredTriggers.get(id);
      return t ? { coded: isTriggerCoded(t) } : null;
    },
  };
}

// ── Pricing statement ───────────────────────────────────────────────────────────────────────────────

export type LegPriceSource = "workflow_ladder" | "benchmark" | "customer_time" | "learning";

export interface LegPricing {
  /** `workflow_ladder`: a channel we run, priced per offer on its workflows (`/offers/:id/sales-paths`);
   *  `benchmark`: a sourced market figure; `customer_time`: the customer's own team, no cost to us;
   *  `learning`: nothing prices it yet, the figure is null until its campaigns record cost and outcomes. */
  source: LegPriceSource;
  /** Only a benchmark carries a figure here; every other source is priced on the reads that measure it. */
  costPerOutcomeUsd: number | null;
  benchmarkSource: string | null;
}

/** PURE: where one (channel × leg) gets its price. Never a number nobody measured or sourced. */
export function legPricingOf(channel: { slug: string; operatedBy: ChannelOperator }, legKey: string): LegPricing {
  if (MANAGED_CHANNEL_SLUGS.has(channel.slug)) return { source: "workflow_ladder", costPerOutcomeUsd: null, benchmarkSource: null };
  if (channel.operatedBy === "customer") return { source: "customer_time", costPerOutcomeUsd: null, benchmarkSource: null };
  const bench = SALES_PATH_COST_BENCHMARKS.get(`${legKey}|${channel.slug}`);
  if (bench) return { source: "benchmark", costPerOutcomeUsd: bench.costPerOutcomeUsd, benchmarkSource: bench.source };
  return { source: "learning", costPerOutcomeUsd: null, benchmarkSource: null };
}

// ── Sales paths ─────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE: read a declared sales path: an ordered list of (channel × leg) that EXIST in the catalogue (published
 * or not), chained step to step from nothing to `paid_client`, visiting no step twice. Identity = the same
 * `combinationKeyOf` spelling the offer listing serves (a platform leg `@<slug>`), so a declared path and the
 * listed row for the same legs share one key and one name.
 */
export function parseSalesPathInput(
  body: Body,
  catalogue: readonly Pick<PublicChannel, "slug" | "operatedBy" | "stepTransitions">[],
  combinationKeyOf: (legs: ReadonlyArray<{ legKey: string; channelSlug: string | null }>) => string,
): { combinationKey: string; legs: DeclaredSalesPathLeg[] } {
  const raw = body.legs;
  if (!Array.isArray(raw) || raw.length === 0) throw bad("legs_required", "legs is required: an ordered list of {channelSlug, legKey}");
  if (raw.length > 12) throw bad("legs_too_many", "a sales path has at most 12 legs");
  const legs: Array<DeclaredSalesPathLeg & { from: string | null; to: string; operatedBy: ChannelOperator }> = raw.map((entry, i) => {
    const e = (entry ?? {}) as Body;
    if (typeof e.channelSlug !== "string" || typeof e.legKey !== "string") throw bad("leg_invalid", `legs[${i}] must be {channelSlug, legKey}`);
    const channel = catalogue.find((c) => c.slug === e.channelSlug);
    if (!channel) throw new DeclarationError(404, "channel_not_found", `legs[${i}]: no channel ${e.channelSlug}`);
    // An outbound channel's leg is computed on the funnel's spelling (`start_to_*`, wave 2): both spellings name it.
    const legKey = isOutboundChannel(channel.slug) ? storedLegKeyOf(e.legKey) : e.legKey;
    const t = channel.stepTransitions.find((x) => x.legKey === legKey);
    if (!t) throw new DeclarationError(404, "leg_not_found", `legs[${i}]: ${e.channelSlug} performs no leg ${e.legKey}`);
    return { channelSlug: channel.slug, legKey, from: t.from?.key ?? null, to: t.to.key, operatedBy: channel.operatedBy };
  });
  if (legs[0].from !== null) throw bad("path_must_start", `a sales path starts from nothing; ${legs[0].legKey} starts at ${legs[0].from}`);
  const seen = new Set<string>();
  for (let i = 0; i < legs.length; i += 1) {
    if (i > 0 && legs[i].from !== legs[i - 1].to) {
      throw bad("path_not_chained", `legs[${i}] ${legs[i].legKey} starts at ${legs[i].from ?? "nothing"}, the leg before ends at ${legs[i - 1].to}`);
    }
    if (seen.has(legs[i].to)) throw bad("path_loops", `the path reaches ${legs[i].to} twice`);
    seen.add(legs[i].to);
  }
  if (legs[legs.length - 1].to !== "paid_client") throw bad("path_must_end_paid", `a sales path ends at paid_client; it ends at ${legs[legs.length - 1].to}`);
  const combinationKey = combinationKeyOf(legs.map((l) => ({ legKey: l.legKey, channelSlug: l.operatedBy === "platform" ? l.channelSlug : null })));
  return { combinationKey, legs: legs.map(({ channelSlug, legKey }) => ({ channelSlug, legKey })) };
}
