/**
 * ONE absolute LIFECYCLE LADDER (owner 2026-10-17, LIFECYCLE-LADDER-1017): where every catalogue step stands, the
 * same for every campaign, sales funnel, brand and channel. lead-service shows each lead's Lifecycle = the highest
 * rung of any step they ever reached, read from the catalogue step reads (`lifecycleRung` / `lifecycleRank`).
 *
 *   Lead found < Contacted < Engaged < Signed up < Meeting booked < Meeting attended < Paid client
 *
 * "Engaged" groups the interest signals nobody can order between themselves (post engaged, positive reply, website
 * visit); Signup and Form submitted share one rung. A step on no rung (purely technical) states `none`. EVERY step's rung,
 * coded or declared, is DATA in the catalogue table `outcome_lifecycle_rungs` (OUTCOME-RUNG-AND-TARGET-1106,
 * `lib/outcome-rungs-store.ts`), never a map in code; this file holds the ladder itself.
 * No per-campaign / per-brand / per-channel ladder: there is exactly one.
 */
export const LIFECYCLE_RUNGS = [
  { key: "lead_found", rank: 1, label: "Lead found" },
  { key: "contacted", rank: 2, label: "Contacted" },
  { key: "engaged", rank: 3, label: "Engaged" },
  { key: "signup_or_form", rank: 4, label: "Signed up" },
  { key: "meeting_booked", rank: 5, label: "Meeting booked" },
  { key: "meeting_attended", rank: 6, label: "Meeting attended" },
  { key: "paid_client", rank: 7, label: "Paid client" },
] as const;

export type LifecycleRungKey = (typeof LIFECYCLE_RUNGS)[number]["key"];
/** What a step states: a rung, or `none` (on no rung, said explicitly). */
export type StepLifecycleRung = LifecycleRungKey | "none";

export const LIFECYCLE_RUNG_VALUES: readonly StepLifecycleRung[] = [...LIFECYCLE_RUNGS.map((r) => r.key), "none"];

export const isStepLifecycleRung = (v: unknown): v is StepLifecycleRung => typeof v === "string" && (LIFECYCLE_RUNG_VALUES as readonly string[]).includes(v);

/** The rank of a rung (1 = lowest); null for `none` or an unstated rung. */
export const lifecycleRankOf = (rung: StepLifecycleRung | null): number | null =>
  rung === null || rung === "none" ? null : (LIFECYCLE_RUNGS.find((r) => r.key === rung)?.rank ?? null);

/** The ladder as served beside every step list. */
export const servedLifecycleLadder = () => LIFECYCLE_RUNGS.map((r) => ({ key: r.key, rank: r.rank, label: r.label }));
