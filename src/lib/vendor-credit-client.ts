/**
 * WHICH LLM VENDORS chat-service STATES OUT OF CREDIT right now (WRITER-PICK-VENDOR-CREDIT-1105, owner 2026-11-05: the
 * Threads pipe published nothing for 2 days, the pick answered Kimi K2 while chat-service reported Moonshot out of
 * credit, every write a 502). chat-service owns the fact (VENDOR-CREDIT-1030, `GET /internal/vendor-credit`: one row
 * per vendor it tracks, `outOfCredit` while the latest outage is not recovered); this service holds no vendor list.
 *
 * Held 60 s (a run-time reader calls it once per send; a recovered vendor comes back within a minute). FAIL-SOFT for the
 * pick: unreadable = `null` (logged loudly), the pick then answers as before the read existed, since a write to a vendor
 * out of credit fails at chat-service anyway and is retried, while an unreadable read must not stop every writer.
 */
import { fetchWithRetry } from "./fetch-retry.js";

const HOLD_MS = 60_000;
let held: { at: number; value: Promise<Set<string>> } | null = null;

/** PURE: the providers chat-service's read states out of credit (lower-cased). */
export function outOfCreditProviders(body: unknown): Set<string> {
  const vendors = (body as { vendors?: unknown })?.vendors;
  if (!Array.isArray(vendors)) throw new Error("chat-service vendor-credit: no vendors array");
  const out = new Set<string>();
  for (const v of vendors as Array<{ provider?: unknown; outOfCredit?: unknown }>) {
    if (typeof v.provider === "string" && v.outOfCredit === true) out.add(v.provider.toLowerCase());
  }
  return out;
}

/** The providers out of credit now. FAIL-LOUD (the caller decides). */
export function readOutOfCreditProviders(): Promise<Set<string>> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/vendor-credit?days=1`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`chat-service vendor-credit ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return outOfCreditProviders(await res.json());
  })();
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** The providers out of credit now, or null when chat-service could not be read (logged). */
export async function readOutOfCreditProvidersSoft(label: string): Promise<Set<string> | null> {
  try {
    return await readOutOfCreditProviders();
  } catch (error) {
    console.error(`[features-service] ${label}: chat-service vendor credit unreadable, picking without it:`, (error as Error).message);
    return null;
  }
}

/** Test seam. */
export function __resetVendorCreditForTest(): void {
  held = null;
}
