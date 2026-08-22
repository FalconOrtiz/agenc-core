import { describe, expect, it } from "vitest";

import {
  REVIEW_REPAIR_INSTRUCTION,
  runIndependentReview,
} from "../../src/workflow/independent-review.js";

const VERDICT = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "The change matches the goal.",
  overallConfidenceScore: 0.9,
});
const PREAMBLE = "I'll inspect the repository and review the change now.";

function scriptedInvoker(replies: readonly string[]) {
  const seen: string[] = [];
  let at = 0;
  return {
    seen,
    invoke: (input: { readonly userMessage: string }) => {
      seen.push(input.userMessage);
      const reply = replies[Math.min(at, replies.length - 1)] ?? "";
      at += 1;
      return Promise.resolve(reply);
    },
  };
}

const BASE = {
  spec: { goal: "fix total", reviewerModel: "test-model" },
  patchText: "- return sum + 1\n+ return sum",
  changedFilesText: "src/total.mjs",
  verification: [],
  verificationVerdict: "PASS",
  step: { runId: "wf-test", stepId: "workflow.review", attempt: 1 },
} as const;

const SINK = {
  recordArtifact: () =>
    Promise.resolve({ digest: "sha256:test", bytes: 0, path: "review.json" }),
};

describe("independent review repair", () => {
  it("asks once more when the reviewer only narrates its intent", async () => {
    const invoker = scriptedInvoker([PREAMBLE, VERDICT]);
    const result = await runIndependentReview({
      ...BASE,
      invoker: invoker as never,
      sink: SINK as never,
    });
    expect(invoker.seen).toHaveLength(2);
    expect(invoker.seen[1]).toContain(REVIEW_REPAIR_INSTRUCTION);
    expect(result.review.overallCorrectness).toBe("correct");
  });

  it("does not retry an already structured verdict", async () => {
    const invoker = scriptedInvoker([VERDICT]);
    await runIndependentReview({
      ...BASE,
      invoker: invoker as never,
      sink: SINK as never,
    });
    expect(invoker.seen).toHaveLength(1);
  });

  it("reports the second unstructured response", async () => {
    const invoker = scriptedInvoker([PREAMBLE, PREAMBLE]);
    await expect(
      runIndependentReview({
        ...BASE,
        invoker: invoker as never,
        sink: SINK as never,
      }),
    ).rejects.toThrow(/inspect the repository/u);
  });
});
