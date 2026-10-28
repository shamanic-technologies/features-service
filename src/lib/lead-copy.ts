/**
 * A LIVE COPY of a scope's compact lead population, kept current through lead-service's change feed
 * (`GET /orgs/leads/changes`, lead-service v0.81.15) instead of re-read whole on every refresh.
 *
 * WHY. A campaign Overview refresh walked the brand's whole population — ~18k rows on the busiest
 * brand, four pages one after another, 5-9s — and that walk was the floor under every Overview view
 * (features-service#1045). Nearly none of those rows change between two refreshes a few seconds apart.
 * The feed answers "what changed since this cursor" in 20-300ms, so a copy held here and patched with
 * the delta returns the same rows the full walk would, at a small fraction of the cost to both sides.
 *
 * WHAT IT RETURNS. Row for row what `GET /orgs/leads?view=compact` returns for the same scope — the
 * producer guarantees every feed element IS the compact row, and a snapshot + its deltas reproduce a
 * full read (verified in prod on 18,146 rows). The ORDER is not the walk's: the snapshot comes
 * id-ordered, a changed row keeps its place and a new row is appended. Every consumer aggregates or
 * sorts (the engine's leads/events carry their own deterministic sort), so no figure depends on it.
 *
 * WHEN IT IS USED. Only inside a `servedCached` view compute ({@link withLiveLeadCopy}) — the
 * interactive views a customer polls — and only for a scope READ OFTEN ENOUGH TO PAY FOR ITS FEED
 * ({@link liveCopyPaysFor}). The fleet sweeps (cross-org revenue, customer health, the return
 * snapshots) keep the plain walk: opening a feed per brand there would make lead-service keep dozens
 * of feeds warm for nobody watching them. A fleet read may still be served a copy this process
 * synced within the walk-hold window ({@link peekLeadCopy}): no call at all, same freshness bound.
 *
 * WHAT A FEED COSTS lead-service (BOX-LOAD-1028-FEATURES-LEADREADS). One read keeps the feed warm
 * 30 min, and a warm feed is RECONCILED (the whole scope re-read and re-hashed, as heavy as a walk)
 * every 3 min: one read of a scope nobody reads again costs ~10 whole-scope reads, a walk costs one.
 * Measured 2026-10-28: 49 feeds warm, 44 of them read once in a burst (cells of ~40 brands computed
 * together) and never again, so most of lead-service's reconcile work kept feeds warm for nobody. A
 * feed pays for itself only on a scope read at least every ~3 min; any other interactive read walks
 * the scope FRESH (a held walk only if taken inside the same 30 s read instant).
 *
 * BOUNDS. The copies live in this process's 384 MB heap, so they are capped by TOTAL ROWS
 * ({@link LEAD_COPY_MAX_ROWS}, least-recently-read evicted first) and dropped once nobody has read
 * them for {@link LEAD_COPY_IDLE_MS}. An evicted scope is simply re-snapshotted on its next read —
 * the cost the walk paid on every read before.
 *
 * FAIL LOUD. Any feed error propagates, as the walk's did: a copy we could not bring current is not
 * served. A `full: true` answer (the producer dropped or replaced the feed) REPLACES the copy.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CompactLeadRow {
  id: string;
  leadId: string;
  [key: string]: unknown;
}

interface ChangesAnswer {
  full: boolean;
  reason?: string | null;
  cursor: string | null;
  leads: CompactLeadRow[];
  removed: string[];
}

interface LeadCopy {
  cursor: string | null;
  rows: Map<string, CompactLeadRow>;
  lastReadAt: number;
  /** When this copy was last brought current (the instant its sync was asked). */
  syncedAt: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Total rows held across every copy. The largest brand is ~50k; two of those plus change fit. */
export const LEAD_COPY_MAX_ROWS = positiveIntEnv("LEAD_COPY_MAX_ROWS", 120_000);
/** A copy nobody read for this long is dropped (lead-service keeps its feed warm 30 min). */
export const LEAD_COPY_IDLE_MS = positiveIntEnv("LEAD_COPY_IDLE_MS", 15 * 60_000);

/**
 * A scope's feed is opened (or kept advancing) only once it was read at {@link LEAD_COPY_OPEN_READS}
 * distinct instants within {@link LEAD_COPY_OPEN_WINDOW_MS}, i.e. at least every ~3 min: below that
 * rate a fresh walk per read costs lead-service less than the reconciles a warm feed costs. Reads less
 * than {@link LEAD_COPY_READ_GAP_MS} apart are ONE instant (one compute reads a scope several times).
 */
export const LEAD_COPY_OPEN_READS = positiveIntEnv("LEAD_COPY_OPEN_READS", 3);
export const LEAD_COPY_OPEN_WINDOW_MS = positiveIntEnv("LEAD_COPY_OPEN_WINDOW_MS", 6 * 60_000);
export const LEAD_COPY_READ_GAP_MS = positiveIntEnv("LEAD_COPY_READ_GAP_MS", 30_000);

/** Per scope key: the distinct read instants inside the window, oldest first. */
const readInstants = new Map<string, number[]>();

/** What the copy decision did since the last log window (read by the walk log, lib/lead-walk-hold.ts). */
export const liveCopyCounters = { copyReads: 0, freshWalks: 0, fleetPeeks: 0 };

/**
 * Record an interactive read of `key` and say whether the live copy pays for it (see the module doc).
 * The answer only picks HOW the rows are read (feed vs fresh walk); both return the scope's current rows.
 */
export function liveCopyPaysFor(key: string, now = Date.now()): boolean {
  const since = now - LEAD_COPY_OPEN_WINDOW_MS;
  const kept = (readInstants.get(key) ?? []).filter((t) => t > since);
  const last = kept[kept.length - 1];
  if (last === undefined || now - last >= LEAD_COPY_READ_GAP_MS) kept.push(now);
  readInstants.delete(key);
  readInstants.set(key, kept);
  // Bounded: scopes not read inside the window are forgotten, oldest first.
  if (readInstants.size > 512) {
    for (const [k, list] of readInstants) {
      if (readInstants.size <= 512) break;
      if (k !== key && (list[list.length - 1] ?? 0) <= since) readInstants.delete(k);
    }
  }
  return kept.length >= LEAD_COPY_OPEN_READS;
}

/**
 * The rows of a copy this process brought current less than `maxAgeMs` ago, WITHOUT asking lead-service
 * (so no feed is kept warm by it), else undefined. For the fleet reads, whose held walk states the same
 * bound: a copy synced inside it is at least as current as the walk the hold would serve.
 */
export function peekLeadCopy(key: string, maxAgeMs: number, now = Date.now()): CompactLeadRow[] | undefined {
  if (maxAgeMs <= 0 || process.env.LEAD_COPY_ENABLED === "false") return undefined;
  const copy = copies.get(key);
  if (!copy || now - copy.syncedAt >= maxAgeMs || inFlightSyncs.has(key)) return undefined;
  return [...copy.rows.values()];
}

/** Least-recently-read first: a Map keeps insertion order and a read re-inserts. */
const copies = new Map<string, LeadCopy>();
const inFlightSyncs = new Map<string, Promise<CompactLeadRow[]>>();

const liveCopyScope = new AsyncLocalStorage<true>();

/** Run `fn` with interactive lead reads served from a live copy (see the module doc). */
export function withLiveLeadCopy<T>(fn: () => Promise<T>): Promise<T> {
  return liveCopyScope.run(true, fn);
}

/**
 * Run the pre-cache reads of an interactive request (the reads that build a view's cache KEY — the
 * brand's channel set, the funnels it is priced on) under the same downstream-read sharing a view
 * compute gets (lib/fetch-retry.ts): a campaign list is reused 30s and re-read behind the answer, so a
 * dashboard poll no longer waits on campaign-service before it can even look the cell up.
 */
export function withInteractiveReads<T>(fn: () => Promise<T>): Promise<T> {
  return liveCopyScope.run(true, fn);
}

/**
 * Run `fn` OUTSIDE any interactive view scope: a fleet sweep started from inside a view compute (a
 * single-flight build shared by later callers) must walk each brand, never open a live copy per brand.
 */
export function outsideInteractiveView<T>(fn: () => Promise<T>): Promise<T> {
  return liveCopyScope.exit(fn);
}

/** Whether the current async context is an interactive view compute (see withLiveLeadCopy). */
export function insideInteractiveView(): boolean {
  return liveCopyScope.getStore() === true;
}

/**
 * Whether the current async context asked for the live copy. `LEAD_COPY_ENABLED=false` switches the
 * copy off process-wide (every read walks, as before) — the test suites use it, and it is the
 * operational kill switch should the feed misbehave.
 */
export function liveLeadCopyRequested(): boolean {
  if (process.env.LEAD_COPY_ENABLED === "false") return false;
  return liveCopyScope.getStore() === true;
}

/** Test seam. */
export function __resetLeadCopies(): void {
  copies.clear();
  inFlightSyncs.clear();
  fingerprints.clear();
  readInstants.clear();
  liveCopyCounters.copyReads = 0;
  liveCopyCounters.freshWalks = 0;
  liveCopyCounters.fleetPeeks = 0;
}

/**
 * Drop every live copy and delivery fingerprint held for these orgs. A brand transfer moves lead rows
 * between orgs inside lead-service, and a copy's change-feed cursor has no promise to report rows that
 * left its scope that way — so the copy is discarded and the next read re-snapshots. Returns how many
 * copies were dropped.
 */
export function dropLeadCopiesForOrgs(orgIds: readonly string[]): number {
  const prefixes = orgIds.map((o) => `${o}|`);
  const owned = (key: string) => prefixes.some((p) => key.startsWith(p));
  let dropped = 0;
  for (const key of [...copies.keys()]) if (owned(key)) { copies.delete(key); dropped++; }
  for (const key of [...inFlightSyncs.keys()]) if (owned(key)) inFlightSyncs.delete(key);
  for (const key of [...fingerprints.keys()]) if (owned(key)) fingerprints.delete(key);
  for (const key of [...readInstants.keys()]) if (owned(key)) readInstants.delete(key);
  return dropped;
}

/** Test / diagnostics seam — how many rows each copy holds. */
export function __leadCopySizes(): Record<string, number> {
  return Object.fromEntries([...copies].map(([k, c]) => [k, c.rows.size]));
}

function evict(now: number, keep: string): void {
  for (const [key, copy] of copies) {
    if (key !== keep && now - copy.lastReadAt > LEAD_COPY_IDLE_MS) copies.delete(key);
  }
  let total = 0;
  for (const copy of copies.values()) total += copy.rows.size;
  for (const [key, copy] of copies) {
    if (total <= LEAD_COPY_MAX_ROWS) break;
    if (key === keep) continue;
    copies.delete(key);
    total -= copy.rows.size;
  }
}

/**
 * The scope's compact rows, current as of this call. `fetchChanges(since)` performs ONE
 * `GET /orgs/leads/changes` for the scope (with `since` when given) and returns its parsed answer;
 * the caller owns the URL, the identity headers and the process-wide slot limiter.
 */
export async function readLeadCopy(
  key: string,
  fetchChanges: (since: string | null) => Promise<ChangesAnswer>,
): Promise<CompactLeadRow[]> {
  const existing = inFlightSyncs.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const now = Date.now();
    const copy = copies.get(key);
    let answer: ChangesAnswer;
    try {
      answer = await fetchChanges(copy?.cursor ?? null);
    } catch (error) {
      // lead-service refuses a cursor it now attributes to ANOTHER feed than the one this scope opens
      // (400 "since belongs to a different scope than this read names"). The cursor is dead; a read
      // with no cursor is, by its contract, the whole scope — so re-snapshot instead of failing every
      // refresh of every view that reads this scope. Measured in prod 2026-09-26: `offer-revenue` and
      // `revenue-grouped` refreshes failed on it and kept serving an ever older body.
      if (!copy?.cursor || !/different scope/i.test((error as Error).message)) throw error;
      console.warn(`[features-service] lead copy cursor refused (${(error as Error).message}); re-snapshotting the scope`);
      copies.delete(key);
      answer = { ...(await fetchChanges(null)), full: true };
    }
    if (!Array.isArray(answer.leads) || !Array.isArray(answer.removed)) {
      throw new Error("lead-service /orgs/leads/changes returned no leads/removed arrays");
    }

    let rows: Map<string, CompactLeadRow>;
    if (answer.full || !copy) {
      rows = new Map();
    } else {
      rows = copy.rows;
    }
    for (const id of answer.removed) rows.delete(id);
    for (const row of answer.leads) {
      if (typeof row?.id !== "string") throw new Error("lead-service /orgs/leads/changes row has no id");
      rows.set(row.id, row);
    }

    copies.delete(key);
    copies.set(key, { cursor: answer.cursor, rows, lastReadAt: now, syncedAt: now });
    evict(now, key);
    return [...rows.values()];
  })();

  inFlightSyncs.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inFlightSyncs.get(key) === pending) inFlightSyncs.delete(key);
  }
}

// ── Per-email delivery fingerprints ─────────────────────────────────────────────────────────────
//
// email-gateway's `/orgs/status` answers first-occurrence timestamps per email (first contacted /
// sent / delivered / opened / clicked / replied). A first-occurrence timestamp only moves when the
// matching delivery flag flips, and the compact row carries every one of those flags from the same
// evidence. So the fingerprint of an email's flags, taken off the live copy, says exactly which
// emails a timestamp read has to ask again (email-status-client.ts) — instead of all ~18k.

const FINGERPRINT_FLAGS = ["contacted", "sent", "delivered", "opened", "clicked", "bounced", "unsubscribed", "replied", "replyClassification"] as const;

const fingerprints = new Map<string, Map<string, string>>();

/** The fingerprint key for a (org, brand, single campaign or none) scope. */
export function fingerprintScopeKey(orgId: string, brandId: string, campaignId: string | undefined): string {
  return `${orgId}|${brandId}|${campaignId ?? ""}`;
}

/** Record the email → delivery-flag fingerprint of a copy's rows (every row of one email joined). */
export function registerEmailFingerprints(scopeKey: string, rows: readonly CompactLeadRow[]): void {
  const parts = new Map<string, string[]>();
  for (const row of rows) {
    const email = typeof row.email === "string" ? row.email : "";
    if (!email) continue;
    const fp = FINGERPRINT_FLAGS.map((f) => String(row[f] ?? "")).join(",");
    const list = parts.get(email);
    if (list) list.push(fp);
    else parts.set(email, [fp]);
  }
  const out = new Map<string, string>();
  for (const [email, list] of parts) out.set(email, list.sort().join(";"));
  fingerprints.delete(scopeKey);
  fingerprints.set(scopeKey, out);
  // Bounded by the copies themselves: one fingerprint set per live scope, oldest dropped first.
  while (fingerprints.size > 64) fingerprints.delete(fingerprints.keys().next().value!);
}

/** The scope's email fingerprints, when a live copy recorded them in this process. */
export function emailFingerprints(scopeKey: string): Map<string, string> | undefined {
  return fingerprints.get(scopeKey);
}
