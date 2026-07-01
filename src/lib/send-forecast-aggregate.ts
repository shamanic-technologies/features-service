/**
 * Series 3 aggregation for the global send-forecast — the fleet's NEW sequences per day driven by
 * active brands' daily budgets.
 *
 * Per brand, new sequences/day `R_b = dailyBudget_b × (1 / outreachUsd)` where `outreachUsd` is the
 * best-signup workflow's cost-per-outreach — a CROSS-ORG per-FEATURE figure (see
 * `computeFeatureOutreachUsd`), NOT per-brand — so we compute it ONCE per cold-email feature and reuse
 * it across every active brand. A brand on multiple cold-email features takes the cheapest (highest
 * sequences-per-USD) → `max` over its features. The daily BUDGET is the only per-brand input.
 *
 * Today's cohort is scaled to the REMAINING budget (`todayNewOverride`): the day's budget is partly
 * spent already, so only the remainder launches new sequences today. Remaining = daily budget −
 * committed spend-so-far-today (runs `startedAfter` 00:00 UTC), matching the campaign-service budget
 * gate's committed-spend semantics.
 *
 * All reads are cross-org (fleet-wide): feature-memberships enumerate active (org, brand) pairs;
 * per-brand billing + runs reads forward the owning org's identity (service stub user/run), same
 * pattern as the public cross-org revenue endpoint. Fail loud on any read error.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchSpendBreakdown } from "./spend-client.js";
import { computeFeatureOutreachUsd, fetchBrandDailyBudgetUsd } from "../routes/pipeline-activity.js";

// Service-stub identity for the cross-org fleet reads. This is a platform-level (no real per-caller
// user/run) forecast, but runs-service `/v1/stats/costs` VALIDATES `x-user-id` / `x-run-id` as a
// well-formed UUID (400 "x-user-id header must be a valid UUID" otherwise), and the shared
// pipeline-activity/billing header builders always send both. So the stub MUST be a valid UUID — a
// plain marker string ("public-send-forecast") 400s the essential runs read and 500s the endpoint.
// A fixed valid-v4-format UUID (version nibble 4, variant nibble 8) satisfies both generic and
// v4-specific validators while staying an obvious synthetic stub in downstream logs. The real
// attribution is the per-(org,brand) `x-org-id`; user/run are unvalidated context beyond format.
const STUB_IDENTITY_UUID = "00000000-0000-4000-8000-000000000000";
const STUB_USER = STUB_IDENTITY_UUID;
const STUB_RUN = STUB_IDENTITY_UUID;

export interface FleetNewSequences {
  /** Σ over active brands of R_b (new sequences/day at full budget). The steady future cohort size. */
  totalNewPerDay: number;
  /** Σ over active brands of R_b × (remaining/budget) — today's cohort, scaled to remaining budget. */
  todayNewOverride: number;
  totalDailyBudgetUsd: number;
  remainingTodayUsd: number;
  activeBrandCount: number;
}

interface BrandEntry {
  orgId: string;
  brandId: string;
  features: Set<string>;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface FleetDeps {
  featureOutreachUsd: (slug: string) => Promise<number | null>;
  featureMemberships: (slug: string) => Promise<Array<{ orgId: string; brandId: string }>>;
  brandDailyBudgetUsd: (brandId: string, featureSlug: string, headers: { orgId: string; userId: string; runId: string }) => Promise<number | null>;
  brandSpentTodayUsd: (brandId: string, featureSlugsCsv: string, headers: { orgId: string; userId: string; runId: string }, now: Date) => Promise<number>;
}

const REAL_DEPS: FleetDeps = {
  featureOutreachUsd: computeFeatureOutreachUsd,
  featureMemberships: async (slug) => (await fetchFeatureMemberships(slug)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  brandDailyBudgetUsd: fetchBrandDailyBudgetUsd,
  brandSpentTodayUsd: async (brandId, featureSlugsCsv, headers, now) => {
    const spend = await fetchSpendBreakdown(brandId, undefined, featureSlugsCsv, headers, now);
    return spend.totalSpentTodayCents / 100;
  },
};

export async function aggregateFleetNewSequences(
  coldEmailSlugs: string[],
  now: Date = new Date(),
  deps: FleetDeps = REAL_DEPS,
): Promise<FleetNewSequences> {
  // 1. Per-feature cross-org outreachUsd → sequences-per-USD (invRate). Skip features with no usable cost.
  const invRateByFeature = new Map<string, number>();
  await Promise.all(
    coldEmailSlugs.map(async (slug) => {
      const outreachUsd = await deps.featureOutreachUsd(slug);
      if (outreachUsd !== null && outreachUsd > 0) invRateByFeature.set(slug, 1 / outreachUsd);
    }),
  );

  // 2. Enumerate active (org, brand) pairs per cold-email feature; collect each brand's feature set.
  const brands = new Map<string, BrandEntry>();
  await Promise.all(
    coldEmailSlugs.map(async (slug) => {
      const memberships = await deps.featureMemberships(slug);
      for (const m of memberships) {
        const key = `${m.orgId}::${m.brandId}`;
        let entry = brands.get(key);
        if (!entry) {
          entry = { orgId: m.orgId, brandId: m.brandId, features: new Set() };
          brands.set(key, entry);
        }
        entry.features.add(slug);
      }
    }),
  );

  // 3. Per unique (org, brand): daily budget + best sequences-per-USD + remaining-today scaling.
  const perBrand = await Promise.all(
    [...brands.values()].map(async (b) => {
      const featureList = [...b.features];
      const bestInvRate = featureList.reduce((max, f) => Math.max(max, invRateByFeature.get(f) ?? 0), 0);
      if (bestInvRate <= 0) return null; // no cold-email feature with usable cost → contributes nothing

      const headers = { orgId: b.orgId, userId: STUB_USER, runId: STUB_RUN };
      const budgetUsd = await deps.brandDailyBudgetUsd(b.brandId, featureList[0], headers);
      if (budgetUsd === null || budgetUsd <= 0) return null; // unbudgeted brand launches no new sequences

      const R = budgetUsd * bestInvRate;
      const spentTodayUsd = await deps.brandSpentTodayUsd(b.brandId, featureList.join(","), headers, now);
      const remainingUsd = Math.max(0, budgetUsd - spentTodayUsd);
      const remainFactor = budgetUsd > 0 ? remainingUsd / budgetUsd : 0;

      return { R, todayR: R * remainFactor, budgetUsd, remainingUsd };
    }),
  );

  let totalNewPerDay = 0;
  let todayNewOverride = 0;
  let totalDailyBudgetUsd = 0;
  let remainingTodayUsd = 0;
  let activeBrandCount = 0;
  for (const row of perBrand) {
    if (!row) continue;
    totalNewPerDay += row.R;
    todayNewOverride += row.todayR;
    totalDailyBudgetUsd += row.budgetUsd;
    remainingTodayUsd += row.remainingUsd;
    activeBrandCount += 1;
  }

  return { totalNewPerDay, todayNewOverride, totalDailyBudgetUsd, remainingTodayUsd, activeBrandCount };
}
