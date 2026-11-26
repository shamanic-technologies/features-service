/**
 * Monitoring: the view refresher crashed (REFRESHER-DOWN-NAMED-1126). The refresher is a child process of the serving
 * one: when it dies (out of memory is SIGABRT) the container keeps running (RestartCount 0), so no box watchdog saw the
 * 7 deaths of 2026-11-25/26 while every read needing a view it had not stored was refused. The serving process notes
 * each exit (`refresherExitsNow`) and writes one box-check run every 10 min: red while a crash happened in the last
 * hour, value = crashes in that hour (a daily series on the Box watchdogs tile).
 */
import type { BoxCheckRun } from "./box-checks.js";
import { upsertBoxCheckRuns } from "./box-checks-store.js";
import { refresherExitsNow, refresherHeapMb, type RefresherExit } from "./view-refresher.js";

export const REFRESHER_CRASH_CHECK = "view-refresher-crashes";
export const REFRESHER_CRASH_CADENCE_MINUTES = 10;
export const REFRESHER_CRASH_WINDOW_MS = 60 * 60_000;

const isCrash = (e: RefresherExit) => e.signal !== null || (e.code !== null && e.code !== 0);

/** PURE: the box-check run for the refresher exits seen so far. */
export function refresherCrashRun(exits: readonly RefresherExit[], now: number, heapMb: number): BoxCheckRun {
  const crashes = exits.filter((e) => isCrash(e) && now - e.at <= REFRESHER_CRASH_WINDOW_MS);
  const line = (e: RefresherExit) => `${new Date(e.at).toISOString().slice(11, 16)} UTC (${e.signal ?? `code ${e.code}`}, up ${Math.round(e.upMs / 60_000)} min)`;
  return {
    check: REFRESHER_CRASH_CHECK,
    ranAt: new Date(now).toISOString(),
    ok: crashes.length === 0,
    reason:
      crashes.length === 0
        ? `The features-service view refresher ran without a crash in the last hour (heap ceiling ${heapMb} MB).`
        : `The features-service view refresher crashed ${crashes.length} time${crashes.length === 1 ? "" : "s"} in the last hour (${crashes
            .slice(-5)
            .map(line)
            .join(", ")}; SIGABRT = out of memory at its ${heapMb} MB heap ceiling). Reads needing a view it had not stored answered 503 view_refresher_restarting meanwhile.`,
    cadenceMinutes: REFRESHER_CRASH_CADENCE_MINUTES,
    label: "View refresher crashes",
    value: crashes.length,
    unit: "crashes",
    details: { heapCeilingMb: heapMb, crashes: crashes.map((e) => ({ at: new Date(e.at).toISOString(), code: e.code, signal: e.signal, upMinutes: Math.round(e.upMs / 60_000) })) },
  };
}

let started = false;
export function startRefresherCrashMonitor(): void {
  if (started) return;
  started = true;
  const tick = () => {
    const run = refresherCrashRun(refresherExitsNow(), Date.now(), refresherHeapMb());
    upsertBoxCheckRuns([run], new Date()).catch((err) => console.error(`[features-service] ${REFRESHER_CRASH_CHECK} write failed:`, err));
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, REFRESHER_CRASH_CADENCE_MINUTES * 60_000).unref();
}
