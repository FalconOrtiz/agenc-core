import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { LiveEffectMutationBlockedError } from "../../src/budget/effect-settlement-supervisor.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

/**
 * #2190. `Skill` and `SendUserMessage` read as read-only in their metadata and
 * side-effecting to the effect gate, so the mutating-tool sweep never saw them
 * and their refusals stayed bare. A bare error result from a non-idempotent
 * tool is filed as `effect_unknown_outcome`, poisons the live effect, and
 * every later mutation of the session is refused until an operator runs
 * /resolve. Both refusals below are made before the tool touches anything: the
 * model named an MCP tool as a skill, or sent no message at all.
 */

let workspaceRoot: string;
let registry: ToolRegistry;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-refusal-gate-"));
  registry = buildToolRegistry({
    workspaceRoot,
    agencHome: workspaceRoot,
    modelFacingTools: createModelFacingTools({
      workspaceRoot,
      agencHome: workspaceRoot,
      getSession: () => null,
      env: {},
    }),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function registeredTool(name: string): Tool {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing production tool: ${name}`);
  return tool;
}

/** Dispatch the way the executor does: cross the boundary, then execute. */
async function admitted(
  session: Session,
  callId: string,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<{ readonly isError?: boolean; readonly content: string }> {
  return runAdmittedToolCall({
    session,
    turnId: "turn-refusal-gate",
    callId,
    tool,
    args,
    invoke: async ({ crossEffectBoundary }) => {
      crossEffectBoundary();
      return tool.execute(args);
    },
  });
}

describe.each([
  { tool: "Skill", args: { skill: "mcp.linear.create_issue" } },
  { tool: "SendUserMessage", args: {} },
])("a refused $tool leaves the session able to mutate", ({ tool, args }) => {
  it("files no unknown effect and does not block the next write", async () => {
    const { session, events } = bindAdmittedToolHarness({
      workspaceRoot,
      label: "refusal-gate",
    });

    const refused = await admitted(session, "refused-call", registeredTool(tool), args);
    expect(refused.isError).toBe(true);
    expect(events.some((event) => event.msg.type === "effect_unknown_outcome")).toBe(
      false,
    );

    const filePath = join(workspaceRoot, "after-refusal.txt");
    const outcome = await admitted(session, "write-after-refusal", registeredTool("Write"), {
      file_path: filePath,
      content: "written after the refusal",
    }).catch((error: unknown) => error);

    expect(outcome).not.toBeInstanceOf(LiveEffectMutationBlockedError);
    expect(await readFile(filePath, "utf8")).toBe("written after the refusal");
  });
});
