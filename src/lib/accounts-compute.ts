/**
 * Assembly of the staff-gated `GET /internal/stats/accounts` audit — one row per cold-email customer
 * account (org × brand) with its daily budget, the org's spendable balance, and whether the account is
 * truly ACTIVE, plus fleet financial stats (total active daily budget → MRR → ARR).
 *
 * ACTIVE rule (exact): a row is "active" iff
 *     dailyBudgetUsd != null && dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd.
 * Otherwise "inactive" — covers $0/null/paused budget AND orgs whose spendable credit can't cover the
 * next day's budget. Inactive rows are LISTED (tagged inactive), never dropped. Stats sum ACTIVE rows.
 *
 * The account universe is the SAME source series-3 of the send-forecast uses: lead-service
 * feature-memberships over the cold-email feature slugs, deduped to distinct (org, brand) pairs. All
 * money + the active determination + MRR/ARR are computed HERE — the admin dashboard renders only.
 *
 * Org-level reads (balance, Clerk id, owner email) run ONCE per org; per-(org,brand) reads only the
 * daily budget; brand name/domain is one batched brand-service call. Fail loud on any read error.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchBrandDailyBudgetUsd } from "../routes/pipeline-activity.js";
import {
  fetchOrgBalanceUsd,
  fetchOrgIdentity,
  fetchBrandsBasic,
  type OrgIdentity,
  type BrandBasic,
} from "./accounts-client.js";

export type AccountStatus = "active" | "inactive";

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
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
}

const REAL_DEPS: AccountsDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgBalanceUsd: fetchOrgBalanceUsd,
  orgIdentity: fetchOrgIdentity,
  // Org-only read: billing daily-budget authorizes on x-org-id; user/run are omitted (no sentinel).
  brandDailyBudgetUsd: (brandId, orgId) => fetchBrandDailyBudgetUsd(brandId, "", { orgId }),
  brandsBasic: fetchBrandsBasic,
};

/** The exact active rule (single source, used by the row builder + asserted directly in tests). */
export function isActive(dailyBudgetUsd: number | null, orgBalanceUsd: number): boolean {
  return dailyBudgetUsd != null && dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd;
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
      const dailyBudgetUsd = await deps.brandDailyBudgetUsd(p.brandId, p.orgId);
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
        status: isActive(dailyBudgetUsd, orgBalanceUsd) ? "active" : "inactive",
      };
    }),
  );

  // Deterministic order: active first, then by daily budget desc (nulls last), tiebreak brandId.
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    const ab = a.dailyBudgetUsd ?? -1;
    const bb = b.dailyBudgetUsd ?? -1;
    if (ab !== bb) return bb - ab;
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats — sum daily budget over ACTIVE rows only; MRR = ×30, ARR = ×365.
  let totalDailyBudgetUsd = 0;
  let activeCount = 0;
  for (const row of rows) {
    if (row.status === "active") {
      totalDailyBudgetUsd += row.dailyBudgetUsd as number; // active ⇒ dailyBudgetUsd is a positive number
      activeCount += 1;
    }
  }
  const inactiveCount = rows.length - activeCount;

  return {
    rows,
    stats: {
      totalDailyBudgetUsd,
      mrrUsd: totalDailyBudgetUsd * 30,
      arrUsd: totalDailyBudgetUsd * 365,
      activeCount,
      inactiveCount,
      totalCount: rows.length,
    },
    asOf: now.toISOString(),
  };
}
