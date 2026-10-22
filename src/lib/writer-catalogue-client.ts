/**
 * WHAT A PIPE CAN WRITE WITH, read from content-generation-service (api key, no identity): its template DYNASTIES
 * (`GET /internal/template-dynasties?featureSlug=&legKey=`), each template's prompt text (`/platform-prompts`) and the
 * writer model aliases it accepts with their staff status (`GET /internal/models`, TEMPLATE-MODEL-STATUS-1019). Read by
 * the Research build and the leg writer ranking (BEST-TPL-LLM-1022), so both see the same candidates.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { dynastyLegKeyOf, dynastyStatusOf, type TemplateDynasty, type TemplateDynastyReason, type TemplateStatus } from "./research/template-dynasties.js";

/** Each template's prompt text (content-generation-service, no identity), held 6 hours: a versioned template never changes. */
const templateTextHeld = new Map<string, { at: number; text: string | null }>();
export async function readTemplateTexts(types: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapWithConcurrency([...new Set(types)], 4, async (type) => {
    const held = templateTextHeld.get(type);
    if (held && Date.now() - held.at < 6 * 60 * 60_000) {
      if (held.text) out.set(type, held.text);
      return;
    }
    const res = await fetchWithRetry(`${process.env.CONTENT_GENERATION_SERVICE_URL}/platform-prompts?type=${encodeURIComponent(type)}`, {
      headers: { "x-api-key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? "" },
    });
    const text = res.ok ? (((await res.json()) as { prompt?: string }).prompt ?? null) : null;
    if (!res.ok && res.status !== 404) throw new Error(`content-generation-service platform-prompts ${type} ${res.status}`);
    templateTextHeld.set(type, { at: Date.now(), text });
    if (text) out.set(type, text);
  });
  return out;
}

/**
 * One pipe's template dynasties, read from content-generation-service's deployed catalogue (TPL-DYNASTY-1021-FS2; api
 * key, no identity). Unreadable = every version is its own page this build, said on each (`template_dynasties_unreadable`).
 */
export async function readTemplateDynasties(featureSlug: string, legKey: string): Promise<TemplateDynasty[] | TemplateDynastyReason> {
  try {
    const q = new URLSearchParams({ featureSlug, legKey: dynastyLegKeyOf(legKey) });
    const res = await fetchWithRetry(`${process.env.CONTENT_GENERATION_SERVICE_URL}/internal/template-dynasties?${q}`, {
      headers: { "x-api-key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`content-generation-service template-dynasties ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { dynasties?: Array<Partial<Omit<TemplateDynasty, "status">> & { status?: unknown; versions?: Array<{ type?: string; position?: number; status?: unknown; statusInDynasty?: unknown; copiedFrom?: unknown }> }> };
    if (!Array.isArray(body.dynasties)) throw new Error("content-generation-service template-dynasties: no dynasties array");
    return body.dynasties.map((d) => {
      if (typeof d.slug !== "string" || typeof d.name !== "string") throw new Error("content-generation-service template-dynasties: a dynasty without slug or name");
      const ordered = [...(d.versions ?? [])]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .flatMap((v) => {
          if (typeof v.type !== "string") return [];
          // A version's status IN this dynasty (head = its own, older = deprecated); `status` is the template's own,
          // active when it heads a dynasty on another pipe. Before content-generation served it: the template's own.
          const st = v.statusInDynasty !== undefined ? v.statusInDynasty : v.status;
          return [{ type: v.type, status: st === "active" || st === "deprecated" ? (st as TemplateStatus) : null, copiedFrom: typeof v.copiedFrom === "string" && v.copiedFrom ? v.copiedFrom : null }];
        });
      const versions = ordered.map((v) => v.type);
      return {
        ...dynastyStatusOf(d.status, ordered),
        versionStatuses: Object.fromEntries(ordered.map((v) => [v.type, v.status])),
        copiedFrom: Object.fromEntries(ordered.flatMap((v) => (v.copiedFrom ? [[v.type, v.copiedFrom]] : []))),
        slug: d.slug,
        name: d.name,
        description: typeof d.description === "string" ? d.description : "",
        signature: typeof d.signature === "string" ? d.signature : null,
        identity: typeof d.identity === "string" ? d.identity : "",
        head: typeof d.head === "string" ? d.head : null,
        versions,
      };
    });
  } catch (error) {
    console.error(`[features-service] template dynasties of ${featureSlug}|${legKey} unreadable, every version is its own page this time:`, error);
    return "template_dynasties_unreadable";
  }
}


/** One writer model alias content-generation accepts (`/internal/models`), with its staff status. */
export interface WriterModelAlias {
  alias: string;
  provider: string;
  status: "active" | "deprecated";
}

/** Every writer model alias content-generation accepts. FAIL-LOUD (a failed read is never "no LLM"). Held 10 minutes. */
let aliasesHeld: { at: number; value: Promise<WriterModelAlias[]> } | null = null;
export function readWriterModelAliases(): Promise<WriterModelAlias[]> {
  if (aliasesHeld && Date.now() - aliasesHeld.at < 10 * 60_000) return aliasesHeld.value;
  const value = (async () => {
    const res = await fetchWithRetry(`${process.env.CONTENT_GENERATION_SERVICE_URL}/internal/models`, { headers: { "x-api-key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`content-generation-service models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { models?: Array<{ model?: unknown; provider?: unknown; status?: unknown }> };
    if (!Array.isArray(body.models)) throw new Error("content-generation-service models: no models array");
    return body.models.flatMap((m) =>
      typeof m.model === "string" && m.model ? [{ alias: m.model, provider: typeof m.provider === "string" ? m.provider : "", status: m.status === "deprecated" ? ("deprecated" as const) : ("active" as const) }] : [],
    );
  })();
  aliasesHeld = { at: Date.now(), value };
  value.catch(() => {
    if (aliasesHeld?.value === value) aliasesHeld = null;
  });
  return value;
}

/** Test seam. */
export function __resetWriterCatalogueForTest(): void {
  aliasesHeld = null;
  templateTextHeld.clear();
}
