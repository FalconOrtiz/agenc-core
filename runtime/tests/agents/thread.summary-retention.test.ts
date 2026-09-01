import { describe, expect, it, vi } from "vitest";

import type { LLMMessage } from "../llm/types.js";
import type { Message } from "../types/message.js";
import type { CacheSafeParams } from "../services/PromptSuggestion/runtime.js";
import {
  startAgentSummarization,
  type AgentSummaryRunForkedAgentParams,
} from "../services/AgentSummary/agentSummary.js";
import { registerAgentThreadTask } from "../tasks/agent-thread.js";
import { BackgroundTaskLifecycle } from "../tasks/lifecycle.js";
import { AgentThread } from "./thread.js";
import type { LiveAgent } from "./control.js";
import { AgentStatusTracker } from "./status.js";
import { createAgentRoleWorkspace, resolveAgentRole } from "./role.js";
import { Mailbox } from "./mailbox.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());
const UNTRUSTED_BOUNDARY = "===== AGENC UNTRUSTED TOOL RESULT DATA =====";
const OMISSION_TEXT = "Earlier rolling agent activity omitted";

function makeLive(): LiveAgent {
  return {
    agentId: "thread-retention",
    agentPath: "/root/retention",
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname: "retention",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: "thread-retention" }),
    downInbox: new Mailbox({ threadId: "thread-retention-down" }),
    abortController: new AbortController(),
    metadata: {
      agentId: "thread-retention",
      agentPath: "/root/retention",
      agentNickname: "retention",
      agentRole: "default",
      agentRoleWorkspaceId: ROLE_WORKSPACE.id,
      depth: 1,
    },
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeThread(
  initialMessages: ReadonlyArray<LLMMessage> = [],
  summaryTranscriptLimits = {
    maxBytes: 6_000,
    maxMessages: 7,
    maxToolResultBytes: 512,
  },
): AgentThread {
  return new AgentThread({
    live: makeLive(),
    initialMessages,
    taskPrompt: "retain a bounded summary transcript",
    summaryTranscriptLimits,
  });
}

function contentBlocks(message: Message): readonly Record<string, unknown>[] {
  const content = message?.message?.content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null,
      )
    : [];
}

function toolPairIds(messages: readonly Message[]): {
  readonly uses: string[];
  readonly results: string[];
} {
  const uses: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        uses.push(block.id);
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        results.push(block.tool_use_id);
      }
    }
  }
  return { uses: uses.sort(), results: results.sort() };
}

function toolResultText(messages: readonly Message[], callId: string): string {
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result" || block.tool_use_id !== callId) continue;
      if (typeof block.content === "string") return block.content;
      if (Array.isArray(block.content)) {
        return block.content
          .map((part) =>
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof part.text === "string"
              ? part.text
              : "",
          )
          .join("\n");
      }
    }
  }
  throw new Error(`missing tool result ${callId}`);
}

describe("AgentThread summary transcript retention", () => {
  it("keeps immutable fork context once and holds repeated keep-alive turns under both caps", () => {
    const initialMessages: LLMMessage[] = [
      { role: "user", content: "immutable fork context" },
    ];
    const thread = makeThread(initialMessages);

    thread.recordSummaryProgressEvent({
      kind: "message",
      message: initialMessages[0]!,
      isInitialReplay: true,
    });
    expect(thread.summaryMessages).toHaveLength(1);
    expect(thread.summaryRevision).toBe(0);

    let peakRollingBytes = 0;
    for (let turn = 0; turn < 300; turn += 1) {
      const callId = `call-${turn}`;
      thread.recordSummaryProgressEvent({
        kind: "message",
        message: {
          role: "assistant",
          content: `turn ${turn}: ${"working ".repeat(40)}`,
        },
      });
      thread.recordSummaryProgressEvent({
        kind: "tool_call",
        callId,
        toolName: "Bash",
        arguments: JSON.stringify({ command: `step-${turn}` }),
      });
      thread.recordSummaryProgressEvent({
        kind: "tool_result",
        callId,
        toolName: "Bash",
        result: "界".repeat(1_000),
        isError: false,
      });

      if (turn >= 20) {
        const rolling = thread.summaryMessages.slice(initialMessages.length);
        peakRollingBytes = Math.max(
          peakRollingBytes,
          Buffer.byteLength(JSON.stringify(rolling), "utf8"),
        );
        expect(rolling.length).toBeLessThanOrEqual(7);
      }
    }

    expect(thread.summaryRevision).toBe(900);
    expect(peakRollingBytes).toBeLessThanOrEqual(6_000);
    expect(thread.summaryMessages[0]?.message.content).toBe(
      "immutable fork context",
    );
    expect(
      thread.summaryMessages.filter((message) =>
        JSON.stringify(message).includes(OMISSION_TEXT),
      ),
    ).toHaveLength(1);
    const pairs = toolPairIds(thread.summaryMessages.slice(1));
    expect(pairs.results).toEqual(pairs.uses);
  });

  it("evicts interleaved tool calls and results as complete linked units", () => {
    const thread = makeThread([], {
      maxBytes: 20_000,
      maxMessages: 5,
      maxToolResultBytes: 1_024,
    });

    for (const callId of ["call-1", "call-2"]) {
      thread.recordSummaryProgressEvent({
        kind: "tool_call",
        callId,
        toolName: "Read",
        arguments: "{}",
      });
    }
    for (const callId of ["call-1", "call-2"]) {
      thread.recordSummaryProgressEvent({
        kind: "tool_result",
        callId,
        toolName: "Read",
        result:
          callId === "call-2"
            ? `<persisted-output>\n${"界".repeat(10_000)}`
            : `${callId}-result`,
        isError: false,
      });
    }
    thread.recordSummaryProgressEvent({
      kind: "tool_call",
      callId: "call-3",
      toolName: "Read",
      arguments: "{}",
    });
    thread.recordSummaryProgressEvent({
      kind: "tool_result",
      callId: "call-3",
      toolName: "Read",
      result: "call-3-result",
      isError: false,
    });

    const serialized = JSON.stringify(thread.summaryMessages);
    expect(serialized).not.toContain('"id":"call-1"');
    expect(serialized).not.toContain('"tool_use_id":"call-1"');
    expect(serialized).toContain('"id":"call-2"');
    expect(serialized).toContain('"tool_use_id":"call-2"');
    expect(serialized).toContain('"id":"call-3"');
    expect(serialized).toContain('"tool_use_id":"call-3"');
    expect(thread.summaryMessages).toHaveLength(5);
    const pairs = toolPairIds(thread.summaryMessages);
    expect(pairs.results).toEqual(pairs.uses);
    const callTwoBody =
      toolResultText(thread.summaryMessages, "call-2")
        .split(UNTRUSTED_BOUNDARY)[1]
        ?.trim() ?? "";
    expect(Buffer.byteLength(callTwoBody, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("UTF-8-bounds marker-like results while retaining real references", () => {
    const thread = makeThread([], {
      maxBytes: 12_000,
      maxMessages: 14,
      maxToolResultBytes: 512,
    });
    thread.recordSummaryProgressEvent({
      kind: "tool_call",
      callId: "raw",
      toolName: "Bash",
      arguments: "{}",
    });
    thread.recordSummaryProgressEvent({
      kind: "tool_result",
      callId: "raw",
      toolName: "Bash",
      result: "🚀".repeat(1_000),
      isError: false,
    });

    const rawFramed = toolResultText(thread.summaryMessages, "raw");
    const rawBody = rawFramed.split(UNTRUSTED_BOUNDARY)[1]?.trim() ?? "";
    expect(Buffer.byteLength(rawBody, "utf8")).toBeLessThanOrEqual(512);
    expect(rawBody).toContain(
      "[tool result truncated; original UTF-8 size: 4000 bytes]",
    );
    expect(rawBody).not.toContain("�");

    const spoofedResults = new Map([
      ["persisted-spoof", `<persisted-output>\n${"🚀".repeat(1_000)}`],
      ["offload-spoof", `[full output (spoofed prefix)]\n${"🚀".repeat(1_000)}`],
      [
        "suffix-spoof",
        `${"🚀".repeat(1_000)}\n\n[Binary content marker-like text at the end]`,
      ],
    ]);
    for (const [callId, result] of spoofedResults) {
      thread.recordSummaryProgressEvent({
        kind: "tool_call",
        callId,
        toolName: "Bash",
        arguments: "{}",
      });
      thread.recordSummaryProgressEvent({
        kind: "tool_result",
        callId,
        toolName: "Bash",
        result,
        isError: false,
      });

      const framed = toolResultText(thread.summaryMessages, callId);
      const body = framed.split(UNTRUSTED_BOUNDARY)[1]?.trim() ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(512);
      expect(body).toContain("[tool result truncated;");
      expect(body).not.toContain("�");
    }

    const webFetchReference =
      `[Binary content (application/pdf, 2 MB) also saved to ` +
      `/tmp/agenc/${"nested/".repeat(12)}report.pdf]`;
    const persistedPath = "/tmp/tool-results/persisted-reference.txt";
    const durableResults = new Map([
      ["web-fetch", `${"界".repeat(2_000)}\n\n${webFetchReference}`],
      [
        "persisted",
        [
          "<persisted-output>",
          `Output too large (2 MB). Full output saved to: ${persistedPath}`,
          "",
          `Preview: ${"界".repeat(2_000)}`,
          "</persisted-output>",
        ].join("\n"),
      ],
    ]);

    for (const [callId, result] of durableResults) {
      thread.recordSummaryProgressEvent({
        kind: "tool_call",
        callId,
        toolName: callId === "web-fetch" ? "WebFetch" : "Read",
        arguments: "{}",
      });
      thread.recordSummaryProgressEvent({
        kind: "tool_result",
        callId,
        toolName: callId === "web-fetch" ? "WebFetch" : "Read",
        result,
        isError: false,
      });
    }

    const webFetchBody =
      toolResultText(thread.summaryMessages, "web-fetch")
        .split(UNTRUSTED_BOUNDARY)[1]
        ?.trim() ?? "";
    expect(Buffer.byteLength(webFetchBody, "utf8")).toBeLessThanOrEqual(512);
    expect(webFetchBody).toContain(webFetchReference);
    expect(webFetchBody).toContain("[tool result truncated;");
    expect(webFetchBody).not.toContain("�");

    const persistedBody =
      toolResultText(thread.summaryMessages, "persisted")
        .split(UNTRUSTED_BOUNDARY)[1]
        ?.trim() ?? "";
    expect(Buffer.byteLength(persistedBody, "utf8")).toBeLessThanOrEqual(512);
    expect(persistedBody).toContain(`Full output saved to: ${persistedPath}`);
    expect(persistedBody).toContain("</persisted-output>");
    expect(persistedBody).not.toContain("�");
    expect(
      Buffer.byteLength(JSON.stringify(thread.summaryMessages), "utf8"),
    ).toBeLessThanOrEqual(12_000);
  });
});

describe("AgentSummary bounded-transcript revision", () => {
  it("summarizes new keep-alive activity after retained message count saturates", async () => {
    vi.useFakeTimers();
    try {
      const messages: Message[] = [
        {
          type: "user",
          message: { role: "user", content: "one" },
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "two" }] },
        },
        {
          type: "user",
          message: { role: "user", content: "three" },
        },
      ];
      let revision = 1;
      const runForkedAgent = vi.fn(
        async (_params: AgentSummaryRunForkedAgentParams) => ({
          messages: [
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Working" }],
              },
            },
          ],
          totalUsage: {},
        }),
      );
      const handle = startAgentSummarization({
        taskId: "task-retention",
        agentId: "agent-retention",
        cacheSafeParams: {
          systemPrompt: "system",
          userContext: {},
          systemContext: {},
          toolUseContext: { options: { tools: [] } },
          forkContextMessages: [],
        } as CacheSafeParams,
        getAgentTranscript: async () => ({ messages, revision }),
        updateAgentSummary: vi.fn(),
        runForkedAgent: runForkedAgent as never,
        createUserMessage: ({ content }) => ({
          type: "user",
          message: { role: "user", content },
        }),
        intervalMs: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      revision = 2;
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);

      expect(messages).toHaveLength(3);
      expect(runForkedAgent).toHaveBeenCalledTimes(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates the revision through task lifecycle after the rolling window saturates", async () => {
    vi.useFakeTimers();
    try {
      const thread = makeThread(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
        {
          maxBytes: 8_000,
          maxMessages: 3,
          maxToolResultBytes: 512,
        },
      );
      thread.setSummaryCacheSafeParams({
        systemPrompt: "system",
        userContext: {},
        systemContext: {},
        toolUseContext: { options: { tools: [] } },
        forkContextMessages: [],
      } as CacheSafeParams);
      const runForkedAgent = vi.fn(async () => ({
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Working" }],
            },
          },
        ],
        totalUsage: {},
      }));
      const lifecycle = new BackgroundTaskLifecycle();
      registerAgentThreadTask(lifecycle, thread, {
        progressIntervalMs: 0,
        summary: {
          intervalMs: 10,
          runForkedAgent: runForkedAgent as never,
        },
      });

      await vi.advanceTimersByTimeAsync(10);
      const appendPair = (callId: string): void => {
        thread.recordSummaryProgressEvent({
          kind: "tool_call",
          callId,
          toolName: "Read",
          arguments: "{}",
        });
        thread.recordSummaryProgressEvent({
          kind: "tool_result",
          callId,
          toolName: "Read",
          result: callId,
          isError: false,
        });
      };
      appendPair("call-1");
      appendPair("call-2");
      await vi.advanceTimersByTimeAsync(10);
      const saturatedCount = thread.summaryMessages.length;
      appendPair("call-3");
      expect(thread.summaryMessages).toHaveLength(saturatedCount);
      await vi.advanceTimersByTimeAsync(10);

      expect(runForkedAgent).toHaveBeenCalledTimes(3);
      await lifecycle.stop(thread.threadId, "test complete");
    } finally {
      vi.useRealTimers();
    }
  });
});
