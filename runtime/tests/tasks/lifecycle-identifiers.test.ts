import { describe, expect, it, vi } from "vitest";

import {
  BackgroundTaskLifecycle,
  type RegisterBackgroundTaskInput,
} from "../../src/tasks/lifecycle.js";

const claims = [
  { held: "primary", requested: "primary", name: "owner" },
  { held: "alias", requested: "primary", name: "nickname" },
  { held: "primary", requested: "alias", name: "owner" },
  { held: "alias", requested: "alias", name: "nickname" },
] as const;

function replacementInput(requested: "primary" | "alias", name: string): RegisterBackgroundTaskInput {
  return {
    id: requested === "primary" ? name : "replacement",
    ...(requested === "alias" ? { aliases: [name] } : {}),
    type: "generic",
    description: "replacement task",
  };
}

describe("background task identifier ownership", () => {
  describe.each(["owner", "nickname"])("stop through %s", (taskId) => {
    it.each([false, true])("does not stop a replacement after old cleanup settles (reject: %s)", async (rejectCleanup) => {
      const lifecycle = new BackgroundTaskLifecycle();
      const cleanup = Promise.withResolvers<void>();
      lifecycle.register({
        id: "owner", aliases: ["nickname"], type: "generic", description: "original task",
        onStop: () => cleanup.promise,
      });
      const stopping = lifecycle.stop(taskId);
      const rejected = expect(stopping).rejects.toMatchObject({
        code: rejectCleanup ? "stop_failed" : "not_found",
      });
      lifecycle.complete("owner", "old output");
      lifecycle.register({
        id: "owner", aliases: ["nickname"], type: "generic", description: "replacement task",
      });
      lifecycle.appendOutput("owner", "replacement output");
      const replacement = lifecycle.get("owner");
      lifecycle.drainNotifications();

      if (rejectCleanup) cleanup.reject(new Error("old cleanup failed"));
      else cleanup.resolve();
      await rejected;

      expect(lifecycle.get("owner")).toEqual(replacement);
      expect(lifecycle.get("nickname")).toEqual(replacement);
      expect(lifecycle.readOutput("owner")).toBe("replacement output");
      expect(lifecycle.drainNotifications()).toEqual([]);
    });
  });

  it("does not let an old unsubscribe remove the replacement's identical listener", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({ id: "owner", type: "generic", description: "original task" });
    const observed = vi.fn();
    const unsubscribeOld = lifecycle.subscribe("owner", observed);
    lifecycle.complete("owner");
    lifecycle.register({ id: "owner", type: "generic", description: "replacement task", status: "pending" });
    const unsubscribeNew = lifecycle.subscribe("owner", observed);
    observed.mockClear();

    unsubscribeOld();
    const running = lifecycle.markRunning("owner");

    expect(observed).toHaveBeenCalledExactlyOnceWith(running);
    unsubscribeNew();
    lifecycle.appendOutput("owner", "unobserved");
    expect(observed).toHaveBeenCalledOnce();
  });

  describe.each(["pending", "running"] as const)("%s task names", (status) => {
    it.each(claims)("rejects a new $requested that collides with a live $held", ({ requested, name }) => {
      const lifecycle = new BackgroundTaskLifecycle();
      lifecycle.register({
        id: "owner", aliases: ["nickname"], type: "generic", description: "original task", status,
      });
      lifecycle.appendOutput("owner", "retained output");
      const original = lifecycle.get("owner");

      expect(() => lifecycle.register(replacementInput(requested, name))).toThrow(
        expect.objectContaining({ code: "already_exists" }),
      );
      expect(lifecycle.list()).toEqual([original]);
      expect(lifecycle.get("nickname")).toEqual(original);
      expect(lifecycle.readOutput("nickname")).toBe("retained output");
    });
  });

  it.each(claims)("reclaims a terminal $held for a new $requested", ({ requested, name }) => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({
      id: "owner", aliases: ["nickname", "old-spare"], type: "generic", description: "original task",
    });
    lifecycle.complete("owner", "old output");

    const replacement = lifecycle.register(replacementInput(requested, name));

    expect(lifecycle.list()).toEqual([replacement]);
    expect(lifecycle.get(name)).toEqual(replacement);
    expect(lifecycle.get("old-spare")).toBeUndefined();
    expect(lifecycle.readOutput(name)).toBe("");
    expect(replacement).toMatchObject({ status: "running", description: "replacement task" });
  });

  it.each(["failed", "killed"] as const)("also reclaims names from a %s task", (status) => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({ id: "owner", type: "generic", description: "original task" });
    if (status === "failed") lifecycle.fail("owner", "failed");
    else lifecycle.kill("owner", "stopped");

    const replacement = lifecycle.register(replacementInput("primary", "owner"));
    expect(lifecycle.list()).toEqual([replacement]);
    expect(replacement.status).toBe("running");
  });

  it.each([
    ["reclaim", "blocked"],
    ["blocked", "reclaim"],
  ])("leaves all state unchanged when any proposed alias is occupied (%s, %s)", (first, second) => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({
      id: "done", aliases: ["reclaim", "spare"], type: "generic", description: "completed task",
      metadata: { retained: true },
    });
    lifecycle.appendOutput("done", "consumed");
    lifecycle.takeOutputDelta("done");
    lifecycle.complete("done", " tail");
    lifecycle.register({ id: "live", aliases: ["blocked"], type: "generic", description: "live task" });
    lifecycle.drainNotifications();
    const before = lifecycle.list();
    const observed = vi.fn();
    lifecycle.subscribe("done", observed);

    expect(() => lifecycle.register({
      id: "attempt", aliases: [first, second], type: "generic", description: "must fail",
    })).toThrow(expect.objectContaining({ code: "already_exists" }));

    expect(lifecycle.list()).toEqual(before);
    expect(lifecycle.get("reclaim")).toEqual(before[0]);
    expect(lifecycle.get("spare")).toEqual(before[0]);
    expect(lifecycle.get("blocked")).toEqual(before[1]);
    expect(lifecycle.get("attempt")).toBeUndefined();
    expect(lifecycle.readOutput("reclaim")).toBe("consumed tail");
    expect(lifecycle.takeOutputDelta("reclaim")).toEqual({ content: " tail", newOffset: 13 });
    expect(lifecycle.drainNotifications()).toEqual([]);
    lifecycle.markRunning("done");
    expect(observed).toHaveBeenCalledOnce();
  });

  it("prepares the new record before reclaiming terminal owners", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({ id: "owner", aliases: ["reclaim"], type: "generic", description: "original" });
    lifecycle.complete("owner", "retained");
    const before = lifecycle.list();

    expect(() => lifecycle.register({
      id: "replacement", aliases: ["reclaim"], type: "generic",
      get description(): string { throw new Error("invalid description"); },
    })).toThrow("invalid description");

    expect(lifecycle.list()).toEqual(before);
    expect(lifecycle.get("reclaim")).toEqual(before[0]);
    expect(lifecycle.readOutput("reclaim")).toBe("retained");
  });

  it("checks ownership after input getters have finished", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({ id: "original", aliases: ["reclaim"], type: "generic", description: "original" });
    lifecycle.complete("original");
    const metadata = vi.fn(() => {
      if (!lifecycle.get("replacement")) {
        lifecycle.register({ id: "replacement", type: "generic", description: "getter-owned task" });
      }
      return {};
    });

    expect(() => lifecycle.register({
      id: "replacement", aliases: ["reclaim"], type: "generic", description: "outer task",
      get metadata() { return metadata(); },
    })).toThrow(expect.objectContaining({ code: "already_exists" }));

    expect(metadata).toHaveBeenCalled();
    expect(lifecycle.get("reclaim")?.id).toBe("original");
    expect(lifecycle.get("replacement")?.description).toBe("getter-owned task");
  });
});
