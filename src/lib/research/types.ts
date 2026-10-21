/**
 * The Research file as the staff Research page renders it (LIVE-RESEARCH-1018). Byte-compatible with the
 * `ResearchFile` the dashboard typed over the nightly snapshot (distribute.you `apps/dashboard/src/lib/research/
 * research.ts`), plus what a live read adds: `computedAt`, the cost basis in our words, and `unavailable` (every
 * study id the page shows that this service does not serve yet, with the reason).
 */
import type { VerdictKind } from "./verdict.js";

export type ResearchPipeId = "cold-email-positive-reply" | "cold-email-website-visit" | "meeting-booking";
export type ResearchOutcomeId = "meeting" | "judgment" | "positive-reply";
export type ResearchTopic =
  | "llm"
  | "cost"
  | "followups"
  | "opens"
  | "template"
  | "workflow"
  | "naming"
  | "layout"
  | "opening"
  | "dash"
  | "weekday"
  | "hour"
  | "judgment"
  | "launch"
  /** How long an outcome takes to arrive (TTFPR-RESEARCH-STUDY-1021; the dashboard reads it since distribute.you #5587). */
  | "delay"
  /** Per prospect country (RESEARCH-COUNTRY-1021; the dashboard reads it once distribute.you ships the topic). */
  | "country"
  /** How specific a client's B2B niche is (RESEARCH-NICHE-1021; the dashboard reads it since distribute.you RESEARCH-NICHE-1021-DASH). */
  | "niche";
export type ResearchGoal = "roi" | "rate";

export interface ResearchPoint {
  /** A bar that opens a catalogue page: the workflow dynasty slug, the template id, the model key. */
  key?: string;
  label: string;
  value: number;
  display: string;
  /** The counts behind the value. */
  note: string;
  /** LEARNING under this service's maturity rule (`lib/maturity.ts`). Historical field name. */
  thin: boolean;
  /** On a month chart: the month the maturity cutoff falls inside (only part of its people count yet). */
  partial?: boolean;
}

export interface ResearchChart {
  kind: "bars" | "months";
  title: string;
  lowerIsBetter: boolean;
  points: ResearchPoint[];
  cumulative?: { title: string; points: ResearchPoint[] };
  /**
   * On a distribution chart (TTFPR-RESEARCH-STUDY-1021): the cumulative curve over the same buckets as `points`, one
   * point per bucket in the same order, `value` = the % of the sample arrived by the END of that bucket (the last = 100).
   */
  curve?: { title: string; points: ResearchPoint[] };
  note?: string;
}

export interface ResearchStudy {
  id: string;
  pipe: ResearchPipeId | null;
  outcome?: ResearchOutcomeId;
  topic: ResearchTopic;
  goal: ResearchGoal;
  question: string;
  status: "measured" | "not_enough_data";
  headline: string;
  winner: string | null;
  crowned: boolean;
  verdict: { kind: VerdictKind; reason: string };
  result: { display: string; unit: string; sample: string } | null;
  charts: ResearchChart[];
  /**
   * On a delay study (TTFPR-RESEARCH-STUDY-1021): the sample and the tiles the page prints, in order p10, p25, median,
   * p75, p90, average; `ms` the figure, `display` it in human units (minutes, hours under a day, then days).
   */
  delay?: { sampleSize: number; stats: Array<{ key: string; label: string; ms: number; display: string }> };
  conclusion: string[];
}

export interface ResearchPipeEntry {
  id: ResearchPipeId;
  channel: string;
  leg: string;
  outcome: string;
  description: string;
}

export interface ResearchOutcomeEntry {
  id: ResearchOutcomeId;
  outcome: string;
  /** The step the outcome is (catalogue key); absent on a section that is no step (Jev, the meeting cost section). */
  step?: string;
  /** The page's pipes that land on it. */
  pipes?: ResearchPipeId[];
  description: string;
  population: string;
}

export interface ResearchUnavailable {
  id: string;
  /** In plain words: what the study needs that this service cannot read yet. */
  reason: string;
}

export interface ResearchFile {
  generatedAt: string;
  /** When this body was computed (equals `generatedAt`; named for the live read). */
  computedAt: string;
  allOrgs: true;
  /** `user` = what clients were billed (default); `actual` = what the vendors charged us (staff only). */
  costBasis: "user" | "actual";
  /** Actual basis only: billed spend no vendor cost prices, left out of every figure (USD). */
  unpricedBilledUsd: number;
  window: { from: string; to: string };
  readOn: string;
  /**
   * The page-wide counts the hub prints: every email sent on the two cold email legs since inception, the clients they
   * were sent for, the workflows with people on them, the emails our own sender sent on the website-visit leg (the only
   * ones a visit can come from), per month. Emails, not people (the hub's "Emails studied"). Absent when unreadable, never 0.
   */
  volume?: { emails: number; orgs: number; workflows: number; linkedEmails: number; byMonth: Array<{ label: string; emails: number }> };
  maturation: {
    rule: "run_start";
    days: number;
    cutoff: string;
    windowEnd: string;
    legs: Record<"reply" | "visit", { durationDays: number; outcomesRequired: number; cutoff: string }>;
    /** Emails of sequences first written on or after their leg's cutoff: too young to count yet. */
    excludedEmails?: number;
    /** People in the fleet person cell no serve record dates (counted in the mature cohort, in no month). */
    noRunStart?: number;
    note: string;
  };
  pipes: ResearchPipeEntry[];
  outcomes: ResearchOutcomeEntry[];
  studies: ResearchStudy[];
  unavailable: ResearchUnavailable[];
}
