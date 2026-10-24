import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NICHE_GRADE_SUPPORT, ONE_LEG_JUDGMENT_SUPPORT, SUPPORT_FUNCTIONS, TACTIC_JUDGMENT_SUPPORT, type PlatformSupport } from "./platform-caller.js";

// PLATFORM-CALLER-RUN-1024: every call to a chat-service platform route states ONE of its own run (x-run-id) or a
// support function. Each known call site is pinned to its decided choice; a new call site fails until decided here.
// A URL built in a template literal (`${base}/internal/platform-…`), never the route named in prose.
const PLATFORM_ROUTE = /\}\/internal\/platform-(complete|judgments|images|transcriptions)`/;

const DECIDED: Record<string, { constant: string; support: PlatformSupport }> = {
  "src/lib/tactic-judgments.ts": { constant: "TACTIC_JUDGMENT_SUPPORT", support: TACTIC_JUDGMENT_SUPPORT },
  "src/lib/one-leg-per-workflow.ts": { constant: "ONE_LEG_JUDGMENT_SUPPORT", support: ONE_LEG_JUDGMENT_SUPPORT },
  "src/lib/research/niche-grades.ts": { constant: "NICHE_GRADE_SUPPORT", support: NICHE_GRADE_SUPPORT },
};

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
      expect(call).toContain(`support: ${constant}`);
      expect(call.toLowerCase()).not.toContain("x-run-id");
      expect(SUPPORT_FUNCTIONS).toContain(support.kind);
      expect(support.reason.length).toBeGreaterThan(10);
    });
  }

  it("support functions match chat-service's closed set", () => {
    expect([...SUPPORT_FUNCTIONS]).toEqual(["payment_fees", "brand_setup", "copilot", "platform_llm", "staff_experiment", "product_feature", "retired_product"]);
  });
});
