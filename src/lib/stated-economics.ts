/**
 * WHAT BRANDS ACTUALLY STATED — and the fleet MEDIAN over it, never a mean.
 *
 * Every fleet surface that needs "the conversion rates and the lifetime revenue a typical brand runs
 * on" (the per-pair channel economics, the cross-org cost-per-outcome trend / lifetime / per-workflow
 * reads) used to take the unweighted MEAN of each brand's BRAND-WIDE economics record. Both halves of
 * that were wrong, and the second one decided the number:
 *
 *  1. A mean over brands is carried by whichever brand sits furthest from the rest. The unit is the
 *     brand, and the honest central value of a set of brands is its MEDIAN.
 *  2. The brand-wide record is NOT NULL with SERVER DEFAULTS, so a brand that never stated a rate
 *     reads back a plausible one. Measured on brand-service's prod database 2026-09-25, of 109 rows:
 *     `visitToPaidClientPct` sat on its default 5 on 82, `replyToPaidClientPct` on its default 25 on 91,
 *     and the two form-submission rates on their defaults 25 / 20 on 93. A median over that column IS
 *     the default — a number nobody stated, served as the fleet's.
 *
 * So the population is what brands STATED, and nothing else:
 *
 *  - RATES come from brand-service's LEG store (one rate per brand and leg — no funnel in the key, wave
 *    C1 2026-09-25). A row exists only where somebody stated a
 *    rate — it has no default behind it — and brand-service's one-time move from the per-offer grain
 *    discarded the values its economics backfill had copied from the brand-wide defaults.
 *  - LIFETIME REVENUE stays per OFFER (`offer-economics`, nullable — null is "never stated"), carried
 *    onto the funnels each offer's campaigns read. A brand selling several offers is read offer by offer.
 *
 * A value that is absent contributes nothing: it is not a zero, not a default, not an average. Each
 * brand is ONE data point per field (the median of its own statements across offers / funnels), so
 * the unit stays the BRAND.
 */

import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { declaredFunnelsToRank } from "./declared-funnels.js";
import type { ProjectionEconomics, SalesEconomics } from "./funnel-registry.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/** A brand's stated economics — only the fields somebody stated. */
export type StatedEconomics = Partial<SalesEconomics>;

/** Median of a set of numbers, null when empty. Linear interpolation for an even count. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return lo === hi ? sorted[lo] : (sorted[lo] + sorted[hi]) / 2;
}

/**
 * One declared funnel's STATED economics. The declared-funnel reader already drops every rate nobody
 * stated (a null never becomes a 0) and composes the meeting funnel's booked → paid rate exactly as
 * pricing does. The one addition is the direct self-serve close `visitToClosePct`, which brand-service
 * DERIVES on every write as `visitToSignupPct × signupToPaidClientPct / 100`: when a funnel states both
 * halves, the derived value is theirs, not ours.
 */
function statedOfFunnel(funnel: DeclaredSalesFunnel): StatedEconomics {
  const [ranked] = declaredFunnelsToRank([funnel]);
  const stated: StatedEconomics = { ...(ranked?.economics ?? {}) };
  if (
    stated.visitToClosePct === undefined &&
    typeof stated.visitToSignupPct === "number" &&
    typeof stated.signupToPaidClientPct === "number"
  ) {
    stated.visitToClosePct = (stated.visitToSignupPct * stated.signupToPaidClientPct) / 100;
  }
  return stated;
}

/** Collapse several statements of one entity into ONE per field — the median of what was stated. */
export function collapseStated(list: readonly StatedEconomics[]): StatedEconomics {
  const fields = new Set<string>();
  for (const s of list) for (const k of Object.keys(s)) fields.add(k);
  const out: Record<string, number> = {};
  for (const field of fields) {
    const m = median(
      list
        .map((s) => (s as Record<string, unknown>)[field])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    );
    if (m !== null) out[field] = m;
  }
  return out as StatedEconomics;
}

/** A brand's stated economics, per funnel it declared and collapsed across all of them. */
export interface BrandStatedEconomics {
  /** Per funnel key, the median over that funnel's offers of what was stated on it. */
  byFunnel: Partial<Record<SalesFunnelKey, StatedEconomics>>;
  /** One data point for the brand: per field, the median over every funnel that stated it. */
  overall: StatedEconomics;
}

/**
 * A brand's stated economics, read through each funnel's own legs exactly as pricing reads them: the leg
 * RATES the brand stated and the LIFETIME REVENUE each offer stated (both already on the funnels).
 */
export function brandStatedEconomics(funnels: readonly DeclaredSalesFunnel[]): BrandStatedEconomics {
  const grouped = new Map<SalesFunnelKey, StatedEconomics[]>();
  for (const funnel of funnels) {
    const list = grouped.get(funnel.funnelKey) ?? [];
    list.push(statedOfFunnel(funnel));
    grouped.set(funnel.funnelKey, list);
  }
  const byFunnel: Partial<Record<SalesFunnelKey, StatedEconomics>> = {};
  for (const [key, list] of grouped) byFunnel[key] = collapseStated(list);
  return { byFunnel, overall: collapseStated(funnels.map(statedOfFunnel)) };
}

/** The fleet's median statement, ready for the projection math. */
export interface FleetMedianEconomics {
  /**
   * Per rate, the median over the brands that STATED it, as a decimal. The five required projection
   * rates read 0 when no brand stated them — the zero-denominator gate downstream turns that into a
   * NULL cost, never a fabricated one (the same convention the lenient projection economics have
   * always used). Null when no brand stated anything at all.
   */
  economics: ProjectionEconomics | null;
  /** Median stated lifetime revenue per paying client, over the brands that stated one (> 0). */
  lifetimeRevenueUsd: number | null;
  /** How many brands contributed at least one stated value. */
  brandCount: number;
}

/**
 * The MEDIAN over a set of brands' stated economics — one data point per brand, per field, over the
 * brands that stated that field. Replaces the retired `meanFleetEconomics`.
 */
export function medianFleetEconomics(brands: readonly StatedEconomics[]): FleetMedianEconomics {
  const contributing = brands.filter((b) => Object.keys(b).length > 0);
  const pick = (field: keyof SalesEconomics): number | undefined => {
    const m = median(
      contributing
        .map((b) => b[field])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    );
    return m === null ? undefined : m / 100;
  };
  const ltr = median(
    contributing
      .map((b) => b.lifetimeRevenueUsd)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0),
  );
  const rateFields: Array<keyof SalesEconomics> = [
    "replyToMeetingPct",
    "visitToMeetingPct",
    "meetingToClosePct",
    "visitToClosePct",
    "visitToSignupPct",
    "signupToPaidClientPct",
    "visitToPaidClientPct",
    "replyToPaidClientPct",
    "visitToFormSubmissionPct",
    "formSubmissionToPaidClientPct",
  ];
  const anyRate = rateFields.some((f) => pick(f) !== undefined);
  return {
    economics: anyRate
      ? {
          r2m: pick("replyToMeetingPct") ?? 0,
          v2m: pick("visitToMeetingPct") ?? 0,
          m2c: pick("meetingToClosePct") ?? 0,
          v2c: pick("visitToClosePct") ?? 0,
          v2s: pick("visitToSignupPct") ?? 0,
          s2pc: pick("signupToPaidClientPct"),
          v2pc: pick("visitToPaidClientPct"),
          r2pc: pick("replyToPaidClientPct"),
          v2fs: pick("visitToFormSubmissionPct"),
          fs2pc: pick("formSubmissionToPaidClientPct"),
        }
      : null,
    lifetimeRevenueUsd: ltr,
    brandCount: contributing.length,
  };
}
