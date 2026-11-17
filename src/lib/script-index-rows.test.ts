import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { bookAsOf, matureCutDayOn, recomputeScriptsEraIndexPoints, scriptIndexRows } from "./script-index-rows.js";
import { computeFleetIndexPoints } from "./fleet-indexes.js";
import { scriptKeyOf } from "./research/engine-script-performance.js";
import type { LedgerPipeBook } from "./ledger-pipe-costs.js";

const SENDER = "email_sent/dy_cold_email_signed_sender_client_brand";
const JUDGE = "email_reply_received/dy_inbound_decision";
const LEG_REPLY = "start_to_conversation";
const LEG_VISIT = "start_to_website_visit";

/**
 * Prod shape since MIGRATE-1105: the cold email script runs on campaigns stating NO leg (no pipe, no leg assignment),
 * 7,288 emails sent on 2026-11-10, a reply judge (another script) declares 5 positive replies and 1 website visit on them.
 */
function book(scale = 1): LedgerPipeBook {
  return {
    produced: [
      { outcomeKey: "email_sent", campaignId: "c-no-leg", workflowSlug: null, scriptSlug: `${SENDER}/v3`, occurrences: 7288, costUsd: 520 * scale, runStartDay: "2026-11-10" },
      { outcomeKey: "conversation", campaignId: "c-no-leg", workflowSlug: null, scriptSlug: `${JUDGE}/v1`, occurrences: 5, costUsd: 0.05 * scale, runStartDay: "2026-11-12" },
      { outcomeKey: "website_visit", campaignId: "c-no-leg", workflowSlug: null, scriptSlug: null, occurrences: 1, costUsd: 0, runStartDay: "2026-11-13" },
    ],
    noOutput: [],
    consumed: [
      { consumerKey: "conversation", consumedKey: "email_sent", campaignId: "c-no-leg", workflowSlug: null, scriptSlug: `${JUDGE}/v1`, sourceCampaignId: "c-no-leg", sourceWorkflowSlug: null, sourceScriptSlug: `${SENDER}/v3`, count: 5, runStartDay: "2026-11-12", sourceRunStartDay: "2026-11-10" },
      { consumerKey: "website_visit", consumedKey: "email_sent", campaignId: "c-no-leg", workflowSlug: null, scriptSlug: null, sourceCampaignId: "c-no-leg", sourceWorkflowSlug: null, sourceScriptSlug: `${SENDER}/v3`, count: 1, runStartDay: "2026-11-13", sourceRunStartDay: "2026-11-10" },
    ],
  };
}
const EMPTY: LedgerPipeBook = { produced: [], noOutput: [], consumed: [] };
const runnable = new Set([SENDER, JUDGE]);
const keyOf = scriptKeyOf([...runnable]);
const books = { gross: book(), vendor: book(0.5), unpriced: EMPTY };

describe("cold email indexes on the email_sent Engine's scripts (PUBLIC-INDEXES-NULL-1117)", () => {
  it("regression: no pipe, no leg assignment, no workflow → the indexes still read the script that sends", () => {
    const cut = matureCutDayOn(LEG_REPLY, "2026-11-17");
    expect(cut).toBe("2026-10-26");
    const reply = scriptIndexRows("conversation", LEG_REPLY, books, keyOf, runnable, cut);
    const visit = scriptIndexRows("website_visit", LEG_VISIT, books, keyOf, runnable, matureCutDayOn(LEG_VISIT, "2026-11-17"));
    const points = new Map(computeFleetIndexPoints({ websiteVisitRows: visit.vendor, positiveReplyRows: reply.vendor, meetingPipe: null, bestAvailableStandsIn: true }).map((p) => [p.indexSlug, p]));
    const cpr = points.get("cold-email-cost-per-positive-reply")!;
    expect(cpr).toMatchObject({ workflowDynastySlug: SENDER, outcomes: 5, contacted: 7288, status: "noise", unavailableReason: null });
    // vendor money (half of billed here) ÷ 5 replies; the judge's stage cost rides the replies
    expect(cpr.value).toBeGreaterThan(52);
    expect(cpr.value).toBeLessThan(52.1);
    expect(points.get("cold-email-positive-reply-rate")!.value).toBeCloseTo((5 / 7288) * 100, 10);
    expect(points.get("cold-email-cost-per-click")).toMatchObject({ workflowDynastySlug: SENDER, outcomes: 1, unavailableReason: null });
    expect(points.get("cold-email-click-rate")!.value).toBeCloseTo((1 / 7288) * 100, 10);
  });

  it("vendor cost unknown past the 1% tolerance: the cost reads null with its reason, the rate still reads", () => {
    const reply = scriptIndexRows("conversation", LEG_REPLY, { gross: book(), vendor: book(0.97), unpriced: book(0.03) }, keyOf, runnable, "2026-10-26");
    const points = new Map(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: reply.vendor, meetingPipe: null, bestAvailableStandsIn: true }).map((p) => [p.indexSlug, p]));
    expect(points.get("cold-email-cost-per-positive-reply")).toMatchObject({ value: null, unavailableReason: "vendor_cost_unknown", workflowDynastySlug: SENDER });
    expect(points.get("cold-email-positive-reply-rate")!.value).toBeCloseTo((5 / 7288) * 100, 10);
  });

  it("a past day reads the book as of its end: a reply declared later never moves it", () => {
    const asOf = bookAsOf(book(), "2026-11-11");
    expect(asOf.produced.map((r) => r.outcomeKey)).toEqual(["email_sent"]);
    expect(asOf.consumed).toEqual([]);
    const out = recomputeScriptsEraIndexPoints({ days: ["2026-11-09", "2026-11-11", "2026-11-12"], books, keyOf, runnable, websiteVisitLeg: LEG_VISIT, positiveReplyLeg: LEG_REPLY, meeting: null });
    const cpr = out.vendor.filter((p) => p.point.indexSlug === "cold-email-cost-per-positive-reply");
    expect(cpr.map((p) => [p.day, p.point.value === null ? p.point.unavailableReason : "value"])).toEqual([
      ["2026-11-09", "no_script_ran_yet"],
      ["2026-11-11", "no_runnable_script_with_outcome"],
      ["2026-11-12", "value"],
    ]);
    expect(cpr[2]!.point.inputs).toMatchObject({ asOfDay: "2026-11-12", costBasis: "vendor", source: "email_sent_engine_scripts" });
  });

  it("a retired script keeps its figures and is never picked", () => {
    const reply = scriptIndexRows("conversation", LEG_REPLY, books, keyOf, new Set([JUDGE]), "2026-10-26");
    const p = computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: reply.vendor, meetingPipe: null, bestAvailableStandsIn: true })[0]!;
    expect(p).toMatchObject({ value: null, unavailableReason: "nothing_runnable_on_pipe" });
  });

  it("a book row naming no run day is in no past day", () => {
    const b = book();
    const asOf = bookAsOf({ ...b, noOutput: [{ campaignId: "c-no-leg", workflowSlug: null, costUsd: 1, runStartDay: null }] }, "2026-11-12");
    expect(asOf.noOutput).toEqual([]);
  });
});
