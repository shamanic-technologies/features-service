/**
 * WHAT A LEAD STRATEGY CHANGES, IN CUSTOMER WORDS (owner 2026-10-27, FUNNEL-NAMES-NO-NUMBERS-1027: « j'ai marre de tes
 * campagnes avec des noms avec des chiffres » + « chaque description doit être unique dans une brand »).
 *
 * A funnel through a non-default play (`<leg>@<slug>~<strategy>`) is another funnel, and its name and sentence must say
 * what differs: WHO it reaches (people who acted, catch-all addresses too, your warm CRM contacts) and WHEN it writes
 * again (a re-contact window shorter or longer than Lead Sourcing's default 3 months). One table per strategy BASE; a
 * window variant is read off the id's `-<n>-months` suffix, so `valid-only-2-months` or a future `valid-catch-all-6-months`
 * needs no line here. A strategy this table does not know adds nothing (it reads like its pipe's default).
 * A `-never-emailed` suffix (FRESH-NEVER-1106, owner 2026-11-06: a cold first email goes only to people the brand NEVER
 * emailed) is the third window: never re-contacted. Its base is the part before it (`valid-catch-all-never-emailed` reads
 * `valid-catch-all`'s who), its name word is "Fresh" and its sentence says "never emailed before". Any base, no line here.
 *
 * Copy rules (humanizer): plain English, no dash, no internal word (catch-all, strategy, play, pipe). A NAME word is one
 * word and carries no digit; the SENTENCE may state the window in figures ("every 2 months").
 */

/** The re-contact window Lead Sourcing applies when the strategy states none (`any-contact`: "no 3-month window"). */
export const DEFAULT_RECONTACT_MONTHS = 3;

interface StrategyWords {
  /** One name word saying who is reached ("Wide"), null = the same people as the default. */
  nameWho: string | null;
  /** Who the sentence names, in place of the default ("new buyers, unconfirmed addresses included"); null = unchanged. */
  sentenceWho: ((defaultWho: string) => string) | null;
}

const withSuffix = (suffix: string) => (who: string) => `${who}, ${suffix}`;

const BASES: Readonly<Record<string, StrategyWords>> = {
  // Default-like plays: the same people as the pipe's default.
  "valid-only": { nameWho: null, sentenceWho: null },
  "everyone-in-the-source": { nameWho: null, sentenceWho: null },
  "leads-only": { nameWho: null, sentenceWho: null },
  "new-contacts-only": { nameWho: null, sentenceWho: null },
  "not-current-clients-only": { nameWho: null, sentenceWho: null },
  // Which addresses we write to.
  "valid-catch-all": { nameWho: "Wide", sentenceWho: withSuffix("unconfirmed addresses included") },
  "valid-catch-all-unknown": { nameWho: "Wider", sentenceWho: withSuffix("unchecked addresses included") },
  // Who, among the people the brand knows.
  "lead-follow-up-due": { nameWho: "Active", sentenceWho: () => "people who acted, once their follow-up is due" },
  "contacted-pure-prospects": { nameWho: "Past", sentenceWho: () => "prospects we already emailed" },
  "any-contact": { nameWho: "Mixed", sentenceWho: () => "new and past buyers" },
  "warm-never-converted": { nameWho: "Warm", sentenceWho: () => "your warm CRM contacts" },
  "customers-prospects": { nameWho: "Prospect", sentenceWho: () => "your CRM prospects" },
  "all-crm-contacts": { nameWho: "CRM", sentenceWho: () => "all your CRM contacts" },
  "reachable-by-email": { nameWho: "CRM", sentenceWho: () => "your CRM contacts with an email" },
  "reachable-by-phone": { nameWho: "CRM", sentenceWho: () => "your CRM contacts with a phone" },
  "current-clients": { nameWho: "Client", sentenceWho: () => "your current clients" },
  "email-replies-only": { nameWho: "Email", sentenceWho: () => "buyers who reply by email" },
  "replies-with-documents": { nameWho: "Document", sentenceWho: withSuffix("your documents attached") },
  // How the first email reads (what we write, not who we write to).
  "blind-emails-only": { nameWho: "Blind", sentenceWho: withSuffix("without naming you") },
  "named-emails-only": { nameWho: "Named", sentenceWho: withSuffix("naming you upfront") },
  "offer-emails-only": { nameWho: "Offer", sentenceWho: withSuffix("leading with a free offer") },
  "no-blind-emails": { nameWho: "Open", sentenceWho: withSuffix("always naming you") },
  "no-named-emails": { nameWho: "Discreet", sentenceWho: withSuffix("never pitching you head on") },
  "no-offer-emails": { nameWho: "Plain", sentenceWho: withSuffix("with no free offer") },
};

export interface ParsedStrategy {
  base: string;
  /** The re-contact window the id states, null when it states none (or states "never emailed"). */
  recontactMonths: number | null;
  /** True when the id states the people reached were never emailed by the brand (`-never-emailed`). */
  neverEmailed: boolean;
}

/** The name word of the "never emailed" window: the people are new to the brand's emails. */
export const NEVER_EMAILED_NAME_WORD = "Fresh";
/** What the sentence adds for the "never emailed" window. */
export const NEVER_EMAILED_SENTENCE = "never emailed before";

/** PURE: `valid-catch-all-2-months` -> base `valid-catch-all`, window 2; `valid-catch-all-never-emailed` -> base
 * `valid-catch-all`, never emailed. */
export function parseStrategyId(id: string): ParsedStrategy {
  const never = /^(.+)-never-emailed$/.exec(id);
  if (never) return { base: never[1], recontactMonths: null, neverEmailed: true };
  const m = /^(.*)-(\d+)-months?$/.exec(id);
  return m ? { base: m[1], recontactMonths: Number(m[2]), neverEmailed: false } : { base: id, recontactMonths: null, neverEmailed: false };
}

/** PURE: the one name word of a re-contact window ("Frequent" sooner than the default, "Patient" later), no digit. */
export function windowNameWord(months: number | null): string | null {
  if (months === null || months === DEFAULT_RECONTACT_MONTHS) return null;
  return months < DEFAULT_RECONTACT_MONTHS ? "Frequent" : "Patient";
}

/** PURE: the name words of a strategy: who it reaches and when it writes again (each null when unchanged). */
export function strategyNameWords(id: string | null): { who: string | null; window: string | null } {
  if (id === null) return { who: null, window: null };
  const { base, recontactMonths, neverEmailed } = parseStrategyId(id);
  return { who: BASES[base]?.nameWho ?? null, window: neverEmailed ? NEVER_EMAILED_NAME_WORD : windowNameWord(recontactMonths) };
}

/** PURE: who the sentence names under a strategy, from the default who ("new buyers"). */
export function strategySentenceWho(id: string | null, defaultWho: string): string {
  if (id === null) return defaultWho;
  const { base, recontactMonths, neverEmailed } = parseStrategyId(id);
  const who = BASES[base]?.sentenceWho?.(defaultWho) ?? defaultWho;
  if (neverEmailed) return `${who}, ${NEVER_EMAILED_SENTENCE}`;
  return recontactMonths !== null && recontactMonths !== DEFAULT_RECONTACT_MONTHS ? `${who}, every ${recontactMonths} months` : who;
}
