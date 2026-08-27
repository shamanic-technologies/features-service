/**
 * WHAT THE CUSTOMER SPENT ON THE LEGS THEY WORKED THEMSELVES — lead-service's per-statement record.
 *
 * The platform automates the first link of a sales funnel and BILLS for it; the customer performs the
 * rest — they run the meeting, they close the deal — so they are the only one who knows what those
 * legs cost. Every money figure this service reports about a funnel used to count only the link the
 * platform paid for, which makes every funnel ending in a human leg read cheaper than it truly is and
 * its return too good.
 *
 * THIS IS NOT PLATFORM SPEND, AND IT MUST NEVER BE FOLDED INTO IT. Nothing here was charged to the
 * organisation, no platform cost was declared for it, and none of it appears in their billing. It is
 * reported BESIDE the charged spend, never inside it — "what we charged them" and "what they spent
 * themselves" are two different questions with two different owners, and a consumer must be able to
 * render either without inferring one from the other.
 *
 * A `costCents` of 0 is a STATED ZERO (a leg somebody did for free); `null` means nobody was ever
 * asked, which is why the producer counts the two separately and why a sum of stated costs is only as
 * complete as `unstatedCount` says it is. Never fabricate the missing ones: absent is absent.
 */
import { fetchWithRetry } from "./fetch-retry.js";

/** One live hand statement: what a leg cost the customer, and which campaign it is attributable to. */
export interface CustomerStepCost {
  /** The campaign the cost is attributable to. Null when the producer could not name one. */
  campaignId: string | null;
  /** The step of the outcome vocabulary the statement was made on. */
  step: string;
  /** `outcome` — the step happened; `never` — it will not, and the leg still cost. Both are real spend. */
  kind: "outcome" | "never";
  /** What the customer stated this leg cost them, in cents. 0 is a stated zero; null is "nobody asked". */
  costCents: number | null;
}

export interface BrandStepCosts {
  brandId: string;
  costs: CustomerStepCost[];
}

/**
 * `GET /internal/brands/{brandId}/step-costs` (service-auth: x-api-key + x-service-name).
 *
 * Org-less internal read — the brand is in the path — exactly like the conversion-count reads beside
 * it. Fails loud on missing config / transport / non-OK / malformed: a swallowed error would silently
 * drop the customer's own money out of a cost of acquisition. The caller decides whether to degrade
 * the display (see `fetchBrandStepCostsSoft`), which is a different decision from inventing a number.
 */
export async function fetchBrandStepCosts(brandId: string): Promise<BrandStepCosts> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");

  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/step-costs`,
    { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service /internal/brands/:brandId/step-costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { costs?: unknown };
  if (!Array.isArray(data.costs)) {
    throw new Error("lead-service /internal/brands/:brandId/step-costs returned malformed costs");
  }
  return {
    brandId,
    costs: data.costs.map((raw) => {
      const row = raw as Record<string, unknown>;
      const cents = row.costCents;
      if (cents !== null && typeof cents !== "number") {
        throw new Error("lead-service /internal/brands/:brandId/step-costs returned a malformed costCents");
      }
      if (row.kind !== "outcome" && row.kind !== "never") {
        throw new Error("lead-service /internal/brands/:brandId/step-costs returned a malformed kind");
      }
      return {
        campaignId: typeof row.campaignId === "string" ? row.campaignId : null,
        step: typeof row.step === "string" ? row.step : "",
        kind: row.kind,
        costCents: cents,
      };
    }),
  };
}

/**
 * The DISPLAY posture: `null` when the read could not be made at all.
 *
 * A funnel's charged spend, its volume and its platform-priced return are all correct without this, so
 * an unreadable statement set degrades the customer half rather than 502-ing a read whose every other
 * number is right — the same fail-soft-with-a-loud-log posture the conversion-count tiles take. Null
 * is distinguishable from an empty set on the wire, so "nobody stated a cost" and "we could not read
 * the statements" are never confused, and the stated basis stays TRUE either way.
 */
export async function fetchBrandStepCostsSoft(brandId: string): Promise<BrandStepCosts | null> {
  try {
    return await fetchBrandStepCosts(brandId);
  } catch (error) {
    console.error("[features-service] customer step-costs read failed (degrading to platform spend only):", error);
    return null;
  }
}
