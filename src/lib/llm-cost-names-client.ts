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

/**
 * PURE: the catalogue body as cost name -> the concrete model id(s) billed under it (MODEL-TAG-EVERY-AI-MESSAGE-1126:
 * the model that ACTUALLY wrote a message is read off the cost names its writing run was billed). Several ids only
 * when a vendor's preview and GA shared one name.
 */
export function parseLlmCostNameModels(body: unknown): Map<string, string[]> {
  parseLlmCostNames(body);
  const out = new Map<string, string[]>();
  for (const e of (body as { costNames: Array<{ costName: string; modelIds?: unknown }> }).costNames) {
    const ids = Array.isArray(e.modelIds) ? e.modelIds.filter((m): m is string => typeof m === "string" && m !== "") : [];
    if (ids.length === 0) throw new Error(`[features-service] chat-service llm-cost-names: ${e.costName} names no modelIds`);
    out.set(e.costName, ids);
  }
  return out;
}

let heldBody: { at: number; value: Promise<unknown> } | null = null;

function readBody(): Promise<unknown> {
  if (heldBody && Date.now() - heldBody.at < HOLD_MS) return heldBody.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/llm-cost-names`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`[features-service] chat-service llm-cost-names ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<unknown>;
  })();
  heldBody = { at: Date.now(), value };
  value.catch(() => {
    if (heldBody?.value === value) heldBody = null;
  });
  return value;
}

export function readLlmCostNames(): Promise<Map<string, string>> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  const value = readBody().then(parseLlmCostNames);
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** cost name -> the concrete model id(s) billed under it. FAIL-LOUD, same hold. */
export function readLlmCostNameModels(): Promise<Map<string, string[]>> {
  return readBody().then(parseLlmCostNameModels);
}

/** Test seam. */
export function __resetLlmCostNamesForTest(): void {
  held = null;
  heldBody = null;
}
