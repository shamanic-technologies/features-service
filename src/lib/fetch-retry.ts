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
 * `fetch` with a connect-phase retry on transient network rejections.
 * Drop-in replacement for `fetch(input, init)` — same signature, same return.
 * A non-transient rejection (or exhausted retries) propagates unchanged.
 */
export async function fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt >= BACKOFF_MS.length || !isTransient(err)) throw err;
      await delay(BACKOFF_MS[attempt]);
    }
  }
}
