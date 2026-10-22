/**
 * THE BEST TEMPLATE AND THE BEST LLM OF ONE PIPE (BEST-TPL-LLM-1022, owner 2026-10-22). Pure: the IO is
 * `lib/leg-writer-ranking-io.ts`.
 *
 * OWNER RULE (2026-10-22): a pipe makes THREE independent choices: the workflow (sequence shape, chosen as before), the
 * template DYNASTY and the LLM. Each of the last two is the cheapest per outcome ON THE LEG, chosen without looking at
 * the other ("on reste simple avec un ROI par template (independamment du workflow ni du LLM)"), on $/outcome, never on
 * ROI. The order is the ONE leg order the workflows already follow (`orderLegWorkflows`, `lib/leg-workflow-order.ts`):
 *   - a MATURE item (its outcomes on runs started before the leg's cutoff reach the leg's bar) is priced on its mature
 *     cost per outcome; the cheapest mature one is where the money goes;
 *   - a LEARNING item is priced on what it spent so far ÷ max(outcomes, 1): with no outcome, on its spend. It goes BEFORE
 *     the best mature one while that price is below the best mature price (worked example: Gemini 3 Flash mature at $43
 *     per positive reply, Claude Opus 5.5 at $12 spent and 0 replies: Opus is picked until its spend passes $43). An item
 *     never used has spent $0 and goes first: never floored up to the best mature price, or it would never be tried.
 * No exploration quota: the learning rule IS the exploration (owner, rejected a share of sends). Ties break on the key.
 *
 * The figures are the Research page's template and model bars (`generationBuckets`, `lib/research/generations.ts`): the
 * same evidence, the same pooling, the same maturity, so the ranking and the page never disagree.
 *
 * A STRATEGY narrows the candidates with its tactics of the subject (`strategyOnSubject`, `lib/plays.ts`): an item it
 * rules out is never listed nor picked (`excluded[]` says why), an item not judged yet on a tactic it names is ruled out
 * too (the workflow rule: never a pick nobody judged). The cheapest remaining wins.
 */
import { bestMatureSlug, explorePriceUsd, legWorkflowPlaces, orderLegWorkflows, type LegWorkflowOrderEntry, type LegWorkflowPlace } from "./leg-workflow-order.js";

export type WriterKind = "template" | "llm";

/** One template dynasty (or a template version no dynasty of the pipe lists) or one LLM, with its evidence on the leg. */
export interface WriterCandidate {
  key: string;
  label: string;
  /** A run may write with it (an active dynasty with a head; an LLM with an active writer alias). */
  selectable: boolean;
  /** Why not, when not selectable. */
  notSelectableReason: string | null;
  /** Read on `basis` (mature once its pooled mature outcomes reach the leg's bar, else everything to date). */
  basis: "mature" | "flash";
  figures: { spentUsd: number; contacted: number; outcomes: number };
}

export interface WriterRankingRow {
  /** 1-based, total, no gaps. */
  rank: number;
  key: string;
  label: string;
  selectable: boolean;
  notSelectableReason: string | null;
  isMature: boolean;
  basis: "mature" | "flash";
  /** Observed on `basis`: null at zero outcomes (never a spend floor; the order reads `explorePriceUsd`). */
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
  spentUsd: number;
  contacted: number;
  outcomes: number;
  /** The price the order reads for a LEARNING row: spend ÷ max(outcomes, 1) ($0 never used). Null on a mature row. */
  explorePriceUsd: number | null;
  /** Why the row stands where it does (the workflow ranking's words). */
  place: LegWorkflowPlace;
  /** Rank 1 when selectable: what the pipe writes with next. */
  goesFirst: boolean;
  /** The best mature selectable row. */
  moneyGoesHere: boolean;
}

export interface WriterRanking {
  rows: WriterRankingRow[];
  /** Rank 1 when it is selectable, else null. */
  best: WriterRankingRow | null;
  /** Ruled out by the strategy, with why (never listed in `rows`). */
  excluded: Array<{ key: string; label: string; reason: string }>;
}

const isMatureCandidate = (c: WriterCandidate): boolean => c.basis === "mature" && c.figures.outcomes > 0 && c.figures.spentUsd > 0;

/**
 * PURE. The ranked candidates of one subject on one pipe. `ruledOut(key)` = the strategy's reason to exclude it (null =
 * allowed); absent = no strategy.
 */
export function rankWriters(candidates: readonly WriterCandidate[], ruledOut?: (key: string) => string | null): WriterRanking {
  const excluded: WriterRanking["excluded"] = [];
  const kept: WriterCandidate[] = [];
  for (const c of candidates) {
    const why = ruledOut?.(c.key) ?? null;
    if (why) excluded.push({ key: c.key, label: c.label, reason: why });
    else kept.push(c);
  }
  const entries: LegWorkflowOrderEntry[] = kept.map((c) => ({
    slug: c.key,
    selectable: c.selectable,
    mature: isMatureCandidate(c) ? { tier: 0, costPerOutcomeUsd: c.figures.spentUsd / c.figures.outcomes } : null,
    fleet: { spentUsd: c.figures.spentUsd, outcomes: c.figures.outcomes },
  }));
  const byKey = new Map(kept.map((c) => [c.key, c]));
  const entryOf = new Map(entries.map((e) => [e.slug, e]));
  const places = legWorkflowPlaces(entries);
  const money = bestMatureSlug(entries);
  const rows = orderLegWorkflows(entries).map((key, i): WriterRankingRow => {
    const c = byKey.get(key)!;
    const e = entryOf.get(key)!;
    const f = c.figures;
    return {
      rank: i + 1,
      key,
      label: c.label,
      selectable: c.selectable,
      notSelectableReason: c.selectable ? null : c.notSelectableReason,
      isMature: e.mature !== null,
      basis: c.basis,
      costPerOutcomeUsd: f.outcomes > 0 && f.spentUsd > 0 ? f.spentUsd / f.outcomes : null,
      conversionRatePct: f.contacted > 0 ? (100 * f.outcomes) / f.contacted : null,
      spentUsd: f.spentUsd,
      contacted: f.contacted,
      outcomes: f.outcomes,
      explorePriceUsd: e.mature ? null : explorePriceUsd(e.fleet),
      place: places.get(key)!,
      goesFirst: i === 0 && c.selectable,
      moneyGoesHere: key === money,
    };
  });
  return { rows, best: rows[0]?.selectable ? rows[0] : null, excluded };
}
