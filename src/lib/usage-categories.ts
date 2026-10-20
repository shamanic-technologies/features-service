/**
 * What an org's money was spent on, by CUSTOMER ACTIVITY — the "Usage" section of the Billing page.
 *
 * A customer asking "why does the sum of my audiences not match what I was billed" needs the whole
 * bill broken down, including the spend no audience or campaign carries (setting up the brand, the
 * offer and the audiences). This module classifies every runs-service cost group into ONE activity and
 * sums them. It is pure; `routes/usage.ts` does the read.
 *
 * Rules that are load-bearing:
 *   - A category is something the CUSTOMER recognises. Never a vendor, a model or a service name.
 *   - The basis is BILLED (net actual) with the open holds (net provisioned) beside it, i.e. the two
 *     figures the Billing page prints as "Billed" and "Set aside". The categories are summed from the
 *     SAME groups as the total, exactly (decimal strings, never floats), so the Total row equals
 *     "Billed" to the cent by construction.
 *   - Nothing is dropped: a cost line this map does not know goes to `other`, never to a guessed
 *     category and never nowhere.
 *   - BILLING IS THE SOURCE OF TRUTH FOR WHAT WAS BILLED (USAGE-MATCHES-BILLED-1021). runs-service holds
 *     every cost, but billing-service bills the org a different figure: spend with NO campaign from
 *     `PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO` on is the platform's cost, not the client's (owner rule
 *     2026-10-13, billing lib/platform-absorbed), and billing's one usage choke point (lib/transfer-usage)
 *     also applies brand-transfer corrections, staff debits and expired subscription credit. So:
 *       · the absorbed spend (runs-service's own no-campaign total since the cutoff, the read billing
 *         makes) is taken OUT of the categories and served on its own as `coveredByUs`, never as billed;
 *       · the totals ARE billing's figures (Billed = credited − actual balance, Set aside = actual balance −
 *         balance, the two lines the Billing page prints), and whatever billing bills beyond the
 *         classified spend (a staff debit, a transfer correction, expired credit, a cost written between
 *         the two reads) is its own `account_adjustments` line, so Σ categories === total to the cent.
 */
import { addDecimals, sumDecimalStrings, decimalCentsToUsd } from "./decimal.js";
import { selectCostCentsString } from "./pricing.js";

export const USAGE_CATEGORY_KEYS = [
  "setup",
  "finding_contacts",
  "writing_emails",
  "sending_emails",
  "reading_replies",
  "notifications",
  "other",
  "account_adjustments",
] as const;
export type UsageCategoryKey = (typeof USAGE_CATEGORY_KEYS)[number];

export const USAGE_CATEGORY_LABEL: Record<UsageCategoryKey, string> = {
  setup: "Setting up your brand, offer and audiences",
  finding_contacts: "Finding and verifying contacts",
  writing_emails: "Writing your emails",
  sending_emails: "Sending emails",
  reading_replies: "Reading replies",
  notifications: "Notifications",
  other: "Other",
  account_adjustments: "Account adjustments",
};

/**
 * billing-service's cutover (lib/platform-absorbed `PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO`, owner rule
 * 2026-10-13): from this instant on, spend with no campaign is the platform's. Byte-equal to billing's
 * literal; were billing to move it, the difference lands in `account_adjustments` (never a wrong total,
 * the total is billing's own) and the route logs it loud.
 */
export const PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO = "2026-10-13T00:00:00.000Z";

const NOTIFICATION_SERVICES = new Set(["postmark-service", "transactional-email-service"]);
const WRITING_SERVICES = new Set(["chat-service", "content-generation-service"]);
const CONTACT_SERVICES = new Set(["apollo-service", "lead-service", "human-service"]);
const SENDING_SERVICES = new Set(["instantly-service", "email-gateway"]);

export interface UsageCostDimensions {
  serviceName?: string | null;
  taskName?: string | null;
  campaignId?: string | null;
}

/** The activity one cost line belongs to. */
export function usageCategoryOf(d: UsageCostDimensions): UsageCategoryKey {
  const service = d.serviceName ?? "";
  const task = d.taskName ?? "";
  if (NOTIFICATION_SERVICES.has(service)) return "notifications";
  // Anything that ran outside a campaign is the customer setting things up (reading the site,
  // drafting the offer, splitting and sizing audiences, their pictures).
  if (!d.campaignId) return "setup";
  if (WRITING_SERVICES.has(service)) return task === "judgments" ? "reading_replies" : "writing_emails";
  if (CONTACT_SERVICES.has(service)) return "finding_contacts";
  if (SENDING_SERVICES.has(service)) return "sending_emails";
  return "other";
}

export interface UsageCategory {
  key: UsageCategoryKey;
  label: string;
  billedUsd: number;
  setAsideUsd: number;
}

/** Spend with no campaign the platform absorbed (runs-service `/internal/org-no-campaign-total` since the
 *  cutover, net cents): `billedCents` = the actualized part, `setAsideCents` = the part still held. */
export interface AbsorbedCents {
  billedCents: string;
  setAsideCents: string;
}

/** billing-service's own two figures for the org (cents): Billed and Set aside. */
export interface BillingCents {
  billedCents: string;
  setAsideCents: string;
}

export interface UsageBreakdown {
  basis: "billed";
  /** billing-service's Billed for the org (credited − actual balance); Σ categories[].billedUsd. */
  totalBilledUsd: number;
  /** billing-service's Set aside for the org (actual balance − balance); Σ categories[].setAsideUsd. */
  totalSetAsideUsd: number;
  /** Every category, in a fixed order, zeros included. Σ billedUsd === totalBilledUsd. */
  categories: UsageCategory[];
  /** Spend with no campaign the platform absorbed: recorded, never billed to the org, in no total. */
  coveredByUs: { billedUsd: number; setAsideUsd: number; sinceIso: string };
  /** "billing" = the totals are billing-service's figures; "no_billing_account" = billing holds no
   *  account for the org, so the totals are the classified spend net of `coveredByUs`. */
  totalsSource: "billing" | "no_billing_account";
}

type CostGroup = Record<string, unknown> & { dimensions?: UsageCostDimensions | null };

const neg = (x: string): string => (x.startsWith("-") ? x.slice(1) : `-${x}`);
const sub = (x: string, y: string): string => addDecimals(x, neg(y));
const isNegative = (x: string): boolean => /^-/.test(x) && /[1-9]/.test(x);
const isZero = (x: string): boolean => !/[1-9]/.test(x);

/** Take `amount` out of the no-campaign pools, in order, never below zero; returns what could not be taken. */
function takeOut(pools: Map<UsageCategoryKey, string>, order: readonly UsageCategoryKey[], amount: string): string {
  let left = amount;
  for (const key of order) {
    if (isZero(left) || isNegative(left)) break;
    const have = pools.get(key) ?? "0";
    const after = sub(have, left);
    if (isNegative(after)) {
      pools.set(key, "0");
      left = sub(left, have);
    } else {
      pools.set(key, after);
      left = "0";
    }
  }
  return left;
}

export interface UsageBreakdownInputs {
  absorbed: AbsorbedCents;
  /** null when billing-service holds no account for the org. */
  billing: BillingCents | null;
}

export interface UsageBreakdownResult {
  breakdown: UsageBreakdown;
  /** Absorbed spend no no-campaign line could carry (its basis disagreed with the classified spend):
   *  billing still absorbed it, so it reads in `account_adjustments`; the route logs it loud. */
  unplacedAbsorbedCents: { billed: string; setAside: string };
}

/**
 * Classify and sum runs-service cost groups on the NET basis, take the platform-absorbed spend out of the
 * no-campaign categories, and close on billing's totals. Fail-loud on a group missing its net figures
 * (via `selectCostCentsString`).
 */
export function buildUsageBreakdown(groups: readonly CostGroup[], inputs: UsageBreakdownInputs): UsageBreakdownResult {
  const billed = new Map<UsageCategoryKey, string[]>();
  const setAside = new Map<UsageCategoryKey, string[]>();
  // The no-campaign part of each category: the only spend the platform can have absorbed.
  const noCampaignBilled = new Map<UsageCategoryKey, string>();
  const noCampaignSetAside = new Map<UsageCategoryKey, string>();
  for (const g of groups) {
    const dims = g.dimensions ?? {};
    const key = usageCategoryOf(dims);
    const b = selectCostCentsString(g, "actualCostInUsdCents", "net");
    const s = selectCostCentsString(g, "provisionedCostInUsdCents", "net");
    (billed.get(key) ?? billed.set(key, []).get(key)!).push(b);
    (setAside.get(key) ?? setAside.set(key, []).get(key)!).push(s);
    if (!dims.campaignId) {
      noCampaignBilled.set(key, addDecimals(noCampaignBilled.get(key) ?? "0", b));
      noCampaignSetAside.set(key, addDecimals(noCampaignSetAside.get(key) ?? "0", s));
    }
  }
  // Absorbed spend comes out of setup first (it is almost all of it), then out of any other no-campaign line.
  const order = USAGE_CATEGORY_KEYS.filter((k) => k !== "account_adjustments").sort((a, b) =>
    a === "setup" ? -1 : b === "setup" ? 1 : 0,
  );
  const billedPools = new Map(noCampaignBilled);
  const setAsidePools = new Map(noCampaignSetAside);
  const unplacedBilled = takeOut(billedPools, order, inputs.absorbed.billedCents);
  const unplacedSetAside = takeOut(setAsidePools, order, inputs.absorbed.setAsideCents);

  const categoryCents = order.map((key) => {
    const absorbedB = sub(noCampaignBilled.get(key) ?? "0", billedPools.get(key) ?? "0");
    const absorbedS = sub(noCampaignSetAside.get(key) ?? "0", setAsidePools.get(key) ?? "0");
    return {
      key,
      billed: sub(sumDecimalStrings(billed.get(key) ?? []), absorbedB),
      setAside: sub(sumDecimalStrings(setAside.get(key) ?? []), absorbedS),
    };
  });
  const classifiedBilled = sumDecimalStrings(categoryCents.map((c) => c.billed));
  const classifiedSetAside = sumDecimalStrings(categoryCents.map((c) => c.setAside));
  // Whatever billing bills beyond the classified spend is its own line; without a billing account the
  // classified spend is the whole figure.
  const totalBilled = inputs.billing ? inputs.billing.billedCents : classifiedBilled;
  const totalSetAside = inputs.billing ? inputs.billing.setAsideCents : classifiedSetAside;
  const adjustment = { key: "account_adjustments" as const, billed: sub(totalBilled, classifiedBilled), setAside: sub(totalSetAside, classifiedSetAside) };
  const byKey = new Map([...categoryCents, adjustment].map((c) => [c.key, c]));

  return {
    breakdown: {
      basis: "billed",
      totalBilledUsd: decimalCentsToUsd(totalBilled),
      totalSetAsideUsd: decimalCentsToUsd(totalSetAside),
      categories: USAGE_CATEGORY_KEYS.map((key) => ({
        key,
        label: USAGE_CATEGORY_LABEL[key],
        billedUsd: decimalCentsToUsd(byKey.get(key)!.billed),
        setAsideUsd: decimalCentsToUsd(byKey.get(key)!.setAside),
      })),
      coveredByUs: {
        billedUsd: decimalCentsToUsd(inputs.absorbed.billedCents),
        setAsideUsd: decimalCentsToUsd(inputs.absorbed.setAsideCents),
        sinceIso: PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO,
      },
      totalsSource: inputs.billing ? "billing" : "no_billing_account",
    },
    unplacedAbsorbedCents: { billed: unplacedBilled, setAside: unplacedSetAside },
  };
}
