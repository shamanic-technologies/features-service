/**
 * WHICH OF THE WORKFLOWS WE RAN FOR THIS BRAND MADE MONEY — the measured-money answer `/revenue`
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
 * shape the funnel ranking uses to rank N funnels off one evidence fetch. Reusing the per-campaign
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
 *
 * ── THE VOLUME HALF, AND WHY IT IS ONE COMMITTED BASIS ──────────────────────────────────────────
 *
 * The money block answers what came back. `outcomes` answers what it was made of: how many people
 * this workflow reached, how many of them visited the site, how many replied positively, what each
 * of those cost, and the committed dollars behind all of it. Same six answers the un-grouped brand
 * read already gives for the whole brand — absent per workflow until now, and underivable by a
 * consumer (a group is a DYNASTY, so a browser would have to sum versions and re-divide).
 *
 * EVERY figure in a group rides COMMITTED spend — the single basis `costEconomics` rides, the same
 * total the brand read's `spend` block reports. So `cpcCents × recipientsClicked ≈ committedSpentCents`
 * by construction, and a workflow's ROI and its cost per click are two views of one number. This block
 * once rode billed-only spend on purpose, to avoid a committed numerator beside a realized ROI; the
 * ROI moved to committed, so the divergence has no reason to exist and would now BE the incoherence.
 * `actualSpentCents` stays reported (billed-only, honest) for the consumer transition and is divided
 * by nowhere. The rates are OBSERVED — ACCOUNTING, "what did this cost", so a workflow with spend and
 * no outcome of a kind reports NULL for that kind's rate ("we could not measure this"), never 0 and
 * never a floored estimate. Projection per workflow already has its own surface:
 * `/workflow-projection`.
 */
import { contactedPricingSoft } from "../routes/contacted-value.js";
import type { ContactedPricing, TimeSeriesPoint } from "./revenue-engine.js";
import { restrictPathsToDeclaredLegs, type getFunnel } from "./funnel-registry.js";
import type { PipelineUnpricedReason, PricedEconomics } from "./offer-priced-economics.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import { buildCostEconomics, type CostEconomics } from "./cost-economics.js";
import { computeRevenue, dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { buildRevenueOutcomes, type RevenueOutcomes } from "./revenue-outcomes.js";
import { WHOLE_BASIS, type RatioBasis } from "./ratio-basis.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchRunsCostCentsByWorkflowSlug, fetchMatureSpendCents, type RunsCostCents } from "./runs-cost-client.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { buildMaturityPlan, matureCohortPersons, scopePredicate, type MaturityPlan } from "./roi-maturity.js";
import { fetchEventTimestamps } from "./email-status-client.js";
import { fetchObservedStepFacts } from "./observed-steps.js";
import { DEFAULT_PRICED_CAUSES, type OutcomeCause } from "./outcome-cause.js";
import { fetchQualifications } from "./qualifications-client.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { fetchPublicWorkflows, type WorkflowMetadata } from "./public-stats-clients.js";
// ONE implementation of "which dynasty is this slug", shared with the `?workflow=` drill-down —
// so the key this grain EMITS and the key that read RESOLVES can never disagree about a version.
import { dynastyOfSlug } from "./workflow-scope.js";
import type { Pricing } from "./pricing.js";
import { campaignScopeIds, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";
import { serveDatesStated } from "./mature-evidence.js";
import {
  buildScopeMaturity,
  centsTextToUsd,
  costRatiosPair,
  fetchSpendSplit,
  outcomeRatiosPair,
  splitByCampaignFor,
  UNKNOWN_SCOPE_MATURITY,
  type ScopeCampaign,
  type ScopeMaturity,
  type SpendSplit,
} from "./scope-maturity.js";

/**
 * The volume half of a workflow's answer — this brand's OWN outreach through this dynasty, and what
 * it cost. Every field is scoped to (this brand, this feature, this dynasty), versions folded in.
 *
 * The SHARED block every `/revenue` grain answers (`lib/revenue-outcomes.ts`), which is where the
 * counting, null and spend-basis rules live. Applied here: a lead served under two workflows is ONE
 * lead to the brand and belongs to BOTH groups, so across several workflows the counts do not sum to
 * the brand — the same counting-people property the money half already carries. A lead the producer
 * served under no workflow is in no group.
 */
export type WorkflowRevenueOutcomes = RevenueOutcomes;

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
    /** Why `totalPipelineUsd` is null (the brand read's own reason); null when it is priced. */
    unpricedReason: PipelineUnpricedReason | null;
  };
  costEconomics: CostEconomics;
  /** ADDITIVE, purely — the volume half. See {@link WorkflowRevenueOutcomes}. */
  outcomes: WorkflowRevenueOutcomes;
  /**
   * THIS WORKFLOW'S MATURITY IN THIS SCOPE (`lib/scope-maturity.ts`): its per-leg figures on both bases
   * and its verdict — the object every surface serves, so a workflow row and the campaign above it are
   * judged by one rule. Null when the read held no spend split (the fleet curve's internal passes).
   */
  maturity?: ScopeMaturity | null;
  /**
   * OFF THE WIRE, present only when the caller asked (`withPipelineTimeSeries`): the engine's own dated,
   * cumulative pipeline for this dynasty — the byte-same series `/revenue`'s `roiHistory` draws. The
   * fleet per-workflow return curve (`lib/fleet-workflow-return.ts`) sums it across orgs. The
   * `?groupBy=workflow` read never asks for it, so its body is unchanged.
   */
  pipelineTimeSeries?: TimeSeriesPoint[];
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
 * PURE: the volume half for ONE dynasty's persons + its realized cents — the shared builder, under
 * the name this grain's tests and callers already use. One implementation, so the workflow grain and
 * the campaign grain can never disagree about whether a lead clicked.
 */
export const buildWorkflowOutcomes = buildRevenueOutcomes;

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
  costCentsBySlug: Map<string, RunsCostCents>;
  workflows: WorkflowMetadata[];
  funnel: ReturnType<typeof getFunnel>;
  /** The brand's DECLARED-funnel-priced economics — resolved ONCE by the route, shared by every group. */
  priced: { economics: PricedEconomics; pricedFunnelKeys: SalesFunnelKey[] } | null;
  /**
   * The MATURE cohort each group's ratios divide (`lib/roi-maturity.ts`): which campaigns are maturing,
   * and the mature spend per versioned slug. Omitted → nothing in scope is maturing, and every ratio
   * rides the whole scope, exactly as before.
   */
  maturity?: { plan: MaturityPlan; matureCostBySlug: Map<string, RunsCostCents> } | "unknown";
  /** How a contacted lead that has not engaged is priced — the brand read's own (`ContactedPricing`). */
  contacted?: ContactedPricing | null;
  /** Attach each group's dated pipeline (`pipelineTimeSeries`). Off by default: the wire read omits it. */
  withPipelineTimeSeries?: boolean;
  /**
   * The scope's spend per (versioned slug × campaign) on both bases, summed exactly, and the scope's
   * campaigns with their legs (null = legs unreadable) — what each group's maturity pairs divide. Omitted
   * → no pair is attached (a caller that never asked, like the fleet curve's per-brand passes).
   */
  maturitySplit?: { campaigns: ScopeCampaign[] | null; split: Map<string, SpendSplit> } | null;
}): WorkflowRevenueGroup[] {
  const { persons, costCentsBySlug, workflows, funnel, priced, maturity, withPipelineTimeSeries, maturitySplit } = input;
  // One flag for the read: a mature cut needs the legs AND serve dates on the persons it cuts.
  const cuttable =
    maturitySplit != null && maturitySplit.campaigns !== null && maturity !== "unknown" && serveDatesStated(persons);
  const contacted = input.contacted ?? null;
  const dynastyOf = dynastyOfSlug(workflows);
  const names = dynastyNames(workflows);

  const costByDynasty = new Map<string, RunsCostCents>();
  const slugsByDynasty = new Map<string, Set<string>>();
  for (const [slug, cents] of costCentsBySlug) {
    const dynasty = dynastyOf(slug);
    const prev = costByDynasty.get(dynasty);
    costByDynasty.set(dynasty, {
      committedCents: (prev?.committedCents ?? 0) + cents.committedCents,
      actualCents: (prev?.actualCents ?? 0) + cents.actualCents,
    });
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
  const unpricedReason: PipelineUnpricedReason = !funnel
    ? "no_funnel_wired"
    : (priced?.economics.unpricedReason ?? "no_priced_funnel");
  // The SAME leg restriction the brand read applies: only the legs of the funnels the brand declared
  // carry value. A workflow does not state a funnel of its own, so every group is priced on the
  // brand's funnels — which is also why a single-workflow brand lands on the brand's own figure.
  const paths =
    funnel && economics
      ? restrictPathsToDeclaredLegs(
          funnel.resolvePaths({ economics, pricedFunnelKeys: priced!.pricedFunnelKeys }),
          priced!.pricedFunnelKeys,
        )
      : null;

  return [...slugsByDynasty.keys()]
    .sort()
    .map((dynasty) => {
      const cost: RunsCostCents = costByDynasty.get(dynasty) ?? { committedCents: 0, actualCents: 0 };
      const mine = personsByDynasty.get(dynasty) ?? [];
      // No funnel wired / cold start → a null pipeline, exactly as the brand read reports it. Null is
      // "we could not price this", never "it returned nothing".
      const revenue =
        paths && economics && funnel ? computeRevenue(paths, mine, economics.lifetimeRevenueUsd, funnel.milestones, contacted) : null;
      const totalPipelineUsd = revenue ? revenue.headline.totalPipelineUsd : null;
      // The same dynasty's MATURE cohort: its versions' mature spend, and its leads first contacted
      // before the cutoff — the byte-same rule the brand read applies, so a single-workflow brand still
      // reads its brand's own ratios at both grains.
      const known = maturity && maturity !== "unknown" ? maturity : undefined;
      let matureCents = 0;
      let matureActualCents = 0;
      for (const slug of slugsByDynasty.get(dynasty) ?? []) {
        matureCents += known?.matureCostBySlug.get(slug)?.committedCents ?? 0;
        matureActualCents += known?.matureCostBySlug.get(slug)?.actualCents ?? 0;
      }
      // The ratios on the volume half divide the SAME cohort the ROI divides (`lib/ratio-basis.ts`).
      const ratioBasis: RatioBasis =
        maturity === "unknown"
          ? { kind: "unknown" }
          : known
            ? {
                kind: "mature",
                days: known.plan.days,
                cost: { committedCents: matureCents, actualCents: matureActualCents },
                persons: matureCohortPersons(mine, known.plan),
              }
            : WHOLE_BASIS;
      const maturePipelineUsd =
        known && paths && economics && funnel
          ? computeRevenue(paths, matureCohortPersons(mine, known.plan), economics.lifetimeRevenueUsd, funnel.milestones, contacted)
              .headline.totalPipelineUsd
          : null;
      // THIS DYNASTY'S MATURITY: its versions' exact spend per campaign on both bases, its own persons,
      // judged per leg exactly as every other scope is (`lib/scope-maturity.ts`).
      const dynastySlugs = slugsByDynasty.get(dynasty) ?? new Set<string>();
      const dynastySplit = maturitySplit
        ? splitByCampaignFor(maturitySplit.split, (slug) => slug != null && dynastySlugs.has(slug))
        : null;
      const scopeMaturity: ScopeMaturity | null = dynastySplit
        ? maturitySplit!.campaigns
          ? buildScopeMaturity({
              campaigns: maturitySplit!.campaigns,
              persons: mine,
              spend: dynastySplit,
              serveDatesStated: cuttable,
            })
          : UNKNOWN_SCOPE_MATURITY
        : null;
      const bases = dynastySplit
        ? {
            flashSpendUsd: centsTextToUsd([...dynastySplit.values()].map((v) => v.flash)),
            matureSpendUsd: cuttable ? centsTextToUsd([...dynastySplit.values()].map((v) => v.mature)) : null,
            persons: mine,
            maturePersons: cuttable ? (known ? matureCohortPersons(mine, known.plan) : mine) : null,
            isMature: scopeMaturity?.isMature ?? null,
          }
        : null;
      const costEconomics = buildCostEconomics({
        committedCostInUsdCents: cost.committedCents,
        actualCostInUsdCents: cost.actualCents,
        totalPipelineUsd,
        lifetimeRevenueUsd: economics?.lifetimeRevenueUsd,
        ...(maturity === "unknown"
          ? { maturity: { unknown: true as const } }
          : known
            ? { maturity: { days: known.plan.days, committedCostInUsdCents: matureCents, totalPipelineUsd: maturePipelineUsd } }
            : {}),
      });
      // The volume half is funnel-INDEPENDENT on purpose: how many people a workflow reached is a
      // measured fact, so it is answered even for a brand with no funnel wired and no economics —
      // exactly the brand whose money half is honestly null.
      const outcomes = buildWorkflowOutcomes(mine, cost, ratioBasis);
      if (bases) {
        costEconomics.maturity = costRatiosPair(
          bases,
          { flash: totalPipelineUsd, mature: known ? maturePipelineUsd : totalPipelineUsd },
          economics?.lifetimeRevenueUsd,
        );
        outcomes.maturity = outcomeRatiosPair(bases);
      }
      return {
        workflowDynastySlug: dynasty,
        workflowDynastyName: names.get(dynasty) ?? null,
        workflowSlugs: [...(slugsByDynasty.get(dynasty) ?? [])].sort(),
        headline: {
          totalPipelineUsd,
          unpricedReason: totalPipelineUsd === null ? unpricedReason : null,
        },
        costEconomics,
        outcomes,
        ...(scopeMaturity !== null ? { maturity: scopeMaturity } : {}),
        ...(withPipelineTimeSeries ? { pipelineTimeSeries: revenue?.timeSeries ?? [] } : {}),
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
  priced: { economics: PricedEconomics; pricedFunnelKeys: SalesFunnelKey[] } | null;
  /**
   * ONE CAMPAIGN — its whole IDENTITY, the family of rows sharing (org, brand, sales funnel,
   * acquisition channel) — when the caller named one. Every group then states what THAT campaign did
   * and spent through each workflow: the customer opens a campaign's Workflows page, and a brand
   * figure under a campaign's name is the wrong-grain bug this fleet has already paid for once.
   *
   * It narrows the SCOPE and nothing else — same partition, same engine, same brand-priced economics
   * — so a brand whose whole spend sits on one campaign identity reads the byte-same groups either
   * way. `undefined` → the brand's whole spend → byte-identical to today.
   */
  campaignScope?: CampaignFilter;
  /**
   * WHOSE WINS THIS GRAIN COUNTS (`lib/outcome-cause.ts`). Threaded so a workflow row and the brand
   * read above it can never be built on two different bases — a grain left behind reproduces the
   * overstatement one click away. Defaults to every state: byte-identical to today.
   */
  causes?: readonly OutcomeCause[];
  /** See `buildWorkflowRevenueGroups`. Only the fleet per-workflow curve asks for it. */
  withPipelineTimeSeries?: boolean;
  /**
   * Attach each group's maturity pairs (default). The fleet per-workflow curve turns it off: it keeps
   * only the dated pipeline, and a spend split per (org, brand) pair would be reads nobody uses.
   */
  withMaturity?: boolean;
}): Promise<WorkflowRevenueGroup[]> {
  const { featureSlug, brandId, funnel, headers, pricing, priced, campaignScope } = input;
  const causes = input.causes ?? DEFAULT_PRICED_CAUSES;
  // The single campaign id the campaign-SCOPED per-email overlays still take: the requested campaign
  // for a single scope, `undefined` for a family (no producer accepts a campaign list). The two legs
  // that must be family-EXACT — cost and leads — take the scope itself.
  const campaignId = singleCampaignId(campaignScope);

  // Which of the scope's campaigns are still maturing, then the mature spend per slug — the ratios'
  // denominator (`lib/roi-maturity.ts`). Fail-loud, like the cost read beside it.
  // The leg read is soft (the brand read's rule): unreadable legs null the ratios with a named reason.
  const legsPromise = fetchBrandCampaignRows(brandId, undefined, headers).then(
    (rows) => {
      const inScope = scopePredicate({ featureSlugs: [featureSlug], campaignIds: campaignScopeIds(campaignScope) });
      return {
        plan: buildMaturityPlan(rows, inScope),
        campaigns: rows.filter(inScope).map((row): ScopeCampaign => ({ id: row.id, legKey: row.legKey ?? null })),
      };
    },
    (err) => {
      console.error(
        `[features-service] campaign legs unreadable for brand ${brandId} — per-workflow ROI / CAC read null (maturity_unknown): ${(err as Error).message}`,
      );
      return null;
    },
  );
  const maturityPromise = legsPromise.then(async (legs) => {
    if (legs === null) return "unknown" as const;
    if (!legs.plan.cutoffIso) return undefined;
    const mature = await fetchMatureSpendCents(brandId, campaignScope, featureSlug, headers, pricing, legs.plan);
    return { plan: legs.plan, matureCostBySlug: mature.bySlug };
  });
  // Each group's maturity pairs divide its versions' spend per campaign, summed exactly — one read
  // split by (slug × campaign). SOFT, with a loud log: a read these groups did not make before the pairs
  // existed must null the pairs, never 502 the grouped read. With the legs unknown it still reads the
  // flash half and every mature half is null.
  const splitPromise =
    input.withMaturity === false
      ? Promise.resolve(null)
      : legsPromise
          .then(async (legs) => ({
            campaigns: legs?.campaigns ?? null,
            split: await fetchSpendSplit({
              brandId,
              featureScope: featureSlug,
              campaignIds: campaignScopeIds(campaignScope),
              campaigns: legs?.campaigns ?? [],
              by: "workflowSlug",
              headers,
              pricing,
            }),
          }))
          .catch((err: Error) => {
            console.error(`[features-service] workflow maturity spend split unreadable for brand ${brandId} (pairs absent): ${err.message}`);
            return null;
          });
  const [costCentsBySlug, persons, workflows, maturity, contacted, maturitySplit] = await Promise.all([
    fetchRunsCostCentsByWorkflowSlug(brandId, featureSlug, headers, pricing, campaignScope),
    // The workflow grain PARTITIONS the leads of its scope: brand-wide by default, the campaign's own
    // rows when one is named. Never narrower than the scope, never wider.
    fetchLeadsForRevenue(brandId, campaignScope, headers),
    fetchWorkflowMetadataSoft(featureSlug),
    maturityPromise,
    // The brand read's own contacted-lead pricing, so a workflow row prices a contacted lead the same.
    contactedPricingSoft(brandId, headers),
    splitPromise,
  ]);

  // The overlays are brand-wide too (a lead's open date does not depend on which workflow reached
  // it), so they are fetched ONCE and merged before the partition — every group then prices the
  // identical lead the brand read prices.
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, observed, quals] = await Promise.all([
    fetchEventTimestamps(brandId, campaignId, emails, headers).catch((err) => {
      console.warn(`[features-service] event-timestamp enrichment failed (degrading to dateless): ${(err as Error).message}`);
      return null;
    }),
    fetchObservedStepFacts(brandId, causes).catch((err) => {
      console.warn(`[features-service] observed step statements failed (degrading to the projection alone): ${(err as Error).message}`);
      return null;
    }),
    // The LEGACY half, still carrying real booked/closed outcomes for brands nobody has restated yet.
    fetchQualifications(brandId, campaignId, emails, headers).catch((err) => {
      console.warn(`[features-service] qualification enrichment failed (degrading to no legacy meeting/close dates): ${(err as Error).message}`);
      return null;
    }),
  ]);
  applySignalOverlays(persons, timestamps, observed?.byEmail ?? null, quals, priced?.pricedFunnelKeys ?? [], causes);

  return buildWorkflowRevenueGroups({
    persons,
    costCentsBySlug,
    workflows,
    funnel,
    priced,
    maturity,
    contacted,
    withPipelineTimeSeries: input.withPipelineTimeSeries,
    maturitySplit,
  });
}
