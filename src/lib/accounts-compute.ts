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
 * verdict and the fleet budget total — therefore reads RUNNING. MRR/ARR are NOT budgets: they are
 * billing's recurring revenue (2026-09-29). CONFIGURED stays on the row because a
 * customer's own settings screen must still be able to state what they set.
 *
 * PROACTIVE vs REACTIVE (owner rule 2026-10-01). A PROACTIVE campaign starts conversations (its leg
 * is an ENTRY leg, `fromStep: null`, e.g. cold email) and spends its daily budget; a REACTIVE one only
 * acts on a conversation that already exists (AI meeting booking) and its budget is a CAP, rarely
 * spent. The running budget a client is charged for is PROACTIVE ONLY, so `runningDailyBudgetUsd` is
 * the proactive running budget (re-based in place 2026-10-01; it used to fold the reactive cap in, and
 * read Doc Dinners "active at $20/day" on an AI-meeting-booking cap with its cold email stopped). The
 * reactive cap rides beside it as `reactiveRunningDailyCapUsd`, never summed into money in play.
 *
 * STATUS rule (exact, precedence order; "running" = PROACTIVE running):
 *   0a. billing cannot charge the org because it has NO chargeable card (`no_chargeable_card`)     → "no_payment_method"
 *   0b. billing cannot charge the org for any other reason (payment-outlook `charge_blocked`)      → "payment_declined"
 *   1. runningDailyBudgetUsd > 0 && (autoTopupEnabled || actualBalanceUsd > runningDailyBudgetUsd) → "active"
 *   2. else runningDailyBudgetUsd == 0 && reactiveRunningDailyCapUsd > 0                           → "reactive_only"
 *   3. else configuredDailyBudgetUsd > 0                                                          → "paused"
 *   4. else                                                                                       → "inactive"
 * PAYMENT_DECLINED wins over everything: billing's verdict is that the org's card is refused (or
 * unusable, or from an unsupported country), campaign-service stops every campaign of such an org, and
 * any budget still reported as running is money that cannot be collected. `paymentDeclinedReason`
 * carries billing's own reason so the board says WHY. It is distinct from PAUSED (the customer's own
 * choice) and INACTIVE (nothing funded), and like them it is excluded from every fleet money total.
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
 * fleet running/configured totals are pure budget figures, so they are undiscounted too. MRR/ARR are
 * billing-service's RECURRING revenue (read, never re-derived; see `AccountsStats.mrrUsd`).
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
import { ARR_MONTHS, fetchFleetRecurringRevenue, sumRecurringMrr, type FleetRecurringRevenue } from "./recurring-revenue-client.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import {
  fetchOrgBalance,
  fetchOrgIdentity,
  fetchOrgPaymentHold,
  fetchBrandsBasic,
  fetchSpendableBudgets,
  spendableKey,
  type OrgBalance,
  type PaymentHold,
  type OrgIdentity,
  type BrandBasic,
  type BrandSpendableBudget,
} from "./accounts-client.js";
import { readStatedAmountsSoft } from "./stated-monthly-amounts-store.js";

/**
 * `no_payment_method` is billing's `charge_blocked` with blockedReason `no_chargeable_card`: the card
 * was removed, or never added, so nothing was ever declined. campaign-service stops such an org with
 * its own stop reason (`no_payment_method`) and the customer dashboard says "no payment method"; the
 * audit says the same thing rather than calling it a declined payment (owner rule 2026-09-27).
 */
export type AccountStatus = "active" | "payment_declined" | "no_payment_method" | "reactive_only" | "paused" | "inactive";

/** billing's blockedReason for an org with no chargeable card. */
export const NO_CHARGEABLE_CARD = "no_chargeable_card";

/**
 * Which side of the revenue split an org is on. `agency` = the org holds at least one stated monthly
 * amount (the SAME derivation the agency/self-serve MRR split uses, `agencyOrgIdsOf`): it pays its
 * cash up front at its own discretion, so its budget burn is an allocation of money already received,
 * not revenue still to come. `self_serve` = it holds none: it pays THROUGH the product, so its budget
 * burn IS its recurring revenue. A property of the ORG — every brand row of one org carries the same
 * value. This service holds no notion of "our own internal org"; that half is the consumer's.
 */
export type RevenueSide = "agency" | "self_serve";

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
   * The part of the configured ceiling standing behind a PROACTIVE campaign that is ongoing right now,
   * in USD. This is the money in play, and the figure the ACTIVE verdict and every fleet total read.
   * Equals `proactiveRunningDailyBudgetUsd` (re-based to proactive-only 2026-10-01).
   */
  runningDailyBudgetUsd: number;
  /** The PROACTIVE running daily budget, in USD (same value as `runningDailyBudgetUsd`, named for what it is). */
  proactiveRunningDailyBudgetUsd: number;
  /**
   * The ceiling standing behind REACTIVE campaigns that are ongoing right now, in USD: a CAP on work
   * that fires only when a lead reaches its step, rarely spent. Never money in play, never in a total of it.
   */
  reactiveRunningDailyCapUsd: number;
  /** Org SPENDABLE balance in USD (billing balance_cents/100; committed usage incl. holds subtracted). Display. */
  orgBalanceUsd: number;
  /** Org ACTUAL balance in USD (billing actual_balance_cents/100; only actualized usage subtracted). The active-verdict figure. */
  orgActualBalanceUsd: number;
  /** Whether the org has auto-topup enabled (billing has_auto_topup; false when absent). */
  autoTopupEnabled: boolean;
  status: AccountStatus;
  /**
   * billing's reason it cannot charge this org (`card_declined`, `card_country_unsupported`, …) when
   * `status` is "payment_declined" or "no_payment_method"; null otherwise (and null if billing blocked without naming one).
   */
  paymentDeclinedReason: string | null;
  /**
   * The org's side of the revenue split (see `RevenueSide`). `null` = the stated-amounts store could
   * not be read on this build, so the side is unknown — never guessed as self-serve.
   */
  revenueSide: RevenueSide | null;
  /**
   * billing-service's revenue class for the ORG (`recurring` | `one_off` | `none`), read from
   * `GET /internal/revenue/fleet` — never re-derived here. `null` = billing's revenue read was not
   * requested or unavailable on this build (see `stats.mrrUnavailableReason`), or billing could not
   * read this org.
   */
  revenueClass: string | null;
  /** billing's reason for `revenueClass` (`postpaid_chargeable_card`, `prepaid_no_auto_topup`, …), or null. */
  revenueClassReason: string | null;
  /**
   * The ORG's recurring MRR as billing states it (USD, org-level — every brand row of one org carries
   * the same value; never sum it across rows). 0 for a one-off or non-paying org; `null` = unknown.
   */
  orgRecurringMrrUsd: number | null;
}

export interface AccountsStats {
  /** Σ PROACTIVE RUNNING daily budget over ACTIVE rows only (USD; undiscounted — a budget is not a charge). The staff-page figure. */
  totalRunningDailyBudgetUsd: number;
  /** Σ REACTIVE running cap over ACTIVE and REACTIVE_ONLY rows (USD). A cap, never added to the figure above. */
  totalReactiveRunningDailyCapUsd: number;
  /** Σ CONFIGURED daily budget over ACTIVE rows only (USD). What those customers set, whatever is running. */
  totalConfiguredDailyBudgetUsd: number;
  /**
   * MRR = billing-service's RECURRING revenue for the whole fleet (Σ of every org's known MRR, billing
   * `GET /internal/revenue/fleet`): recurring orgs only (postpaid with a chargeable card, or prepaid with
   * auto top-up and a card), proactive running campaigns with audience left only, DRR × 30. A reactive
   * campaign's budget and a one-off prepaid org are NOT in it. Supersedes the old
   * `totalRunningDailyBudgetUsd × 30` (2026-09-29). `null` = billing's read was unavailable
   * (`mrrUnavailableReason`), never the old computation.
   */
  mrrUsd: number | null;
  /** ARR = mrrUsd × 12. null whenever the MRR is. (Was running budget × 365 until 2026-09-29.) */
  arrUsd: number | null;
  /** The basis of `mrrUsd`: always billing's recurring figure. */
  mrrBasis: "billing_recurring";
  /** Why `mrrUsd` is null (`billing_revenue_unavailable` / `not_requested`), or null when it is stated. */
  mrrUnavailableReason: "billing_revenue_unavailable" | "not_requested" | null;
  /** Orgs whose MRR billing could not state — listed beside the sum, never counted as 0. */
  mrrUnknownOrgIds: string[];
  activeCount: number;
  /** Rows with nothing proactive running but a reactive campaign still on (status reactive_only). */
  reactiveOnlyCount: number;
  paymentDeclinedCount: number;
  /** Rows with no chargeable card (status no_payment_method); excluded from every money total. */
  noPaymentMethodCount: number;
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
  /** billing's payment hold for the org (null = billing can charge it, or has no account for it). */
  paymentHold: (orgId: string) => Promise<PaymentHold | null>;
  spendableBudgets: (
    pairs: Array<{ orgId: string; brandId: string }>,
  ) => Promise<Map<string, BrandSpendableBudget>>;
  brandsBasic: (ids: string[]) => Promise<Map<string, BrandBasic>>;
  /**
   * Every stated monthly amount, fail-SOFT (`null` = unreadable). Optional so a fixture that does not
   * care about the revenue side need not state it; absent ⇒ every row reads `revenueSide: null`.
   */
  statedAmounts?: () => Promise<Array<{ orgId: string }> | null>;
  /** billing's recurring revenue for every org. Read only when the caller asks for the MRR. */
  recurringRevenue?: () => Promise<FleetRecurringRevenue>;
}

export interface AccountsAuditOptions {
  /**
   * Read billing's recurring revenue (a ~15 s fleet read) to state MRR/ARR and each row's revenue
   * class. The staff Accounts page and the revenue history ask for it; the active-users count does not.
   */
  recurringRevenue?: boolean;
}

const REAL_DEPS: AccountsDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId, brandId: m.brandId })),
  orgBalance: fetchOrgBalance,
  orgIdentity: fetchOrgIdentity,
  paymentHold: fetchOrgPaymentHold,
  spendableBudgets: fetchSpendableBudgets,
  brandsBasic: fetchBrandsBasic,
  statedAmounts: readStatedAmountsSoft,
  recurringRevenue: fetchFleetRecurringRevenue,
};

/**
 * The exact status rule (single source, used by the accounts row builder, the send-forecast active
 * gate, and asserted directly in tests). Precedence: payment_declined / no_payment_method > active > paused > inactive.
 *
 * REACTIVE_ONLY is the account whose proactive campaigns are all stopped while a reactive one is still
 * on: it starts no conversation and spends next to nothing, so it is not active, and it is not paused
 * either (something still runs). Like paused it is excluded from every fleet money total.
 *
 * PAYMENT_DECLINED first: when billing cannot charge the org, nothing it has configured or running is
 * money in play, so it can never read active (nor paused, which is the customer's own choice).
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
  proactiveRunningDailyBudgetUsd: number,
  reactiveRunningDailyCapUsd: number,
  actualBalanceUsd: number,
  autoTopupEnabled: boolean,
  paymentHold: PaymentHold | null,
): AccountStatus {
  if (paymentHold) return paymentHold.blockedReason === NO_CHARGEABLE_CARD ? "no_payment_method" : "payment_declined";
  if (proactiveRunningDailyBudgetUsd > 0 && (autoTopupEnabled || actualBalanceUsd > proactiveRunningDailyBudgetUsd)) return "active";
  if (proactiveRunningDailyBudgetUsd === 0 && reactiveRunningDailyCapUsd > 0) return "reactive_only";
  if (configuredDailyBudgetUsd > 0) return "paused";
  return "inactive";
}

/** One org's billing MRR (cents text) as USD, or null when unknown / not read. */
function orgMrrUsd(cents: string | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Math.round(Number(cents)) / 100;
}

export async function buildAccountsAudit(
  coldEmailSlugsCsv: string,
  now: Date = new Date(),
  deps: AccountsDeps = REAL_DEPS,
  opts: AccountsAuditOptions = {},
): Promise<AccountsAudit> {
  // 1. Enumerate distinct (org, brand) accounts across the cold-email feature set.
  const memberships = coldEmailSlugsCsv ? await deps.featureMemberships(coldEmailSlugsCsv) : [];
  const pairs = new Map<string, { orgId: string; brandId: string }>();
  for (const m of memberships) pairs.set(`${m.orgId}::${m.brandId}`, { orgId: m.orgId, brandId: m.brandId });

  const orgIds = [...new Set([...pairs.values()].map((p) => p.orgId))];
  const brandIds = [...new Set([...pairs.values()].map((p) => p.brandId))];
  // One batched call for every pair's configured + running budget — a fleet audit cannot afford a
  // request per brand, and both figures come from the same producer computation.
  const wantRecurring = opts.recurringRevenue === true && deps.recurringRevenue !== undefined;
  const [budgets, statedRows, recurring] = await Promise.all([
    deps.spendableBudgets([...pairs.values()]),
    // Fail-soft: the side is additive information on a fail-loud audit whose other consumers (revenue
    // history, send-forecast, customer-health) must not gain a new way to fail. Unreadable ⇒ null side.
    deps.statedAmounts ? deps.statedAmounts() : Promise.resolve(null),
    // Fail-soft to NULL with a reason: an unavailable billing read makes the MRR unknown — it never
    // falls back to the running-budget computation this replaced, and never fails the audit's rows.
    wantRecurring
      ? deps.recurringRevenue!().catch((err) => {
          console.error("[features-service] accounts: billing recurring revenue unavailable (soft):", err);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const recurringByOrg = new Map((recurring?.orgs ?? []).map((o) => [o.orgId, o]));
  // The agency rule, byte-for-byte `agencyOrgIdsOf` (agency-self-serve-compute.ts): any org carrying a
  // stated amount, whatever its date range. Restated rather than imported because that module imports
  // active-users-compute, which imports this one.
  const agencyOrgIds = statedRows === null ? null : new Set(statedRows.map((r) => r.orgId));

  // 2. Org-level reads once per org (balance + identity + billing's payment hold); brand name/domain in one batched call.
  const [orgInfoEntries, brandInfo] = await Promise.all([
    Promise.all(
      orgIds.map(
        async (orgId): Promise<[string, { balance: OrgBalance; identity: OrgIdentity; hold: PaymentHold | null }]> => {
          const [balance, identity, hold] = await Promise.all([
            deps.orgBalance(orgId),
            deps.orgIdentity(orgId),
            deps.paymentHold(orgId),
          ]);
          return [orgId, { balance, identity, hold }];
        },
      ),
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
        runningDailyBudgetUsd: budget.proactiveRunningUsd,
        proactiveRunningDailyBudgetUsd: budget.proactiveRunningUsd,
        reactiveRunningDailyCapUsd: budget.reactiveRunningUsd,
        orgBalanceUsd: balance.spendableUsd,
        orgActualBalanceUsd: balance.actualUsd,
        autoTopupEnabled: balance.autoTopupEnabled,
        status: accountStatus(
          budget.configuredUsd,
          budget.proactiveRunningUsd,
          budget.reactiveRunningUsd,
          balance.actualUsd,
          balance.autoTopupEnabled,
          info.hold,
        ),
        paymentDeclinedReason: info.hold?.blockedReason ?? null,
        revenueSide: agencyOrgIds === null ? null : agencyOrgIds.has(p.orgId) ? "agency" : "self_serve",
        revenueClass: recurringByOrg.get(p.orgId)?.revenueClass ?? null,
        revenueClassReason: recurringByOrg.get(p.orgId)?.classReason ?? null,
        orgRecurringMrrUsd: orgMrrUsd(recurringByOrg.get(p.orgId)?.mrrCents),
      };
  });

  // Deterministic order: active → payment_declined → no_payment_method → reactive_only → paused → inactive, then running budget desc, tiebreak on the
  // configured one (a paused row runs nothing, so its posted money is what ranks it), then brandId.
  const statusRank: Record<AccountStatus, number> = { active: 0, payment_declined: 1, no_payment_method: 2, reactive_only: 3, paused: 4, inactive: 5 };
  rows.sort((a, b) => {
    if (a.status !== b.status) return statusRank[a.status] - statusRank[b.status];
    if (a.runningDailyBudgetUsd !== b.runningDailyBudgetUsd) {
      return b.runningDailyBudgetUsd - a.runningDailyBudgetUsd;
    }
    if (a.reactiveRunningDailyCapUsd !== b.reactiveRunningDailyCapUsd) {
      return b.reactiveRunningDailyCapUsd - a.reactiveRunningDailyCapUsd;
    }
    if (a.configuredDailyBudgetUsd !== b.configuredDailyBudgetUsd) {
      return b.configuredDailyBudgetUsd - a.configuredDailyBudgetUsd;
    }
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats — sum the RUNNING daily budget over ACTIVE rows only (paused/inactive don't spend);
  //    Undiscounted budget total (a ceiling is config, not a charge); NOT the MRR (see step 5). Active ⇒
  //    running > 0 by the verdict rule, so the sum is over positive numbers. The configured total rides
  //    alongside so a reader can see what those same customers posted, and can never be mistaken for it.
  let totalRunningDailyBudgetUsd = 0;
  let totalConfiguredDailyBudgetUsd = 0;
  let totalReactiveRunningDailyCapUsd = 0;
  let activeCount = 0;
  let reactiveOnlyCount = 0;
  let pausedCount = 0;
  let paymentDeclinedCount = 0;
  let noPaymentMethodCount = 0;
  for (const row of rows) {
    if (row.status === "active") {
      totalRunningDailyBudgetUsd += row.runningDailyBudgetUsd;
      totalConfiguredDailyBudgetUsd += row.configuredDailyBudgetUsd;
      totalReactiveRunningDailyCapUsd += row.reactiveRunningDailyCapUsd;
      activeCount += 1;
    } else if (row.status === "reactive_only") {
      totalReactiveRunningDailyCapUsd += row.reactiveRunningDailyCapUsd;
      reactiveOnlyCount += 1;
    } else if (row.status === "paused") {
      pausedCount += 1;
    } else if (row.status === "payment_declined") {
      paymentDeclinedCount += 1;
    } else if (row.status === "no_payment_method") {
      noPaymentMethodCount += 1;
    }
  }
  const inactiveCount = rows.length - activeCount - reactiveOnlyCount - pausedCount - paymentDeclinedCount - noPaymentMethodCount;
  // Round the fleet totals to cents defensively (per-row budgets are already dollars-and-cents).
  totalRunningDailyBudgetUsd = Math.round(totalRunningDailyBudgetUsd * 100) / 100;
  totalConfiguredDailyBudgetUsd = Math.round(totalConfiguredDailyBudgetUsd * 100) / 100;
  totalReactiveRunningDailyCapUsd = Math.round(totalReactiveRunningDailyCapUsd * 100) / 100;

  // 5. MRR / ARR — billing's recurring figure for the fleet, summed on its own decimal text. The
  //    running budget above is configuration in play, not revenue, and is no longer multiplied into MRR.
  const mrr = recurring ? sumRecurringMrr(recurring) : null;
  return {
    rows,
    stats: {
      totalRunningDailyBudgetUsd,
      totalConfiguredDailyBudgetUsd,
      totalReactiveRunningDailyCapUsd,
      mrrUsd: mrr ? mrr.mrrUsd : null,
      arrUsd: mrr ? Math.round(mrr.mrrUsd * ARR_MONTHS * 100) / 100 : null,
      mrrBasis: "billing_recurring",
      mrrUnavailableReason: mrr ? null : wantRecurring ? "billing_revenue_unavailable" : "not_requested",
      mrrUnknownOrgIds: mrr ? mrr.unknownOrgIds : [],
      activeCount,
      reactiveOnlyCount,
      paymentDeclinedCount,
      noPaymentMethodCount,
      pausedCount,
      inactiveCount,
      totalCount: rows.length,
    },
    asOf: now.toISOString(),
  };
}
