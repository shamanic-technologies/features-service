/**
 * IO of the most Units a campaign's brief allows per Engine (BRIEF-DAILY-CAP-1125; rules in `brief-most-units.ts`, PURE).
 *
 * `askBriefMostUnits` is the ONE Jev call (a yes/no, the period, one choice per digit, in one request).
 * `mostUnitsOfCampaign` is the live pass (called by `engineStrategyOfCampaign` only, the read that already may ask Jev):
 * the stored answer, re-asked and stored when the brief or the rule moved. Every other reader takes the STORED answers
 * (`brief-most-units-store.ts`) and never asks. A failure throws: the caller fails closed like the strategy judge
 * (never a silent "no cap").
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { BRIEF_MOST_UNITS_SUPPORT } from "./platform-caller.js";
import type { RunnableScript } from "./script-catalogue-client.js";
import { MOST_UNITS_RULE, briefMostUnitsNeed, briefMostUnitsQuestions, briefMostUnitsState, mostUnitsOf, mostUnitsOfAnswers, type MostUnits, type StoredBriefMostUnits } from "./brief-most-units.js";
import { readBriefMostUnits, writeBriefMostUnits } from "./brief-most-units-store.js";

const JEV_TIMEOUT_MS = 60_000;

/** Jev: does the brief state a most number of Units of this Engine's outcome per day, week or month, and which. */
export async function askBriefMostUnits(state: Record<string, unknown>): Promise<Pick<StoredBriefMostUnits, "units" | "per" | "probability" | "confidence" | "model">> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: briefMostUnitsQuestions(), support: BRIEF_MOST_UNITS_SUPPORT }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Parameters<typeof mostUnitsOfAnswers>[0] };
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  return { ...mostUnitsOfAnswers(body.answers), model: body.model };
}

/**
 * The LIVE pass: the most Units this campaign's brief allows on one Engine; null = no cap. The stored answer stands while
 * the brief (and the rule) are unchanged; else Jev is asked once and the answer stored. No brief = no call.
 */
export async function mostUnitsOfCampaign(
  campaign: { campaignId: string; orgId: string },
  engine: { outcome: string; label: string },
  brief: string | null,
  briefHash: string | null,
  scriptsNow: () => Promise<readonly RunnableScript[]>,
): Promise<MostUnits | null> {
  const stored = await readBriefMostUnits(campaign.campaignId, engine.outcome);
  const need = briefMostUnitsNeed(stored, briefHash);
  if (need === "none") return null;
  if (need === "stored") return mostUnitsOf(stored);
  const answer = await askBriefMostUnits(briefMostUnitsState(brief!, engine, await scriptsNow()));
  const next = { campaignId: campaign.campaignId, outcome: engine.outcome, orgId: campaign.orgId, ...answer, briefHash: briefHash!, rule: MOST_UNITS_RULE };
  await writeBriefMostUnits(next);
  const now = mostUnitsOf(next);
  console.log(`[features-service] brief of campaign ${campaign.campaignId} read for a most number of Units on Engine ${engine.outcome}: ${now ? `${now.units} per ${now.per}` : "none stated"} (${answer.probability})`);
  return now;
}
