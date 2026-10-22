/**
 * LLM DYNASTIES (LLM-DYNASTY-1022-FS, owner 2026-10-22: « Les stats par modèles continuent à faire du sens mais ce qui
 * nous intéressera le plus ce sont les stats par dynasties de LLM. »). chat-service states every LLM dynasty (one vendor
 * line: Gemini Flash, Claude Opus...) with its versions newest first, its head and the legacy aliases workflows wrote
 * before dynasties (`GET /internal/model-dynasties`, LLM-DYNASTY-1022). A Research model bar and the leg writer ranking's
 * LLM row are a DYNASTY: every version's people, outcomes and spend pool into it (the template dynasty rule), so a new
 * version (Gemini 3.7 Flash -> 3.8 Flash) carries what the line already proved. Per-model rows stay as the detail.
 *
 * Which dynasty a name belongs to is chat-service's ONLY (no local table, no name parsing): a dynasty slug, any of its
 * versions' model ids, or one of its legacy aliases. A name chat-service does not place keeps its own bar (`dynasty:
 * null`), never guessed into a line.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface LlmDynasty {
  slug: string;
  name: string;
  provider: string;
  capabilityTier: string;
  /** The newest version a current name serves (for a line nothing serves any more, its last version). */
  headModelId: string;
  /** True when the slug answers chat-service `/complete` and runs the head. */
  servedToday: boolean;
  /** Every version, newest first. */
  models: Array<{ modelId: string; displayName: string; servedToday: boolean }>;
  /** Names workflows wrote before dynasties; each still runs the dynasty's head at chat-service. */
  legacyAliases: string[];
}

export type LlmDynastyReason = "llm_dynasties_unreadable";

export interface LlmDynastyIndex {
  /** A model id, dynasty slug or legacy alias → its dynasty (null = chat-service places it in none). */
  dynastyOfName: (name: string) => LlmDynasty | null;
  bySlug: (slug: string) => LlmDynasty | null;
  dynasties: readonly LlmDynasty[];
  /** Set when the dynasties could not be read: every model is its own bar then. */
  unavailableReason: LlmDynastyReason | null;
}

/**
 * PURE. The index over chat-service's dynasties. A name resolves in chat-service's own order (`resolveModel`): a SERVED
 * dynasty's slug, then a version's model id (retired versions included: history), then a served dynasty's legacy alias,
 * then whatever line still names it. So `deepseek-pro`, the slug of a line nothing serves and a legacy alias of DeepSeek
 * Flash, files under DeepSeek Flash, the model it runs; the concrete id `deepseek-v4-pro` files under DeepSeek Pro.
 */
export function llmDynastyIndex(read: readonly LlmDynasty[] | LlmDynastyReason): LlmDynastyIndex {
  if (typeof read === "string") return { dynastyOfName: () => null, bySlug: () => null, dynasties: [], unavailableReason: read };
  const bySlug = new Map(read.map((d) => [d.slug, d]));
  const byModel = new Map<string, LlmDynasty>();
  const byServedAlias = new Map<string, LlmDynasty>();
  const byAnyAlias = new Map<string, LlmDynasty>();
  for (const d of read) {
    for (const m of d.models) if (!byModel.has(m.modelId)) byModel.set(m.modelId, d);
    for (const a of d.legacyAliases) {
      if (d.servedToday && !byServedAlias.has(a)) byServedAlias.set(a, d);
      if (!byAnyAlias.has(a)) byAnyAlias.set(a, d);
    }
  }
  const served = (d: LlmDynasty | undefined) => (d?.servedToday ? d : undefined);
  return {
    dynastyOfName: (name) => served(bySlug.get(name)) ?? byModel.get(name) ?? byServedAlias.get(name) ?? bySlug.get(name) ?? byAnyAlias.get(name) ?? null,
    bySlug: (slug) => bySlug.get(slug) ?? null,
    dynasties: read,
    unavailableReason: null,
  };
}

/** No dynasty read (tests, a pipe built before them): every model is its own bar. */
export const NO_LLM_DYNASTIES: LlmDynastyIndex = llmDynastyIndex([]);

const HOLD_MS = 10 * 60_000;
let held: { at: number; value: Promise<LlmDynasty[]> } | null = null;

/** chat-service's LLM dynasties (api key, no identity). FAIL-LOUD; held 10 minutes (moves only when chat-service deploys). */
export function readLlmDynasties(): Promise<LlmDynasty[]> {
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CHAT_SERVICE_URL}/internal/model-dynasties`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`chat-service model-dynasties ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { dynasties?: Array<Partial<LlmDynasty>> };
    if (!Array.isArray(body.dynasties)) throw new Error("chat-service model-dynasties: no dynasties array");
    return body.dynasties.map((d) => {
      if (typeof d.slug !== "string" || typeof d.name !== "string" || typeof d.headModelId !== "string" || !Array.isArray(d.models)) {
        throw new Error("chat-service model-dynasties: a dynasty without slug, name, head or models");
      }
      return {
        slug: d.slug,
        name: d.name,
        provider: typeof d.provider === "string" ? d.provider : "",
        capabilityTier: typeof d.capabilityTier === "string" ? d.capabilityTier : "",
        headModelId: d.headModelId,
        servedToday: d.servedToday === true,
        models: d.models.map((m) => ({ modelId: String(m.modelId), displayName: String(m.displayName ?? m.modelId), servedToday: m.servedToday === true })),
        legacyAliases: Array.isArray(d.legacyAliases) ? d.legacyAliases.map(String) : [],
      };
    });
  })();
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** The dynasties, or the reason they could not be read (logged): a reader degrades to one bar per model. */
export async function readLlmDynastiesSoft(label: string): Promise<LlmDynasty[] | LlmDynastyReason> {
  try {
    return await readLlmDynasties();
  } catch (error) {
    console.error(`[features-service] ${label}: chat-service LLM dynasties unreadable, every model is its own row this time:`, (error as Error).message);
    return "llm_dynasties_unreadable";
  }
}

/** Test seam. */
export function __resetLlmDynastiesForTest(): void {
  held = null;
}
