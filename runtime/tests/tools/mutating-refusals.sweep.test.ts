import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";

/**
 * #2190, proposal 3. A tool that refuses before it touches anything must say
 * so with a `confirmed_no_effect` disposition; a bare error (or a thrown one)
 * is filed as an unknown outcome and gates the whole session behind /resolve.
 * Empty arguments are the refusal every tool has, so this sweep asserts the
 * contract over every built-in tool the gate can stop, at once, and a new tool
 * cannot regress it silently.
 */

let root = "";
let home = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-refusal-sweep-ws-"));
  home = await mkdtemp(join(tmpdir(), "agenc-refusal-sweep-home-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * Tools for which `{}` is a complete, valid call: they attempt their work at
 * once, so a failure is a real post-attempt failure and not this sweep's
 * subject. Add a tool here only when its schema has no required argument.
 */
const EMPTY_CALL_IS_AN_ATTEMPT = new Set(["install_ledger_wallet_cli"]);

/**
 * The gate's own population, not the metadata's. `runAdmittedToolCall` poisons
 * the live effect for every recovery category but `idempotent`, and a missing
 * category means side-effecting, so a tool can be read-only in its metadata and
 * still stop the session when it refuses — `Skill` and `SendUserMessage` are.
 * Sweeping `metadata.mutating` alone left those outside the guard.
 */
function gatedTools(): readonly Tool[] {
  const modelFacing = createModelFacingTools({
    workspaceRoot: root,
    agencHome: home,
    getSession: () => null,
    env: {},
  });
  const coding = buildToolRegistry({ workspaceRoot: root }).tools;
  const seen = new Set<string>();
  return [...coding, ...modelFacing].filter((tool) => {
    if (seen.has(tool.name)) return false;
    const gated =
      tool.metadata?.mutating === true ||
      (tool.recoveryCategory ?? "side-effecting") !== "idempotent";
    if (!gated) return false;
    seen.add(tool.name);
    return !EMPTY_CALL_IS_AN_ATTEMPT.has(tool.name);
  });
}

async function refusal(tool: Tool): Promise<ToolResult | string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      tool.execute({}).catch((error: unknown) =>
        `threw: ${error instanceof Error ? error.message : String(error)}`,
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("did not settle within 10 s"), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("every gated tool names its boundary when it refuses empty arguments", () => {
  test("the sweep sees the gated tool family", () => {
    const names = gatedTools().map((tool) => tool.name);
    expect(names, names.join(", ")).toEqual(
      expect.arrayContaining([
        "exec_command",
        "TaskCreate",
        "WorkflowTool",
        "Skill",
        "SendUserMessage",
      ]),
    );
    expect(names.length).toBeGreaterThan(20);
  });

  test("no gated tool refuses empty arguments with a bare or thrown error", async () => {
    const failures: string[] = [];
    const accepted: string[] = [];
    for (const tool of gatedTools()) {
      const result = await refusal(tool);
      if (typeof result === "string") {
        failures.push(`${tool.name}: ${result}`);
        continue;
      }
      if (result.isError !== true) {
        accepted.push(tool.name);
        continue;
      }
      if (result.effectDisposition?.disposition !== "confirmed_no_effect") {
        failures.push(
          `${tool.name}: bare error "${String(result.content).slice(0, 80)}"`,
        );
      }
    }
    // A tool that accepts {} refused nothing; it is not this sweep's subject.
    expect(failures, `accepted {}: ${accepted.join(", ") || "none"}`).toEqual([]);
  });
});
