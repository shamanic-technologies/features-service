/**
 * Per-(org, brand) HISTORY reads for the customer-health board's `notTrackedYet` slots that are now
 * tracked upstream:
 *   - daily-budget change history → billing-service  GET /internal/brands/:brandId/daily-budget/history
 *   - pause on/off history        → campaign-service GET /brands/:brandId/pause-history
 *
 * Both are org-scoped service reads (x-api-key + x-org-id), forward-only (entries begin when each
 * producer shipped the feature — a brand with no changes since returns an empty array, a legitimate
 * state, never a fabricated backfill). Shapes conform to the DEPLOYED producer contracts (verified live
 * via api-registry), not a guess: billing returns `{ brandId, history:[{dailyBudgetCents, changedAt}] }`
 * (cents → USD here); campaign returns `{ brandId, orgId, transitions:[{paused, transitionedAt}] }`.
 *
 * The clients themselves FAIL LOUD (throw on missing config / transport / non-OK / malformed); the board
 * builder wraps each call fail-SOFT (→ null) so a billing/campaign blip degrades only its own column,
 * never the whole board (mirrors the PostHog dashboard-return degrade).
 */
import { fetchWithRetry } from "./fetch-retry.js";

/** One daily-budget change: the brand's per-day spend ceiling BECAME `dailyBudgetUsd` at `changedAt`. */
export interface BudgetChangeEntry {
  /** The daily budget in USD after this change (billing's cents / 100). 0 = explicit pause. */
  dailyBudgetUsd: number;
  /** ISO timestamp the budget was set to this value. */
  changedAt: string;
}

/** One pause flip: the brand's campaigns became `paused` (true) or resumed (false) at `transitionedAt`. */
export interface PauseTransition {
  /** New pause state AFTER this flip (true = paused, false = resumed). */
  paused: boolean;
  /** ISO timestamp of the flip. */
  transitionedAt: string;
}

/**
 * Ordered (oldest-first) daily-budget change history for one (org, brand), from billing-service
 * `GET /internal/brands/:brandId/daily-budget/history` (x-api-key + x-org-id). Empty array when the
 * brand has had no budget changes since the feature shipped. Fails loud on any transport / non-OK /
 * malformed response.
 */
export async function fetchBudgetChangeHistory(brandId: string, orgId: string): Promise<BudgetChangeEntry[]> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  }
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/daily-budget/history`,
    { headers: { "x-api-key": apiKey, "x-org-id": orgId } },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`billing-service daily-budget history failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { history?: Array<{ dailyBudgetCents?: number | string; changedAt?: string }> };
  if (!Array.isArray(data.history)) {
    throw new Error("billing-service daily-budget history returned no history array");
  }
  return data.history.map((h) => {
    const cents = Number(h.dailyBudgetCents);
    if (!Number.isFinite(cents)) {
      throw new Error(`billing-service daily-budget history non-numeric dailyBudgetCents: ${JSON.stringify(h.dailyBudgetCents)}`);
    }
    if (typeof h.changedAt !== "string") {
      throw new Error("billing-service daily-budget history entry missing changedAt");
    }
    return { dailyBudgetUsd: cents / 100, changedAt: h.changedAt };
  });
}

/**
 * Ordered (oldest-first) pause on/off transition history for one (org, brand), from campaign-service
 * `GET /brands/:brandId/pause-history` (x-api-key + x-org-id). Empty array when the brand has had no
 * pause flips since the feature shipped. Fails loud on any transport / non-OK / malformed response.
 */
export async function fetchPauseHistory(brandId: string, orgId: string): Promise<PauseTransition[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  }
  const response = await fetchWithRetry(
    `${url}/brands/${encodeURIComponent(brandId)}/pause-history`,
    { headers: { "x-api-key": apiKey, "x-org-id": orgId } },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`campaign-service pause-history failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { transitions?: Array<{ paused?: boolean; transitionedAt?: string }> };
  if (!Array.isArray(data.transitions)) {
    throw new Error("campaign-service pause-history returned no transitions array");
  }
  return data.transitions.map((t) => {
    if (typeof t.transitionedAt !== "string") {
      throw new Error("campaign-service pause-history entry missing transitionedAt");
    }
    return { paused: t.paused === true, transitionedAt: t.transitionedAt };
  });
}
