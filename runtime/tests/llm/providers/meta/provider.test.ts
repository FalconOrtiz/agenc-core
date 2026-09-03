import { describe, expect, test, vi } from "vitest";

import { resolveProviderCapabilityEntry } from "../../capabilities.js";
import { createProvider, readProviderIdentity } from "../../provider.js";
import { resolveProviderCredentialAuthority } from "../../provider-options.js";
import { MetaProvider } from "./index.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";
import { getTokenizerConfigForProvider } from "../../token-estimation.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";

function successfulChat(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_meta",
      model,
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("MetaProvider", () => {
  test("factory uses Meta chat completions with bearer auth", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulChat(model));
    const provider = createProvider("meta", {
      apiKey: "meta-test",
      extra: { fetchImpl },
    });

    expect(provider).toBeInstanceOf(MetaProvider);
    expect(readProviderIdentity(provider)).toBe("meta");

    const response = await provider.chat([{ role: "user", content: "hello" }]);
    expect(response.content).toBe("ok");

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.meta}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer meta-test");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model, stream: false });
    expect(body.max_completion_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeUndefined();
  });

  test("requires an explicit resolved Meta credential", () => {
    expect(() => createProvider("meta", {})).toThrow(/meta.*apiKey/i);
  });

  test.each(BUILT_IN_PROVIDER_MODEL_CATALOG.meta)(
    "registers and routes chat model %s",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new MetaProvider({
        apiKey: "meta-test",
        model,
        fetchImpl,
      });

      await provider.chat([{ role: "user", content: "hello" }]);

      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(model);
      expect(resolveModelCatalogMetadata({ provider: "meta", model })).toEqual({
        contextWindow: 1_048_576,
        maxContextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        maxOutputTokensUpperLimit: 131_072,
      });
      expect(resolveProviderCapabilityEntry({ provider: "meta", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsStructuredOutput: false,
          supportsImageInput: false,
          supportsProviderNativeWebSearch: false,
          acceptsReasoningEffort: true,
        });
      expect(
        resolveRegisteredModelCatalogEntry({ provider: "meta", model }),
      ).toMatchObject({
        supportedReasoningLevels: [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ],
        defaultReasoningLevel: "medium",
      });
    },
  );

  test("forwards only Meta's accepted reasoning levels", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulChat(model));
    const provider = new MetaProvider({ apiKey: "meta-test", model, fetchImpl });

    await provider.chat(
      [{ role: "user", content: "reason carefully" }],
      { reasoningEffort: "xhigh" },
    );
    await provider.chat(
      [{ role: "user", content: "reason carefully" }],
      { reasoningEffort: "none" },
    );

    const acceptedBody = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    const rejectedBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(acceptedBody.reasoning_effort).toBe("xhigh");
    expect(rejectedBody.reasoning_effort).toBeUndefined();

    const hints = chatCompletionsCapabilityHintsForProvider("meta", model);
    expect(hints.acceptsReasoningEffort).toBe(true);
    expect([...(hints.reasoningEffortAllowedValues ?? [])]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("downgrades unsupported required tool choice to auto", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      tools: [
        {
          type: "function",
          function: {
            name: "system.echo",
            description: "Echo text.",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
      fetchImpl,
    });

    await provider.chat(
      [{ role: "user", content: "use a tool" }],
      { toolChoice: "required" },
    );

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toBeInstanceOf(Array);
  });

  test("resolves the Meta credential and endpoint from canonical env", () => {
    const resolved = resolveProviderCredentialAuthority(
      "meta",
      { model: BUILT_IN_PROVIDER_DEFAULT_MODELS.meta },
      {
        MODEL_API_KEY: "meta-environment-test",
        META_BASE_URL: "https://meta.invalid/v1",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "MODEL_API_KEY" }],
      },
    });
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "meta-environment-test",
      baseURL: "https://meta.invalid/v1",
    });
  });

  test("uses an explicit conservative Muse token estimate", () => {
    expect(
      getTokenizerConfigForProvider({
        provider: "meta",
        model: BUILT_IN_PROVIDER_DEFAULT_MODELS.meta,
      }),
    ).toMatchObject({ modelFamily: "meta", bytesPerToken: 4 });
  });

  test("does not expose Meta media endpoints as session LLMs", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain(
      "muse-image-1.0",
    );
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain(
      "muse-voice-transcribe-1.0",
    );
    expect(
      resolveProviderCapabilityEntry({
        provider: "meta",
        model: "unknown-meta-model",
      }).acceptsReasoningEffort,
    ).toBe(false);
  });
});
