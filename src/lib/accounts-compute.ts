/**
 * Assembly of the staff-gated `GET /internal/stats/accounts` audit — one row per cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account is
 * truly ACTIVE, plus fleet financial stats (total active daily budget → MRR → ARR).
 *
 * STATUS rule (exact, precedence order):
 *   1. paused === true (campaign-service brand pause)                                  → "paused"
 *   2. else dailyBudgetUsd != null && dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd → "active"
 *   3. else                                                                            → "inactive"
 * PAUSED wins over everything — a paused brand keeps its budget but campaigns are HELD, so it is
 * neither active nor plain-inactive. All rows are LISTED (active + paused + inactive), never dropped.
 * `stats.totalDailyBudgetUsd`/MRR/ARR sum ACTIVE rows ONLY (a paused brand is not spending).
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
  fetchOrgBalanceUsd,
  fetchOrgIdentity,
  fetchBrandsBasic,
  fetchBrandPaused,
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
  dailyBudgetUsd: number | null;
  orgBalanceUsd: number;
  status: AccountStatus;
}

export interface AccountsStats {
  totalDailyBudgetUsd: number;
  mrrUsd: number;
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
  orgBalanceUsd: (orgId: string) => Promise<number>;
  orgIdentity: (orgId: string) => Promise<OrgIdentity>;
  brandDailyBudgetUsd: (brandId: string, orgId: string) => Promise<number | null>;
  brandPaused: (brandId: string, orgId: string) => Promise<boolean>;
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
}

const REAL_DEPS: AccountsDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgBalanceUsd: fetchOrgBalanceUsd,
  orgIdentity: fetchOrgIdentity,
  // Org-only reads: billing daily-budget + campaign pause authorize on x-org-id; user/run omitted (no sentinel).
  brandDailyBudgetUsd: (brandId, orgId) => fetchBrandDailyBudgetUsd(brandId, "", { orgId }),
  brandPaused: fetchBrandPaused,
  brandsBasic: fetchBrandsBasic,
};

/**
 * The exact status rule (single source, used by the accounts row builder, the send-forecast active
 * gate, and asserted directly in tests). Precedence: PAUSED > active > inactive.
 */
export function accountStatus(dailyBudgetUsd: number | null, orgBalanceUsd: number, paused: boolean): AccountStatus {
  if (paused) return "paused";
  if (dailyBudgetUsd != null && dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd) return "active";
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

  // 2. Org-level reads once per org (balance + identity); brand name/domain in one batched call.
  const [orgInfoEntries, brandInfo] = await Promise.all([
    Promise.all(
      orgIds.map(async (orgId): Promise<[string, { balanceUsd: number; identity: OrgIdentity }]> => {
        const [balanceUsd, identity] = await Promise.all([deps.orgBalanceUsd(orgId), deps.orgIdentity(orgId)]);
        return [orgId, { balanceUsd, identity }];
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
      const [dailyBudgetUsd, paused] = await Promise.all([
        deps.brandDailyBudgetUsd(p.brandId, p.orgId),
        deps.brandPaused(p.brandId, p.orgId),
      ]);
      const brand = brandInfo.get(p.brandId);
      const orgBalanceUsd = info.balanceUsd;
      return {
        orgId: p.orgId,
        orgExternalId: info.identity.orgExternalId,
        ownerEmail: info.identity.ownerEmail,
        brandId: p.brandId,
        brandName: brand?.name ?? null,
        brandDomain: brand?.domain ?? null,
        dailyBudgetUsd,
        orgBalanceUsd,
        status: accountStatus(dailyBudgetUsd, orgBalanceUsd, paused),
      };
    }),
  );

  // Deterministic order: active → paused → inactive, then daily budget desc (nulls last), tiebreak brandId.
  const statusRank: Record<AccountStatus, number> = { active: 0, paused: 1, inactive: 2 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return statusRank[a.status] - statusRank[b.status];
    const ab = a.dailyBudgetUsd ?? -1;
    const bb = b.dailyBudgetUsd ?? -1;
    if (ab !== bb) return bb - ab;
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats — sum daily budget over ACTIVE rows only (paused/inactive don't spend); MRR ×30, ARR ×365.
  let totalDailyBudgetUsd = 0;
  let activeCount = 0;
  let pausedCount = 0;
  for (const row of rows) {
    if (row.status === "active") {
      totalDailyBudgetUsd += row.dailyBudgetUsd as number; // active ⇒ dailyBudgetUsd is a positive number
      activeCount += 1;
    } else if (row.status === "paused") {
      pausedCount += 1;
    }
  }
  const inactiveCount = rows.length - activeCount - pausedCount;

  return {
    rows,
    stats: {
      totalDailyBudgetUsd,
      mrrUsd: totalDailyBudgetUsd * 30,
      arrUsd: totalDailyBudgetUsd * 365,
      activeCount,
      pausedCount,
      inactiveCount,
      totalCount: rows.length,
    },
    asOf: now.toISOString(),
  };
}
