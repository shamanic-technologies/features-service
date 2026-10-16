/**
 * PROACTIVE OR REACTIVE, AND WHAT TRIGGERS A REACTIVE LEG (owner 2026-10-09).
 *
 * Every leg a channel performs is one of two kinds:
 *  - PROACTIVE: it goes and finds or contacts people on its own budget. It has NO trigger: campaign-service
 *    checks it at every tick against its budget (daily, weekly, monthly) and billing. Cold email, ads.
 *  - REACTIVE: it runs ON DEMAND, and something asks for it. It names exactly ONE trigger from the list below:
 *    another pipe asking for it (`on_demand`; the sourcing channels until 2026-10-12, now PROACTIVE: every pipe is
 *    independent, a source finds leads on its own), or an event on a lead (`positive_reply_received`: AI meeting booking,
 *    the instant call; `meeting_booked`: meeting attendance...).
 *
 * Three separate things, three homes:
 *  1. The TRIGGER TYPES: this list, one row each in `channel_trigger_types` (upserted on boot), published on
 *     `/public/channels` `triggers[]` with a label and an icon. Same for every client. `coded` = a service
 *     fires it today.
 *  2. The TRIGGER EVENTS: one per occurrence (type, lead, org x brand x offer, due time, fired or skipped and
 *     why): campaign-service, the single door that fires them.
 *  3. ON/OFF: per campaign (org x brand x offer x leg x channel), campaign-service's existing switch.
 *
 * GUARANTEE: a leg can only name a trigger on this list (or one declared at run time,
 * `lib/channel-declarations.ts`), and a leg of a channel we RUN (managed) can only name a CODED one.
 * `assertLegTriggersDeclared` runs on boot, in the seed guard test and on every catalogue build; a leg
 * DECLARED at run time is refused at creation on any trigger nothing fires (409 `trigger_not_fired`).
 */
import type { ChannelStepKey } from "./acquisition-channels.js";
import { isTriggerCallable } from "./outcome-vocabulary.js";

export const LEG_MODES = ["proactive", "reactive"] as const;
export type LegMode = (typeof LEG_MODES)[number];

export interface ChannelTriggerType {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** The step a lead reached that fires it; null when it is not a step. */
  fromStep: ChannelStepKey | null;
  /** The service that detects the event and asks campaign-service to run the campaign. */
  firedBy: string;
  /** A service fires it today. A managed channel's leg may only name a coded trigger. */
  coded: boolean;
  /**
   * The pipe answering it runs INSIDE the run that fires it (a source answering the lead request of the outreach run
   * that needs the lead): it draws on no budget of its own, so it never makes a funnel "mixed". Absent = false.
   */
  inline?: boolean;
  /**
   * How it fires (`lib/channel-declarations.ts` kinds). Absent = `event` (a service detects it on a lead and rings
   * campaign-service). `reported` = a CALLER reports each occurrence to campaign-service's trigger-events record route.
   */
  kind?: "event" | "reported" | "github_issue_in_prod" | "any_of";
}

/**
 * Every trigger has a UNIQUE slug (`id`) AND a unique NAME (`label`, case-insensitive; owner 2026-10-11): a reactive
 * sales path or funnel STARTS with its trigger, shown by name ("Positive reply", drawn with the ⚡ trigger glyph), so two triggers may never read
 * alike. Enforced by the unique index `channel_trigger_types_label_lower_unique` (migration 0026) and refused on
 * create / rename (409 `trigger_name_taken`, `lib/channel-declarations.ts`).
 *
 * An OUTCOME trigger (`lib/outcome-vocabulary.ts`, owner 2026-10-15) has no name of its own: its outcome's served
 * label, one per outcome (guard `outcome-vocabulary.test.ts`); "⚡" is the glyph a trigger is drawn with, never part of
 * its name. A condition trigger keeps its own Title Case name.
 */
export const CHANNEL_TRIGGER_TYPES: readonly ChannelTriggerType[] = [
  {
    // ON DEMAND (owner 2026-10-11: "ça ne changera rien si le pipe a un trigger de type 'on demand' -> only exécuté
    // quand par ex le pipe cold email l'appelle"): the pipe runs only when another pipe asks for it, at that instant,
    // as its OWN unit run (campaign-service `POST /internal/on-demand-runs`: own run id, campaign, workflow, costs).
    // The sourcing channels answer it: lead-service serves the lead a cold email run asks for under the source unit's
    // run. Any future pipe that only runs when asked names it too.
    id: "on_demand",
    label: "On Demand",
    description: "Runs only when another step asks for it.",
    icon: "hand-tap",
    fromStep: null,
    firedBy: "campaign-service",
    coded: true,
    inline: true,
  },
  {
    // The sourcing channels' trigger until 2026-10-11 (now `on_demand`). Kept declared: its recorded events stay
    // readable (campaign-service anchors `lead_found` on them), and no leg names it.
    id: "lead_requested",
    label: "Lead Requested",
    description: "A campaign needs a new person to contact.",
    icon: "user-focus",
    fromStep: null,
    firedBy: "lead-service",
    coded: true,
    inline: true,
  },
  {
    id: "positive_reply_received",
    label: "Positive reply",
    description: "A prospect replied with interest.",
    icon: "thumbs-up",
    fromStep: "conversation",
    // instantly-service asks campaign-service to run the legs out of it (`trigger-for-step`).
    firedBy: "instantly-service",
    coded: true,
  },
  // FIRED by lead-service (EVERY-OUTCOME-FIRES-1015, STD-VOCAB-1016: "every outcome reached fires its trigger, no
  // exception"): its outcome detector rings campaign-service's door once per person for every outcome its records
  // show (a serve's find, a CRM fact, a stated or tracked outcome, an AI Instant Call act; a sale the site's tag
  // reported = Direct purchase), the same door an outside caller uses, one fire per person whoever rings.
  {
    id: "website_visited",
    label: "Website visit",
    description: "A prospect clicked through to your site.",
    icon: "cursor-click",
    fromStep: "website_visit",
    firedBy: "lead-service",
    coded: true,
  },
  {
    id: "booking_call_started",
    label: "Booking call",
    description: "A prospect was put on a call with your sales rep.",
    icon: "phone-call",
    fromStep: "booking_call",
    firedBy: "lead-service",
    coded: true,
  },
  {
    id: "meeting_booked",
    label: "Meeting booked",
    description: "A prospect booked a meeting.",
    icon: "calendar-check",
    fromStep: "meeting_booked",
    firedBy: "lead-service",
    coded: true,
  },
  {
    id: "meeting_attended",
    label: "Meeting attended",
    description: "A booked meeting was held.",
    icon: "handshake",
    fromStep: "meeting_attended",
    firedBy: "lead-service",
    coded: true,
  },
  {
    id: "signed_up",
    label: "Signup",
    description: "A prospect created an account.",
    icon: "user-plus",
    fromStep: "signup",
    firedBy: "lead-service",
    coded: true,
  },
  {
    // FIRED by crm-service (owner 2026-10-12, FORM-SUBMITTED-TRIGGER-1012, Doc Dinners' "AI auto responder"): each NEW
    // form submission in a brand's connected CRM (GoHighLevel today, any CRM later) is reported to campaign-service's
    // generic trigger door naming the person and what they asked, so a reactive pipe out of `form_submitted` (AI
    // meeting booking's `form_submitted_to_meeting_booked`) answers within minutes. A calendar's own booking form is
    // the booking, never this trigger.
    id: "form_submitted",
    label: "Form submitted",
    description: "A prospect filled in a form.",
    icon: "clipboard-text",
    fromStep: "form_submitted",
    firedBy: "crm-service",
    coded: true,
  },
  {
    id: "purchase_made",
    label: "Direct purchase",
    description: "A prospect bought on your site.",
    icon: "shopping-cart",
    fromStep: "purchase",
    firedBy: "lead-service",
    coded: true,
  },
  {
    // OUTCOME TRIGGERS of the two outcomes that had none (owner 2026-10-15: one trigger per outcome, no exception).
    // A caller (API / MCP / Copilot) reports the fact through campaign-service's door; lead-service rings the same door.
    id: "lead_found",
    label: "Lead",
    description: "A person matching your target was found.",
    icon: "identification-card",
    fromStep: "lead_found",
    firedBy: "lead-service",
    coded: true,
  },
  {
    id: "paid_client",
    label: "Paid client",
    description: "A prospect became a paying client.",
    icon: "currency-dollar",
    fromStep: "paid_client",
    firedBy: "lead-service",
    coded: true,
  },
  {
    // REPORTED BY A CALLER (owner 2026-10-11, the Copilot follow-up): a follow-up someone planned for ONE person is
    // due. Whoever knows it is due (the Copilot, staff) reports it to campaign-service's trigger-events record route
    // with the person's lead id; campaign-service fires the live campaigns whose pipe names it, which act for that
    // person and carry the instruction of what to write. The generic one: a precise condition is its own declared
    // `reported` trigger (`src/routes/CLAUDE.md`, "Copilot follow-up").
    id: "follow_up_due",
    label: "Follow-up Due",
    description: "A follow-up planned for one person is due.",
    icon: "bell-ringing",
    fromStep: null,
    firedBy: "campaign-service",
    coded: true,
    kind: "reported",
  },
  {
    // A GITHUB ISSUE REACHED PRODUCTION (owner 2026-10-12: "un nouveau type de trigger qui se déclenche quand une issue
    // GitHub est en prod"). The Copilot gives an estimate when no endpoint serves the exact figure, files a GitHub issue
    // on the repo that must build it, and starts a campaign that waits on THAT issue. Which issue (repo + number) is a
    // per-campaign fact stated at campaign-service, never a parameter here: one general type, every campaign its own
    // issue. campaign-service's in-process detector (same loop as `delay` / `poll`) selects it by its kind and fires the
    // campaigns whose issue is live. Any channel's reactive leg may name it.
    id: "github_issue_in_prod",
    label: "GitHub Issue In Prod",
    description: "A GitHub issue this campaign waits on reached production.",
    icon: "github-logo",
    fromStep: null,
    firedBy: "campaign-service",
    coded: true,
    kind: "github_issue_in_prod",
  },
  {
    // ANY FACT ABOUT A PERSON (owner 2026-10-16, LEAD-EVENT-TRIGGER-1016: "je les veux tous, et c'est le channel followup
    // qui jugera s'il faut écrire ou pas"): ONE trigger instead of one reactive campaign per fact. Whenever any member
    // fires for a person (a positive reply, a visit, a signup, a computed condition...), campaign-service records ONE
    // occurrence of this trigger for that person, keeping which member it was, and fires the campaigns starting on it.
    // Who is worth acting on is the pipe's tactic/strategy, never this trigger. Its members are DATA served on every
    // trigger list (`params.memberTriggerIds`, `withAnyOfMembers`): every fact trigger, so a fact declared later joins
    // by itself. Computed from its members: never fired by an outside caller (`callable` false), still listed so a
    // funnel can be headed by it.
    id: "lead_event",
    label: "Lead event",
    description: "Anything happens with a person: a reply, a visit, a signup, a meeting, a payment.",
    icon: "pulse",
    fromStep: null,
    firedBy: "campaign-service",
    coded: true,
    kind: "any_of",
  },
];

/**
 * NOT A FACT ABOUT A PERSON (owner 2026-10-16, LEAD-EVENT-TRIGGER-1016): the triggers an `any_of` trigger never takes as
 * members. Our OWN actions (`lead_found`: we found them; `email_sent`: we wrote; `email_pushed_via_api`: a client asked
 * us to write) and our internal requests (`follow_up_due`, `github_issue_in_prod`; the inline `on_demand` /
 * `lead_requested` are out by `isEntryDoor`). Closed: a fact trigger declared later is a member with no code.
 */
export const NOT_A_LEAD_FACT_TRIGGER_IDS: ReadonlySet<string> = new Set([
  "lead_found",
  "email_sent",
  "email_pushed_via_api",
  "follow_up_due",
  "follow_up_date_reached",
  "github_issue_in_prod",
]);

/** PURE: the members of an `any_of` trigger among `triggers`: every canonical entry door that is a fact about a person
 *  (not in `NOT_A_LEAD_FACT_TRIGGER_IDS`, never another `any_of`), in the list's order. */
export function anyOfMemberIds(triggers: ReadonlyArray<{ id: string; kind?: string | null }>): string[] {
  return triggers
    .filter((t) => (t.kind ?? "event") !== "any_of" && canonicalTriggerId(t.id) === t.id && isEntryDoor(t) && !NOT_A_LEAD_FACT_TRIGGER_IDS.has(t.id))
    .map((t) => t.id);
}

/** PURE: `triggers` with every `any_of` trigger's `params` = `{memberTriggerIds}` (`anyOfMemberIds`), what
 *  campaign-service reads to record one occurrence of it per member occurrence. Every other row unchanged. */
export function withAnyOfMembers<T extends { id: string; kind?: string | null; params?: Record<string, unknown> | null }>(triggers: readonly T[]): T[] {
  const members = anyOfMemberIds(triggers);
  return triggers.map((t) => (t.kind === "any_of" ? { ...t, params: { memberTriggerIds: members } } : t));
}

/**
 * ONE TRIGGER PER FACT (owner 2026-10-16, STD-VOCAB-CONDITION-1016): a trigger id MERGED into another. Keys are frozen
 * (only labels move), so a merged id keeps RESOLVING forever, to the one trigger every read serves:
 *  - `follow_up_date_reached` (declared 2026-10-14, reported by workflow-service's prospect follow-up after each send)
 *    said the same fact as `follow_up_due` ("a follow-up planned for one person is due", the Copilot's): one trigger.
 * Served: a pipe naming a merged id is served on its target (`listDeclaredLegs`), the trigger lists serve only the
 * target, and `/public/channels` `triggerAliases[]` publishes this table so campaign-service records and fires an
 * occurrence reported under the old id as the target (its pending occurrences included). A merged id is never declared
 * again (`parseTriggerInput`). Same kind of table as the LOCKED outbound leg rename (`lib/funnel-legs.ts`).
 */
export const TRIGGER_ID_MERGES: Readonly<Record<string, string>> = {
  follow_up_date_reached: "follow_up_due",
};

/** PURE: the trigger id every read serves for `id` (itself unless merged into another). */
export const canonicalTriggerId = (id: string): string => TRIGGER_ID_MERGES[id] ?? id;

/** The merged ids, as `/public/channels` serves them. */
export const TRIGGER_ALIASES: ReadonlyArray<{ id: string; mergedInto: string }> = Object.entries(TRIGGER_ID_MERGES).map(([id, mergedInto]) => ({ id, mergedInto }));

const BY_ID: ReadonlyMap<string, ChannelTriggerType> = new Map(CHANNEL_TRIGGER_TYPES.map((t) => [t.id, t]));
const BY_FROM_STEP: ReadonlyMap<ChannelStepKey, ChannelTriggerType> = new Map(
  CHANNEL_TRIGGER_TYPES.filter((t) => t.fromStep !== null).map((t) => [t.fromStep as ChannelStepKey, t]),
);

export const channelTriggerType = (id: string): ChannelTriggerType | null => BY_ID.get(id) ?? null;

/** The trigger fired when a lead reaches `step`, or null when no trigger is declared for that step. */
export const triggerForStep = (step: ChannelStepKey): ChannelTriggerType | null => BY_FROM_STEP.get(step) ?? null;

/** What one leg states about how it runs. `triggerId` is null exactly on a proactive leg. */
export interface LegRunStatement {
  mode: LegMode;
  triggerId: string | null;
}

export class UndeclaredLegTriggerError extends Error {
  constructor(detail: string) {
    super(`A channel leg names a trigger that cannot fire it: ${detail}`);
    this.name = "UndeclaredLegTriggerError";
  }
}

/**
 * FAIL LOUD when a leg's statement cannot run: a reactive leg with no trigger or an unknown one, a proactive
 * leg carrying one, or a leg of a channel we RUN on a trigger nothing fires yet.
 */
export function assertLegTriggersDeclared(
  legs: ReadonlyArray<{ slug: string; legKey: string; managed: boolean } & LegRunStatement>,
  // The coded list, plus (on a catalogue build that merges run-time declarations) the declared trigger types.
  triggerOf: (id: string) => Pick<ChannelTriggerType, "coded"> | null = channelTriggerType,
): void {
  for (const leg of legs) {
    const where = `${leg.slug} ${leg.legKey}`;
    if (leg.mode === "proactive") {
      if (leg.triggerId !== null) throw new UndeclaredLegTriggerError(`${where} is proactive and names ${leg.triggerId}`);
      continue;
    }
    if (leg.triggerId === null) throw new UndeclaredLegTriggerError(`${where} is reactive and names no trigger`);
    const type = triggerOf(leg.triggerId);
    if (!type) throw new UndeclaredLegTriggerError(`${where} names unknown trigger ${leg.triggerId}`);
    if (leg.managed && !type.coded) throw new UndeclaredLegTriggerError(`${where} is run by us and names ${leg.triggerId}, which nothing fires yet`);
  }
}

/** The triggers answered INSIDE the run that fires them (`ChannelTriggerType.inline`). */
export const INLINE_TRIGGER_IDS: ReadonlySet<string> = new Set(CHANNEL_TRIGGER_TYPES.filter((t) => t.inline === true).map((t) => t.id));

/** Whether an outside caller may fire this trigger type (`isTriggerCallable`, `lib/outcome-vocabulary.ts`): one rule
 *  for every read serving `callable`, the inline flag read off the coded list. */
export const triggerCallable = (t: { id: string; kind?: string | null; fromStep: string | null }): boolean =>
  isTriggerCallable({ id: t.id, kind: t.kind, fromStep: t.fromStep, inline: INLINE_TRIGGER_IDS.has(t.id) });

/**
 * An ENTRY DOOR (owner 2026-10-15/16, standard vocabulary): a trigger a reactive campaign is offered on. Every trigger
 * but the INLINE ones (`on_demand`, `lead_requested`: one of our services asking another inside a run). Every LIST of
 * triggers an outside reader or the Copilot gets (`/public/channels` `triggers[]`, `/internal/catalogue/triggers`,
 * `/internal/declarations/trigger-types`) serves entry doors only; `?includeInline=true` adds the inline ones for our
 * own services (campaign-service's door validates every declared trigger). A read BY ID always answers, and every
 * pipe or funnel naming an inline trigger keeps working.
 */
export const isEntryDoor = (t: { id: string }): boolean => !INLINE_TRIGGER_IDS.has(t.id);

/** `?includeInline=` on a trigger list: absent or `false` = entry doors only, `true` = every declared trigger. */
export class IncludeInlineQueryError extends Error {
  readonly reason = "include_inline_unrecognised";
}

export function includeInlineOf(raw: unknown): boolean {
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new IncludeInlineQueryError("includeInline must be true or false");
}
