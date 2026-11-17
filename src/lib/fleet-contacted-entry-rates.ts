/**
 * IO (MEASURED-BEFORE-DEFAULT-1117): the FLEET's measured cold-email entry rate per engine signal, the rung a contacted
 * lead with no measured group rate takes before the seeded benchmark (`ContactedPricing.fleetEntryRatePct`). Read off
 * the outcome-prices build, AWAITED at boot like every expected rate read (a young process never answers "nothing
 * measured", which froze the benchmark in a cell: FLEET-CONVERSION-BOOT-1116). Its own module so route suites, whose
 * fixtures answer no outcome-prices walk, keep the benchmark (`src/vitest.setup.ts`).
 */
import { fleetContactedEntryRatesBySignal } from "./contacted-value.js";

export async function readFleetContactedEntryRates(): Promise<Record<string, number>> {
  const fleet = await (await import("../routes/public.js")).awaitFleetLegConversionRatesFromOutcomePrices();
  return fleetContactedEntryRatesBySignal(fleet);
}
