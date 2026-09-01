import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenCSessionSnapshotPolicy } from "./snapshot-policy.js";
import {
  SESSION_SNAPSHOT_HARD_CAP,
  type AgentSnapshotPruningReport,
} from "./pruning.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import {
  readRotatedToolOutputLog,
  recordInFlightToolCallStart,
  resolveToolOutputLogPath,
} from "./tool-output-rotation.js";
import { recoverDaemonStateOnStartup } from "./recovery.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("AgenCSessionSnapshotPolicy", () => {
  it("snapshots message, tool, and status triggers into session_state_snapshots", () => {
    seedRun("run-1", "session-1");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:04.000Z",
        "2026-05-01T00:00:05.000Z",
        "2026-05-01T00:00:06.000Z",
        "2026-05-01T00:00:07.000Z",
      ]),
      agencHome: home,
    });

    policy.recordMessageExchange({
      sessionId: "session-1",
      agentId: "run-1",
      content: "hello",
      messageId: "message-1",
      streamId: "stream-1",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    policy.recordSessionEvent("session-1", {
      method: "event.tool_request",
      params: {
        eventId: "event-tool-1",
        requestId: "tool-1",
        toolName: "FileRead",
        recoveryCategory: "idempotent",
        input: { path: "a.txt" },
      },
    });
    policy.recordSessionEvent("session-1", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-1",
            result: "ok",
            isError: false,
          },
        },
      },
    });
    policy.recordAgentStatusTransition({
      sessionId: "session-1",
      agentId: "run-1",
      status: "running",
      transitionAt: "2026-05-01T00:00:03.000Z",
    });

    expect(snapshotCount("session-1")).toBe(4);
    const latest = latestSnapshot("session-1");
    expect(latest.toolState).toMatchObject({
      lastTrigger: "agent_status",
      inFlight: {},
      completed: {
        "tool-1": {
          requestId: "tool-1",
          recoveryCategory: "idempotent",
          status: "completed",
          result: "ok",
        },
      },
      statusTransitions: [
        {
          agentId: "run-1",
          status: "running",
          transitionAt: "2026-05-01T00:00:03.000Z",
        },
      ],
    });
    expect(latest.conversation).toEqual([
      {
        role: "user",
        agentId: "run-1",
        content: "hello",
        messageId: "message-1",
        streamId: "stream-1",
        acceptedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(runLastSnapshotAt("run-1")).toBe("2026-05-01T00:00:05.000Z");
  });

  // OOM fix: a long-lived (e.g. `agenc --dangerously-bypass-approvals-and-sandbox`) session fires many tool calls;
  // the in-memory `completed` map previously pinned the RAW result of every one
  // forever (unbounded large-payload growth → ~4GB heap → crash). Assert it is
  // now FIFO-capped and each retained result is truncated to a bounded preview.
  it("bounds the in-memory completed tool-call map and truncates large results (OOM fix)", () => {
    seedRun("run-oom", "session-oom");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxCompletedToolCalls: 50,
      maxInMemoryToolResultBytes: 1024,
    });

    const big = "x".repeat(64 * 1024); // 64 KB per result — the leak's payload shape
    const total = 300;
    for (let i = 0; i < total; i++) {
      policy.recordSessionEvent("session-oom", {
        method: "event.tool_request",
        params: {
          eventId: `evt-req-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
      policy.recordSessionEvent("session-oom", {
        method: "event.session_event",
        params: {
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: `${big}-${i}`, isError: false },
          },
        },
      });
    }
    // Same-instant events coalesce into one trailing write; flush it so the
    // assertion reads the final in-memory state.
    policy.flushPeriodic();

    const completed = latestSnapshot("session-oom").toolState.completed as Record<
      string,
      { result?: string }
    >;
    const keys = Object.keys(completed);
    // Before the fix this held all 300 entries (each pinning 64 KB).
    expect(keys.length).toBeLessThanOrEqual(50);
    // Oldest entries are evicted (FIFO); the newest survive.
    expect(completed["tool-0"]).toBeUndefined();
    expect(completed["tool-299"]).toBeDefined();
    // Each retained result is a bounded preview, not the full 64 KB payload
    // (the untruncated result lives in the rotated-output snapshot store).
    for (const key of keys) {
      expect((completed[key]?.result ?? "").length).toBeLessThan(2048);
    }
  });

  // OOM fix: `inFlight` normally drains on tool_call_completed/poisoned, but an
  // orphaned tool call (cancellation, crash, or a lost completion event)
  // previously pinned an entry forever — the sibling leak to `completed`, the
  // same unbounded-per-session class as #946/#947. Assert it is now FIFO-capped.
  it("bounds the in-memory in-flight tool-call map for orphaned calls (OOM fix)", () => {
    seedRun("run-oom-inflight", "session-oom-inflight");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxInFlightToolCalls: 50,
    });

    // 300 tool requests, NONE completed → all remain "in flight" (orphaned).
    const total = 300;
    for (let i = 0; i < total; i++) {
      policy.recordSessionEvent("session-oom-inflight", {
        method: "event.tool_request",
        params: {
          eventId: `evt-req-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
    }
    policy.flushPeriodic();

    const inFlight = latestSnapshot("session-oom-inflight").toolState
      .inFlight as Record<string, unknown>;
    const keys = Object.keys(inFlight);
    // Before the fix this held all 300 orphaned entries.
    expect(keys.length).toBeLessThanOrEqual(50);
    // Oldest are evicted (FIFO by insertion order); the newest survive.
    expect(inFlight["tool-0"]).toBeUndefined();
    expect(inFlight["tool-299"]).toBeDefined();
  });

  // The cap must not interfere with the happy-path lifecycle: a completed tool
  // call still drains its in-flight entry, so a well-behaved session keeps
  // `inFlight` near-empty regardless of the cap.
  it("drains in-flight entries on completion (cap leaves the happy path intact)", () => {
    seedRun("run-inflight-drain", "session-inflight-drain");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxInFlightToolCalls: 50,
    });

    for (let i = 0; i < 120; i++) {
      policy.recordSessionEvent("session-inflight-drain", {
        method: "event.tool_request",
        params: {
          eventId: `evt-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
      policy.recordSessionEvent("session-inflight-drain", {
        method: "event.session_event",
        params: {
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: "ok", isError: false },
          },
        },
      });
    }
    policy.flushPeriodic();

    const inFlight = latestSnapshot("session-inflight-drain").toolState
      .inFlight as Record<string, unknown>;
    expect(Object.keys(inFlight).length).toBe(0);
  });

  // OOM fix: the per-session status-transition log was an unbounded push target.
  it("bounds the status-transition log (OOM fix)", () => {
    seedRun("run-oom-st", "session-oom-st");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      maxStatusTransitions: 25,
    });
    for (let i = 0; i < 300; i++) {
      policy.recordAgentStatusTransition({
        sessionId: "session-oom-st",
        agentId: "run-oom-st",
        status: `status-${i}`, // distinct status forces a push (no dedup)
        transitionAt: "2026-05-01T00:00:00.000Z",
      });
    }
    policy.flushPeriodic();
    const transitions = latestSnapshot("session-oom-st").toolState
      .statusTransitions as unknown[];
    expect(transitions.length).toBeLessThanOrEqual(25);
  });

  // Review P0-1: one snapshot row per forwarded `agent_message_delta` produced
  // 4,931 rows / 980 MB for a single 82-minute desktop session, each row a
  // full re-serialization with four fsyncs on the RPC event loop. A chunk now
  // only extends the in-memory conversation tail; the dirty state rides the
  // next tool/status write or the periodic tick.
  it("does not write a snapshot row per streaming message chunk", () => {
    seedRun("run-chunks", "session-chunks");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
    });

    for (let i = 0; i < 1000; i++) {
      policy.recordSessionEvent("session-chunks", {
        method: "event.message_chunk",
        params: {
          agentId: "run-chunks",
          delta: `token-${i} `,
          messageId: "message-stream",
          streamId: "stream-1",
          eventId: `chunk-${i}`,
        },
      });
    }
    expect(snapshotCount("session-chunks")).toBe(0);

    // The periodic tick flushes the accumulated tail in one write.
    policy.flushPeriodic();
    expect(snapshotCount("session-chunks")).toBeLessThanOrEqual(2);
    const conversation = latestSnapshot("session-chunks").conversation as {
      delta: string;
    }[];
    expect(conversation).toHaveLength(200);
    expect(conversation.at(-1)?.delta).toBe("token-999 ");

    // A clean session does not write again.
    policy.flushPeriodic();
    expect(snapshotCount("session-chunks")).toBeLessThanOrEqual(2);
  });

  it("coalesces a burst of tool events into one leading and one trailing write", () => {
    seedRun("run-coalesce", "session-coalesce");
    const timers: (() => void)[] = [];
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      setTimeout: (callback, delayMs) => {
        expect(delayMs).toBeGreaterThan(0);
        expect(delayMs).toBeLessThanOrEqual(1_000);
        timers.push(callback);
        return { unref: vi.fn() };
      },
    });

    for (let i = 0; i < 50; i++) {
      policy.recordSessionEvent("session-coalesce", {
        method: "event.tool_request",
        params: {
          agentId: "run-coalesce",
          eventId: `evt-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
          input: { path: `${i}.txt` },
        },
      });
      policy.recordSessionEvent("session-coalesce", {
        method: "event.session_event",
        params: {
          agentId: "run-coalesce",
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: "ok", isError: false },
          },
        },
      });
    }

    // Leading edge: the first event of the burst is written immediately;
    // the other 99 events armed exactly one trailing timer.
    expect(snapshotCount("session-coalesce")).toBe(1);
    expect(timers).toHaveLength(1);

    timers[0]?.();
    expect(snapshotCount("session-coalesce")).toBe(2);
    expect(latestSnapshot("session-coalesce").toolState).toMatchObject({
      lastTrigger: "tool_call",
      inFlight: {},
      completed: { "tool-49": { status: "completed" } },
    });
    // Every tool result still landed row-by-row in the durable table.
    expect(inFlightToolOutput("session-coalesce", "tool-49").status).toBe(
      "completed",
    );
  });

  it("bounds tool inputs and keeps at most 20 completed calls in the snapshot", () => {
    seedRun("run-inputs", "session-inputs");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
    });
    const bigInput = { file_path: "a.txt", content: "x".repeat(64 * 1024) };

    for (let i = 0; i < 30; i++) {
      policy.recordSessionEvent("session-inputs", {
        method: "event.tool_request",
        params: {
          agentId: "run-inputs",
          eventId: `evt-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileWrite",
          input: bigInput,
        },
      });
      policy.recordSessionEvent("session-inputs", {
        method: "event.session_event",
        params: {
          agentId: "run-inputs",
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: "ok", isError: false },
          },
        },
      });
    }
    policy.flushPeriodic();

    const toolState = latestSnapshot("session-inputs").toolState as {
      completed: Record<string, { input?: unknown }>;
    };
    const keys = Object.keys(toolState.completed);
    expect(keys.length).toBe(20);
    expect(toolState.completed["tool-9"]).toBeUndefined();
    expect(toolState.completed["tool-29"]).toBeDefined();
    for (const key of keys) {
      const input = toolState.completed[key]?.input;
      expect(typeof input).toBe("string");
      expect((input as string).length).toBeLessThan(8 * 1024);
    }
    // The full arguments are persisted once, in in_flight_tool_calls.
    const args = driver
      .prepareState<[string], { args_json: string }>(
        "SELECT args_json FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("tool-29")?.args_json;
    expect(JSON.parse(args ?? "null")).toEqual(bigInput);
  });

  it("updates agent_runs from runner-emitted terminal run statuses", () => {
    seedRun("run-complete", "session-complete");
    seedRun("run-error", "session-error");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:10.000Z",
        "2026-05-01T00:00:11.000Z",
      ]),
    });

    policy.recordSessionEvent("session-complete", {
      method: "event.agent_status",
      params: {
        agentId: "run-complete",
        status: "idle",
        runStatus: "completed",
      },
    });
    policy.recordSessionEvent("session-error", {
      method: "event.agent_status",
      params: {
        agentId: "run-error",
        status: "error",
        runStatus: "errored",
      },
    });

    expect(runStatus("run-complete")).toEqual({
      status: "completed",
      last_active_at: "2026-05-01T00:00:10.000Z",
    });
    expect(runStatus("run-error")).toEqual({
      status: "errored",
      last_active_at: "2026-05-01T00:00:11.000Z",
    });
  });

  it("persists budget halt markers from runner-emitted agent status", () => {
    seedRun("run-budget", "session-budget");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:12.000Z"]),
    });
    const budgetHalt = {
      kind: "token_cap",
      cap: 10,
      observed: 12,
      reason: "token_cap:12",
      haltedAt: "2026-05-01T00:00:12.000Z",
      tokens: { input: 8, output: 4, total: 12 },
      costUsd: 0.0001,
      wallClockSeconds: 12,
      model: "gpt-5.4",
      provider: "openai",
    };
    const budgetUsage = {
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
      costUsd: 0.0001,
      costBasis: "input_output_token_usage",
    };

    policy.recordSessionEvent("session-budget", {
      method: "event.agent_status",
      params: {
        agentId: "run-budget",
        status: "stopped",
        runStatus: "stopped",
        message: "agent budget token_cap reached",
        budgetHalt,
        budgetUsage,
      },
    });

    expect(runStatus("run-budget")).toEqual({
      status: "stopped",
      last_active_at: "2026-05-01T00:00:12.000Z",
    });
    expect(runMetadata("run-budget")).toEqual({ budgetHalt, budgetUsage });
    expect(latestSnapshot("session-budget").toolState).toMatchObject({
      statusTransitions: [
        {
          agentId: "run-budget",
          status: "stopped",
          reason: "agent budget token_cap reached",
          metadataPatch: { budgetHalt, budgetUsage },
        },
      ],
    });
  });

  it("ignores array-shaped budget metadata in status events", () => {
    seedRun("run-budget-arrays", "session-budget-arrays");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:12.000Z", "2026-05-01T00:00:13.000Z"]),
    });

    policy.recordSessionEvent("session-budget-arrays", {
      method: "event.agent_status",
      params: {
        agentId: "run-budget-arrays",
        status: "stopped",
        runStatus: "stopped",
        message: "agent budget token_cap reached",
        budgetHalt: ["spoof"],
        budgetUsage: ["spoof"],
      },
    });

    expect(runMetadata("run-budget-arrays")).toBeNull();
    const [transition] = latestSnapshot("session-budget-arrays").toolState
      .statusTransitions as Record<string, unknown>[];
    expect(transition).toMatchObject({
      agentId: "run-budget-arrays",
      status: "stopped",
      reason: "agent budget token_cap reached",
    });
    expect(transition).not.toHaveProperty("metadataPatch");
  });

  it("periodically flushes tracked sessions and stops the timer", () => {
    const clearInterval = vi.fn();
    let tick: (() => void) | undefined;
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:30.000Z",
      ]),
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        tick = callback;
        return { unref: vi.fn() };
      },
      clearInterval,
    });

    policy.recordMessageExchange({
      sessionId: "session-periodic",
      agentId: "agent-periodic",
      content: "watch",
      messageId: "message-periodic",
      streamId: "stream-periodic",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    // A streaming chunk dirties the session without writing; the periodic
    // tick is what lands it.
    policy.recordSessionEvent("session-periodic", {
      method: "event.message_chunk",
      params: {
        agentId: "agent-periodic",
        delta: "hello",
        messageId: "message-assistant",
        streamId: "stream-periodic",
        eventId: "chunk-periodic",
      },
    });
    policy.startPeriodic();
    tick?.();
    policy.stopPeriodic();

    expect(snapshotCount("session-periodic")).toBe(2);
    expect(latestSnapshot("session-periodic").toolState).toMatchObject({
      lastTrigger: "periodic",
    });
    expect(latestSnapshot("session-periodic").conversation).toEqual([
      expect.objectContaining({ role: "user", content: "watch" }),
      expect.objectContaining({ role: "assistant", delta: "hello" }),
    ]);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  // Review P1-3: after the measured runs ended, every tracked session still
  // received a 30 s periodic snapshot forever (21 per session in ten idle
  // minutes, up to 349 KB and four fsyncs each) with the desktop idle.
  it("flushPeriodic writes nothing for a session without changes", () => {
    seedRun("run-idle", "session-idle");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
    });
    policy.recordMessageExchange({
      sessionId: "session-idle",
      agentId: "run-idle",
      content: "one",
      messageId: "message-idle",
      streamId: "stream-idle",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(snapshotCount("session-idle")).toBe(1);

    for (let tick = 0; tick < 21; tick++) {
      expect(policy.flushPeriodic()).toEqual([]);
    }
    expect(snapshotCount("session-idle")).toBe(1);
    expect(policy.trackedSessionIds()).toEqual(["session-idle"]);
    expect(policy.flushSession("session-idle")).toBeUndefined();
  });

  it("close flushes dirty sessions once and forgets them", () => {
    seedRun("run-close", "session-close");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
    });
    policy.recordSessionEvent("session-close", {
      method: "event.message_chunk",
      params: {
        agentId: "run-close",
        delta: "partial",
        messageId: "message-close",
        streamId: "stream-close",
        eventId: "chunk-close",
      },
    });
    expect(snapshotCount("session-close")).toBe(0);

    policy.close();

    expect(snapshotCount("session-close")).toBe(1);
    expect(latestSnapshot("session-close").conversation).toEqual([
      expect.objectContaining({ role: "assistant", delta: "partial" }),
    ]);
    expect(policy.trackedSessionIds()).toEqual([]);
  });

  it("hydrates recovered session state before periodic flush", () => {
    seedRun("run-hydrate", "session-hydrate");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:30.000Z"]),
    });

    policy.hydrateSession({
      sessionId: "session-hydrate",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversation: [{ role: "assistant", content: "previous" }],
      toolState: {
        pending: ["tool-hydrate"],
        inFlight: {
          "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
        },
      },
      mcpConnectionState: { connected: true },
    });
    policy.flushPeriodic();

    const latest = latestSnapshot("session-hydrate");
    expect(latest.conversation).toEqual([
      { role: "assistant", content: "previous" },
    ]);
    expect(latest.toolState).toMatchObject({
      lastTrigger: "periodic",
      pending: ["tool-hydrate"],
      inFlight: {
        "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
      },
    });
    expect(latest.mcpConnectionState).toMatchObject({ connected: true });
    expect(runLastSnapshotAt("run-hydrate")).toBe(
      "2026-05-01T00:00:30.000Z",
    );
  });

  it("drops array-shaped hydrated tool-state maps before flushing", () => {
    seedRun("run-hydrate-arrays", "session-hydrate-arrays");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:30.000Z"]),
    });

    policy.hydrateSession({
      sessionId: "session-hydrate-arrays",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversation: [],
      toolState: {
        inFlight: ["spoof"],
        completed: ["spoof"],
      },
      mcpConnectionState: {},
    });
    policy.flushPeriodic();

    expect(latestSnapshot("session-hydrate-arrays").toolState).toMatchObject({
      inFlight: {},
      completed: {},
      lastTrigger: "periodic",
    });
  });

  it("persists session agent ownership for retention pruning", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver);

    policy.trackSession("session-linked", "agent-linked");

    expect(sessionAgent("session-linked")).toBe("agent-linked");
  });

  it("keeps tool identity for completion-only tool events", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:00.000Z"]),
    });

    policy.recordSessionEvent("session-completion-only", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-completion-only",
            result: "done",
            isError: false,
            metadata: {
              toolName: "FileRead",
            },
          },
        },
      },
    });

    expect(latestSnapshot("session-completion-only").toolState).toMatchObject({
      completed: {
        "tool-completion-only": {
          requestId: "tool-completion-only",
          toolName: "FileRead",
          status: "completed",
          result: "done",
        },
      },
    });
  });

  it("persists replay poison events as terminal recovery state", () => {
    seedRun("run-replay-poison", "session-replay-poison");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
      ]),
      agencHome: home,
    });

    policy.recordSessionEvent("session-replay-poison", {
      method: "event.tool_request",
      params: {
        agentId: "run-replay-poison",
        requestId: "tool-replay-poison",
        toolName: "FileWrite",
        recoveryCategory: "idempotent",
        input: { file_path: "a.txt", content: "x" },
      },
    });
    policy.recordSessionEvent("session-replay-poison", {
      method: "event.session_event",
      params: {
        agentId: "run-replay-poison",
        event: {
          type: "tool_call_recovery_poisoned",
          payload: {
            callId: "tool-replay-poison",
            result: "current registry says side-effecting",
            metadata: {
              toolName: "FileWrite",
              recoveryCategory: "side-effecting",
            },
          },
        },
      },
    });
    // The poison lands within the coalescing window of the request write.
    policy.flushPeriodic();

    expect(latestSnapshot("session-replay-poison").toolState).toMatchObject({
      inFlight: {},
      completed: {
        "tool-replay-poison": {
          requestId: "tool-replay-poison",
          toolName: "FileWrite",
          recoveryCategory: "side-effecting",
          recoveryAction: "poison",
          status: "poisoned",
          result: "current registry says side-effecting",
        },
      },
    });
    expect(inFlightToolOutput("session-replay-poison", "tool-replay-poison"))
      .toMatchObject({
        status: "poisoned",
        output_partial: "current registry says side-effecting",
      });
    expect(
      inFlightToolRecoveryCategory(
        "session-replay-poison",
        "tool-replay-poison",
      ),
    ).toBe("side-effecting");
  });

  it("persists capped tool output rows from daemon tool events", () => {
    seedRun("agent-output", "session-output");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
      ]),
      outputRotation: {
        outputPartialMaxBytes: 4,
        logMaxBytes: 3,
        rotatedLogCount: 1,
      },
    });

    policy.recordSessionEvent("session-output", {
      method: "event.tool_request",
      params: {
        agentId: "agent-output",
        eventId: "event-tool-output-start",
        requestId: "tool-output",
        toolName: "Bash",
        input: { command: "printf output" },
      },
    });
    policy.recordSessionEvent("session-output", {
      method: "event.session_event",
      params: {
        agentId: "agent-output",
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-output",
            result: "abcdefghij",
            isError: false,
            metadata: {
              toolName: "Bash",
            },
          },
        },
      },
    });

    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-output",
      toolCallId: "tool-output",
    });
    expect(inFlightToolOutput("session-output", "tool-output")).toEqual({
      status: "completed",
      output_partial: "abcd",
      output_log_path: outputLogPath,
      output_log_bytes: 6,
    });
    expect(existsSync(outputLogPath)).toBe(true);
    expect(existsSync(`${outputLogPath}.1`)).toBe(true);
    expect(inFlightToolRecoveryCategory("session-output", "tool-output")).toBe(
      "side-effecting",
    );
  });

  it("persists capped running output from tool_progress chunks", () => {
    seedRun("agent-progress", "session-progress");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:04.000Z",
        "2026-05-01T00:00:05.000Z",
      ]),
      outputRotation: {
        outputPartialMaxBytes: 4,
        logMaxBytes: 3,
        rotatedLogCount: 1,
      },
    });

    policy.recordSessionEvent("session-progress", {
      method: "event.tool_request",
      params: {
        agentId: "agent-progress",
        eventId: "event-tool-progress-start",
        requestId: "tool-progress",
        toolName: "Bash",
        input: { command: "printf output" },
      },
    });
    for (const chunk of ["abc", "def", "ghij"]) {
      policy.recordSessionEvent("session-progress", {
        method: "event.session_event",
        params: {
          agentId: "agent-progress",
          event: {
            type: "tool_progress",
            payload: {
              callId: "tool-progress",
              toolName: "Bash",
              chunk,
            },
          },
        },
      });
    }

    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-progress",
      toolCallId: "tool-progress",
    });
    expect(inFlightToolOutput("session-progress", "tool-progress")).toEqual({
      status: "running",
      output_partial: "abcd",
      output_log_path: outputLogPath,
      output_log_bytes: 6,
    });
    expect(readRotatedToolOutputLog(outputLogPath, {
      outputPartialMaxBytes: 4,
      logMaxBytes: 3,
      rotatedLogCount: 1,
    })).toBe("efghij");
    expect(existsSync(outputLogPath)).toBe(true);
    expect(existsSync(`${outputLogPath}.1`)).toBe(true);
  });

  it("applies snapshotRetention on writes separated by the prune interval", () => {
    seedRun("run-retention", "session-retention");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:01:01.000Z",
        "2026-05-01T00:02:02.000Z",
      ]),
      snapshotRetention: { snapshot_max_count: 2 },
    });

    for (const [index, at] of [
      [1, "2026-05-01T00:00:00.000Z"],
      [2, "2026-05-01T00:01:01.000Z"],
      [3, "2026-05-01T00:02:02.000Z"],
    ] as const) {
      policy.recordMessageExchange({
        sessionId: "session-retention",
        agentId: "run-retention",
        content: `message-${index}`,
        messageId: `message-${index}`,
        streamId: "stream-retention",
        acceptedAt: at,
      });
    }

    expect(snapshotCount("session-retention")).toBe(2);
    expect(latestSnapshot("session-retention").conversation).toEqual([
      expect.objectContaining({ content: "message-1" }),
      expect.objectContaining({ content: "message-2" }),
      expect.objectContaining({ content: "message-3" }),
    ]);
    expect(runLastSnapshotAt("run-retention")).toBe(
      "2026-05-01T00:02:02.000Z",
    );
  });

  // Review P0-2: the previous sweep was a table-wide LENGTH() scan throttled
  // to once per minute, and the configured 64 MiB cap never deleted a row.
  // The per-session prune is cheap enough to run on every write, and its
  // report surfaces on the periodic tick instead of per write.
  it("applies snapshot retention on every write and reports pruning on the periodic tick", () => {
    seedRun("run-retention-fast", "session-retention-fast");
    const reports: AgentSnapshotPruningReport[] = [];
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
      ]),
      snapshotRetention: { snapshot_max_count: 2 },
      onPruneReport: (report) => reports.push(report),
    });

    for (const index of [1, 2, 3]) {
      policy.recordMessageExchange({
        sessionId: "session-retention-fast",
        agentId: "run-retention-fast",
        content: `message-${index}`,
        messageId: `message-${index}`,
        streamId: "stream-retention-fast",
        acceptedAt: `2026-05-01T00:00:0${index}.000Z`,
      });
      expect(snapshotCount("session-retention-fast")).toBeLessThanOrEqual(2);
    }
    expect(snapshotCount("session-retention-fast")).toBe(2);
    expect(latestSnapshot("session-retention-fast").conversation).toHaveLength(3);
    expect(reports).toEqual([]);

    policy.flushPeriodic();
    expect(reports).toEqual([
      { prunedSnapshots: 1, prunedSessionIds: ["session-retention-fast"] },
    ]);
    expect(snapshotCount("session-retention-fast")).toBe(2);
    // Nothing new to report on a quiet tick.
    policy.flushPeriodic();
    expect(reports).toHaveLength(1);
  });

  it("hard-caps snapshot rows per session without any configured retention", () => {
    seedRun("run-hard-cap", "session-hard-cap");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      coalesceIntervalMs: 0,
    });

    for (let index = 0; index < SESSION_SNAPSHOT_HARD_CAP + 10; index++) {
      policy.recordMessageExchange({
        sessionId: "session-hard-cap",
        agentId: "run-hard-cap",
        content: `message-${index}`,
        messageId: `message-${index}`,
        streamId: "stream-hard-cap",
        acceptedAt: "2026-05-01T00:00:00.000Z",
      });
    }

    expect(snapshotCount("session-hard-cap")).toBe(SESSION_SNAPSHOT_HARD_CAP);
    expect(latestSnapshot("session-hard-cap").conversation).toHaveLength(
      SESSION_SNAPSHOT_HARD_CAP + 10,
    );
  });
});

describe("unknown-outcome gate violations in snapshots", () => {
  it("persists (and round-trips) the flag-mode violation for a poisoned session", () => {
    seedRun("run-gate", "session-gate");
    // Crash-poison a side-effecting call through real recovery.
    recordInFlightToolCallStart(driver, {
      sessionId: "session-gate",
      agentId: "run-gate",
      toolCallId: "tool-poisoned",
      toolName: "Bash",
      args: { command: "curl -X POST https://example.invalid/charge" },
      startedAt: "2026-05-01T00:00:00.000Z",
      recoveryCategory: "side-effecting",
      agencHome: home,
    });
    recoverDaemonStateOnStartup(driver);
    // The observer records a NEW already-dispatched side-effecting call:
    // flag mode must record it AND persist the violation into the snapshot.
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:01.000Z",
      agencHome: home,
    });
    policy.recordSessionEvent("session-gate", {
      method: "event.tool_request",
      params: {
        eventId: "event-gate-1",
        requestId: "tool-dependent",
        toolName: "Bash",
        recoveryCategory: "side-effecting",
        input: { command: "echo dependent" },
      },
    });
    const inFlight = latestSnapshot("session-gate").toolState as {
      inFlight: Record<string, Record<string, unknown>>;
    };
    expect(
      inFlight.inFlight["tool-dependent"]?.unknownOutcomeGateViolation,
    ).toEqual({
      blockedBy: [{ toolCallId: "tool-poisoned", toolName: "Bash" }],
    });
    // The dependent call itself was still recorded (observer never loses
    // bookkeeping).
    const row = driver
      .prepareState<[string], { status?: string }>(
        "SELECT status FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("tool-dependent");
    expect(row).toEqual({ status: "running" });
  });
});

function seedRun(runId: string, sessionId: string): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      "snapshot work",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      sessionId,
      "client-1",
      null,
    );
}

function snapshotCount(sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM session_state_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function latestSnapshot(sessionId: string): {
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
} {
  const row = driver
    .prepareState<
      [string],
      {
        conversation_json: string;
        tool_state_json: string;
        mcp_connection_state_json: string;
      }
    >(
      `SELECT conversation_json, tool_state_json, mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) throw new Error("snapshot missing");
  return {
    conversation: JSON.parse(row.conversation_json),
    toolState: JSON.parse(row.tool_state_json),
    mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
  };
}

function runLastSnapshotAt(runId: string): string | null {
  return (
    driver
      .prepareState<[string], { last_snapshot_at: string | null }>(
        "SELECT last_snapshot_at FROM agent_runs WHERE id = ?",
      )
      .get(runId)?.last_snapshot_at ?? null
  );
}

function runStatus(runId: string): {
  readonly status: string;
  readonly last_active_at: string;
} | undefined {
  return driver
    .prepareState<[string], { status: string; last_active_at: string }>(
      "SELECT status, last_active_at FROM agent_runs WHERE id = ?",
    )
    .get(runId);
}

function runMetadata(runId: string): unknown {
  const value = driver
    .prepareState<[string], { metadata_json: string | null }>(
      "SELECT metadata_json FROM agent_runs WHERE id = ?",
    )
    .get(runId)?.metadata_json;
  return value === null || value === undefined ? null : JSON.parse(value);
}

function sessionAgent(sessionId: string): string | undefined {
  return driver
    .prepareState<[string], { agent_id: string }>(
      "SELECT agent_id FROM session_agent_links WHERE session_id = ?",
    )
    .get(sessionId)?.agent_id;
}

function inFlightToolOutput(
  sessionId: string,
  toolCallId: string,
): {
  readonly status: string;
  readonly output_partial: string | null;
  readonly output_log_path: string | null;
  readonly output_log_bytes: number;
} {
  const row = driver
    .prepareState<
      [string, string],
      {
        status: string;
        output_partial: string | null;
        output_log_path: string | null;
        output_log_bytes: number;
      }
    >(
      `SELECT status, output_partial, output_log_path, output_log_bytes
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId);
  if (row === undefined) throw new Error("tool output row missing");
  return row;
}

function inFlightToolRecoveryCategory(
  sessionId: string,
  toolCallId: string,
): string | undefined {
  return driver
    .prepareState<[string, string], { recovery_category: string }>(
      `SELECT recovery_category
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId)?.recovery_category;
}

function clock(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? values.at(-1);
    if (value === undefined) throw new Error("empty clock");
    index += 1;
    return value;
  };
}
