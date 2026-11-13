import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { BoxCheckRunSchema } from "./box-checks.js";
import { ENGINE_HELD_CHECK, engineHeldRun } from "./engine-held-monitor.js";

const now = Date.parse("2026-11-11T12:00:00Z");

describe("campaign-engine-held: red on Monitoring only while an Engine cannot run (NO-BRIEF-UNBLOCK-1111)", () => {
  it("green when every recent answer ran (nothing asked = green too)", () => {
    const r = engineHeldRun([{ campaignId: "c1", outcome: "message_written", heldReason: null, at: now - 60_000 }], now);
    expect(r).toMatchObject({ check: ENGINE_HELD_CHECK, ok: true, value: 0 });
    expect(engineHeldRun([], now).ok).toBe(true);
    expect(BoxCheckRunSchema.safeParse(r).success).toBe(true);
  });
  it("red with each held (campaign, Engine) named; an answer older than an hour says nothing", () => {
    const r = engineHeldRun(
      [
        { campaignId: "c1", outcome: "message_written", heldReason: "script_strategy_unreadable", at: now - 5 * 60_000 },
        { campaignId: "c2", outcome: "lead_found", heldReason: "campaign_states_no_campaign", at: now - 2 * 3_600_000 },
      ],
      now,
    );
    expect(r).toMatchObject({ ok: false, value: 1 });
    expect(r.reason).toMatch(/1 campaign cannot run an Engine: message_written on c1 \(script_strategy_unreadable\)/);
    expect(BoxCheckRunSchema.safeParse(r).success).toBe(true);
  });
  it("a hold its service calls expected (out of credit, ceiling reached) is never red, counted apart (MON-HELD-FALSE-1113)", () => {
    const r = engineHeldRun(
      [
        { campaignId: "c1", outcome: "message_written", heldReason: "Insufficient credits", expected: true, at: now - 60_000 },
        { campaignId: "c2", outcome: "message_written", heldReason: "daily_ceiling_reached", expected: true, at: now - 60_000 },
        { campaignId: "c3", outcome: "message_written", heldReason: "daily_ceiling_reached", expected: true, at: now - 60_000 },
      ],
      now,
    );
    expect(r).toMatchObject({ ok: true, value: 0, details: { heldOnPurpose: 3, heldOnPurposeByReason: { "Insufficient credits": 1, daily_ceiling_reached: 2 } } });
    expect(r.reason).toMatch(/3 held on purpose: 2 daily_ceiling_reached, 1 Insufficient credits/);
    const mixed = engineHeldRun(
      [
        { campaignId: "c1", outcome: "message_written", heldReason: "Insufficient credits", expected: true, at: now - 60_000 },
        { campaignId: "c4", outcome: "message_written", heldReason: "budgets_unreadable", at: now - 60_000 },
      ],
      now,
    );
    expect(mixed).toMatchObject({ ok: false, value: 1 });
    expect(mixed.reason).toMatch(/budgets_unreadable/);
    expect(BoxCheckRunSchema.safeParse(r).success).toBe(true);
  });
});
