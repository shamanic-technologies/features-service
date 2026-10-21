/**
 * MERGED WORKFLOW DYNASTIES POOL THEIR STATS (TPL-DYNASTY-1021-FS, owner 2026-10-21: "stats pool across the versions of
 * a dynasty, by principle").
 *
 * workflow-service merges two ACTIVE dynasties on the same pipe running the same template dynasty with the same LLM
 * alias: the ABSORBED one is recorded as merged into a SURVIVOR, deprecated with the survivor as successor, and no
 * historical row is rewritten (runs, emails, leads keep the absorbed versions' slugs). So every figure features groups
 * by dynasty must count the absorbed versions inside the survivor, read off the merge record, never stored here:
 * un-merging (the record no longer states the pair) restores the prior per-dynasty figures exactly.
 *
 * ONE choke point: the catalogue read (`fetchPublicWorkflows`) maps each absorbed version's `workflowDynastySlug` (and
 * name) onto its survivor's, so every roll-up keyed on that field (leg evidence, ranking, projection, revenue by
 * workflow, return curves) pools with no per-reader code. Each version keeps its OWN status axes: an absorbed version
 * never makes a fully retired survivor executable. The dated spend levers that let runs-service resolve a dynasty
 * itself (`workflowDynastySlug=` on its cost timeseries) cannot see the merge, so they are asked once per MEMBER
 * dynasty and summed (`sumOverMembers`). WRITE paths (leg assignments, one-leg resolution) read the catalogue AS
 * STATED: they act on the dynasty workflow-service names, never on a pooled alias.
 */

/** absorbed dynasty slug -> the survivor it is pooled into (chains already resolved to the final survivor). */
export type DynastyMerges = ReadonlyMap<string, string>;

export const NO_MERGES: DynastyMerges = new Map();

/**
 * PURE. Resolve stated (absorbed, survivor) pairs to their FINAL survivor (A into B, B into C: A pools into C). A cycle
 * is a producer contradiction: thrown, never guessed (a guess would print one dynasty's history under another's name).
 */
export function resolveDynastyMerges(pairs: ReadonlyArray<{ absorbed: string; survivor: string }>): DynastyMerges {
  const direct = new Map<string, string>();
  for (const { absorbed, survivor } of pairs) {
    if (absorbed === survivor) continue;
    const prior = direct.get(absorbed);
    if (prior && prior !== survivor) {
      throw new Error(`[features-service] dynasty ${absorbed} stated as merged into both ${prior} and ${survivor}`);
    }
    direct.set(absorbed, survivor);
  }
  const out = new Map<string, string>();
  for (const absorbed of direct.keys()) {
    const seen = new Set<string>([absorbed]);
    let cur = direct.get(absorbed)!;
    while (direct.has(cur)) {
      if (seen.has(cur)) throw new Error(`[features-service] dynasty merge cycle through ${absorbed}`);
      seen.add(cur);
      cur = direct.get(cur)!;
    }
    out.set(absorbed, cur);
  }
  return out;
}

/** PURE. The dynasty a stated dynasty's figures count under. */
export function pooledDynastyOf(dynastySlug: string, merges: DynastyMerges): string {
  return merges.get(dynastySlug) ?? dynastySlug;
}

/** PURE. Every stated dynasty whose history counts under `dynastySlug` (itself first, then the absorbed, sorted). */
export function dynastyMembers(dynastySlug: string, merges: DynastyMerges): string[] {
  const absorbed = [...merges].filter(([, s]) => s === dynastySlug).map(([a]) => a).sort();
  return [dynastySlug, ...absorbed];
}

/**
 * PURE. The catalogue with every absorbed version re-keyed onto its survivor (`workflowDynastySlug`, and the survivor's
 * `workflowDynastyName` when the catalogue describes the survivor). Status axes, slugs and ids stay the version's own.
 * No merge = the same array, byte-identical.
 */
export function poolMergedDynasties<T extends { workflowDynastySlug: string; workflowDynastyName?: string }>(
  workflows: readonly T[],
  merges: DynastyMerges,
): T[] {
  if (merges.size === 0) return workflows as T[];
  const nameOf = new Map<string, string>();
  for (const w of workflows) {
    if (!merges.has(w.workflowDynastySlug) && w.workflowDynastyName && !nameOf.has(w.workflowDynastySlug)) {
      nameOf.set(w.workflowDynastySlug, w.workflowDynastyName);
    }
  }
  return workflows.map((w) => {
    const survivor = merges.get(w.workflowDynastySlug);
    if (!survivor) return w;
    const name = nameOf.get(survivor);
    return { ...w, workflowDynastySlug: survivor, ...(name !== undefined ? { workflowDynastyName: name } : {}) };
  });
}

/**
 * A per-day figure asked of a producer that resolves the dynasty itself: one read per member dynasty, summed per day
 * (a cost row belongs to one workflow version, so the members are disjoint and the sum is exact). Fail-loud per member.
 */
export async function sumOverMembers<V>(
  dynastySlug: string,
  merges: DynastyMerges,
  read: (memberDynastySlug: string) => Promise<Map<string, V>>,
  add: (a: V, b: V) => V,
): Promise<Map<string, V>> {
  const members = dynastyMembers(dynastySlug, merges);
  if (members.length === 1) return read(dynastySlug);
  const parts = await Promise.all(members.map(read));
  const out = new Map<string, V>();
  for (const part of parts) {
    for (const [k, v] of part) {
      const prev = out.get(k);
      out.set(k, prev === undefined ? v : add(prev, v));
    }
  }
  return out;
}
