import { describe, expect, it } from "vitest";
import { assertLegTriggersDeclared, CHANNEL_TRIGGER_TYPES, UndeclaredLegTriggerError } from "./channel-triggers.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { isReplayableIdentity } from "./identity-headers.js";

const CATALOGUE = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));

describe("every leg states proactive or reactive, and a reactive leg names one declared trigger (owner 2026-10-09)", () => {
  it("every SEEDED leg states its mode explicitly (no blob relies on the legacy derivation)", () => {
    for (const f of SEED_FEATURES) {
      for (const t of f.acquisitionChannel?.stepTransitions ?? []) {
        expect(t.mode, `${f.slug} ${t.from}>${t.to}`).toBeDefined();
        expect(t.mode === "proactive" ? t.triggerId === null : typeof t.triggerId === "string", `${f.slug} ${t.from}>${t.to}`).toBe(true);
      }
    }
  });

  it("the owner's examples", () => {
    const leg = (slug: string) => CATALOGUE.find((c) => c.slug === slug)!.stepTransitions;
    expect(leg("sales-cold-email-outreach").map((t) => [t.mode, t.triggerId])).toEqual([
      ["proactive", null],
      ["proactive", null],
    ]);
    expect(leg("google-ads").every((t) => t.mode === "proactive")).toBe(true);
    expect(leg("sourcing-apollo-cold-filters").map((t) => [t.mode, t.triggerId])).toEqual([["reactive", "lead_requested"]]);
    expect(leg("ai-meeting-booking").map((t) => [t.mode, t.triggerId])).toEqual([["reactive", "positive_reply_received"]]);
    expect(leg("ai-instant-call").map((t) => [t.mode, t.triggerId])).toEqual([["reactive", "positive_reply_received"]]);
    expect(leg("agency-meeting-attendance").map((t) => [t.mode, t.triggerId])).toEqual([["reactive", "meeting_booked"]]);
  });

  it("every channel we RUN names only a trigger a service fires today", () => {
    for (const c of CATALOGUE.filter((c) => c.managed)) {
      for (const t of c.stepTransitions.filter((t) => t.mode === "reactive")) {
        expect(CHANNEL_TRIGGER_TYPES.find((x) => x.id === t.triggerId)?.coded, `${c.slug} ${t.legKey}`).toBe(true);
      }
    }
  });

  it("refuses a leg that cannot run: unknown trigger, reactive without one, proactive with one, managed on an uncoded one", () => {
    const leg = { slug: "x", legKey: "a_to_b", managed: false };
    expect(() => assertLegTriggersDeclared([{ ...leg, mode: "reactive", triggerId: "nope" }])).toThrow(UndeclaredLegTriggerError);
    expect(() => assertLegTriggersDeclared([{ ...leg, mode: "reactive", triggerId: null }])).toThrow(UndeclaredLegTriggerError);
    expect(() => assertLegTriggersDeclared([{ ...leg, mode: "proactive", triggerId: "lead_requested" }])).toThrow(UndeclaredLegTriggerError);
    expect(() => assertLegTriggersDeclared([{ ...leg, managed: true, mode: "reactive", triggerId: "meeting_booked" }])).toThrow(UndeclaredLegTriggerError);
    expect(() => assertLegTriggersDeclared([{ ...leg, mode: "reactive", triggerId: "meeting_booked" }])).not.toThrow();
  });

  it("every icon is a REAL Phosphor icon name (verified against @phosphor-icons/core 2.x assets, 2026-10-09)", () => {
    // The dashboard maps Phosphor names only; an unknown token renders the label alone. A new trigger's icon
    // is checked against https://unpkg.com/@phosphor-icons/core@2/assets/regular/<name>.svg, then added here.
    const VERIFIED_PHOSPHOR = new Set(["user-focus", "thumbs-up", "cursor-click", "calendar-check", "handshake", "user-plus", "clipboard-text"]);
    for (const t of CHANNEL_TRIGGER_TYPES) expect(VERIFIED_PHOSPHOR.has(t.icon), `${t.id}: ${t.icon}`).toBe(true);
  });

  it("trigger ids are unique and every one has a label and an icon", () => {
    expect(new Set(CHANNEL_TRIGGER_TYPES.map((t) => t.id)).size).toBe(CHANNEL_TRIGGER_TYPES.length);
    for (const t of CHANNEL_TRIGGER_TYPES) expect(t.label.length * t.icon.length * t.description.length).toBeGreaterThan(0);
  });
});

describe("a probe's nil-UUID identity is never replayed for other reads", () => {
  it("refuses the nil UUID, keeps a real one", () => {
    const real = { "x-org-id": "d4cbcbd5-35ad-4634-919d-7dbd40f76a59", "x-user-id": "0b0b0b0b-0000-4000-8000-00000000000b", "x-run-id": "0c0c0c0c-0000-4000-8000-00000000000c" };
    expect(isReplayableIdentity(real)).toBe(true);
    expect(isReplayableIdentity({ ...real, "x-user-id": "00000000-0000-0000-0000-000000000000" })).toBe(false);
  });
});
