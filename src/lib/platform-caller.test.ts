import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BRIEF_JUDGMENT_SUPPORT, BRIEF_MOST_UNITS_SUPPORT, BRIEF_OPT_IN_SUPPORT, CARRIED_DRY_JUDGE_SUPPORT, ENGINE_STRATEGY_SUPPORT, HUMAN_BRIEF_SUPPORT, NICHE_GRADE_SUPPORT, ONE_LEG_JUDGMENT_SUPPORT, SUPPORT_FUNCTIONS, TACTIC_JUDGMENT_SUPPORT, type PlatformSupport } from "./platform-caller.js";

// PLATFORM-CALLER-RUN-1024: every call to a chat-service platform route states ONE of its own run (x-run-id) or a
// support function. Each known call site is pinned to its decided choice; a new call site fails until decided here.
// A URL built in a template literal (`${base}/internal/platform-…`), never the route named in prose.
const PLATFORM_ROUTE = /\}\/internal\/platform-(complete|judgments|images|transcriptions)`/;

const DECIDED: Record<string, { constant: string; support: PlatformSupport }> = {
  "src/lib/tactic-judgments.ts": { constant: "TACTIC_JUDGMENT_SUPPORT", support: TACTIC_JUDGMENT_SUPPORT },
  "src/lib/one-leg-per-workflow.ts": { constant: "ONE_LEG_JUDGMENT_SUPPORT", support: ONE_LEG_JUDGMENT_SUPPORT },
  "src/lib/research/niche-grades.ts": { constant: "NICHE_GRADE_SUPPORT", support: NICHE_GRADE_SUPPORT },
  "src/routes/factory-shadow.ts": { constant: "BRIEF_JUDGMENT_SUPPORT", support: BRIEF_JUDGMENT_SUPPORT },
  "src/lib/engine-strategy-io.ts": { constant: "ENGINE_STRATEGY_SUPPORT", support: ENGINE_STRATEGY_SUPPORT },
  "src/lib/human-brief-io.ts": { constant: "HUMAN_BRIEF_SUPPORT", support: HUMAN_BRIEF_SUPPORT },
  "src/lib/brief-opt-in-io.ts": { constant: "BRIEF_OPT_IN_SUPPORT", support: BRIEF_OPT_IN_SUPPORT },
  "src/lib/brief-most-units-io.ts": { constant: "BRIEF_MOST_UNITS_SUPPORT", support: BRIEF_MOST_UNITS_SUPPORT },
};

/**
 * The brief judges (`askJev`: the strategy; `askBriefOptIns`: what the brief asks for) take their support as a parameter,
 * default = their own; the callers stating another support function are pinned, call by call, in file order.
 */
const JUDGE_FILES = ["src/lib/engine-strategy-io.ts", "src/lib/brief-opt-in-io.ts"];
const JUDGE_CALLERS: Record<string, string[]> = { "src/routes/carried-verdicts.ts": ["CARRIED_DRY_JUDGE_SUPPORT"] };

function callSiteFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => PLATFORM_ROUTE.test(readFileSync(f, "utf8")));
}

describe("platform caller (PLATFORM-CALLER-RUN-1024)", () => {
  it("every file calling a chat-service platform route has a decided choice", () => {
    expect(callSiteFiles().sort()).toEqual(Object.keys(DECIDED).sort());
  });

  for (const [file, { constant, support }] of Object.entries(DECIDED)) {
    it(`${file} sends support ${support.kind}, never x-run-id`, () => {
      const src = readFileSync(file, "utf8");
      const call = src.slice(src.search(PLATFORM_ROUTE), src.search(PLATFORM_ROUTE) + 600);
      // The brief judge takes its support as a parameter (default = its own): the callers passing another are pinned below.
      if (JUDGE_FILES.includes(file)) {
        expect(src).toContain(`support: PlatformSupport = ${constant}`);
        expect(call).toContain("support })");
      } else expect(call).toContain(`support: ${constant}`);
      expect(call.toLowerCase()).not.toContain("x-run-id");
      expect(SUPPORT_FUNCTIONS).toContain(support.kind);
      expect(support.reason.length).toBeGreaterThan(10);
    });
  }

  it("only the decided callers hand the brief judge another support function", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const passing: Record<string, string[]> = {};
    for (const f of files) {
      const calls = [...readFileSync(f, "utf8").matchAll(/(?:askJev|askBriefOptIns)\(([^;]*?)\);/gs)].map((m) => m[1]!).filter((args) => /_SUPPORT\b/.test(args));
      if (calls.length > 0) passing[f] = calls.map((args) => args.match(/([A-Z_]+_SUPPORT)\b/)![1]!);
    }
    expect(passing).toEqual(JUDGE_CALLERS);
    expect(CARRIED_DRY_JUDGE_SUPPORT.kind).toBe("staff_experiment");
    expect(CARRIED_DRY_JUDGE_SUPPORT.reason.length).toBeGreaterThan(10);
  });

  it("support functions match chat-service's closed set", () => {
    expect([...SUPPORT_FUNCTIONS]).toEqual(["payment_fees", "brand_setup", "copilot", "platform_llm", "staff_experiment", "product_feature", "retired_product"]);
  });
});
