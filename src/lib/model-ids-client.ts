/**
 * chat-service's served models (`GET /internal/model-ids`): the concrete id, the public name, the vendor it comes from,
 * its capability tier and the aliases a workflow names it by. One reader for every surface naming a model (Research,
 * the client's "who wrote this message"). Held 10 minutes: the list moves only when chat-service deploys a model.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { ModelIdRow } from "./research/writers.js";

export interface ServedModel extends ModelIdRow {
  /** chat-service's vendor id (`anthropic`, `google`, `openai`...). */
  provider: string;
  capabilityTier: string;
}

const HOLD_MS = 10 * 60_000;
let held: { at: number; value: Promise<ServedModel[]> } | null = null;

export function readModelIds(): Promise<ServedModel[]> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/model-ids`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`chat-service model-ids ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { models?: Array<{ modelId: string; displayName: string; provider?: string; capabilityTier: string; aliases?: string[]; formerAliases?: string[] }> };
    if (!Array.isArray(body.models)) throw new Error("chat-service model-ids: no models array");
    return body.models.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      provider: m.provider ?? "",
      capabilityTier: m.capabilityTier,
      aliases: m.aliases ?? [],
      formerAliases: m.formerAliases ?? [],
    }));
  })();
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** Test seam. */
export function __resetModelIdsForTest(): void {
  held = null;
}
