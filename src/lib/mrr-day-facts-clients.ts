/**
 * THE FOUR FACTS A DAY'S SaaS RUN-RATE RESTS ON, each read from the service that RECORDS it.
 *
 * The fleet's monthly run-rate counts a brand's budget on a given day only when all four of these
 * held THAT DAY: payment had not stopped, a campaign was running, an amount was in force, and there
 * was somebody left to contact. Every one of those is a fact some service already keeps, and none of
 * them is this service's to invent — so this module is four readers and no arithmetic.
 *
 *   billing-service  GET /internal/brands/:brandId/daily-budget/by-day            → the AMOUNT in force
 *   billing-service  GET /internal/accounts/by-org/:orgId/payment-stopped-periods → PAYMENT stopped
 *   campaign-service GET /campaigns/list                                          → which campaigns a pair has
 *   campaign-service POST /internal/campaigns/earning-history                     → RUNNING + AUDIENCE
 *
 * `not_recorded` IS THE ANSWER THAT MATTERS MOST, and every reader preserves it rather than
 * collapsing it to a zero or a false. A day before a producer's record begins is a day we know
 * nothing about, which is a different statement from "the budget was 0" or "the campaign was
 * stopped" — and telling the two apart is the whole reason the caller can mark a period as
 * approximated instead of presenting a guess as a measurement.
 *
 * Shapes CONFORM to the deployed producer contracts (read from api-registry, verified against prod),
 * never a shape authored here. All four FAIL LOUD; the split that consumes them is wrapped fail-soft
 * by its caller, so a producer blip nulls the split and leaves every other figure on the revenue
 * payload correct.
 */
import { fetchWithRetry } from "./fetch-retry.js";

/** How the caller learned a fact: from a producer's record, or inferred from activity evidence. */
export type FactBasis = "recorded" | "approximated";

/** One pair's recorded daily-budget answer per UTC day. */
export interface BudgetByDay {
  /** ISO timestamp the brand's budget record begins, or null when billing holds no change for it. */
  recordBeginsAt: string | null;
  /** day (`YYYY-MM-DD`) → amount in force, USD. A day billing answered `not_recorded` is ABSENT. */
  byDay: Map<string, number>;
}

/**
 * What amount was in force for a brand on each UTC day of a range, replayed by billing from its own
 * append-only change log. The GRAIN is the brand total — billing states explicitly that its finer
 * per-funnel / per-leg ceilings carry no change log, so a past-day answer at that grain would be
 * invented. A `not_recorded` day is DROPPED from the map (absent ≠ 0).
 */
export async function fetchBrandBudgetByDay(
  brandId: string,
  orgId: string,
  from: string,
  to: string,
): Promise<BudgetByDay> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");

  const params = new URLSearchParams({ from, to });
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/daily-budget/by-day?${params}`,
    { headers: { "x-api-key": apiKey, "x-org-id": orgId } },
  );
  if (!response.ok) {
    throw new Error(`billing-service daily-budget/by-day failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    recordBeginsAt?: string | null;
    days?: Array<{ date?: string; state?: string; dailyBudgetCents?: string | number | null }>;
  };
  if (!Array.isArray(data.days)) throw new Error("billing-service daily-budget/by-day returned no days array");

  const byDay = new Map<string, number>();
  for (const d of data.days) {
    if (typeof d.date !== "string") throw new Error("billing-service daily-budget/by-day entry missing date");
    if (d.state !== "recorded") continue; // not_recorded is an answer: we hold no amount, so we assert none
    const cents = Number(d.dailyBudgetCents);
    if (!Number.isFinite(cents)) {
      throw new Error(`billing-service daily-budget/by-day recorded day with non-numeric cents: ${JSON.stringify(d)}`);
    }
    byDay.set(d.date, cents / 100);
  }
  return { recordBeginsAt: data.recordBeginsAt ?? null, byDay };
}

/** Every stretch during which an org was not paying, plus the day the fleet's record begins. */
export interface PaymentStoppedFacts {
  /** UTC day (`YYYY-MM-DD`) the episode record begins, or null when nothing was ever recorded. */
  recordBeginsOn: string | null;
  /** Closed or still-open stretches, as UTC days. `endedOn: null` = still inside it. */
  periods: Array<{ startedOn: string; endedOn: string | null }>;
}

/**
 * When an org's payment had stopped — a failed card or credit gone — as periods. Service-to-service
 * read with the api-key ONLY and the org in the path (no `x-org-id`, no sentinel identity), per the
 * deployed contract. `recordBeginsAt` matters: before it, the ABSENCE of a period is not evidence
 * that payment was on, so the caller must treat that day's payment axis as unrecorded.
 */
export async function fetchPaymentStoppedPeriods(orgId: string): Promise<PaymentStoppedFacts> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");

  const response = await fetchWithRetry(
    `${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/payment-stopped-periods`,
    { headers: { "x-api-key": apiKey } },
  );
  if (!response.ok) {
    throw new Error(`billing-service payment-stopped-periods failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    recordBeginsAt?: string | null;
    periods?: Array<{ startedAt?: string; endedAt?: string | null }>;
  };
  if (!Array.isArray(data.periods)) throw new Error("billing-service payment-stopped-periods returned no periods array");

  return {
    recordBeginsOn: typeof data.recordBeginsAt === "string" ? data.recordBeginsAt.slice(0, 10) : null,
    periods: data.periods.map((p) => {
      if (typeof p.startedAt !== "string") throw new Error("billing-service payment-stopped period missing startedAt");
      return { startedOn: p.startedAt.slice(0, 10), endedOn: typeof p.endedAt === "string" ? p.endedAt.slice(0, 10) : null };
    }),
  };
}

/** The identity of one campaign, as much of it as the run-rate question needs. */
export interface FleetCampaignRow {
  campaignId: string;
  orgId: string;
  /** The brand it funds, or null for a legacy row that names none (such a row joins to no pair). */
  brandId: string | null;
}

/**
 * Every campaign across every org, in ONE call — the cheapest way to answer "which campaigns does
 * this (org, brand) pair have", which a per-pair fan-out would turn into one round trip per brand.
 */
export async function fetchFleetCampaigns(): Promise<FleetCampaignRow[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");

  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    campaigns?: Array<{ id?: string; orgId?: string; brandId?: string | null; brandIds?: string[] | null }>;
  };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");

  return data.campaigns.flatMap((c) => {
    if (typeof c.id !== "string" || typeof c.orgId !== "string") return [];
    const brandId = c.brandIds?.[0] ?? c.brandId ?? null;
    return [{ campaignId: c.id, orgId: c.orgId, brandId: typeof brandId === "string" ? brandId : null }];
  });
}

/** What campaign-service recorded about one campaign on one UTC day. */
export interface CampaignDayAnswer {
  campaignId: string;
  status: "ongoing" | "stopped" | "not_recorded";
  audience: "available" | "exhausted" | "not_recorded";
  /** The producer's own verdict: true only when BOTH axes are recorded and both say yes. */
  earning: boolean | null;
  /** ISO timestamp this campaign's status record begins, or null. */
  statusRecordedSince: string | null;
  /** ISO timestamp this campaign's audience record begins, or null. */
  audienceRecordedSince: string | null;
}

/** campaign-service's documented cap on one batch. */
export const EARNING_BATCH_SIZE = 500;

/**
 * Was each of these campaigns running, and did it have anybody to contact, on ONE UTC day.
 *
 * Asked a DAY at a time rather than over the whole displayed range on purpose: the caller needs an
 * answer only on each period's reference date, and a range read would carry (campaigns × days) rows
 * for a question that is (campaigns × a dozen dates) — tens of megabytes of JSON through a 384 MB
 * heap to use a hundredth of it.
 */
export async function fetchCampaignEarningOnDay(campaignIds: string[], day: string): Promise<CampaignDayAnswer[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  if (campaignIds.length === 0) return [];
  if (campaignIds.length > EARNING_BATCH_SIZE) {
    throw new Error(`campaign earning-history batch of ${campaignIds.length} exceeds the producer cap of ${EARNING_BATCH_SIZE}`);
  }

  const response = await fetchWithRetry(`${url}/internal/campaigns/earning-history`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ campaignIds, from: day, to: day }),
  });
  if (!response.ok) {
    throw new Error(`campaign-service earning-history failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    campaigns?: Array<{
      campaignId?: string;
      statusRecordedSince?: string | null;
      audienceRecordedSince?: string | null;
      days?: Array<{ day?: string; status?: string; audience?: string; earning?: boolean | null }>;
    }>;
  };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service earning-history returned no campaigns array");

  return data.campaigns.flatMap((c) => {
    if (typeof c.campaignId !== "string") return [];
    const row = c.days?.find((d) => d.day === day) ?? c.days?.[0];
    if (!row) return [];
    return [
      {
        campaignId: c.campaignId,
        status: (row.status === "ongoing" || row.status === "stopped" ? row.status : "not_recorded") as CampaignDayAnswer["status"],
        audience: (row.audience === "available" || row.audience === "exhausted" ? row.audience : "not_recorded") as CampaignDayAnswer["audience"],
        earning: typeof row.earning === "boolean" ? row.earning : null,
        statusRecordedSince: c.statusRecordedSince ?? null,
        audienceRecordedSince: c.audienceRecordedSince ?? null,
      },
    ];
  });
}
