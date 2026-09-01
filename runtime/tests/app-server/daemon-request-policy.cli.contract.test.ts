import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const timeoutPolicy = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("./daemon-request-policy.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./daemon-request-policy.js")
  >();
  timeoutPolicy.resolve.mockImplementation(
    actual.resolveAgenCDaemonRequestTimeoutMs,
  );
  return {
    ...actual,
    resolveAgenCDaemonRequestTimeoutMs: timeoutPolicy.resolve,
  };
});

import { createAgenCJsonLineDaemonRequestClient } from "./agent-cli.js";
import {
  requestAgenCDaemonInstanceIdentity,
  resolveAgenCDaemonCookiePath,
  type AgenCDaemonCliHost,
} from "./daemon-cli.js";

const roots: string[] = [];

afterEach(async () => {
  timeoutPolicy.resolve.mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("daemon request timeout CLI defaults", () => {
  it("keeps the agent client default at 30 seconds", () => {
    const env: NodeJS.ProcessEnv = {};

    createAgenCJsonLineDaemonRequestClient({
      env,
      socketPath: "/tmp/agenc-timeout-policy-agent.sock",
      authCookie: "test-cookie",
    });

    expect(timeoutPolicy.resolve).toHaveBeenCalledWith(env, 30_000);
  });

  it("keeps daemon control requests at the two-second default", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-timeout-policy-"));
    roots.push(agencHome);
    const host = createHost(agencHome);
    await writeFile(
      resolveAgenCDaemonCookiePath(host.env, host.userHome),
      "test-cookie\n",
      { mode: 0o600 },
    );
    const stopBeforeSocket = new Error("timeout policy observed");
    timeoutPolicy.resolve.mockImplementationOnce(() => {
      throw stopBeforeSocket;
    });

    await expect(requestAgenCDaemonInstanceIdentity(host)).rejects.toBe(
      stopBeforeSocket,
    );
    expect(timeoutPolicy.resolve).toHaveBeenCalledWith(host.env, 2_000);
  });
});

function createHost(agencHome: string): AgenCDaemonCliHost {
  return {
    env: { AGENC_HOME: agencHome },
    userHome: "/home/test",
    entrypointPath: "/opt/agenc/bin/agenc.js",
    execPath: "/usr/bin/node",
    pid: 4100,
    spawnDetachedDaemon: () => 4200,
    isPidRunning: () => false,
    terminatePid: () => {},
    sleep: async () => {},
  };
}
