import { createHash, randomBytes } from "node:crypto";

/**
 * Compute a deterministic signature from input and output keys.
 * A feature is defined by its inputs + outputs — if either changes, it's a new feature.
 */
export function computeSignature(inputKeys: string[], outputKeys: string[]): string {
  const sorted = `in:${[...inputKeys].sort().join(",")}|out:${[...outputKeys].sort().join(",")}`;
  return createHash("sha256").update(sorted).digest("hex");
}

/**
 * Slugify a name: lowercase, replace spaces/special chars with hyphens, collapse multiples.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Given a dynasty name and a version number, produce the versioned name.
 * v1 = no suffix, v2+ = " v2", " v3", etc.
 */
export function versionedName(dynastyName: string, version: number): string {
  return version === 1 ? dynastyName : `${dynastyName} v${version}`;
}

/**
 * Given a dynasty slug and a version number, produce the versioned slug.
 * v1 = no suffix, v2+ = "-v2", "-v3", etc.
 */
export function versionedSlug(dynastySlug: string, version: number): string {
  return version === 1 ? dynastySlug : `${dynastySlug}-v${version}`;
}

/**
 * Compose a dynasty name from base_name and optional fork_name.
 */
export function composeDynastyName(baseName: string, forkName: string | null): string {
  return forkName ? `${baseName} ${forkName}` : baseName;
}

// ── Fork name codenames ─────────────────────────────────────────────────────

/**
 * Curated list of codenames for auto-generated fork names.
 * Used when a new dynasty is created with a base_name that already exists.
 */
export const CODENAMES = [
  // Cities
  "Sophia", "Berlin", "Vienna", "Oslo", "Lisbon",
  "Prague", "Dublin", "Geneva", "Milan", "Porto",
  "Kyoto", "Seoul", "Taipei", "Lima", "Bogota",
  "Havana", "Nairobi", "Accra", "Cairo", "Tunis",
  "Mumbai", "Jakarta", "Manila", "Hanoi", "Bangkok",
  // Gems & minerals
  "Onyx", "Quartz", "Amber", "Jade", "Topaz",
  "Opal", "Ruby", "Pearl", "Ivory", "Cobalt",
  // Nature
  "Aurora", "Cascade", "Summit", "Horizon", "Canyon",
  "Glacier", "Tundra", "Savanna", "Lagoon", "Delta",
  "Reef", "Mesa", "Fjord", "Grove", "Ridge",
  // Abstract
  "Nova", "Ember", "Prism", "Velvet", "Zenith",
  "Atlas", "Nexus", "Pulse", "Forge", "Drift",
  "Bloom", "Crest", "Spark", "Flare", "Surge",
  "Echo", "Orbit", "Helix", "Vertex", "Axiom",
  // Metals & elements
  "Titanium", "Neon", "Argon", "Helium", "Radium",
  "Zinc", "Chrome", "Copper", "Nickel", "Carbon",
  // Weather & sky
  "Cirrus", "Nimbus", "Solstice", "Equinox", "Zephyr",
  "Monsoon", "Breeze", "Thunder", "Frost", "Haze",
  // Mythology
  "Phoenix", "Griffin", "Pegasus", "Hydra", "Chimera",
  "Kraken", "Sphinx", "Titan", "Triton", "Orion",
];

/**
 * Pick a fork name that hasn't been used yet for this base_name.
 * @param usedForkNames - Set of fork names already in use for this base_name
 * @returns A unique fork name
 */
export function pickForkName(usedForkNames: Set<string>): string {
  for (const codename of CODENAMES) {
    if (!usedForkNames.has(codename)) {
      return codename;
    }
  }
  // All codenames exhausted — fallback with short random suffix
  const suffix = randomBytes(2).toString("hex");
  return `${CODENAMES[0]}-${suffix}`;
}
