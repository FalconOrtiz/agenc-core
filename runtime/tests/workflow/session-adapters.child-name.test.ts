import { describe, expect, it } from "vitest";

import { assertValidAgentName } from "../../src/agents/registry.js";
import {
  workflowChildAgentName,
  workflowDelegateBounds,
  workflowDelegateToolPolicy,
  workflowImplementReachedBoundWithProgress,
} from "../../src/app-server/workflow/session-adapters.js";

const CHILD_RUN_IDS = [
  "wf-3f78249a-c5e4-42b4-90ac-c89cf87618f5:plan#1",
  "wf-3f78249a-c5e4-42b4-90ac-c89cf87618f5:plan#2",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:implement#1",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:verify-agent#1",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:review#3",
] as const;

describe("workflowChildAgentName", () => {
  it("produces names accepted by the agent registry", () => {
    for (const childRunId of CHILD_RUN_IDS) {
      expect(() =>
        assertValidAgentName(workflowChildAgentName(childRunId)),
      ).not.toThrow();
    }
  });

  it("folds every separator and remains stable and distinct", () => {
    expect(workflowChildAgentName("wf-ABC.123:plan#1")).toBe(
      "wf_abc_123_plan_1",
    );
    expect(new Set(CHILD_RUN_IDS.map(workflowChildAgentName)).size).toBe(
      CHILD_RUN_IDS.length,
    );
  });
});

describe("workflowDelegateBounds", () => {
  it("makes planning a single tool-free read-only turn", () => {
    expect(workflowDelegateBounds("plan")).toEqual({
      role: "Plan",
      toolAllowlist: [],
      maxTurns: 1,
    });
  });

  it("bounds implementation and adversarial verification independently", () => {
    expect(workflowDelegateBounds("implement")).toEqual({ maxTurns: 8 });
    expect(workflowDelegateBounds("verify_agent")).toEqual({
      role: "verification",
      maxTurns: 4,
      maxOutputTokens: 8_192,
    });
    expect(workflowDelegateBounds("review")).toEqual({
      maxTurns: 4,
      maxOutputTokens: 8_192,
    });
  });
});

describe("workflowImplementReachedBoundWithProgress", () => {
  it("hands a mutated max-turn implementer to controller verification", () => {
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        {
          outcome: "errored",
          error: new Error("subagent exceeded maxTurns (8)"),
        },
        2,
      ),
    ).toBe(true);
  });

  it("hands a mutated token-budget denial to controller verification", () => {
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        {
          outcome: "errored",
          error: new Error("execution admission deny: budget_exceeded"),
        },
        1,
      ),
    ).toBe(true);
  });

  it("does not mask an empty, non-implement, or unrelated child failure", () => {
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        {
          outcome: "errored",
          error: new Error("subagent exceeded maxTurns (8)"),
        },
        0,
      ),
    ).toBe(false);
    expect(
      workflowImplementReachedBoundWithProgress(
        "verify_agent",
        {
          outcome: "errored",
          error: new Error("subagent exceeded maxTurns (3)"),
        },
        2,
      ),
    ).toBe(false);
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        { outcome: "errored", error: new Error("provider unavailable") },
        2,
      ),
    ).toBe(false);
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        {
          outcome: "errored",
          error: new Error("execution admission deny: budget_exceeded"),
        },
        0,
      ),
    ).toBe(false);
    expect(
      workflowImplementReachedBoundWithProgress(
        "implement",
        {
          outcome: "errored",
          error: new Error("execution admission deny: cost_exceeded"),
        },
        2,
      ),
    ).toBe(false);
  });
});

describe("workflowDelegateToolPolicy", () => {
  it("bounds pre- and post-mutation inspection while pinning relative paths", async () => {
    const policy = workflowDelegateToolPolicy(
      "implement",
      "Preferred source target: src/a.ts\nPreferred test target: tests/a.test.ts",
    );
    expect(policy).toBeDefined();
    expect(
      await policy!(
        { name: "FileRead" },
        {
          file_path: "/checkout/repo/tests/a.test.ts",
          offset: 800,
          limit: 1_200,
        },
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/a.ts", offset: 1, limit: 320 },
    });
    for (let index = 1; index < 3; index += 1) {
      expect(
        await policy!({ name: "Grep" }, { pattern: `term-${index}` }),
      ).toEqual({
        behavior: "allow",
        updatedInput: { pattern: `term-${index}` },
      });
    }
    expect(
      await policy!({ name: "FileRead" }, { file_path: "src/a.ts" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: {
        workflowPolicy: "implement_pre_mutation_tool_limit",
        limit: 3,
      },
    });
    expect(
      await policy!(
        { name: "Edit" },
        { file_path: "/checkout/repo/.agenc-worktrees/run/src/a.ts" },
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/a.ts" },
    });
    expect(
      await policy!(
        { name: "FileRead" },
        { file_path: "tests/a.test.ts", limit: 900 },
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "tests/a.test.ts", limit: 320 },
    });
    expect(
      await policy!({ name: "Grep" }, { pattern: "another" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: {
        workflowPolicy: "implement_post_mutation_inspection_limit",
        limit: 1,
        mutationDispatches: 1,
      },
    });
    expect(
      await policy!({ name: "Edit" }, { file_path: "tests/a.test.ts" }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "tests/a.test.ts" },
    });
    expect(await policy!({ name: "Bash" }, { command: "npm test" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
  });

  it("caps adversarial verification tools and preserves a final-response recovery turn", async () => {
    const policy = workflowDelegateToolPolicy("verify_agent");
    expect(policy).toBeDefined();
    expect(
      await policy!({ name: "FileRead" }, { file_path: "src/a.ts" }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/a.ts" },
    });
    expect(
      await policy!({ name: "Bash" }, { command: "npm test -- --focused" }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test -- --focused" },
    });
    expect(
      await policy!({ name: "Grep" }, { pattern: "another-check" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: {
        workflowPolicy: "verify_agent_tool_limit",
        limit: 2,
        attemptedTool: "Grep",
      },
    });
  });

  it("does not constrain plan or review workflow children", () => {
    expect(workflowDelegateToolPolicy("plan")).toBeUndefined();
    expect(workflowDelegateToolPolicy("review")).toBeUndefined();
  });
});
