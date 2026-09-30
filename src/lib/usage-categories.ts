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
 */
import { sumDecimalStrings, decimalCentsToUsd } from "./decimal.js";
import { selectCostCentsString } from "./pricing.js";

export const USAGE_CATEGORY_KEYS = [
  "setup",
  "finding_contacts",
  "writing_emails",
  "sending_emails",
  "reading_replies",
  "notifications",
  "other",
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
};

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

export interface UsageBreakdown {
  basis: "billed";
  totalBilledUsd: number;
  totalSetAsideUsd: number;
  /** Every category, in a fixed order, zeros included. Σ billedUsd === totalBilledUsd. */
  categories: UsageCategory[];
}

type CostGroup = Record<string, unknown> & { dimensions?: UsageCostDimensions | null };

/** Classify and sum runs-service cost groups on the NET basis (what the org is billed). Fail-loud on a
 *  group missing its net figures (via `selectCostCentsString`). */
export function buildUsageBreakdown(groups: readonly CostGroup[]): UsageBreakdown {
  const billed = new Map<UsageCategoryKey, string[]>();
  const setAside = new Map<UsageCategoryKey, string[]>();
  const allBilled: string[] = [];
  const allSetAside: string[] = [];
  for (const g of groups) {
    const key = usageCategoryOf(g.dimensions ?? {});
    const b = selectCostCentsString(g, "actualCostInUsdCents", "net");
    const s = selectCostCentsString(g, "provisionedCostInUsdCents", "net");
    (billed.get(key) ?? billed.set(key, []).get(key)!).push(b);
    (setAside.get(key) ?? setAside.set(key, []).get(key)!).push(s);
    allBilled.push(b);
    allSetAside.push(s);
  }
  return {
    basis: "billed",
    totalBilledUsd: decimalCentsToUsd(sumDecimalStrings(allBilled)),
    totalSetAsideUsd: decimalCentsToUsd(sumDecimalStrings(allSetAside)),
    categories: USAGE_CATEGORY_KEYS.map((key) => ({
      key,
      label: USAGE_CATEGORY_LABEL[key],
      billedUsd: decimalCentsToUsd(sumDecimalStrings(billed.get(key) ?? [])),
      setAsideUsd: decimalCentsToUsd(sumDecimalStrings(setAside.get(key) ?? [])),
    })),
  };
}
