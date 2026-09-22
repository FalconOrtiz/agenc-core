import { RemoteError } from "./types.js";

/** This rejects permissive sessions; it does not claim OS filesystem isolation. */
export function assertSafeRemoteSessionPolicy(settings: unknown, runtimeOptions: unknown): void {
  const state = settings as { permissionMode?: unknown; autoModeActive?: unknown } | undefined;
  const options = runtimeOptions as { dangerouslyBypassApprovalsAndSandbox?: unknown; allowUntrustedHooks?: unknown } | undefined;
  if (!state || !["default", "plan"].includes(String(state.permissionMode)) || state.autoModeActive !== false || options?.dangerouslyBypassApprovalsAndSandbox !== false || options?.allowUntrustedHooks !== false) throw new RemoteError("REMOTE_SESSION_POLICY_UNSAFE");
}
