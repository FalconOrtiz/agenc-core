/**
 * Ports the upstream memory-extraction trigger logic onto AgenC turn state.
 *
 * Why this lives here:
 *   - The extraction service owns child-agent execution. This module owns the
 *     memory-specific trigger decisions that determine whether the child should
 *     run at all.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Feature-service gates and team-memory routing; AgenC wires these through
 *     local env/config and the single auto-memory directory.
 */
import type { LLMMessage } from "../llm/types.js";
import type { TurnContext } from "../session/turn-context.js";
import type { CompletedToolResultRecord } from "../session/turn-state.js";
import { isEnvTruthy } from "../utils/envUtils.js";

export type MemoryExtractionEnv = Readonly<Record<string, string | undefined>>;

export interface MemoryExtractionVisibleRange {
  readonly visibleMessages: readonly LLMMessage[];
  readonly unprocessedMessages: readonly LLMMessage[];
  readonly currentVisibleCount: number;
}

export interface MemoryExtractionTriggerState {
  processedVisibleCount: number;
  turnsSinceLastExtraction: number;
}

export function createMemoryExtractionTriggerState(): MemoryExtractionTriggerState {
  return {
    processedVisibleCount: 0,
    turnsSinceLastExtraction: 0,
  };
}

export function memoryExtractionVisibleRange(
  messages: readonly LLMMessage[],
  processedVisibleCount: number,
): MemoryExtractionVisibleRange {
  const visibleMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const currentVisibleCount = visibleMessages.length;
  const unprocessedMessages =
    currentVisibleCount < processedVisibleCount
      ? visibleMessages
      : visibleMessages.slice(processedVisibleCount);
  return {
    visibleMessages,
    unprocessedMessages,
    currentVisibleCount,
  };
}

export function parseMemoryToolArguments(
  raw: string | undefined,
): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function hasSuccessfulMemoryWrite(params: {
  readonly messages: readonly LLMMessage[];
  readonly completedToolResults: readonly CompletedToolResultRecord[];
  readonly writeToolNames: ReadonlySet<string>;
  readonly resolveMemoryPath: (value: unknown) => string | null;
}): boolean {
  const completedByCallId = new Map(
    params.completedToolResults
      .filter((record) => record.isError !== true)
      .map((record) => [record.callId, record]),
  );
  for (const message of params.messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (!params.writeToolNames.has(toolCall.name)) continue;
      const record = completedByCallId.get(toolCall.id);
      if (!record) continue;
      if (record.toolName !== toolCall.name) continue;
      const args = parseMemoryToolArguments(toolCall.arguments);
      if (params.resolveMemoryPath(args.file_path) !== null) return true;
    }
  }
  return false;
}

export function isMainMemoryExtractionContext(ctx: TurnContext): boolean {
  if ((ctx.depth ?? 0) > 0) return false;
  const source = ctx.sessionSource as unknown;
  if (source === "cli_subagent") return false;
  return !(
    typeof source === "object" &&
    source !== null &&
    (source as { kind?: unknown }).kind === "subagent"
  );
}

export function isMemoryExtractionDisabledByEnv(
  env: MemoryExtractionEnv | undefined,
): boolean {
  return isEnvTruthy((env ?? process.env).AGENC_DISABLE_EXTRACT_MEMORIES);
}

/**
 * Eligible terminating turns between extraction runs. One full-history child
 * per turn is the most expensive thing the runtime does in the background, so
 * by default the child runs on every third eligible turn; a trailing run that
 * coalesced newer context never waits.
 */
export const DEFAULT_MIN_ELIGIBLE_TURNS = 3;

function resolveMinEligibleTurns(value: number | undefined): number {
  return Math.max(1, Math.trunc(value ?? DEFAULT_MIN_ELIGIBLE_TURNS));
}

/**
 * Eligible turns waiting in a range, counted as the human messages in it.
 * This is the history-derived twin of `turnsSinceLastExtraction`: the counter
 * lives in process memory and a daemon restart sets it back to zero, while
 * the range is recomputed from the conversation and survives.
 */
export function eligibleTurnsInRange(
  unprocessedMessages: readonly LLMMessage[],
): number {
  return unprocessedMessages.filter((message) => message.role === "user").length;
}

/**
 * Whether to hold this extraction back for the cadence.
 *
 * The counter alone was not restart-safe: it lives in the in-process lane
 * map, so every daemon restart began the wait again. In the live 15-prompt
 * run three restarts meant the extraction ran once in thirteen turns, each
 * restart logging "deferred by eligible-turn cadence (1/3 eligible turns)".
 * The waiting turns are recoverable from the conversation itself, so the
 * decision now takes whichever is larger: what this process has counted, or
 * what the unprocessed range shows is already waiting. A fresh session is
 * unaffected — on its first turn both are 1 — and a resumed session no
 * longer pays another full cadence before its memory is written.
 */
export function shouldDeferForEligibleTurnCadence(params: {
  readonly state: MemoryExtractionTriggerState;
  readonly minEligibleTurns: number | undefined;
  readonly isTrailingRun: boolean;
  readonly unprocessedEligibleTurns?: number;
}): boolean {
  if (params.isTrailingRun) return false;
  params.state.turnsSinceLastExtraction += 1;
  const waiting = Math.max(
    params.state.turnsSinceLastExtraction,
    params.unprocessedEligibleTurns ?? 0,
  );
  if (waiting < resolveMinEligibleTurns(params.minEligibleTurns)) {
    return true;
  }
  params.state.turnsSinceLastExtraction = 0;
  return false;
}
