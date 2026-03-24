import { createHash } from "node:crypto";

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
 * Given a base name and a version number, produce the suffixed name.
 * v1 = no suffix, v2+ = " v2", " v3", etc.
 */
export function versionedName(baseName: string, version: number): string {
  return version === 1 ? baseName : `${baseName} v${version}`;
}

/**
 * Given a base slug and a version number, produce the suffixed slug.
 * v1 = no suffix, v2+ = "-v2", "-v3", etc.
 */
export function versionedSlug(baseSlug: string, version: number): string {
  return version === 1 ? baseSlug : `${baseSlug}-v${version}`;
}
