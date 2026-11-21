/**
 * HUMAN-BRIEF-1121 (owner 2026-11-21): a campaign's brief is ONE short text in the client's words of value, never a channel
 * or step dump. « "Goal: Paid client for <offer>. Use only these channels: …" → c'est horrible et inutile. Partout où tu
 * as mis ça remplace par du langage humain. […] Juste tu dis du cold email et c'est tout non? »
 *
 * PURE. Two jobs:
 * - `robotBriefSplit`: recognise a brief OUR system wrote in a robot shape (this service's old prefill « Use only these
 *   channels:\nUse <channel> (<step> to <step>)… », campaign-service's old birth composer « Goal: <step> for <offer>.\nUse
 *   only these channels: a, b. »). Only those LINES are robot: any text a person (or a later pass) put after them is kept
 *   word for word. A brief that merely starts with « Goal: » in a person's words (its goal is no catalogue step) is not ours.
 * - `humanBriefPrompt` / `composeHumanBrief`: what the writer reads (offer, who it is for, the Target, the channels the
 *   client chose with the plays they narrow) and the deterministic cleanup after it (no dash, one paragraph). The writer is
 *   TRUSTED (no validator, no retry): its rules live in its prompt.
 */
import { createHash } from "node:crypto";
import { funnelById, stepLabel, type CatalogueModel } from "./agent-catalogue.js";

/** One channel the client chose, as the catalogue says it. `play` = a NON-default play (the default is what an empty brief picks). */
export interface BriefChannel {
  name: string;
  fromLabel: string;
  toLabel: string;
  /** The client's own team works it (we run nothing there). */
  ownTeam: boolean;
  play: { name: string; description: string } | null;
}

export interface HumanBriefInput {
  offer: { name: string; description: string | null } | null;
  /** Who the offer is for, as the client's audiences state it. */
  audiences: string[];
  /** The step the campaign aims at ("Paid client", "Meeting booked"). */
  targetLabel: string | null;
  channels: BriefChannel[];
  /** The robot text being replaced (its meaning is kept); null on a new campaign. */
  replacing: string | null;
}

const FEATURES_HEAD = "Use only these channels:";
const FEATURES_LINE = /^Use .+ \(.+ to .+\)(:.*|\.)$/;
const SERVICE_GOAL = /^Goal: (.+?)(?: for (.+))?\.$/;
const SERVICE_CHANNELS = /^Use only these channels: .+\.$/;

export type RobotShape = "features_prefill" | "campaign_service_birth";

/**
 * PURE: the robot lines of a brief and the rest (kept verbatim), or null when the brief is not robot-shaped.
 * `stepLabels` = the catalogue's step labels (a campaign-service birth goal names one, lower-cased compare).
 */
export function robotBriefSplit(brief: string | null | undefined, stepLabels: ReadonlySet<string>): { shape: RobotShape; robot: string; rest: string } | null {
  if (!brief) return null;
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let shape: RobotShape;
  if (lines[0]?.trim() === FEATURES_HEAD) {
    shape = "features_prefill";
    i = 1;
    while (i < lines.length && FEATURES_LINE.test(lines[i]!.trim())) i++;
  } else {
    const goal = SERVICE_GOAL.exec(lines[0]?.trim() ?? "");
    if (!goal) return null;
    const labels = new Set([...stepLabels].map((l) => l.toLowerCase()));
    if (!labels.has(goal[1]!.trim().toLowerCase())) return null;
    shape = "campaign_service_birth";
    i = 1;
    if (i < lines.length && SERVICE_CHANNELS.test(lines[i]!.trim())) i++;
  }
  return { shape, robot: lines.slice(0, i).join("\n").trim(), rest: lines.slice(i).join("\n").trim() };
}

/** PURE: does this text still hold a robot line anywhere (the AC sweep: none may start with one)? */
export const isRobotBrief = (brief: string | null | undefined, stepLabels: ReadonlySet<string>): boolean => robotBriefSplit(brief, stepLabels) !== null;

export const HUMAN_BRIEF_RULE = "human-brief-v1";

/** PURE: what the writer reads. Owner words: short, concise, clear, the client's value, how in a few plain words. */
export function humanBriefPrompt(input: HumanBriefInput): { systemPrompt: string; message: string } {
  const systemPrompt = [
    "You write the brief of one B2B sales campaign: one or two short sentences, in plain English, that a busy founder reads in two seconds and agrees with.",
    "Say what the campaign aims at, in the client's words of value (who it reaches and what it brings them), then how, in a few plain words (for example \"by cold email\").",
    "Name a channel only by what it does in everyday words (cold email, LinkedIn, X posts, our AI books the meetings). Leave out the steps the client's own team works.",
    "When a channel follows a specific rule (for example only confirmed email addresses), keep that rule in a few plain words.",
    "Never list channels, steps or strategies. Never write a label followed by a colon. No dashes, no bullet points, no line breaks, no quotes.",
    "Never use the pattern \"X, not Y\" or \"not X but Y\". Never start a sentence with It, They or This. Plain words, one idea per sentence.",
    "Answer with the brief only.",
  ].join(" ");
  const lines: string[] = [];
  if (input.offer) lines.push(`Offer: ${input.offer.name}${input.offer.description ? `. ${input.offer.description}` : ""}`);
  if (input.audiences.length > 0) lines.push(`Who it is for: ${input.audiences.join("; ")}`);
  if (input.targetLabel) lines.push(`What the campaign aims at: ${input.targetLabel}`);
  const ours = input.channels.filter((c) => !c.ownTeam);
  if (ours.length > 0)
    lines.push(
      "How (the channels the client chose, in order):",
      ...ours.map((c) => `${c.name}, moves people from ${c.fromLabel} to ${c.toLabel}${c.play ? `, with this rule: ${c.play.name}. ${c.play.description}` : ""}`),
    );
  if (input.replacing) lines.push(`The old brief said this (keep its meaning, drop its form): ${input.replacing}`);
  return { systemPrompt, message: lines.join("\n") };
}

/** PURE: the writer's text made a brief (deterministic cleanups only): no em/en dash, no quotes around it, one paragraph. */
export function cleanHumanBrief(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

/** PURE: the human sentence(s) first, then what a person wrote after the robot lines, word for word. */
export function composeHumanBrief(human: string, rest: string): string {
  const head = cleanHumanBrief(human);
  return rest.trim() === "" ? head : `${head}\n\n${rest.trim()}`;
}

/** PURE: the fingerprint of what a written brief depends on (the stored draft is reused while it holds). */
export const humanBriefKeyOf = (input: HumanBriefInput): string =>
  createHash("sha256").update(`${HUMAN_BRIEF_RULE}|${JSON.stringify(input)}`).digest("hex").slice(0, 32);

/**
 * PURE: the channels a funnel id names, in order, from the catalogue (a play only when it is NOT the pipe's default: the
 * default is what a brief silent on it picks). Unknown funnel = none (the brief then says the aim only).
 */
export function briefChannelsOf(model: CatalogueModel, salesFunnelId: string | null): BriefChannel[] {
  if (!salesFunnelId) return [];
  const f = funnelById(model, salesFunnelId);
  return (f?.legs ?? []).flatMap((l) => {
    const p = l.pipe;
    if (!p) return [];
    return [
      {
        name: p.channelName,
        fromLabel: p.fromStep === null ? "Start" : stepLabel(model, p.fromStep),
        toLabel: stepLabel(model, p.toStep),
        ownTeam: p.operatedBy === "customer",
        play: p.play && !p.play.isDefault ? { name: p.play.strategyName, description: p.play.strategyDescription } : null,
      },
    ];
  });
}

/** PURE: the step a campaign aims at, in words: the stated Target, else the funnel's last step. */
export function briefTargetLabelOf(model: CatalogueModel, target: string | null, salesFunnelId: string | null): string | null {
  if (target) return stepLabel(model, target);
  const legs = salesFunnelId ? (funnelById(model, salesFunnelId)?.legs ?? []) : [];
  const last = legs[legs.length - 1]?.pipe;
  return last ? stepLabel(model, last.toStep) : null;
}

/** PURE: every step label of the catalogue (a campaign-service birth goal names one). */
export const stepLabelsOf = (model: CatalogueModel): Set<string> => new Set([...model.steps.values()].map((s) => s.label));

/** PURE: the writer's input for one campaign (or one onboarding card): the offer, who it is for, the aim, the channels. */
export function humanBriefInputOf(
  model: CatalogueModel,
  context: { offer: { name: string; description: string | null } | null; audiences: string[] },
  campaign: { salesFunnelId: string | null; target: string | null; replacing: string | null },
): HumanBriefInput {
  return {
    offer: context.offer,
    audiences: context.audiences,
    targetLabel: briefTargetLabelOf(model, campaign.target, campaign.salesFunnelId),
    channels: briefChannelsOf(model, campaign.salesFunnelId),
    replacing: campaign.replacing,
  };
}
