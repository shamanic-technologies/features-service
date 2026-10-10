import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, funnelsOfPath, stepLabel } from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { describeFunnel, funnelTriggerLabel, mediumOf } from "./funnel-descriptions.js";

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const ids = new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`)));
const model = buildCatalogueModel({ channels, publishedPipeIds: ids, declaredSteps: [], measurements: new Map(), fleetMedians: new Map(), lifetimeRevenueUsd: 3000 });
const all = [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p));
const label = (k: string) => stepLabel(model, k);
const byId = (id: string) => all.find((f) => f.id === id)!;

describe("one customer sentence per sales funnel (owner 2026-10-11)", () => {
  it("is unique over the whole catalogue: two funnels never share a sentence", () => {
    const sentences = all.map((f) => describeFunnel(f, channels, label));
    expect(all.length).toBeGreaterThan(500);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("is customer copy: one sentence, no internal word, no dash", () => {
    for (const f of all) {
      const s = describeFunnel(f, channels, label);
      expect(s).toMatch(/^[A-Z][^.]*\.$/);
      expect(s).not.toMatch(/funnel|pipe|\bleg\b|workflow|—|–|undefined|null/i);
    }
  });

  it("reads the five named funnels as the Campaigns page shows them", () => {
    expect(describeFunnel(byId("lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client"), channels, label)).toBe(
      "We reach buyers through cold email outreach, start conversations with those who reply with interest, and you close the sale.",
    );
    expect(describeFunnel(byId("lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client"), channels, label)).toBe(
      "We reach buyers through cold email outreach, bring them to your website, they buy online, and they become paying clients.",
    );
    const motivate = byId("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client");
    expect(describeFunnel(motivate, channels, label)).toBe(
      "When a buyer replies with interest, our AI books a meeting with them, your team makes sure they show up, and your team closes the deal.",
    );
    expect(funnelTriggerLabel(motivate, label)).toBe("Positive replies");
    expect(funnelTriggerLabel(byId("lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client"), label)).toBeNull();
  });

  it("names a channel as a medium", () => {
    expect(mediumOf("Sales Cold Email Outreach")).toBe("cold email");
    expect(mediumOf("Cold LinkedIn Outreach")).toBe("cold LinkedIn");
    expect(mediumOf("Google Ads")).toBe("Google ads");
  });
});
