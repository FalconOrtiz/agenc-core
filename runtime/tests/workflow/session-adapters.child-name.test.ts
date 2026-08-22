import { describe, expect, it } from "vitest";

import { assertValidAgentName } from "../../src/agents/registry.js";
import {
  workflowChildAgentName,
  workflowDelegateBounds,
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
    expect(workflowDelegateBounds("implement")).toEqual({ maxTurns: 24 });
    expect(workflowDelegateBounds("verify_agent")).toEqual({
      role: "verification",
      maxTurns: 24,
    });
  });
});
