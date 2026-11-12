/**
 * THE BOOT WARMS, ONE AT A TIME (MON-PAGE-SPEED-2-1112).
 *
 * Why: every deploy fired ~35 fleet rebuilds the instant the port bound, all at once, in the SERVING process: the fleet
 * snapshot (65 brand engine passes), the showcase (twice), the outcome prices, the agent catalogue figures, one leg
 * ranking per assigned pipe (29 in parallel), each rebuilt even when the copy stored minutes before by the previous
 * process was still fresh. Prod 2026-11-12 08:44 (a features-service restart): the serving process at 200-440 % CPU,
 * runs-service at 15-28 active ledger queries, box load 15 -> 22, and the dashboard's cached brand reads (revenue,
 * offers, campaigns, spend charts: 50-300 ms in steady state) took 1-8 s for the whole boot window.
 *
 * Now: the serving process answers from the stored bodies at once, every warm starts from its STORED copy and skips
 * when that copy is still fresh, and what is left runs here, one step after the other, after a short delay.
 */

export interface BootWarmStep {
  name: string;
  /** Resolves to "skipped" when the stored copy was fresh and nothing was rebuilt. */
  run: () => Promise<"built" | "skipped" | void>;
}

/** The first step waits this long after listen(): the first dashboard reads after a deploy are served before any warm. */
export const BOOT_WARM_START_AFTER_MS = 30_000;

/** PURE. Whether a stored copy computed at `computedAtMs` is still inside its fresh window at `nowMs`. */
export function storedCopyIsFresh(computedAtMs: number | null | undefined, freshMs: number, nowMs = Date.now()): boolean {
  return typeof computedAtMs === "number" && Number.isFinite(computedAtMs) && nowMs - computedAtMs < freshMs;
}

/**
 * Run the steps strictly one after the other (never two at once). A failed step is logged loud and the next one runs.
 * Resolves once every step settled; never rejects.
 */
export async function runBootWarmsSequentially(steps: readonly BootWarmStep[], log: (line: string) => void = console.log): Promise<void> {
  const started = Date.now();
  let built = 0;
  let skipped = 0;
  for (const step of steps) {
    const t0 = Date.now();
    try {
      const outcome = await step.run();
      if (outcome === "skipped") skipped += 1;
      else built += 1;
      log(`[features-service] boot warm ${step.name}: ${outcome === "skipped" ? "stored copy fresh, skipped" : "built"} in ${Date.now() - t0} ms`);
    } catch (error) {
      console.error(`[features-service] boot warm ${step.name} failed after ${Date.now() - t0} ms:`, error);
    }
  }
  log(`[features-service] boot warms done in ${Math.round((Date.now() - started) / 1000)} s: ${built} built, ${skipped} skipped (stored copy fresh), ${steps.length - built - skipped} failed`);
}

/** Start the sequence `startAfterMs` after the call (unref'd timer: never holds the process open). */
export function scheduleBootWarms(steps: () => readonly BootWarmStep[] | Promise<readonly BootWarmStep[]>, startAfterMs = BOOT_WARM_START_AFTER_MS): void {
  setTimeout(() => {
    void (async () => {
      let list: readonly BootWarmStep[];
      try {
        list = await steps();
      } catch (error) {
        console.error("[features-service] boot warms could not be listed, none ran:", error);
        return;
      }
      await runBootWarmsSequentially(list);
    })();
  }, startAfterMs).unref();
}
