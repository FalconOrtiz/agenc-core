import { execFile } from "node:child_process";
import { win32 } from "node:path";

import {
  resolveTrustedWindowsSystemExecutable,
  resolveTrustedWindowsSystemPaths,
  type TrustedWindowsSystemPaths,
} from "./windows-system-path.js";

export const WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS = 45_000;
const WINDOWS_PROCESS_CREATION_TIME_MAX_BUFFER_BYTES = 4_096;
const WINDOWS_DATETIME_MAX_TICKS = "3155378975999999999";

interface WindowsProcessQueryResult {
  readonly stdout: string;
}

type WindowsProcessQuery = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly signal?: AbortSignal;
    readonly timeout: number;
    readonly windowsHide: true;
  },
) => Promise<WindowsProcessQueryResult>;

export interface TrustedWindowsProcessCreationTimeOptions {
  readonly signal?: AbortSignal;
  /**
   * Per-query wall-clock bound. Callers with a tighter aggregate recovery
   * budget must supply their remaining allowance instead of inheriting the
   * daemon-startup cold-launch allowance.
   */
  readonly timeoutMs?: number;
}

/**
 * Read an arbitrary Windows process creation time without consulting PATH,
 * caller cwd, profiles, CIM/WMI, or module autoload. The PowerShell binary is
 * identity-proved against GLOBALROOT and receives a minimal trusted env.
 */
export async function readTrustedWindowsProcessCreationTime(
  pid: number,
  options: TrustedWindowsProcessCreationTimeOptions = {},
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const timeoutMs =
    options.timeoutMs ?? WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Windows process creation-time timeout must be between 1 and ${WINDOWS_PROCESS_CREATION_TIME_QUERY_TIMEOUT_MS}ms`,
    );
  }
  const paths = resolveTrustedWindowsSystemPaths();
  const executable = resolveTrustedWindowsSystemExecutable(paths, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  const script = [
    `try { $target = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch [System.ArgumentException] { exit 3 }`,
    "$ticks = $target.StartTime.ToUniversalTime().Ticks",
    "[Console]::Out.Write($ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))",
  ].join("; ");
  try {
    // Hosted Windows PowerShell 5.1 can take tens of seconds to cold-start.
    // This mandatory identity query therefore has a bounded 45s budget, but
    // uses direct mscorlib Process.StartTime and never CIM/module autoload.
    const result = await executeWindowsProcessQuery(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: paths.system32,
        env: trustedWindowsProcessQueryEnvironment(paths),
        maxBuffer: WINDOWS_PROCESS_CREATION_TIME_MAX_BUFFER_BYTES,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    const ticks = result.stdout.trim();
    if (
      !/^[1-9]\d*$/u.test(ticks) ||
      ticks.length > WINDOWS_DATETIME_MAX_TICKS.length ||
      BigInt(ticks) > BigInt(WINDOWS_DATETIME_MAX_TICKS)
    ) {
      throw new Error(
        "Windows process creation-time query returned invalid output",
      );
    }
    return ticks;
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    const code = (
      error as (NodeJS.ErrnoException & { code?: number }) | undefined
    )?.code;
    // The script reserves exit 3 for Process.GetProcessById's missing-PID
    // ArgumentException. Access failures and every other query error remain
    // explicit so callers fail closed.
    if (code === 3) return null;
    throw error;
  }
}

function trustedWindowsProcessQueryEnvironment(
  paths: TrustedWindowsSystemPaths,
): NodeJS.ProcessEnv {
  return {
    COMSPEC: win32.join(paths.system32, "cmd.exe"),
    PATH: `${paths.powerShellRoot};${paths.system32}`,
    PATHEXT: ".COM;.EXE",
    PSMODULEPATH: "",
    SystemRoot: paths.systemRoot,
    TEMP: win32.join(paths.systemRoot, "Temp"),
    TMP: win32.join(paths.systemRoot, "Temp"),
    WINDIR: paths.systemRoot,
  };
}

function executeWindowsProcessQuery(
  executable: string,
  args: readonly string[],
  options: Parameters<WindowsProcessQuery>[2],
): Promise<WindowsProcessQueryResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { ...options, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}
