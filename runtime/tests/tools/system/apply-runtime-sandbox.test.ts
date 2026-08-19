import { describe, expect, it, vi } from "vitest";
import {
  applyReadOnlyRuntimeSandboxToSpawn,
  applyRuntimeSandboxToSpawn,
  transformWithRuntimeSandbox,
} from "../../../src/tools/system/apply-runtime-sandbox.js";
import {
  attachSandboxExecutionBroker,
  type SandboxExecutionBrokerLike,
} from "../../../src/sandbox/execution-broker.js";
import { UnifiedExecError } from "../../../src/unified-exec/types.js";
import type { UnifiedExecRuntimeSandbox } from "../../../src/unified-exec/types.js";
import type { PermissionProfile } from "../../../src/sandbox/engine/index.js";

function fakeProfile(): PermissionProfile {
  return {
    fileSystem: { kind: "workspace_write", entries: [] },
    network: { kind: "enabled" },
  } as PermissionProfile;
}

function fakeRuntimeSandbox(
  preference: "require" | "auto" = "require",
): UnifiedExecRuntimeSandbox {
  return {
    permissionProfile: fakeProfile(),
    sandboxPolicyCwd: process.cwd(),
    preference,
  };
}

function attachedBrokerArgs(
  runtimeSandbox: UnifiedExecRuntimeSandbox,
): {
  readonly args: Record<string, unknown>;
  readonly broker: SandboxExecutionBrokerLike;
} {
  const broker: SandboxExecutionBrokerLike = {
    mode: "workspace_write",
    required: true,
    cwd: process.cwd(),
    forkDepth: 0,
    rebase: vi.fn(),
    forkForCwd: vi.fn(),
    status: vi.fn().mockReturnValue({
      kind: "ready",
      mode: "workspace_write",
      platform: process.platform,
    }),
    assertReady: vi.fn().mockReturnValue({
      kind: "ready",
      mode: "workspace_write",
      platform: process.platform,
    }),
    runtimeSandbox: vi.fn().mockReturnValue(runtimeSandbox),
    prepareSpawn: vi.fn(),
  };
  const args: Record<string, unknown> = {};
  attachSandboxExecutionBroker(args, broker);
  return { args, broker };
}

describe("applyRuntimeSandboxToSpawn (TOOL-03/04) — behavioral", () => {
  it("fails closed when no runtime sandbox boundary is attached", () => {
    expect(() => applyRuntimeSandboxToSpawn({
      toolArgs: { command: "echo hi" },
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
    })).toThrow("sandbox_surface_uncovered");
  });

  it("does not accept a structurally forged runtime context for a read-only child", () => {
    expect(() => applyReadOnlyRuntimeSandboxToSpawn({
      toolArgs: {
        __toolRuntimeContext: {
          callId: "forged",
          toolName: "Glob",
          sandboxMode: "danger_full_access",
        },
      },
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
    })).toThrow("sandbox_surface_uncovered");
  });

  it("narrows authenticated read-only children without widening their read scope", () => {
    const runtimeSandbox: UnifiedExecRuntimeSandbox = {
      permissionProfile: {
        fileSystem: {
          kind: "restricted",
          entries: [
            {
              path: { kind: "path", path: "/scope/already-readable" },
              access: "read",
            },
            {
              path: { kind: "path", path: "/scope/session-writable" },
              access: "write",
            },
            {
              path: { kind: "path", path: "/scope/denied" },
              access: "none",
            },
            {
              path: { kind: "glob", pattern: "/scope/**/secret" },
              access: "none",
            },
          ],
          globScanMaxDepth: 7,
          includePlatformDefaults: false,
        },
        network: "enabled",
        enforcement: "managed",
      },
      additionalPermissions: {
        fileSystem: {
          entries: [
            {
              path: { kind: "path", path: "/scope/approved-write" },
              access: "write",
            },
          ],
        },
        network: { enabled: true },
      },
      sandboxPolicyCwd: process.cwd(),
      preference: "require",
      enforceManagedNetwork: true,
      network: { allowAllUnixSockets: true },
    };
    const { args, broker } = attachedBrokerArgs(runtimeSandbox);
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: process.cwd(),
      env: {},
    });
    const selectInitial = vi.fn().mockReturnValue("linux_seccomp");

    applyReadOnlyRuntimeSandboxToSpawn({
      toolArgs: args,
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: ".",
      cwdBinding: "inherited_readonly",
      env: { PATH: "/usr/bin" },
      sandboxManager: { selectInitial, transform } as never,
    });

    expect(broker.runtimeSandbox).toHaveBeenCalledWith("tool");
    expect(broker.prepareSpawn).not.toHaveBeenCalled();
    expect(selectInitial).toHaveBeenCalledWith(expect.objectContaining({
      networkPolicy: "disabled",
      hasManagedNetworkRequirements: false,
      fileSystemPolicy: {
        kind: "restricted",
        entries: [
          {
            path: { kind: "path", path: "/scope/already-readable" },
            access: "read",
          },
          {
            path: { kind: "path", path: "/scope/session-writable" },
            access: "read",
          },
          {
            path: { kind: "path", path: "/scope/denied" },
            access: "none",
          },
          {
            path: { kind: "glob", pattern: "/scope/**/secret" },
            access: "none",
          },
          {
            path: { kind: "path", path: "/scope/approved-write" },
            access: "read",
          },
        ],
        globScanMaxDepth: 7,
        includePlatformDefaults: false,
      },
    }));
    const request = transform.mock.calls[0]?.[0];
    expect(request.permissions).toMatchObject({
      network: "disabled",
      enforcement: "managed",
    });
    expect(request.command).not.toHaveProperty("additionalPermissions");
    expect(request).not.toHaveProperty("network");
    expect(request.enforceManagedNetwork).toBe(false);
  });

  it("leaves the ordinary spawn path's write and network grants unchanged", () => {
    const runtimeSandbox: UnifiedExecRuntimeSandbox = {
      permissionProfile: {
        fileSystem: {
          kind: "restricted",
          entries: [
            {
              path: { kind: "path", path: "/scope/session-writable" },
              access: "write",
            },
          ],
        },
        network: "enabled",
      },
      additionalPermissions: {
        network: { enabled: true },
      },
      sandboxPolicyCwd: process.cwd(),
      preference: "require",
      enforceManagedNetwork: true,
      network: { allowAllUnixSockets: true },
    };
    const { args } = attachedBrokerArgs(runtimeSandbox);
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: process.cwd(),
      env: {},
    });
    const selectInitial = vi.fn().mockReturnValue("linux_seccomp");

    applyRuntimeSandboxToSpawn({
      toolArgs: args,
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
      sandboxManager: { selectInitial, transform } as never,
    });

    expect(selectInitial).toHaveBeenCalledWith(expect.objectContaining({
      networkPolicy: "enabled",
      hasManagedNetworkRequirements: true,
      fileSystemPolicy: runtimeSandbox.permissionProfile.fileSystem,
    }));
    expect(transform.mock.calls[0]?.[0]).toMatchObject({
      enforceManagedNetwork: true,
      network: { allowAllUnixSockets: true },
      command: {
        additionalPermissions: runtimeSandbox.additionalPermissions,
      },
    });
  });

  it("preserves an externally enforced boundary for a pinned read-only child", () => {
    const runtimeSandbox: UnifiedExecRuntimeSandbox = {
      permissionProfile: {
        fileSystem: { kind: "external_sandbox", entries: [] },
        network: "enabled",
      },
      sandboxPolicyCwd: process.cwd(),
      preference: "best_effort",
    };
    const { args } = attachedBrokerArgs(runtimeSandbox);
    const transform = vi.fn().mockReturnValue({
      command: ["/bin/rg", "needle"],
      cwd: process.cwd(),
      env: {},
    });
    const selectInitial = vi.fn().mockReturnValue("none");

    expect(
      applyReadOnlyRuntimeSandboxToSpawn({
        toolArgs: args,
        fallbackCwd: process.cwd(),
        program: "/bin/rg",
        args: ["needle"],
        cwd: process.cwd(),
        env: { PATH: "/usr/bin" },
        sandboxManager: { selectInitial, transform } as never,
      }),
    ).toEqual({
      program: "/bin/rg",
      args: ["needle"],
      cwd: process.cwd(),
      env: {},
      argv0: "rg",
    });
    expect(selectInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        fileSystemPolicy: { kind: "external_sandbox", entries: [] },
        networkPolicy: "enabled",
      }),
    );
    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: runtimeSandbox.permissionProfile,
        sandbox: "none",
      }),
    );
  });

  it("rewrites program/args via SandboxManager.transform when isolation is applied", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: { PATH: "/sandbox/bin", SANDBOX: "1" },
      arg0: "wrapper",
    });
    const selectInitial = vi.fn().mockReturnValue("bwrap");
    const manager = {
      selectInitial,
      transform,
    } as never;

    const result = transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
      runtimeSandbox: fakeRuntimeSandbox("require"),
      sandboxManager: manager,
    });

    expect(selectInitial).toHaveBeenCalled();
    expect(transform).toHaveBeenCalled();
    expect(result.program).toBe("/sandbox/wrapper");
    expect(result.args).toEqual(["/bin/echo", "hi"]);
    expect(result.cwd).toBe("/sandboxed");
    expect(result.env.SANDBOX).toBe("1");
  });

  it("threads allowGpu through to SandboxManager.transform when set", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: {},
    });
    const manager = {
      selectInitial: vi.fn().mockReturnValue("macos_seatbelt"),
      transform,
    } as never;

    transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: {},
      runtimeSandbox: { ...fakeRuntimeSandbox("require"), allowGpu: true },
      sandboxManager: manager,
    });

    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({ allowGpu: true }),
    );
  });

  it("omits allowGpu from the transform request when not set", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: {},
    });
    const manager = {
      selectInitial: vi.fn().mockReturnValue("macos_seatbelt"),
      transform,
    } as never;

    transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: {},
      runtimeSandbox: fakeRuntimeSandbox("require"),
      sandboxManager: manager,
    });

    expect(transform.mock.calls[0]?.[0]).not.toHaveProperty("allowGpu");
  });

  it("fails closed when preference is require and no platform sandbox is selected", () => {
    const manager = {
      selectInitial: vi.fn().mockReturnValue("none"),
      transform: vi.fn(),
    } as never;

    expect(() =>
      transformWithRuntimeSandbox({
        program: "/bin/echo",
        args: ["hi"],
        cwd: process.cwd(),
        env: { PATH: "/usr/bin" },
        runtimeSandbox: fakeRuntimeSandbox("require"),
        sandboxManager: manager,
      }),
    ).toThrow(UnifiedExecError);

    expect(manager.transform).not.toHaveBeenCalled();
  });
});
