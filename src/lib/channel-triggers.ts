/**
 * PROACTIVE OR REACTIVE, AND WHAT TRIGGERS A REACTIVE LEG (owner 2026-10-09).
 *
 * Every leg a channel performs is one of two kinds:
 *  - PROACTIVE: it goes and finds or contacts people on its own budget. It has NO trigger: campaign-service
 *    checks it at every tick against its budget (daily, weekly, monthly) and billing. Cold email, ads.
 *  - REACTIVE: it runs ON DEMAND, and something asks for it. It names exactly ONE trigger from the list below:
 *    a campaign asking for a lead (`lead_requested`: the sourcing channels, pulled by the outbound campaign
 *    that needs someone to contact), or an event on a lead (`positive_reply_received`: AI meeting booking,
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
}

export const CHANNEL_TRIGGER_TYPES: readonly ChannelTriggerType[] = [
  {
    id: "lead_requested",
    label: "Lead requested",
    description: "A campaign needs a new person to contact.",
    icon: "user-focus",
    fromStep: null,
    // lead-service serves a lead the moment an outbound run asks for one (its `lead-serve` run).
    firedBy: "lead-service",
    coded: true,
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
  {
    id: "website_visited",
    label: "Website visit",
    description: "A prospect clicked through to your site.",
    icon: "cursor-click",
    fromStep: "website_visit",
    firedBy: "lead-service",
    coded: false,
  },
  {
    id: "meeting_booked",
    label: "Meeting booked",
    description: "A prospect booked a meeting.",
    icon: "calendar-check",
    fromStep: "meeting_booked",
    firedBy: "lead-service",
    coded: false,
  },
  {
    id: "meeting_attended",
    label: "Meeting attended",
    description: "A booked meeting was held.",
    icon: "handshake",
    fromStep: "meeting_attended",
    firedBy: "lead-service",
    coded: false,
  },
  {
    id: "signed_up",
    label: "Signup",
    description: "A prospect created an account.",
    icon: "user-plus",
    fromStep: "signup",
    firedBy: "lead-service",
    coded: false,
  },
  {
    id: "form_submitted",
    label: "Form submitted",
    description: "A prospect filled in a form.",
    icon: "clipboard-text",
    fromStep: "form_submitted",
    firedBy: "lead-service",
    coded: false,
  },
];

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
