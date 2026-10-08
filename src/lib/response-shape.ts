/**
 * THE RESPONSE SHAPE A BUILD SERVES, as a short fingerprint every Gold cell is keyed on.
 *
 * Why: the Gold layer (lib/view-cache.ts) serves a retained cell first and refreshes behind it. Across
 * a deploy that ADDS or renames a response field, that served cell is the OLD build's body, so a
 * consumer that requires the new field fails to parse until the cell rolls (prod 2026-10-03,
 * v0.179.42: `window.spend.totalSpentCents` absent on the warm `windowDays=7` cell for minutes while a
 * cold `windowDays=8` had it).
 *
 * The fingerprint is a hash of this build's OpenAPI document (the contract every response is generated
 * against) with its PROSE removed (descriptions, summaries, examples, titles): a deploy that only edits
 * wording keeps every cell warm; one that changes a field, a type or a path keys every cell anew, so
 * the old shape is never served (a cell is cold once after such a deploy, never wrong).
 *
 * Do NOT key on a per-boot id instead: every deploy would make every cell cold (24-44 s uncached).
 */

import { createHash } from "node:crypto";
import { openApiDocument } from "./openapi.js";

const PROSE_KEYS = new Set(["description", "summary", "example", "examples", "title"]);

/** The document without its prose. Keys INSIDE a `properties` map are field names, never prose. */
export function shapeOf(value: unknown, fieldNames = false): unknown {
  if (Array.isArray(value)) return value.map((v) => shapeOf(v));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    if (!fieldNames && PROSE_KEYS.has(key)) continue;
    out[key] = shapeOf((value as Record<string, unknown>)[key], !fieldNames && key === "properties");
  }
  return out;
}

export function shapeFingerprint(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(shapeOf(document))).digest("hex").slice(0, 12);
}

let memo: string | undefined;

/** This build's response-shape fingerprint (computed once per process). */
export function responseShapeFingerprint(): string {
  return (memo ??= shapeFingerprint(openApiDocument));
}

const routeMemo = new Map<string, string>();

/** `value` with every `#/components/schemas/X` reference replaced by the schema it names (cycles kept as the ref). */
function inlineRefs(value: unknown, schemas: Record<string, unknown>, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((v) => inlineRefs(v, schemas, seen));
  if (!value || typeof value !== "object") return value;
  const ref = (value as Record<string, unknown>).$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    const name = ref.slice("#/components/schemas/".length);
    if (seen.has(name) || !(name in schemas)) return value;
    return inlineRefs(schemas[name], schemas, new Set([...seen, name]));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as object)) out[k] = inlineRefs(v, schemas, seen);
  return out;
}

/**
 * The response shape of ONE route (its responses, every referenced component inlined, prose removed), for a
 * view whose cell must survive deploys that change OTHER routes. The whole-document fingerprint re-keys every
 * cell on any shape change anywhere: on a ~4 MB brand body whose cold compute takes 9-30 s (lead families,
 * brand `75d7e3e8…`, 2026-10-08: 7 shape-changing deploys in a day, crm-service's 30 s read timed out after
 * one), that is a blocking miss on the first read after nearly every deploy. A change to THIS route's
 * response still keys the cell anew, so the old shape is never served.
 */
export function routeResponseShapeFingerprint(path: string, method = "get", document: unknown = openApiDocument): string {
  const memoKey = `${method} ${path}`;
  if (document === openApiDocument) {
    const hit = routeMemo.get(memoKey);
    if (hit) return hit;
  }
  const doc = document as { paths?: Record<string, Record<string, { responses?: unknown }>>; components?: { schemas?: Record<string, unknown> } };
  const operation = doc.paths?.[path]?.[method];
  if (!operation?.responses) throw new Error(`routeResponseShapeFingerprint: no ${method.toUpperCase()} ${path} in the OpenAPI document`);
  const fingerprint = shapeFingerprint(inlineRefs(operation.responses, doc.components?.schemas ?? {}));
  if (document === openApiDocument) routeMemo.set(memoKey, fingerprint);
  return fingerprint;
}

/** The scope-key part carrying the shape. Underscored: no route reads a `_shape` query param. */
export const SHAPE_KEY_PART = "_shape";

/** A cell key bound to a response shape. */
export function withResponseShape(scopeKey: string, fingerprint = responseShapeFingerprint()): string {
  const bar = scopeKey.indexOf("|");
  if (bar < 0) return `${scopeKey}|${SHAPE_KEY_PART}=${fingerprint}`;
  return `${scopeKey}${bar === scopeKey.length - 1 ? "" : "&"}${SHAPE_KEY_PART}=${fingerprint}`;
}

/** A key with its shape part removed — for matching a cell across builds (the keeper's replay target). */
export function withoutResponseShape(key: string): string {
  const bar = key.indexOf("|");
  if (bar < 0) return key;
  const params = new URLSearchParams(key.slice(bar + 1));
  if (!params.has(SHAPE_KEY_PART)) return key;
  params.delete(SHAPE_KEY_PART);
  return `${key.slice(0, bar)}|${params.toString()}`;
}
