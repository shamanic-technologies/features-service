/**
 * EVERY RESPONSE SERVES AN OUTBOUND LEG IN ITS NEW SPELLING — ONE CHOKE POINT (outbound leg rename,
 * wave 2, LOCKED owner 2026-10-09; the rename itself lives in `lib/funnel-legs.ts`).
 *
 * Computation keeps running on the funnel's leg (`start_to_conversation` is the entry leg of every funnel
 * outbound feeds), so the translation to what an OUTBOUND channel's leg IS (`lead_found_to_conversation`:
 * a sourcing channel performs Start -> Lead found, the outbound one Lead found -> Positive reply) happens
 * once, on the way out, in `res.json` (`servedLegKeysMiddleware`). A field-by-field translation in each of
 * the ~50 builders would leave the next field added on the legacy spelling; one walk over the served body
 * cannot. The Gold cells keep the computed body; the translation is applied to what they serve.
 *
 * WHICH CHANNEL a leg key belongs to is read from the body itself, nearest first:
 *  - a combination key (`leg@slug+...`) and a campaign key (`campaign:<slug>|<leg>`) carry their own;
 *  - a sales-path row's chain (`pathKey`, `legKeys`, `entryLegKey`) is its combination's ENTRY channel;
 *  - otherwise the nearest object stating a channel slug (`featureSlug`, `channelSlug`, `channel.slug`, a
 *    channel row's `slug`; only a slug of the channel typology counts, a workflow slug never does);
 *  - otherwise the route's own channel (`/features/:featureSlug/...`, `?featureSlug=`).
 * No channel known = verbatim: a funnel's own entry leg (`/public/channels` `funnels[]`, an offer's ticked
 * legs) names no channel and stays `start_to_*`, and so does every non-outbound channel's.
 *
 * A leg re-spelled out of nothing (`fromStep: null` / `from: null` beside it) now starts on Lead found,
 * so that step is filled in, in the shape its sibling `toStep` / `to` is served in.
 */
import type { NextFunction, Request, Response } from "express";
import { CHANNEL_STEPS } from "./acquisition-channels.js";
import { CHANNEL_TYPED_SLUGS } from "./channel-types.js";
import {
  LEGACY_OUTBOUND_LEG_KEYS,
  entryChannelOfCombinationKey,
  servedCampaignKeyOf,
  servedCombinationKeyOf,
  servedLegKeyOf,
} from "./funnel-legs.js";

const CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNEL_TYPED_SLUGS);

/** A string field holding ONE leg key. */
const LEG_FIELDS = new Set(["legKey", "entryLegKey"]);
/** A field holding a LIST of leg keys. */
const LEG_LIST_FIELDS = new Set(["legKeys", "pricedThroughLegKeys", "returnPathLegKeys"]);
/** A chain of leg keys joined by `+`. */
const CHAIN_FIELDS = new Set(["pathKey"]);
/** A combination key, or a list of them. */
const COMBINATION_FIELDS = new Set(["combinationKey", "roiCombinationKey", "combinationKeys"]);
/** A campaign key, or a list of them. */
const CAMPAIGN_KEY_FIELDS = new Set(["campaignKey", "sourceCampaignKey", "sourceCampaignKeys"]);
/** The fields a sales-path row's chain lives in: their channel is the combination's entry channel. */
const PATH_ROW_FIELDS = new Set(["pathKey", "legKeys", "entryLegKey"]);

const LEGACY_PATTERN = new RegExp(LEGACY_OUTBOUND_LEG_KEYS.map((k) => `\\b${k}\\b`).join("|"));

const asChannel = (v: unknown): string | null => (typeof v === "string" && CHANNEL_SLUGS.has(v) ? v : null);

/** The channel an object itself states, or null. */
function ownChannel(node: Record<string, unknown>): string | null {
  const channel = node.channel;
  return (
    asChannel(node.featureSlug) ??
    asChannel(node.channelSlug) ??
    (channel && typeof channel === "object" ? asChannel((channel as Record<string, unknown>).slug) : null) ??
    asChannel(node.slug)
  );
}

/** Lead found, in the shape its sibling step is served in (an object with the same keys, or the bare key). */
function leadFoundLike(sibling: unknown): unknown {
  if (typeof sibling === "string") return "lead_found";
  if (!sibling || typeof sibling !== "object") return null;
  const def = CHANNEL_STEPS.lead_found as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.keys(sibling as object).map((k) => [k, def[k] ?? null]));
}

function walk(node: unknown, channel: string | null): unknown {
  if (Array.isArray(node)) return node.map((item) => walk(item, channel));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const own = ownChannel(obj) ?? channel;
  const pathChannel = typeof obj.combinationKey === "string" ? entryChannelOfCombinationKey(obj.combinationKey) : own;
  const out: Record<string, unknown> = {};
  let respelled = false;
  for (const [k, v] of Object.entries(obj)) {
    const ch = PATH_ROW_FIELDS.has(k) ? pathChannel : own;
    if (LEG_FIELDS.has(k) && typeof v === "string") {
      out[k] = servedLegKeyOf(ch, v);
      if (out[k] !== v) respelled = true;
    } else if (LEG_LIST_FIELDS.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === "string" ? servedLegKeyOf(ch, x) : walk(x, own)));
    } else if (CHAIN_FIELDS.has(k) && typeof v === "string") {
      out[k] = v
        .split("+")
        .map((leg) => servedLegKeyOf(ch, leg))
        .join("+");
    } else if (COMBINATION_FIELDS.has(k) && (typeof v === "string" || Array.isArray(v))) {
      out[k] = typeof v === "string" ? servedCombinationKeyOf(v) : v.map((x) => (typeof x === "string" ? servedCombinationKeyOf(x) : walk(x, own)));
    } else if (CAMPAIGN_KEY_FIELDS.has(k) && (typeof v === "string" || Array.isArray(v))) {
      out[k] = typeof v === "string" ? servedCampaignKeyOf(v) : v.map((x) => (typeof x === "string" ? servedCampaignKeyOf(x) : walk(x, own)));
    } else {
      out[k] = walk(v, own);
    }
  }
  if (respelled) {
    if ("fromStep" in out && out.fromStep === null) out.fromStep = leadFoundLike(out.toStep);
    if ("from" in out && out.from === null && "to" in out) out.from = leadFoundLike(out.to);
  }
  return out;
}

/** True when a JSON text holds a legacy outbound spelling anywhere (the cheap gate before any walk). */
export function hasLegacyOutboundLegKey(text: string): boolean {
  return LEGACY_PATTERN.test(text);
}

/** A JSON TEXT in its served spelling (parsed, walked, re-stringified only when it holds a legacy key). */
export function servedJsonTextOf(text: string, routeChannel: string | null = null): string {
  return hasLegacyOutboundLegKey(text) ? JSON.stringify(walk(JSON.parse(text), asChannel(routeChannel))) : text;
}

/** The served JSON TEXT of a body: stringified once; walked only when the text holds a legacy outbound
 *  spelling at all, so a body without one costs nothing extra. */
export function servedJsonText(body: unknown, routeChannel: string | null = null): string | undefined {
  const text = JSON.stringify(body);
  return text === undefined ? undefined : servedJsonTextOf(text, routeChannel);
}

/**
 * A JSON-able body with every outbound leg key in its served spelling. `routeChannel` is the route's own
 * channel (null when the route names none).
 */
export function serveOutboundLegKeys<T>(body: T, routeChannel: string | null = null): T {
  const text = servedJsonText(body, routeChannel);
  return text === undefined ? body : (JSON.parse(text) as T);
}

/** The channel a request names: `/features/:featureSlug/...` (internal too), else `?featureSlug=`. */
export function routeChannelOf(req: Pick<Request, "path" | "query"> | undefined): string | null {
  if (!req || typeof req.path !== "string") return null;
  const m = /^\/(?:internal\/)?features\/([^/]+)\//.exec(req.path);
  if (m) return asChannel(decodeURIComponent(m[1]));
  return asChannel(req.query?.featureSlug);
}

/** Mounted before every router: every `res.json` body goes out in the served spelling (same headers and
 *  body as Express's own `res.json` with default settings, stringified once). */
export function servedLegKeysMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.json = ((body: unknown) => {
    const text = servedJsonText(body, routeChannelOf(req));
    if (!res.get("Content-Type")) res.set("Content-Type", "application/json");
    return res.send(text);
  }) as Response["json"];
  next();
}
