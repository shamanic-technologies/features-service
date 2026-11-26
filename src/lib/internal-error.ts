/**
 * The ONE answer to an unexpected route error (REFRESHER-DOWN-NAMED-1126). A view the request needed while the view
 * refresher is restarting (`RefresherDownError`: crashed, out of memory, respawning) is a 503 the caller can act on:
 * named `view_refresher_restarting`, `Retry-After: 60`, never a bare 500 (prod 2026-11-26 03:36 UTC: an outside agent
 * launching a campaign read `GET /offers/{id}/sales-funnels` twice and got `500 Internal server error` both times). Any
 * other error stays the 500 it was.
 */
import type { Response } from "express";
import { RefresherDownError } from "./view-refresher.js";

export const REFRESHER_RETRY_AFTER_SECONDS = 60;

/** The `RefresherDownError` in `err` or its `cause` chain, else null. */
export function refresherDownIn(err: unknown): RefresherDownError | null {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof RefresherDownError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Answers a refresher-down error as a named, retryable 503 and returns true; anything else returns false untouched. */
export function answerRefresherDown(res: Response, err: unknown): boolean {
  const down = refresherDownIn(err);
  if (!down) return false;
  res.setHeader("Retry-After", String(REFRESHER_RETRY_AFTER_SECONDS));
  res.status(503).json({ error: down.message, reason: "view_refresher_restarting", view: down.view, retryAfterSeconds: REFRESHER_RETRY_AFTER_SECONDS });
  return true;
}

/** A route's catch-all: the named 503 above, else `500 Internal server error`. */
export function answerInternalError(res: Response, err: unknown): void {
  if (answerRefresherDown(res, err)) return;
  res.status(500).json({ error: "Internal server error" });
}
