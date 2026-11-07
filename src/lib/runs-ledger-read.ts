/**
 * ONE read per runs-service ledger URL, process-wide (LEDGER-LOAD-1107-FEATURES).
 *
 * Since LEDGER-ONLY-1107 every figure reads runs-service's general ledger (`/internal/stats/outcome-costs`, its
 * reconciliation, its performers). Each reader held its OWN copy: the brand ledger per (brand, basis) although gross and
 * net parse the SAME two bodies, a campaign's by-day read twice (scope ledger + Today's milestone cards), the ledger book
 * per basis (gross, net, vendor, unpriced: four times the same month reads), the fleet totals not at all (Research mature
 * then flash, the hourly index recorder: the same 10 MB read back to back). Each of those is a multi-second statement on
 * runs-service's database (prod 2026-11-07: 6.6 runs_service backends busy on average, load5 51 on 8 cores).
 *
 * Here a GET of the same URL (path + query; the api key is the process's) is asked ONCE: concurrent askers share the
 * in-flight request, and a successful body is answered to every asker for `holdMs` from the moment it ARRIVED (never longer
 * than the reader's own hold before this module: each call site passes the hold it already had). A failed answer is
 * never held: the next asker goes to runs-service itself. The body is parsed once and handed to every asker: READ-ONLY
 * (every parser of it builds new objects). Figures are byte-identical: the same wire body gives the same parse, whoever
 * asks first.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export type LedgerAnswer =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; text: string };

interface Held {
  /** When the answer arrived (null while in flight). */
  at: number | null;
  holdMs: number;
  answer: Promise<LedgerAnswer>;
}

const store = new Map<string, Held>();
/** Per-path counts since boot: asked (every call), sent (went to runs-service), shared (answered from a held/in-flight read). */
const counts = new Map<string, { asked: number; sent: number }>();

function pathKeyOf(path: string): string {
  return path.split("?")[0]!;
}

let lastLogAt = Date.now();

function count(path: string, sent: boolean): void {
  const k = pathKeyOf(path);
  const c = counts.get(k) ?? counts.set(k, { asked: 0, sent: 0 }).get(k)!;
  c.asked += 1;
  if (sent) c.sent += 1;
  if (Date.now() - lastLogAt >= 10 * 60_000) {
    lastLogAt = Date.now();
    console.log(`[features-service] runs ledger reads since boot (asked/sent): ${runsLedgerReadCounts().map((x) => `${x.path} ${x.asked}/${x.sent}`).join(", ")}`);
  }
}

/** Test seam + kill switch: `RUNS_LEDGER_SHARE=false` sends every ask to runs-service (the pre-1107 behaviour). */
function sharingOn(): boolean {
  return process.env.RUNS_LEDGER_SHARE !== "false";
}

/**
 * The answer of runs-service to `GET <RUNS_SERVICE_URL><path>`, shared process-wide. `holdMs` = how long a successful
 * body keeps answering (0 = in-flight sharing only).
 */
export function readRunsLedger(path: string, holdMs: number): Promise<LedgerAnswer> {
  if (!sharingOn()) {
    count(path, true);
    return send(path);
  }
  const now = Date.now();
  const h = store.get(path);
  if (h && (h.at === null || now - h.at < h.holdMs)) {
    count(path, false);
    return h.answer;
  }
  count(path, true);
  const answer = send(path);
  const mine: Held = { at: null, holdMs, answer };
  store.set(path, mine);
  answer.then(
    (a) => {
      if (store.get(path) !== mine) return;
      if (!a.ok || holdMs <= 0) store.delete(path);
      else mine.at = Date.now();
    },
    () => {
      if (store.get(path) === mine) store.delete(path);
    },
  );
  // Reap expired entries now and then (keys carry ids: brands, campaigns, days).
  if (store.size > 2_000) for (const [k, v] of store) if (v.at !== null && now - v.at >= v.holdMs) store.delete(k);
  return answer;
}

/** One campaign's by-day ledger: ONE read for its scope ledger (`scope-outcome-ledger-io.ts`) and Today's milestone cards (`campaign-ledger-units-client.ts`). */
export function campaignLedgerByDayPath(campaignId: string): string {
  return `/internal/stats/outcome-costs?groupBy=outcomeKey,day&campaignId=${encodeURIComponent(campaignId)}`;
}

/** The JSON body of a successful read, else throws `[features-service] runs-service <path> <status>: <text>`. */
export async function readRunsLedgerJson(path: string, holdMs: number): Promise<unknown> {
  const a = await readRunsLedger(path, holdMs);
  if (!a.ok) throw new Error(`[features-service] runs-service ${pathKeyOf(path)} ${a.status}: ${a.text.slice(0, 200)}`);
  return a.json;
}

async function send(path: string): Promise<LedgerAnswer> {
  const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}${path}`, { headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" } }, { backgroundShare: false });
  if (!r.ok) return { ok: false, status: r.status, text: await r.text() };
  return { ok: true, status: r.status, json: await r.json() };
}

/** Since-boot counts per runs-service path (asked vs sent): logged every 10 min, the load audit's after-figure. */
export function runsLedgerReadCounts(): Array<{ path: string; asked: number; sent: number }> {
  return [...counts].map(([path, c]) => ({ path, ...c })).sort((a, b) => b.sent - a.sent);
}

/** Test seam. */
export function __resetRunsLedgerReads(): void {
  store.clear();
  counts.clear();
}
