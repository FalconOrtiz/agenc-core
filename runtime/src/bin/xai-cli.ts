/** OAuth-only xAI media CLI and stable NDJSON broker transport. */

import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import {
  runXaiBrowserLogin,
  runXaiDeviceLogin,
  XaiOauthError,
  type XaiBrowserLoginResult,
} from "../services/xai/oauth.js";
import {
  XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
  XaiImagineBroker,
  handleXaiImagineBrokerValue,
  invalidJsonBrokerResponse,
  type XaiImagineBrokerResponse,
} from "../services/xai/imagine-broker.js";
import { migratePlainTextStorageToNative } from "../utils/secureStorage/index.js";
import {
  clearXaiOauthCredentials,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
} from "../utils/xaiOauthCredentials.js";

const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;

export type AgenCXaiCliCommand =
  | { readonly kind: "broker" }
  | { readonly kind: "auth-status" }
  | { readonly kind: "auth-login"; readonly device: boolean }
  | { readonly kind: "auth-logout" }
  | { readonly kind: "auth-migrate-storage" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCXaiCliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface XaiCliAuthDependencies {
  readonly browserLogin: typeof runXaiBrowserLogin;
  readonly deviceLogin: typeof runXaiDeviceLogin;
  readonly saveLogin: typeof saveXaiOauthCredentials;
  readonly clearLogin: typeof clearXaiOauthCredentials;
  readonly migrateStorage: typeof migratePlainTextStorageToNative;
}

export interface AgenCXaiCliOptions {
  readonly cwd?: string;
  readonly io?: AgenCXaiCliIo;
  readonly broker?: XaiImagineBroker;
  readonly serveBroker?: typeof serveXaiImagineBrokerStdio;
  readonly auth?: Partial<XaiCliAuthDependencies>;
}

const DEFAULT_AUTH: XaiCliAuthDependencies = {
  browserLogin: runXaiBrowserLogin,
  deviceLogin: runXaiDeviceLogin,
  saveLogin: saveXaiOauthCredentials,
  clearLogin: clearXaiOauthCredentials,
  migrateStorage: migratePlainTextStorageToNative,
};

export function formatAgenCXaiCliHelpText(): string {
  return [
    "Usage: agenc xai <command>",
    "       agenc xai broker --stdio",
    "       agenc xai auth <status|login|logout|migrate-storage>",
    "",
    "Commands:",
    "  broker --stdio          Run the versioned OAuth-only NDJSON media broker",
    "  auth status             Print safe xAI OAuth and storage status as JSON",
    "  auth login [--device]   Sign in with browser PKCE or device code",
    "  auth logout             Delete the stored xAI OAuth session",
    "  auth migrate-storage    Verify native vault storage, then remove plaintext",
    "",
    "The broker pins https://api.x.ai/v1, never reads API keys, and writes",
    "artifacts only beneath its startup working directory.",
    "",
    "Examples:",
    "  agenc xai broker --stdio",
    "  agenc xai auth status",
    "  agenc xai auth login --device",
  ].join("\n");
}

export function parseAgenCXaiCliArgs(
  argv: readonly string[],
): AgenCXaiCliCommand | null {
  if (argv[0] !== "xai") return null;
  if (
    argv.length === 1 ||
    (argv.length === 2 && ["help", "--help", "-h"].includes(argv[1]!))
  ) {
    return { kind: "help", text: formatAgenCXaiCliHelpText() };
  }
  if (argv[1] === "broker") {
    if (argv.length === 3 && ["--help", "-h"].includes(argv[2]!)) {
      return { kind: "help", text: formatAgenCXaiCliHelpText() };
    }
    if (argv.length === 3 && argv[2] === "--stdio") return { kind: "broker" };
    return {
      kind: "error",
      message: "xai broker requires the exact flag --stdio",
    };
  }
  if (argv[1] === "auth") {
    if (
      argv.length === 2 ||
      (argv.length === 3 && ["help", "--help", "-h"].includes(argv[2]!))
    ) {
      return { kind: "help", text: formatAgenCXaiCliHelpText() };
    }
    const action = argv[2];
    if (action === "status" && argv.length === 3) return { kind: "auth-status" };
    if (action === "logout" && argv.length === 3) return { kind: "auth-logout" };
    if (action === "migrate-storage" && argv.length === 3) {
      return { kind: "auth-migrate-storage" };
    }
    if (action === "login") {
      if (argv.length === 3) return { kind: "auth-login", device: false };
      if (argv.length === 4 && argv[3] === "--device") {
        return { kind: "auth-login", device: true };
      }
    }
    return {
      kind: "error",
      message: `invalid xai auth command: ${argv.slice(2).join(" ") || "(missing)"}`,
    };
  }
  return {
    kind: "error",
    message: `unknown xai command: ${argv[1] ?? "(missing)"}`,
  };
}

function tooLargeResponse(): XaiImagineBrokerResponse {
  return {
    protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
    id: null,
    ok: false,
    error: {
      code: "invalid_request",
      message: `input line exceeds ${MAX_NDJSON_LINE_BYTES} bytes`,
      retryable: false,
    },
  };
}

async function writeNdjson(io: AgenCXaiCliIo, value: unknown): Promise<void> {
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_NDJSON_LINE_BYTES) {
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    const id = typeof record?.id === "string"
      ? record.id.slice(0, 128)
      : null;
    serialized = JSON.stringify({
      protocol_version: XAI_IMAGINE_BROKER_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: "internal_error",
        message: "broker response exceeded the NDJSON frame limit",
        retryable: false,
      },
    });
  }
  await writeText(io.stdout, `${serialized}\n`);
}

async function writeText(stream: Writable, value: string): Promise<void> {
  if (!stream.write(value)) await once(stream, "drain");
}

function safeCliMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value
    .trim()
    .slice(0, 1_000)
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED]",
    )
    .replace(
      /\b(access_token|token|signature|sig|api_key)=[^\s&]+/giu,
      "$1=[REDACTED]",
    );
}

export async function serveXaiImagineBrokerStdio(
  io: AgenCXaiCliIo,
  broker: XaiImagineBroker,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let pendingBytes = 0;
  let droppingOversizedLine = false;

  const consume = async (text: string): Promise<void> => {
    const segments = text.split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      let segment = segments[index]!;
      const terminated = index < segments.length - 1;
      if (droppingOversizedLine) {
        if (!terminated) continue;
        droppingOversizedLine = false;
        pending = "";
        pendingBytes = 0;
        continue;
      }
      if (segment.endsWith("\r") && terminated) segment = segment.slice(0, -1);
      pending += segment;
      pendingBytes += Buffer.byteLength(segment, "utf8");
      if (pendingBytes > MAX_NDJSON_LINE_BYTES) {
        await writeNdjson(io, tooLargeResponse());
        pending = "";
        pendingBytes = 0;
        droppingOversizedLine = !terminated;
        continue;
      }
      if (!terminated) continue;
      const line = pending;
      pending = "";
      pendingBytes = 0;
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        await writeNdjson(io, invalidJsonBrokerResponse());
        continue;
      }
      await writeNdjson(io, await handleXaiImagineBrokerValue(broker, value));
    }
  };

  for await (const chunk of io.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    await consume(decoder.decode(bytes, { stream: true }));
  }
  await consume(decoder.decode());
  if (!droppingOversizedLine && pending.trim().length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(pending);
    } catch {
      await writeNdjson(io, invalidJsonBrokerResponse());
      return;
    }
    await writeNdjson(io, await handleXaiImagineBrokerValue(broker, value));
  }
}

async function writeJson(stream: Writable, value: unknown): Promise<void> {
  await writeText(stream, `${JSON.stringify(value)}\n`);
}

async function runLogin(
  device: boolean,
  io: AgenCXaiCliIo,
  auth: XaiCliAuthDependencies,
): Promise<number> {
  let login: XaiBrowserLoginResult;
  try {
    if (device) {
      login = await auth.deviceLogin({
        onUserCode: ({ userCode, verificationUri, verificationUriComplete }) => {
          io.stderr.write(
            `Open ${verificationUriComplete ?? verificationUri}\n` +
              `Enter xAI device code: ${userCode}\n`,
          );
        },
      });
    } else {
      login = await auth.browserLogin({
        onAuthorizeUrl: (url) => {
          io.stderr.write(`Open this xAI sign-in URL in a browser:\n${url}\n`);
        },
      });
    }
    const blob = xaiOauthTokensToBlob(login.tokens, {
      tokenEndpoint: login.tokenEndpoint,
    });
    const saved = auth.saveLogin(blob);
    if (!saved.success) {
      await writeJson(io.stderr, {
        ok: false,
        error: {
          code: "storage_failed",
          message: safeCliMessage(
            saved.warning,
            "xAI OAuth storage failed",
          ),
        },
      });
      return 1;
    }
    await writeJson(io.stdout, {
      ok: true,
      operation: "login",
      auth_mode: "oauth",
      configured: true,
      ...(blob.accountLabel !== undefined
        ? {
            account_label: safeCliMessage(
              blob.accountLabel,
              "account",
            ).slice(0, 256),
          }
        : {}),
      ...(saved.warning !== undefined
        ? {
            storage_warning: safeCliMessage(
              saved.warning,
              "Credential storage warning",
            ),
          }
        : {}),
    });
    return 0;
  } catch (error) {
    await writeJson(io.stderr, {
      ok: false,
      error: {
        code: error instanceof XaiOauthError ? error.code : "login_failed",
        message: safeCliMessage(error, "xAI login failed"),
      },
    });
    return 1;
  }
}

export async function runAgenCXaiCli(
  command: AgenCXaiCliCommand,
  options: AgenCXaiCliOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const auth = { ...DEFAULT_AUTH, ...options.auth };
  switch (command.kind) {
    case "help":
      await writeText(io.stdout, `${command.text}\n`);
      return 0;
    case "error":
      await writeText(
        io.stderr,
        `agenc: ${command.message}\n${formatAgenCXaiCliHelpText()}\n`,
      );
      return 1;
    case "broker": {
      const broker = options.broker ?? new XaiImagineBroker({
        artifactRoot: options.cwd ?? process.cwd(),
      });
      await (options.serveBroker ?? serveXaiImagineBrokerStdio)(io, broker);
      return 0;
    }
    case "auth-status": {
      const broker = options.broker ?? new XaiImagineBroker({
        artifactRoot: options.cwd ?? process.cwd(),
      });
      await writeJson(
        io.stdout,
        await broker.handle({
          protocol_version: 1,
          id: "auth-status",
          method: "auth.status",
        }),
      );
      return 0;
    }
    case "auth-login":
      return runLogin(command.device, io, auth);
    case "auth-logout": {
      const result = auth.clearLogin();
      await writeJson(result.success ? io.stdout : io.stderr, {
        ok: result.success,
        operation: "logout",
        ...(result.warning !== undefined
          ? { warning: safeCliMessage(result.warning, "Credential deletion warning") }
          : {}),
      });
      return result.success ? 0 : 1;
    }
    case "auth-migrate-storage": {
      const result = auth.migrateStorage();
      if (!result.success) {
        await writeJson(io.stderr, {
          ok: false,
          error: {
            code: "storage_migration_failed",
            reason: result.reason,
            storage: result.storage,
          },
        });
        return 1;
      }
      await writeJson(io.stdout, {
        ok: true,
        operation: "migrate-storage",
        migrated: result.migrated,
        already_secure: result.alreadySecure,
        storage: result.storage,
      });
      return 0;
    }
  }
}
