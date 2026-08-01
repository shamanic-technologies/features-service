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
 *   - signup         → cost per self-serve signup (click → signup, visitToSignupPct)
 *   - meetingBooked  → cost per booked meeting (click + reply routes)
 *   - websitePurchase→ cost per paying close via the multi-step self-serve/meeting funnel (RENAMED from
 *                      the former `purchase` goal)
 *   - sales          → COMBINED goal: cost per SALE (paying client, valued at CLTV) won via EITHER the
 *                      visit→paid OR the reply→paid single-step path; population expected-count = the two
 *                      channels ADD, per-lead probability = orP. The outcome IS the paying client.
 *   - websiteVisit   → cost per paid client via the SINGLE-STEP visit→paid rate (visitToPaidClientPct)
 *   - positiveReply  → cost per paid client via the SINGLE-STEP reply→paid rate (replyToPaidClientPct)
 *   - formSubmission → cost per form submission via the TWO-STEP click route (visitToFormSubmissionPct);
 *                      close economics ride visit→form→paid. Visit-driven, the sibling of signup.
 *
 * websiteVisit / positiveReply are SINGLE-STEP goals: the paid-client conversion is one rate applied
 * to the click (visit) or positive-reply population — NOT the multi-step funnels the other goals use.
 * formSubmission is a TWO-STEP self-serve goal (visit → micro-conversion → paid), the sibling of signup.
 * `sales` + `websitePurchase` are FIRST-CLASS Goal members (the whole fleet — including the cross-org
 * public/staff surfaces that iterate GOALS — speaks one vocabulary). During the fleet rename the
 * cross-org response keeps a transitional byte-equal `purchase` alias of `websitePurchase` so the admin
 * dashboard keeps rendering until it migrates.
 *
 * ⚠️ TWO ENTRY POINTS, TWO RESOLVERS — the token `sales` means DIFFERENT things depending on which door
 * it came through, so the resolvers below are split by ENTRY POINT and must never be merged:
 *   - a value on a REQUEST PARAM (`goal` / `objective` / `lens`, sent by the dashboard or
 *     campaign-service) → `matchCombinedSalesGoal` + `matchWebsitePurchaseGoal`: `sales` = the COMBINED
 *     goal, because the dashboard's local enum spells the combined goal `sales`.
 *   - a value in a BRAND-SERVICE PAYLOAD (`salesEconomics.optimizationGoal`, a declared sales funnel's
 *     `goal` / `currentGoal`) → `matchBrandServiceGoal`: `sales` = WEBSITE PURCHASE, brand-service's
 *     older, data-backed meaning, which it documents as unchangeable.
 * Pinned by `goals-entry-points.test.ts`.
 */
export type Goal = "signup" | "meetingBooked" | "websitePurchase" | "sales" | "websiteVisit" | "positiveReply" | "formSubmission" | "whatsappConversation";

export const GOALS: readonly Goal[] = ["signup", "meetingBooked", "websitePurchase", "sales", "websiteVisit", "positiveReply", "formSubmission", "whatsappConversation"] as const;

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

/**
 * The `whatsappConversation` goal — a SINGLE-STEP, CLICK-driven optimization goal where the desired
 * outcome is that a recipient STARTS A WHATSAPP CONVERSATION by clicking the brand's WhatsApp link.
 * Because the WhatsApp link IS the outreach click destination, a click on it IS a started conversation:
 * the goal REUSES the existing click evidence/tracking that backs the website-visit / CPC metrics — it
 * is NOT a new event pipeline or click type. So the outcome cost = cost-per-click (CPC) and the outcome
 * count = clicks, exactly like `websiteVisit`'s OUTCOME metric.
 *
 * Distinct from the `SingleStepGoal` family (`websiteVisit` / `positiveReply`) because brand-service
 * exposes NO whatsapp→paid conversion rate for it — so it carries no paid-client / ROI economics
 * (those read null, null-safe) and must NOT be fed through `singleStepRateDecimal` (which would fail
 * loud on the absent rate). It is a CLICK-outcome goal, nothing more — its cost-per-outcome = CPC,
 * exactly like `websiteVisit`. It is a FIRST-CLASS `Goal` member (one fleet vocabulary — no separate
 * "extended" concept); the cross-org surfaces that iterate `GOALS` treat its outcome cost as CPC and
 * leave its paid-client/ROI figures null.
 *
 * `WhatsappGoal` / `CombinedSalesGoal` / `WebsitePurchaseGoal` are just literal aliases naming the
 * matcher return types below; all three are members of `Goal`.
 */
export type WhatsappGoal = "whatsappConversation";
export type CombinedSalesGoal = "sales";
export type WebsitePurchaseGoal = "websitePurchase";

/**
 * Recognise the `whatsappConversation` goal from ANY of the fleet's spellings — runtime camelCase
 * (`whatsappConversation`, brand-service CurrentGoal + campaign-service currentGoal), stored/dashboard
 * snake_case (`whatsapp_conversations`), kebab, and the human display value ("WhatsApp conversations").
 * Separator- and case-insensitive input tolerance (NOT a silent fallback for missing data). Returns the
 * canonical camelCase `whatsappConversation`, or null when `raw` is not the whatsapp goal.
 */
export function matchWhatsappGoal(raw: string): WhatsappGoal | null {
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "whatsappconversation" || norm === "whatsappconversations" ? "whatsappConversation" : null;
}

/**
 * Recognise the COMBINED-sales goal on a value that arrived on a REQUEST PARAM — the `goal` /
 * `objective` / `lens` a CALLER sends us (dashboard, campaign-service). On that entry point a bare
 * `sales` means the COMBINED goal: the dashboard's own local enum spells the combined goal `sales` and
 * sends it verbatim (`goalForOptimizationGoal("sales") === "sales"`, distribute.you
 * `apps/dashboard/src/lib/strategy-model.ts`). Also accepts `combinedSales` / `combined_sales` /
 * `combined-sales`. Separator- and case-insensitive input tolerance (NOT a silent fallback).
 *
 * ⚠️ ENTRY POINT MATTERS — do NOT use this on a value read out of a BRAND-SERVICE PAYLOAD. There a bare
 * `sales` means WEBSITE PURCHASE (brand-service's older, data-backed meaning; see
 * `matchBrandServiceGoal`). The two meanings arrive through two different doors and must keep two
 * resolvers; collapsing them back into one is the bug this split exists to prevent.
 */
export function matchCombinedSalesGoal(raw: string): CombinedSalesGoal | null {
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "sales" || norm === "combinedsales" ? "sales" : null;
}

/**
 * Recognise the COMBINED-sales goal on a value that arrived in a BRAND-SERVICE PAYLOAD — the twin of
 * `matchCombinedSalesGoal` for the producer entry point. brand-service's wire token for the combined
 * goal is `combined_sales` (its runtime token is `combinedSales`); a bare `sales` on that wire is the
 * LEGACY spelling of website purchase and is deliberately NOT matched here.
 */
export function matchDeclaredCombinedSalesGoal(raw: string): CombinedSalesGoal | null {
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "combinedsales" ? "sales" : null;
}

/**
 * Recognise the "website purchase" goal (the RENAMED former `purchase` goal) from ANY of the fleet's
 * spellings — runtime camelCase (`websitePurchase`), stored/dashboard snake_case (`website_purchase`),
 * kebab, AND the LEGACY `purchase` / `purchases` spellings (campaign-service forwards the brand's
 * `currentGoal`, which may still be the pre-rename `purchase` during the fleet transition). Separator-
 * and case-insensitive input tolerance. Returns the canonical camel `websitePurchase`, or null.
 */
export function matchWebsitePurchaseGoal(raw: string): WebsitePurchaseGoal | null {
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "websitepurchase" || norm === "websitepurchases" || norm === "purchase" || norm === "purchases"
    ? "websitePurchase"
    : null;
}

/**
 * Recognise the website-purchase goal on a value that arrived in a BRAND-SERVICE PAYLOAD — the twin of
 * `matchWebsitePurchaseGoal` for the producer entry point, and the ONLY place a bare `sales` resolves to
 * website purchase. brand-service's internal read collapses the `website_purchase` wire sub-type onto
 * the legacy `sales` token, so that is what every stored purchase-brand reads back as.
 *
 * ⚠️ Never reach for this on a caller's request param — there a bare `sales` means COMBINED sales.
 */
export function matchBrandServiceWebsitePurchaseGoal(raw: string): WebsitePurchaseGoal | null {
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "sales" ? "websitePurchase" : matchWebsitePurchaseGoal(raw);
}

/**
 * Resolve a goal value that arrived in a BRAND-SERVICE PAYLOAD — the ONLY entry point this resolver
 * serves. Two payload fields feed it today: `salesEconomics.optimizationGoal` on
 * `GET /internal/brands/:id/sales-economics` (`fetchBrandSavedEconomicsWithGoal`), and a declared sales
 * funnel's `goal` / `currentGoal` on `GET /internal/brands/:brandId/sales-funnels` (`authorized-goals`).
 *
 * **`sales` FROM BRAND-SERVICE MEANS WEBSITE PURCHASE.** That is brand-service's older, data-backed
 * meaning, and it is documented there as unchangeable: `sales` is the legacy wire spelling of the
 * website-purchase goal, "so it ALWAYS means website-purchase, and can NEVER be re-purposed for the new
 * combined goal (that would silently reinterpret every stored purchase-brand)". Its internal read
 * collapses the wire sub-type, so `website_purchase` brands read back as `sales` — verified live on
 * brand `emailtoolshub.com` (stored `website_purchase`, current goal `purchase`) → `"sales"`. The
 * combined goal has its own brand-new token, `combined_sales` / runtime `combinedSales`, which the old
 * dashboard never sends and which therefore can never collide with a stored purchase row.
 *
 * ⚠️ This is the OPPOSITE of what `sales` means on a REQUEST PARAM, where the dashboard's local enum
 * spells the COMBINED goal `sales` and sends it as the `goal` param. Two entry points, two meanings, two
 * resolvers: caller params go through `matchCombinedSalesGoal`, producer payloads through this one. Do
 * NOT collapse them — an earlier doc comment here asserted the `sales`=purchase mapping "is gone post
 * fleet-rename", which was never true of brand-service, and every website-purchase brand in production
 * was consequently bucketed as combined sales in the fleet cost-per-outcome benchmark.
 *
 * The stored spellings otherwise differ from the runtime `CurrentGoal` — the stored layer pluralises
 * signups and says `booked_meetings` for a booked meeting. Accepts the runtime camel spellings + the
 * legacy `purchase` (→ websitePurchase) for tolerance. Returns null for an unrecognised value (a brand
 * with no recognised goal is excluded from every cost bucket).
 */
export function matchBrandServiceGoal(raw: string): Goal | null {
  const single = matchSingleStepGoal(raw);
  if (single) return single;
  if (matchFormSubmissionGoal(raw)) return "formSubmission";
  // `combined_sales` / `combinedSales` ONLY — a bare `sales` falls through to website purchase below.
  if (matchDeclaredCombinedSalesGoal(raw)) return "sales";
  // incl. the legacy `sales` + `purchase` spellings and the preferred `website_purchase`.
  if (matchBrandServiceWebsitePurchaseGoal(raw)) return "websitePurchase";
  if (matchWhatsappGoal(raw)) return "whatsappConversation";
  switch (raw) {
    case "signups":
    case "signup":
      return "signup";
    case "booked_meetings":
    // `sales_meetings` is the dashboard's local spelling of the SAME goal; brand-service accepts both
    // on write and can echo either on a declared sales funnel, so both must map here.
    case "sales_meetings":
    case "meetingBooked":
      return "meetingBooked";
    default:
      return null;
  }
}
