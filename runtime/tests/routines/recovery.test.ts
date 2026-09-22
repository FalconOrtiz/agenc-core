import { describe, expect, it, vi } from "vitest";
import { restoreRecoveredAgentRuntime } from "../../src/app-server/daemon-cli.js";

describe("routine runtime recovery", () => {
  it("does not revive a previous invocation or replay its recoverable tools", async () => {
    for (const metadata of [{ routineId: "routine-owned" }, { routineRunId: "routine-run-owned" }]) {
      const close = vi.fn(); const restoreAgent = vi.fn(async () => true);
      const run = { id: "prior-run", status: "running", metadata, resumeSource: { close }, latestSnapshot: { recoveredToolCalls: [{ recoveryAction: "replay", toolName: "Read" }] } };
      await expect(restoreRecoveredAgentRuntime({ startAgent: vi.fn(), restoreAgent }, run as never)).resolves.toEqual({ available: false });
      expect(close).toHaveBeenCalledOnce(); expect(restoreAgent).not.toHaveBeenCalled();
    }
  });
});
