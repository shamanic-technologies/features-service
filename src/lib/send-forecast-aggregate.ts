/**
 * Series 3 aggregation for the global send-forecast — the fleet's NEW sequences per day driven by
 * ACTIVE brands' daily budgets.
 *
 * Per brand, new sequences/day `R_b = dailyBudget_b × (1 / outreachUsd)` where `outreachUsd` is the
 * best-signup workflow's cost-per-outreach — a CROSS-ORG per-FEATURE figure (see
 * `computeFeatureOutreachUsd`), NOT per-brand — so we compute it ONCE per cold-email feature and reuse
 * it across every active brand. A brand on multiple cold-email features takes the cheapest (highest
 * sequences-per-USD) → `max` over its features. The daily BUDGET is the only per-brand input.
 *
 * ACTIVE gate (shared with the `/internal/stats/accounts` audit — reuses `accountStatus`): a
 * (org, brand) account contributes ONLY when `accountStatus(...) === "active"` — its RUNNING daily
 * budget (the part of its configured ceilings standing behind an ongoing campaign, per campaign-service)
 * is > 0 AND (the org has auto-topup enabled OR its ACTUAL credit balance — credited − actualized usage,
 * NOT the provisioned-holds-subtracted spendable figure — EXCEEDS that budget). This is the fix for the
 * forecast over-count: without it, every brand that ever ran cold-email and still has a stale positive
 * budget was summed in — incl. brands whose campaigns are stopped and churned orgs with $0 credits —
 * inflating the projection several-fold above the observed send rate.
 *
 * The budget driving `R_b` is the RUNNING one for the same reason: a ceiling nobody is spending against
 * launches no sequences, so projecting from the configured figure forecasts sends that cannot happen.
 *
 * Today's cohort is scaled to the REMAINING budget (`todayNewOverride`): the day's budget is partly
 * spent already, so only the remainder launches new sequences today. Remaining = daily budget −
 * committed spend-so-far-today (runs `startedAfter` 00:00 UTC).
 *
 * All reads are ORG-LESS PLATFORM reads: cross-org, api-key + x-org-id ONLY (org balance keys org in
 * the path) — NO forwarded/faked user identity (see accounts-client). Fail loud on any read error.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchSpendBreakdown } from "./spend-client.js";
import {
  fetchOrgBalance,
  fetchSpendableBudgets,
  spendableKey,
  type OrgBalance,
  type BrandSpendableBudget,
} from "./accounts-client.js";
import { accountStatus } from "./accounts-compute.js";
import { computeFeatureOutreachUsd } from "../routes/pipeline-activity.js";

export interface FleetNewSequences {
  /** Σ over ACTIVE brands of R_b (new sequences/day at full budget). The steady future cohort size. */
  totalNewPerDay: number;
  /** Σ over ACTIVE brands of R_b × (remaining/budget) — today's cohort, scaled to remaining budget. */
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
  orgBalance: (orgId: string) => Promise<OrgBalance>;
  spendableBudgets: (
    pairs: Array<{ orgId: string; brandId: string }>,
  ) => Promise<Map<string, BrandSpendableBudget>>;
  brandSpentTodayUsd: (brandId: string, featureSlugsCsv: string, orgId: string, now: Date) => Promise<number>;
}

const REAL_DEPS: FleetDeps = {
  featureOutreachUsd: computeFeatureOutreachUsd,
  featureMemberships: async (slug) => (await fetchFeatureMemberships(slug)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  // Org-less platform reads: campaign spendable-budget takes its pairs in the body; billing balance and
  // runs cost authorize on x-org-id. No user/run identity is forwarded.
  orgBalance: fetchOrgBalance,
  spendableBudgets: fetchSpendableBudgets,
  brandSpentTodayUsd: async (brandId, featureSlugsCsv, orgId, now) => {
    const spend = await fetchSpendBreakdown(brandId, undefined, featureSlugsCsv, { orgId }, now);
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

  // 2. Enumerate (org, brand) pairs per cold-email feature; collect each brand's feature set.
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

  // 3. Org balance ONCE per org (shared across its brands) — the credit side of the active gate
  //    (actual balance + auto-topup, not the provisioned-holds-subtracted spendable figure).
  const orgIds = [...new Set([...brands.values()].map((b) => b.orgId))];
  const balanceByOrg = new Map<string, OrgBalance>();
  await Promise.all(orgIds.map(async (orgId) => balanceByOrg.set(orgId, await deps.orgBalance(orgId))));

  // 4. Per unique (org, brand): running budget + ACTIVE gate (running>0 && balance>running) +
  //    remaining-today. One batched call covers every pair's budgets.
  const budgets = await deps.spendableBudgets([...brands.values()].map((b) => ({ orgId: b.orgId, brandId: b.brandId })));
  const perBrand = await Promise.all(
    [...brands.values()].map(async (b) => {
      const featureList = [...b.features];
      const bestInvRate = featureList.reduce((max, f) => Math.max(max, invRateByFeature.get(f) ?? 0), 0);
      if (bestInvRate <= 0) return null; // no cold-email feature with usable cost → contributes nothing

      const spendable = budgets.get(spendableKey(b.orgId, b.brandId));
      // A pair the producer did not answer for is a read we did not get, never a zero.
      if (!spendable) {
        throw new Error(`[features-service] send-forecast: no spendable budget for ${b.orgId}/${b.brandId}`);
      }
      const balance = balanceByOrg.get(b.orgId) ?? { spendableUsd: 0, actualUsd: 0, autoTopupEnabled: false };
      // Same rule as /internal/stats/accounts: only "active" (running budget > 0, auto-topup OR actual
      // credits cover ≥1 day) contributes.
      if (
        accountStatus(spendable.configuredUsd, spendable.runningUsd, balance.actualUsd, balance.autoTopupEnabled) !==
        "active"
      ) {
        return null;
      }
      const budget = spendable.runningUsd; // "active" guarantees > 0

      const R = budget * bestInvRate;
      const spentTodayUsd = await deps.brandSpentTodayUsd(b.brandId, featureList.join(","), b.orgId, now);
      const remainingUsd = Math.max(0, budget - spentTodayUsd);
      const remainFactor = remainingUsd / budget;

      return { R, todayR: R * remainFactor, budgetUsd: budget, remainingUsd };
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
