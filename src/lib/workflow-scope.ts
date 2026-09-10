/**
 * ONE WORKFLOW, INSIDE ONE READ — the drill-down half of `?groupBy=workflow`.
 *
 * The grouped read answers "which of the workflows we ran made money" as a table of lean rows. A
 * customer who then opens ONE of those rows asks the question the campaign Overview already answers —
 * return on spend over time, the outcome trend, the funnel walk, the stat cards — about that workflow
 * alone. Every one of those blocks lives on the UN-grouped body, so the drill-down is not a new
 * computation: it is the same body, narrowed.
 *
 * ── THE UNIT IS THE DYNASTY, because the row the consumer clicked is one ────────────────────────
 *
 * `?groupBy=workflow` emits a DYNASTY key (a workflow's identity across its versions) for the reasons
 * `lib/workflow-revenue.ts` states at length, so the drill-down takes that same key or the two
 * surfaces would speak two vocabularies about one workflow. Upgrading a workflow to v2 does not make
 * it a different workflow that earned nothing.
 *
 * ── ONE RESOLUTION, TWO LEGS, BOTH FROZEN BY THEIR PRODUCER ─────────────────────────────────────
 *
 *   - SPEND: the runs / email-gateway reads carry `workflowSlugs` — the VERSIONED slugs resolved
 *     HERE, never the dynasty for the producer to resolve again. Both producers offer a
 *     `workflowDynastySlug` filter and it is deliberately NOT used: each resolves it by asking
 *     workflow-service, which **404s for a dynasty it does not describe** and turns into a 500 on
 *     runs and a 502 on email-gateway. A RETIRED lineage is exactly such a dynasty — and it is
 *     exactly the workflow a "which of these burned money" question is about — so routing through
 *     the producer's resolution makes the one case that matters most unanswerable.
 *   - LEADS: the `workflowSlug` lead-service froze on each `leads_campaigns` row at serve time,
 *     mapped to its dynasty HERE through the same workflow-service catalogue.
 *
 * So ONE resolution serves both legs, which is what the claim above actually requires. (The dated
 * spend leg behind `roiHistory` is the single exception: runs' cost TIMESERIES offers no slug
 * filter at all, only `workflowDynastySlug`, so it keeps that lever and fails SOFT — a dynasty
 * nobody describes nulls the return curve rather than 502-ing a page whose every other figure is
 * right.)
 *
 * Neither may be inferred from the campaign row's CURRENT workflow: campaign-service switches the
 * workflow of a campaign already alive on an identity instead of opening a new row, so that field
 * mis-attributes every lead and every dollar spent before the switch.
 *
 * ── THE CATALOGUE READ IS FAIL-LOUD HERE, AND FAIL-SOFT ON THE GROUPED GRAIN ────────────────────
 *
 * Not an inconsistency — the same rule applied to two different questions. On the grouped grain the
 * catalogue decides how versions are GROUPED, so losing it degrades to the version grain: a poorer
 * grouping of the same, correct numbers. Here it decides WHICH LEADS ARE THIS WORKFLOW'S, so losing
 * it would answer about the single version whose slug happens to equal the dynasty and print that
 * subset under the whole workflow's name — the wrong-grain bug this drill-down exists to avoid, one
 * level down. So it throws, and the read 502s.
 *
 * ── A WORKFLOW THE SCOPE NEVER SPENT THROUGH IS A REAL, EMPTY ANSWER ────────────────────────────
 *
 * Zero counts, zero cents, a null return — never a 404 and never a fabricated fleet estimate. There
 * is nothing to 404 on: a slug the catalogue does not describe is ITS OWN dynasty of one (the same
 * rule the grouped grain applies), so every key that read can emit resolves here, and a key nobody
 * ever ran simply matches no lead and no cost row.
 */
import { fetchPublicWorkflows, type WorkflowMetadata } from "./public-stats-clients.js";

/** PURE: slug → its dynasty. A slug nobody describes is its own dynasty, never folded on a guess. */
export function dynastyOfSlug(workflows: WorkflowMetadata[]): (slug: string) => string {
  const map = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  return (slug: string) => map.get(slug) ?? slug;
}

/** ONE workflow dynasty, and the two things a narrowed read needs to know about it. */
export interface WorkflowScope {
  /** The dynasty key — byte the same value `?groupBy=workflow` emits as `workflowDynastySlug`. */
  workflowDynastySlug: string;
  /** Its human name, when workflow-service describes any version of it. Null otherwise. */
  workflowDynastyName: string | null;
  /** Every versioned slug the catalogue folds into it, ascending. Empty when it describes none. */
  workflowSlugs: string[];
  /** PURE: does a lead's FROZEN workflow slug belong to this dynasty? A lead served under no workflow never does. */
  includes(slug: string | null | undefined): boolean;
  /**
   * WHAT THE SPEND PRODUCERS ARE ASKED FOR — the comma-separated versioned slugs, resolved HERE.
   * A dynasty the catalogue does not describe is its own dynasty of one, so it asks for the dynasty
   * slug itself: a retired lineage still has cost rows and served leads under that exact slug, and
   * the producer's own dynasty resolution would 404 on it (see the module header).
   */
  producerSlugs: string;
}

/**
 * PURE: the scope, from a catalogue already in hand. Separated from the read below so the whole
 * membership rule is testable from one fixture without a network in sight.
 */
export function buildWorkflowScope(dynastySlug: string, workflows: WorkflowMetadata[]): WorkflowScope {
  const dynastyOf = dynastyOfSlug(workflows);
  const slugs = workflows.filter((w) => w.workflowDynastySlug === dynastySlug).map((w) => w.workflowSlug);
  const named = workflows.find((w) => w.workflowDynastySlug === dynastySlug && Boolean(w.workflowDynastyName));
  return {
    workflowDynastySlug: dynastySlug,
    workflowDynastyName: named?.workflowDynastyName ?? null,
    workflowSlugs: [...new Set(slugs)].sort(),
    includes: (slug) => Boolean(slug) && dynastyOf(slug as string) === dynastySlug,
    producerSlugs: (slugs.length > 0 ? [...new Set(slugs)].sort() : [dynastySlug]).join(","),
  };
}

/**
 * The request-path read. FAIL-LOUD, for the reason in the module header: a degraded catalogue would
 * silently narrow the answer to one version of the workflow the caller named.
 */
export async function resolveWorkflowScope(featureSlug: string, dynastySlug: string): Promise<WorkflowScope> {
  return buildWorkflowScope(dynastySlug, await fetchPublicWorkflows(featureSlug, "all"));
}
