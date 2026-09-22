import { describe, expect, test } from "vitest";
import { OPENAI_REASONING_MODELS } from "../../src/llm/registry/openai-reasoning-models.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { resolveProviderModelCapabilities } from "../../src/llm/capabilities.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { defaultConfig } from "../../src/config/schema.js";
import { effortValueToReasoningEffort, getAvailableEffortLevelsForContext } from "../../src/utils/effort.js";

describe("OpenAI OAuth reasoning model contract", () => {
  test.each(OPENAI_REASONING_MODELS)("$model preserves every positive tier from configuration to Responses", ({ model, efforts }) => {
    const entry = resolveRegisteredModelCatalogEntry({ provider: "openai", model })!;
    expect(entry.supportedReasoningLevels).toEqual(efforts);
    expect(resolveProviderModelCapabilities({ provider: "openai", model }).acceptsReasoningEffort).toBe(true);
    expect(chatCompletionsCapabilityHintsForProvider("openai", model).acceptsReasoningEffort).toBe(true);
    expect(getAvailableEffortLevelsForContext(model, { provider: "openai", environment: {}, home: {} } as never)).toEqual(efforts);
    for (const effort of efforts) {
      const configuration = sessionConfigurationFromAgenCConfig({
        config: { ...defaultConfig(), model_provider: "openai", reasoning_effort: effort },
        provider: "openai", workspaceRoot: "/tmp/openai-effort-fixture", model,
      });
      expect(configuration.collaborationMode.reasoningEffort).toBe(effort);
      expect(effortValueToReasoningEffort(effort, efforts)).toBe(effort);
      const resolved = resolveSessionReasoningEffort(configuration.collaborationMode.reasoningEffort, entry.supportedReasoningLevels);
      const request = buildOpenAIResponsesRequest({ model, messages: [{ role: "user", content: "Fixture only" }], tools: [], options: { reasoningEffort: resolved } });
      expect(request.reasoning?.effort).toBe(effort);
    }
  });

  test("does not grant an unverified variant max effort or leak OpenAI capabilities to another provider", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-6-astra-unverified" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model: "gpt-6-astra" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-5.4" })?.supportedReasoningLevels).not.toContain("max");
  });
});
