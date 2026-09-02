/**
 * THE LEG CATALOGUE — one identifier per leg, minted here, derived from the funnels themselves.
 *
 * Performance is measured per LEG; a sales funnel is a way of READING those legs. So the catalogue
 * has to state three things and nothing else: a leg has ONE identifier, an entry leg is ordinary,
 * and a leg knows every funnel it is a leg of (usually several — which is why a campaign can no
 * longer be identified by one funnel, and why two funnels' figures overlap and must never be summed).
 */
import { describe, it, expect } from "vitest";
import {
  FUNNEL_LEGS,
  FUNNEL_LEG_KEYS,
  legKeyBetween,
  legKeysOfFunnel,
  funnelLeg,
  funnelsContainingLeg,
  matchFunnelLegKey,
} from "./funnel-legs.js";
import { funnelLegs } from "./acquisition-channels.js";
import { ALL_STEP_EVIDENCE, buildFunnelSteps } from "./funnel-steps.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("funnel legs", () => {
  it("mints ONE identifier per leg, and the catalogue is exactly the funnels' legs deduped", () => {
    const fromFunnels = new Set<string>();
    for (const key of SALES_FUNNEL_KEYS) for (const leg of funnelLegs(key)) fromFunnels.add(legKeyBetween(leg.from, leg.to));
    expect(new Set(FUNNEL_LEG_KEYS)).toEqual(fromFunnels);
    // No key is minted twice, so a leg can never be two rows of the catalogue.
    expect(new Set(FUNNEL_LEG_KEYS).size).toBe(FUNNEL_LEGS.length);
  });

  it("an ENTRY leg carries an ORDINARY identifier and states its missing step as data, not as a name", () => {
    const entry = funnelLeg("start_to_conversation");
    expect(entry).not.toBeNull();
    // The identifier is one value like every other; the "no step before it" fact rides beside it.
    expect(entry!.legKey).toBe("start_to_conversation");
    expect(entry!.fromStep).toBeNull();
    expect(entry!.toStep.key).toBe("conversation");
    expect(entry!.toStep.label).toBe("Conversation");
  });

  it("a NON-entry leg states both of its steps beside the identifier, so nobody parses the string", () => {
    const leg = funnelLeg("meeting_booked_to_meeting_attended")!;
    expect(leg.fromStep?.key).toBe("meeting_booked");
    expect(leg.toStep.key).toBe("meeting_attended");
  });

  it("ONE leg belongs to SEVERAL funnels — the whole reason a campaign cannot name one", () => {
    // The two meeting funnels differ only in what buys the meeting; everything after it is shared.
    expect(funnelsContainingLeg("meeting_booked_to_meeting_attended")).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(funnelsContainingLeg("meeting_attended_to_paid_client")).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    // The website-visit entry leg feeds every website-led funnel AT ONCE — nobody can buy traffic
    // that only travels down one of them.
    expect(funnelsContainingLeg("start_to_website_visit")).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    // And a leg only one funnel has stays that way.
    expect(funnelsContainingLeg("start_to_conversation")).toEqual(["sales_meetings_from_conversation"]);
  });

  it("a funnel is COMPOSED of its legs, in its own order", () => {
    expect(legKeysOfFunnel("sales_meetings_from_conversation")).toEqual([
      "start_to_conversation",
      "conversation_to_meeting_booked",
      "meeting_booked_to_meeting_attended",
      "meeting_attended_to_paid_client",
    ]);
    expect(legKeysOfFunnel("website_purchases")).toEqual([
      "start_to_website_visit",
      "website_visit_to_signup",
      "signup_to_paid_client",
    ]);
  });

  it("a funnel's RUNGS carry the legs they are, so performance is readable per leg and a funnel is composed of them", () => {
    const conversation = buildFunnelSteps("sales_meetings_from_conversation", [], 0, ALL_STEP_EVIDENCE);
    const website = buildFunnelSteps("sales_meetings_from_website", [], 0, ALL_STEP_EVIDENCE);

    // Rung i is the rung the funnel's leg i moves a lead onto — one walk, never two.
    expect(conversation.steps.map((s) => s.legKey)).toEqual(legKeysOfFunnel("sales_meetings_from_conversation"));
    expect(website.steps.map((s) => s.legKey)).toEqual(legKeysOfFunnel("sales_meetings_from_website"));

    // The two funnels SHARE their tail legs: the same attended meeting is on both, so their figures
    // OVERLAP and must never be summed. A funnel is a way of reading legs, not a partition of them.
    const tail = (keys: string[]) => keys.slice(2);
    expect(tail(conversation.steps.map((s) => s.legKey))).toEqual(tail(website.steps.map((s) => s.legKey)));
  });

  it("resolving a spelling is a LOOKUP, never a parse — case and separators tolerated, unknowns null", () => {
    expect(matchFunnelLegKey(" START-TO-CONVERSATION ")).toBe("start_to_conversation");
    expect(matchFunnelLegKey("Meeting Booked To Meeting Attended")).toBe("meeting_booked_to_meeting_attended");
    // Well-formed and still unknown: nothing is inferred from the shape of the string.
    expect(matchFunnelLegKey("signup_to_meeting_attended")).toBeNull();
    expect(matchFunnelLegKey("whatever")).toBeNull();
  });
});
