import { describe, expect, it } from "vitest";
import { imageJudgeStudy, IMAGE_JUDGE_STUDY_ID, scoreQuestion } from "./image-judge.js";
import { IMAGE_JUDGE_BENCHMARK, type ImageJudgeRow } from "./image-judge-benchmark.js";

describe("IMAGE-JUDGE-STUDY-1021: ask on the screenshot or on a description of it", () => {
  const study = imageJudgeStudy();
  const chart = (title: RegExp) => study.charts.find((c) => title.test(c.title))!;

  it("scores the benchmark's disagreements checked by eye: 52 against 3, 4 ambiguous not scored", () => {
    expect(study.id).toBe(IMAGE_JUDGE_STUDY_ID);
    expect(study).toMatchObject({ pipe: null, outcome: "judgment", topic: "judgment", status: "measured", winner: "On the screenshot" });
    expect(study.result!.display).toBe("52 of 55");
    const all = study.charts[0]!;
    expect(all.points.map((p) => [p.label, p.value])).toEqual([
      ["On the screenshot", 52],
      ["On a description", 3],
    ]);
    expect(all.note).toMatch(/4 the eye could not settle are not scored/);
  });

  it("per question, the page's verdict rule on paired items: phone and reviews conclusions, address a signal, chat noise", () => {
    const rows = IMAGE_JUDGE_BENCHMARK.rows;
    const s = (q: ImageJudgeRow["question"]) => scoreQuestion(rows, q, 4);
    expect([s("phone").imageRight, s("phone").descriptionRight, s("phone").verdict.kind]).toEqual([27, 0, "conclusion"]);
    expect([s("reviews").imageRight, s("reviews").descriptionRight, s("reviews").verdict.kind]).toEqual([13, 0, "conclusion"]);
    // 7 of 7: p = 2/128 = 0.0156, under 0.05 but over the 4-question bar 0.0125
    expect([s("address").imageRight, s("address").descriptionRight, s("address").verdict.kind]).toEqual([7, 0, "signal"]);
    expect(s("address").verdict.p).toBeCloseTo(2 / 128, 6);
    expect([s("chat").imageRight, s("chat").descriptionRight, s("chat").ambiguous, s("chat").verdict.kind]).toEqual([5, 3, 4, "noise"]);
    expect(study.verdict.kind).toBe("conclusion");
    expect(study.crowned).toBe(true);
    expect(study.verdict.reason).toMatch(/Bonferroni over 4 questions/);
  });

  it("the conclusion lines state only the conclusions, plus the every-header check of the phone question", () => {
    expect(study.conclusion).toHaveLength(3);
    expect(study.conclusion[0]).toMatch(/^Phone number in the header: ask on the screenshot\. .* right on 27 of 27/);
    expect(study.conclusion[1]).toMatch(/^Review rating: ask on the screenshot\. .* right on 13 of 13/);
    expect(study.conclusion[2]).toBe(
      "On 33 homepages of one trade, every header checked by eye: the screenshot answer was right on 32 of 32, the description on 14 of 32.",
    );
    expect(study.conclusion.join(" ")).not.toMatch(/Chat widget|Street address/);
  });

  it("bars a staff member reads in 2 seconds: right answers per way, per question, the leading way first", () => {
    expect(chart(/^Chat widget/).points.map((p) => [p.label, p.value])).toEqual([
      ["Asked on the screenshot", 5],
      ["Asked on a description", 3],
    ]);
    expect(chart(/^Chat widget/).note).toMatch(/a gap chance alone produces often/);
    expect(chart(/every header checked/).points.map((p) => p.display)).toEqual(["100%", "44%"]);
  });

  it("names no client and no prospect domain", () => {
    const text = JSON.stringify(study);
    expect(text).not.toMatch(/https?:|www\.|\.(com|net|org|io|co|fr|uk|us|de)\b/i);
    expect(text).not.toMatch(/site-\d/);
    expect(text).not.toMatch(/roof/i);
  });
});
