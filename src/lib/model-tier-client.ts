/**
 * THE ALIAS → CAPABILITY TIER CATALOGUE, READ FROM THE SERVICE THAT OWNS IT
 *
 * chat-service resolves every model alias a workflow can name and records the capability tier of each
 * one as data (`GET /internal/models` → `{ models: [{ provider, model, capabilityTier }] }`,
 * `x-api-key` only, no identity). It is the ONLY service that can answer this: the tier is a decision
 * recorded per alias, not a property of the alias string — `flash-pro` resolves to a Flash model and
 * is CHEAP despite containing "pro", so a substring rule gets a live alias wrong. This module reads
 * that catalogue and never derives anything.
 *
 * An alias is globally unique across providers in that catalogue, so it flattens to one alias → tier
 * map. If a future catalogue ever gave one alias two DIFFERENT tiers under two providers, the alias
 * is dropped from the map rather than resolved arbitrarily — a workflow naming it then reads as
 * UNKNOWABLE and stays eligible, which is the same treatment every other gap gets.
 *
 * Fail-LOUD client. The caller wraps it fail-SOFT (`fetchModelTierCatalogueSoft`), because a
 * catalogue blip must leave every row eligible with a stated reason rather than 502 a page whose
 * every other figure is correct — and must NEVER exclude a workflow on a failed read.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { isCapabilityTier, type CapabilityTier } from "./model-tier-eligibility.js";

interface CatalogueEntry {
  provider?: unknown;
  model?: unknown;
  capabilityTier?: unknown;
}

/**
 * Every alias chat-service can resolve, mapped to its recorded tier.
 *
 * Throws on transport failure, a non-OK status, or a body that is not the documented shape — an
 * unreadable catalogue is never a partially-populated map (a map missing half its aliases would
 * silently make half the fleet's workflows "unknowable" while the other half is judged).
 */
export async function fetchModelTierCatalogue(): Promise<Map<string, CapabilityTier>> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) {
    throw new Error(
      "[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY are not set — the model-tier catalogue cannot be read",
    );
  }

  const response = await fetchWithRetry(`${base}/internal/models`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] chat-service GET /internal/models failed: ${response.status} — ${body}`);
  }

  const data = (await response.json()) as { models?: unknown };
  if (!Array.isArray(data.models)) {
    throw new Error("[features-service] chat-service GET /internal/models returned no `models` array");
  }

  const byAlias = new Map<string, CapabilityTier>();
  const conflicting = new Set<string>();
  for (const raw of data.models as CatalogueEntry[]) {
    const alias = raw?.model;
    const tier = raw?.capabilityTier;
    if (typeof alias !== "string" || alias === "" || !isCapabilityTier(tier)) {
      throw new Error(
        `[features-service] chat-service GET /internal/models returned an entry with no usable (model, capabilityTier): ${JSON.stringify(raw)}`,
      );
    }
    const existing = byAlias.get(alias);
    if (existing !== undefined && existing !== tier) conflicting.add(alias);
    byAlias.set(alias, tier);
  }
  // Two providers disagreeing about one alias's tier is not an answer we can pick between, so the
  // alias is removed and every workflow naming it reads as unknowable-but-eligible. Loud, because it
  // is a producer-side contradiction somebody has to fix.
  for (const alias of conflicting) {
    console.error(
      `[features-service] chat-service model catalogue states two different capability tiers for the alias "${alias}" — dropping it; workflows naming it will read as unknown-tier and stay eligible`,
    );
    byAlias.delete(alias);
  }

  return byAlias;
}

/**
 * Fail-SOFT wrapper: `null` on any failure, with a loud log. A null catalogue leaves EVERY row
 * eligible and states `catalogue_unavailable` as the reason — never an exclusion on a failed read,
 * and never a silent one.
 */
export async function fetchModelTierCatalogueSoft(): Promise<Map<string, CapabilityTier> | null> {
  try {
    return await fetchModelTierCatalogue();
  } catch (error) {
    console.error(
      "[features-service] model-tier catalogue unavailable — every workflow stays ELIGIBLE with the reason stated on its row:",
      error,
    );
    return null;
  }
}
