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
  funnelMixed,
  funnelRunnable,
  legacyFunnelIdAliasOf,
  legPipes,
  legStepsOf,
  pathById,
  pipesOnLeg,
  matchesQuery,
  pathEconomics,
  pathLine,
  funnelTrigger,
  phosphorIconOf,
  STEP_ICONS,
  FAMILY_GLYPHS,
  stepEconomics,
  expectedPipeCost,
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
import { funnelTriggerLabel } from "./funnel-descriptions.js";

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
    // The sourcing pipes, each on its OWN cost per lead found (owner 2026-10-11).
    ["lead-sourcing|start_to_lead_found", mature(0.5, 100)],
    ["sourcing-apollo-cold-filters|start_to_lead_found", mature(0.2, 100)],
  ]),
  lifetimeRevenueUsd: 3000,
  ...over,
});

describe("the agent catalogue model", () => {
  const model = buildCatalogueModel(inputs());

  it("enumerates sales paths from Start to Paid client (a reactive one from its trigger step), every leg a channel", () => {
    expect(model.paths.size).toBeGreaterThan(10);
    for (const p of model.paths.values()) {
      expect(p.steps[p.steps.length - 1]).toBe("paid_client");
      // Every leg is worked by a channel (owner 2026-10-11): no leg of a path without a pipe.
      for (const l of p.legKeys) expect(pipesOnLeg(model, l).length, `${p.id}: ${l}`).toBeGreaterThan(0);
      // A proactive path starts at Start (a leg from nothing); none starts at Lead found any more.
      if (p.type === "proactive") expect(legStepsOf(model, p.legKeys[0]).fromStep, p.id).toBeNull();
      expect(p.legKeys[0].startsWith("lead_found_to_"), p.id).toBe(false);
    }
    // An outbound path starts Start -> Lead found; its former id resolves to it.
    const old = "lead_found_to_conversation+conversation_to_paid_client";
    expect(pathById(model, old)?.id).toBe(`start_to_lead_found+${old}`);
    expect(pathLine(model, pathById(model, old)!)).toBe("Start → Lead → Positive reply → Paid client");
    // The funnel named Victory is one of them: its stored id resolves to its Lead Sourcing funnel (one channel per leg).
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    expect(funnelById(model, victory)?.id).toBe(`start_to_lead_found@lead-sourcing+${victory}`);
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
    // needed: paid 1, attended 5, booked 6.667, conversation 22.22, lead found 2222.2 (1% measured reply rate).
    // cost = 2 x 6.667 + 40 x 22.22 + its source (Lead Sourcing, $0.50 a lead) 0.5 x 2222.2 = 2013.33.
    // Every pipe is measured, but legs 2-4 convert at default rates: the cost per paying client is ESTIMATED.
    expect(f.economics.status).toBe("estimated");
    expect(f.economics.estimates).toEqual([
      "rate:conversation_to_meeting_booked",
      "rate:meeting_booked_to_meeting_attended",
      "rate:meeting_attended_to_paid_client",
      "lifetime_revenue",
    ]);
    expect(f.economics.costUsd).toBeCloseTo(2013.33, 1);
    expect(f.economics.roi).toBeCloseTo(3000 / 2013.33, 2);
  });

  it("states learning, never a guessed figure, as soon as one platform pipe is unmeasured", () => {
    const path = [...model.paths.values()].find((p) => p.legKeys[0] === "start_to_website_visit" && p.legKeys.includes("website_visit_to_signup"))!;
    const ads = funnelsOfPath(model, path).find((f) => f.channelSlugs.includes("google-ads"))!;
    expect(ads.economics.status).toBe("learning");
    expect(ads.economics.reason).toMatch(/^pipe_learning:/);
  });

  it("serves a path its best measured funnel, a channel its best measured pipe, a step its cheapest producing pipe", () => {
    const path = pathById(model, "lead_found_to_conversation+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    expect(pathLine(model, path)).toBe("Start → Lead → Positive reply → Meeting booked → Meeting attended → Paid client");
    const e = pathEconomics(model, path);
    expect(e.status).toBe("estimated");
    expect(e.bestFunnelId).toContain("@sales-cold-email-outreach");
    expect(channelEconomics(model, "ai-meeting-booking").costUsd).toBe(2);
    // The value the pipe ADDS (owner 2026-10-11, `lib/value-added.ts`): a booked meeting ($450) minus the Positive
    // reply it took over ($150), over $2: 150x (was 450 / 2 = 225x, crediting it the reply cold email bought).
    expect(stepEconomics(model, "meeting_booked")).toMatchObject({ status: "measured", costUsd: 2, roi: 150 });
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
    // Website-visit legs convert at the 0.2% cold-click benchmark (owner 2026-10-14): the reply pipe is the best overall...
    const all = channelEconomics(m, "sales-cold-email-outreach");
    expect(all.bestPipeId).toBe("sales-cold-email-outreach|lead_found_to_conversation");
    // ...yet a path that only walks the visit leg is figured on the visit pipe, never on the reply one it does not use.
    const onVisitPath = channelEconomics(m, "sales-cold-email-outreach", new Set(["lead_found_to_website_visit"]));
    expect(onVisitPath).toMatchObject({ costUsd: 3, bestPipeId: "sales-cold-email-outreach|lead_found_to_website_visit" });
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

describe("every leg a channel, every proactive funnel from Start (owner 2026-10-11)", () => {
  const model = buildCatalogueModel(inputs());
  const all = [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p));
  const BLISS = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

  it("no funnel holds a leg without a channel", () => {
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) for (const l of f.legs) expect(legPipes(l).length, `${f.id}: ${l.legKey}`).toBeGreaterThan(0);
  });

  it("the legs nobody worked are the customer's own team's, each a Your Team channel", () => {
    for (const [leg, slug] of [
      ["booking_call_to_meeting_booked", "your-team-booking-calls"],
      ["conversation_to_paid_client", "your-team-reply-closing"],
      ["website_visit_to_purchase", "your-team-website"],
      ["website_visit_to_signup", "your-team-website"],
      ["website_visit_to_form_submitted", "your-team-website"],
      ["purchase_to_paid_client", "your-team-order-delivery"],
    ]) {
      // A platform channel may also work the leg (AI Follow-up Email on Positive reply -> Paid client); the customer's is Your Team.
      const on = pipesOnLeg(model, leg).filter((p) => p.operatedBy === "customer");
      expect(on.map((p) => p.channelSlug), leg).toEqual([slug]);
    }
  });

  it("a leg has at most one Your Team channel, so a customer leg is one funnel, never several", () => {
    const legs = new Set([...model.pipes.values()].map((p) => p.legKey));
    for (const l of legs) expect(pipesOnLeg(model, l).filter((p) => p.operatedBy === "customer").length, l).toBeLessThanOrEqual(1);
  });

  it("Bliss's stored id resolves to its LEAD SOURCING funnel: one channel per leg, the sourcing leg named in the id", () => {
    const bliss = funnelById(model, BLISS)!;
    expect(bliss.id).toBe(`start_to_lead_found@lead-sourcing+${BLISS}`);
    expect(legacyFunnelIdAliasOf(BLISS)).toBe(bliss.id);
    expect(funnelById(model, bliss.id)!.id).toBe(bliss.id);
    expect(bliss.pathId).toBe(`start_to_lead_found+${BLISS.replace("@sales-cold-email-outreach", "")}`);
    expect(bliss.legs.map((l) => l.pipe!.channelSlug)).toEqual(["lead-sourcing", "sales-cold-email-outreach", "your-team-meeting-booking", "your-team-meeting-attendance", "your-team-closing-calls"]);
    expect(funnelTypeOf(bliss)).toBe("proactive");
    expect(funnelMixed(bliss)).toBe(false);
  });

  it("no funnel holds two channels on one leg; every sourcing pipe is its own funnel", () => {
    for (const f of all) {
      expect(new Set(f.legs.map((l) => l.legKey)).size, f.id).toBe(f.legs.length);
      for (const l of f.legs) expect(legPipes(l).length, `${f.id}: ${l.legKey}`).toBe(1);
      expect(f.id, f.id).toBe(funnelIdOf(f.legs));
    }
    const path = model.paths.get(funnelById(model, BLISS)!.pathId)!;
    const sources = funnelsOfPath(model, path)
      .filter((f) => f.legs[1].pipe!.channelSlug === "sales-cold-email-outreach" && f.legs[2].pipe!.channelSlug === "your-team-meeting-booking")
      .map((f) => f.legs[0].pipe!.channelSlug);
    // Your CRM contacts feed cold email too (owner 2026-10-12): the brand's own people carry an email.
    expect(sources).toEqual(expect.arrayContaining(["lead-sourcing", "sourcing-apollo-cold-filters", "sourcing-apollo-buying-signals", "sourcing-linkedin-engagement-signals", "sourcing-crm-contacts"]));
  });

  it("Your CRM Contacts -> Cold WhatsApp Outreach -> your team is a funnel; WhatsApp takes no other source (owner 2026-10-12)", () => {
    const id = "start_to_lead_found@sourcing-crm-contacts+lead_found_to_conversation@cold-whatsapp-outreach+conversation_to_paid_client";
    const f = funnelById(model, id)!;
    expect(f.id).toBe(id);
    expect(f.legs.map((l) => l.pipe!.channelSlug)).toEqual(["sourcing-crm-contacts", "cold-whatsapp-outreach", "your-team-reply-closing"]);
    expect(funnelMixed(f)).toBe(false);
    const path = model.paths.get(f.pathId)!;
    const whatsappSources = funnelsOfPath(model, path)
      .filter((g) => g.legs[1].pipe!.channelSlug === "cold-whatsapp-outreach")
      .map((g) => g.legs[0].pipe!.channelSlug);
    expect([...new Set(whatsappSources)]).toEqual(["sourcing-crm-contacts"]);
    // No workflow on the WhatsApp pipe yet: offered, not runnable. Runnable the moment one is assigned.
    expect(funnelRunnable(f)).toBe(false);
    const withWorkflow = buildCatalogueModel(inputs({ workflowPipeKeys: new Set(["cold-whatsapp-outreach|start_to_conversation", "sourcing-crm-contacts|start_to_lead_found"]) }));
    expect(funnelRunnable(funnelById(withWorkflow, id)!)).toBe(true);
  });

  it("the sourcing leg adds its OWN cost: two funnels that differ only by their source price differently (owner 2026-10-11)", () => {
    const victory = funnelById(model, "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    expect(victory.id.startsWith("start_to_lead_found@lead-sourcing+")).toBe(true);
    const path = model.paths.get(victory.pathId)!;
    // Without its source the funnel is the outreach legs alone: 902.22; the source adds its cost per lead x the leads.
    const withoutSource = funnelEconomics({ ...path, legKeys: path.legKeys.slice(1), rates: path.rates.slice(1) }, victory.legs.slice(1), 3000);
    expect(withoutSource.costUsd).toBeCloseTo(902.22, 1);
    expect(victory.economics.costUsd).toBeCloseTo(902.22 + 0.5 * 2222.22, 1);
    const coldFilters = funnelById(model, victory.id.replace("@lead-sourcing", "@sourcing-apollo-cold-filters"))!;
    expect(coldFilters.economics.costUsd).toBeCloseTo(902.22 + 0.2 * 2222.22, 1);
    // A source still learning makes its funnel learning: never a guessed figure.
    const signals = funnelById(model, victory.id.replace("@lead-sourcing", "@sourcing-apollo-buying-signals"))!;
    expect(signals.economics).toMatchObject({ status: "learning", reason: "pipe_learning:sourcing-apollo-buying-signals|start_to_lead_found" });
  });

  it("a funnel id that names no funnel, and one only its legacy spelling resolves, are told apart", () => {
    expect(funnelById(model, "start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_conversation@cold-whatsapp-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")).toBeNull();
    expect(legacyFunnelIdAliasOf("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")).toBeNull();
  });
});

describe("a sales funnel's type (owner 2026-10-10: Proactive when at least one pipe is proactive, else Reactive)", () => {
  const model = buildCatalogueModel(inputs());

  it("reads Proactive on a funnel holding one proactive pipe (Epiphany: cold email from Lead found)", () => {
    const epiphany = funnelById(model, "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client")!;
    expect(epiphany).toBeDefined();
    expect(epiphany.legs[1].pipe!.mode).toBe("proactive");
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
        const anyProactive = f.legs.some((l) => legPipes(l).some((p) => p.mode === "proactive"));
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

describe("a reactive pipe out of Start (owner 2026-10-13: Email Pushed Via API -> Email Sending -> Positive reply -> ... -> Paid client)", () => {
  // A step-less trigger starts a leg out of nothing that proactive channels also work (the seeded `follow_up_due`
  // stands in for `email_pushed_via_api`).
  const legs: DeclaredLeg[] = [
    { channelSlug: "ai-follow-up-email", legKey: "start_to_conversation", fromStep: null, toStep: "conversation", mode: "reactive", triggerId: "follow_up_due", published: true, createdBy: "t", requestedByOrgId: null, createdAt: "", updatedAt: "" },
  ];
  const merged = mergeDeclarations(SEEDED, { channels: [], legs, triggers: [] }, { publishedOnly: false }, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
  const model = buildCatalogueModel(inputs({ channels: buildChannelCatalogue(merged.rows, merged.shortDescriptionOf, merged.channelTypeOfSlug, merged.triggerOf) }));
  const funnels = [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p)).filter((f) => f.legs[0].pipe?.id === "ai-follow-up-email|start_to_conversation");

  it("composes funnels that start on its trigger and end at Paid client", () => {
    expect(funnels.length).toBeGreaterThan(0);
    const viaMeeting = funnels.find((f) => f.legs[1]?.pipe?.id === "ai-meeting-booking|conversation_to_meeting_booked")!;
    expect(viaMeeting).toBeDefined();
    expect(funnelTypeOf(viaMeeting)).toBe("reactive");
    expect(funnelTrigger(model, viaMeeting)).toEqual({ slug: "follow_up_due", name: "Follow-up Due" });
    expect(funnelTriggerLabel(viaMeeting, (k) => k, (id) => model.triggers.get(id)?.name ?? null)).toBe("Follow-up Due");
  });

  it("a funnel whose first pipe is proactive on the same leg names no trigger", () => {
    const path = model.paths.get(funnels[0].pathId)!;
    const organic = funnelsOfPath(model, path).find((f) => f.legs[0].pipe?.mode === "proactive")!;
    expect(funnelTrigger(model, organic)).toBeNull();
  });

  it("every path ends at Paid client ('une campagne valide doit tjs finir par paid client')", () => {
    for (const p of model.paths.values()) expect(p.steps[p.steps.length - 1]).toBe("paid_client");
  });
});

describe("catalogue icons are Phosphor names only (owner 2026-10-10)", () => {
  // Checked against @phosphor-icons/react 2.1 (`dist/csr/<PascalName>`): every name the catalogue serves today.
  const PHOSPHOR = new Set([
    "browser", "package",
    "address-book", "at", "bell", "bird", "calendar-check", "calendar-plus", "chat-circle", "chat-circle-text", "chat-text",
    "currency-dollar", "cursor-click", "envelope", "facebook-logo", "file-text", "flow-arrow", "funnel", "globe", "handshake",
    "instagram-logo", "lightning", "linkedin-logo", "list-bullets", "magnifying-glass", "medal", "megaphone", "microphone", "newspaper",
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

describe("a learning funnel still serves an EXPECTED cost per paying client and roi (FUNNEL-EXPECTED-ROI-1012)", () => {
  const WONDERFUL = "start_to_lead_found@sourcing-crm-contacts+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
  // Doc Dinners-like offer: its own measured rates on the team legs, a stated $2,500 client value.
  const offerRates = new Map([
    ["conversation>meeting_booked", { ratePct: 26.67, source: "offer_measured" as const }],
    ["meeting_booked>meeting_attended", { ratePct: 16.8, source: "offer_measured" as const }],
    ["meeting_attended>paid_client", { ratePct: 65.12, source: "offer_measured" as const }],
  ]);
  const model = buildCatalogueModel(inputs({ offerRates, lifetimeRevenueUsd: 2500, lifetimeRevenueBasis: "stated" }));

  it("prices a funnel whose source pipe has no fleet history on another source's mature price, each leg naming its basis", () => {
    const f = funnelById(model, WONDERFUL)!;
    expect(f.economics.status).toBe("learning");
    const e = f.expected;
    expect(e.unavailableReason).toBeNull();
    const [source, email, booking, attended, closing] = e.legs;
    // The CRM source has no fleet history: the highest mature price of another source on Start -> Lead found.
    expect(source).toMatchObject({ pipeId: "sourcing-crm-contacts|start_to_lead_found", costPerOutcomeUsd: 0.5, costSource: "same_leg_fleet", costBasis: "fleet", ratePct: null });
    expect(email).toMatchObject({ costPerOutcomeUsd: 40, costSource: "workflow", costBasis: "measured", ratePct: 1, rateSource: "measured_pipe", rateBasis: "measured" });
    expect(booking).toMatchObject({ costPerOutcomeUsd: 0, costSource: "customer_team", costBasis: null, ratePct: 26.67, rateSource: "offer_measured" });
    expect(attended.rateSource).toBe("offer_measured");
    expect(closing).toMatchObject({ outcomesNeededPerPayingClient: 1, ratePct: 65.12 });
    // cost = 40 x positive replies needed + 0.5 x leads found needed.
    const replies = 1 / 0.6512 / 0.168 / 0.2667;
    expect(email.outcomesNeededPerPayingClient).toBeCloseTo(replies, 1);
    const cost = 40 * replies + 0.5 * (replies / 0.01);
    expect(e.costUsd).toBeCloseTo(cost, 0);
    expect(e.roi).toBeCloseTo(2500 / cost, 1);
    expect(e.basis).toBe("fleet");
    expect(e.lifetimeRevenueBasis).toBe("stated");
  });

  it("equals the measured/estimated figure on a priced funnel", () => {
    for (const f of [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p))) {
      if (f.economics.status !== "measured" && f.economics.status !== "estimated") continue;
      expect(f.expected.costUsd, f.id).toBeCloseTo(f.economics.costUsd!, 1);
      if (f.economics.roi !== null) expect(f.expected.roi, f.id).toBeCloseTo(f.economics.roi, 1);
    }
  });

  it("never leaves a funnel null without a named reason", () => {
    for (const f of [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p))) {
      if (f.expected.roi === null) expect(f.expected.unavailableReason, f.id).toMatch(/\w/);
    }
  });

  it("takes a pipe's cost in order: mature workflow > seeded default > benchmark > flash > another channel on the leg", () => {
    const p = (id: string) => model.pipes.get(id)!;
    expect(expectedPipeCost(p("sales-cold-email-outreach|lead_found_to_conversation"), model.pipes.values())?.source).toBe("workflow");
    expect(expectedPipeCost(p("sales-cold-email-outreach|lead_found_to_website_visit"), model.pipes.values())).toMatchObject({ source: "default", costPerOutcomeUsd: 5 });
    expect(expectedPipeCost(p("cold-whatsapp-outreach|lead_found_to_conversation"), model.pipes.values())).toMatchObject({ source: "same_leg_fleet", costPerOutcomeUsd: 40 });
    const flash = buildCatalogueModel(inputs({ measurements: new Map([["cold-whatsapp-outreach|lead_found_to_conversation", { basis: "flash", costPerOutcomeUsd: 12, conversionRatePct: 2, workflowDynastySlug: "w" }]]) }));
    expect(expectedPipeCost(flash.pipes.get("cold-whatsapp-outreach|lead_found_to_conversation")!, flash.pipes.values())).toMatchObject({ source: "flash", basis: "fleet", costPerOutcomeUsd: 12 });
    expect(expectedPipeCost(p("your-team-meeting-booking|conversation_to_meeting_booked"), model.pipes.values())).toBeNull();
  });

  it("rates an entry leg out of Lead found nobody measured on the cold-email default", () => {
    const bare = buildCatalogueModel(inputs({ measurements: new Map([["lead-sourcing|start_to_lead_found", mature(0.5, 100)]]) }));
    const f = funnelById(bare, WONDERFUL)!;
    // Cold email unmeasured: its seeded $50 per positive reply, and the 1% cold-email reply default.
    expect(f.expected.legs[1]).toMatchObject({ ratePct: 1, rateSource: "default_entry", rateBasis: "default", costPerOutcomeUsd: 50, costSource: "default" });
    expect(f.expected.basis).toBe("default");
  });

  it("prices a team leg out of Lead found on the brand's own history (owner 2026-10-12)", () => {
    const SOARING = "start_to_lead_found@sourcing-crm-contacts+lead_found_to_paid_client";
    // The customer's team closing CRM leads directly (declared in prod, 2026-10-12).
    const legs: DeclaredLeg[] = [
      { channelSlug: "your-team-closing-calls", legKey: "lead_found_to_paid_client", fromStep: "lead_found", toStep: "paid_client", mode: "proactive", triggerId: null, published: true, createdBy: "t", requestedByOrgId: null, createdAt: "", updatedAt: "" },
    ];
    const merged = mergeDeclarations(SEEDED, { channels: [], legs, triggers: [] }, { publishedOnly: false }, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
    const withTeam = buildChannelCatalogue(merged.rows, merged.shortDescriptionOf, merged.channelTypeOfSlug, merged.triggerOf);
    const own = buildCatalogueModel(inputs({ channels: withTeam, publishedPipeIds: allPipeIds(withTeam), offerRates: new Map([["lead_found>paid_client", { ratePct: 0.5, source: "offer_team_measured" as const }]]), lifetimeRevenueUsd: 2500, lifetimeRevenueBasis: "stated" }));
    const f = funnelById(own, SOARING)!;
    expect(f.expected.unavailableReason).toBeNull();
    expect(f.expected.legs[1]).toMatchObject({ ratePct: 0.5, rateSource: "offer_team_measured", rateBasis: "measured", costSource: "customer_team" });
    // 200 CRM leads per client at the borrowed $0.50 per lead found.
    expect(f.expected.costUsd).toBeCloseTo(100, 1);
    expect(f.expected.roi).toBeCloseTo(25, 1);
    // Without the brand's own rate the leg has none: a named reason, never a blank.
    const bare = buildCatalogueModel(inputs({ channels: withTeam, publishedPipeIds: allPipeIds(withTeam) }));
    expect(funnelById(bare, SOARING)!.expected.unavailableReason).toBe("leg_unrated:lead_found_to_paid_client");
  });
});

describe("a funnel id resolves whatever the size of its path (WARM-FUNNEL-NOT-FOUND-1016)", () => {
  // 600 meeting-booking channels on one leg: the 5-leg path holds far more combinations than the listing cap (2,000).
  const base = SEEDED.find((f) => f.slug === "ai-meeting-booking")!;
  const clones = Array.from({ length: 600 }, (_, i) => ({ ...base, slug: `zz-meeting-booking-${String(i).padStart(3, "0")}`, name: `ZZ Meeting Booking ${i}` }));
  const big = buildChannelCatalogue([...SEEDED, ...clones], (slug) => (slug.startsWith("zz-") ? "A clone." : channelShortDescription(slug)), (slug) =>
    slug.startsWith("zz-") ? channelTypeOf(base.slug) : channelTypeOf(slug),
  );
  const model = buildCatalogueModel(inputs({ channels: big, publishedPipeIds: allPipeIds(big) }));
  const path = [...model.paths.values()]
    .filter((p) => !p.triggerId && p.legKeys.includes("conversation_to_meeting_booked") && p.legKeys[0] === "start_to_lead_found")
    .sort((a, b) => b.legKeys.length - a.legKeys.length)[0];

  it("the target funnel sits past the listing cap and still resolves by id", () => {
    expect(path.legKeys.length).toBeGreaterThanOrEqual(5);
    const listed = funnelsOfPath(model, path);
    expect(listed.length).toBe(2000);
    const outreach = pipesOnLeg(model, path.legKeys[1]).find((p) => p.operatedBy === "platform")!;
    const source = pipesOnLeg(model, "start_to_lead_found").find((p) => p.operatedBy === "platform" && p.channelSlug === "lead-sourcing")!;
    const legs = path.legKeys.map((legKey, i) => ({
      legKey,
      pipe:
        i === 0
          ? source
          : i === 1
            ? outreach
            : legKey === "conversation_to_meeting_booked"
              ? model.pipes.get(`zz-meeting-booking-599|${legKey}`)!
              : pipesOnLeg(model, legKey).find((p) => p.operatedBy === "customer")!,
    }));
    const id = funnelIdOf(legs);
    expect(listed.some((f) => f.id === id)).toBe(false);
    const f = funnelById(model, id);
    expect(f?.id).toBe(id);
    expect(f?.legs.map((l) => l.pipe?.id)).toEqual(legs.map((l) => l.pipe.id));
  });

  it("an id naming a pipe the leg does not have, or the wrong leg count, resolves to nothing", () => {
    const first = funnelsOfPath(model, path)[0];
    expect(funnelById(model, first.id.replace("@lead-sourcing", "@no-such-source"))).toBeNull();
    expect(funnelById(model, first.id.split("+").slice(0, -1).join("+"))).toBeNull();
  });

  it("every listed funnel of every path resolves to itself", () => {
    const small = buildCatalogueModel(inputs());
    for (const p of small.paths.values()) for (const f of funnelsOfPath(small, p)) expect(funnelById(small, f.id)?.id, f.id).toBe(f.id);
  });
});

describe("expected cost of a pipe that produced nothing yet (FACTORY-P1)", () => {
  const pipe = (id: string, from: string, to: string, m: Partial<PipeMeasurement> | null) =>
    ({ id, channelSlug: id.split("|")[0], computedLegKey: `${from}_to_${to}`, fromStep: from, toStep: to, operatedBy: "platform", measurement: m ? { basis: "flash", costPerOutcomeUsd: null, conversionRatePct: null, workflowDynastySlug: null, ...m } : null }) as unknown as Parameters<typeof expectedPipeCost>[0];
  const fresh = (spentUsd: number) => pipe("zz-new|form_submitted_to_meeting_booked", "form_submitted", "meeting_booked", { spentUsd });
  const sibling = pipe("zz-other|conversation_to_meeting_booked", "conversation", "meeting_booked", { basis: "mature", costPerOutcomeUsd: 40 });

  it("takes the fleet's mature price of the same outcome, never below what it already spent", () => {
    expect(expectedPipeCost(fresh(12), [sibling])).toEqual({ costPerOutcomeUsd: 40, source: "same_step_fleet", basis: "fleet" });
    // The model passes `pipes.values()`, a one-shot iterator: the second rung must still see every pipe.
    expect(expectedPipeCost(fresh(12), new Map([[sibling.id, sibling]]).values())).toEqual({ costPerOutcomeUsd: 40, source: "same_step_fleet", basis: "fleet" });
    expect(expectedPipeCost(fresh(55), [sibling])).toEqual({ costPerOutcomeUsd: 55, source: "same_step_fleet", basis: "fleet" });
  });

  it("with no prior, its own spend alone; never run and no prior stays unpriced", () => {
    expect(expectedPipeCost(fresh(12), [])).toEqual({ costPerOutcomeUsd: 12, source: "own_spend", basis: "default" });
    expect(expectedPipeCost(fresh(0), [])).toBeNull();
    expect(expectedPipeCost(pipe("zz-new|form_submitted_to_meeting_booked", "form_submitted", "meeting_booked", null), [])).toBeNull();
  });
});
