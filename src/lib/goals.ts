/**
 * Goal vocabulary — the optimization targets a campaign budget can pursue (e.g. $/signup).
 *
 * OWNERSHIP: the canonical Goal enum belongs to brand-service — a brand declares which goals it
 * pursues. This mirrors brand-service's runtime `CurrentGoal` — the vocabulary brand-service
 * explicitly documents as "the vocabulary features-service accepts as runtime candidate-selection
 * input" (schemas.ts `CurrentGoalSchema`). campaign-service reads the brand's `currentGoal` from
 * brand-service `/internal/brands/:id/runtime-context` and forwards it verbatim as the `goal` param.
 * SalesEconomics is likewise re-declared locally rather than imported from a shared package (there
 * is no shared-contract package wired into features-service today).
 *
 * When brand-service ships a shared goals package, swap this for the brand-service-owned type.
 *
 * Each goal maps to ONE projected cost-per-outcome the funnel can already compute from a brand's
 * effective sales-economics:
 *   - signup        → cost per self-serve signup (click → signup, visitToSignupPct)
 *   - meetingBooked → cost per booked meeting (click + reply routes)
 *   - purchase      → cost per paying close (full funnel)
 *   - websiteVisit  → cost per paid client via the SINGLE-STEP visit→paid rate (visitToPaidClientPct)
 *   - positiveReply → cost per paid client via the SINGLE-STEP reply→paid rate (replyToPaidClientPct)
 *   - formSubmission→ cost per form submission via the TWO-STEP click route (visitToFormSubmissionPct);
 *                     close economics ride visit→form→paid. Visit-driven, the sibling of signup.
 *
 * websiteVisit / positiveReply are SINGLE-STEP goals: the paid-client conversion is one rate applied
 * to the click (visit) or positive-reply population — NOT the multi-step funnels the other goals use.
 * formSubmission is a TWO-STEP self-serve goal (visit → micro-conversion → paid), the sibling of signup.
 */
export type Goal = "signup" | "meetingBooked" | "purchase" | "websiteVisit" | "positiveReply" | "formSubmission";

export const GOALS: readonly Goal[] = ["signup", "meetingBooked", "purchase", "websiteVisit", "positiveReply", "formSubmission"] as const;

export const isGoal = (value: unknown): value is Goal =>
  typeof value === "string" && (GOALS as readonly string[]).includes(value);

/** The two SINGLE-STEP goals (visit→paid / reply→paid). */
export type SingleStepGoal = "websiteVisit" | "positiveReply";

/**
 * Recognise a single-step goal from ANY of the vocabularies the fleet uses for it — the runtime
 * camelCase (`websiteVisit`, brand-service CurrentGoal + campaign-service currentGoal), the stored /
 * dashboard snake_case (`website_visits` / `positive_replies`, brand-service OptimizationGoal, read
 * verbatim off `salesEconomics.optimizationGoal`), and the kebab spelling the workflow-projection
 * `objective` / revenue `lens` params style favours. Returns the canonical camelCase SingleStepGoal,
 * or null when `raw` is not a single-step goal (existing goals fall through to their own validators).
 *
 * This is input tolerance across the fleet's three real spellings — NOT a silent fallback for
 * missing data. A genuinely-absent rate field still fails loud at compute time (see funnel-registry).
 */
export function matchSingleStepGoal(raw: string): SingleStepGoal | null {
  switch (raw) {
    case "websiteVisit":
    case "website_visits":
    case "website-visits":
      return "websiteVisit";
    case "positiveReply":
    case "positive_replies":
    case "positive-replies":
      return "positiveReply";
    default:
      return null;
  }
}

/**
 * Recognise the TWO-STEP `formSubmission` goal from ANY of the fleet's spellings — runtime camelCase
 * (`formSubmission`, brand-service CurrentGoal + campaign-service currentGoal), stored/dashboard
 * snake_case (`form_submissions`, brand-service OptimizationGoal), and the kebab spelling. Returns the
 * canonical camelCase `formSubmission`, or null when `raw` is not the form-submission goal. Same input
 * tolerance as matchSingleStepGoal — NOT a silent fallback for missing data.
 */
export function matchFormSubmissionGoal(raw: string): "formSubmission" | null {
  switch (raw) {
    case "formSubmission":
    case "form_submissions":
    case "form-submissions":
      return "formSubmission";
    default:
      return null;
  }
}
