import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import type { CompletedToolResultRecord } from "../session/turn-state.js";
import {
  createMemoryExtractionTriggerState,
  DEFAULT_MIN_ELIGIBLE_TURNS,
  hasSuccessfulMemoryWrite,
  isMainMemoryExtractionContext,
  isMemoryExtractionDisabledByEnv,
  memoryExtractionVisibleRange,
  parseMemoryToolArguments,
  shouldDeferForEligibleTurnCadence,
  eligibleTurnsInRange,
} from "./extraction-triggers.js";

describe("memory extraction triggers", () => {
  it("falls back to retained visible messages when compaction shrinks history", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "hidden" },
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];

    const range = memoryExtractionVisibleRange(messages, 10);

    expect(range.currentVisibleCount).toBe(2);
    expect(range.unprocessedMessages).toEqual(messages.slice(1));
  });

  it("detects successful absolute memory writes and ignores failed or relative writes", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-failed",
            name: "Write",
            arguments: JSON.stringify({ file_path: "/memory/failed.md" }),
          },
          {
            id: "write-relative",
            name: "Write",
            arguments: JSON.stringify({ file_path: "relative.md" }),
          },
          {
            id: "write-success",
            name: "MultiEdit",
            arguments: JSON.stringify({ file_path: "/memory/saved.md" }),
          },
        ],
      },
    ];
    const completedToolResults: CompletedToolResultRecord[] = [
      {
        callId: "write-failed",
        toolName: "Write",
        arguments: "{}",
        content: "failed",
        isError: true,
      },
      {
        callId: "write-relative",
        toolName: "Write",
        arguments: "{}",
        content: "ok",
        isError: false,
      },
      {
        callId: "write-success",
        toolName: "MultiEdit",
        arguments: "{}",
        content: "ok",
        isError: false,
      },
    ];
    const resolveMemoryPath = (value: unknown) =>
      typeof value === "string" && value.startsWith("/memory/")
        ? value
        : null;

    expect(
      hasSuccessfulMemoryWrite({
        messages,
        completedToolResults,
        writeToolNames: new Set(["Write", "MultiEdit"]),
        resolveMemoryPath,
      }),
    ).toBe(true);

    expect(
      hasSuccessfulMemoryWrite({
        messages,
        completedToolResults: completedToolResults.slice(0, 2),
        writeToolNames: new Set(["Write", "MultiEdit"]),
        resolveMemoryPath,
      }),
    ).toBe(false);
  });

  it("classifies main-agent and disabled contexts", () => {
    expect(
      isMainMemoryExtractionContext({
        depth: 0,
        sessionSource: "cli_main",
      } as never),
    ).toBe(true);
    expect(
      isMainMemoryExtractionContext({
        depth: 1,
        sessionSource: "cli_main",
      } as never),
    ).toBe(false);
    expect(
      isMainMemoryExtractionContext({
        depth: 0,
        sessionSource: { kind: "subagent" },
      } as never),
    ).toBe(false);
    expect(
      isMemoryExtractionDisabledByEnv({
        AGENC_DISABLE_EXTRACT_MEMORIES: "1",
      }),
    ).toBe(true);
  });

  it("defers two eligible turns by default before the third runs", () => {
    const state = createMemoryExtractionTriggerState();
    expect(DEFAULT_MIN_ELIGIBLE_TURNS).toBe(3);
    const outcomes = [0, 1, 2].map(() =>
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: undefined,
        isTrailingRun: false,
      }),
    );
    expect(outcomes).toEqual([true, true, false]);
    expect(state.turnsSinceLastExtraction).toBe(0);
  });

  it("applies eligible-turn cadence but never defers trailing runs", () => {
    const state = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }),
    ).toBe(false);
    expect(state.turnsSinceLastExtraction).toBe(0);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 99,
        isTrailingRun: true,
      }),
    ).toBe(false);
  });

  it("counts the human turns waiting in an unprocessed range", () => {
    expect(
      eligibleTurnsInRange([
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok" },
      ]),
    ).toBe(2);
    expect(eligibleTurnsInRange([])).toBe(0);
  });

  it("does not restart the cadence when a restart cleared the counter", () => {
    // Live shape: three daemon restarts in one run, and each one logged
    // "deferred by eligible-turn cadence (1/3 eligible turns)" on a session
    // that had been waiting far longer. The extraction ran once in 13 turns.
    const restarted = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state: restarted,
        minEligibleTurns: undefined,
        isTrailingRun: false,
        // The conversation shows eight human turns still unprocessed.
        unprocessedEligibleTurns: 8,
      }),
    ).toBe(false);
    expect(restarted.turnsSinceLastExtraction).toBe(0);
  });

  it("still paces a fresh session exactly as before", () => {
    const state = createMemoryExtractionTriggerState();
    // A fresh session's range grows one human turn at a time, so the derived
    // count and the counter agree and the cadence is unchanged.
    const outcomes = [1, 2, 3].map((turns) =>
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: undefined,
        isTrailingRun: false,
        unprocessedEligibleTurns: turns,
      }),
    );
    expect(outcomes).toEqual([true, true, false]);
    expect(state.turnsSinceLastExtraction).toBe(0);
  });

  it("keeps deferring when too few turns are waiting", () => {
    const state = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: undefined,
        isTrailingRun: false,
        unprocessedEligibleTurns: 1,
      }),
    ).toBe(true);
  });

  it("parses invalid tool arguments as an empty object", () => {
    expect(parseMemoryToolArguments("{nope")).toEqual({});
    expect(parseMemoryToolArguments(JSON.stringify(["not", "object"]))).toEqual({});
  });
});
