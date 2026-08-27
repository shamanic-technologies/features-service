/**
 * Assembly of the staff-gated `GET /internal/stats/accounts` audit — one row per cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account is
 * truly ACTIVE, plus fleet financial stats (total running daily budget → MRR → ARR).
 *
 * TWO BUDGETS, and they answer different questions. CONFIGURED is every ceiling the customer set in
 * billing. RUNNING is the part of it standing behind a campaign that is ongoing right now — the join of
 * campaign status to per-funnel ceiling, which only campaign-service can make. billing's brand total is
 * the configured one and is status-BLIND, so a brand running one campaign at $50 beside one stopped at
 * $10 answers $60; measured in production 2026-08-27, ~$25/day of a $138/day fleet sat on funnels whose
 * campaign was stopped or never created. Everything that claims to be money in play — the active
 * verdict, the fleet total, MRR, ARR — therefore reads RUNNING. CONFIGURED stays on the row because a
 * customer's own settings screen must still be able to state what they set.
 *
 * STATUS rule (exact, precedence order):
 *   1. runningDailyBudgetUsd > 0 && (autoTopupEnabled || actualBalanceUsd > runningDailyBudgetUsd) → "active"
 *   2. else configuredDailyBudgetUsd > 0                                                          → "paused"
 *   3. else                                                                                       → "inactive"
 * PAUSED means the customer has money posted and nothing running against it — they stopped their
 * campaigns, or campaign-service never gave them one. There is NO brand-level pause flag in this rule
 * any more: that control was removed from the product, the flag has not been written since early
 * August, and it lied in both directions — it marked one brand paused that spent $56 in the prior week
 * with an ongoing campaign, while brands with no campaign at all read active. The credit test uses the
 * ACTUAL balance (credited − actualized usage), NOT the spendable balance: a provisioned hold is
 * in-flight ACTIVE spend, so subtracting it would wrongly read the busiest accounts "inactive". An
 * auto-topup org never runs dry, so it is active regardless of the momentary balance. All rows are
 * LISTED (active + paused + inactive), never dropped. `stats.totalRunningDailyBudgetUsd`/MRR/ARR sum
 * ACTIVE rows ONLY (a paused brand is not spending).
 *
 * NEITHER BUDGET CARRIES THE PER-ORG USAGE DISCOUNT — the discount is a modifier on CHARGES only
 * (frozen gross+net per cost row in the runs/billing ledger); a daily budget is a configuration value,
 * not a charge, so it is the same number for every customer whether or not they have a discount. The
 * fleet total/MRR/ARR are pure budget projections (budget × 30 / × 365), so they are undiscounted too.
 * (Actual-charge / realized-revenue figures — e.g. the `/internal/stats/revenue` realized-spend buckets
 * — legitimately stay net; those are not computed here.)
 *
 * The account universe is the SAME source series-3 of the send-forecast uses: lead-service
 * feature-memberships over the cold-email feature slugs, deduped to distinct (org, brand) pairs. All
 * money + the status determination + MRR/ARR are computed HERE — the admin dashboard renders only.
 *
 * Org-level reads (balance, Clerk id, owner email) run ONCE per org; the spendable budgets come back for
 * every (org, brand) pair in ONE batched campaign-service call; brand name/domain is one batched
 * brand-service call. Fail loud.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import {
  fetchOrgBalance,
  fetchOrgIdentity,
  fetchBrandsBasic,
  fetchSpendableBudgets,
  spendableKey,
  type OrgBalance,
  type OrgIdentity,
  type BrandBasic,
  type BrandSpendableBudget,
} from "./accounts-client.js";

export type AccountStatus = "active" | "paused" | "inactive";

export interface AccountRow {
  orgId: string;
  orgExternalId: string | null;
  ownerEmail: string | null;
  brandId: string;
  brandName: string | null;
  brandDomain: string | null;
  /**
   * Every ceiling the customer configured for this brand, in USD (campaign-service's read of billing's
   * per-funnel rows). What they set — NOT what can be spent today. The per-org usage discount is a
   * modifier on CHARGES, not on a configuration ceiling, so it is NEVER applied here.
   */
  configuredDailyBudgetUsd: number;
  /**
   * The part of the configured ceiling standing behind a campaign that is ongoing right now, in USD.
   * This is the money in play, and the figure the ACTIVE verdict and every fleet total read.
   */
  runningDailyBudgetUsd: number;
  /** Org SPENDABLE balance in USD (billing balance_cents/100; committed usage incl. holds subtracted). Display. */
  orgBalanceUsd: number;
  /** Org ACTUAL balance in USD (billing actual_balance_cents/100; only actualized usage subtracted). The active-verdict figure. */
  orgActualBalanceUsd: number;
  /** Whether the org has auto-topup enabled (billing has_auto_topup; false when absent). */
  autoTopupEnabled: boolean;
  status: AccountStatus;
}

export interface AccountsStats {
  /** Σ RUNNING daily budget over ACTIVE rows only (USD; undiscounted — a budget is not a charge). The staff-page figure. */
  totalRunningDailyBudgetUsd: number;
  /** Σ CONFIGURED daily budget over ACTIVE rows only (USD). What those customers set, whatever is running. */
  totalConfiguredDailyBudgetUsd: number;
  /** MRR = totalRunningDailyBudgetUsd × 30 (a budget projection, undiscounted). */
  mrrUsd: number;
  /** ARR = totalRunningDailyBudgetUsd × 365 (a budget projection, undiscounted). */
  arrUsd: number;
  activeCount: number;
  pausedCount: number;
  inactiveCount: number;
  totalCount: number;
}

export interface AccountsAudit {
  rows: AccountRow[];
  stats: AccountsStats;
  asOf: string;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface AccountsDeps {
  featureMemberships: (featureSlugsCsv: string) => Promise<Array<{ orgId: string; brandId: string }>>;
  orgBalance: (orgId: string) => Promise<OrgBalance>;
  orgIdentity: (orgId: string) => Promise<OrgIdentity>;
  spendableBudgets: (
    pairs: Array<{ orgId: string; brandId: string }>,
  ) => Promise<Map<string, BrandSpendableBudget>>;
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
}

const REAL_DEPS: AccountsDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgBalance: fetchOrgBalance,
  orgIdentity: fetchOrgIdentity,
  spendableBudgets: fetchSpendableBudgets,
  brandsBasic: fetchBrandsBasic,
};

/**
 * The exact status rule (single source, used by the accounts row builder, the send-forecast active
 * gate, and asserted directly in tests). Precedence: active > paused > inactive.
 *
 * ACTIVE is decided on the RUNNING budget, never the configured one: money posted against a campaign
 * nobody is running cannot be spent, so counting it reads a dormant account as a paying one. PAUSED is
 * exactly that case — configured money, nothing running. The credit test uses the ACTUAL balance
 * (credited − actualized usage), not the spendable balance (which subtracts in-flight provisioned holds
 * and so wrongly reads busy accounts inactive), OR the org has auto-topup enabled (never runs dry →
 * active regardless of momentary balance).
 */
export function accountStatus(
  configuredDailyBudgetUsd: number,
  runningDailyBudgetUsd: number,
  actualBalanceUsd: number,
  autoTopupEnabled: boolean,
): AccountStatus {
  if (runningDailyBudgetUsd > 0 && (autoTopupEnabled || actualBalanceUsd > runningDailyBudgetUsd)) return "active";
  if (configuredDailyBudgetUsd > 0) return "paused";
  return "inactive";
}

export async function buildAccountsAudit(
  coldEmailSlugsCsv: string,
  now: Date = new Date(),
  deps: AccountsDeps = REAL_DEPS,
): Promise<AccountsAudit> {
  // 1. Enumerate distinct (org, brand) accounts across the cold-email feature set.
  const memberships = coldEmailSlugsCsv ? await deps.featureMemberships(coldEmailSlugsCsv) : [];
  const pairs = new Map<string, { orgId: string; brandId: string }>();
  for (const m of memberships) pairs.set(`${m.orgId}::${m.brandId}`, { orgId: m.orgId, brandId: m.brandId });

  const orgIds = [...new Set([...pairs.values()].map((p) => p.orgId))];
  const brandIds = [...new Set([...pairs.values()].map((p) => p.brandId))];
  // One batched call for every pair's configured + running budget — a fleet audit cannot afford a
  // request per brand, and both figures come from the same producer computation.
  const budgets = await deps.spendableBudgets([...pairs.values()]);

  // 2. Org-level reads once per org (balance + identity); brand name/domain in one batched call.
  const [orgInfoEntries, brandInfo] = await Promise.all([
    Promise.all(
      orgIds.map(async (orgId): Promise<[string, { balance: OrgBalance; identity: OrgIdentity }]> => {
        const [balance, identity] = await Promise.all([
          deps.orgBalance(orgId),
          deps.orgIdentity(orgId),
        ]);
        return [orgId, { balance, identity }];
      }),
    ),
    deps.brandsBasic(brandIds),
  ]);
  const orgInfo = new Map(orgInfoEntries);

  // 3. Build each row from the batched budgets + apply the active rule.
  const rows: AccountRow[] = [...pairs.values()].map((p): AccountRow => {
      const info = orgInfo.get(p.orgId);
      if (!info) throw new Error(`[features-service] accounts: missing org info for ${p.orgId}`);
      const budget = budgets.get(spendableKey(p.orgId, p.brandId));
      // A pair the producer did not answer for is a read we did not get, never a zero: a missing figure
      // that defaulted to 0 would drop the account out of the fleet total without anything reporting it.
      if (!budget) {
        throw new Error(`[features-service] accounts: no spendable budget for ${p.orgId}/${p.brandId}`);
      }
      const brand = brandInfo.get(p.brandId);
      const { balance } = info;
      // Neither budget carries the usage discount — a ceiling is a config value, not a charge. The
      // ACTIVE verdict gates on the RUNNING figure vs the actual balance.
      return {
        orgId: p.orgId,
        orgExternalId: info.identity.orgExternalId,
        ownerEmail: info.identity.ownerEmail,
        brandId: p.brandId,
        brandName: brand?.name ?? null,
        brandDomain: brand?.domain ?? null,
        configuredDailyBudgetUsd: budget.configuredUsd,
        runningDailyBudgetUsd: budget.runningUsd,
        orgBalanceUsd: balance.spendableUsd,
        orgActualBalanceUsd: balance.actualUsd,
        autoTopupEnabled: balance.autoTopupEnabled,
        status: accountStatus(
          budget.configuredUsd,
          budget.runningUsd,
          balance.actualUsd,
          balance.autoTopupEnabled,
        ),
      };
  });

  // Deterministic order: active → paused → inactive, then running budget desc, tiebreak on the
  // configured one (a paused row runs nothing, so its posted money is what ranks it), then brandId.
  const statusRank: Record<AccountStatus, number> = { active: 0, paused: 1, inactive: 2 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return statusRank[a.status] - statusRank[b.status];
    if (a.runningDailyBudgetUsd !== b.runningDailyBudgetUsd) {
      return b.runningDailyBudgetUsd - a.runningDailyBudgetUsd;
    }
    if (a.configuredDailyBudgetUsd !== b.configuredDailyBudgetUsd) {
      return b.configuredDailyBudgetUsd - a.configuredDailyBudgetUsd;
    }
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats — sum the RUNNING daily budget over ACTIVE rows only (paused/inactive don't spend);
  //    MRR ×30, ARR ×365. Undiscounted budget projection (a ceiling is config, not a charge). Active ⇒
  //    running > 0 by the verdict rule, so the sum is over positive numbers. The configured total rides
  //    alongside so a reader can see what those same customers posted, and can never be mistaken for it.
  let totalRunningDailyBudgetUsd = 0;
  let totalConfiguredDailyBudgetUsd = 0;
  let activeCount = 0;
  let pausedCount = 0;
  for (const row of rows) {
    if (row.status === "active") {
      totalRunningDailyBudgetUsd += row.runningDailyBudgetUsd;
      totalConfiguredDailyBudgetUsd += row.configuredDailyBudgetUsd;
      activeCount += 1;
    } else if (row.status === "paused") {
      pausedCount += 1;
    }
  }
  const inactiveCount = rows.length - activeCount - pausedCount;
  // Round the fleet totals to cents defensively (per-row budgets are already dollars-and-cents).
  totalRunningDailyBudgetUsd = Math.round(totalRunningDailyBudgetUsd * 100) / 100;
  totalConfiguredDailyBudgetUsd = Math.round(totalConfiguredDailyBudgetUsd * 100) / 100;

  return {
    rows,
    stats: {
      totalRunningDailyBudgetUsd,
      totalConfiguredDailyBudgetUsd,
      mrrUsd: totalRunningDailyBudgetUsd * 30,
      arrUsd: totalRunningDailyBudgetUsd * 365,
      activeCount,
      pausedCount,
      inactiveCount,
      totalCount: rows.length,
    },
    asOf: now.toISOString(),
  };
}
