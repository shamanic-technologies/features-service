/**
 * WHICH OF THE WORKFLOWS WE RAN FOR THIS BRAND MADE MONEY — the realized-money answer `/revenue`
 * already gives for a brand and for its campaigns, at the grain of the WORKFLOW.
 *
 * A consumer cannot roll this up from the per-campaign answer: one brand runs ~20 campaigns over ~15
 * workflows, several workflows carrying two to four campaigns, so a per-workflow figure would mean
 * summing pipeline in the browser and re-deriving the ratios there — client-side money math, which
 * would drift from the brand Overview the moment either side changed. So it is answered here, from
 * the same evidence, through the same engine.
 *
 * ── WHAT A WORKFLOW IS ──────────────────────────────────────────────────────────────────────────
 *
 * A DYNASTY, not a versioned slug. Every other surface in this service treats a workflow as one
 * dynasty (workflow-projection's three grains, the Strategy page's pick, the cross-org per-workflow
 * benchmark), so a version-grain answer here would be a second, incompatible vocabulary — and the
 * consumer renders these figures BESIDE the cross-org benchmark for the same workflow, which is
 * dynasty-keyed. Upgrading a workflow to v2 does not make it a different workflow that earned
 * nothing. `workflowSlugs` lists the versions folded in, so nothing is hidden.
 *
 * A slug workflow-service does not describe (metadata unreachable, or a version outside every known
 * dynasty) is ITS OWN dynasty of one — never dropped and never folded onto a neighbour on a guess.
 * That matters: the dynasty rollups elsewhere are built from ACTIVE workflows only, so a retired
 * lineage would vanish, taking its spend with it — and "which workflows burned money" is exactly the
 * question a retired one answers.
 *
 * ── HOW RUNS AND OUTCOMES ARE ATTRIBUTED ────────────────────────────────────────────────────────
 *
 * Both legs come from the producer that froze the attribution at write time, never from an inference:
 *
 *   - SPEND: runs-service `groupBy=workflowSlug` — byte the same request the brand read already
 *     makes, kept split instead of summed (`fetchRunsCostCentsByWorkflowSlug`).
 *   - LEADS: the `workflowSlug` lead-service froze on each `leads_campaigns` row at serve time.
 *
 * Do NOT substitute the campaign row's workflow for either. campaign-service now SWITCHES the
 * workflow of the campaign already alive on an identity instead of opening a new row, so a campaign's
 * current workflow mis-attributes every lead and every dollar it spent before the switch.
 *
 * ── WHY THE FAN-OUT DOES NOT MULTIPLY ───────────────────────────────────────────────────────────
 *
 * ONE brand-wide lead read, ONE cost read, ONE overlay pair — then N pure engine passes, exactly the
 * shape `/funnel-ranking` uses to rank N funnels off one evidence fetch. Reusing the per-campaign
 * machinery instead (one `computeFeatureRevenue` per group) would re-read the brand's leads once per
 * workflow, and this process parses that page under a 384 MB heap.
 *
 * ── WHAT RECONCILES, AND WHAT DOES NOT ──────────────────────────────────────────────────────────
 *
 * A brand whose spend all sits on ONE workflow reads the same four figures at both grains, by
 * construction (same request, same engine, same economics). Across SEVERAL workflows the groups do
 * NOT sum to the brand: a lead served under two workflows is one lead to the brand and belongs to
 * both workflows, and the engine's per-organisation combination is not additive across partitions.
 * That is the same property the per-campaign grain already has, and it is a property of counting
 * people rather than an error to correct.
 */
import { restrictPathsToDeclaredLegs, type EconomicsSource, type getFunnel } from "./funnel-registry.js";
import type { EffectiveEconomics } from "./sales-economics-client.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import { buildCostEconomics, type CostEconomics } from "./cost-economics.js";
import { computeRevenue, type EnginePerson } from "./revenue-engine.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchRunsCostCentsByWorkflowSlug } from "./runs-cost-client.js";
import { fetchEventTimestamps } from "./email-status-client.js";
import { fetchQualifications } from "./qualifications-client.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { fetchPublicWorkflows, type WorkflowMetadata } from "./public-stats-clients.js";
import type { Pricing } from "./pricing.js";

/** One workflow the brand has run, and what it returned. The four figures are the brand read's own. */
export interface WorkflowRevenueGroup {
  /** The dynasty — a workflow's identity across its versions. The key a consumer joins a benchmark on. */
  workflowDynastySlug: string;
  /** Human name of the dynasty. Null when workflow-service does not describe this slug. */
  workflowDynastyName: string | null;
  /** Every versioned slug folded into this group, ascending. `[dynastySlug]` when it has one version. */
  workflowSlugs: string[];
  headline: {
    totalPipelineUsd: number | null;
    economicsSource: EconomicsSource | null;
  };
  costEconomics: CostEconomics;
}

type Headers = { orgId: string; userId?: string; runId?: string; featureSlug?: string };

/**
 * The workflow metadata, SOFT. It decides how versions are GROUPED, not what any figure is: with
 * workflow-service unreachable every slug becomes its own dynasty, which is the version-grain
 * answer — a poorer grouping of the same, correct numbers, not a fabricated one. Same posture as the
 * campaign-identity read on the sibling grain.
 */
async function fetchWorkflowMetadataSoft(featureSlug: string): Promise<WorkflowMetadata[]> {
  try {
    return await fetchPublicWorkflows(featureSlug, "all");
  } catch (err) {
    console.warn(
      `[features-service] workflow metadata unavailable (per-workflow revenue stays at the version grain): ${(err as Error).message}`,
    );
    return [];
  }
}

/** PURE: slug → its dynasty. A slug nobody describes is its own dynasty, never folded on a guess. */
export function dynastyOfSlug(workflows: WorkflowMetadata[]): (slug: string) => string {
  const map = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  return (slug: string) => map.get(slug) ?? slug;
}

/** PURE: dynasty slug → its human name, when workflow-service describes any version of it. */
function dynastyNames(workflows: WorkflowMetadata[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const w of workflows) {
    if (w.workflowDynastyName && !names.has(w.workflowDynastySlug)) {
      names.set(w.workflowDynastySlug, w.workflowDynastyName);
    }
  }
  return names;
}

/**
 * PURE: the groups, from evidence already in hand. Separated from the IO above so the whole
 * partition + pricing rule is testable from one fixture without a network in sight.
 *
 * The enumeration is the UNION of the workflows that spent and the workflows that served a lead —
 * "has runs for this brand and feature" in both of the ways that shows up. A workflow that spent and
 * reached nobody is a first-class answer here (it is the one the staff member is hunting), and a
 * workflow whose spend rows carry no cost but whose leads exist is still a workflow we ran.
 *
 * A lead the producer served under NO workflow is in no group — it belongs to none, and parking it on
 * one would invent an attribution nobody recorded.
 */
export function buildWorkflowRevenueGroups(input: {
  persons: EnginePerson[];
  costCentsBySlug: Map<string, number>;
  workflows: WorkflowMetadata[];
  funnel: ReturnType<typeof getFunnel>;
  /** The brand's DECLARED-funnel-priced economics — resolved ONCE by the route, shared by every group. */
  priced: { economics: EffectiveEconomics; pricedFunnelKeys: SalesFunnelKey[] } | null;
}): WorkflowRevenueGroup[] {
  const { persons, costCentsBySlug, workflows, funnel, priced } = input;
  const dynastyOf = dynastyOfSlug(workflows);
  const names = dynastyNames(workflows);

  const costByDynasty = new Map<string, number>();
  const slugsByDynasty = new Map<string, Set<string>>();
  for (const [slug, cents] of costCentsBySlug) {
    const dynasty = dynastyOf(slug);
    costByDynasty.set(dynasty, (costByDynasty.get(dynasty) ?? 0) + cents);
    (slugsByDynasty.get(dynasty) ?? slugsByDynasty.set(dynasty, new Set()).get(dynasty)!).add(slug);
  }

  const personsByDynasty = new Map<string, EnginePerson[]>();
  for (const person of persons) {
    if (!person.workflowSlug) continue;
    const dynasty = dynastyOf(person.workflowSlug);
    (slugsByDynasty.get(dynasty) ?? slugsByDynasty.set(dynasty, new Set()).get(dynasty)!).add(person.workflowSlug);
    const bucket = personsByDynasty.get(dynasty);
    if (bucket) bucket.push(person);
    else personsByDynasty.set(dynasty, [person]);
  }

  const economics = priced?.economics.economics ?? null;
  const economicsSource: EconomicsSource | null = !priced
    ? null
    : priced.economics.source === "user"
      ? "sales-economics"
      : "cross-brand-average";
  // The SAME leg restriction the brand read applies: only the legs of the funnels the brand declared
  // carry value. A workflow does not state a funnel of its own, so every group is priced on the
  // brand's chains — which is also why a single-workflow brand lands on the brand's own figure.
  const paths =
    funnel && economics
      ? restrictPathsToDeclaredLegs(funnel.resolvePaths({ economics }), priced!.pricedFunnelKeys)
      : null;

  return [...slugsByDynasty.keys()]
    .sort()
    .map((dynasty) => {
      const actualCostInUsdCents = costByDynasty.get(dynasty) ?? 0;
      const mine = personsByDynasty.get(dynasty) ?? [];
      // No funnel wired / cold start → a null pipeline, exactly as the brand read reports it. Null is
      // "we could not price this", never "it returned nothing".
      const totalPipelineUsd =
        paths && economics && funnel
          ? computeRevenue(paths, mine, economics.lifetimeRevenueUsd, funnel.milestones).headline.totalPipelineUsd
          : null;
      return {
        workflowDynastySlug: dynasty,
        workflowDynastyName: names.get(dynasty) ?? null,
        workflowSlugs: [...(slugsByDynasty.get(dynasty) ?? [])].sort(),
        headline: {
          totalPipelineUsd,
          economicsSource: totalPipelineUsd === null ? null : economicsSource,
        },
        costEconomics: buildCostEconomics(
          actualCostInUsdCents,
          totalPipelineUsd,
          economics?.lifetimeRevenueUsd,
        ),
      };
    });
}

/**
 * The request-path composition: one cost read, one lead read, one metadata read, one overlay pair —
 * then the pure build above.
 *
 * Cost and leads are FAIL-LOUD (a swallowed error would fake a $0 spend or a missing pipeline and
 * print an ROI nobody earned). The metadata read and both overlays are FAIL-SOFT with a loud log,
 * exactly as they are on the brand read: they enrich dates and grouping, they are not the money.
 */
export async function computeWorkflowRevenueGroups(input: {
  featureSlug: string;
  brandId: string;
  funnel: ReturnType<typeof getFunnel>;
  headers: Headers;
  pricing: Pricing;
  priced: { economics: EffectiveEconomics; pricedFunnelKeys: SalesFunnelKey[] } | null;
}): Promise<WorkflowRevenueGroup[]> {
  const { featureSlug, brandId, funnel, headers, pricing, priced } = input;

  const [costCentsBySlug, persons, workflows] = await Promise.all([
    fetchRunsCostCentsByWorkflowSlug(brandId, featureSlug, headers, pricing),
    // Brand-wide: the workflow grain partitions the brand's own leads, it never narrows the read.
    fetchLeadsForRevenue(brandId, undefined, headers),
    fetchWorkflowMetadataSoft(featureSlug),
  ]);

  // The overlays are brand-wide too (a lead's open date does not depend on which workflow reached
  // it), so they are fetched ONCE and merged before the partition — every group then prices the
  // identical lead the brand read prices.
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, quals] = await Promise.all([
    fetchEventTimestamps(brandId, undefined, emails, headers).catch((err) => {
      console.warn(`[features-service] event-timestamp enrichment failed (degrading to dateless): ${(err as Error).message}`);
      return null;
    }),
    fetchQualifications(brandId, undefined, emails, headers).catch((err) => {
      console.warn(`[features-service] qualification enrichment failed (degrading to no meeting/close dates): ${(err as Error).message}`);
      return null;
    }),
  ]);
  applySignalOverlays(persons, timestamps, quals);

  return buildWorkflowRevenueGroups({ persons, costCentsBySlug, workflows, funnel, priced });
}
