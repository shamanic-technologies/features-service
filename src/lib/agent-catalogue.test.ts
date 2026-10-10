import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildCatalogueModel,
  byRoi,
  roiBasisOf,
  channelEconomics,
  funnelById,
  funnelEconomics,
  funnelIdOf,
  funnelsOfPath,
  funnelTypeOf,
  matchesQuery,
  pathEconomics,
  pathLine,
  phosphorIconOf,
  STEP_ICONS,
  FAMILY_GLYPHS,
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
    // The COST is measured; the ROI divides a step value (stated lifetime revenue): estimated.
    expect(cold.economics).toEqual({ status: "measured", costUsd: 40, roi: 3.75, reason: null, estimates: ["step_value"] });
    const ads = model.pipes.get("google-ads|start_to_website_visit")!;
    expect(ads.economics.status).toBe("learning");
    expect(ads.economics.costUsd).toBeNull();
    const team = [...model.pipes.values()].find((p) => p.operatedBy === "customer")!;
    expect(team.economics.status).toBe("customer_time");
  });

  it("prices a funnel per paying client with the sales-path formula", () => {
    const f = funnelById(model, "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    // needed: paid 1, attended 5, booked 6.667, conversation 22.22. cost = 2 x 6.667 + 40 x 22.22 = 902.22.
    // Both pipes are measured, but legs 2-4 convert at default rates: the cost per paying client is ESTIMATED.
    expect(f.economics.status).toBe("estimated");
    expect(f.economics.estimates).toEqual([
      "rate:conversation_to_meeting_booked",
      "rate:meeting_booked_to_meeting_attended",
      "rate:meeting_attended_to_paid_client",
      "lifetime_revenue",
    ]);
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
    expect(e.status).toBe("estimated");
    expect(e.bestFunnelId).toContain("@sales-cold-email-outreach");
    expect(channelEconomics(model, "ai-meeting-booking").costUsd).toBe(2);
    expect(stepEconomics(model, "meeting_booked")).toMatchObject({ status: "measured", costUsd: 2, roi: 225 });
  });

  it("ranks a fully measured figure above any estimate, however high the estimate", () => {
    const measured = { status: "measured" as const, costUsd: 100, roi: 1.1, reason: null, estimates: [] };
    const estimate = { status: "estimated" as const, costUsd: 10, roi: 50, reason: null, estimates: ["rate:x"] };
    const learning = { status: "learning" as const, costUsd: null, roi: null, reason: "x", estimates: [] };
    const rows = [
      { id: "e", e: estimate },
      { id: "l", e: learning },
      { id: "m", e: measured },
    ].sort(byRoi((r) => r.e, (r) => r.id));
    expect(rows.map((r) => r.id)).toEqual(["m", "e", "l"]);
    expect(roiBasisOf(measured)).toBe("measured");
    expect(roiBasisOf(estimate)).toBe("estimated");
    expect(roiBasisOf(learning)).toBeNull();
  });

  it("figures a channel on the legs it is listed for, never on a pipe the path does not use", () => {
    const m = buildCatalogueModel(
      inputs({
        measurements: new Map([
          ["sales-cold-email-outreach|lead_found_to_conversation", mature(40, 1)],
          ["sales-cold-email-outreach|lead_found_to_website_visit", mature(3, 5)],
        ]),
      }),
    );
    const all = channelEconomics(m, "sales-cold-email-outreach");
    expect(all.bestPipeId).toBe("sales-cold-email-outreach|lead_found_to_website_visit");
    const onReplyPath = channelEconomics(m, "sales-cold-email-outreach", new Set(["lead_found_to_conversation"]));
    expect(onReplyPath).toMatchObject({ costUsd: 40, bestPipeId: "sales-cold-email-outreach|lead_found_to_conversation" });
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

describe("a sales funnel's type (owner 2026-10-10: Proactive when at least one pipe is proactive, else Reactive)", () => {
  const model = buildCatalogueModel(inputs());

  it("reads Proactive on a funnel holding one proactive pipe (Epiphany: cold email from Lead found)", () => {
    const epiphany = funnelById(model, "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client")!;
    expect(epiphany).toBeDefined();
    expect(epiphany.legs[0].pipe!.mode).toBe("proactive");
    expect(funnelTypeOf(epiphany)).toBe("proactive");
  });

  it("reads Reactive when every pipe is reactive, bare legs included", () => {
    const meet = model.pipes.get("ai-meeting-booking|conversation_to_meeting_booked")!;
    expect(meet.mode).toBe("reactive");
    expect(funnelTypeOf({ legs: [{ legKey: "lead_found_to_conversation", pipe: null }, { legKey: meet.legKey, pipe: meet }] })).toBe("reactive");
    expect(funnelTypeOf({ legs: [{ legKey: "conversation_to_paid_client", pipe: null }] })).toBe("reactive");
  });

  it("every funnel the model builds states exactly one of the two types, matching its pipes", () => {
    for (const path of model.paths.values()) {
      for (const f of funnelsOfPath(model, path)) {
        const anyProactive = f.legs.some((l) => l.pipe?.mode === "proactive");
        expect(funnelTypeOf(f)).toBe(anyProactive ? "proactive" : "reactive");
      }
    }
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

describe("catalogue icons are Phosphor names only (owner 2026-10-10)", () => {
  // Checked against @phosphor-icons/react 2.1 (`dist/csr/<PascalName>`): every name the catalogue serves today.
  const PHOSPHOR = new Set([
    "address-book", "at", "bell", "bird", "calendar-check", "calendar-plus", "chat-circle", "chat-circle-text", "chat-text",
    "currency-dollar", "cursor-click", "envelope", "facebook-logo", "file-text", "flow-arrow", "funnel", "globe", "handshake",
    "instagram-logo", "linkedin-logo", "list-bullets", "magnifying-glass", "medal", "megaphone", "microphone", "newspaper",
    "note-pencil", "phone", "phone-call", "question", "rocket", "share-network", "shopping-cart", "sparkle", "target",
    "trend-up", "tray", "user-check", "user-focus", "user-plus", "users", "video", "waves", "youtube-logo",
  ]);
  it("maps the other set's spellings to the same picture", () => {
    expect(phosphorIconOf("mail")).toBe("envelope");
    expect(phosphorIconOf("share-2")).toBe("share-network");
    expect(phosphorIconOf("mic")).toBe("microphone");
    expect(phosphorIconOf("envelope")).toBe("envelope");
  });
  it("every seeded channel and step icon is served as a Phosphor name", async () => {
    const { SEED_FEATURES } = await import("../seed/features.js");
    const served = [
      ...SEED_FEATURES.map((f) => phosphorIconOf(f.icon)),
      ...Object.values(STEP_ICONS),
      ...Object.values(FAMILY_GLYPHS).filter((g): g is NonNullable<typeof g> => g !== null),
    ];
    expect([...new Set(served)].filter((i) => !PHOSPHOR.has(i))).toEqual([]);
  });
});
