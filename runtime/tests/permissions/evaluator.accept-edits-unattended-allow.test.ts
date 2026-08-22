import { describe, expect, it } from "vitest";

import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
  type ToolLike,
} from "../../src/permissions/evaluator.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import {
  createEmptyToolPermissionContext,
  type PermissionResult,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { createUnattendedPermissionPolicy } from "../../src/permissions/unattended-policy.js";
import type { Session } from "../../src/session/session.js";

function buildContext(options: {
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
}): ToolEvaluatorContext {
  const toolPermissionContext: ToolPermissionContext =
    createEmptyToolPermissionContext({
      mode: "acceptEdits",
      unattendedPolicy: createUnattendedPermissionPolicy(options),
    });
  const state: AppStateSnapshot = {
    toolPermissionContext,
    denialTracking: freshDenialTracking(),
    autoModeActive: false,
  };
  return attachContextDefaults({
    getAppState: () => state,
    session: {
      state: { unsafePeek: () => ({ history: [] }) },
    } as unknown as Session,
  } as ToolEvaluatorContext);
}

const execTool: ToolLike = {
  name: "exec_command",
  requiresApproval: true,
  metadata: { mutating: true },
};

describe("acceptEdits with an explicit unattended allowlist", () => {
  it("allows an explicitly allowlisted exec_command without an approval resolver", async () => {
    const result = await hasPermissionsToUseTool(
      execTool,
      { cmd: "npm test" },
      buildContext({ allowlist: ["exec_command"] }),
    );

    expect(result).toMatchObject({
      behavior: "allow",
      decisionReason: {
        type: "other",
        reason: "unattended allowlist: system.bash",
      },
    });
  });

  it("does not broaden acceptEdits for tools absent from the allowlist", async () => {
    const result = await hasPermissionsToUseTool(
      execTool,
      { cmd: "npm test" },
      buildContext({ allowlist: ["FileRead"] }),
    );

    expect(result.behavior).toBe("ask");
  });

  it("keeps the unattended denylist as the hard floor", async () => {
    const result = await hasPermissionsToUseTool(
      execTool,
      { cmd: "npm test" },
      buildContext({
        allowlist: ["exec_command"],
        denylist: ["Bash"],
      }),
    );

    expect(result.behavior).toBe("deny");
  });

  it("does not override a tool-level safety ask", async () => {
    const guardedExec: ToolLike = {
      ...execTool,
      checkPermissions: (): PermissionResult => ({
        behavior: "ask",
        message: "command requires review",
        decisionReason: {
          type: "other",
          reason: "bash_parse_unavailable",
        },
      }),
    };
    const result = await hasPermissionsToUseTool(
      guardedExec,
      { cmd: "echo $(date)" },
      buildContext({ allowlist: ["exec_command"] }),
    );

    expect(result.behavior).toBe("ask");
  });
});
