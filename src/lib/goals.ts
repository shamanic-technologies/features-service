/**
 * Goal vocabulary — the optimization targets a campaign budget can pursue (e.g. $/signup).
 *
 * OWNERSHIP: the canonical Goal enum belongs to brand-service — a brand declares which goals it
 * pursues. brand-service has not yet built the goals entity (verified: no goals endpoint on
 * staging), so feature-service mirrors a minimal local enum here. This matches the existing
 * convention in this repo: SalesEconomics is likewise re-declared locally rather than imported
 * from a shared package (there is no shared-contract package wired into features-service today).
 *
 * When brand-service ships goals, swap this for the brand-service-owned type. Whether that means
 * publishing a shared npm package or mirroring (as with SalesEconomics) is a fleet-wide infra
 * decision tracked alongside the persona/brand-profile write-side blockers in features-service#298.
 *
 * Each goal maps to ONE projected cost-per-outcome the funnel can already compute from a brand's
 * effective sales-economics:
 *   - signup        → cost per self-serve signup (click → signup, visitToSignupPct)
 *   - meetingBooked → cost per booked meeting (click + reply routes)
 *   - purchase      → cost per paying close (full funnel)
 */
export type Goal = "signup" | "meetingBooked" | "purchase";

export const GOALS: readonly Goal[] = ["signup", "meetingBooked", "purchase"] as const;

export const isGoal = (value: unknown): value is Goal =>
  typeof value === "string" && (GOALS as readonly string[]).includes(value);
