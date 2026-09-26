import { createHash } from "node:crypto";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * A BRAND'S FACTS FINGERPRINT — a cheap answer to "has anything a money figure is computed from
 * changed since this cell was computed?", so a stale cell whose facts did not move is served without
 * re-running a whole-population compute.
 *
 * WHY. A cell a customer is looking at went stale on a clock (3s for a campaign's views, 30s for the
 * rest) and every stale read recomputed the brand's whole population behind the answer, whether or not
 * a single fact had landed — an Overview left open overnight recomputed every few seconds for nothing.
 *
 * WHAT IT READS — three O(1)-to-cheap answers, each already maintained by its owner:
 *   - runs-service  `GET /internal/org-actual-total` — the org's actualized platform spend (O(1), 5-45ms
 *     measured). It moves when a cost is actualized.
 *   - lead-service  `GET /orgs/leads/bucket-counts` and `/standing-counts` for the brand — answered from
 *     lead-service's kept read model (0.2-0.6s measured), which applies a person's statement on the very
 *     next read and delivery evidence within its own bound. They move when a lead is served or contacted,
 *     replies, clicks, converts, is stated won/lost/disqualified, or opts out.
 * NOT the org's committed (actual + provisioned) total: that read is an 800ms aggregate scan on
 * runs-service's database and a new hold coincides with a lead being contacted, which the counts see.
 *
 * WHAT IT CANNOT SEE — and why a gated cell still has a ceiling (`FACTS_GATE_MAX_MS`, the keeper's
 * `view-cache.ts` gate): a provisioned hold cancelled without anything else moving, a stated deal value
 * edited on a lead already won, an audience edited in human-service, and every CROSS-ORG input (the
 * fleet benchmark behind the projected cost columns). None of those moves these three answers, so a
 * cell is recomputed at the latest `FACTS_GATE_MAX_MS` after its last compute whatever the fingerprint
 * says. The economics a body is priced on are NOT here: they are already in every economics-driven
 * cell's KEY (`econ` / `decl`), so a write to them lands on a new cell.
 *
 * FAIL SOFT, BY DESIGN — and not the swallowed error the fail-loud rule forbids: a fingerprint we
 * could not read is `null`, and `null` means "gate nothing", i.e. recompute exactly as before this
 * module existed. No figure is ever derived from it; the worst outcome of a failure is the old load.
 */

/** How long one brand's fingerprint is reused across the cells that ask for it. */
const FINGERPRINT_REUSE_MS = 10_000;

interface Entry {
  at: number;
  value: Promise<string | null>;
}

const cache = new Map<string, Entry>();

/** Test seam. */
export function __resetFactsFingerprints(): void {
  cache.clear();
}

export interface FactsIdentity {
  orgId: string;
  brandId: string;
  userId?: string;
  runId?: string;
}

/** The brand's facts fingerprint, or null when any source could not be read (see the module doc). */
export function factsFingerprint(identity: FactsIdentity): Promise<string | null> {
  const key = `${identity.orgId}|${identity.brandId}`;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > FINGERPRINT_REUSE_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = readFingerprint(identity);
  cache.set(key, { at: now, value });
  return value;
}

async function readFingerprint(identity: FactsIdentity): Promise<string | null> {
  const runsUrl = process.env.RUNS_SERVICE_URL;
  const runsKey = process.env.RUNS_SERVICE_API_KEY;
  const leadUrl = process.env.LEAD_SERVICE_URL;
  const leadKey = process.env.LEAD_SERVICE_API_KEY;
  if (!runsUrl || !runsKey || !leadUrl || !leadKey) return null;

  const leadHeaders: Record<string, string> = {
    "x-api-key": leadKey,
    "x-org-id": identity.orgId,
    "x-brand-id": identity.brandId,
  };
  if (identity.userId) leadHeaders["x-user-id"] = identity.userId;
  if (identity.runId) leadHeaders["x-run-id"] = identity.runId;
  const brand = encodeURIComponent(identity.brandId);

  try {
    const answers = await Promise.all([
      readJson(`${runsUrl}/internal/org-actual-total?org_id=${encodeURIComponent(identity.orgId)}`, { "x-api-key": runsKey }),
      readJson(`${leadUrl}/orgs/leads/bucket-counts?brandId=${brand}`, leadHeaders),
      readJson(`${leadUrl}/orgs/leads/standing-counts?brandId=${brand}`, leadHeaders),
    ]);
    return fingerprintOf(answers);
  } catch (err) {
    console.warn(
      `[features-service] facts fingerprint unavailable for brand ${identity.brandId} (recomputing as before): ${(err as Error).message}`,
    );
    return null;
  }
}

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithRetry(url, { headers }, { timeoutMs: 10_000 });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Keys whose value is the answer's TIME, not a fact — excluded so an unchanged brand hashes the same. */
const VOLATILE_KEYS = new Set(["as_of", "asOf", "generatedAt", "computedAt"]);

/** A stable hash of the answers, ignoring their timestamps (exported for tests). */
export function fingerprintOf(answers: readonly unknown[]): string {
  return createHash("sha256").update(stableStringify(answers)).digest("hex").slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !VOLATILE_KEYS.has(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The brand a request is about: `/brands/:id` in the path, else `brandId` in the query, else the header. */
export function brandIdOfRequest(url: string, headers: Record<string, string>): string | null {
  const parsed = new URL(url, "http://local");
  const inPath = /^\/brands\/([^/]+)/.exec(parsed.pathname)?.[1];
  const candidate = inPath ?? parsed.searchParams.get("brandId") ?? headers["x-brand-id"] ?? null;
  return candidate && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate.toLowerCase() : null;
}
