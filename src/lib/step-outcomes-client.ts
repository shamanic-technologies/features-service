import { fetchWithRetry } from "./fetch-retry.js";

/**
 * WHAT A HUMAN OBSERVED ABOUT A LEAD — the readers that let the revenue engine stop estimating.
 *
 * Every figure this service reports about a lead used to be a projection: a chance of becoming a
 * paying client, obtained by multiplying declared conversion rates through whatever the lead last
 * did. That was the only thing available. The website tracker sees roughly one conversion in ten (it
 * cannot see a meeting somebody took or a deal closed on a call at all), so a booked meeting and a
 * won deal lived as typed notes where nothing that computes money could read them.
 *
 * lead-service now records what a human states about a funnel step, and exposes it two ways —
 * deliberately apart, because they are not the same kind of fact:
 *
 *   - an OUTCOME ("this happened") is a conversion event like any other, and carries WHEN it happened
 *     and WHAT IT WAS WORTH. `GET /internal/brands/:brandId/converted-leads?event=<step>`.
 *   - a NEVER ("this will not happen") is NOT an outcome and nothing counts it. It exists so a
 *     consumer can tell a lead that is DEAD at a step from one still PENDING — the difference between
 *     a forecast still worth making and one that has been ruled out.
 *     `GET /internal/brands/:brandId/step-disqualifications`.
 *
 * Contract ownership: lead-service OWNS both paths, their vocabulary and their shapes. This reader
 * CONFORMS to what is deployed and invents nothing.
 *
 * Fail-loud: silence here does not read as "no outcomes", it reads as "this brand's deals never
 * closed" — every money figure on the page would quietly revert to the forecast this whole change
 * exists to replace. Any missing config / transport / non-OK / malformed response throws; the caller
 * decides whether that degrades a display or propagates.
 */

/**
 * The five steps a human can state, byte-equal to lead-service's own vocabulary.
 *
 * `meeting_attended` is the one only a human can state: attendance happens off the client's website,
 * so a page-load tag has nothing to observe. Sales funnels have carried the step all along and
 * brand-service prices with a booked→attended rate that, until now, no event in the fleet could ever
 * measure against reality.
 */
export type LeadStepOutcome =
  | "signup"
  | "meeting_booked"
  | "meeting_attended"
  | "form_submission"
  | "sale";

/** One attributed outcome, as the producer serves it. */
export interface StepOutcomeRow {
  /** The matched lead. Present for every row — the set is the attributed one. */
  leadId: string;
  /**
   * The matched lead's canonical email — the SAME join key `converted-lead-emails` returns and the
   * key this service already holds from the lead snapshot. Null for a lead with no email contact
   * method: the producer keeps the row rather than dropping it, so its counts cannot disagree with
   * itself, and a row we cannot join is a row we skip rather than a total we mis-state.
   */
  email: string | null;
  /**
   * The campaign the statement was made on. Null for a tracker-reported outcome — a website pixel
   * knows the brand and nothing about which campaign reached the person, and a guess is worse than
   * a null.
   */
  campaignId: string | null;
  /**
   * When the outcome ACTUALLY happened (a human stating a past fact supplies the date), never when we
   * heard about it. Null only when genuinely undated — never fabricated, so an undated outcome stays
   * in the total and out of the timeline rather than being parked on a plausible day.
   */
  occurredAt: string | null;
  /**
   * What the outcome was worth, in cents. Null means NOBODY SAID — not zero. A stated sale always
   * carries one (the producer refuses a sale with no amount), because realized revenue is the one
   * figure with no excuse to be an average.
   */
  valueCents: number | null;
  /** Whether a human stated it or the website tracker reported it. Frozen at write, never inferred. */
  source: "manual" | "tracker";
  /**
   * WHOSE WIN IT WAS. `true` — the customer states OUR outreach caused it. `false` — they state
   * something else of theirs did (a referral, a conference, their existing pipeline, another agency):
   * the outcome is REAL and stays in every count they read, it is simply not one to compute OUR return
   * on. `null` — NOBODY WAS ASKED, which is every statement made before the field existed and every
   * tracker-reported outcome, because a page-load tag cannot know why somebody bought.
   *
   * Null is never read as either answer — see `lib/outcome-cause.ts`. A producer predating
   * lead-service#511 omits the field entirely, which lands here as the same honest `null`.
   */
  causedByOutreach: boolean | null;
}

function leadServiceConfig(): { url: string; apiKey: string } {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

const headers = (apiKey: string) => ({ "x-api-key": apiKey, "x-service-name": "features-service" });

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/**
 * Every attributed outcome of `event` for the brand, one row per outcome, with its date and its
 * value. Empty when the brand has none — the producer never 404s a brand that simply has nothing.
 */
export async function fetchStepOutcomes(
  brandId: string,
  event: LeadStepOutcome,
): Promise<StepOutcomeRow[]> {
  const { url, apiKey } = leadServiceConfig();
  const params = new URLSearchParams({ event });
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/converted-leads?${params}`,
    { headers: headers(apiKey) },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `lead-service /internal/brands/:brandId/converted-leads failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { outcomes?: unknown };
  if (!Array.isArray(data.outcomes)) {
    throw new Error("lead-service /internal/brands/:brandId/converted-leads returned no outcomes array");
  }

  return data.outcomes.map((raw) => {
    const row = raw as Record<string, unknown>;
    const leadId = nonEmpty(row.leadId);
    if (!leadId) {
      throw new Error("lead-service /internal/brands/:brandId/converted-leads returned an outcome with no leadId");
    }
    const emailRaw = nonEmpty(row.email);
    return {
      leadId,
      email: emailRaw ? emailRaw.trim().toLowerCase() : null,
      campaignId: nonEmpty(row.campaignId),
      occurredAt: nonEmpty(row.occurredAt),
      // `null` is "nobody said" and must survive as null. Anything non-numeric is malformed, not zero.
      valueCents:
        row.valueCents === null || row.valueCents === undefined
          ? null
          : typeof row.valueCents === "number" && Number.isFinite(row.valueCents)
            ? row.valueCents
            : (() => {
                throw new Error(
                  "lead-service /internal/brands/:brandId/converted-leads returned a non-numeric valueCents",
                );
              })(),
      source: row.source === "manual" ? "manual" : "tracker",
      // Absent (a producer predating the field) and explicitly `null` (nobody was asked) are the SAME
      // honest answer, and neither may become `false`: "they say we did not cause it" is a statement a
      // human made, and inventing one would put words in the customer's mouth.
      causedByOutreach: typeof row.causedByOutreach === "boolean" ? row.causedByOutreach : null,
    } satisfies StepOutcomeRow;
  });
}

/**
 * WHO IS DEAD AT WHICH STEP for the brand, keyed by step, as the canonical emails this service joins
 * on. A brand nobody has ruled anyone out for answers with empty sets — which is every brand today,
 * so this read costs nothing and changes nothing until somebody states a first `never`.
 */
export async function fetchStepDisqualifications(
  brandId: string,
): Promise<Map<LeadStepOutcome, Set<string>>> {
  const { url, apiKey } = leadServiceConfig();
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/step-disqualifications`,
    { headers: headers(apiKey) },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `lead-service /internal/brands/:brandId/step-disqualifications failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { byStep?: unknown };
  if (!data.byStep || typeof data.byStep !== "object") {
    throw new Error("lead-service /internal/brands/:brandId/step-disqualifications returned no byStep object");
  }

  const out = new Map<LeadStepOutcome, Set<string>>();
  for (const [step, raw] of Object.entries(data.byStep as Record<string, unknown>)) {
    if (!Array.isArray(raw)) {
      throw new Error("lead-service /internal/brands/:brandId/step-disqualifications returned a non-array step");
    }
    const emails = new Set<string>();
    for (const email of raw) {
      const normalized = nonEmpty(email);
      if (normalized) emails.add(normalized.trim().toLowerCase());
    }
    out.set(step as LeadStepOutcome, emails);
  }
  return out;
}
