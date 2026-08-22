import { describe, expect, it } from "vitest";

import { workflowChildFailureMessage } from "../../src/app-server/workflow/session-adapters.js";

describe("workflowChildFailureMessage", () => {
  it("returns null for a completed child", () => {
    expect(workflowChildFailureMessage("plan", { outcome: "completed" })).toBeNull();
  });

  it("carries an Error message", () => {
    expect(
      workflowChildFailureMessage("plan", {
        outcome: "errored",
        error: new Error("provider unavailable"),
      }),
    ).toBe("workflow plan child errored: provider unavailable");
  });

  it("retains the outcome without an Error", () => {
    expect(
      workflowChildFailureMessage("verify_agent", { outcome: "aborted" }),
    ).toBe("workflow verify_agent child aborted");
  });

  it("serializes a structured non-Error", () => {
    expect(
      workflowChildFailureMessage("plan", {
        outcome: "errored",
        error: { code: "PROVIDER_UNAVAILABLE" },
      }),
    ).toContain('"code":"PROVIDER_UNAVAILABLE"');
  });
});
