/**
 * BACKLINK-ENGINE-1109. A funnel campaign launched on its TARGET alone (campaign-service #883, MIGRATE-1105 S8) holds
 * ONE unit run by that outcome's Engine: no pipe, no feature slug, no leg (all null). Every reader of a funnel
 * campaign's units goes through these helpers, so such a unit never reaches a pipe lookup, and its spend is read on
 * its own campaign id with no feature filter (its runs carry no feature slug: a feature-filtered read drops them).
 * The unit's outcome is the campaign's `target`; nothing here names an outcome, a brand or a campaign.
 */
import type { SalesFunnelCampaignRow, SalesFunnelUnitRow } from "./sales-funnel-campaigns-client.js";
import type { Pricing } from "./pricing.js";

/** A unit that runs a catalogue pipe: every pipe field stated. */
export type PipeUnitRow = SalesFunnelUnitRow & { pipeId: string; featureSlug: string; legKey: string };

export function isPipeUnit(u: SalesFunnelUnitRow): u is PipeUnitRow {
  return u.pipeId !== null && u.featureSlug !== null && u.legKey !== null;
}

/** The units of a row (or rows) that run a pipe. */
export function pipeUnitsOf(units: readonly SalesFunnelUnitRow[]): PipeUnitRow[] {
  return units.filter(isPipeUnit);
}

/** A row with only its pipe units (for a reader whose every figure is per pipe). */
export function withPipeUnitsOnly(row: SalesFunnelCampaignRow): SalesFunnelCampaignRow {
  return row.units.every(isPipeUnit) ? row : { ...row, units: pipeUnitsOf(row.units) };
}

/** The stated feature slugs of a unit set (an Engine-run unit states none). */
export function unitFeatureSlugsOf(units: readonly SalesFunnelUnitRow[]): string[] {
  return units.map((u) => u.featureSlug).filter((s): s is string => s !== null);
}

/** The unit campaigns stating no feature slug: their spend is read on their own ids, unfiltered by feature. */
export function featurelessUnitIdsOf(units: readonly SalesFunnelUnitRow[]): string[] {
  return units.filter((u) => u.featureSlug === null).map((u) => u.campaignId);
}

/** A pipe's steps lookup that a pipe-less unit never reaches (a play id reads its base pipe's). */
export function stepsOfPipeId<T>(steps: ReadonlyMap<string, T>, pipeId: string | null): T | null {
  if (pipeId === null) return null;
  return steps.get(pipeId) ?? steps.get(pipeId.split("~")[0]!) ?? null;
}

/** The step a unit makes when it runs no pipe: its campaign's Target (null when the campaign states none). */
export function engineUnitOutcomeOf(u: SalesFunnelUnitRow, row: SalesFunnelCampaignRow): string | null {
  return isPipeUnit(u) ? null : (row.target ?? null);
}

/**
 * The committed spend per UTC day of the featureless unit campaigns `ids`, read on their own campaign ids with no
 * feature filter, ADDED to `byDay` (a new map). Each cost row belongs to one campaign, so the sum is exact.
 * No featureless id = `byDay` itself, byte for byte (no read).
 */
export async function addFeaturelessUnitSpend(
  byDay: Map<string, number>,
  brandId: string,
  ids: readonly string[],
  headers: { orgId: string },
  pricing: Pricing,
): Promise<Map<string, number>> {
  if (ids.length === 0) return byDay;
  const { fetchBrandCommittedSpendByDay } = await import("./brand-spend-by-day-client.js");
  const extra = await fetchBrandCommittedSpendByDay(brandId, [...new Set(ids)].sort(), [], headers, pricing);
  const out = new Map(byDay);
  for (const [d, v] of extra) out.set(d, (out.get(d) ?? 0) + v);
  return out;
}

/**
 * THE steps a unit makes: its pipe's (a play id reads its base pipe's), else, for a unit an Engine runs with no pipe,
 * Start -> its campaign's Target (that Engine's outcome). Null = a pipe the catalogue lacks, or no Target stated.
 */
export function unitStepsOf<T extends { fromStep: string | null; toStep: string }>(
  steps: ReadonlyMap<string, T>,
  u: SalesFunnelUnitRow,
  row: Pick<SalesFunnelCampaignRow, "target">,
): T | null {
  if (u.pipeId !== null) return stepsOfPipeId(steps, u.pipeId);
  if (isPipeUnit(u) || !row.target) return null;
  return { fromStep: null, toStep: row.target, outcome: row.target } as unknown as T;
}
