/**
 * THE ARROW CATALOGUE — one identifier per arrow, minted here, derived from the funnels themselves.
 *
 * Performance is measured per ARROW; a sales funnel is a way of READING those arrows. So the catalogue
 * has to state three things and nothing else: an arrow has ONE identifier, an entry arrow is ordinary,
 * and an arrow knows every funnel it is a leg of (usually several — which is why a campaign can no
 * longer be identified by one funnel, and why two funnels' figures overlap and must never be summed).
 */
import { describe, it, expect } from "vitest";
import {
  FUNNEL_ARROWS,
  FUNNEL_ARROW_KEYS,
  arrowKeyBetween,
  arrowKeysOfFunnel,
  funnelArrow,
  funnelsContainingArrow,
  matchFunnelArrowKey,
} from "./funnel-arrows.js";
import { funnelLegs } from "./acquisition-channels.js";
import { ALL_STEP_EVIDENCE, buildFunnelSteps } from "./funnel-steps.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("funnel arrows", () => {
  it("mints ONE identifier per arrow, and the catalogue is exactly the funnels' legs deduped", () => {
    const fromFunnels = new Set<string>();
    for (const key of SALES_FUNNEL_KEYS) for (const leg of funnelLegs(key)) fromFunnels.add(arrowKeyBetween(leg.from, leg.to));
    expect(new Set(FUNNEL_ARROW_KEYS)).toEqual(fromFunnels);
    // No key is minted twice, so an arrow can never be two rows of the catalogue.
    expect(new Set(FUNNEL_ARROW_KEYS).size).toBe(FUNNEL_ARROWS.length);
  });

  it("an ENTRY arrow carries an ORDINARY identifier and states its missing step as data, not as a name", () => {
    const entry = funnelArrow("start_to_conversation");
    expect(entry).not.toBeNull();
    // The identifier is one value like every other; the "no step before it" fact rides beside it.
    expect(entry!.arrowKey).toBe("start_to_conversation");
    expect(entry!.fromStep).toBeNull();
    expect(entry!.toStep.key).toBe("conversation");
    expect(entry!.toStep.label).toBe("Conversation");
  });

  it("a NON-entry arrow states both of its steps beside the identifier, so nobody parses the string", () => {
    const arrow = funnelArrow("meeting_booked_to_meeting_attended")!;
    expect(arrow.fromStep?.key).toBe("meeting_booked");
    expect(arrow.toStep.key).toBe("meeting_attended");
  });

  it("ONE arrow belongs to SEVERAL funnels — the whole reason a campaign cannot name one", () => {
    // The two meeting funnels differ only in what buys the meeting; everything after it is shared.
    expect(funnelsContainingArrow("meeting_booked_to_meeting_attended")).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(funnelsContainingArrow("meeting_attended_to_paid_client")).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    // The website-visit entry arrow feeds every website-led funnel AT ONCE — nobody can buy traffic
    // that only travels down one of them.
    expect(funnelsContainingArrow("start_to_website_visit")).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    // And an arrow only one funnel has stays that way.
    expect(funnelsContainingArrow("start_to_conversation")).toEqual(["sales_meetings_from_conversation"]);
  });

  it("a funnel is COMPOSED of its arrows, in its own order", () => {
    expect(arrowKeysOfFunnel("sales_meetings_from_conversation")).toEqual([
      "start_to_conversation",
      "conversation_to_meeting_booked",
      "meeting_booked_to_meeting_attended",
      "meeting_attended_to_paid_client",
    ]);
    expect(arrowKeysOfFunnel("website_purchases")).toEqual([
      "start_to_website_visit",
      "website_visit_to_signup",
      "signup_to_paid_client",
    ]);
  });

  it("a funnel's RUNGS carry the arrows they are, so performance is readable per arrow and a funnel is composed of them", () => {
    const conversation = buildFunnelSteps("sales_meetings_from_conversation", [], 0, ALL_STEP_EVIDENCE);
    const website = buildFunnelSteps("sales_meetings_from_website", [], 0, ALL_STEP_EVIDENCE);

    // Rung i is the rung the funnel's arrow i moves a lead onto — one walk, never two.
    expect(conversation.steps.map((s) => s.arrowKey)).toEqual(arrowKeysOfFunnel("sales_meetings_from_conversation"));
    expect(website.steps.map((s) => s.arrowKey)).toEqual(arrowKeysOfFunnel("sales_meetings_from_website"));

    // The two funnels SHARE their tail arrows: the same attended meeting is on both, so their figures
    // OVERLAP and must never be summed. A funnel is a way of reading arrows, not a partition of them.
    const tail = (keys: string[]) => keys.slice(2);
    expect(tail(conversation.steps.map((s) => s.arrowKey))).toEqual(tail(website.steps.map((s) => s.arrowKey)));
  });

  it("resolving a spelling is a LOOKUP, never a parse — case and separators tolerated, unknowns null", () => {
    expect(matchFunnelArrowKey(" START-TO-CONVERSATION ")).toBe("start_to_conversation");
    expect(matchFunnelArrowKey("Meeting Booked To Meeting Attended")).toBe("meeting_booked_to_meeting_attended");
    // Well-formed and still unknown: nothing is inferred from the shape of the string.
    expect(matchFunnelArrowKey("signup_to_meeting_attended")).toBeNull();
    expect(matchFunnelArrowKey("whatever")).toBeNull();
  });
});
