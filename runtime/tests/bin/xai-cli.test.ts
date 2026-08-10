import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  formatAgenCXaiCliHelpText,
  parseAgenCXaiCliArgs,
  runAgenCXaiCli,
  serveXaiImagineBrokerStdio,
  type AgenCXaiCliIo,
} from "../../src/bin/xai-cli.js";
import { XaiImagineBroker } from "../../src/services/xai/imagine-broker.js";
import type { XaiOauthCredentialBlob } from "../../src/utils/xaiOauthCredentials.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agenc-xai-cli-"));
  roots.push(value);
  return value;
}

function capture(): Writable & { text(): string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  return Object.assign(stream, { text: () => output });
}

function io(input = ""): AgenCXaiCliIo & {
  stdout: Writable & { text(): string };
  stderr: Writable & { text(): string };
} {
  return {
    stdin: Readable.from([input]),
    stdout: capture(),
    stderr: capture(),
  };
}

function session(storage = "libsecret") {
  const blob: XaiOauthCredentialBlob = {
    accessToken: "never-print-access-token",
    refreshToken: "never-print-refresh-token",
    expiresAt: Date.now() + 6 * 60 * 60 * 1_000,
  };
  return {
    read: () => blob,
    refreshIfNeeded: async () => blob,
    forceRefresh: async () => blob,
    storageKind: () => storage,
  };
}

describe("xai CLI parsing", () => {
  test.each([
    [["xai"], "help"],
    [["xai", "--help"], "help"],
    [["xai", "broker", "--stdio"], "broker"],
    [["xai", "auth", "status"], "auth-status"],
    [["xai", "auth", "login"], "auth-login"],
    [["xai", "auth", "login", "--device"], "auth-login"],
    [["xai", "auth", "logout"], "auth-logout"],
    [["xai", "auth", "migrate-storage"], "auth-migrate-storage"],
  ])("parses %j as %s", (argv, kind) => {
    expect(parseAgenCXaiCliArgs(argv)).toMatchObject({ kind });
  });

  test.each([
    ["missing stdio", ["xai", "broker"]],
    ["unknown broker flag", ["xai", "broker", "--stdio=true"]],
    ["duplicate stdio", ["xai", "broker", "--stdio", "--stdio"]],
    ["auth extra positional", ["xai", "auth", "status", "extra"]],
    ["login unknown flag", ["xai", "auth", "login", "--browser"]],
    ["unknown namespace", ["xai", "generate"]],
  ])("captures malformed xai argv instead of falling through: %s", (_label, argv) => {
    expect(parseAgenCXaiCliArgs(argv)).toMatchObject({ kind: "error" });
  });

  test("returns null only outside the xai namespace", () => {
    expect(parseAgenCXaiCliArgs(["mcp", "list"])).toBeNull();
  });
});

describe("xai CLI execution", () => {
  test("prints help and errors on separate channels", async () => {
    const helpIo = io();
    expect(
      await runAgenCXaiCli(
        { kind: "help", text: formatAgenCXaiCliHelpText() },
        { io: helpIo },
      ),
    ).toBe(0);
    expect(helpIo.stdout.text()).toContain("agenc xai broker --stdio");
    expect(helpIo.stderr.text()).toBe("");

    const errorIo = io();
    expect(
      await runAgenCXaiCli(
        { kind: "error", message: "bad xai command" },
        { io: errorIo },
      ),
    ).toBe(1);
    expect(errorIo.stdout.text()).toBe("");
    expect(errorIo.stderr.text()).toContain("bad xai command");
  });

  test("auth status is safe JSON with explicit storage security", async () => {
    const commandIo = io();
    const broker = new XaiImagineBroker({ oauth: session("plaintext"), artifactRoot: await root() });
    expect(
      await runAgenCXaiCli({ kind: "auth-status" }, { io: commandIo, broker }),
    ).toBe(0);
    const output = JSON.parse(commandIo.stdout.text());
    expect(output).toMatchObject({
      auth_mode: "oauth",
      configured: true,
      storage_security: { status: "plaintext", secure: false },
    });
    expect(commandIo.stdout.text()).not.toContain("never-print-access-token");
    expect(commandIo.stdout.text()).not.toContain("never-print-refresh-token");
  });

  test("login stores tokens but returns only non-secret status", async () => {
    const commandIo = io();
    const saveLogin = vi.fn(() => ({ success: true as const }));
    const browserLogin = vi.fn(async ({ onAuthorizeUrl }) => {
      await onAuthorizeUrl("https://auth.x.ai/authorize?safe-state=1");
      return {
        tokens: {
          accessToken: "login-access-secret",
          refreshToken: "login-refresh-secret",
          expiresAt: Date.now() + 60_000,
        },
        identity: { sub: "subject" },
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
      };
    });
    expect(
      await runAgenCXaiCli(
        { kind: "auth-login", device: false },
        { io: commandIo, auth: { browserLogin, saveLogin } },
      ),
    ).toBe(0);
    expect(saveLogin).toHaveBeenCalledTimes(1);
    expect(commandIo.stderr.text()).toContain("https://auth.x.ai/authorize");
    expect(commandIo.stdout.text()).toContain('"configured":true');
    expect(commandIo.stdout.text()).not.toContain("login-access-secret");
    expect(commandIo.stdout.text()).not.toContain("login-refresh-secret");
  });

  test("logout and migration expose status only", async () => {
    const logoutIo = io();
    expect(
      await runAgenCXaiCli(
        { kind: "auth-logout" },
        { io: logoutIo, auth: { clearLogin: () => ({ success: true }) } },
      ),
    ).toBe(0);
    expect(JSON.parse(logoutIo.stdout.text())).toMatchObject({
      ok: true,
      operation: "logout",
    });

    const migrateIo = io();
    expect(
      await runAgenCXaiCli(
        { kind: "auth-migrate-storage" },
        {
          io: migrateIo,
          auth: {
            migrateStorage: () => ({
              success: true,
              migrated: true,
              alreadySecure: false,
              storage: "libsecret",
            }),
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(migrateIo.stdout.text())).toEqual({
      ok: true,
      operation: "migrate-storage",
      migrated: true,
      already_secure: false,
      storage: "libsecret",
    });
  });
});

describe("NDJSON stdio contract", () => {
  test("emits one valid JSON response per input line and drains through EOF", async () => {
    const commandIo = io(
      [
        JSON.stringify({
          protocol_version: 1,
          id: "one",
          method: "protocol.version",
        }),
        "not-json",
        JSON.stringify({
          protocol_version: 1,
          id: "two",
          method: "auth.status",
        }),
        "",
      ].join("\n"),
    );
    const broker = new XaiImagineBroker({ oauth: session(), artifactRoot: await root() });
    await serveXaiImagineBrokerStdio(commandIo, broker);
    const lines = commandIo.stdout.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ protocol_version: 1, id: "one", ok: true });
    expect(lines[1]).toMatchObject({
      protocol_version: 1,
      id: null,
      ok: false,
      error: { code: "invalid_json" },
    });
    expect(lines[2]).toMatchObject({ protocol_version: 1, id: "two", ok: true });
    expect(commandIo.stderr.text()).toBe("");
  });

  test("rejects oversized unterminated lines without losing the next request", async () => {
    const valid = JSON.stringify({
      protocol_version: 1,
      id: "after-large",
      method: "protocol.version",
    });
    const commandIo = io(`${"x".repeat(16 * 1024 * 1024 + 1)}\n${valid}\n`);
    const broker = new XaiImagineBroker({ oauth: session(), artifactRoot: await root() });
    await serveXaiImagineBrokerStdio(commandIo, broker);
    const lines = commandIo.stdout.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(lines[1]).toMatchObject({ id: "after-large", ok: true });
  });

  test("awaits output backpressure and never contaminates stdout", async () => {
    let output = "";
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        output += String(chunk);
        setImmediate(callback);
      },
    });
    const commandIo: AgenCXaiCliIo = {
      stdin: Readable.from([
        `${JSON.stringify({ protocol_version: 1, id: "bp", method: "auth.status" })}\n`,
      ]),
      stdout,
      stderr: capture(),
    };
    const broker = new XaiImagineBroker({ oauth: session(), artifactRoot: await root() });
    await serveXaiImagineBrokerStdio(commandIo, broker);
    expect(JSON.parse(output)).toMatchObject({ id: "bp", ok: true });
    expect(output).not.toContain("never-print-access-token");
  });

  test("the CLI broker runner is injectable and awaited", async () => {
    const commandIo = io();
    const serveBroker = vi.fn(async () => {});
    const broker = new XaiImagineBroker({ oauth: session(), artifactRoot: await root() });
    expect(
      await runAgenCXaiCli(
        { kind: "broker" },
        { io: commandIo, broker, serveBroker },
      ),
    ).toBe(0);
    expect(serveBroker).toHaveBeenCalledWith(commandIo, broker);
    expect(commandIo.stdout.text()).toBe("");
  });
});
