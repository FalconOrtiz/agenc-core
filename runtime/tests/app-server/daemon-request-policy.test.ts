import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV,
  MAX_DAEMON_REQUEST_TIMEOUT_MS,
  resolveAgenCDaemonRequestTimeoutMs,
} from "./daemon-request-policy.js";

const DAEMON_CLI_DEFAULT_MS = 2_000;
const AGENT_CLI_DEFAULT_MS = 30_000;

function resolve(raw: string | undefined, defaultTimeoutMs = 2_000): number {
  return resolveAgenCDaemonRequestTimeoutMs(
    raw === undefined
      ? {}
      : { [AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV]: raw },
    defaultTimeoutMs,
  );
}

describe("daemon request timeout policy", () => {
  it("uses each caller's explicit default for missing and blank values", () => {
    expect(resolve(undefined, DAEMON_CLI_DEFAULT_MS)).toBe(
      DAEMON_CLI_DEFAULT_MS,
    );
    expect(resolve(" \t\n", AGENT_CLI_DEFAULT_MS)).toBe(
      AGENT_CLI_DEFAULT_MS,
    );
  });

  it("accepts trimmed canonical positive integers through the timer maximum", () => {
    expect(resolve(" 42 ")).toBe(42);
    expect(resolve(String(MAX_DAEMON_REQUEST_TIMEOUT_MS))).toBe(
      MAX_DAEMON_REQUEST_TIMEOUT_MS,
    );
  });

  it.each([
    ["zero", "0"],
    ["leading zeros", "01"],
    ["plus sign", "+1"],
    ["negative sign", "-1"],
    ["fraction", "1.5"],
    ["exponent", "1e3"],
    ["timer overflow", String(MAX_DAEMON_REQUEST_TIMEOUT_MS + 1)],
    ["numeric overflow", "9".repeat(400)],
  ])("rejects %s", (_label, raw) => {
    expect(() => resolve(raw)).toThrow(
      `${AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV} must be a positive integer no greater than ${MAX_DAEMON_REQUEST_TIMEOUT_MS}`,
    );
  });
});
