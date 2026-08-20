import { describe, expect, it } from "vitest";

import { createPlanningTools } from "../../src/tools/system/planning.js";

/**
 * #1751 — validation refusals from the planning tools are produced before
 * any effect, so they must carry an authoritative `confirmed_no_effect`
 * disposition. A bare `isError` result from a non-idempotent tool poisons
 * the session's unknown-outcome mutation gate: the observed failure was a
 * misfired ExitPlanMode ("You are not in plan mode") blocking every later
 * side-effecting tool call in the session.
 */
describe("planning tool validation refusals attest no effect", () => {
  it("ExitPlanMode outside plan mode refuses with confirmed_no_effect", async () => {
    const tool = createPlanningTools({
      workflowController: {
        getPermissionModeRegistry: () =>
          ({
            current: () => ({ mode: "default" }),
          }) as never,
      },
    }).find((candidate) => candidate.name === "ExitPlanMode");
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, {} as never);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not in plan mode");
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
    });
  });

  it("ExitPlanMode without a registry refuses with confirmed_no_effect", async () => {
    const tool = createPlanningTools({}).find(
      (candidate) => candidate.name === "ExitPlanMode",
    );
    const result = await tool!.execute({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
    });
  });

  it("TodoWrite input validation refuses with confirmed_no_effect", async () => {
    const tool = createPlanningTools({}).find(
      (candidate) => candidate.name === "TodoWrite",
    );
    const result = await tool!.execute({ todos: "not-a-list" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
    });
  });
});
