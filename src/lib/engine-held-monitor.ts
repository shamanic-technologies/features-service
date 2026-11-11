/**
 * ENGINE HELD MONITOR (NO-BRIEF-UNBLOCK-1111). A campaign whose Engine cannot run (the Engine runner asked which scripts
 * the campaign's strategy keeps and got no answer it can run on) is RED on dashboard v2 Monitoring, check
 * `campaign-engine-held` in the box-checks registry (`lib/box-checks.ts`, the Box watchdogs tile). Red ONLY while broken:
 * a (campaign, Engine) counts when its LATEST answer within the last hour was a refusal; one good answer after it clears it.
 *
 * In memory: `/internal/script-strategy` notes every answer (`noteEngineAnswer`); a loop writes one run every 10 minutes
 * (first a minute after listen). A restart forgets the past answers: the runner asks again within minutes, so a campaign
 * still held turns red again on the next write.
 */
import type { BoxCheckRun } from "./box-checks.js";
import { upsertBoxCheckRuns } from "./box-checks-store.js";

export const ENGINE_HELD_CHECK = "campaign-engine-held";
export const ENGINE_HELD_CADENCE_MINUTES = 10;
/** An answer older than this says nothing about now. */
export const ENGINE_HELD_WINDOW_MS = 60 * 60_000;

export interface EngineAnswer {
  /** The campaign row the runner named (a unit id). */
  campaignId: string;
  outcome: string;
  /** null = the runner got its scripts; else the refusal reason served. */
  heldReason: string | null;
  at: number;
}

const latest = new Map<string, EngineAnswer>();

export function noteEngineAnswer(campaignId: string, outcome: string, heldReason: string | null, at = Date.now()): void {
  latest.set(`${campaignId}|${outcome}`, { campaignId, outcome, heldReason, at });
  if (latest.size > 20_000) {
    for (const [k, v] of latest) if (at - v.at > ENGINE_HELD_WINDOW_MS) latest.delete(k);
  }
}

export function __resetEngineAnswersForTest(): void {
  latest.clear();
}

export function engineAnswersNow(): EngineAnswer[] {
  return [...latest.values()];
}

/** PURE: the box-check run for the answers held now. */
export function engineHeldRun(answers: readonly EngineAnswer[], now: number): BoxCheckRun {
  const recent = answers.filter((a) => now - a.at <= ENGINE_HELD_WINDOW_MS);
  const held = recent.filter((a) => a.heldReason !== null).sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : a.outcome < b.outcome ? -1 : 1));
  const campaigns = new Set(held.map((a) => a.campaignId)).size;
  return {
    check: ENGINE_HELD_CHECK,
    ranAt: new Date(now).toISOString(),
    ok: held.length === 0,
    reason:
      held.length === 0
        ? `Every campaign Engine that asked in the last hour could run (${recent.length} asked).`
        : `${campaigns} campaign${campaigns === 1 ? "" : "s"} cannot run ${held.length === 1 ? "an Engine" : `${held.length} Engines`}: ${held
            .slice(0, 5)
            .map((a) => `${a.outcome} on ${a.campaignId} (${a.heldReason})`)
            .join(", ")}${held.length > 5 ? ", ..." : ""}.`,
    cadenceMinutes: ENGINE_HELD_CADENCE_MINUTES,
    label: "Campaign Engines held",
    value: held.length,
    unit: "engines",
    details: { held: held.slice(0, 100).map((a) => ({ campaignId: a.campaignId, outcome: a.outcome, reason: a.heldReason, at: new Date(a.at).toISOString() })), asked: recent.length },
  };
}

let started = false;
export function startEngineHeldMonitor(): void {
  if (started) return;
  started = true;
  const tick = () => {
    const run = engineHeldRun(engineAnswersNow(), Date.now());
    upsertBoxCheckRuns([run], new Date()).catch((err) => console.error(`[features-service] ${ENGINE_HELD_CHECK} write failed:`, err));
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, ENGINE_HELD_CADENCE_MINUTES * 60_000).unref();
}
