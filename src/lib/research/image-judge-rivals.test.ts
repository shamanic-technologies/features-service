import { describe, expect, it } from "vitest";
import { compareToReference, imageJudgeRivalsStudy, IMAGE_JUDGE_RIVALS_STUDY_ID, scoreModels } from "./image-judge-rivals.js";
import { IMAGE_JUDGE_RIVALS_BENCHMARK as B } from "./image-judge-rivals-benchmark.js";

describe("IMAGE-JUDGE-RIVALS-STUDY-1021: which AI reads a prospect's homepage best, and at what price", () => {
  const study = imageJudgeRivalsStudy();
  const scores = Object.fromEntries(scoreModels(B).map((s) => [s.key, s]));

  it("scores 378 checks per model (17 ambiguous not scored) and recomputes the blog's right answers", () => {
    expect(study.id).toBe(IMAGE_JUDGE_RIVALS_STUDY_ID);
    expect(study).toMatchObject({ pipe: null, outcome: "judgment", topic: "judgment", status: "measured" });
    expect(B.rows).toHaveLength(395);
    expect(Object.values(scores).map((s) => s.scored)).toEqual(Array(6).fill(378));
    expect(Object.fromEntries(Object.values(scores).map((s) => [s.key, s.right]))).toEqual({
      jev: 373,
      "openai-luna": 373,
      "gemini-flash-lite": 375,
      "gemini-flash": 374,
      "claude-haiku": 366,
      "claude-sonnet": 377,
    });
    expect(study.charts[0]!.note).toMatch(/17 the eye could not settle are not scored/);
  });

  it("the page's verdict rule, paired against Jev with Bonferroni over 5 rivals: no rival differs beyond chance", () => {
    const jev = B.models.find((m) => m.key === "jev")!;
    for (const m of B.models.filter((x) => x.key !== "jev")) expect(compareToReference(B, m, jev, 5).verdict.kind, m.key).toBe("noise");
    expect(study.verdict.kind).toBe("noise");
    expect(study.verdict.reason).toMatch(/Bonferroni over 5 rivals/);
    expect(study.winner).toBeNull();
    expect(study.crowned).toBe(false);
  });

  it("bars staff read in 2 seconds: accuracy per model (best first), price per 1,000 checks (cheapest first)", () => {
    const [accuracy, price] = study.charts;
    expect(accuracy!.lowerIsBetter).toBe(false);
    expect(accuracy!.points.map((p) => [p.label, p.display])).toEqual([
      ["Claude Sonnet 5.5", "99.7%"],
      ["Gemini 3.1 Flash-Lite", "99.2%"],
      ["Gemini 3.5 Flash-Lite", "98.9%"],
      ["Jev 1.13", "98.7%"],
      ["GPT-6 Luna", "98.7%"],
      ["Claude Haiku 5.5", "96.8%"],
    ]);
    expect(price!.lowerIsBetter).toBe(true);
    expect(price!.points.map((p) => [p.label, p.display])).toEqual([
      ["Jev 1.13", "$0.35"],
      ["GPT-6 Luna", "$0.36"],
      ["Gemini 3.1 Flash-Lite", "$0.66"],
      ["Gemini 3.5 Flash-Lite", "$0.81"],
      ["Claude Haiku 5.5", "$0.82"],
      ["Claude Sonnet 5.5", "$13.19"],
    ]);
  });

  it("the conclusion states only what holds: no accuracy winner, the price gap as a measured fact", () => {
    expect(study.conclusion).toHaveLength(2);
    expect(study.conclusion[0]).toMatch(/^No accuracy winner: .* no rival differs from Jev 1\.13 beyond chance/);
    expect(study.conclusion[1]).toMatch(/^Price per 1,000 checks, measured on the billed run: Jev 1\.13 \$0\.35, .* Claude Sonnet 5\.5 \$13\.19\. Claude Sonnet 5\.5 costs 38x Jev 1\.13\.$/);
    expect(study.result).toMatchObject({ display: "$0.35" });
  });

  it("names no client and no prospect domain", () => {
    const text = JSON.stringify(study);
    expect(text).not.toMatch(/https?:|www\.|\.(com|net|org|io|co|fr|uk|us|de)\b/i);
    expect(text).not.toMatch(/site-\d/);
    expect(text).not.toMatch(/roof/i);
  });
});
