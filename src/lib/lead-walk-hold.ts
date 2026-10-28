/**
 * A WHOLE-POPULATION LEAD WALK, HELD A FEW MINUTES FOR THE FLEET SWEEPS THAT ASK FOR IT AGAIN.
 *
 * WHY. Outside an interactive view (lib/lead-copy.ts) every `fetchLeadsForRevenue` walks lead-service's
 * `GET /orgs/leads?view=compact` page by page, and lead-service hydrates every row of every page. The
 * fleet sweeps each walk EVERY (org, brand) pair brand-wide, several of them per 15-min cycle, and some
 * several times per pair: the cross-org revenue roll-up, the return snapshots (once per channel AND once
 * per declared funnel, one after another), the workflow return pipelines, customer health (revenue,
 * audience stats, projection persons), the fleet person cell, the internal pipe fleet and outcome prices,
 * in each of the two processes. Measured on lead-service 2026-10-27 (BOX-DB-LOAD-1027-FEATURES-LEADS):
 * ~98k page statements and 63M hydrated rows a day, ~1,500 of its 6,722 DB-minutes. Every one of those
 * walks of one pair inside a few minutes reads the same rows.
 *
 * WHAT IT DOES. The first walk of a scope is kept, gzipped, for {@link leadWalkHoldMs} (10 min): any
 * NON-interactive read of the exact same request (org + URL) inside that window is served the very rows
 * that walk returned, decoded from the held bytes, so lead-service is not asked again. The same rows go
 * through the same mapping, so every figure is the one the walk would have produced on that data.
 *
 * FRESHNESS. 10 min sits below every fleet sweep's own fresh window (15 min): a sweep's figures are at
 * most as old as the window its cell already states. Interactive views never read it — they read the
 * live copy, patched every poll — and neither does anything inside one (`insideInteractiveView`).
 *
 * BOUNDS. Held bodies are gzipped Buffers, i.e. memory OUTSIDE the V8 heap the process caps
 * (`--max-old-space-size`), bounded by TOTAL BYTES ({@link leadWalkHoldMaxBytes}, oldest first out). The
 * whole fleet's compact population (~400k rows) gzips to a few tens of MB, so a sweep cycling over every
 * pair does not evict what the next sweep needs. Nothing is held past its window: an expired entry is
 * dropped on the next store.
 *
 * NOT A FALLBACK. A failed walk is not held and propagates (fail loud); a held entry is never served past
 * its window, whatever happens to lead-service.
 *
 * Kill switch / test default: `LEAD_WALK_HOLD_MS=0` (every read walks, as before).
 */
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createSlotLimiter } from "./concurrency.js";
import { liveCopyCounters } from "./lead-copy.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** How long a walk is held. 0 = off. Read at call time so a suite (or the operator) can switch it. */
export function leadWalkHoldMs(): number {
  return nonNegativeIntEnv("LEAD_WALK_HOLD_MS", 10 * 60_000);
}

/** Total gzipped bytes held across every scope. */
export function leadWalkHoldMaxBytes(): number {
  return nonNegativeIntEnv("LEAD_WALK_HOLD_MAX_BYTES", 96 * 1024 * 1024);
}

interface HeldWalk {
  body: Buffer;
  pages: number;
  heldAt: number;
}

/** Oldest first: a Map keeps insertion order and a store re-inserts. */
const held = new Map<string, HeldWalk>();
let heldBytes = 0;
const inFlight = new Map<string, Promise<unknown[]>>();
/**
 * A held hit decodes a whole population (a ~25 MB string, then its parse) in one go, where a walk built it
 * page by page behind the lead-read slots: at most as many decodes at once as walks may read at once.
 */
const decodeSlots = createSlotLimiter(4);

/** What lead-service was actually asked, and what the hold spared it — since boot and per log window. */
interface WalkCounters {
  walks: number;
  pagesRead: number;
  heldHits: number;
  pagesSpared: number;
}
const sinceBoot: WalkCounters = { walks: 0, pagesRead: 0, heldHits: 0, pagesSpared: 0 };
let windowCounters: WalkCounters = { walks: 0, pagesRead: 0, heldHits: 0, pagesSpared: 0 };
let windowStartedAt = Date.now();
const LOG_EVERY_MS = 10 * 60_000;

function count(field: keyof WalkCounters, n: number): void {
  sinceBoot[field] += n;
  windowCounters[field] += n;
  const now = Date.now();
  if (now - windowStartedAt < LOG_EVERY_MS) return;
  const w = windowCounters;
  const asked = w.pagesRead + w.pagesSpared;
  console.log(
    `[features-service] lead walks, last ${Math.round((now - windowStartedAt) / 60_000)} min: ` +
      `${w.pagesRead} lead-service pages read (${w.walks} walks), ${w.heldHits} reads served from a held walk ` +
      `sparing ${w.pagesSpared} pages (${asked} pages asked without the hold); held ${held.size} scopes, ${heldBytes} bytes; ` +
      `interactive reads: ${liveCopyCounters.copyReads} from a live copy, ${liveCopyCounters.freshWalks} fresh walks (scope not read often enough to keep a feed); ` +
      `${liveCopyCounters.fleetPeeks} fleet reads served from a live copy`,
  );
  windowCounters = { walks: 0, pagesRead: 0, heldHits: 0, pagesSpared: 0 };
  liveCopyCounters.copyReads = 0;
  liveCopyCounters.freshWalks = 0;
  liveCopyCounters.fleetPeeks = 0;
  windowStartedAt = now;
}

/** Test / diagnostics seam. */
export function __leadWalkCounters(): WalkCounters & { heldScopes: number; heldBytes: number } {
  return { ...sinceBoot, heldScopes: held.size, heldBytes };
}

/** Test seam. */
export function __resetLeadWalkHold(): void {
  held.clear();
  inFlight.clear();
  decoded.clear();
  decoding.clear();
  decodeCounters.decodes = 0;
  decodeCounters.reused = 0;
  heldBytes = 0;
  for (const c of [sinceBoot, windowCounters]) {
    c.walks = 0;
    c.pagesRead = 0;
    c.heldHits = 0;
    c.pagesSpared = 0;
  }
}

/** Drop every walk held for these orgs (a brand transfer moves lead rows between orgs). */
export function dropHeldLeadWalksForOrgs(orgIds: readonly string[]): number {
  const prefixes = orgIds.map((o) => `${o}|`);
  let dropped = 0;
  for (const [key, entry] of [...held]) {
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    held.delete(key);
    heldBytes -= entry.body.length;
    dropped++;
  }
  return dropped;
}

function store(key: string, entry: HeldWalk, holdMs: number, maxBytes: number): void {
  const previous = held.get(key);
  if (previous) {
    held.delete(key);
    heldBytes -= previous.body.length;
  }
  if (entry.body.length > maxBytes) return;
  held.set(key, entry);
  heldBytes += entry.body.length;
  const now = Date.now();
  for (const [k, e] of held) {
    if (heldBytes <= maxBytes && now - e.heldAt < holdMs) continue;
    if (k === key) continue;
    held.delete(k);
    heldBytes -= e.body.length;
  }
}

/**
 * ONE DECODE PER HELD WALK, NOT ONE PER READ (BOX-CPU-1028-FEATURES).
 *
 * WHY. Every held hit used to gunzip and `JSON.parse` the whole population again — a 5k-50k row array per
 * read, 300-600 reads per 10 min (one brand is read ~12× per sweep cycle, several of them in the SAME compute:
 * workflow-projection asks the brand-wide persons and the brand-wide repliers concurrently). A CPU profile of
 * the refresher in prod 2026-10-28 put that decode, its parse and the garbage it left at the top of the
 * process (~0.6-1.4 cores for the container), and N concurrent decodes of one big brand held N copies of it
 * in a heap that already dies of OOM a few times a day.
 *
 * WHAT. Concurrent reads of one held walk share ONE decode (in flight), and the decoded array is remembered
 * through a `WeakRef` tied to the exact held entry: a later read of the same walk reuses it while the GC has
 * not reclaimed it, else decodes as before. The rows are the same rows the decode would return (they came
 * from this very body, or are what the body was made of), and every caller only READS them (leads-client maps
 * each row into a new person; nothing writes a row), so no figure can move. A WeakRef holds nothing alive:
 * the heap bound is the one this module always had.
 */
interface Decoded {
  entry: HeldWalk;
  rows: WeakRef<unknown[]>;
}
const decoded = new Map<string, Decoded>();
const decoding = new Map<string, { entry: HeldWalk; rows: Promise<unknown[]> }>();
const decodeCounters = { decodes: 0, reused: 0 };

function rememberDecoded(key: string, entry: HeldWalk, rows: unknown[]): void {
  decoded.set(key, { entry, rows: new WeakRef(rows) });
  // Forget references to walks no longer held (their arrays are already collectable).
  for (const [k, d] of decoded) if (held.get(k) !== d.entry) decoded.delete(k);
}

function decodedRows(key: string, entry: HeldWalk): Promise<unknown[]> {
  const known = decoded.get(key);
  if (known && known.entry === entry) {
    const rows = known.rows.deref();
    if (rows) {
      decodeCounters.reused += 1;
      return Promise.resolve(rows);
    }
  }
  const pending = decoding.get(key);
  if (pending && pending.entry === entry) {
    decodeCounters.reused += 1;
    return pending.rows;
  }
  decodeCounters.decodes += 1;
  const rows = decodeSlots.run(async () => JSON.parse((await gunzipAsync(entry.body)).toString("utf8")) as unknown[]);
  const flight = { entry, rows };
  decoding.set(key, flight);
  void rows
    .then((r) => {
      if (held.get(key) === entry) rememberDecoded(key, entry, r);
    })
    .catch(() => undefined)
    .finally(() => {
      if (decoding.get(key) === flight) decoding.delete(key);
    });
  return rows;
}

/** Test / diagnostics seam: held reads that decoded the body vs reused a decode. */
export function __leadWalkDecodeCounters(): { decodes: number; reused: number } {
  return { ...decodeCounters };
}

/** Record a walk that went to lead-service (called by the walker itself, once per walk actually run). */
export function countLeadWalk(pages: number): void {
  count("walks", 1);
  count("pagesRead", pages);
}

/**
 * The rows of the walk named by `key` (org + exact request URL): a held walk of the same request taken
 * less than {@link leadWalkHoldMs} ago, else a fresh `walk()` that is then held. Concurrent asks of one
 * key share one walk. `walk` counts the pages it really reads ({@link countLeadWalk}).
 *
 * `maxAgeMs` (an interactive read, lib/lead-copy.ts: the same READ INSTANT, 30 s) takes a held walk only
 * that young, else walks now (or joins the walk already in flight) — and HOLDS what it read, so the fleet
 * sweeps asking the same request in the next minutes read it instead of walking again.
 */
export async function heldLeadWalk<Row>(
  key: string,
  walk: () => Promise<{ rows: Row[]; pages: number }>,
  opts: { maxAgeMs?: number } = {},
): Promise<Row[]> {
  const holdMs = leadWalkHoldMs();
  if (holdMs === 0) return (await walk()).rows;
  const entry = held.get(key);
  if (entry && Date.now() - entry.heldAt < Math.min(holdMs, opts.maxAgeMs ?? holdMs)) {
    count("heldHits", 1);
    count("pagesSpared", entry.pages);
    return decodedRows(key, entry) as Promise<Row[]>;
  }
  const pending = inFlight.get(key);
  if (pending) return (await pending) as Row[];

  const run = (async () => {
    const heldAt = Date.now();
    const { rows, pages } = await walk();
    const body = await gzipAsync(Buffer.from(JSON.stringify(rows), "utf8"), { level: 1 });
    const entry: HeldWalk = { body, pages, heldAt };
    store(key, entry, holdMs, leadWalkHoldMaxBytes());
    // The rows this walk just built ARE what a decode of its held body returns: a read of the same key while
    // they are still alive reuses them instead of decoding (see `decodedRows`).
    rememberDecoded(key, entry, rows);
    return rows;
  })();
  inFlight.set(key, run);
  try {
    return (await run) as Row[];
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}
