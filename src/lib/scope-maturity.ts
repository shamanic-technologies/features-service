/**
 * THE MATURITY OF ONE SCOPE, BUILT ONE WAY FOR EVERY SURFACE THAT DESCRIBES IT (features-service#1196).
 *
 * `lib/maturity.ts` owns the RULE: each leg's duration and bar, the cutoff, the lead cohort on the
 * run-start clock, the verdict, and the shared shapes (`OutcomeFigures`, `MaturityPair`,
 * `LegMaturityFigures`). This module owns the APPLICATION of that rule to a scope — a brand, an offer, a
 * campaign identity, an audience, a workflow — so /revenue, the audience rows, the offer outcomes, /stats
 * and the learning verdict cannot come to print two numbers for one scope.
 *
 * Measured in prod 2026-09-28 (campaign `3922c8e1…`, brand `a179bbd9…`, net): one campaign read FOUR
 * costs per positive reply — $87.58 on /revenue (a 14-day cohort), $107.77 on /stats and the offer
 * outcomes (all history), $68.38 on the learning verdict (one workflow's cells), $49.04 on most audience
 * rows (a floor). Each surface cut the evidence its own way.
 *
 * ── SPEND IS SUMMED EXACTLY, ON THE PRODUCER'S TEXT, AND NEVER ROUNDED HERE ───────────────────────
 *
 * runs-service states each cost as a 10-place decimal string. A scope's figure is the exact sum of its
 * groups' strings (`lib/decimal.ts`), converted to dollars once. Rounding each group to the cent made the
 * same campaign read 53,883 cents on /revenue and 53,882 summed over its audience rows (prod, above), and
 * a one-cent drift is enough to flip the printed cents of a cost per reply. Unrounded, a scope's rows add
 * up to the scope within float epsilon, and every surface prints the same cents.
 *
 * ── ONE ENTRY PER LEG, AND ONLY FOR A LEG WHOSE OUTCOME IS A COUNTED SIGNAL ───────────────────────
 *
 * A leg's figures divide its campaigns' spend by the distinct leads that reached its outcome signal
 * (`legMaturity(leg).outcomeSignal`: a positive reply on the conversation leg, a website visit on the
 * visit leg). Two kinds of campaign carry no such entry, on purpose:
 *   - a campaign stating NO leg (every such row in prod is a stopped pre-leg ancestor) — there is no
 *     outcome to count it in;
 *   - a leg whose outcome is not a signal a lead row carries — the AI meeting-booking channel
 *     (`conversation_to_meeting_booked`) serves no lead of its own, so its meetings are not on any person
 *     served under it and a count there would be a fabricated 0.
 * Their SPEND still counts wherever a block divides the scope's whole spend (ROI, cost per click): only
 * the per-leg figures and the verdict leave them out.
 *
 * ── THE VERDICT (`scopeMaturityVerdict`) ──────────────────────────────────────────────────────────
 *
 * A scope spanning several legs is mature when every leg PRESENT in its mature figures is mature
 * (`scopeIsMature`). A leg is present when its mature cohort holds spend or reached somebody. A scope
 * with flash activity and NO leg present is simply young: `false`, never null — "a campaign younger than
 * 21 days shows is_mature false with flash present" (the owner's AC). `null` is kept for "we could not
 * judge": a mature cut that could not be made (serve dates not stated), or nothing to judge at all.
 */
import { ratiosOf, type CostRatios } from "./cost-economics.js";
import { observedCostPerOutcome } from "./cost-engine.js";
import { decimalCentsToUsd, sumDecimalStrings } from "./decimal.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { featureSlugList, runsFeatureSlugsParam, type FeatureScope } from "./feature-scope.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { serveDatesStated } from "./mature-evidence.js";
import { scopePredicate } from "./roi-maturity.js";
import { fetchWithRetry } from "./fetch-retry.js";
import {
  legCutoffIso,
  legMaturity,
  legMaturityFigures,
  maturityCutoffIso,
  outcomeFigures,
  maturityPair,
  scopeIsMature,
  servedInMatureCohort,
  startedBeforeParam,
  type LegMaturityFigures,
  type MaturityPair,
  type OutcomeFigures,
} from "./maturity.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "./pricing.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";

/** One campaign of a scope, as far as maturity needs it: its id and the leg it is bought for. */
export interface ScopeCampaign {
  id: string;
  legKey: string | null;
}

/**
 * The exact spend of ONE key on both bases, as decimal CENTS text (never rounded):
 *  - `flash`  — every run of the key;
 *  - `mature` — the runs STARTED before the cutoff of the key's campaign's leg, or `flash` itself when
 *               that leg matures the day it is bought (0 days) or the run carries no campaign.
 */
export interface SpendSplit {
  flash: string;
  mature: string;
}

/** The scope's verdict and its per-leg figures — what every surface serves as `maturity`. */
export interface ScopeMaturity {
  /** See the module header. `null` = could not judge; never a Learning verdict. */
  isMature: boolean | null;
  /** One entry per leg the scope's campaigns are bought for whose outcome is a counted signal. */
  legs: LegMaturityFigures[];
}

/** The key a `campaignId`-only split is stored under. Runs carrying no campaign sit under `""`. */
export function campaignKey(campaignId: string | null | undefined): string {
  return campaignId ?? "";
}

/** The key an (extra dimension × campaign) split is stored under. */
export function pairKey(dimension: string | null | undefined, campaignId: string | null | undefined): string {
  return `${dimension ?? ""}|${campaignId ?? ""}`;
}

/**
 * The producer's figure as decimal text. runs-service's billed fields ARE decimal text and pass through
 * untouched; a figure this service composed from two of them (the vendor basis adds the refunded bucket
 * back) is a JS number rendered by `String`, which can come out in exponent form for a tiny value — it is
 * re-rendered at the producer's own ten places so the exact adder can read it.
 */
function decimalText(raw: string): string {
  return /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : Number(raw).toFixed(10);
}

/** The (dimension, campaign) a {@link pairKey} was built from. */
export function parsePairKey(key: string): { dimension: string | null; campaignId: string | null } {
  const at = key.lastIndexOf("|");
  const dimension = key.slice(0, at);
  const campaignId = key.slice(at + 1);
  return { dimension: dimension || null, campaignId: campaignId || null };
}

/**
 * The split of ONE value of the extra dimension (an audience, a workflow's versions), re-keyed by campaign
 * — what `buildScopeLegs` takes. `keep` picks the dimension values that belong to the group.
 */
export function splitByCampaignFor(
  split: ReadonlyMap<string, SpendSplit>,
  keep: (dimension: string | null) => boolean,
): Map<string, SpendSplit> {
  const acc = new Map<string, { flash: string[]; mature: string[] }>();
  for (const [key, value] of split) {
    const { dimension, campaignId } = parsePairKey(key);
    if (!keep(dimension)) continue;
    const id = campaignKey(campaignId);
    const entry = acc.get(id) ?? { flash: [], mature: [] };
    entry.flash.push(value.flash);
    entry.mature.push(value.mature);
    acc.set(id, entry);
  }
  return new Map([...acc].map(([id, e]) => [id, { flash: sumDecimalStrings(e.flash), mature: sumDecimalStrings(e.mature) }]));
}

/** Dollars of an exact decimal-cents sum — converted once, never rounded. */
export function centsTextToUsd(cents: readonly string[]): number {
  return decimalCentsToUsd(sumDecimalStrings(cents));
}

export interface SpendSplitRequest {
  brandId: string;
  featureScope: FeatureScope;
  /**
   * The campaign ids the read is narrowed to. `[]` = every campaign of the channel set. ONE id takes
   * runs-service's own `campaignId` filter; SEVERAL (a campaign family, an offer) are kept locally from a
   * brand-wide read, because runs-service takes no campaign list on this route.
   */
  campaignIds: readonly string[];
  /** Every campaign the scope may hold, with its leg — it decides which cutoff each campaign is cut at. */
  campaigns: readonly ScopeCampaign[];
  /** A dimension to split by BESIDE the campaign: the audience rows, or the workflow grain. */
  by?: "audienceId" | "workflowSlug";
  /** A workflow drill-down's versioned slugs, comma-separated (`WorkflowScope.producerSlugs`). */
  workflowSlugs?: string;
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string };
  pricing: Pricing;
  now?: Date;
}

/**
 * The scope's spend split per key, on both bases — ONE flash read plus one `startedBefore` read per
 * distinct cutoff in the scope (one, today: both measured legs wait 21 days). Fail-loud, like every other
 * spend read on these bodies: a swallowed error would print a cost per outcome resting on no spend.
 */
export async function fetchSpendSplit(req: SpendSplitRequest): Promise<Map<string, SpendSplit>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");

  const now = req.now ?? new Date();
  const single = req.campaignIds.length === 1 ? req.campaignIds[0]! : undefined;
  const family = req.campaignIds.length > 1 ? new Set(req.campaignIds) : null;
  const legOf = new Map(req.campaigns.map((c) => [c.id, c.legKey] as const));
  const cutoffOf = (campaignId: string | null | undefined): string | null => {
    if (!campaignId) return null;
    const days = legMaturity(legOf.get(campaignId) ?? null).durationDays;
    return days > 0 ? maturityCutoffIso(days, now) : null;
  };
  const cutoffs = [...new Set(req.campaigns.map((c) => cutoffOf(c.id)).filter((c): c is string => c != null))];

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": req.headers.orgId,
    "x-brand-id": req.brandId,
  };
  if (req.headers.userId) headers["x-user-id"] = req.headers.userId;
  if (req.headers.runId) headers["x-run-id"] = req.headers.runId;
  if (single) headers["x-campaign-id"] = single;
  if (req.headers.featureSlug) headers["x-feature-slug"] = req.headers.featureSlug;

  const read = async (startedBefore: string | null): Promise<Map<string, { campaignId: string | null; cents: string[] }>> => {
    const params = new URLSearchParams({
      groupBy: req.by ? `${req.by},campaignId` : "campaignId",
      brandId: req.brandId,
      featureSlugs: runsFeatureSlugsParam(req.featureScope),
    });
    if (single) params.set("campaignId", single);
    if (req.workflowSlugs) params.set("workflowSlugs", req.workflowSlugs);
    if (startedBefore) params.set("startedBefore", startedBeforeParam(startedBefore));
    const response = await fetchWithRetry(
      runsCostsUrl(url, "org", req.pricing, params),
      { headers },
      // The before-cutoff half covers the history and its URL moves once a day: shared across a view's
      // refreshes for 30s like every other slow-moving input.
      startedBefore ? { shareForMs: 30_000 } : undefined,
    );
    if (!response.ok) {
      throw new Error(`runs-service /v1/stats/costs (maturity split) failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as {
      groups?: Array<Record<string, unknown> & { dimensions?: Record<string, string | null> }>;
    };
    if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
    const out = new Map<string, { campaignId: string | null; cents: string[] }>();
    for (const group of data.groups) {
      const campaignId = group.dimensions?.campaignId ?? null;
      if (campaignId === "__total__") continue;
      if (family && (!campaignId || !family.has(campaignId))) continue;
      const dim = req.by ? (group.dimensions?.[req.by] ?? null) : null;
      if (dim === "__total__") continue;
      const key = req.by ? pairKey(dim, campaignId) : campaignKey(campaignId);
      const entry = out.get(key) ?? { campaignId, cents: [] };
      entry.cents.push(decimalText(selectCostCentsString(group, "totalCostInUsdCents", req.pricing)));
      out.set(key, entry);
    }
    return out;
  };

  const [flash, ...befores] = await Promise.all([read(null), ...cutoffs.map((c) => read(c))]);
  const beforeByCutoff = new Map(cutoffs.map((c, i) => [c, befores[i]!] as const));

  const split = new Map<string, SpendSplit>();
  for (const [key, entry] of flash!) {
    const flashCents = sumDecimalStrings(entry.cents);
    const cutoff = cutoffOf(entry.campaignId);
    const matureCents = cutoff ? sumDecimalStrings(beforeByCutoff.get(cutoff)?.get(key)?.cents ?? []) : flashCents;
    split.set(key, { flash: flashCents, mature: matureCents });
  }
  return split;
}

/** The scope's spend on both bases: the exact sum of every key in the split, in dollars. */
export function scopeSpendUsd(split: ReadonlyMap<string, SpendSplit>): { flash: number; mature: number } {
  const values = [...split.values()];
  return {
    flash: centsTextToUsd(values.map((v) => v.flash)),
    mature: centsTextToUsd(values.map((v) => v.mature)),
  };
}

/** Distinct leads among `rows` that were contacted, and that reached `signal`. */
function countLeads(rows: EnginePerson[], signal: string): { contacted: number; outcomes: number } {
  let contacted = 0;
  let outcomes = 0;
  for (const person of dedupPersonsByLead(rows)) {
    if (person.signals.contacted) contacted += 1;
    if (person.signals[signal]) outcomes += 1;
  }
  return { contacted, outcomes };
}

/**
 * PURE. The scope's per-leg figures on both bases.
 *
 * `spend` is keyed by campaign id (`campaignKey`). `serveDatesStated` false means the persons carry no
 * serve date at all (a producer predating it): the mature cut cannot be made, so every `mature` is null
 * and the verdict cannot be reached — never the flash figure served under the mature name.
 */
export function buildScopeLegs(input: {
  campaigns: readonly ScopeCampaign[];
  persons: readonly EnginePerson[];
  spend: ReadonlyMap<string, SpendSplit>;
  serveDatesStated: boolean;
  now?: Date;
}): LegMaturityFigures[] {
  const now = input.now ?? new Date();
  const byLeg = new Map<string, Set<string>>();
  for (const campaign of input.campaigns) {
    if (!campaign.legKey) continue;
    const ids = byLeg.get(campaign.legKey) ?? new Set<string>();
    ids.add(campaign.id);
    byLeg.set(campaign.legKey, ids);
  }
  const legs: LegMaturityFigures[] = [];
  for (const legKey of [...byLeg.keys()].sort()) {
    const rule = legMaturity(legKey);
    if (!rule.outcomeSignal) continue;
    const ids = byLeg.get(legKey)!;
    const splits = [...ids].map((id) => input.spend.get(campaignKey(id))).filter((s): s is SpendSplit => s != null);
    const rows = input.persons.filter((p) => p.campaignId != null && ids.has(p.campaignId));
    const flashCounts = countLeads(rows, rule.outcomeSignal);
    const flash = outcomeFigures(centsTextToUsd(splits.map((s) => s.flash)), flashCounts.contacted, flashCounts.outcomes);
    let mature: OutcomeFigures | null = null;
    if (input.serveDatesStated) {
      const cutoff = legCutoffIso(legKey, now);
      const matureCounts = countLeads(
        rows.filter((p) => servedInMatureCohort(p.servedAt, cutoff)),
        rule.outcomeSignal,
      );
      mature = outcomeFigures(centsTextToUsd(splits.map((s) => s.mature)), matureCounts.contacted, matureCounts.outcomes);
    }
    legs.push(legMaturityFigures(legKey, flash, mature));
  }
  return legs;
}

const active = (figures: OutcomeFigures | null): boolean =>
  figures != null && (figures.spentUsd > 0 || figures.contacted > 0);

/**
 * PURE. The scope's verdict from its legs — see the module header. A leg whose mature cut could not be
 * made (`mature` null) while it has flash activity is an unknown leg: it makes the verdict null unless
 * another leg already answered `false`.
 */
export function scopeMaturityVerdict(legs: readonly LegMaturityFigures[]): boolean | null {
  let flashActivity = false;
  const present: Array<{ legKey: string | null; matureOutcomes: number | null }> = [];
  for (const leg of legs) {
    if (active(leg.flash)) flashActivity = true;
    if (leg.mature === null) {
      if (active(leg.flash)) present.push({ legKey: leg.legKey, matureOutcomes: null });
      continue;
    }
    if (active(leg.mature)) present.push({ legKey: leg.legKey, matureOutcomes: leg.mature.outcomes });
  }
  if (present.length === 0) return flashActivity ? false : null;
  return scopeIsMature(present);
}

/** PURE. The scope's `maturity` block: its legs and its verdict. */
export function buildScopeMaturity(input: Parameters<typeof buildScopeLegs>[0]): ScopeMaturity {
  const legs = buildScopeLegs(input);
  return { isMature: scopeMaturityVerdict(legs), legs };
}

/** The block served when the scope's legs could not be read at all (campaign-service unreachable). */
export const UNKNOWN_SCOPE_MATURITY: ScopeMaturity = Object.freeze({ isMature: null, legs: [] }) as ScopeMaturity;

// ── THE BLOCK PAIRS: one block's own ratios, on both bases, beside the scope's verdict ─────────────

/**
 * The scope's spend and people on both bases — everything a block pair divides. `mature*` null ⟺ the
 * mature cut could not be made (legs unknown, or serve dates not stated), which nulls every mature half.
 */
export interface ScopeBases {
  flashSpendUsd: number;
  matureSpendUsd: number | null;
  /** The scope's persons (rows), and the mature cohort's (rows served before their leg's cutoff). */
  persons: readonly EnginePerson[];
  maturePersons: readonly EnginePerson[] | null;
  isMature: boolean | null;
}

/**
 * PURE. The cost-economics ratios on both bases. A mature cohort holding no spend (a young scope) has no
 * ratio to state — every mature ratio is null, never 0 and never the flash figure under the mature name.
 */
export function costRatiosPair(
  bases: Pick<ScopeBases, "flashSpendUsd" | "matureSpendUsd" | "isMature">,
  pipelines: { flash: number | null; mature: number | null },
  lifetimeRevenueUsd: number | null | undefined,
): MaturityPair<CostRatios> {
  const none: CostRatios = { roiMultiple: null, costOfAcquisitionPct: null, costPerAcquisitionUsd: null };
  const flash = bases.flashSpendUsd > 0 ? ratiosOf(bases.flashSpendUsd, pipelines.flash, lifetimeRevenueUsd) : none;
  const mature =
    bases.matureSpendUsd == null
      ? null
      : bases.matureSpendUsd > 0
        ? ratiosOf(bases.matureSpendUsd, pipelines.mature, lifetimeRevenueUsd)
        : none;
  return maturityPair(flash, mature, bases.isMature);
}

/** The two per-lead cost ratios `outcomes` states, in cents. */
export interface OutcomeRatios {
  cpcCents: number | null;
  cpprCents: number | null;
}

function outcomeRatios(spentUsd: number, rows: readonly EnginePerson[]): OutcomeRatios {
  let clicked = 0;
  let replied = 0;
  for (const person of dedupPersonsByLead([...rows])) {
    if (person.signals.clicked) clicked += 1;
    if (person.signals.positiveReply) replied += 1;
  }
  return {
    cpcCents: observedCostPerOutcome(spentUsd * 100, clicked),
    cpprCents: observedCostPerOutcome(spentUsd * 100, replied),
  };
}

/** PURE. The cost per visit and per positive reply on both bases — OBSERVED, never floored. */
export function outcomeRatiosPair(bases: ScopeBases): MaturityPair<OutcomeRatios> {
  const mature =
    bases.matureSpendUsd == null || bases.maturePersons == null
      ? null
      : outcomeRatios(bases.matureSpendUsd, bases.maturePersons);
  return maturityPair(outcomeRatios(bases.flashSpendUsd, bases.persons), mature, bases.isMature);
}

// ── ONE GROUP OF A SCOPE (an audience row, a workflow row): its maturity and the bases its pairs divide ──

/**
 * PURE. The rows of the mature cohort: each row served before ITS OWN campaign's leg cutoff (the run-start
 * clock, `servedInMatureCohort`). A row with no campaign, or of a campaign whose leg matures the day it is
 * bought, stays in — the same rule `matureCohortPersons` applies to a scope's delayed campaigns.
 */
export function matureRows(
  persons: readonly EnginePerson[],
  campaigns: readonly ScopeCampaign[],
  now: Date = new Date(),
): EnginePerson[] {
  const cutoffOf = new Map(campaigns.map((c) => [c.id, legCutoffIso(c.legKey, now)] as const));
  return persons.filter((p) => {
    const cutoff = p.campaignId ? (cutoffOf.get(p.campaignId) ?? null) : null;
    return servedInMatureCohort(p.servedAt, cutoff);
  });
}

/** A group's maturity and the bases every pair of that group divides. */
export interface GroupMaturity {
  maturity: ScopeMaturity;
  bases: ScopeBases;
}

/**
 * PURE. One group's maturity (its legs and verdict) and its bases — `persons` are the group's OWN rows,
 * `spend` its spend keyed by campaign. `serveDatesStated` false nulls every mature half.
 */
export function buildGroupMaturity(input: {
  campaigns: readonly ScopeCampaign[];
  persons: readonly EnginePerson[];
  spend: ReadonlyMap<string, SpendSplit>;
  serveDatesStated: boolean;
  now?: Date;
}): GroupMaturity {
  const maturity = buildScopeMaturity(input);
  const values = [...input.spend.values()];
  return {
    maturity,
    bases: {
      flashSpendUsd: centsTextToUsd(values.map((v) => v.flash)),
      matureSpendUsd: input.serveDatesStated ? centsTextToUsd(values.map((v) => v.mature)) : null,
      persons: input.persons,
      maturePersons: input.serveDatesStated ? matureRows(input.persons, input.campaigns, input.now) : null,
      isMature: maturity.isMature,
    },
  };
}

/** Distinct leads among `rows` whose (lowercased) email is in `emails`. */
function countByEmail(rows: readonly EnginePerson[], emails: ReadonlySet<string>): number {
  let n = 0;
  for (const person of dedupPersonsByLead([...rows])) {
    const email = person.email?.trim().toLowerCase();
    if (email && emails.has(email)) n += 1;
  }
  return n;
}

/** An audience row's five cost columns, in cents, as one figure `MaturityPair` carries. */
export interface AudienceMetricRatios {
  cpcCents: number | null;
  cpprCents: number | null;
  cpfsCents: number | null;
  cpsCents: number | null;
  cpsaleCents: number | null;
}

/**
 * PURE. An audience row's five cost columns on both bases — OBSERVED (spend over the row's own outcomes,
 * null at 0), never floored: where the legacy columns floor a 0-outcome audience against a benchmark, the
 * pair states what the audience itself measured. A conversion column exists only when its matched-lead
 * email set was read for this goal (null otherwise), exactly like the legacy column.
 */
export function audienceMetricPair(
  bases: ScopeBases,
  conversions: { formSubmission: ReadonlySet<string> | null; signup: ReadonlySet<string> | null; sale: ReadonlySet<string> | null },
): MaturityPair<AudienceMetricRatios> {
  const ratios = (spentUsd: number, rows: readonly EnginePerson[]): AudienceMetricRatios => {
    const cents = spentUsd * 100;
    const per = (set: ReadonlySet<string> | null) => (set ? observedCostPerOutcome(cents, countByEmail(rows, set)) : null);
    return {
      ...outcomeRatios(spentUsd, rows),
      cpfsCents: per(conversions.formSubmission),
      cpsCents: per(conversions.signup),
      cpsaleCents: per(conversions.sale),
    };
  };
  const mature =
    bases.matureSpendUsd == null || bases.maturePersons == null ? null : ratios(bases.matureSpendUsd, bases.maturePersons);
  return maturityPair(ratios(bases.flashSpendUsd, bases.persons), mature, bases.isMature);
}

/** A group's OBSERVED unit costs on one basis: spend over distinct visitors, over distinct positive repliers. */
export function observedUnitCosts(spentUsd: number, rows: readonly EnginePerson[]): { clickUsd: number | null; replyUsd: number | null } {
  const { cpcCents, cpprCents } = outcomeRatios(spentUsd, rows);
  return { clickUsd: cpcCents != null ? cpcCents / 100 : null, replyUsd: cpprCents != null ? cpprCents / 100 : null };
}

/**
 * A SCOPE'S MATURITY, read end to end — its campaigns (with their legs), its lead rows and its exact spend
 * split — for a surface that holds none of them already (/stats). The byte-same object `/revenue` serves
 * for the same scope. SOFT with a loud log: `null` is "we could not read this", never a verdict.
 */
export async function readScopeMaturitySoft(input: {
  brandId: string;
  featureScope: FeatureScope;
  /** The campaign ids the read is narrowed to (a campaign identity, an offer). `[]` = the channel set. */
  campaignIds: readonly string[];
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string };
  pricing: Pricing;
}): Promise<ScopeMaturity | null> {
  try {
    const narrowed = input.campaignIds.length === 0 ? undefined : input.campaignIds.length === 1 ? input.campaignIds[0] : [...input.campaignIds];
    const [rows, allPersons] = await Promise.all([
      fetchBrandCampaignRows(input.brandId, undefined, input.headers),
      fetchLeadsForRevenue(input.brandId, narrowed, input.headers),
    ]);
    const inScope = scopePredicate({ featureSlugs: featureSlugList(input.featureScope), campaignIds: [...input.campaignIds] });
    const campaigns = rows.filter(inScope).map((row): ScopeCampaign => ({ id: row.id, legKey: row.legKey ?? null }));
    const ids = new Set(campaigns.map((c) => c.id));
    const persons = allPersons.filter((p) => p.campaignId != null && ids.has(p.campaignId));
    const split = await fetchSpendSplit({
      brandId: input.brandId,
      featureScope: input.featureScope,
      campaignIds: input.campaignIds,
      campaigns,
      headers: input.headers,
      pricing: input.pricing,
    });
    return buildScopeMaturity({ campaigns, persons, spend: split, serveDatesStated: serveDatesStated(persons) });
  } catch (err) {
    console.error(`[features-service] scope maturity unavailable for brand ${input.brandId}: ${(err as Error).message}`);
    return null;
  }
}
