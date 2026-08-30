/**
 * HOW MUCH OF A PERSON A `/revenue` READ CARRIES — `?leads=outcomes` (the default) or `?leads=full`.
 *
 * A `/revenue` body answers a question about MONEY, and it was 99.6% people. Measured in prod on
 * 2026-08-31 for brand `75d7e3e8-…`: the brand read answered **10,903,573 bytes**, of which
 * **10,860,781** were `leads[]` — 9,854 rows, each fully hydrated with a name, a photo, an org, a
 * logo, tags, seniority, industry, headcount and every timestamp. Everything the read exists to say —
 * the headline, the economics, the spend block, every count series, the ROI history, the funnel walk,
 * the organisations, the events, the channels — was **43KB combined**.
 *
 * The consumer cost was not a slow page, it was NO page: the dashboard's persisted query cache refuses
 * a snapshot over 2MB, so the four money keys were never written to disk and every stat card, the
 * return-on-spend chart and the cost card cold-skeletoned on EVERY load of every brand, offer, funnel
 * and campaign page.
 *
 * ── THE TWO ANSWERS, AND WHY THERE ARE EXACTLY TWO ──────────────────────────────────────────────
 *
 * **`outcomes` (DEFAULT)** — the twelve fields a BROWSER surface can read (a lead's id, the seven
 * outcome flags, and the four realized-outcome timestamps), on the rows that REACHED something. Every
 * browser consumer builds the same thing out of this array — a `leadId → outcome` map — and a lead
 * with every flag false and every date null is looked up in that map and found absent either way. On
 * the measured brand that is 72 rows of 9,854: **19,720 bytes instead of 10,860,781**.
 *
 * **`full`** — every row, fully hydrated: today's array, byte for byte. Exactly one consumer needs it
 * (the dashboard's nightly outcome-digest cron, which NAMES each person and what they did on the day),
 * it runs server-side on its own schedule, and it asks for it explicitly.
 *
 * A `false` flag is deliberately NOT an outcome: it is this service saying "measured, did not happen",
 * which is precisely the row worth dropping. What is NOT dropped is the STATEMENT that the outcome is
 * measured at all — see `attributedOutcomes` on the body, which is why narrowing the array does not
 * take a Leads-page tab away from a brand whose tracker is live and whose signups are still zero.
 *
 * NOT A PAGE, on purpose. The digest wants the whole set and the browser wants a filtered subset;
 * neither is a page, and a `?limit=`/`?cursor=` pair would answer neither question.
 *
 * ── THE DEFAULT MOVED, AND THE OLD DEFAULT FAILS LOUD ───────────────────────────────────────────
 *
 * A read that names nothing gets `outcomes`, because a money surface that has to opt IN to a lean body
 * is a money surface that ships fat. The digest's own parse REQUIRES the hydrated fields (`firstName`,
 * `photoUrl`, `orgName`, `tags`, `expectedRevenueUsd`, …), so a narrowed row does not degrade its
 * output — it fails its schema, loudly, which is the honest answer and the opposite of reporting
 * "nothing landed" for every brand on the platform.
 */

import type { LeadRow } from "./revenue-engine.js";
import type { StepEvidence } from "./funnel-steps.js";

export const LEAD_DETAIL_VALUES = ["outcomes", "full"] as const;
export type LeadDetail = (typeof LEAD_DETAIL_VALUES)[number];

/**
 * Parse `?leads=`. Absent / empty → `"outcomes"` (the default). An unrecognised word is `null` → the
 * caller 400s: silently serving one shape to a caller that asked for the other is exactly the
 * misunderstanding this parameter exists to remove.
 */
export function parseLeadDetail(raw: unknown): LeadDetail | null {
  if (raw === undefined || raw === null || raw === "") return "outcomes";
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return "outcomes";
  return (LEAD_DETAIL_VALUES as readonly string[]).includes(value) ? (value as LeadDetail) : null;
}

/**
 * THE SEVEN OUTCOME FLAGS a browser surface reads — the four a human (or the tracker) states, plus
 * the three the delivery layer measures. `clicked` and `repliedPositive` ride the core lead read;
 * the rest ride an overlay that can be absent, which is what `attributedOutcomes` states.
 */
export const LEAD_OUTCOME_FLAGS = [
  "clicked",
  "repliedPositive",
  "meetingBooked",
  "meetingAttended",
  "signup",
  "formSubmission",
  "purchased",
] as const;
export type LeadOutcomeFlag = (typeof LEAD_OUTCOME_FLAGS)[number];

/** The four realized-outcome timestamps. `clickedAt` / `repliedPositiveAt` are engagement dates the
 *  count series already carry as a server-computed series, so no browser surface reads them per lead. */
export const LEAD_OUTCOME_DATES = [
  "signupAt",
  "meetingBookedAt",
  "formSubmissionAt",
  "purchasedAt",
] as const;
export type LeadOutcomeDate = (typeof LEAD_OUTCOME_DATES)[number];

/** One narrowed lead row: its id, the seven flags, the four dates — and nothing else. */
export type LeadOutcomeRow = { leadId: string } & Record<LeadOutcomeFlag, boolean> &
  Record<LeadOutcomeDate, string | null> & {
    /** Lens-only, carried through when present: a `?lens=` read prices each lead and the figure is
     *  the whole point of that read. Absent on every un-lensed body, exactly as on the full row. */
    conversionProbabilityPct?: number;
  };

/**
 * Has this lead reached ANYTHING? True when any of the seven flags is true, or any of the four dates
 * is known. A row for which this is false says nothing a consumer can act on.
 */
export function leadReachedSomething(lead: LeadRow): boolean {
  for (const flag of LEAD_OUTCOME_FLAGS) if (lead[flag] === true) return true;
  for (const date of LEAD_OUTCOME_DATES) if (lead[date] != null) return true;
  return false;
}

/** Narrow the array: drop every row that reached nothing, and keep only the twelve fields on the rest. */
export function projectLeadOutcomes(leads: readonly LeadRow[]): LeadOutcomeRow[] {
  const rows: LeadOutcomeRow[] = [];
  for (const lead of leads) {
    if (!leadReachedSomething(lead)) continue;
    const row = {
      leadId: lead.leadId,
      clicked: lead.clicked,
      repliedPositive: lead.repliedPositive,
      meetingBooked: lead.meetingBooked,
      meetingAttended: lead.meetingAttended,
      signup: lead.signup,
      formSubmission: lead.formSubmission,
      purchased: lead.purchased,
      signupAt: lead.signupAt,
      meetingBookedAt: lead.meetingBookedAt,
      formSubmissionAt: lead.formSubmissionAt,
      purchasedAt: lead.purchasedAt,
    } as LeadOutcomeRow;
    if (lead.conversionProbabilityPct !== undefined) row.conversionProbabilityPct = lead.conversionProbabilityPct;
    rows.push(row);
  }
  return rows;
}

/**
 * Apply the requested detail to a body's `leads[]`. `full` returns the body UNTOUCHED — byte for byte
 * what this service has always served — so the digest's read is unchanged by this parameter existing.
 *
 * Applied INSIDE the cached compute, with the detail in the scope key, so the stored snapshot is the
 * narrow one too: a jsonb cell holding 10.9MB of people is the same waste one layer down.
 */
export function applyLeadDetail<T extends { leads: LeadRow[] }>(
  body: T,
  detail: LeadDetail,
): T | (Omit<T, "leads"> & { leads: LeadOutcomeRow[] }) {
  if (detail === "full") return body;
  return { ...body, leads: projectLeadOutcomes(body.leads) };
}

/**
 * WHICH OUTCOMES THIS READ COULD ATTRIBUTE — a fact about the READ, never about the leads.
 *
 * The Leads page shows an outcome tab only once this service attributes that outcome, and it used to
 * answer that by asking whether ANY lead row carried the key. That question dies the moment the array
 * narrows: a brand with a live tracker and zero signups serves zero outcome-carrying rows, so the
 * derivation would say "signup is not attributed" and silently take a tab away from a brand that is
 * measuring signups perfectly well. "This outcome is attributed, nobody has reached it yet" and "this
 * outcome is not measured here" are different statements, and only the producer can tell them apart.
 *
 * So it is SERVED, and it is derived from the same {@link StepEvidence} the funnel walk reports its
 * rungs on — one implementation, so a rung that reads `null` and a tab that hides can never disagree
 * about which producer degraded. `clicked` / `repliedPositive` ride the core lead read (fail-loud), so
 * they are attributed wherever the leads were read at all.
 */
export function attributedOutcomesFor(evidence: StepEvidence): LeadOutcomeFlag[] {
  const attributed: LeadOutcomeFlag[] = ["clicked", "repliedPositive"];
  // Booked and closed have TWO producers — the human's step statements and the LEGACY instantly
  // qualifications — and either alone is a real answer, matching the overlay's own COALESCE.
  if (evidence.observedSteps || evidence.legacyQualifications) attributed.push("meetingBooked", "purchased");
  // Attended has only the statements: nothing else in the fleet can observe somebody showing up.
  if (evidence.observedSteps) attributed.push("meetingAttended");
  if (evidence.signupAttribution) attributed.push("signup");
  if (evidence.formSubmissionAttribution) attributed.push("formSubmission");
  return attributed.sort(
    (a, b) => LEAD_OUTCOME_FLAGS.indexOf(a) - LEAD_OUTCOME_FLAGS.indexOf(b),
  );
}

/** The two the core lead read alone evidences — every path that reads leads without any overlay. */
export const DELIVERY_ATTRIBUTED_OUTCOMES: LeadOutcomeFlag[] = ["clicked", "repliedPositive"];
