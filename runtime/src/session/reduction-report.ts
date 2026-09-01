import type { EventSeq } from "./event-log.js";

export const REDUCTION_REPORT_SAMPLE_CAP = 5;

export interface ReductionReport {
  /** Count of unknown rollout-type variants encountered (I-26). */
  readonly unknownVariantCount: number;
  /** Unknown-variant samples retained for telemetry. */
  readonly unknownVariantSamples: ReadonlyArray<string>;
  /** Count of seq-gap violations (I-27). */
  readonly seqGapCount: number;
  /** First seq-gap encountered (useful for reporting). */
  readonly firstSeqGap?: {
    readonly expected: EventSeq;
    readonly actual: EventSeq;
  };
  /** Lines that failed to parse and were skipped. */
  readonly malformedLineCount: number;
  /** Total rollout items successfully processed. */
  readonly processed: number;
}

function validCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0;
}

function addCounts(current: unknown, delta: unknown): number {
  const sum = validCount(current) + validCount(delta);
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

/**
 * Merge an incremental report delta without mutating either input.
 * `processed` is additive here. Callers that own the complete input sequence
 * assign its exact final length after their fold.
 */
export function mergeReductionReports(
  current: ReductionReport,
  delta: Partial<ReductionReport>,
): ReductionReport {
  const currentSamples = Array.isArray(current.unknownVariantSamples)
    ? current.unknownVariantSamples
    : [];
  const deltaSamples = Array.isArray(delta.unknownVariantSamples)
    ? delta.unknownVariantSamples
    : [];

  return {
    unknownVariantCount: addCounts(
      current.unknownVariantCount,
      delta.unknownVariantCount,
    ),
    unknownVariantSamples: [...currentSamples, ...deltaSamples].slice(
      0,
      REDUCTION_REPORT_SAMPLE_CAP,
    ),
    seqGapCount: addCounts(current.seqGapCount, delta.seqGapCount),
    firstSeqGap: current.firstSeqGap ?? delta.firstSeqGap,
    malformedLineCount: addCounts(
      current.malformedLineCount,
      delta.malformedLineCount,
    ),
    processed: addCounts(current.processed, delta.processed),
  };
}
