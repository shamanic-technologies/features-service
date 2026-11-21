/**
 * IO of the human brief (HUMAN-BRIEF-1121; rules in `human-brief.ts`, PURE).
 * - `readOfferBriefContext`: what the client stated about the offer (brand-service offers: name, description) and who it is
 *   for (human-service audiences of the offer, else of the brand). Read FAIL-LOUD: a brief written on nothing would be a
 *   made-up one.
 * - `writeHumanBrief`: the writer through chat-service's PLATFORM complete (no run of ours: a support mark), stored per
 *   input fingerprint in the fleet cell store, so the same inputs answer the same text (an onboarding card re-painted, a
 *   dry run then its apply) and the writer is asked once.
 */
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { HUMAN_BRIEF_SUPPORT } from "./platform-caller.js";
import { cleanHumanBrief, humanBriefKeyOf, humanBriefPrompt, type HumanBriefInput } from "./human-brief.js";

/** The writer: Anthropic's head Sonnet (chat-service resolves the alias). Never Haiku 4.5 (owner rule). */
export const HUMAN_BRIEF_PROVIDER = "anthropic";
export const HUMAN_BRIEF_MODEL = "sonnet";
const WRITER_TIMEOUT_MS = 45_000;

export interface OfferBriefContext {
  offer: { name: string; description: string | null };
  audiences: string[];
}

export class OfferNotOfBrandError extends Error {}

/** The offer's own words and who it is for. Throws `OfferNotOfBrandError` when the brand lists no such offer. */
export async function readOfferBriefContext(orgId: string, brandId: string, offerId: string): Promise<OfferBriefContext> {
  const brandUrl = process.env.BRAND_SERVICE_URL;
  const brandKey = process.env.BRAND_SERVICE_API_KEY;
  const humanUrl = process.env.HUMAN_SERVICE_URL;
  const humanKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!brandUrl || !brandKey) throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  if (!humanUrl || !humanKey) throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  const [offersRes, audiencesRes] = await Promise.all([
    fetchWithRetry(`${brandUrl}/internal/brands/${encodeURIComponent(brandId)}/offers`, { headers: { "x-api-key": brandKey, "x-org-id": orgId } }),
    fetchWithRetry(`${humanUrl}/internal/brands/${encodeURIComponent(brandId)}/audience-snapshot?${new URLSearchParams({ orgId })}`, { headers: { "x-api-key": humanKey } }),
  ]);
  if (offersRes.status === 404) throw new OfferNotOfBrandError(`brand ${brandId} is not readable for org ${orgId}`);
  if (!offersRes.ok) throw new Error(`brand-service offers ${offersRes.status}: ${(await offersRes.text()).slice(0, 200)}`);
  if (!audiencesRes.ok) throw new Error(`human-service audience-snapshot ${audiencesRes.status}: ${(await audiencesRes.text()).slice(0, 200)}`);
  const offers = ((await offersRes.json()) as { offers?: Array<{ offerId?: unknown; name?: unknown; description?: unknown }> }).offers;
  if (!Array.isArray(offers)) throw new Error("brand-service offers: no offers array");
  const offer = offers.find((o) => o.offerId === offerId);
  if (!offer || typeof offer.name !== "string") throw new OfferNotOfBrandError(`offer ${offerId} is not an offer of brand ${brandId}`);
  const audiences = ((await audiencesRes.json()) as { audiences?: Array<{ name?: unknown; targetText?: unknown; offerId?: unknown }> }).audiences;
  if (!Array.isArray(audiences)) throw new Error("human-service audience-snapshot: no audiences array");
  const words = (a: { name?: unknown; targetText?: unknown }) => (typeof a.targetText === "string" && a.targetText.trim() !== "" ? a.targetText.trim() : typeof a.name === "string" ? a.name.trim() : "");
  const own = audiences.filter((a) => a.offerId === offerId);
  return {
    offer: { name: offer.name, description: typeof offer.description === "string" && offer.description.trim() !== "" ? offer.description.trim() : null },
    audiences: [...new Set((own.length > 0 ? own : audiences).map(words).filter((w) => w !== ""))].slice(0, 3),
  };
}

const cellKeyOf = (input: HumanBriefInput) => `human-brief:${humanBriefKeyOf(input)}`;

/** The human brief for these inputs: the stored one, else the writer's (stored). Throws when the writer cannot answer. */
export async function writeHumanBrief(input: HumanBriefInput): Promise<{ brief: string; model: string; stored: boolean }> {
  const key = cellKeyOf(input);
  const held = await loadFleetCell(key);
  if (held) {
    const body = JSON.parse(held.text) as { brief: string; model: string };
    return { ...body, stored: true };
  }
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const { systemPrompt, message } = humanBriefPrompt(input);
  const res = await fetchWithRetry(
    `${base}/internal/platform-complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ message, systemPrompt, provider: HUMAN_BRIEF_PROVIDER, model: HUMAN_BRIEF_MODEL, support: HUMAN_BRIEF_SUPPORT }),
    },
    { timeoutMs: WRITER_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-complete ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content?: unknown; model?: unknown };
  if (typeof body.content !== "string" || body.content.trim() === "") throw new Error("chat-service answered no brief text");
  const out = { brief: cleanHumanBrief(body.content), model: typeof body.model === "string" ? body.model : HUMAN_BRIEF_MODEL };
  await storeFleetCell(key, JSON.stringify(out), Date.now());
  return { ...out, stored: false };
}
