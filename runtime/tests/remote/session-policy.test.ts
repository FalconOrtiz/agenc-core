import { describe, expect, it } from "vitest";
import { assertSafeRemoteSessionPolicy } from "../../src/remote/session-policy.js";

describe("remote session control policy", () => {
  const options = { dangerouslyBypassApprovalsAndSandbox: false, allowUntrustedHooks: false };
  it("allows only verified default or plan sessions without bypass or untrusted hooks", () => {
    for (const permissionMode of ["default", "plan"]) expect(() => assertSafeRemoteSessionPolicy({ permissionMode, autoModeActive: false }, options)).not.toThrow();
    for (const permissionMode of ["acceptEdits", "bypassPermissions", "auto", "dontAsk", undefined]) expect(() => assertSafeRemoteSessionPolicy({ permissionMode, autoModeActive: false }, options)).toThrow("REMOTE_SESSION_POLICY_UNSAFE");
  });
  it("fails closed for missing authority, auto mode, and runtime bypass flags", () => {
    const settings = { permissionMode: "default", autoModeActive: false };
    expect(() => assertSafeRemoteSessionPolicy(undefined, options)).toThrow();
    expect(() => assertSafeRemoteSessionPolicy(settings, undefined)).toThrow();
    expect(() => assertSafeRemoteSessionPolicy({ ...settings, autoModeActive: true }, options)).toThrow();
    expect(() => assertSafeRemoteSessionPolicy(settings, { ...options, allowUntrustedHooks: true })).toThrow();
    expect(() => assertSafeRemoteSessionPolicy(settings, { ...options, dangerouslyBypassApprovalsAndSandbox: true })).toThrow();
  });
});
