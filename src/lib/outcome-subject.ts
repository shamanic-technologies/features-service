/**
 * WHAT AN OUTCOME IS ABOUT (owner 2026-10-23, COST-ACCOUNTING-1023; doctrine: agent-config skill `cost-accounting`).
 * Every outcome (catalogue step) states the kind of subject one occurrence of it is about: a `person` (Lead found,
 * Email checked, Positive reply...) or an `object` (Audience built, Post published, Creative made...). It is the one
 * fact the cost ledger needs per outcome: an occurrence is (outcome, subject id), held by the service that owns it.
 * Pure.
 */
import type { ChannelStepKey } from "./acquisition-channels.js";

export const OUTCOME_SUBJECT_KINDS = ["person", "object"] as const;
export type OutcomeSubjectKind = (typeof OUTCOME_SUBJECT_KINDS)[number];

export const isOutcomeSubjectKind = (v: unknown): v is OutcomeSubjectKind => typeof v === "string" && (OUTCOME_SUBJECT_KINDS as readonly string[]).includes(v);

/** Every coded step is reached by a person. A Record over the coded keys: a new coded step fails the build without one. */
export const CODED_STEP_SUBJECT_KINDS: Readonly<Record<ChannelStepKey, OutcomeSubjectKind>> = {
  lead_found: "person",
  conversation: "person",
  website_visit: "person",
  booking_call: "person",
  signup: "person",
  form_submitted: "person",
  meeting_booked: "person",
  meeting_attended: "person",
  purchase: "person",
  paid_client: "person",
};

/** A CODED step's subject kind; null for any other key (a declared step states its own). */
export const codedStepSubjectKindOf = (key: string): OutcomeSubjectKind | null =>
  Object.hasOwn(CODED_STEP_SUBJECT_KINDS, key) ? CODED_STEP_SUBJECT_KINDS[key as ChannelStepKey] : null;
