import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveHomeContext } from "../../config/home.js";
import { ConfigStore } from "../../config/store.js";
import type { SecureStorageData } from "../../../src/utils/secureStorage/index.js";

const TEST_HOME_CONTEXT = resolveHomeContext(
  { AGENC_HOME: "/tmp/agenc-mcp-cli-redaction-test" },
  { platformHome: "/tmp" },
);
const TEST_AUTHORITY = new ConfigStore({
  home: TEST_HOME_CONTEXT.path,
  cwd: "/tmp",
  projectRoot: "/tmp",
  env: { AGENC_HOME: TEST_HOME_CONTEXT.path, HOME: "/tmp" },
});

vi.mock("bun:bundle", () => ({ feature: () => false }));

const mcpState = vi.hoisted(() => ({
  server: undefined as unknown,
}));
const credentials = vi.hoisted(() => new Map<string, SecureStorageData>());

vi.mock("../../utils/secureStorage/native.js", () => ({
  readNativeSecureStorage: (home: { path: string }) => structuredClone(credentials.get(home.path) ?? {}),
  readNativeSecureStorageFresh: (home: { path: string }) => structuredClone(credentials.get(home.path) ?? {}),
  updateNativeSecureStorage: (home: { path: string }, update: (value: SecureStorageData) => SecureStorageData) => {
    const previous = structuredClone(credentials.get(home.path) ?? {});
    const written = update(previous);
    credentials.set(home.path, structuredClone(written));
    return { previous, written };
  },
}));
vi.mock("../../services/mcp/auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/services/mcp/auth.js")>(),
  readClientSecret: vi.fn(),
}));
vi.mock("../../services/mcp/client.js", () => ({
  connectToServer: vi.fn(async () => ({ type: "failed" })),
  getMcpServerConnectionBatchSize: vi.fn(() => 1),
}));
vi.mock("../../services/mcp/config.js", () => ({
  addMcpConfig: vi.fn(),
  getAllMcpConfigs: vi.fn(async () => ({ servers: {} })),
  getMcpConfigByName: vi.fn(() => mcpState.server),
  getMcpConfigsByScope: vi.fn(() => ({ servers: {} })),
  removeMcpConfig: vi.fn(),
}));
vi.mock("../../services/mcp/doctor.js", () => ({
  doctorAllServers: vi.fn(),
  doctorServer: vi.fn(),
}));
vi.mock("../../services/mcp/utils.js", () => ({
  describeMcpConfigFilePath: vi.fn(() => "/tmp/agenc/config.toml"),
  ensureConfigScope: vi.fn((scope?: string) => scope ?? "user"),
  getScopeLabel: vi.fn((scope: string) => `${scope} config`),
}));
vi.mock("../../tui/components/MCPServerDesktopImportDialog.js", () => ({
  MCPServerDesktopImportDialog: vi.fn(() => null),
}));
vi.mock("../../tui/ink.js", () => ({ render: vi.fn() }));
vi.mock("../../tui/keybindings/KeybindingProviderSetup.js", () => ({
  KeybindingSetup: vi.fn(({ children }) => children),
}));
vi.mock("../../tui/state/AppState.js", () => ({
  AppStateProvider: vi.fn(({ children }) => children),
}));
vi.mock("../../utils/errors.js", () => ({ isFsInaccessible: vi.fn(() => false) }));
vi.mock("../../utils/gracefulShutdown.js", () => ({
  gracefulShutdown: vi.fn(async () => {}),
}));
vi.mock("../../utils/json.js", () => ({
  safeParseJSON: vi.fn((value: string) => JSON.parse(value)),
}));
vi.mock("../../utils/platform.js", () => ({ getPlatform: vi.fn(() => "linux") }));
vi.mock("../exit.js", () => ({
  cliError: vi.fn((message?: string) => {
    throw new Error(message ?? "cliError");
  }),
  cliOk: vi.fn(),
}));

import { addMcpConfig } from "../../services/mcp/config.js";
import { ensureConfigScope } from "../../services/mcp/utils.js";
import { AgenCAuthProvider, getServerKey, readClientSecret } from "../../services/mcp/auth.js";
import { McpServerConfigSchema } from "../../../src/services/mcp/types.js";
import { cliOk, cliError } from "../exit.js";
import { mcpAddJsonHandler, mcpGetHandler } from "./mcp.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  credentials.clear();
  mcpState.server = undefined;
});

function captureConsole(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("MCP CLI redaction", () => {
  test.each(["http", "sse"] as const)("add-json stores %s client secrets under the complete normalized OAuth identity", async (type) => {
    const input = {
      type,
      url: "https://mcp.example.test/mcp",
      headers: { "X-Tenant": "fixture-tenant" },
      oauth: {
        clientId: "fixture-public-client",
        scopes: ["read"],
        callbackPort: 3118,
        authServerMetadataUrl: "https://auth.example.test/metadata",
        ignoredMetadata: "not-part-of-the-normalized-identity",
      },
      enabled: false,
      enabled_tools: ["read_document"],
    };
    const config = McpServerConfigSchema().parse(input);
    if (config.type !== "http" && config.type !== "sse") throw new Error("Expected a remote fixture");
    const secret = "fixture-only-client-secret";
    vi.mocked(readClientSecret).mockResolvedValueOnce(secret);

    await mcpAddJsonHandler("static-client", JSON.stringify(input), {
      authority: TEST_AUTHORITY,
      environment: {},
      clientSecret: true,
    });

    expect(await new AgenCAuthProvider(TEST_HOME_CONTEXT, "static-client", config).clientInformation()).toEqual({
      client_id: input.oauth.clientId,
      client_secret: secret,
    });
    expect(addMcpConfig).toHaveBeenCalledWith("static-client", config, "user", TEST_AUTHORITY);
    expect(Object.keys(credentials.get(TEST_HOME_CONTEXT.path)?.mcpOAuthClientConfig ?? {})).toEqual([getServerKey("static-client", config)]);
    for (const changed of [
      { ...config, headers: { "X-Tenant": "other-tenant" } },
      { ...config, oauth: { ...config.oauth, clientId: "other-client" } },
      { ...config, oauth: { ...config.oauth, scopes: ["write"] } },
    ]) {
      expect((await new AgenCAuthProvider(TEST_HOME_CONTEXT, "static-client", changed).clientInformation())?.client_secret).toBeUndefined();
    }
    expect(JSON.stringify(vi.mocked(addMcpConfig).mock.calls)).not.toContain(secret);
    expect(JSON.stringify([vi.mocked(cliOk).mock.calls, vi.mocked(cliError).mock.calls])).not.toContain(secret);
  });

  test("add-json cancellation writes neither configuration nor client credentials", async () => {
    vi.mocked(readClientSecret).mockRejectedValueOnce(new Error("Cancelled"));
    await expect(mcpAddJsonHandler("static-client", JSON.stringify({
      type: "http", url: "https://mcp.example.test/mcp", oauth: { clientId: "fixture-client" },
    }), { authority: TEST_AUTHORITY, environment: {}, clientSecret: true })).rejects.toThrow("Cancelled");
    expect(addMcpConfig).not.toHaveBeenCalled();
    expect(credentials.size).toBe(0);
  });

  test("add-json rejects invalid configuration without prompting or echoing input", async () => {
    const privateInput = "fixture-private-invalid-value";
    await expect(mcpAddJsonHandler("static-client", JSON.stringify({
      type: "http", url: { privateInput }, oauth: { clientId: "fixture-client" },
    }), { authority: TEST_AUTHORITY, environment: {}, clientSecret: true })).rejects.toThrow("Invalid MCP server configuration.");
    expect(readClientSecret).not.toHaveBeenCalled();
    expect(addMcpConfig).not.toHaveBeenCalled();
    expect(credentials.size).toBe(0);
    expect(JSON.stringify(vi.mocked(cliError).mock.calls)).not.toContain(privateInput);
  });

  test("mcp add-json defaults to user scope", async () => {
    await mcpAddJsonHandler(
      "game-helper",
      JSON.stringify({ type: "stdio", command: "node", args: ["server.js"] }),
      { authority: TEST_AUTHORITY },
    );

    expect(ensureConfigScope).toHaveBeenCalledWith("user");
    expect(addMcpConfig).toHaveBeenCalledWith(
      "game-helper",
      { type: "stdio", command: "node", args: ["server.js"] },
      "user",
      TEST_AUTHORITY,
    );
  });

  test("mcp get redacts remote headers", async () => {
    const lines = captureConsole();
    mcpState.server = {
      type: "http",
      scope: "user",
      url: "https://agenc.tech/mcp",
      headers: {
        Authorization: "Bearer secret-token",
        "X-API-Key": "api-secret",
      },
    };

    await mcpGetHandler(TEST_AUTHORITY, "docs");

    const output = lines.join("\n");
    expect(output).toContain("Authorization: <redacted>");
    expect(output).toContain("X-API-Key: <redacted>");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("api-secret");
  });

  test("mcp get redacts stdio environment values", async () => {
    const lines = captureConsole();
    mcpState.server = {
      type: "stdio",
      scope: "user",
      command: "gh-mcp",
      args: [],
      env: {
        API_KEY: "api-secret",
        DEBUG: "true",
      },
    };

    await mcpGetHandler(TEST_AUTHORITY, "github");

    const output = lines.join("\n");
    expect(output).toContain("API_KEY=<redacted>");
    expect(output).toContain("DEBUG=<redacted>");
    expect(output).not.toContain("api-secret");
    expect(output).not.toContain("DEBUG=true");
  });
});
