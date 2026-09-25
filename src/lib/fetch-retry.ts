import { insideInteractiveView } from "./lead-copy.js";
import { mergeCostAnswers, PAST_PART_REUSE_MS, splitLifetimeCostUrl } from "./runs-cost-split.js";
/**
 * Connect-phase retry for downstream HTTP calls to Neon-backed sibling services
 * (lead-service, brand-service, runs-service, email-gateway, instantly, campaign,
 * press-kits, journalists, workflow-service).
 *
 * Those siblings can be temporarily unreachable during cold starts, deploys, or
 * Neon-backed boot windows. The TCP connection is reset / refused / times out
 * before the service is reachable, so `fetch` rejects with `TypeError: fetch
 * failed` whose `cause` carries the transient code — `ECONNREFUSED` /
 * `ECONNRESET` (observed), `ETIMEDOUT` (Node-20 happy-eyeballs 250ms attempt
 * window), or undici's `UND_ERR_CONNECT_TIMEOUT`.
 *
 * features-service's revenue path composes the pipeline total from a `Promise.all`
 * of lead/brand/runs/email-gateway calls and FAILS LOUD (502) on any rejection —
 * so a single transient reset blocks `GET /features/:slug/revenue` entirely. This
 * was the prod incident: lead-service mid-cold-start → `computeFeatureRevenue`
 * `fetchLeadsForRevenue` threw `ECONNREFUSED` → endpoint 502'd.
 *
 * We retry ONLY a thrown (connect-phase) failure, never a completed HTTP
 * response: an HTTP 5xx is a real answer the server already produced and may
 * have side-effected on. A connect-phase rejection means the request never
 * reached the server, so the retry is write-safe.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];

/**
 * A transient network error from `fetch` is wrapped in `cause` (and for
 * happy-eyeballs, an `AggregateError` with per-address sub-errors under
 * `.errors`). Walk both funnels, guarding against cycles.
 */
function isTransient(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const cause = (cur as { cause?: unknown }).cause;
    if (cause !== undefined) stack.push(cause);
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors)) stack.push(...errors);
  }
  return false;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `timeoutMs` — ABORT the request after that long instead of merely giving up on it.
 *
 * undici's default 300s headers timeout makes the CLIENT stop waiting; it does not tell the server
 * to stop working. A downstream that is still building a large response then keeps a connection —
 * and, behind it, a database backend — busy writing to a client nobody is reading, which is how one
 * slow read turns into an exhausted pool over there. An `AbortSignal` destroys the socket, so the
 * downstream's write fails immediately and it releases what it was holding.
 *
 * The signal is minted FRESH PER ATTEMPT: a single pre-made signal would already be aborted on the
 * retry, turning one slow attempt into an instant failure of every remaining one. An abort is NOT a
 * transient connect-phase error, so it propagates loudly rather than being retried.
 */
export interface FetchRetryOptions {
  timeoutMs?: number;
  /**
   * Inside an interactive view compute, reuse this read's successful answer for this long and
   * re-read it BEHIND the answer once it ages (served up to twice this old while re-read). For a
   * slow-moving input (an audience's members, their outcome flags) that a view refreshing every few
   * seconds would otherwise re-ask every time. Also applies to a POST (keyed on its body) — only for
   * a read-only POST, which is the only kind a call site may mark.
   */
  shareForMs?: number;
}

/**
 * `fetch` with a connect-phase retry on transient network rejections.
 * Drop-in replacement for `fetch(input, init)` — same signature, same return.
 * A non-transient rejection (or exhausted retries) propagates unchanged.
 */
/**
 * SHARED READS ACROSS THE VIEWS OF ONE REFRESH (features-service#1045).
 *
 * A campaign Overview polls five views at once and they ask several siblings the IDENTICAL question
 * (the brand's cost per workflow, the workflow catalogue, the fleet benchmark…) — 121 of 440
 * downstream calls of one refresh were exact duplicates. Inside an interactive view compute, a GET
 * with the same URL and the same headers is answered once: concurrent askers share the in-flight
 * request, and a successful answer is reused for {@link sharedReadMs} (3s by default — shorter than
 * one dashboard poll, so no figure is held back a refresh). A failed answer is never reused.
 * `DOWNSTREAM_READ_SHARE_MS=0` switches it off (the test suites do).
 */
function sharedReadMs(): number {
  const raw = process.env.DOWNSTREAM_READ_SHARE_MS;
  if (raw === undefined || raw === "") return 3_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3_000;
}

interface SharedAnswer {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

interface SharedEntry {
  at: number;
  ttl: number;
  revalidate: boolean;
  settled: boolean;
  refreshing: boolean;
  answer: Promise<SharedAnswer>;
}

const sharedReads = new Map<string, SharedEntry>();

function sharedKey(input: string, init?: RequestInit, allowBody = false): string | null {
  const method = (init?.method ?? "GET").toUpperCase();
  if (!allowBody && (method !== "GET" || init?.body)) return null;
  if (init?.body !== undefined && init?.body !== null && typeof init.body !== "string") return null;
  // Only a plain header object can be keyed faithfully; anything else is never shared.
  const raw = init?.headers;
  if (raw !== undefined && (raw instanceof Headers || Array.isArray(raw))) return null;
  const headers = Object.entries((raw as Record<string, string> | undefined) ?? {})
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${method} ${input}\n${JSON.stringify(headers)}\n${(init?.body as string | undefined) ?? ""}`;
}

/** Test seam. */
export function __resetSharedReads(): void {
  sharedReads.clear();
}

export async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const ttl = sharedReadMs();
  const key = ttl > 0 && insideInteractiveView() ? sharedKey(input, init, opts?.shareForMs !== undefined) : null;
  if (key === null) return fetchWithRetryOnce(input, init, opts);
  if (opts?.shareForMs !== undefined) {
    return toResponse(await readShared(input, init, opts, Math.max(ttl, opts.shareForMs), true));
  }

  // A lifetime runs cost aggregate is answered as past + today (lib/runs-cost-split.ts).
  const split = splitLifetimeCostUrl(input);
  if (split) {
    const [past, today] = await Promise.all([
      readShared(split.past, init, opts, Math.max(ttl, PAST_PART_REUSE_MS), true),
      readShared(split.today, init, opts, ttl),
    ]);
    if (past.status >= 400) return toResponse(past);
    if (today.status >= 400) return toResponse(today);
    const merged = mergeCostAnswers(
      JSON.parse(new TextDecoder().decode(past.body)),
      JSON.parse(new TextDecoder().decode(today.body)),
    );
    return new Response(JSON.stringify(merged), { status: 200, headers: { "content-type": "application/json" } });
  }
  return toResponse(await readShared(input, init, opts, ttl));
}

async function readShared(
  input: string,
  init: RequestInit | undefined,
  opts: FetchRetryOptions | undefined,
  ttl: number,
  // Serve a successful answer up to 2 × ttl old while ONE background read replaces it — used for
  // the past half of a lifetime cost read, so no refresh ever waits on the expensive scan.
  revalidate = false,
): Promise<SharedAnswer> {
  const key = sharedKey(input, init, true)!;

  const now = Date.now();
  for (const [k, v] of sharedReads) if (now - v.at > (v.revalidate ? 2 * v.ttl : v.ttl)) sharedReads.delete(k);
  let entry = sharedReads.get(key);
  if (entry && revalidate && now - entry.at > ttl && !entry.refreshing && entry.settled) {
    entry.refreshing = true;
    const stale = entry;
    const next = fetchWithRetryOnce(input, init, opts).then(async (res) => ({
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body: await res.arrayBuffer(),
    }));
    next.then(
      (a) => {
        if (a.status < 400 && sharedReads.get(key) === stale) {
          sharedReads.set(key, { at: Date.now(), ttl, revalidate, settled: true, refreshing: false, answer: Promise.resolve(a) });
        } else {
          stale.refreshing = false;
        }
      },
      (err) => {
        console.error(`[features-service] background re-read failed (serving the previous answer): ${(err as Error).message}`);
        stale.refreshing = false;
      },
    );
    return stale.answer;
  }
  if (!entry) {
    const answer = fetchWithRetryOnce(input, init, opts).then(async (res) => ({
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body: await res.arrayBuffer(),
    }));
    entry = { at: now, ttl, revalidate, settled: false, refreshing: false, answer };
    sharedReads.set(key, entry);
    const mine = entry;
    // A failed read is never reused: drop it so the next asker goes to the sibling itself.
    answer.then(
      (a) => {
        mine.settled = true;
        if (a.status >= 400 && sharedReads.get(key) === mine) sharedReads.delete(key);
      },
      () => {
        if (sharedReads.get(key) === mine) sharedReads.delete(key);
      },
    );
  }
  return entry.answer;
}

function toResponse(a: SharedAnswer): Response {
  return new Response(a.body.byteLength === 0 && (a.status === 204 || a.status === 304) ? null : a.body.slice(0), {
    status: a.status,
    statusText: a.statusText,
    headers: a.headers,
  });
}

async function fetchWithRetryOnce(
  input: string,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const signal = opts?.timeoutMs === undefined ? init?.signal : AbortSignal.timeout(opts.timeoutMs);
      return await fetch(input, signal === undefined ? init : { ...init, signal });
    } catch (err) {
      if (attempt >= BACKOFF_MS.length || !isTransient(err)) throw err;
      await delay(BACKOFF_MS[attempt]);
    }
  }
}
