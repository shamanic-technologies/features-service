import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("./ledger-book.js");
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./channel-declarations-store.js", () => ({ loadChannelCatalogue: vi.fn(async () => ({ channels: [] })) }));
const { ledgerRegime, parseLedgerBook, reconciledOf, runStartUntilOf, __resetLedgerBook } = await import("./ledger-book.js");

const c = (g: number) => ({ grossCents: String(g * 100), netCents: String(g * 100), vendorCents: "0", unpricedGrossCents: "0" });
const body = (spend: number, declared: number, daysMissing: string[] = []) => ({
  daysMissing,
  produced: [{ dimensions: { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "w" }, occurrences: 10, cost: c(declared) }],
  consumed: [{ dimensions: { consumingOutcomeKey: "conversation", consumedOutcomeKey: "message_sent", campaignId: null, workflowSlug: null, sourceCampaignId: "c1", sourceWorkflowSlug: "w" }, consumptions: "2", unknownProvenance: "0" }],
  scope: [{ dimensions: { campaignId: "c1", workflowSlug: "w" }, spend: c(spend), producedCost: c(declared), producedNone: c(spend - declared), support: c(0) }],
});

describe("the ledger regime gate (LEDGER-HISTORY-1024)", () => {
  afterEach(() => {
    __resetLedgerBook();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("parses the three reads into one book; a run with no output inside a campaign is that pipe's loss, never undeclared", () => {
    const r = parseLedgerBook(body(100, 60), body(100, 60), body(100, 60), "gross");
    expect(r.book.noOutput).toEqual([{ campaignId: "c1", workflowSlug: "w", audienceId: null, costUsd: 40 }]);
    expect(r.daysMissing).toBe(0);
    expect(reconciledOf({ reconciled: true })).toBe(true);
    expect(reconciledOf({ reconciled: "true" })).toBe(false);
    expect(reconciledOf({})).toBe(false);
    expect(runStartUntilOf("2026-10-03T00:00:00.000Z")).toBe("2026-10-02");
  });

  const answer = (reconciled: boolean, daysMissing: string[] = []) =>
    vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes("/reconciliation") ? { reconciled } : body(100, 60, daysMissing)), { status: 200 }));

  it("runs-service not reconciled = null: every reader keeps the previous regime", async () => {
    vi.stubGlobal("fetch", answer(false));
    expect(await ledgerRegime("gross")).toBeNull();
  });

  it("reconciled but the read's days still computing (or stale after a backfill) = null", async () => {
    vi.stubGlobal("fetch", answer(true, ["2026-09-01"]));
    expect(await ledgerRegime("gross")).toBeNull();
  });

  it("reconciled = the book; a later failed read serves the last good book, never flips the fleet back", async () => {
    vi.stubGlobal("fetch", answer(true));
    const first = await ledgerRegime("gross");
    expect(first?.daysMissing).toBe(0);
    __resetLedgerBookHeldOnly();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ledgerRegime("gross")).toBe(first);
    err.mockRestore();
  });
});

// clears the 15-min hold but keeps the last good book (the failure path under test)
function __resetLedgerBookHeldOnly() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 16 * 60_000);
}
