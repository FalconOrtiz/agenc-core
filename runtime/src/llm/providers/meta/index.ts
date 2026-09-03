import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type MetaProviderConfig = OpenAIProviderConfig;

/** Meta Model API adapter over its OpenAI-compatible chat-completions wire. */
export class MetaProvider extends OpenAIProvider {
  constructor(config: MetaProviderConfig) {
    super({
      ...config,
      providerName: "meta",
      useResponsesApi: false,
    });
  }
}
