import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, funnelsOfPath, stepLabel } from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { funnelTriggerLabel } from "./funnel-descriptions.js";

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const ids = new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`)));
const model = buildCatalogueModel({ channels, publishedPipeIds: ids, declaredSteps: [], measurements: new Map(), fleetMedians: new Map(), lifetimeRevenueUsd: 3000 });
const all = [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p));
const label = (k: string) => stepLabel(model, k);
const byId = (id: string) => all.find((f) => f.id === id)!;
// A proactive funnel's id names its sourcing leg (owner 2026-10-11: one channel per leg).
const LS = "start_to_lead_found@lead-sourcing+";

describe("a reactive funnel names what starts it, in customer words", () => {
  it("Positive replies on a funnel answering replies; nothing on a proactive one", () => {
    expect(funnelTriggerLabel(byId("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client"), label)).toBe("Positive replies");
    expect(funnelTriggerLabel(byId(`${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`), label)).toBeNull();
  });
});
