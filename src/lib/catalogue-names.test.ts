import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  FAMILY_ADJECTIVES,
  FUNNEL_EXTRA_WORDS,
  PATH_RIVER_WORDS,
  PIPE_BIRD_WORDS,
  familyNameCandidates,
  isGivableWord,
  nameFamilyOfKey,
} from "./catalogue-names.js";
import { FAMILY_WORDS, nextNamesForKeys, SALES_PATH_NAME_POOL, SalesPathNamePoolExhaustedError } from "./sales-path-names.js";
import { WORKFLOW_DYNASTY_WORDS } from "./workflow-dynasty-words.js";

const lower = (ws: readonly string[]) => ws.map((w) => w.toLowerCase());

describe("the name families (owner 2026-10-10)", () => {
  it("are English single words, each listed once", () => {
    for (const [family, words] of Object.entries(FAMILY_WORDS)) {
      expect(new Set(words).size, family).toBe(words.length);
      for (const w of words) expect(w, family).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it("share no word between two families, adjectives included", () => {
    const sets = Object.entries({ ...FAMILY_WORDS, ...Object.fromEntries(Object.entries(FAMILY_ADJECTIVES).map(([k, v]) => [`${k}_adjectives`, v])) }).map(
      ([k, v]) => [k, new Set(lower(v))] as const,
    );
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const shared = [...sets[i][1]].filter((w) => sets[j][1].has(w));
        expect(shared, `${sets[i][0]} x ${sets[j][0]}`).toEqual([]);
      }
    }
  });

  it("never GIVE a workflow dynasty word (an old word already given stays given)", () => {
    const wf = new Set(lower(WORKFLOW_DYNASTY_WORDS));
    for (const w of [...FUNNEL_EXTRA_WORDS, ...PIPE_BIRD_WORDS, ...PATH_RIVER_WORDS, ...Object.values(FAMILY_ADJECTIVES).flat()]) expect(wf.has(w.toLowerCase()), w).toBe(false);
    // The snapshot holds the STAR pool and its two-word adjectives too (workflow-service #514), not only the old words.
    for (const star of ["vega", "bright", "bold", "twinkling", "clear"]) expect(wf.has(star), star).toBe(true);
    // The original pool predates the rule: its dynasty words are skipped, never handed out again.
    expect(isGivableWord("Aurora")).toBe(false);
    expect([...familyNameCandidates("sales_funnel", SALES_PATH_NAME_POOL)].slice(0, 3)).toEqual(["Victory", "Sol", "Epiphany"]);
  });

  it("are large: ~1000 funnel words, and a two-word form after the single words", () => {
    expect(FAMILY_WORDS.sales_funnel.filter(isGivableWord).length).toBeGreaterThanOrEqual(950);
    expect(PIPE_BIRD_WORDS.length).toBeGreaterThanOrEqual(250);
    expect(PATH_RIVER_WORDS.length).toBeGreaterThanOrEqual(200);
    const all = [...familyNameCandidates("pipe", PIPE_BIRD_WORDS)];
    expect(all[PIPE_BIRD_WORDS.length]).toBe(`${FAMILY_ADJECTIVES.pipe[0]} ${PIPE_BIRD_WORDS[0]}`);
    expect(new Set(all).size).toBe(all.length);
  });

  it("route a key to its family by its prefix", () => {
    expect(nameFamilyOfKey("campaign:sales-cold-email-outreach|lead_found_to_conversation")).toBe("pipe");
    expect(nameFamilyOfKey("path:lead_found_to_conversation+conversation_to_paid_client")).toBe("sales_path");
    expect(nameFamilyOfKey("lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client")).toBe("sales_funnel");
  });

  it("hand each key the next free name of ITS family, and fail loud when a family runs out", () => {
    const names = nextNamesForKeys(["campaign:a|x", "path:p", "f1", "campaign:b|y"], new Set([PIPE_BIRD_WORDS[0], "Victory"]));
    expect(names).toEqual([PIPE_BIRD_WORDS[1], PATH_RIVER_WORDS[0], "Sol", PIPE_BIRD_WORDS[2]]);
    const everything = new Set([...familyNameCandidates("sales_path", PATH_RIVER_WORDS)]);
    expect(() => nextNamesForKeys(["path:q"], everything)).toThrow(SalesPathNamePoolExhaustedError);
  });
});
