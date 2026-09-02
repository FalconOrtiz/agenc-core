import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { LLMProviderTraceEvent } from "../../src/llm/types.js";
import {
  createProviderTraceSink,
  providerTraceEnabled,
  summarizeProviderRequestParams,
} from "../../src/llm/provider-trace-sink.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agenc-trace-sink-"));
  homes.push(home);
  return home;
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const requestEvent: LLMProviderTraceEvent = {
  kind: "request",
  transport: "chat_stream",
  provider: "grok",
  model: "grok-4.6",
  payload: {
    model: "grok-4.6",
    input: [
      { role: "system", content: "static instructions" },
      { role: "user", content: "hello there" },
    ],
    tools: [{ type: "function", name: "FileRead" }, { type: "function", name: "Edit" }],
    prompt_cache_key: "conv-1",
    previous_response_id: "resp_0",
    reasoning: { effort: "xhigh" },
    parallel_tool_calls: true,
    max_output_tokens: 32_000,
    store: true,
    stream: true,
  },
  context: { requestMetrics: { totalContentChars: 30 } },
};

const responseEvent: LLMProviderTraceEvent = {
  kind: "response",
  transport: "chat_stream",
  provider: "grok",
  model: "grok-4.6",
  payload: {
    id: "resp_1",
    status: "completed",
    model: "grok-4.6",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "function_call", call_id: "call_1", name: "FileRead", arguments: "{}" },
    ],
    usage: {
      input_tokens: 154_304,
      output_tokens: 878,
      input_tokens_details: { cached_tokens: 151_680 },
      output_tokens_details: { reasoning_tokens: 348 },
    },
  },
};

describe("provider trace sink", () => {
  test("is gated by AGENC_PROVIDER_TRACE", () => {
    expect(providerTraceEnabled({})).toBe(false);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "0" })).toBe(false);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "1" })).toBe(true);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "true" })).toBe(true);
  });

  test("writes one request line and one response line per call without message bodies", () => {
    const home = tempHome();
    let clock = 1_000;
    const sink = createProviderTraceSink({
      agencHome: home,
      conversationId: "conv-1",
      now: () => clock,
      wallClock: () => "2026-09-02T00:00:00.000Z",
    });

    sink.onProviderTraceEvent(requestEvent);
    clock = 1_250;
    sink.onProviderTraceEvent({
      kind: "stream_event",
      transport: "chat_stream",
      provider: "grok",
      payload: { type: "response.created" },
    });
    sink.onProviderTraceEvent({
      kind: "stream_event",
      transport: "chat_stream",
      provider: "grok",
      payload: { type: "response.output_text.delta", delta: "done" },
    });
    clock = 13_400;
    sink.onProviderTraceEvent(responseEvent);

    expect(sink.directory).toBe(join(home, "agent-logs", "conv-1"));
    expect(readdirSync(sink.directory)).toEqual(["llm-00001.jsonl"]);
    const [request, response] = readLines(join(sink.directory, "llm-00001.jsonl"));

    expect(request).toMatchObject({
      kind: "request",
      seq: 1,
      conversationId: "conv-1",
      provider: "grok",
      model: "grok-4.6",
      params: {
        model: "grok-4.6",
        prompt_cache_key: "conv-1",
        previous_response_id: "resp_0",
        reasoning: { effort: "xhigh" },
        parallel_tool_calls: true,
        max_output_tokens: 32_000,
        store: true,
        input_items: 2,
        tool_count: 2,
        tool_names: ["FileRead", "Edit"],
      },
      context: { requestMetrics: { totalContentChars: 30 } },
    });
    const params = request?.params as Record<string, unknown>;
    expect(params.input).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("hello there");
    expect(JSON.stringify(request)).not.toContain("static instructions");

    expect(response).toMatchObject({
      kind: "response",
      seq: 1,
      elapsedMs: 12_400,
      firstStreamEventMs: 250,
      streamEvents: 2,
      response: {
        id: "resp_1",
        status: "completed",
        usage: {
          input_tokens: 154_304,
          output_tokens: 878,
          input_tokens_details: { cached_tokens: 151_680 },
          output_tokens_details: { reasoning_tokens: 348 },
        },
        output_items: 2,
        output_text_chars: 4,
        tool_calls: 1,
      },
    });
  });

  test("numbers files per request and records errors with elapsed time", () => {
    const home = tempHome();
    let clock = 0;
    const sink = createProviderTraceSink({
      agencHome: home,
      conversationId: "conv/with spaces",
      now: () => clock,
    });
    sink.onProviderTraceEvent(requestEvent);
    clock = 40;
    sink.onProviderTraceEvent(responseEvent);
    sink.onProviderTraceEvent(requestEvent);
    clock = 95;
    sink.onProviderTraceEvent({
      kind: "error",
      transport: "chat_stream",
      provider: "grok",
      payload: { name: "LLMRateLimitError", message: "rate limited", status: 429 },
    });

    const files = readdirSync(sink.directory).sort();
    expect(files).toEqual(["llm-00001.jsonl", "llm-00002.jsonl"]);
    const [, error] = readLines(join(sink.directory, "llm-00002.jsonl"));
    expect(error).toMatchObject({
      kind: "error",
      seq: 2,
      elapsedMs: 55,
      streamEvents: 0,
      error: { name: "LLMRateLimitError", status: 429 },
    });
  });

  test("summarizeProviderRequestParams reports absent routing fields as null", () => {
    expect(summarizeProviderRequestParams({ model: "grok-4.6", input: [] })).toEqual({
      model: "grok-4.6",
      prompt_cache_key: null,
      previous_response_id: null,
      reasoning: null,
      parallel_tool_calls: null,
      max_output_tokens: null,
      input_items: 0,
      input_chars: 2,
    });
  });
});
