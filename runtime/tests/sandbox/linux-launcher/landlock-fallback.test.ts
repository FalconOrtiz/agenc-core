import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { planLandlockConfinement } from "../../../src/sandbox/linux-launcher/landlock-exec.js";
import { runLinuxSandboxMain } from "../../../src/sandbox/linux-launcher/linux-run-main.js";
import {
  restrictedFileSystemPolicy,
  type PermissionProfile,
} from "../../../src/sandbox/engine/index.js";
import { probeLandlock } from "../../../src/sandbox/landlock-run.js";
import { preferredBubblewrapLauncher } from "../../../src/sandbox/linux-launcher/launcher.js";

const canRunLive = process.platform === "linux" && probeLandlock() === "full";

const work: string[] = [];
afterAll(() => {
  for (const dir of work) fs.rmSync(dir, { recursive: true, force: true });
});

function withTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  work.push(dir);
  return dir;
}

function workspaceWriteProfile(
  workspace: string,
  network: PermissionProfile["network"],
): PermissionProfile {
  // Mirrors the production workspace_write shape: full disk read plus a
  // writable workspace, with platform defaults on.
  return {
    fileSystem: restrictedFileSystemPolicy(
      [
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "path", path: workspace }, access: "write" },
      ],
      { includePlatformDefaults: true },
    ),
    network,
  };
}

function readOnlyProfile(
  network: PermissionProfile["network"] = "disabled",
): PermissionProfile {
  return {
    fileSystem: restrictedFileSystemPolicy(
      [
        {
          path: { kind: "special", value: { kind: "root" } },
          access: "read",
        },
      ],
      { includePlatformDefaults: true },
    ),
    network,
  };
}

/** Run the REAL helper main with bubblewrap made unavailable. */
async function runFallback(
  profile: PermissionProfile,
  workspace: string,
  command: readonly string[],
): Promise<{ exitCode: number; stderr: string[] }> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(
    [
      "--sandbox-policy-cwd",
      workspace,
      "--command-cwd",
      workspace,
      "--permission-profile",
      JSON.stringify(profile),
      "--",
      ...command,
    ],
    {
      preferredLauncher: () => null,
      onStderr: (line) => stderr.push(line),
    },
  );
  return { exitCode, stderr };
}

async function runInheritedFallback(
  profile: PermissionProfile,
  command: readonly string[],
): Promise<{ exitCode: number; stderr: string[] }> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(
    [
      "--inherited-readonly-command-cwd",
      "--permission-profile",
      JSON.stringify(profile),
      "--no-proc",
      "--",
      ...command,
    ],
    {
      preferredLauncher: () => null,
      onStderr: (line) => stderr.push(line),
    },
  );
  return { exitCode, stderr };
}

describe("planLandlockConfinement refusals", () => {
  const base = {
    sandboxPolicyCwd: "/tmp",
    allowNetworkForProxy: false,
    inheritedCwd: false,
  } as const;
  const plainPolicy = restrictedFileSystemPolicy([
    { path: { kind: "path", path: "/tmp" }, access: "write" },
  ]);

  it("refuses managed proxy networking", () => {
    const plan = planLandlockConfinement({
      ...base,
      allowNetworkForProxy: true,
      fileSystem: plainPolicy,
    });
    expect(plan).toMatchObject({ kind: "refused" });
  });

  it("accepts an inherited cwd only after writable roots are removed", () => {
    const refused = planLandlockConfinement({
      ...base,
      inheritedCwd: true,
      fileSystem: plainPolicy,
    });
    expect(refused).toEqual({
      kind: "refused",
      reason: "inherited read-only cwd cannot retain writable filesystem roots",
    });

    const accepted = planLandlockConfinement({
      ...base,
      inheritedCwd: true,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(accepted).toMatchObject({
      kind: "ok",
      readWrite: expect.not.arrayContaining(["/tmp"]),
    });
  });



  it("refuses unreadable masks an allow-list cannot express", () => {
    const secret = withTempDir("agenc-landlock-plan-secret-");
    const plan = planLandlockConfinement({
      ...base,
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/tmp" }, access: "write" },
        { path: { kind: "path", path: secret }, access: "none" },
      ]),
    });
    expect(plan).toMatchObject({ kind: "refused" });
    expect((plan as { reason: string }).reason).toContain("allow-list");
  });

  it("refuses read-only carve-outs inside a writable root", () => {
    const workspace = withTempDir("agenc-landlock-plan-carveout-");
    const frozen = path.join(workspace, "frozen");
    fs.mkdirSync(frozen);
    const plan = planLandlockConfinement({
      ...base,
      sandboxPolicyCwd: workspace,
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: workspace }, access: "write" },
        { path: { kind: "path", path: frozen }, access: "read" },
      ]),
    });
    expect(plan).toMatchObject({ kind: "refused" });
  });

  it("never grants /proc or /sys, even under full disk read", () => {
    const plan = planLandlockConfinement({
      ...base,
      fileSystem: restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
          { path: { kind: "path", path: "/tmp" }, access: "write" },
        ],
        { includePlatformDefaults: true },
      ),
    });
    expect(plan.kind).toBe("ok");
    const grants = plan as { readOnly: readonly string[] };
    expect(grants.readOnly).not.toContain("/proc");
    expect(grants.readOnly).not.toContain("/sys");
    expect(grants.readOnly.length).toBeGreaterThan(0);
  });
});

describe.runIf(canRunLive)("Landlock fallback through the real helper", () => {
  it("runs a descriptor-bound read in a git workspace with writes and network removed", async () => {
    const root = withTempDir("agenc-landlock-bound-read-");
    const workspace = path.join(root, "workspace");
    const unexpectedWrite = path.join(workspace, "unexpected.txt");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(path.join(workspace, "sentinel.txt"), "bound-read\n");
    const savedCwd = process.cwd();
    process.chdir(workspace);
    try {
      const read = await runInheritedFallback(
        readOnlyProfile(),
        ["/bin/sh", "-c", 'test "$(cat sentinel.txt)" = bound-read'],
      );
      expect(read).toEqual({ exitCode: 0, stderr: [] });

      const write = await runInheritedFallback(
        readOnlyProfile(),
        ["/bin/sh", "-c", `printf unexpected > ${unexpectedWrite}`],
      );
      expect(write.exitCode).not.toBe(0);
      expect(fs.existsSync(unexpectedWrite)).toBe(false);

      if (fs.existsSync("/usr/bin/python3")) {
        const network = await runInheritedFallback(
          readOnlyProfile(),
          [
            "/usr/bin/python3",
            "-c",
            "import socket, sys\n" +
              "try:\n" +
              "  socket.socket(socket.AF_INET)\n" +
              "except PermissionError:\n" +
              "  sys.exit(0)\n" +
              "sys.exit(9)",
          ],
        );
        expect(network.exitCode).toBe(0);
      }
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("uses Landlock when installed bubblewrap cannot create namespaces", async () => {
    const root = withTempDir("agenc-landlock-bwrap-denied-");
    const workspace = path.join(root, "workspace");
    const trusted = path.join(root, "trusted-bin");
    fs.mkdirSync(workspace);
    fs.mkdirSync(trusted);
    const fakeBwrap = path.join(trusted, "bwrap");
    fs.writeFileSync(
      fakeBwrap,
      [
        "#!/bin/sh",
        'if [ "$1" = "--help" ]; then',
        "  echo '--argv0 --ro-bind-fd'",
        "  exit 0",
        "fi",
        "echo 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2",
        "exit 1",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const capture = path.join(workspace, "result.txt");
    const stderr: string[] = [];

    const exitCode = await runLinuxSandboxMain(
      [
        "--sandbox-policy-cwd",
        workspace,
        "--command-cwd",
        workspace,
        "--permission-profile",
        JSON.stringify(workspaceWriteProfile(workspace, "disabled")),
        "--",
        "/bin/sh",
        "-c",
        `printf fallback-ok > ${capture}`,
      ],
      {
        preferredLauncher: (options = {}) =>
          preferredBubblewrapLauncher({
            ...options,
            searchPath: trusted,
            trustedDirectories: [trusted],
          }),
        onStderr: (line) => stderr.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(fs.readFileSync(capture, "utf8")).toBe("fallback-ok");
  });

  it("confines writes to the workspace when bubblewrap is unavailable", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-ws-");
    const outside = withTempDir("agenc-landlock-fallback-out-");
    const inside = path.join(workspace, "made.txt");
    const escaped = path.join(outside, "escaped.txt");

    const ok = await runFallback(
      workspaceWriteProfile(workspace, "disabled"),
      workspace,
      ["/bin/sh", "-c", `echo confined > ${inside}`],
    );
    expect(ok.exitCode).toBe(0);
    expect(fs.readFileSync(inside, "utf8")).toBe("confined\n");

    const denied = await runFallback(
      workspaceWriteProfile(workspace, "disabled"),
      workspace,
      ["/bin/sh", "-c", `echo escaped > ${escaped}`],
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it("keeps /proc unreadable, closing the same-uid environ channel", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-proc-");
    const capture = path.join(workspace, "proc.txt");
    const denied = await runFallback(
      workspaceWriteProfile(workspace, "disabled"),
      workspace,
      ["/bin/sh", "-c", `cat /proc/self/status > ${capture}`],
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fs.readFileSync(capture, "utf8")).toBe("");
  });

  it("applies the network seccomp program when the policy disables network", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-net-");
    if (!fs.existsSync("/usr/bin/python3")) return;
    const verdict = path.join(workspace, "net.txt");
    const probe = await runFallback(
      workspaceWriteProfile(workspace, "disabled"),
      workspace,
      [
        "/usr/bin/python3",
        "-c",
        "import socket\n" +
          "out = open(" + JSON.stringify(verdict) + ", 'w')\n" +
          "try:\n" +
          "  socket.socket(socket.AF_INET)\n" +
          "  out.write('inet-open')\n" +
          "except PermissionError:\n" +
          "  out.write('inet-denied')\n" +
          "out.close()",
      ],
    );
    expect(probe.exitCode).toBe(0);
    expect(fs.readFileSync(verdict, "utf8")).toBe("inet-denied");
  });

  it("leaves the network open when the policy enables it", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-neton-");
    if (!fs.existsSync("/usr/bin/python3")) return;
    const verdict = path.join(workspace, "net.txt");
    const probe = await runFallback(
      workspaceWriteProfile(workspace, "enabled"),
      workspace,
      [
        "/usr/bin/python3",
        "-c",
        "import socket; socket.socket(socket.AF_INET)\n" +
          "open(" + JSON.stringify(verdict) + ", 'w').write('inet-open')",
      ],
    );
    expect(probe.exitCode).toBe(0);
    expect(fs.readFileSync(verdict, "utf8")).toBe("inet-open");
  });

  it("fails closed with both reasons when the policy is inexpressible", async () => {
    const workspace = withTempDir("agenc-landlock-fallback-refuse-");
    const secret = withTempDir("agenc-landlock-fallback-secret-");
    const result = await runFallback(
      {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "path", path: workspace }, access: "write" },
          { path: { kind: "path", path: secret }, access: "none" },
        ]),
        network: "disabled",
      },
      workspace,
      ["/bin/true"],
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toContain(
      "Landlock fallback cannot express",
    );
  });
});

describe.runIf(canRunLive)("broker probe fallback", () => {
  it("reports ready through Landlock when bubblewrap is missing from PATH", async () => {
    const { probeSandboxExecutionStatus } = await import(
      "../../../src/sandbox/execution-broker.js"
    );
    const cwd = withTempDir("agenc-landlock-probe-cwd-");
    const status = probeSandboxExecutionStatus({
      mode: "workspace_write",
      cwd,
      env: { PATH: "/nonexistent-path-for-probe" },
      platform: "linux",
      agencLinuxSandboxExe: path.resolve(
        __dirname,
        "../../../bin/agenc-linux-sandbox",
      ),
    });
    expect(status.kind).toBe("ready");
    expect(status.landlock).toBe("full");
    expect(status.reason).toContain("Landlock fallback is active");
    expect(status.isolationProgram).toBeDefined();
  });
});
