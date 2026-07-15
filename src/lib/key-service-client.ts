import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Resolve a decrypted PLATFORM key for a provider via key-service — the fleet's single source for
 * secrets that live on the admin app's Vercel env (the admin registers each `{provider, envVar}` into
 * key-service at startup; every backend then reads them here rather than duplicating the secret into its
 * own Railway env). Platform keys are global (no org/user identity), but the `X-Caller-*` headers are
 * required for provider-requirements tracking. Mirrors ahref-service `getPlatformKey`.
 *
 * FAIL-LOUD: missing config / transport / non-OK (incl. 404 = provider not registered yet) / malformed
 * all throw. Callers that treat the key as optional display-enrichment (e.g. the customer-health board's
 * PostHog return signal) wrap this soft; callers that require it let it propagate.
 */
export interface CallerInfo {
  service: string;
  method: string;
  path: string;
}

const TIMEOUT_MS = 30_000;

export async function getPlatformKey(provider: string, caller: CallerInfo): Promise<string> {
  const url = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("KEY_SERVICE_URL or KEY_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(
    `${url.replace(/\/$/, "")}/keys/platform/${encodeURIComponent(provider)}/decrypt`,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "x-caller-service": caller.service,
        "x-caller-method": caller.method,
        "x-caller-path": caller.path,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`key-service GET /keys/platform/${provider}/decrypt failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { provider?: string; key?: string };
  if (!data.key || typeof data.key !== "string") {
    throw new Error(`key-service returned malformed platform key for "${provider}"`);
  }
  return data.key;
}
