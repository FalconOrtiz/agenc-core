import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BoundedRegularFileError,
  readBoundedRegularFile,
  readBoundedRegularFileSync,
} from "../../src/utils/bounded-regular-file.js";

describe("bounded regular-file reads", () => {
  it("rejects an in-place synchronous mutation after the bounded read", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-bounded-sync-"));
    const path = join(root, "daemon.pid");
    writeFileSync(path, "123\n");
    try {
      expect(() =>
        readBoundedRegularFileSync(path, 64, {
          afterRead: () => appendFileSync(path, "4"),
        }),
      ).toThrow(BoundedRegularFileError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an in-place asynchronous mutation after the bounded read", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-bounded-async-"));
    const path = join(root, "daemon-runtime.json");
    await writeFile(path, '{"pid":123}\n');
    try {
      await expect(
        readBoundedRegularFile(path, 64 * 1_024, {
          afterRead: () => appendFile(path, " "),
        }),
      ).rejects.toBeInstanceOf(BoundedRegularFileError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
