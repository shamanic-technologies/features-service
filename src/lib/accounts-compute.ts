/**
 * Assembly of the staff-gated `GET /internal/stats/accounts` audit — one row per cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account is
 * truly ACTIVE, plus fleet financial stats (total active daily budget → MRR → ARR).
 *
 * STATUS rule (exact, precedence order):
 *   1. paused === true (campaign-service brand pause)                                  → "paused"
 *   2. else dailyBudgetUsd != null && dailyBudgetUsd > 0 && (autoTopupEnabled ||
 *          actualBalanceUsd > dailyBudgetUsd)                                          → "active"
 *   3. else                                                                            → "inactive"
 * PAUSED wins over everything — a paused brand keeps its budget but campaigns are HELD, so it is
 * neither active nor plain-inactive. The credit test uses the ACTUAL balance (credited − actualized
 * usage), NOT the spendable balance: a provisioned hold is in-flight ACTIVE spend, so subtracting it
 * would wrongly read the busiest accounts "inactive". An auto-topup org never runs dry, so it is active
 * regardless of the momentary balance. All rows are LISTED (active + paused + inactive), never dropped.
 * `stats.totalDailyBudgetUsd`/MRR/ARR sum ACTIVE rows ONLY (a paused brand is not spending).
 *
 * MONEY IS NET (post per-org usage discount). Each org has a platform-usage discount % (owned by
 * billing-service); the row `dailyBudgetUsd` + fleet `totalDailyBudgetUsd`/MRR/ARR are the NET figure
 * (gross × (1 − discount)) — what the org actually pays — so the staff metrics page renders net. The
 * GROSS (list-price) figures are exposed additively (`grossDailyBudgetUsd`, `stats.gross*`) and are the
 * basis the ACTIVE verdict + row sort compute on, so the discount NEVER changes who is active. For an
 * org with no discount, NET == GROSS.
 *
 * The account universe is the SAME source series-3 of the send-forecast uses: lead-service
 * feature-memberships over the cold-email feature slugs, deduped to distinct (org, brand) pairs. All
 * money + the status determination + MRR/ARR are computed HERE — the admin dashboard renders only.
 *
 * Org-level reads (balance, Clerk id, owner email) run ONCE per org; per-(org,brand) reads the daily
 * budget + the brand pause state; brand name/domain is one batched brand-service call. Fail loud.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchBrandDailyBudgetUsd } from "../routes/pipeline-activity.js";
import {
  fetchOrgBalance,
  fetchOrgIdentity,
  fetchBrandsBasic,
  fetchBrandPaused,
  fetchOrgUsageDiscountPct,
  type OrgBalance,
  type OrgIdentity,
  type BrandBasic,
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
   * NET brand daily budget in USD = gross budget × (1 − org usage-discount/100). This is what the org
   * actually pays for a full-budget day, so it is the figure the staff metrics page renders. For an org
   * with no discount, NET == GROSS. Null when the budget is unset/paused.
   */
  dailyBudgetUsd: number | null;
  /**
   * GROSS (list-price) brand daily budget in USD, before the org usage discount — the raw billing
   * daily-budget. Additive: exposed for any consumer that needs the undiscounted figure (and the basis
   * the ACTIVE verdict + row sort are computed on, so the discount never shifts the verdict). Null when unset/paused.
   */
  grossDailyBudgetUsd: number | null;
  /** Org SPENDABLE balance in USD (billing balance_cents/100; committed usage incl. holds subtracted). Display. */
  orgBalanceUsd: number;
  /** Org ACTUAL balance in USD (billing actual_balance_cents/100; only actualized usage subtracted). The active-verdict figure. */
  orgActualBalanceUsd: number;
  /** Whether the org has auto-topup enabled (billing has_auto_topup; false when absent). */
  autoTopupEnabled: boolean;
  status: AccountStatus;
}

export interface AccountsStats {
  /** Σ NET daily budget over ACTIVE rows only (USD; each row net = gross × (1 − org discount)). The staff-page figure. */
  totalDailyBudgetUsd: number;
  /** NET MRR = totalDailyBudgetUsd × 30. */
  mrrUsd: number;
  /** NET ARR = totalDailyBudgetUsd × 365. */
  arrUsd: number;
  /** Σ GROSS (list-price) daily budget over ACTIVE rows only (USD). Additive — the undiscounted figure. */
  grossTotalDailyBudgetUsd: number;
  /** GROSS MRR = grossTotalDailyBudgetUsd × 30. */
  grossMrrUsd: number;
  /** GROSS ARR = grossTotalDailyBudgetUsd × 365. */
  grossArrUsd: number;
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
  /** Org platform-usage discount percent (0..100), owned by billing-service. Applied to the gross budget for NET. */
  orgDiscountPct: (orgId: string) => Promise<number>;
  brandDailyBudgetUsd: (brandId: string, orgId: string) => Promise<number | null>;
  brandPaused: (brandId: string, orgId: string) => Promise<boolean>;
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
}

const REAL_DEPS: AccountsDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgBalance: fetchOrgBalance,
  orgIdentity: fetchOrgIdentity,
  orgDiscountPct: fetchOrgUsageDiscountPct,
  // Org-only reads: billing daily-budget + campaign pause authorize on x-org-id; user/run omitted (no sentinel).
  brandDailyBudgetUsd: (brandId, orgId) => fetchBrandDailyBudgetUsd(brandId, "", { orgId }),
  brandPaused: fetchBrandPaused,
  brandsBasic: fetchBrandsBasic,
};

/** Apply an org usage-discount percentage to a gross USD budget → NET USD (2-decimal, FP-safe). null stays null. */
function applyDiscount(grossUsd: number | null, discountPct: number): number | null {
  if (grossUsd === null) return null;
  return Math.round(grossUsd * (1 - discountPct / 100) * 100) / 100;
}

/**
 * The exact status rule (single source, used by the accounts row builder, the send-forecast active
 * gate, and asserted directly in tests). Precedence: PAUSED > active > inactive.
 *
 * The credit test uses the ACTUAL balance (credited − actualized usage), not the spendable balance
 * (which subtracts in-flight provisioned holds and so wrongly reads busy accounts inactive), OR the
 * org has auto-topup enabled (never runs dry → active regardless of momentary balance).
 */
export function accountStatus(
  dailyBudgetUsd: number | null,
  actualBalanceUsd: number,
  autoTopupEnabled: boolean,
  paused: boolean,
): AccountStatus {
  if (paused) return "paused";
  if (dailyBudgetUsd != null && dailyBudgetUsd > 0 && (autoTopupEnabled || actualBalanceUsd > dailyBudgetUsd)) return "active";
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

  // 2. Org-level reads once per org (balance + identity + usage discount); brand name/domain in one batched call.
  const [orgInfoEntries, brandInfo] = await Promise.all([
    Promise.all(
      orgIds.map(async (orgId): Promise<[string, { balance: OrgBalance; identity: OrgIdentity; discountPct: number }]> => {
        const [balance, identity, discountPct] = await Promise.all([
          deps.orgBalance(orgId),
          deps.orgIdentity(orgId),
          deps.orgDiscountPct(orgId),
        ]);
        return [orgId, { balance, identity, discountPct }];
      }),
    ),
    deps.brandsBasic(brandIds),
  ]);
  const orgInfo = new Map(orgInfoEntries);

  // 3. Per-(org,brand) daily budget, then build each row + apply the active rule.
  const rows: AccountRow[] = await Promise.all(
    [...pairs.values()].map(async (p): Promise<AccountRow> => {
      const info = orgInfo.get(p.orgId);
      if (!info) throw new Error(`[features-service] accounts: missing org info for ${p.orgId}`);
      const [grossDailyBudgetUsd, paused] = await Promise.all([
        deps.brandDailyBudgetUsd(p.brandId, p.orgId),
        deps.brandPaused(p.brandId, p.orgId),
      ]);
      const brand = brandInfo.get(p.brandId);
      const { balance } = info;
      // NET = gross × (1 − org usage discount). The ACTIVE verdict is computed on the GROSS budget so the
      // discount NEVER changes active/inactive (no-go); only the displayed money is net.
      const netDailyBudgetUsd = applyDiscount(grossDailyBudgetUsd, info.discountPct);
      return {
        orgId: p.orgId,
        orgExternalId: info.identity.orgExternalId,
        ownerEmail: info.identity.ownerEmail,
        brandId: p.brandId,
        brandName: brand?.name ?? null,
        brandDomain: brand?.domain ?? null,
        dailyBudgetUsd: netDailyBudgetUsd,
        grossDailyBudgetUsd,
        orgBalanceUsd: balance.spendableUsd,
        orgActualBalanceUsd: balance.actualUsd,
        autoTopupEnabled: balance.autoTopupEnabled,
        status: accountStatus(grossDailyBudgetUsd, balance.actualUsd, balance.autoTopupEnabled, paused),
      };
    }),
  );

  // Deterministic order: active → paused → inactive, then daily budget desc (nulls last), tiebreak brandId.
  // Sort on the GROSS budget so the discount never reshuffles rows (only the displayed number changes).
  const statusRank: Record<AccountStatus, number> = { active: 0, paused: 1, inactive: 2 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return statusRank[a.status] - statusRank[b.status];
    const ab = a.grossDailyBudgetUsd ?? -1;
    const bb = b.grossDailyBudgetUsd ?? -1;
    if (ab !== bb) return bb - ab;
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats — sum daily budget over ACTIVE rows only (paused/inactive don't spend); MRR ×30, ARR ×365.
  //    NET (post-discount) is the staff-page primary; GROSS twins are additive. Active ⇒ gross budget > 0
  //    (verdict on gross); a 100%-discount active row contributes 0 to the net totals (we bill nothing).
  let totalDailyBudgetUsd = 0;
  let grossTotalDailyBudgetUsd = 0;
  let activeCount = 0;
  let pausedCount = 0;
  for (const row of rows) {
    if (row.status === "active") {
      totalDailyBudgetUsd += row.dailyBudgetUsd as number; // active ⇒ net budget is a number (0 only at 100% discount)
      grossTotalDailyBudgetUsd += row.grossDailyBudgetUsd as number; // active ⇒ gross budget is a positive number
      activeCount += 1;
    } else if (row.status === "paused") {
      pausedCount += 1;
    }
  }
  const inactiveCount = rows.length - activeCount - pausedCount;
  // Round the fleet net total to cents (per-row nets are already 2-dp; sum stays FP-clean but round defensively).
  totalDailyBudgetUsd = Math.round(totalDailyBudgetUsd * 100) / 100;

  return {
    rows,
    stats: {
      totalDailyBudgetUsd,
      mrrUsd: totalDailyBudgetUsd * 30,
      arrUsd: totalDailyBudgetUsd * 365,
      grossTotalDailyBudgetUsd,
      grossMrrUsd: grossTotalDailyBudgetUsd * 30,
      grossArrUsd: grossTotalDailyBudgetUsd * 365,
      activeCount,
      pausedCount,
      inactiveCount,
      totalCount: rows.length,
    },
    asOf: now.toISOString(),
  };
}
