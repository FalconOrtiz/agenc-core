import { vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";

export interface AdmittedToolHarness {
  readonly session: Session;
  readonly events: Event[];
  readonly acquire: ReturnType<typeof vi.fn>;
}

/**
 * A session that admits every tool call and collects the events it emits, so a
 * test can dispatch through `runAdmittedToolCall` and read back what the effect
 * gate filed. `label` names this test's admission scope: the run is
 * `run-${label}`, the session `session-${label}`, and callers pass
 * `turn-${label}` as the turn id.
 */
export function bindAdmittedToolHarness(options: {
  readonly workspaceRoot: string;
  readonly label: string;
  readonly toolPermissionContext?: ToolPermissionContext;
}): AdmittedToolHarness {
  const { workspaceRoot, label } = options;
  const events: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => events.push(event));
  const acquire = vi.fn(async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
    decision: "allow",
    reservation: {
      reservationId: input.stepId,
      step: { runId: `run-${label}`, stepId: input.stepId },
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: "2026-09-07T00:00:00.000Z",
    },
    request: {
      step: { runId: `run-${label}`, stepId: input.stepId },
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: workspaceRoot,
      sessionId: `session-${label}`,
      parentScopeId: `turn-${label}`,
      autonomous: false,
    },
    signal: new AbortController().signal,
  }));
  const admission = {
    scope: { runId: `run-${label}` },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
  } as unknown as ExecutionAdmissionClient;
  const session = {
    conversationId: `session-${label}`,
    eventLog,
    emit: (event: Event) => eventLog.emit(event),
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      permissionModeRegistry: new PermissionModeRegistry(
        options.toolPermissionContext ?? createEmptyToolPermissionContext(),
      ),
    },
  } as unknown as Session;
  return { session, events, acquire };
}
