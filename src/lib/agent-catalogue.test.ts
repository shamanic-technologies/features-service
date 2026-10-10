import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildCatalogueModel,
  channelEconomics,
  funnelById,
  funnelEconomics,
  funnelIdOf,
  funnelsOfPath,
  matchesQuery,
  pathEconomics,
  pathLine,
  stepEconomics,
  type CatalogueInputs,
  type PipeMeasurement,
} from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { registerDeclaredSteps } from "./acquisition-channels.js";
import { registerDeclaredLegRates } from "./default-leg-rates.js";
import { mergeDeclarations, type DeclaredLeg } from "./channel-declarations.js";
import { channelShortDescription } from "./channel-short-descriptions.js";
import { channelTypeOf } from "./channel-types.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";

const SEEDED = SEED_FEATURES.filter((f) => f.status === "active");
const channels = buildChannelCatalogue(SEEDED);
const allPipeIds = (cs = channels) => new Set(cs.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`)));

const mature = (costPerOutcomeUsd: number, conversionRatePct: number): PipeMeasurement => ({ basis: "mature", costPerOutcomeUsd, conversionRatePct, workflowDynastySlug: "w" });

const inputs = (over: Partial<CatalogueInputs> = {}): CatalogueInputs => ({
  channels,
  publishedPipeIds: allPipeIds(),
  declaredSteps: [],
  measurements: new Map([
    ["sales-cold-email-outreach|lead_found_to_conversation", mature(40, 1)],
    ["ai-meeting-booking|conversation_to_meeting_booked", mature(2, 30)],
  ]),
  fleetMedians: new Map(),
  lifetimeRevenueUsd: 3000,
  ...over,
});

describe("the agent catalogue model", () => {
  const model = buildCatalogueModel(inputs());

  it("enumerates sales paths from an entry leg to Paid client, sourcing never a leg of one", () => {
    expect(model.paths.size).toBeGreaterThan(10);
    for (const p of model.paths.values()) {
      expect(p.steps[p.steps.length - 1]).toBe("paid_client");
      expect(p.legKeys.some((l) => l.endsWith("_to_lead_found"))).toBe(false);
    }
    // The funnel named Victory is one of them, keyed exactly as its stored name row.
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    expect(funnelById(model, victory)?.id).toBe(victory);
  });

  it("values a step as LTR x the best rated route to Paid client", () => {
    // meeting_attended -> paid 20%: 3000 x 0.2 = 600; meeting_booked -> attended 75%: 450.
    expect(model.steps.get("paid_client")!.valueUsd).toBe(3000);
    expect(model.steps.get("meeting_attended")!.valueUsd).toBe(600);
    expect(model.steps.get("meeting_booked")!.valueUsd).toBe(450);
    // conversation: max(direct 5% x 3000 = 150, 30% x 450 = 135, booking call 60% x 40% x 450 = 108) = 150.
    expect(model.steps.get("conversation")!.valueUsd).toBe(150);
    // lead_found: the cold-email leg's measured 1% x 150 = 1.5.
    expect(model.steps.get("lead_found")!.valueUsd).toBe(1.5);
  });

  it("prices a measured pipe on its mature cost, roi = value of its step / cost; unmeasured is learning", () => {
    const cold = model.pipes.get("sales-cold-email-outreach|lead_found_to_conversation")!;
    expect(cold.economics).toEqual({ status: "measured", costUsd: 40, roi: 3.75, reason: null });
    const ads = model.pipes.get("google-ads|start_to_website_visit")!;
    expect(ads.economics.status).toBe("learning");
    expect(ads.economics.costUsd).toBeNull();
    const team = [...model.pipes.values()].find((p) => p.operatedBy === "customer")!;
    expect(team.economics.status).toBe("customer_time");
  });

  it("prices a funnel per paying client with the sales-path formula", () => {
    const f = funnelById(model, "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    // needed: paid 1, attended 5, booked 6.667, conversation 22.22. cost = 2 x 6.667 + 40 x 22.22 = 902.22.
    expect(f.economics.status).toBe("measured");
    expect(f.economics.costUsd).toBeCloseTo(902.22, 1);
    expect(f.economics.roi).toBeCloseTo(3000 / 902.22, 2);
  });

  it("states learning, never a guessed figure, as soon as one platform pipe is unmeasured", () => {
    const path = [...model.paths.values()].find((p) => p.legKeys[0] === "start_to_website_visit" && p.legKeys.includes("website_visit_to_signup"))!;
    const ads = funnelsOfPath(model, path).find((f) => f.channelSlugs.includes("google-ads"))!;
    expect(ads.economics.status).toBe("learning");
    expect(ads.economics.reason).toMatch(/^pipe_learning:/);
  });

  it("serves a path its best measured funnel, a channel its best measured pipe, a step its cheapest producing pipe", () => {
    const path = [...model.paths.values()].find((p) => p.id === "lead_found_to_conversation+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    expect(pathLine(model, path)).toBe("Lead found → Positive reply → Meeting booked → Meeting attended → Paid client");
    const e = pathEconomics(model, path);
    expect(e.status).toBe("measured");
    expect(e.bestFunnelId).toContain("@sales-cold-email-outreach");
    expect(channelEconomics(model, "ai-meeting-booking").costUsd).toBe(2);
    expect(stepEconomics(model, "meeting_booked")).toMatchObject({ status: "measured", costUsd: 2, roi: 225 });
  });

  it("matches a query word by word, case-insensitive", () => {
    expect(matchesQuery("cold EMAIL", ["Sales Cold Email"])).toBe(true);
    expect(matchesQuery("linkedin post", ["LinkedIn Ads"])).toBe(false);
    expect(matchesQuery(undefined, [])).toBe(true);
  });

  it("keeps a list page around 2k tokens (10 rows ~ 8 KB of JSON at most)", () => {
    const rows = [...model.paths.values()].slice(0, 10).map((p) => ({ id: p.id, name: "Danube", icon: "waves", color: "#E0784B", line: pathLine(model, p), costUsd: 902.22, roi: 3.33, status: "measured" }));
    expect(JSON.stringify({ object: "sales_path", total: 40, truncated: true, rows }).length).toBeLessThan(8000);
  });
});

describe("a step declared at run time ('LinkedIn post') rides legs, paths and values like a coded one", () => {
  registerDeclaredSteps([{ key: "linkedin_post" as never, label: "LinkedIn post", description: "A post published on LinkedIn.", shortDescription: "Posts on LinkedIn" }]);
  registerDeclaredLegRates([{ fromStep: "linkedin_post", toStep: "conversation", ratePct: 2 }]);
  const legs: DeclaredLeg[] = [
    { channelSlug: "organic-linkedin-publishing", legKey: "start_to_linkedin_post", fromStep: null, toStep: "linkedin_post" as never, mode: "proactive", triggerId: null, published: false, createdBy: "t", requestedByOrgId: null, createdAt: "", updatedAt: "" },
    { channelSlug: "organic-linkedin-publishing", legKey: "linkedin_post_to_conversation", fromStep: "linkedin_post" as never, toStep: "conversation", mode: "proactive", triggerId: null, published: false, createdBy: "t", requestedByOrgId: null, createdAt: "", updatedAt: "" },
  ];
  const merged = mergeDeclarations(SEEDED, { channels: [], legs, triggers: [] }, { publishedOnly: false }, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
  const withPost = buildChannelCatalogue(merged.rows, merged.shortDescriptionOf, merged.channelTypeOfSlug, merged.triggerOf);
  const model = buildCatalogueModel(
    inputs({
      channels: withPost,
      declaredSteps: [{ key: "linkedin_post", label: "LinkedIn post", description: "A post published on LinkedIn.", shortDescription: "Posts on LinkedIn", icon: "linkedin-logo", towardStep: "conversation", towardRatePct: 2, producedBy: null }],
    }),
  );

  it("lists the paths containing the step, valued through its toward step", () => {
    const paths = [...model.paths.values()].filter((p) => p.steps.includes("linkedin_post"));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].legKeys[0]).toBe("start_to_linkedin_post");
    // 2% x value(conversation) 150 = 3.
    expect(model.steps.get("linkedin_post")!.valueUsd).toBe(3);
    expect(model.steps.get("linkedin_post")!.declared).toBe(true);
    const pipe = model.pipes.get("organic-linkedin-publishing|linkedin_post_to_conversation")!;
    expect(pipe.published).toBe(false);
  });

  it("names a funnel of it with the offer read's key spelling", () => {
    const path = [...model.paths.values()].find((p) => p.steps.includes("linkedin_post"))!;
    const f = funnelsOfPath(model, path)[0];
    expect(f.id).toBe(funnelIdOf(f.legs));
    expect(f.id.startsWith("start_to_linkedin_post@organic-linkedin-publishing+linkedin_post_to_conversation@organic-linkedin-publishing")).toBe(true);
    expect(funnelEconomics(path, f.legs, 3000).status).toBe("learning");
  });
});
