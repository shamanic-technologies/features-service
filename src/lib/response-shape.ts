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
