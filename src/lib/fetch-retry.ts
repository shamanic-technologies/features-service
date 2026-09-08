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
}

/**
 * `fetch` with a connect-phase retry on transient network rejections.
 * Drop-in replacement for `fetch(input, init)` — same signature, same return.
 * A non-transient rejection (or exhausted retries) propagates unchanged.
 */
export async function fetchWithRetry(
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
