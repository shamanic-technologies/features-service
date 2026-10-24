/**
 * PLATFORM-CALLER-RUN-1024 (owner 2026-10-24): every call to a chat-service PLATFORM route
 * (`/internal/platform-complete|judgments|images|transcriptions`) states whose work it is, exactly ONE of:
 * the caller's own run in `x-run-id` (the spend rides the outcome that run declares), or, when no run stands
 * behind the call by design, a declared support function in the body `support: {kind, reason}` (reported apart,
 * never on an outcome). Both = 400; neither = 400 soon (chat-service `readPlatformCaller`).
 *
 * features-service opens no run of its own: every call it makes is a catalogue / research judgment that produces
 * no outcome occurrence, so each states its support function here. Never forward an inbound request's `x-run-id`
 * to a platform route (another service's run; 2026-10-23 put 3,052 probe runs under newsletter sends).
 * Guard `platform-caller.test.ts` pins each call site's choice and fails on a new one left undecided.
 */

/** chat-service's support functions (byte-equal with its `SUPPORT_FUNCTIONS`, `src/lib/support-marks.ts`). */
export const SUPPORT_FUNCTIONS = [
  "payment_fees",
  "brand_setup",
  "copilot",
  "platform_llm",
  "staff_experiment",
  "product_feature",
  "retired_product",
] as const;

export interface PlatformSupport {
  kind: (typeof SUPPORT_FUNCTIONS)[number];
  reason: string;
}

/** Tactic sweep: tags each workflow / template / LLM dynasty with the tactics it follows (strategies filter on them). */
export const TACTIC_JUDGMENT_SUPPORT: PlatformSupport = {
  kind: "product_feature",
  reason: "features-service tactic sweep: judges whether a catalogue workflow, template or LLM follows a tactic, produces no outcome",
};

/** One-leg resolution: picks the leg a multi-leg workflow keeps (staff-triggered catalogue upkeep). */
export const ONE_LEG_JUDGMENT_SUPPORT: PlatformSupport = {
  kind: "product_feature",
  reason: "features-service one-leg resolution: judges which leg a workflow's template is built for, catalogue upkeep, produces no outcome",
};

/** Research niche study: grades how specific each client's B2B niche is (staff Research page). */
export const NICHE_GRADE_SUPPORT: PlatformSupport = {
  kind: "staff_experiment",
  reason: "features-service Research niche study: grades how specific a client's B2B niche is, staff research, produces no outcome",
};
