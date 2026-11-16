/**
 * chat-service's LLM cost-name catalogue (`GET /internal/llm-cost-names`): every LLM cost name it ever wrote to
 * runs-service -> the LLM dynasty that billed it (SERVED-MODEL-1116). Exact names: no cost name is ever parsed here.
 * FAIL-LOUD; held 10 minutes (moves only when chat-service deploys).
 */
import { fetchWithRetry } from "./fetch-retry.js";

const HOLD_MS = 10 * 60_000;
let held: { at: number; value: Promise<Map<string, string>> } | null = null;

/** PURE: the catalogue body as cost name -> LLM dynasty slug. */
export function parseLlmCostNames(body: unknown): Map<string, string> {
  const list = (body as { costNames?: unknown })?.costNames;
  if (!Array.isArray(list)) throw new Error("[features-service] chat-service llm-cost-names: no costNames array");
  const out = new Map<string, string>();
  for (const e of list) {
    const costName = (e as { costName?: unknown })?.costName;
    const dynasty = (e as { dynasty?: unknown })?.dynasty;
    if (typeof costName !== "string" || costName === "" || typeof dynasty !== "string" || dynasty === "") {
      throw new Error("[features-service] chat-service llm-cost-names: an entry without costName or dynasty");
    }
    out.set(costName, dynasty);
  }
  return out;
}

export function readLlmCostNames(): Promise<Map<string, string>> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/llm-cost-names`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`[features-service] chat-service llm-cost-names ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseLlmCostNames(await res.json());
  })();
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** Test seam. */
export function __resetLlmCostNamesForTest(): void {
  held = null;
}
