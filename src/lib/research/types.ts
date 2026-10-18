/**
 * The Research file as the staff Research page renders it (LIVE-RESEARCH-1018). Byte-compatible with the
 * `ResearchFile` the dashboard typed over the nightly snapshot (distribute.you `apps/dashboard/src/lib/research/
 * research.ts`), plus what a live read adds: `computedAt`, the cost basis in our words, and `unavailable` (every
 * study id the page shows that this service does not serve yet, with the reason).
 */
import type { VerdictKind } from "./verdict.js";

export type ResearchPipeId = "cold-email-positive-reply" | "cold-email-website-visit" | "meeting-booking";
export type ResearchOutcomeId = "meeting" | "judgment";
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
  | "launch";
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
  maturation: {
    rule: "run_start";
    days: number;
    cutoff: string;
    windowEnd: string;
    legs: Record<"reply" | "visit", { durationDays: number; outcomesRequired: number; cutoff: string }>;
    note: string;
  };
  pipes: ResearchPipeEntry[];
  outcomes: ResearchOutcomeEntry[];
  studies: ResearchStudy[];
  unavailable: ResearchUnavailable[];
}
