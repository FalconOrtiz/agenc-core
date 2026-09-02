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
 * Unprocessed messages that mean "this process inherited a conversation it did
 * not build". One turn's own output is a handful of messages; a backlog this
 * size only accumulates across a restart or a dropped lane.
 */
export const COLD_LANE_BACKLOG_MESSAGES = 8;

/**
 * Whether to hold this extraction back for the cadence.
 *
 * The counter is process-local: it lives in the in-process lane map, so a
 * daemon restart begins the wait again while the conversation it is pacing
 * stays on disk. A process that inherits a session mid-conversation would
 * make it wait a further full cadence before writing any memory.
 *
 * The first decision a process makes for a lane is therefore allowed to look
 * at the backlog instead of the counter: an unprocessed range far larger than
 * one turn's output means this process did not build this conversation, and
 * that extraction runs now. It fires at most once per lane per process, so a
 * failing extraction still retries on the ordinary cadence rather than on
 * every turn — the cursor only advances when a run succeeds, so a backlog
 * that stays large must not keep re-triggering.
 */
export function shouldDeferForEligibleTurnCadence(params: {
  readonly state: MemoryExtractionTriggerState;
  readonly minEligibleTurns: number | undefined;
  readonly isTrailingRun: boolean;
  /** First cadence decision this process makes for this lane. */
  readonly laneIsCold?: boolean;
  readonly unprocessedVisibleCount?: number;
}): { readonly defer: boolean; readonly waiting: number } {
  if (params.isTrailingRun) return { defer: false, waiting: 0 };
  params.state.turnsSinceLastExtraction += 1;
  const minimum = resolveMinEligibleTurns(params.minEligibleTurns);
  if (
    params.laneIsCold === true &&
    (params.unprocessedVisibleCount ?? 0) >= COLD_LANE_BACKLOG_MESSAGES
  ) {
    params.state.turnsSinceLastExtraction = 0;
    return { defer: false, waiting: minimum };
  }
  const waiting = params.state.turnsSinceLastExtraction;
  if (waiting < minimum) return { defer: true, waiting };
  params.state.turnsSinceLastExtraction = 0;
  return { defer: false, waiting: minimum };
}
