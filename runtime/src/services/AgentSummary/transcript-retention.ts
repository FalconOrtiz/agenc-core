import type { LLMMessage } from "../../llm/types.js";
import type { Message } from "../../types/message.js";
import type { RunAgentProgressEvent } from "../../agents/run-agent.js";
import {
  llmMessageToAgentSummaryMessage,
  runAgentProgressEventToAgentSummaryMessage,
} from "./transcript.js";

export interface AgentSummaryTranscriptLimits {
  /** Maximum JSON-serialized UTF-8 bytes retained for rolling activity. */
  readonly maxBytes: number;
  /** Maximum retained rolling messages, including the omission marker. */
  readonly maxMessages: number;
  /** Maximum UTF-8 bytes retained inline for one raw tool result. */
  readonly maxToolResultBytes: number;
}

export type AgentSummaryTranscriptLimitOverrides =
  Partial<AgentSummaryTranscriptLimits>;

export const DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxMessages: 256,
  maxToolResultBytes: 64 * 1024,
}) satisfies AgentSummaryTranscriptLimits;

const MIN_TRANSCRIPT_BYTES = 512;
const MIN_TRANSCRIPT_MESSAGES = 3;
const MIN_TOOL_RESULT_BYTES = 128;
const EPOCH_TIMESTAMP = new Date(0).toISOString();

type ToolMessageIds = {
  readonly uses: ReadonlySet<string>;
  readonly results: ReadonlySet<string>;
  readonly all: ReadonlySet<string>;
};

function resolvedLimit(
  name: keyof AgentSummaryTranscriptLimits,
  value: number,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `AgentSummary transcript ${name} must be a safe integer >= ${minimum}`,
    );
  }
  return value;
}

function resolveLimits(
  overrides: AgentSummaryTranscriptLimitOverrides,
): AgentSummaryTranscriptLimits {
  const maxBytes = resolvedLimit(
    "maxBytes",
    overrides.maxBytes ?? DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxBytes,
    MIN_TRANSCRIPT_BYTES,
  );
  const maxMessages = resolvedLimit(
    "maxMessages",
    overrides.maxMessages ??
      DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxMessages,
    MIN_TRANSCRIPT_MESSAGES,
  );
  const maxToolResultBytes = resolvedLimit(
    "maxToolResultBytes",
    overrides.maxToolResultBytes ??
      DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxToolResultBytes,
    MIN_TOOL_RESULT_BYTES,
  );
  if (maxToolResultBytes > maxBytes) {
    throw new RangeError(
      "AgentSummary transcript maxToolResultBytes must not exceed maxBytes",
    );
  }
  return { maxBytes, maxMessages, maxToolResultBytes };
}

function messageContent(message: Message): readonly unknown[] {
  if (typeof message !== "object" || message === null) return [];
  const envelope = (message as { readonly message?: unknown }).message;
  if (typeof envelope !== "object" || envelope === null) return [];
  const content = (envelope as { readonly content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function toolMessageIds(message: Message): ToolMessageIds {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const block of messageContent(message)) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly tool_use_id?: unknown;
    };
    if (
      record.type === "tool_use" &&
      typeof record.id === "string" &&
      record.id.length > 0
    ) {
      uses.add(record.id);
    }
    if (
      record.type === "tool_result" &&
      typeof record.tool_use_id === "string" &&
      record.tool_use_id.length > 0
    ) {
      results.add(record.tool_use_id);
    }
  }
  return { uses, results, all: new Set([...uses, ...results]) };
}

function serializedMessageBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function serializedArrayBytes(payloadBytes: number, count: number): number {
  return 2 + payloadBytes + Math.max(0, count - 1);
}

function utf8Prefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function isDurableToolResultReference(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<persisted-output>") ||
    trimmed.startsWith("[full output (")
  );
}

function clampRawToolResult(text: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes || isDurableToolResultReference(text)) {
    return text;
  }
  const marker =
    `\n[tool result truncated; original UTF-8 size: ${originalBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefix = utf8Prefix(text, Math.max(0, maxBytes - markerBytes));
  return `${prefix}${marker}`;
}

function boundedProgressEvent(
  event: RunAgentProgressEvent,
  maxToolResultBytes: number,
): RunAgentProgressEvent {
  if (event.kind !== "tool_result") return event;
  const result = clampRawToolResult(event.result, maxToolResultBytes);
  return result === event.result ? event : { ...event, result };
}

function omissionMarker(
  omittedMessages: number,
  omittedBytes: number,
): Message {
  return {
    type: "user",
    uuid: "agent-summary-rolling-omission",
    timestamp: EPOCH_TIMESTAMP,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `[Earlier rolling agent activity omitted: ${omittedMessages} ` +
            `messages / ${omittedBytes} serialized UTF-8 bytes.]`,
        },
      ],
    },
  } as Message;
}

/**
 * Immutable fork context plus a bounded rolling activity window.
 *
 * The rolling window is measured as a JSON array in serialized UTF-8 bytes.
 * Tool-linked messages are evicted as a connected unit, so interleaved calls
 * and results cannot leave either half of a completed pair behind.
 */
export class AgentSummaryTranscript {
  private readonly forkContextMessages: ReadonlyArray<Message>;
  private readonly limits: AgentSummaryTranscriptLimits;
  private rollingMessages: Message[] = [];
  private rollingPayloadBytes = 0;
  private omittedMessages = 0;
  private omittedBytes = 0;
  private nextMessageIndex: number;
  private revisionValue = 0;

  constructor(
    initialMessages: ReadonlyArray<LLMMessage>,
    limitOverrides: AgentSummaryTranscriptLimitOverrides = {},
  ) {
    this.limits = resolveLimits(limitOverrides);
    this.forkContextMessages = Object.freeze(
      initialMessages.map(llmMessageToAgentSummaryMessage),
    );
    this.nextMessageIndex = this.forkContextMessages.length;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get messages(): ReadonlyArray<Message> {
    const marker = this.currentOmissionMarker();
    return marker === null
      ? [...this.forkContextMessages, ...this.rollingMessages]
      : [...this.forkContextMessages, marker, ...this.rollingMessages];
  }

  record(event: RunAgentProgressEvent): void {
    if (event.kind === "message" && event.isInitialReplay === true) return;
    const message = runAgentProgressEventToAgentSummaryMessage(
      boundedProgressEvent(event, this.limits.maxToolResultBytes),
      this.nextMessageIndex,
    );
    if (message === null) return;
    this.nextMessageIndex += 1;
    this.revisionValue += 1;

    const ids = toolMessageIds(message);
    if (
      ids.results.size > 0 &&
      [...ids.results].some((id) => !this.hasRollingToolUse(id))
    ) {
      this.noteOmitted([message]);
      this.enforceLimits();
      return;
    }

    this.rollingMessages.push(message);
    this.rollingPayloadBytes += serializedMessageBytes(message);
    this.enforceLimits();
  }

  private hasRollingToolUse(id: string): boolean {
    return this.rollingMessages.some((message) =>
      toolMessageIds(message).uses.has(id),
    );
  }

  private currentOmissionMarker(): Message | null {
    return this.omittedMessages === 0
      ? null
      : omissionMarker(this.omittedMessages, this.omittedBytes);
  }

  private retainedRollingSize(): {
    readonly bytes: number;
    readonly messages: number;
  } {
    const marker = this.currentOmissionMarker();
    const markerCount = marker === null ? 0 : 1;
    const markerBytes = marker === null ? 0 : serializedMessageBytes(marker);
    const messages = this.rollingMessages.length + markerCount;
    return {
      bytes: serializedArrayBytes(
        this.rollingPayloadBytes + markerBytes,
        messages,
      ),
      messages,
    };
  }

  private enforceLimits(): void {
    while (true) {
      const retained = this.retainedRollingSize();
      if (
        retained.bytes <= this.limits.maxBytes &&
        retained.messages <= this.limits.maxMessages
      ) {
        return;
      }
      if (this.rollingMessages.length === 0) {
        throw new Error("AgentSummary omission marker exceeds transcript limits");
      }
      this.noteOmitted(this.removeOldestLinkedUnit());
    }
  }

  private removeOldestLinkedUnit(): Message[] {
    const indexes = new Set<number>([0]);
    const linkedIds = new Set(toolMessageIds(this.rollingMessages[0]!).all);
    let changed = linkedIds.size > 0;
    while (changed) {
      changed = false;
      for (let index = 1; index < this.rollingMessages.length; index += 1) {
        if (indexes.has(index)) continue;
        const ids = toolMessageIds(this.rollingMessages[index]!).all;
        if (![...ids].some((id) => linkedIds.has(id))) continue;
        indexes.add(index);
        for (const id of ids) linkedIds.add(id);
        changed = true;
      }
    }

    const removed: Message[] = [];
    const retained: Message[] = [];
    for (let index = 0; index < this.rollingMessages.length; index += 1) {
      const message = this.rollingMessages[index]!;
      if (indexes.has(index)) {
        removed.push(message);
        this.rollingPayloadBytes -= serializedMessageBytes(message);
      } else {
        retained.push(message);
      }
    }
    this.rollingMessages = retained;
    return removed;
  }

  private noteOmitted(messages: ReadonlyArray<Message>): void {
    this.omittedMessages += messages.length;
    this.omittedBytes += messages.reduce(
      (total, message) => total + serializedMessageBytes(message),
      0,
    );
  }
}
