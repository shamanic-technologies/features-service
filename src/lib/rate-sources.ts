/**
 * THE CLIENT IS ASKED A RATE ONLY WHERE THE LEDGER CANNOT MEASURE IT (owner 2026-11-13, SCRIPT-VALUE-RATING-1113-RATES).
 * PURE; IO + route in `routes/rate-sources.ts`.
 *
 * Owner's words: « il faut aussi tenir des valeurs par défaut et demander au user pour chaque Engine [dont on ne mesure pas
 * l'outcome] … Ce sont les seuls endroits dans Brand (et onboarding) où on veut lui donner des taux. » A rate the ledger
 * cannot measure for the brand is ASKED (prefilled with a default) and replaced as soon as the measure exists (CRM, Stripe,
 * calendar connected); a rate it measures is SHOWN, never asked.
 *
 * Per leg the client can state today (brand-service's leg list, in its own step words):
 *  - the step's ledger outcomes come from the catalogue: the step key itself, and the lead state it reaches when the ledger
 *    declares that instead (`ledgerKeysOfStep`); the one runs-service actually chains is read, never a hand table;
 *  - MEASURED = the brand's own one-step rate passes the Rating's rule (`measuredStepShare`, the same function the script
 *    Rating values outcomes with): enough consumed Units, at least one led. A leg touching a meeting step is measured only
 *    on a brand that REPORTS meetings (MEETING-POPULATION-1018): one that never reported one is unmeasured, never 0 %;
 *  - otherwise ASKED, prefilled with the DEFAULT: the fleet's own ledger rate on the step when the fleet measures it
 *    (`fleet_measured`; never on a meeting leg, whose fleet figure would count brands that report no meetings), else the
 *    leg's seeded benchmark (`leg_default`);
 *  - the rate IN FORCE: measured, else stated by the client, else the default.
 * A brand with too few Units is never "measured" on the fleet's rate. No return is ever served from these figures.
 */
import { CHANNEL_STEP_KEYS, FUNNEL_STEP_LABEL_TO_KEY, type ChannelStepKey } from "./acquisition-channels.js";
import { defaultLegRatePct } from "./default-leg-rates.js";
import { normaliseStep } from "./funnel-steps.js";
import { funnelLeg, legKeyBetween } from "./funnel-legs.js";
import { ledgerKeysOfStep } from "./ledger-counts.js";
import { MEETING_STEPS } from "./meeting-population.js";
import { measuredStepShare, MIN_CONSUMED_UNITS, type StepRate } from "./script-value-rating.js";
import type { BrandLegRate } from "./brand-leg-economics-client.js";

/** A step-rates book of runs-service (`/internal/stats/outcome-chains/step-rates[?brandId]`). */
export interface StepRateBook {
  builtAt: string;
  /** Distinct consumed Units per outcome (the denominators, also of pairs never chained). */
  consumed: ReadonlyMap<string, number>;
  steps: readonly StepRate[];
}

export type RateSource = "measured" | "stated" | "default";
export type UnmeasuredReason = "not_a_ledger_step" | "too_few_units" | "nothing_led_yet" | "brand_reports_no_meetings";

export interface LegRateSource {
  /** brand-service's own step words (the key a write joins on). */
  fromStep: string;
  toStep: string;
  /** The catalogue's leg, null when the catalogue carries none. */
  legKey: string | null;
  /** The ledger outcomes the leg reads (null = not a ledger step). */
  fromOutcome: string | null;
  toOutcome: string | null;
  /** true = the client is asked this rate (the ledger does not measure it for the brand). */
  ask: boolean;
  /** The rate in force, 0..100; null only when nothing measured, stated or defaulted exists. */
  ratePct: number | null;
  source: RateSource | null;
  /** The brand's ledger on the leg, whatever the bar: consumed Units of the start, those that led to the end. */
  ledger: { consumedUnits: number; ledUnits: number } | null;
  /** The brand's measured rate, null unless it passes the rule. */
  measuredRatePct: number | null;
  unmeasuredReason: UnmeasuredReason | null;
  statedRatePct: number | null;
  defaultRatePct: number | null;
  defaultSource: "fleet_measured" | "leg_default" | null;
}

const isChannelStepKey = (v: string): v is ChannelStepKey => (CHANNEL_STEP_KEYS as readonly string[]).includes(v);

/** A brand-service step word (either spelling) -> its catalogue step key, or null. */
export function catalogueStepOf(label: string): ChannelStepKey | null {
  const direct = FUNNEL_STEP_LABEL_TO_KEY[label.trim()];
  if (direct) return direct;
  const flat = normaliseStep(label);
  const byLabel = Object.entries(FUNNEL_STEP_LABEL_TO_KEY).find(([l]) => normaliseStep(l) === flat)?.[1];
  if (byLabel) return byLabel;
  const asKey = flat.replace(/ /g, "_");
  return isChannelStepKey(asKey) ? asKey : null;
}

/** The ledger outcomes a catalogue step may be declared under: the step key, then its ledger key when it differs. */
export function ledgerCandidatesOf(step: ChannelStepKey): string[] {
  return [...new Set([step, ...ledgerKeysOfStep(step)])];
}

/** Of the candidates, the one the book holds the most consumed Units of (the ledger's own spelling); none = the first. */
function spelledInBook(candidates: readonly string[], book: StepRateBook, role: "from" | "to"): string {
  const weight = (o: string): number =>
    role === "from" ? (book.consumed.get(o) ?? 0) : book.steps.reduce((n, s) => (s.toOutcome === o ? n + s.ledUnits : n), 0);
  return [...candidates].sort((a, b) => weight(b) - weight(a))[0]!;
}

/** The book's figures on one pair: consumed Units of the start (chained or not), those that led to the end. */
function pairOf(book: StepRateBook, from: string, to: string): { consumedUnits: number; ledUnits: number } {
  const row = book.steps.find((s) => s.fromOutcome === from && s.toOutcome === to);
  return { consumedUnits: row?.consumedUnits ?? book.consumed.get(from) ?? 0, ledUnits: row?.ledUnits ?? 0 };
}

const pct = (share: number): number => Math.round(share * 1e6) / 1e4;

export function legRateSources(input: {
  legs: readonly BrandLegRate[];
  brand: StepRateBook;
  fleet: StepRateBook;
  /** Whether the brand reports meetings (lead-service, MEETING-POPULATION-1018). */
  reportsMeetings: boolean;
}): LegRateSource[] {
  return input.legs.map((l): LegRateSource => {
    const stated = l.stated && l.ratePct !== null ? l.ratePct : null;
    const from = catalogueStepOf(l.fromStep);
    const to = catalogueStepOf(l.toStep);
    const leg = from && to ? funnelLeg(legKeyBetween(from, to)) : null;
    const seeded = from && to ? defaultLegRatePct(from, to) : null;
    const base = { fromStep: l.fromStep, toStep: l.toStep, legKey: leg?.legKey ?? null, statedRatePct: stated };
    if (!from || !to) {
      const ratePct = stated ?? seeded;
      return {
        ...base, fromOutcome: null, toOutcome: null, ask: true, ratePct,
        source: stated !== null ? "stated" : seeded !== null ? "default" : null,
        ledger: null, measuredRatePct: null, unmeasuredReason: "not_a_ledger_step",
        defaultRatePct: seeded, defaultSource: seeded !== null ? "leg_default" : null,
      };
    }
    const fromCandidates = ledgerCandidatesOf(from);
    const toCandidates = ledgerCandidatesOf(to);
    const merged: StepRateBook = { builtAt: input.brand.builtAt, consumed: new Map([...input.fleet.consumed, ...input.brand.consumed]), steps: [...input.brand.steps, ...input.fleet.steps] };
    const fromOutcome = spelledInBook(fromCandidates, merged, "from");
    const toOutcome = spelledInBook(toCandidates, merged, "to");
    const meetingLeg = MEETING_STEPS.has(from) || MEETING_STEPS.has(to);

    const ledger = pairOf(input.brand, fromOutcome, toOutcome);
    const share = measuredStepShare(ledger);
    let unmeasuredReason: UnmeasuredReason | null = null;
    if (meetingLeg && !input.reportsMeetings) unmeasuredReason = "brand_reports_no_meetings";
    else if (share === null) unmeasuredReason = ledger.consumedUnits < MIN_CONSUMED_UNITS ? "too_few_units" : "nothing_led_yet";
    const measuredRatePct = unmeasuredReason === null && share !== null ? pct(share) : null;

    const fleetShare = meetingLeg ? null : measuredStepShare(pairOf(input.fleet, fromOutcome, toOutcome));
    const defaultRatePct = fleetShare !== null ? pct(fleetShare) : seeded;
    const defaultSource = fleetShare !== null ? "fleet_measured" : seeded !== null ? "leg_default" : null;

    const ratePct = measuredRatePct ?? stated ?? defaultRatePct;
    const source: RateSource | null = measuredRatePct !== null ? "measured" : stated !== null ? "stated" : defaultRatePct !== null ? "default" : null;
    return { ...base, fromOutcome, toOutcome, ask: measuredRatePct === null, ratePct, source, ledger, measuredRatePct, unmeasuredReason, defaultRatePct, defaultSource };
  });
}
