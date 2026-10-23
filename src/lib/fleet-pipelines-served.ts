/**
 * A fleet value leg (per-pair engine pipelines folded per workflow dynasty) is a SUM over every (org, brand) pair: a pair
 * whose compute failed makes it a partial sum. A partial sum never replaces the last complete one
 * (RESEARCH-PERFORMANCE-1023: a ranking built on a partial sum read Ballad 0.09x for 3.47x, and every template and
 * combination return the Research build read off it). Pure.
 */
export function servedFleetPipelines<T extends { pairsFailed: number }>(computed: T, lastComplete: T | undefined): T {
  return computed.pairsFailed > 0 && lastComplete ? lastComplete : computed;
}
