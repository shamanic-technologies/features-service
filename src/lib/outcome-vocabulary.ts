/**
 * OUTCOMES AND TRIGGERS ARE TWO CATALOGUES (owner 2026-10-15, standard-vocabulary decision, MUST-HAVE list).
 *
 *  - An OUTCOME is a valued result a person reaches (Lead, Positive reply, Meeting booked, Paid client). Served as
 *    `outcomes[]` beside the legacy `steps[]` (same rows; the KEYS never move, only labels do: `lead_found` reads "Lead").
 *  - A TRIGGER is an entry door of a reactive campaign. Two types:
 *      `outcome`   "⚡ <outcome>": exactly one per outcome, named by the outcome's own label (no name of its own; ⚡ is
 *                  the glyph it is drawn with, never in the name).
 *                  The fact can happen outside our system, so it is CALLABLE (API / MCP / Copilot) through
 *                  campaign-service's one door; our own detectors ring the same door.
 *      `condition` computed by us: an outcome + a delay + "still not" another (`delay`), a source polled (`poll`), an
 *                  integration state (`github_issue_in_prod`). Never callable: we already hold the fact.
 *    Legacy exceptions, PARKED by the owner (C3 / D): the `reported` triggers (`follow_up_due`, `email_pushed_via_api`;
 *    `follow_up_date_reached` was merged into `follow_up_due` 2026-10-16, `TRIGGER_ID_MERGES`) are typed `condition` but stay callable, because a caller reports each occurrence through
 *    the door today (campaign-service, 2026-10-15). The INLINE ones (`on_demand`, `lead_requested`) are never callable.
 *  - A trigger can carry a VALUE: an outcome trigger's is its outcome's (`lib/agent-catalogue.ts` step value).
 *
 * A NEW outcome or trigger is a FEATURE REQUEST built with the backend that fills it (owner C1), never a bare row.
 *
 * Imports nothing: `lib/channel-triggers.ts` (loaded by `lib/acquisition-channels.ts`) reads it at module load.
 */
export type TriggerType = "outcome" | "condition";

/** The kinds a caller reports through the door (`event`: a service detects it; `reported`: a caller states it). */
const DOOR_KINDS: ReadonlySet<string> = new Set(["event", "reported"]);

/** PURE: an OUTCOME trigger is fired the moment a person reaches its step (`kind: event` + a `fromStep`). */
export const triggerTypeOf = (t: { kind?: string | null; fromStep: string | null }): TriggerType =>
  (t.kind ?? "event") === "event" && t.fromStep !== null ? "outcome" : "condition";

/** PURE: the outcome an outcome trigger reports, null on a condition trigger (whose `fromStep` is only its anchor). */
export const triggerOutcomeKeyOf = (t: { kind?: string | null; fromStep: string | null }): string | null =>
  triggerTypeOf(t) === "outcome" ? t.fromStep : null;

/**
 * PURE: may an OUTSIDE caller (API / MCP / Copilot, through campaign-service's public door) fire it? False for what we
 * compute ourselves (`delay`, `poll`, `github_issue_in_prod`) and for an INLINE trigger (`on_demand`, `lead_requested`:
 * one of our services asking another inside a run, never a fact a client holds). Our own services keep the internal
 * door for every declared trigger.
 */
export const isTriggerCallable = (t: { kind?: string | null; inline?: boolean }): boolean => t.inline !== true && DOOR_KINDS.has(t.kind ?? "event");

/** The glyph a trigger is DRAWN with in a text line ("⚡ Positive reply → Meeting booked"); never part of its name (the
 *  dashboard draws its own lightning icon beside the name). */
export const TRIGGER_GLYPH = "⚡";

/** PURE: an outcome trigger's name: its outcome's served label, nothing else ("Lead"). */
export const outcomeTriggerLabel = (outcomeLabel: string): string => outcomeLabel;

const pluralWord = (w: string): string => {
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
};

/**
 * PURE: the plural of an outcome label, for counts ("12 Leads", "3 Meetings booked"). A label ending on a past
 * participle ("Meeting booked", "Form submitted", "Email sent") pluralises its noun, the first word; any other
 * pluralises its last word ("Positive reply" -> "Positive replies", "Paid client" -> "Paid clients").
 */
export function pluralLabelOf(label: string): string {
  const words = label.trim().split(/\s+/);
  if (words.length === 0 || words[0] === "") return label;
  const last = words[words.length - 1];
  const participle = words.length > 1 && (/ed$/i.test(last) || /^(sent|done|won|lost|held|paid|made|seen)$/i.test(last));
  if (participle) return [pluralWord(words[0]), ...words.slice(1)].join(" ");
  return [...words.slice(0, -1), pluralWord(last)].join(" ");
}

/** The fields of a trigger type this module reads and writes (`TriggerTypeRecord`, `lib/channel-declarations.ts`). */
export interface OutcomeTriggerSource {
  id: string;
  label: string;
  description: string;
  icon: string;
  fromStep: string | null;
  firedBy: string;
  coded: boolean;
  origin: "code" | "declared";
  kind: string;
  params: Record<string, unknown> | null;
  displayOrder: number;
  createdBy: string | null;
  requestedByOrgId: string | null;
}

/**
 * PURE: every trigger type plus the OUTCOME trigger of every outcome that has none yet (one per outcome, no
 * exception: owner 2026-10-15). Only an outcome DECLARED at run time can lack one (every coded step states its own in
 * `lib/channel-triggers.ts`); its trigger is generated here, keyed on the outcome's key, named "⚡ <outcome>", fired by
 * nothing of ours (`coded: false`), never stored. Order: the stored ones, then the generated ones in outcome order.
 */
export function withOutcomeTriggers<T extends OutcomeTriggerSource>(
  triggers: readonly T[],
  outcomes: ReadonlyArray<{ key: string; label: string; description: string; icon: string }>,
  make: (generated: OutcomeTriggerSource) => T,
): T[] {
  const covered = new Set(triggers.map(triggerOutcomeKeyOf).filter((k): k is string => k !== null));
  const taken = new Set(triggers.map((t) => t.id));
  const next = triggers.reduce((max, t) => Math.max(max, t.displayOrder), -1) + 1;
  const generated = outcomes
    .filter((o) => !covered.has(o.key) && !taken.has(o.key))
    .map((o, i) =>
      make({
        id: o.key,
        label: outcomeTriggerLabel(o.label),
        description: o.description,
        icon: o.icon,
        fromStep: o.key,
        firedBy: "campaign-service",
        coded: false,
        origin: "declared",
        kind: "event",
        params: null,
        displayOrder: next + i,
        createdBy: null,
        requestedByOrgId: null,
      }),
    );
  return [...triggers, ...generated];
}
