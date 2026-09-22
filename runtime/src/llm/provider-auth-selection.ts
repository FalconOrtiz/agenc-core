/** Non-secret auth intent, captured in the same immutable env as credentials. */
export type SelectableAuthProvider = "openai" | "grok";
export type ProviderAuthPreference = "auto" | "oauth" | "api-key";
export type ProviderAuthEnvironment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_AUTH_ENV = Object.freeze({
  openai: "OPENAI_AUTH_MODE",
  grok: "GROK_AUTH_MODE",
} as const);

export function providerAuthPreference(
  provider: SelectableAuthProvider,
  environment: ProviderAuthEnvironment,
): ProviderAuthPreference {
  const name = PROVIDER_AUTH_ENV[provider];
  const value = environment[name]?.trim();
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "oauth" || value === "api-key") return value;
  throw new Error(`${name} must be auto, oauth, or api-key`);
}

/** Status describes credential presence, never network validity or balance. */
export function providerAuthSelection(
  provider: SelectableAuthProvider,
  environment: ProviderAuthEnvironment,
  available: { readonly oauth: boolean; readonly apiKey: boolean },
  automaticMode?: "oauth" | "api-key",
) {
  const preference = providerAuthPreference(provider, environment);
  const effectiveMode = preference === "oauth"
    ? available.oauth ? "oauth" : null
    : preference === "api-key"
      ? available.apiKey ? "api-key" : null
      : automaticMode ?? (available.oauth ? "oauth" : available.apiKey ? "api-key" : null);
  return Object.freeze({
    version: 1 as const,
    preference,
    effectiveMode,
    available: Object.freeze({ ...available }),
  });
}
