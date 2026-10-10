/**
 * THE NAME OF A SALES PATH COMBINATION — "Victory is our best path for you", "Sol is second".
 *
 * Owner decision 2026-10-04 (supersedes the per-(channel, leg) crew names Herald/Scout/Pilot/…, retired
 * from `/public/channels`). A COMBINATION is a chain of legs to `paid_client` with ONE managed channel on
 * every leg a channel of ours works (`combinationKeyOf`, `lib/offer-sales-paths.ts`). Its name is:
 *
 *  - SHARED: keyed on the combination alone, never on a brand, org or offer — the same combination reads
 *    the same name for every client;
 *  - STABLE FOREVER: written once to `sales_path_combination_names` and never updated or deleted, so a
 *    name never moves to another combination and is never given twice (UNIQUE on the name). Nothing is
 *    derived from a slug, and nothing is recomputed per request: reordering or growing the pool below
 *    changes only which word the NEXT new combination receives;
 *  - ASSIGNED ON FIRST SIGHT: a combination nobody named yet takes the first unused word of the pool, in
 *    the order the read ranked it (the best new combination gets the earlier word). The whole assignment
 *    runs under one transaction-scoped advisory lock, so two concurrent reads cannot hand one word to two
 *    combinations nor two words to one.
 *
 * A CAMPAIGN — one (channel × leg) a sales path can contain — is named from the SAME table and pool
 * (owner 2026-10-04, the offer's Sales path page lists its campaigns with a name and a face each). Its key
 * lives in its own namespace (`campaignNameKeyOf`: `campaign:<channel slug>|<leg key>`), which no
 * combination key can spell (those are leg keys joined by `+`, `@slug` per managed leg), and the name is
 * UNIQUE across the whole table, so a campaign and a path never share a name — not even a one-leg path
 * on the same channel.
 *
 * The pool is curated: English, one word, optimistic (success, height, glory, abundance, joy). Its size is
 * guarded against every combination the catalogue can form (`offer-sales-paths.test.ts`); an exhausted
 * pool throws `SalesPathNamePoolExhaustedError` — loud, never a reused or invented name.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesPathCombinationNames } from "../db/schema.js";
import type { ChannelStepTransitionWire, PublicChannel } from "./channel-catalogue.js";
import { campaignNameKeyOf } from "./offer-sales-paths.js";
import { servedNameKeyOf } from "./funnel-legs.js";
import { FUNNEL_EXTRA_WORDS, PATH_RIVER_WORDS, PIPE_BIRD_WORDS, familyNameCandidates, nameFamilyOfKey, type NameFamily } from "./catalogue-names.js";

/** Append-only in spirit: add words at the END; a word already given stays given whatever happens here. */
export const SALES_PATH_NAME_POOL: readonly string[] = [
  "Victory", "Sol", "Herald", "Epiphany", "Triumph", "Zenith", "Summit", "Glory",
  "Aurora", "Bounty", "Jubilee", "Radiance", "Apex", "Laurel", "Harvest", "Eureka",
  "Halo", "Crown", "Pinnacle", "Ascent", "Bliss", "Splendor", "Fortune", "Valor",
  "Anthem", "Beacon", "Comet", "Dawn", "Elation", "Encore", "Euphoria", "Fanfare",
  "Flourish", "Gala", "Gleam", "Golden", "Grace", "Honor", "Horizon", "Jackpot",
  "Joy", "Jubilation", "Lumen", "Luster", "Majesty", "Marvel", "Meridian", "Miracle",
  "Nova", "Oasis", "Opulence", "Ovation", "Paragon", "Plenty", "Prism", "Prodigy",
  "Rapture", "Regal", "Rise", "Rhapsody", "Riches", "Soar", "Solstice", "Sovereign",
  "Sparkle", "Spire", "Starlight", "Sterling", "Sunrise", "Sunburst", "Supernova", "Thrive",
  "Tiara", "Titan", "Torch", "Treasure", "Trophy", "Upswing", "Utopia", "Vanguard",
  "Verve", "Vista", "Wonder", "Zeal", "Zest", "Abundance", "Acclaim", "Accolade",
  "Ardor", "Aspire", "Bonanza", "Brilliance", "Cascade", "Celebration", "Champion", "Cheer",
  "Clarion", "Crescendo", "Delight", "Destiny", "Diadem", "Dynamo", "Eden", "Elevate",
  "Elysium", "Emblem", "Empyrean", "Exalt", "Excelsior", "Fiesta", "Flair", "Fervor",
  "Gem", "Genesis", "Gilded", "Glimmer", "Glow", "Gusto", "Harmony", "Heyday",
  "Hurrah", "Icon", "Ignite", "Jewel", "Kudos", "Legend", "Lodestar", "Magnum",
  "Mirth", "Momentum", "Monarch", "Noble", "Olympus", "Panache", "Paradise", "Pearl",
  "Phoenix", "Plaudit", "Polaris", "Premier", "Prestige", "Promise", "Providence", "Rainbow",
  "Renown", "Revel", "Ruby", "Saga", "Sapphire", "Serenade", "Shine", "Skyward",
  "Sonnet", "Spark", "Stellar", "Sublime", "Success", "Sunbeam", "Surge", "Talisman",
  "Tribute", "Uplift", "Vantage", "Verdant", "Victor", "Vivid", "Windfall", "Wish",
  "Amber", "Aria", "Bravo", "Cadence", "Cosmos", "Dazzle", "Echelon", "Ember",
  "Emerald", "Fable", "Festival", "Luminary", "Gallant", "Garland", "Glee", "Grandeur",
  "Hallmark", "Heaven", "Hero", "Idyll", "Jasmine", "Kindle", "Lyric", "Medal",
  "Merit", "Nectar", "Opal", "Orbit", "Peak", "Pride", "Quasar", "Radiant",
  "Rally", "Reign", "Resound", "Sunlit", "Topaz", "Unity", "Velvet", "Zephyr",
];

export class SalesPathNamePoolExhaustedError extends Error {
  constructor(
    public readonly missing: number,
    public readonly families: readonly string[] = ["sales_funnel"],
  ) {
    super(`name family exhausted (${families.join(", ")}): ${missing} new object(s) need a name and every name of the family is given — add words at the end of its list (lib/catalogue-names.ts)`);
    this.name = "SalesPathNamePoolExhaustedError";
  }
}

/** PURE: the next `count` words of `pool`, in pool order, that `used` does not hold. Throws when short. */
export function nextUnusedNames(pool: readonly string[], used: ReadonlySet<string>, count: number): string[] {
  const free = pool.filter((w) => !used.has(w));
  if (free.length < count) throw new SalesPathNamePoolExhaustedError(count - free.length);
  return free.slice(0, count);
}

/** Each family's single words (`lib/catalogue-names.ts`): a sales funnel's are the original pool, then the extra words. */
export const FAMILY_WORDS: Readonly<Record<NameFamily, readonly string[]>> = {
  sales_funnel: [...SALES_PATH_NAME_POOL, ...FUNNEL_EXTRA_WORDS],
  pipe: PIPE_BIRD_WORDS,
  sales_path: PATH_RIVER_WORDS,
};

/**
 * PURE: one new name per key, in key order, each from the key's OWN family (`nameFamilyOfKey`), never one
 * `used` holds nor one given earlier in the same call. Throws when a family is exhausted.
 */
export function nextNamesForKeys(keys: readonly string[], used: ReadonlySet<string>): string[] {
  const taken = new Set(used);
  const iterators = new Map<NameFamily, Generator<string>>();
  const missingByFamily = new Map<NameFamily, number>();
  const out: string[] = [];
  for (const key of keys) {
    const family = nameFamilyOfKey(key);
    let it = iterators.get(family);
    if (!it) {
      it = familyNameCandidates(family, FAMILY_WORDS[family]);
      iterators.set(family, it);
    }
    let next = it.next();
    while (!next.done && taken.has(next.value)) next = it.next();
    if (next.done) {
      missingByFamily.set(family, (missingByFamily.get(family) ?? 0) + 1);
      continue;
    }
    taken.add(next.value);
    out.push(next.value);
  }
  const missing = [...missingByFamily.values()].reduce((a, b) => a + b, 0);
  if (missing > 0) throw new SalesPathNamePoolExhaustedError(missing, [...missingByFamily.keys()]);
  return out;
}

/** Lock id of the assignment (any constant; scoped to this one table's writes). */
export const NAME_ASSIGNMENT_LOCK = 784_530_071;

/**
 * The name of every combination in `keysInRankOrder`, assigning the unnamed ones on first sight.
 * Fail-loud: a DB error or an exhausted pool throws (the route answers 502); never an invented name.
 */
export async function salesPathNamesFor(keysInRankOrder: readonly string[]): Promise<Map<string, string>> {
  // Stored in the served spelling (outbound leg rename, wave 2: `lib/outbound-leg-key-migration.ts`); the
  // map answers under the key the caller asked with.
  const stored = new Map(keysInRankOrder.map((k) => [k, servedNameKeyOf(k)]));
  const byStored = await namesByStoredKey([...new Set(stored.values())]);
  return new Map([...stored].flatMap(([asked, key]) => (byStored.has(key) ? [[asked, byStored.get(key)!] as const] : [])));
}

async function namesByStoredKey(keysInRankOrder: readonly string[]): Promise<Map<string, string>> {
  const keys = [...new Set(keysInRankOrder)];
  if (keys.length === 0) return new Map();
  const read = async (q: Pick<typeof db, "select">) =>
    new Map(
      (
        await q
          .select({ key: salesPathCombinationNames.combinationKey, name: salesPathCombinationNames.name })
          .from(salesPathCombinationNames)
          .where(inArray(salesPathCombinationNames.combinationKey, keys))
      ).map((r) => [r.key, r.name]),
    );
  const known = await read(db);
  if (keys.every((k) => known.has(k))) return known;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAME_ASSIGNMENT_LOCK})`);
    const named = await read(tx);
    const missing = keys.filter((k) => !named.has(k));
    if (missing.length === 0) return named;
    const used = new Set((await tx.select({ name: salesPathCombinationNames.name }).from(salesPathCombinationNames)).map((r) => r.name));
    const words = nextNamesForKeys(missing, used);
    await tx.insert(salesPathCombinationNames).values(missing.map((combinationKey, i) => ({ combinationKey, name: words[i] })));
    missing.forEach((k, i) => named.set(k, words[i]));
    console.log(`[features-service] sales-path names: named ${missing.map((k, i) => `${words[i]}=${k}`).join(", ")}`);
    return named;
  });
}

/** Every name given so far, keyed by its stored key (one small table: read whole, ~1 row per named object). */
export async function allNamesByKey(): Promise<Map<string, string>> {
  const rows = await db.select({ key: salesPathCombinationNames.combinationKey, name: salesPathCombinationNames.name }).from(salesPathCombinationNames);
  return new Map(rows.map((r) => [r.key, r.name]));
}

/** The key a CAMPAIGN's name is stored under: its own namespace, never a combination key. */
export { campaignNameKeyOf };

/**
 * The published channels with every SALES-PATH-ELIGIBLE (channel × leg) campaign named, assigned on first
 * sight in catalogue order (channel display order, then the channel's own leg order). A channel that can
 * appear in no sales path keeps `campaignName: null`. Fail-loud like `salesPathNamesFor`.
 */
/** The name of every named campaign of `channels` (the output of `withCampaignNames`), keyed `campaignNameKeyOf`. */
export function campaignNamesOf(channels: readonly PublicChannel[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of channels) for (const t of c.stepTransitions) if (t.campaignName) out.set(campaignNameKeyOf(c.slug, t.legKey), t.campaignName);
  return out;
}

export async function withCampaignNames(channels: readonly PublicChannel[]): Promise<PublicChannel[]> {
  const keys = channels
    .filter((c) => c.salesPathEligible)
    .flatMap((c) => c.stepTransitions.map((t) => campaignNameKeyOf(c.slug, t.legKey)));
  const names = await salesPathNamesFor(keys);
  return channels.map((c) => ({
    ...c,
    stepTransitions: c.stepTransitions.map((t): ChannelStepTransitionWire => {
      if (!c.salesPathEligible) return t;
      const campaignName = names.get(campaignNameKeyOf(c.slug, t.legKey));
      if (!campaignName) throw new Error(`campaign ${c.slug} × ${t.legKey} has no name`);
      return { ...t, campaignName };
    }),
  }));
}
