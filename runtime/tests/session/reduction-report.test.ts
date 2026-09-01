import { describe, expect, test } from "vitest";
import {
  REDUCTION_REPORT_SAMPLE_CAP,
  mergeReductionReports,
  type ReductionReport,
} from "./reduction-report.js";

function report(overrides: Partial<ReductionReport> = {}): ReductionReport {
  return {
    unknownVariantCount: 0,
    unknownVariantSamples: [],
    seqGapCount: 0,
    malformedLineCount: 0,
    processed: 0,
    ...overrides,
  };
}

describe("reduction report merger", () => {
  test("an empty partial preserves every report field", () => {
    const initial = report({
      unknownVariantCount: 2,
      unknownVariantSamples: ["future-a", "future-b"],
      seqGapCount: 1,
      firstSeqGap: { expected: 4, actual: 7 },
      malformedLineCount: 3,
      processed: 9,
    });

    expect(mergeReductionReports(initial, {})).toEqual(initial);
  });

  test("ignores malformed count deltas", () => {
    const initial = report({
      unknownVariantCount: 2,
      seqGapCount: 3,
      malformedLineCount: 4,
      processed: 5,
    });

    expect(
      mergeReductionReports(initial, {
        unknownVariantCount: Number.NaN,
        seqGapCount: -1,
        malformedLineCount: Number.POSITIVE_INFINITY,
        processed: 1.5,
      }),
    ).toMatchObject({
      unknownVariantCount: 2,
      seqGapCount: 3,
      malformedLineCount: 4,
      processed: 5,
    });
  });

  test("retains the first sequence gap across later deltas", () => {
    const firstGap = { expected: 2, actual: 5 };
    const withFirstGap = mergeReductionReports(report(), {
      seqGapCount: 1,
      firstSeqGap: firstGap,
    });

    expect(
      mergeReductionReports(withFirstGap, {
        seqGapCount: 1,
        firstSeqGap: { expected: 6, actual: 9 },
      }),
    ).toMatchObject({
      seqGapCount: 2,
      firstSeqGap: firstGap,
    });
  });

  test("keeps only the first five unknown-variant samples", () => {
    const merged = mergeReductionReports(
      report({ unknownVariantSamples: ["a", "b", "c"] }),
      { unknownVariantSamples: ["d", "e", "f"] },
    );

    expect(REDUCTION_REPORT_SAMPLE_CAP).toBe(5);
    expect(merged.unknownVariantSamples).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("repeated merges add every valid count without mutating inputs", () => {
    const initial = report({ unknownVariantSamples: ["a"] });
    const deltas: ReadonlyArray<Partial<ReductionReport>> = [
      {
        unknownVariantCount: 1,
        seqGapCount: 1,
        malformedLineCount: 2,
        processed: 3,
      },
      {
        unknownVariantCount: 2,
        seqGapCount: 3,
        malformedLineCount: 4,
        processed: 5,
      },
    ];

    const merged = deltas.reduce(mergeReductionReports, initial);

    expect(merged).toMatchObject({
      unknownVariantCount: 3,
      seqGapCount: 4,
      malformedLineCount: 6,
      processed: 8,
    });
    expect(initial).toEqual(report({ unknownVariantSamples: ["a"] }));
    expect(deltas[0]?.processed).toBe(3);
  });
});
