import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrustedWindowsSystemPaths } from "../../src/utils/windows-system-path.js";

const dependencyMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveExecutable: vi.fn(),
  resolvePaths: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: dependencyMocks.execFile,
}));

vi.mock("../../src/utils/windows-system-path.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/utils/windows-system-path.js")
  >()),
  resolveTrustedWindowsSystemExecutable: dependencyMocks.resolveExecutable,
  resolveTrustedWindowsSystemPaths: dependencyMocks.resolvePaths,
}));

import {
  readTrustedWindowsProcessCreationTime,
  WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS,
} from "../../src/utils/windows-process-identity.js";

const TRUSTED_PATHS: TrustedWindowsSystemPaths = {
  systemRoot: String.raw`C:\Windows`,
  system32: String.raw`C:\Windows\System32`,
  powerShellRoot: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`,
  namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
};
const TRUSTED_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function completeQuery(stdout: string): void {
  dependencyMocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: NodeJS.ErrnoException | null,
      stdout: string,
    ) => void;
    callback(null, stdout);
  });
}

function failQuery(error: NodeJS.ErrnoException): void {
  dependencyMocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: NodeJS.ErrnoException | null,
      stdout: string,
    ) => void;
    callback(error, "");
  });
}

describe("trusted Windows process creation-time query", () => {
  beforeEach(() => {
    dependencyMocks.execFile.mockReset();
    dependencyMocks.resolveExecutable.mockReset();
    dependencyMocks.resolvePaths.mockReset();
    dependencyMocks.resolvePaths.mockReturnValue(TRUSTED_PATHS);
    dependencyMocks.resolveExecutable.mockReturnValue(TRUSTED_POWERSHELL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the GLOBALROOT-proved executable, direct .NET query, and scrubbed launch context", async () => {
    vi.stubEnv("PATH", String.raw`C:\attacker`);
    vi.stubEnv("SystemRoot", String.raw`D:\fake-windows`);
    vi.stubEnv("WINDIR", String.raw`E:\other-fake-windows`);
    completeQuery("638911234567890123\r\n");

    await expect(readTrustedWindowsProcessCreationTime(4242)).resolves.toBe(
      "638911234567890123",
    );

    expect(dependencyMocks.resolvePaths).toHaveBeenCalledOnce();
    expect(dependencyMocks.resolveExecutable).toHaveBeenCalledExactlyOnceWith(
      TRUSTED_PATHS,
      ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    );
    expect(dependencyMocks.execFile).toHaveBeenCalledTimes(1);
    const [executable, args, options] = dependencyMocks.execFile.mock.calls[0]!;
    expect(executable).toBe(TRUSTED_POWERSHELL);
    expect(args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining(
        "[System.Diagnostics.Process]::GetProcessById(4242)",
      ),
    ]);
    expect((args as readonly string[]).at(-1)).not.toMatch(
      /Get-CimInstance|Win32_Process/u,
    );
    expect(options).toEqual({
      cwd: TRUSTED_PATHS.system32,
      encoding: "utf8",
      env: {
        COMSPEC: String.raw`C:\Windows\System32\cmd.exe`,
        PATH: `${TRUSTED_PATHS.powerShellRoot};${TRUSTED_PATHS.system32}`,
        PATHEXT: ".COM;.EXE",
        PSMODULEPATH: "",
        SystemRoot: TRUSTED_PATHS.systemRoot,
        TEMP: String.raw`C:\Windows\Temp`,
        TMP: String.raw`C:\Windows\Temp`,
        WINDIR: TRUSTED_PATHS.systemRoot,
      },
      maxBuffer: 4_096,
      timeout: WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    expect(
      WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(30_000);
  });

  it("maps only the script's reserved missing-PID exit to null", async () => {
    failQuery(Object.assign(new Error("missing"), { code: 3 }));
    await expect(
      readTrustedWindowsProcessCreationTime(4242),
    ).resolves.toBeNull();

    failQuery(Object.assign(new Error("access denied"), { code: 1 }));
    await expect(readTrustedWindowsProcessCreationTime(4242)).rejects.toThrow(
      /access denied/u,
    );
  });

  it.each([
    "",
    "0",
    "01",
    "3155378976000000000",
    "9999999999999999999999999999999999999999",
    "not-a-creation-time",
  ])("rejects non-canonical or out-of-range ticks %j", async (stdout) => {
    completeQuery(stdout);
    await expect(readTrustedWindowsProcessCreationTime(4242)).rejects.toThrow(
      /invalid output/u,
    );
  });

  it("accepts DateTime.MaxValue ticks without numeric precision loss", async () => {
    completeQuery("3155378975999999999");
    await expect(readTrustedWindowsProcessCreationTime(4242)).resolves.toBe(
      "3155378975999999999",
    );
  });

  it("honors a caller's tighter recovery deadline", async () => {
    completeQuery("638911234567890123");

    await expect(
      readTrustedWindowsProcessCreationTime(4242, { timeoutMs: 2_000 }),
    ).resolves.toBe("638911234567890123");

    const options = dependencyMocks.execFile.mock.calls[0]?.[2] as
      { readonly timeout?: number } | undefined;
    expect(options?.timeout).toBe(2_000);
  });
});
