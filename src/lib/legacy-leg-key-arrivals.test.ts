/**
 * The switch-off measurement of the outbound leg rename (`lib/legacy-leg-key-arrivals.ts`): every LEGACY
 * outbound leg key that arrives writes one `legacy-outbound-leg-key` warn line; the new spelling, a
 * non-outbound channel's `start_to_*` and a channel-less funnel leg write none; the request is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  LEGACY_OUTBOUND_LEG_KEY_MARKER,
  legacyLegKeyArrivalsMiddleware,
  legacyOutboundLegKeysIn,
} from "./legacy-leg-key-arrivals.js";

const COLD = "sales-cold-email-outreach";

describe("which keys are a legacy outbound arrival", () => {
  it("finds a legacy key on an outbound channel, from the context or the key itself", () => {
    expect(legacyOutboundLegKeysIn("start_to_conversation", COLD)).toEqual([{ legKey: "start_to_conversation", channel: COLD }]);
    expect(legacyOutboundLegKeysIn({ featureSlug: "cold-linkedin-outreach", legKey: "start_to_website_visit" })).toEqual([
      { legKey: "start_to_website_visit", channel: "cold-linkedin-outreach" },
    ]);
    expect(legacyOutboundLegKeysIn([`start_to_conversation@${COLD}+conversation_to_meeting_booked`])).toEqual([
      { legKey: "start_to_conversation", channel: COLD },
    ]);
    expect(legacyOutboundLegKeysIn(`campaign:${COLD}|start_to_conversation`)).toEqual([{ legKey: "start_to_conversation", channel: COLD }]);
    expect(legacyOutboundLegKeysIn({ start_to_conversation: 1 }, COLD)).toEqual([{ legKey: "start_to_conversation", channel: COLD }]);
  });

  it("finds nothing for the new spelling, a non-outbound channel, or no channel at all", () => {
    expect(legacyOutboundLegKeysIn("lead_found_to_conversation", COLD)).toEqual([]);
    expect(legacyOutboundLegKeysIn("start_to_website_visit", "google-ads")).toEqual([]);
    expect(legacyOutboundLegKeysIn({ featureSlug: "google-ads", legKey: "start_to_website_visit" }, COLD)).toEqual([]);
    expect(legacyOutboundLegKeysIn("start_to_website_visit@google-ads", COLD)).toEqual([]);
    expect(legacyOutboundLegKeysIn("start_to_conversation")).toEqual([]);
    expect(legacyOutboundLegKeysIn("start_to_lead_found", COLD)).toEqual([]);
  });
});

describe("a request carrying a legacy outbound key", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const app = express();
  app.use(express.json());
  app.use(legacyLegKeyArrivalsMiddleware);
  app.get("/features/:slug/workflow-projection", (req, res) => res.json({ leg: req.query.leg }));
  app.get("/public/stats/leg-workflow-ranking", (req, res) => res.json({ leg: req.query.leg }));
  app.put("/internal/workflow-leg-assignments", (req, res) => res.json({ legKey: req.body.legKey }));

  const lines = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes(LEGACY_OUTBOUND_LEG_KEY_MARKER));

  it("answers the same and logs ONE line with the key, route and caller", async () => {
    const res = await request(app)
      .get(`/features/${COLD}/workflow-projection?leg=start_to_conversation`)
      .set("x-org-id", "org-1")
      .set("x-run-id", "run-1")
      .set("x-service-name", "campaign-service");
    expect(res.body).toEqual({ leg: "start_to_conversation" });
    expect(lines()).toHaveLength(1);
    const payload = JSON.parse(lines()[0].split(`${LEGACY_OUTBOUND_LEG_KEY_MARKER} `)[1]);
    expect(payload).toEqual({
      legKey: "start_to_conversation",
      channel: COLD,
      source: "request",
      route: `GET /features/${COLD}/workflow-projection`,
      caller: { service: "campaign-service", orgId: "org-1", runId: "run-1" },
    });
  });

  it("reads the channel from ?featureSlug= and from the body", async () => {
    await request(app).get(`/public/stats/leg-workflow-ranking?featureSlug=${COLD}&leg=start_to_website_visit`);
    await request(app).put("/internal/workflow-leg-assignments").send({ featureSlug: COLD, legKey: "start_to_conversation" });
    expect(lines()).toHaveLength(2);
  });

  it("logs nothing for the new spelling or google-ads' start_to_*", async () => {
    await request(app).get(`/features/${COLD}/workflow-projection?leg=lead_found_to_conversation`);
    await request(app).get("/features/google-ads/workflow-projection?leg=start_to_website_visit");
    await request(app).get("/public/stats/leg-workflow-ranking?featureSlug=google-ads&leg=start_to_website_visit");
    expect(lines()).toHaveLength(0);
  });
});
