import { describe, expect, it } from "vitest";

import {
  isUnsupportedDirectorySync,
  writeDurableAtomicFile,
  writeDurableAtomicFileSync,
  type DurableAtomicAsyncOperations,
  type DurableAtomicSyncOperations,
} from "../../src/utils/durable-atomic-file.js";

describe("durable atomic file publication", () => {
  it("fsyncs file before rename and parent directory after rename", () => {
    const order: string[] = [];
    const operations: DurableAtomicSyncOperations = {
      mkdir: () => order.push("mkdir"),
      openTemporary: () => {
        order.push("open-temp");
        return "handle";
      },
      write: () => order.push("write-temp"),
      sync: () => order.push("fsync-temp"),
      close: () => order.push("close-temp"),
      rename: () => order.push("rename"),
      syncDirectory: () => order.push("fsync-parent"),
      remove: () => order.push("remove-temp"),
    };

    writeDurableAtomicFileSync(
      "/state/daemon-runtime.json",
      "/state/daemon-runtime.tmp",
      "new",
      0o600,
      operations,
    );
    expect(order).toEqual([
      "mkdir",
      "open-temp",
      "write-temp",
      "fsync-temp",
      "close-temp",
      "rename",
      "fsync-parent",
      "remove-temp",
    ]);
  });

  it("preserves the previous generation when temp fsync fails", () => {
    let target = "older-generation";
    let temporary = "";
    const operations: DurableAtomicSyncOperations = {
      mkdir: () => {},
      openTemporary: () => "handle",
      write: (_handle, data) => {
        temporary = data;
      },
      sync: () => {
        throw new Error("injected temp fsync failure");
      },
      close: () => {},
      rename: () => {
        target = temporary;
      },
      syncDirectory: () => {},
      remove: () => {
        temporary = "";
      },
    };

    expect(() =>
      writeDurableAtomicFileSync(
        "/state/daemon-runtime.json",
        "/state/daemon-runtime.tmp",
        "newer-generation",
        0o600,
        operations,
      ),
    ).toThrow(/fsync failure/u);
    expect(target).toBe("older-generation");
    expect(temporary).toBe("");
  });

  it("does not remove a pre-existing temp path when sync open fails", () => {
    const openError = new Error("injected exclusive open failure");
    let removeCalls = 0;
    const operations: DurableAtomicSyncOperations = {
      mkdir: () => {},
      openTemporary: () => {
        throw openError;
      },
      write: () => {},
      sync: () => {},
      close: () => {},
      rename: () => {},
      syncDirectory: () => {},
      remove: () => {
        removeCalls += 1;
      },
    };

    expect(() =>
      writeDurableAtomicFileSync(
        "/state/daemon-runtime.json",
        "/state/daemon-runtime.tmp",
        "new",
        0o600,
        operations,
      ),
    ).toThrow(openError);
    expect(removeCalls).toBe(0);
  });

  it("applies the same durable ordering to asynchronous pid publication", async () => {
    const order: string[] = [];
    const complete = async (step: string): Promise<void> => {
      order.push(step);
    };
    const operations: DurableAtomicAsyncOperations = {
      mkdir: () => complete("mkdir"),
      openTemporary: async () => {
        order.push("open-temp");
        return "handle";
      },
      write: () => complete("write-temp"),
      sync: () => complete("fsync-temp"),
      close: () => complete("close-temp"),
      rename: () => complete("rename"),
      syncDirectory: () => complete("fsync-parent"),
      remove: () => complete("remove-temp"),
    };

    await writeDurableAtomicFile(
      "/state/daemon.pid",
      "/state/daemon.pid.tmp",
      "4242\n",
      0o600,
      operations,
    );
    expect(order).toEqual([
      "mkdir",
      "open-temp",
      "write-temp",
      "fsync-temp",
      "close-temp",
      "rename",
      "fsync-parent",
      "remove-temp",
    ]);
  });

  it("preserves the primary sync failure while always closing and removing", () => {
    const primary = new Error("injected temp fsync failure");
    const cleanup = new Error("injected close failure");
    let temporaryExists = false;
    let closeCalls = 0;
    const operations: DurableAtomicSyncOperations = {
      mkdir: () => {},
      openTemporary: () => {
        temporaryExists = true;
        return "handle";
      },
      write: () => {},
      sync: () => {
        throw primary;
      },
      close: () => {
        closeCalls += 1;
        throw cleanup;
      },
      rename: () => {},
      syncDirectory: () => {},
      remove: () => {
        temporaryExists = false;
      },
    };

    let thrown: unknown;
    try {
      writeDurableAtomicFileSync(
        "/state/daemon-runtime.json",
        "/state/daemon-runtime.tmp",
        "new",
        0o600,
        operations,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toEqual([primary, cleanup]);
    expect(closeCalls).toBe(1);
    expect(temporaryExists).toBe(false);
  });

  it("attempts async close and removal independently without masking the write error", async () => {
    const primary = new Error("injected temp write failure");
    const closeError = new Error("injected close failure");
    const removeError = new Error("injected remove report failure");
    let temporaryExists = false;
    const cleanupOrder: string[] = [];
    const operations: DurableAtomicAsyncOperations = {
      mkdir: async () => {},
      openTemporary: async () => {
        temporaryExists = true;
        return "handle";
      },
      write: async () => {
        throw primary;
      },
      sync: async () => {},
      close: async () => {
        cleanupOrder.push("close");
        throw closeError;
      },
      rename: async () => {},
      syncDirectory: async () => {},
      remove: async () => {
        cleanupOrder.push("remove");
        // Model a filesystem that completed unlink but reported a late error.
        temporaryExists = false;
        throw removeError;
      },
    };

    let thrown: unknown;
    try {
      await writeDurableAtomicFile(
        "/state/daemon.pid",
        "/state/daemon.pid.tmp",
        "4242\n",
        0o600,
        operations,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toEqual([
      primary,
      closeError,
      removeError,
    ]);
    expect(cleanupOrder).toEqual(["close", "remove"]);
    expect(temporaryExists).toBe(false);
  });

  it("does not remove a pre-existing temp path when async open fails", async () => {
    const openError = new Error("injected exclusive open failure");
    let removeCalls = 0;
    const operations: DurableAtomicAsyncOperations = {
      mkdir: async () => {},
      openTemporary: async () => {
        throw openError;
      },
      write: async () => {},
      sync: async () => {},
      close: async () => {},
      rename: async () => {},
      syncDirectory: async () => {},
      remove: async () => {
        removeCalls += 1;
      },
    };

    await expect(
      writeDurableAtomicFile(
        "/state/daemon.pid",
        "/state/daemon.pid.tmp",
        "4242\n",
        0o600,
        operations,
      ),
    ).rejects.toBe(openError);
    expect(removeCalls).toBe(0);
  });

  it("never suppresses POSIX permission failures from parent-directory fsync", () => {
    const permissionError = Object.assign(new Error("denied"), {
      code: "EACCES",
    });
    expect(isUnsupportedDirectorySync(permissionError, "linux")).toBe(false);
    expect(isUnsupportedDirectorySync(permissionError, "darwin")).toBe(false);
    expect(isUnsupportedDirectorySync(permissionError, "win32")).toBe(true);
  });
});
