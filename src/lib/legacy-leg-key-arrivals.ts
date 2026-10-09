/**
 * EVERY ARRIVAL OF A LEGACY OUTBOUND LEG KEY IS LOGGED (outbound leg rename, owner 2026-10-09; the rename
 * itself lives in `lib/funnel-legs.ts`).
 *
 * Wave 2 stores and serves `lead_found_to_conversation` / `lead_found_to_website_visit` for an OUTBOUND
 * channel and still ACCEPTS the legacy `start_to_conversation` / `start_to_website_visit` on input. The owner
 * switches that tolerance off once we MEASURE that nobody sends the legacy spelling any more (7 days with
 * zero arrivals), never on a guessed date. This module is the measurement: one `warn` line carrying the
 * literal marker `legacy-outbound-leg-key` per arrival, nothing else changes (the value is still accepted
 * and resolved exactly as before). A week with no such line in the container log = safe to drop it.
 *
 * WHAT COUNTS as an arrival: a legacy key that names an OUTBOUND channel's leg, wherever it arrives:
 *  - a request (`legacyLegKeyArrivalsMiddleware`, before every router): query, body and path, values AND
 *    object keys, the channel read nearest first (a combination key's own `leg@slug`, a campaign key's
 *    `campaign:<slug>|<leg>`, the nearest object stating a channel slug, then the route's channel);
 *  - a sibling's read this service tolerates it on (`noteLegacyOutboundLegKeys`, campaign-service campaign
 *    rows, brand-service selected combinations).
 * NOT an arrival: the new spelling, a non-outbound channel's `start_to_*` (Google Ads, SEO, organic, PR keep
 * it), and a `start_to_*` with no channel at all (a funnel's own entry leg, still its real name).
 */
import type { NextFunction, Request, Response } from "express";
import { CHANNEL_TYPED_SLUGS, isOutboundChannel } from "./channel-types.js";
import { LEGACY_OUTBOUND_LEG_KEYS } from "./funnel-legs.js";
import { routeChannelOf } from "./served-leg-keys.js";

export const LEGACY_OUTBOUND_LEG_KEY_MARKER = "legacy-outbound-leg-key";

const CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNEL_TYPED_SLUGS);
const asChannel = (v: unknown): string | null => (typeof v === "string" && CHANNEL_SLUGS.has(v) ? v : null);

/** A legacy key as a token, optionally followed by its combination channel (`@slug`). */
const TOKEN = new RegExp(`(?:campaign:([a-z0-9-]+)\\|)?\\b(${LEGACY_OUTBOUND_LEG_KEYS.join("|")})\\b(?:@([a-z0-9-]+))?`, "g");
const CHEAP_GATE = new RegExp(LEGACY_OUTBOUND_LEG_KEYS.join("|"));

/** One legacy key found, with the outbound channel it names. */
export interface LegacyLegKeyHit {
  legKey: string;
  channel: string;
}

function ownChannel(node: Record<string, unknown>): string | null {
  const channel = node.channel;
  return (
    asChannel(node.featureSlug) ??
    asChannel(node.channelSlug) ??
    (channel && typeof channel === "object" ? asChannel((channel as Record<string, unknown>).slug) : null) ??
    asChannel(node.slug)
  );
}

function hitsInString(text: string, channel: string | null, out: LegacyLegKeyHit[]): void {
  if (!CHEAP_GATE.test(text)) return;
  for (const m of text.matchAll(TOKEN)) {
    const ch = asChannel(m[1]) ?? asChannel(m[3]) ?? (m[3] ? null : channel);
    if (isOutboundChannel(ch)) out.push({ legKey: m[2], channel: ch as string });
  }
}

function walk(node: unknown, channel: string | null, out: LegacyLegKeyHit[], depth: number): void {
  if (depth > 32) return;
  if (typeof node === "string") return hitsInString(node, channel, out);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, channel, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const own = ownChannel(obj) ?? channel;
  for (const [k, v] of Object.entries(obj)) {
    hitsInString(k, own, out);
    walk(v, own, out, depth + 1);
  }
}

/** Every legacy outbound leg key in a value (query, body, sibling payload), `channel` = the context's own. */
export function legacyOutboundLegKeysIn(value: unknown, channel: string | null = null): LegacyLegKeyHit[] {
  const out: LegacyLegKeyHit[] = [];
  walk(value, asChannel(channel), out, 0);
  return out;
}

/** Who sent it: whatever identity the caller stated (absent fields omitted, never guessed). */
export interface LegacyLegKeyCaller {
  service?: string | null;
  orgId?: string | null;
  runId?: string | null;
  userAgent?: string | null;
}

/** Write ONE `warn` line per distinct (key, channel) in `hits`. */
export function noteLegacyOutboundLegKeys(hits: LegacyLegKeyHit[], where: { source: string; route: string; caller?: LegacyLegKeyCaller }): void {
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = `${hit.legKey}|${hit.channel}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const caller = Object.fromEntries(Object.entries(where.caller ?? {}).filter(([, v]) => v != null && v !== ""));
    console.warn(
      `[features-service] ${LEGACY_OUTBOUND_LEG_KEY_MARKER} ${JSON.stringify({
        legKey: hit.legKey,
        channel: hit.channel,
        source: where.source,
        route: where.route,
        caller,
      })}`,
    );
  }
}

const header = (req: Request, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
};

/** Mounted before every router (after `express.json()`): logs, never alters the request. */
export function legacyLegKeyArrivalsMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const route = `${req.method} ${req.path}`;
    const channel = routeChannelOf(req) ?? asChannel((req.body as Record<string, unknown> | undefined)?.featureSlug);
    const hits = legacyOutboundLegKeysIn({ query: req.query, body: req.body, path: req.path }, channel);
    if (hits.length > 0) {
      noteLegacyOutboundLegKeys(hits, {
        source: "request",
        route,
        caller: {
          service: header(req, "x-service-name") ?? header(req, "x-caller-service"),
          orgId: header(req, "x-org-id"),
          runId: header(req, "x-run-id"),
          userAgent: header(req, "user-agent"),
        },
      });
    }
  } catch (err) {
    // A measurement must never refuse a request; the failure itself is loud.
    console.error(`[features-service] ${LEGACY_OUTBOUND_LEG_KEY_MARKER} detection failed:`, err);
  }
  next();
}
