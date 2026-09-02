/**
 * Single classifier for turn lifecycle terminals.
 *
 * Durable `error` is non-terminal telemetry (stop_hook_threw, compaction,
 * editor-policy diagnostics). Lifecycle failure uses `turn_failed`.
 * Readers still recognize two pre-turn_failed journal shapes so old
 * rollouts classify correctly without treating every diagnostic as a
 * failure.
 */

export type TurnLifecycleKind = "completed" | "aborted" | "failed";

export interface TurnLifecycleTerminal {
  readonly kind: TurnLifecycleKind;
  readonly turnId?: string;
  readonly message?: string;
  readonly cause?: string;
  readonly reason?: string;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

/**
 * Bounded legacy rule. Only these `error` payloads closed a turn before
 * `turn_failed` existed. Diagnostic causes such as `stop_hook_threw` are
 * intentionally excluded.
 */
export function isLegacyTurnFailureErrorPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const record = payload as {
    readonly terminal?: unknown;
    readonly cause?: unknown;
  };
  if (record.terminal === true) return true;
  return record.cause === "background_agent_error";
}

function payloadTurnId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const turnId = (payload as { readonly turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

function payloadString(
  payload: unknown,
  key: "message" | "cause" | "reason" | "lastAgentMessage",
): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function payloadNumber(
  payload: unknown,
  key: "completedAt" | "durationMs",
): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify a durable or daemon event as a turn lifecycle terminal, or
 * undefined when the event must not close the turn.
 */
function withTurnId(
  turnId: string | undefined,
  terminal: TurnLifecycleTerminal,
): TurnLifecycleTerminal {
  return turnId !== undefined ? { ...terminal, turnId } : terminal;
}

export function turnLifecycleTerminalFromEvent(event: {
  readonly type: string;
  readonly payload?: unknown;
}): TurnLifecycleTerminal | undefined {
  const payload = event.payload;
  const turnId = payloadTurnId(payload);

  if (event.type === "turn_complete") {
    const message = payloadString(payload, "lastAgentMessage");
    const completedAt = payloadNumber(payload, "completedAt");
    const durationMs = payloadNumber(payload, "durationMs");
    return withTurnId(turnId, {
      kind: "completed",
      ...(message !== undefined ? { message } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  if (event.type === "turn_aborted") {
    const reason = payloadString(payload, "reason") ?? "aborted";
    return withTurnId(turnId, {
      kind: "aborted",
      reason,
      ...(payloadString(payload, "reason") !== undefined
        ? { message: reason }
        : {}),
    });
  }

  if (event.type === "turn_failed") {
    const completedAt = payloadNumber(payload, "completedAt");
    const durationMs = payloadNumber(payload, "durationMs");
    return withTurnId(turnId, {
      kind: "failed",
      cause: payloadString(payload, "cause") ?? "turn_failed",
      message: payloadString(payload, "message") ?? "turn failed",
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  if (event.type === "error" && isLegacyTurnFailureErrorPayload(payload)) {
    return withTurnId(turnId, {
      kind: "failed",
      cause: payloadString(payload, "cause") ?? "legacy_terminal_error",
      message: payloadString(payload, "message") ?? "turn failed",
    });
  }

  return undefined;
}

export function isTurnLifecycleTerminalEvent(event: {
  readonly type: string;
  readonly payload?: unknown;
}): boolean {
  return turnLifecycleTerminalFromEvent(event) !== undefined;
}
