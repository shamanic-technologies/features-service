/**
 * Assembly of the staff-gated `GET /internal/stats/active-users-by-user` breakdown — the PER-USER analog
 * of the aggregate `GET /internal/stats/active-users` history. One row per USER (a distinct org that has
 * an active, funded, non-paused cold-email brand), carrying that user's ACTIVE HISTORY since inception:
 * which months / weeks / days it was active, plus a pre-derived summary (first/last active month, first/
 * last active week, retention-window-in-weeks) and the current-week / current-month "active at least once"
 * flags the admin uses for tab counts.
 *
 * SAME universe + SAME "active" notion as the aggregate series. An "active user" is a distinct org with
 * ≥1 active cold-email brand; the faithful HISTORICAL signal features-service owns is per-day ACTUALIZED
 * cold-email spend (runs-service): a day of real billed cold-email spend implies the brand was NOT paused
 * (paused → held → no spend), HAD a budget (spend needs budget authorization) and was FUNDED (spend needs
 * affordability). So a day D on which the org billed cold-email spend is the accounts active-verdict for D,
 * observed after the fact — the exact same realized-activity signal `bucketizeSeries` unions in the
 * aggregate history, just kept PER ORG here instead of counted as a distinct-org total.
 *
 * PER-ORG rows are allowed because this is a STAFF-ONLY admin surface (staff-gated at api-service, like the
 * accounts audit + the aggregate active-users history) — NOT the public aggregate. Each row carries enough
 * identity for the admin to label it (Clerk org id → name, owner email, brand name/domain) exactly as the
 * Accounts audit does.
 *
 * INCEPTION. "Since inception" = the org's earliest billed cold-email day. We read each org's active days
 * from a fixed generous lower bound (`INCEPTION_ISO`) that predates all cold-email history, so every org's
 * true first active day is captured. An org in the cold-email membership universe with ZERO active days is
 * OMITTED (it was never active — "list every user that was ever active").
 *
 * The account universe is the SAME source the accounts audit + aggregate history use: lead-service
 * feature-memberships over the cold-email feature slugs, deduped to distinct orgs (brands grouped per org
 * for identity). Per-org dated spend + identity are one bounded, capped fan-out each. Fail loud.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchOrgActiveDays } from "./active-users-client.js";
import { fetchOrgIdentity, fetchBrandsBasic, type OrgIdentity, type BrandBasic } from "./accounts-client.js";
import { mapWithConcurrency } from "./concurrency.js";
import { bucketOf, weekStart } from "./active-users-compute.js";

/** Cap the per-org fan-out so a cold-Neon sibling is not hit with N sockets at once. */
const ORG_FANOUT_CONCURRENCY = 6;

/**
 * Fixed lower bound for the per-org active-day read — predates all cold-email spend, so every org's true
 * FIRST active day is captured ("since inception"). A generous constant (not a trailing window) because
 * the admin drill-down goes back to each user's own first active day, not a rolling N-day tail.
 */
export const INCEPTION_ISO = "2024-01-01T00:00:00.000Z";

const MS_PER_WEEK = 7 * 86_400_000;

/** Cold-email brand of the org, for labelling / fallback (Clerk name → owner email → brand domain). */
export interface UserBrand {
  brandId: string;
  brandName: string | null;
  brandDomain: string | null;
}

export interface ActiveUserRow {
  orgId: string;
  /** Clerk org id (org_...); lets the admin resolve the org display name. null if unset. */
  orgExternalId: string | null;
  /** The org owner's email (earliest-created user). null if the org has no users. Label fallback. */
  ownerEmail: string | null;
  /** Every cold-email brand of the org (id + name + domain). Label fallback (brand domain). */
  brands: UserBrand[];
  /** Earliest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. Non-null: a row exists only if ≥1 active day. */
  firstActiveDay: string;
  /** Latest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. */
  lastActiveDay: string;
  /** ISO-week label (`YYYY-Www`) of the first active day. */
  firstActiveWeek: string;
  /** ISO-week label (`YYYY-Www`) of the last active day. */
  lastActiveWeek: string;
  /** Calendar-month label (`YYYY-MM`) of the first active day. */
  firstActiveMonth: string;
  /** Calendar-month label (`YYYY-MM`) of the last active day. */
  lastActiveMonth: string;
  /**
   * Retention window in ISO weeks = INCLUSIVE span between the first and last active week
   * ((lastWeekMonday − firstWeekMonday) / 7 + 1). A user active in exactly one week → 1 (not 0).
   */
  retentionWeeks: number;
  /** Whether the org was active at least once in the CURRENT ISO week (tab count / filter). */
  activeThisWeek: boolean;
  /** Whether the org was active at least once in the CURRENT calendar month (tab count / filter). */
  activeThisMonth: boolean;
  /** Distinct active UTC days (`YYYY-MM-DD`), ascending — the day-by-day drill-down. */
  activeDays: string[];
  /** Distinct active ISO weeks (`YYYY-Www`), ascending — the week-by-week drill-down. */
  activeWeeks: string[];
  /** Distinct active calendar months (`YYYY-MM`), ascending — the month-by-month drill-down. */
  activeMonths: string[];
}

export interface ActiveUsersByUser {
  /** One row per user (org) that was EVER active (≥1 billed cold-email day), sorted most-recently-active first. */
  users: ActiveUserRow[];
  stats: {
    /** Number of users ever active (= users.length). */
    totalUsers: number;
    /** Users active at least once in the current ISO week. */
    activeThisWeekCount: number;
    /** Users active at least once in the current calendar month. */
    activeThisMonthCount: number;
  };
  /** Current ISO-week label (`YYYY-Www`), the boundary the `activeThisWeek` flag / tab count uses. */
  currentWeek: string;
  /** Current calendar-month label (`YYYY-MM`), the boundary the `activeThisMonth` flag / tab count uses. */
  currentMonth: string;
  asOf: string;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface ActiveUsersByUserDeps {
  featureMemberships: (featureSlugsCsv: string) => Promise<Array<{ orgId: string; brandId: string }>>;
  orgActiveDays: (orgId: string, coldEmailSlugsCsv: string, startedAfterIso: string) => Promise<Set<string>>;
  orgIdentity: (orgId: string) => Promise<OrgIdentity>;
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
}

const REAL_DEPS: ActiveUsersByUserDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgActiveDays: fetchOrgActiveDays,
  orgIdentity: fetchOrgIdentity,
  brandsBasic: fetchBrandsBasic,
};

/**
 * Derive one user row from an org's active-day set. Pure — no I/O. Buckets the days into distinct
 * months/weeks, picks the first/last of each, computes the inclusive retention-week span, and flags
 * current-week / current-month membership. `days` MUST be non-empty (callers omit never-active orgs).
 */
export function summarizeUser(
  orgId: string,
  days: Set<string>,
  brands: UserBrand[],
  identity: OrgIdentity,
  currentWeek: string,
  currentMonth: string,
): ActiveUserRow {
  const activeDays = [...days].sort(); // ISO YYYY-MM-DD sorts chronologically
  const firstActiveDay = activeDays[0];
  const lastActiveDay = activeDays[activeDays.length - 1];

  const weekSet = new Set<string>();
  const monthSet = new Set<string>();
  for (const d of activeDays) {
    weekSet.add(bucketOf(d, "week").period); // YYYY-Www (isoWeek-year padded → lexical sort = chronological)
    monthSet.add(bucketOf(d, "month").period); // YYYY-MM
  }
  const activeWeeks = [...weekSet].sort();
  const activeMonths = [...monthSet].sort();

  // Retention window = inclusive count of ISO weeks between the first and last active week.
  const firstWeekMonday = weekStart(firstActiveDay);
  const lastWeekMonday = weekStart(lastActiveDay);
  const retentionWeeks = Math.round((Date.parse(lastWeekMonday) - Date.parse(firstWeekMonday)) / MS_PER_WEEK) + 1;

  return {
    orgId,
    orgExternalId: identity.orgExternalId,
    ownerEmail: identity.ownerEmail,
    brands,
    firstActiveDay,
    lastActiveDay,
    firstActiveWeek: activeWeeks[0],
    lastActiveWeek: activeWeeks[activeWeeks.length - 1],
    firstActiveMonth: activeMonths[0],
    lastActiveMonth: activeMonths[activeMonths.length - 1],
    retentionWeeks,
    activeThisWeek: weekSet.has(currentWeek),
    activeThisMonth: monthSet.has(currentMonth),
    activeDays,
    activeWeeks,
    activeMonths,
  };
}

/**
 * Build the full per-user active-history payload. Enumerates the cold-email org universe (brands grouped
 * per org for identity), fans out one dated-spend read + one identity read per org (capped), batches brand
 * name/domain, then derives one row per EVER-active org + the current-week / current-month tab counts.
 */
export async function buildActiveUsersByUser(
  coldEmailSlugsCsv: string,
  now: Date,
  deps: ActiveUsersByUserDeps = REAL_DEPS,
): Promise<ActiveUsersByUser> {
  const todayIso = now.toISOString().slice(0, 10);
  const currentWeek = bucketOf(todayIso, "week").period;
  const currentMonth = bucketOf(todayIso, "month").period;

  // 1. Enumerate the distinct cold-email org universe; group brand ids per org for identity/labelling.
  const memberships = coldEmailSlugsCsv ? await deps.featureMemberships(coldEmailSlugsCsv) : [];
  const orgBrandIds = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!orgBrandIds.has(m.orgId)) orgBrandIds.set(m.orgId, new Set());
    orgBrandIds.get(m.orgId)!.add(m.brandId);
  }
  const orgIds = [...orgBrandIds.keys()];
  const allBrandIds = [...new Set(memberships.map((m) => m.brandId))];

  // 2. Per-org active-day set + identity (both capped fan-outs), brand name/domain in one batched call.
  const [dayEntries, identityEntries, brandInfo] = await Promise.all([
    mapWithConcurrency(orgIds, ORG_FANOUT_CONCURRENCY, async (orgId): Promise<[string, Set<string>]> => {
      return [orgId, await deps.orgActiveDays(orgId, coldEmailSlugsCsv, INCEPTION_ISO)];
    }),
    mapWithConcurrency(orgIds, ORG_FANOUT_CONCURRENCY, async (orgId): Promise<[string, OrgIdentity]> => {
      return [orgId, await deps.orgIdentity(orgId)];
    }),
    orgIds.length > 0 ? deps.brandsBasic(allBrandIds) : Promise.resolve(new Map<string, BrandBasic>()),
  ]);
  const orgDays = new Map(dayEntries);
  const orgIdentity = new Map(identityEntries);

  // 3. One row per EVER-active org (skip never-active orgs — zero billed cold-email days).
  const users: ActiveUserRow[] = [];
  for (const orgId of orgIds) {
    const days = orgDays.get(orgId)!;
    if (days.size === 0) continue;
    const brands: UserBrand[] = [...orgBrandIds.get(orgId)!].map((brandId) => {
      const info = brandInfo.get(brandId);
      return { brandId, brandName: info?.name ?? null, brandDomain: info?.domain ?? null };
    });
    users.push(summarizeUser(orgId, days, brands, orgIdentity.get(orgId)!, currentWeek, currentMonth));
  }

  // Sort most-recently-active first, then earliest-onboarded first, tiebreak orgId (deterministic).
  users.sort((a, b) => {
    if (a.lastActiveDay !== b.lastActiveDay) return a.lastActiveDay < b.lastActiveDay ? 1 : -1;
    if (a.firstActiveDay !== b.firstActiveDay) return a.firstActiveDay < b.firstActiveDay ? -1 : 1;
    return a.orgId.localeCompare(b.orgId);
  });

  return {
    users,
    stats: {
      totalUsers: users.length,
      activeThisWeekCount: users.filter((u) => u.activeThisWeek).length,
      activeThisMonthCount: users.filter((u) => u.activeThisMonth).length,
    },
    currentWeek,
    currentMonth,
    asOf: now.toISOString(),
  };
}
