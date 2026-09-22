import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SecureStorageData } from "../../../src/utils/secureStorage/index.js";

const records = vi.hoisted(() => new Map<string, SecureStorageData>());
const cachedRecords = vi.hoisted(() => new Map<string, SecureStorageData>());
vi.mock("../../../src/utils/secureStorage/native.js", () => ({
  readNativeSecureStorage: (home: { path: string }) => structuredClone(cachedRecords.get(home.path) ?? records.get(home.path) ?? {}),
  readNativeSecureStorageFresh: (home: { path: string }) => structuredClone(records.get(home.path) ?? {}),
  updateNativeSecureStorage: (home: { path: string }, update: (value: SecureStorageData) => SecureStorageData) => {
    const previous = structuredClone(records.get(home.path) ?? {});
    const written = update(previous); records.set(home.path, structuredClone(written));
    return { previous, written };
  },
}));
vi.mock("../../../src/utils/log.js", () => ({ logMCPDebug: vi.fn(), logError: vi.fn(), debug: vi.fn() }));
vi.mock("../../../src/utils/browser.js", () => ({ openBrowser: vi.fn(() => { throw new Error("Unexpected real browser launch"); }) }));

import { resolveHomeContext } from "../../../src/config/home.js";
import { getServerKey, AgenCAuthProvider } from "../../../src/services/mcp/auth.js";
import { authenticateMcp, mcpOAuthFetch, mcpOAuthTransportFetch, runtimeMcpOAuthProvider, mcpOAuthAuthenticated } from "../../../src/services/mcp/interactive-auth.js";
import { createHttpMCPConnection } from "../../../src/mcp-client/transports/http.js";

let root: string;
let server: Server;
let base: string;
let callbackPort: number;
let challenge: string;
let requests: string[];
let tokenRequests: URLSearchParams[];
let resourceHeaders: Array<string | undefined>;
let headerRequests: Array<{ path: string; privateHeader?: string; contentType?: string }>;
const actualFetch = globalThis.fetch;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-oauth-contract-"));
  callbackPort = await freePort(); challenge = ""; requests = []; tokenRequests = []; resourceHeaders = []; headerRequests = [];
  server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    requests.push(path);
    headerRequests.push({ path, privateHeader: request.headers["x-private"] as string | undefined, contentType: request.headers["content-type"] });
    response.setHeader("content-type", "application/json");
    let body = ""; for await (const part of request) body += part.toString();
    if (path.startsWith("/.well-known/oauth-protected-resource")) response.end(JSON.stringify({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://auth.example.test"], scopes_supported: ["read"] }));
    else if (path === "/.well-known/oauth-authorization-server") response.end(JSON.stringify({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", registration_endpoint: "https://auth.example.test/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }));
    else if (path === "/register") response.end(JSON.stringify({ ...JSON.parse(body), client_id: "fixture-client" }));
    else if (path === "/token") {
      const params = new URLSearchParams(body); tokenRequests.push(params);
      if (params.get("grant_type") === "authorization_code") {
        expect(params.get("code")).toBe("fixture-code");
        expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(challenge);
        expect(params.get("redirect_uri")).toBe(`http://127.0.0.1:${callbackPort}/callback`);
      }
      response.end(JSON.stringify({ access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", token_type: "Bearer", expires_in: 3600, scope: "read" }));
    } else if (path === "/mcp") {
      resourceHeaders.push(request.headers.authorization);
      if (request.headers.authorization !== "Bearer fixture-access-secret") { response.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return; }
      if (!body) { response.writeHead(405).end(); return; }
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "fixture", version: "1" } } : { tools: [] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } else response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals(); records.clear(); cachedRecords.clear();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const environment = { AGENC_HOME: root, HOME: root };
  const home = resolveHomeContext(environment, { platformHome: root });
  const config = { type: "http" as const, url: "https://mcp.example.test/mcp", oauth: { callbackPort, scopes: ["read"] } };
  const fetchFn: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    expect(["auth.example.test", "mcp.example.test"]).toContain(url.hostname);
    return actualFetch(`${base}${url.pathname}${url.search}`, init);
  };
  return { home, config, environment, name: "fixture", fetchFn };
}

async function approve(url: string): Promise<boolean> {
  const parsed = new URL(url); challenge = parsed.searchParams.get("code_challenge")!;
  const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "fixture-code"); redirect.searchParams.set("state", "wrong-state");
  expect((await actualFetch(redirect)).status).toBe(400);
  redirect.searchParams.set("state", parsed.searchParams.get("state")!);
  expect((await actualFetch(redirect)).status).toBe(200);
  return true;
}

describe("MCP OAuth foundation", () => {
  test("completes discovery, DCR, state and PKCE exchange using only loopback fixtures", async () => {
    const options = fixture();
    await authenticateMcp({ ...options, openAuthorizationUrl: approve });
    expect(mcpOAuthAuthenticated(options.home, options.name, options.config)).toBe(true);
    expect(tokenRequests[0]?.get("resource")).toBe(options.config.url);
    expect(records.get(root)?.mcpOAuth?.[getServerKey(options.name, options.config)]?.refreshToken).toBe("fixture-refresh-secret");
    await expect(actualFetch(`http://127.0.0.1:${callbackPort}/callback`)).rejects.toThrow();
  });
  test("cancels pending authorization and closes the listener without storing tokens", async () => {
    const options = fixture(); const controller = new AbortController();
    await expect(authenticateMcp({ ...options, signal: controller.signal, openAuthorizationUrl: async () => { controller.abort(); return true; } })).rejects.toThrow("cancelled");
    expect(mcpOAuthAuthenticated(options.home, options.name, options.config)).toBe(false);
    await expect(actualFetch(`http://127.0.0.1:${callbackPort}/callback`)).rejects.toThrow();
  });
  test("times out, never exposing OAuth response bodies", async () => {
    await expect(authenticateMcp({ ...fixture(), timeoutMs: 50, openAuthorizationUrl: async () => true })).rejects.toThrow("timed out");
    const options = fixture();
    await expect(authenticateMcp({ ...options, fetchFn: async () => new Response('secret-response-token', { status: 500 }), openAuthorizationUrl: approve })).rejects.toThrow("MCP authentication failed.");
  });
  test("rejects denied consent without token exchange", async () => {
    const options = fixture();
    await expect(authenticateMcp({ ...options, openAuthorizationUrl: async (url) => {
      const auth = new URL(url); const redirect = new URL(auth.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", auth.searchParams.get("state")!); redirect.searchParams.set("error", "access_denied"); redirect.searchParams.set("error_description", "untrusted-secret-value");
      await actualFetch(redirect); return true;
    } })).rejects.toThrow("MCP authorization was not granted.");
    expect(tokenRequests).toHaveLength(0);
  });
  test("refreshes from native storage and stops authorizing existing HTTP clients after logout", async () => {
    const baseOptions = fixture();
    const options = { ...baseOptions, config: { ...baseOptions.config, headers: { "X-Private": "resource-private", "Content-Type": "application/json" } } };
    await authenticateMcp({ ...options, openAuthorizationUrl: approve });
    const key = getServerKey(options.name, options.config);
    records.get(root)!.mcpOAuth![key]!.expiresAt = Date.now() - 1000;
    vi.stubGlobal("fetch", options.fetchFn);
    const client = await createHttpMCPConnection({ name: options.name, endpoint: options.config.url, oauth: options.config.oauth, headers: options.config.headers }, undefined, undefined, undefined, options.environment);
    try {
      await client.listTools();
      expect(tokenRequests.some((params) => params.get("grant_type") === "refresh_token")).toBe(true);
      expect(resourceHeaders).toContain("Bearer fixture-access-secret");
      expect(headerRequests.filter((entry) => entry.path === "/mcp").some((entry) => entry.privateHeader === "resource-private")).toBe(true);
      expect(headerRequests.filter((entry) => entry.path !== "/mcp").every((entry) => entry.privateHeader === undefined)).toBe(true);
      expect(headerRequests.filter((entry) => entry.path === "/token").every((entry) => entry.contentType === "application/x-www-form-urlencoded")).toBe(true);
      const count = requests.filter((path) => path === "/register").length;
      // Another process can retain a macOS cached record for thirty seconds.
      cachedRecords.set(root, structuredClone(records.get(root)!));
      await new AgenCAuthProvider(options.home, options.name, options.config).invalidateCredentials("all");
      await expect(client.listTools()).rejects.toThrow();
      expect(resourceHeaders.at(-1)).toBeUndefined();
      expect(requests.filter((path) => path === "/register")).toHaveLength(count);
    } finally { await client.close(); }
  });
  test("binds credentials to endpoint, OAuth client and scopes and rejects late refresh after logout", async () => {
    const options = fixture(); await authenticateMcp({ ...options, openAuthorizationUrl: approve });
    expect(getServerKey("fixture", options.config)).not.toBe(getServerKey("fixture", { ...options.config, oauth: { ...options.config.oauth, clientId: "different" } }));
    const provider = runtimeMcpOAuthProvider(options.name, options.config.url, "http", options.config.oauth, options.environment);
    await provider.invalidateCredentials!("all");
    await expect(provider.saveTokens({ access_token: "late-secret", token_type: "Bearer" })).rejects.toThrow();
    expect(records.get(root)?.mcpOAuth?.[getServerKey(options.name, options.config)]).toBeUndefined();
  });
  test("rejects unsafe transport/authorization schemes and binds the captured home", async () => {
    const options = fixture();
    await expect(authenticateMcp({ ...options, config: { ...options.config, url: "http://mcp.example.test" } })).rejects.toThrow("HTTPS");
    expect(() => runtimeMcpOAuthProvider("fixture", options.config.url, "http", {}, {})).toThrow("bound AgenC home");
    const fetchSpy = vi.fn();
    await expect(mcpOAuthFetch({}, undefined, fetchSpy)("file:///tmp/secret")).rejects.toThrow("HTTPS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test.each([undefined, "", " \t "])("rejects an unbound or blank captured home (%s)", (configuredHome) => {
    const options = fixture();
    expect(() => runtimeMcpOAuthProvider(
      options.name,
      options.config.url,
      "http",
      options.config.oauth,
      { HOME: root, ...(configuredHome === undefined ? {} : { AGENC_HOME: configuredHome }) },
    )).toThrow("bound AgenC home");
    expect(records.size).toBe(0);
  });
  test("accepts an explicitly configured canonical default home", () => {
    const options = fixture();
    const environment = { HOME: root, AGENC_HOME: join(root, ".agenc") };
    expect(resolveHomeContext(environment, { platformHome: root })).toMatchObject({
      source: "agenc-home",
      isDefault: true,
    });
    expect(() => runtimeMcpOAuthProvider(
      options.name, options.config.url, "http", options.config.oauth, environment,
    )).not.toThrow();
    expect(records.size).toBe(0);
  });
  test("canonicalizes OAuth identity independently of object key order", () => {
    const config = fixture().config;
    expect(getServerKey("fixture", { ...config, headers: { A: "a", B: "b" }, oauth: { scopes: ["read"], clientId: "public", callbackPort } })).toBe(getServerKey("fixture", { ...config, headers: { B: "b", A: "a" }, oauth: { callbackPort, clientId: "public", scopes: ["read"] } }));
  });
  test("keeps transport streams caller-owned and does not leak resource headers to an OAuth origin", async () => {
    const captured: RequestInit[] = [];
    const fetchSpy = vi.fn(async (_input, init) => { captured.push(init); return new Response(new ReadableStream()); });
    const transport = mcpOAuthTransportFetch({}, fetchSpy, { endpoint: "https://mcp.example.test/mcp", headers: { "X-Private": "fixture-private", "Content-Type": "application/json" } });
    const controller = new AbortController();
    const response = await transport("https://mcp.example.test/mcp", { signal: controller.signal });
    expect(captured[0]?.signal).toBe(controller.signal);
    expect(new Headers(captured[0]?.headers).get("X-Private")).toBe("fixture-private");
    await transport("https://auth.example.test/token", { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic fixture-client-auth" } });
    expect(new Headers(captured[1]?.headers).has("X-Private")).toBe(false);
    expect(new Headers(captured[1]?.headers).get("Authorization")).toBe("Basic fixture-client-auth");
    expect(new Headers(captured[1]?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(captured[1]?.signal).toBeUndefined();
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(controller.signal.aborted).toBe(false);
    } finally { vi.useRealTimers(); }
    await response.body?.cancel();
  });
  test("a delayed refresh cannot resurrect logout or overwrite a subsequent login", async () => {
    const options = fixture(); await authenticateMcp({ ...options, openAuthorizationUrl: approve });
    const key = getServerKey(options.name, options.config);
    const firstGeneration = records.get(root)!.mcpOAuth![key]!.authorizationGeneration;
    records.get(root)!.mcpOAuth![key]!.expiresAt = Date.now() - 1000;
    let release!: () => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const delayedFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/token")) { started(); await pending; }
      return options.fetchFn(input, init);
    };
    vi.stubGlobal("fetch", delayedFetch);
    const runtime = runtimeMcpOAuthProvider(options.name, options.config.url, "http", options.config.oauth, options.environment);
    const result = runtime.tokens(); await requested;
    await new AgenCAuthProvider(options.home, options.name, options.config).invalidateCredentials("all");
    await expect(runtime.saveDiscoveryState!({ authorizationServerUrl: "https://auth.example.test" })).rejects.toThrow();
    expect(records.get(root)?.mcpOAuth?.[key]).toBeUndefined();
    const newLogin = new AgenCAuthProvider(options.home, options.name, options.config);
    await newLogin.saveTokens({ access_token: "new-login-secret", refresh_token: "new-refresh-secret", expires_in: 3600, token_type: "Bearer" });
    expect(records.get(root)!.mcpOAuth![key]!.authorizationGeneration).not.toBe(firstGeneration);
    release(); expect(await result).toBeUndefined();
    expect(records.get(root)!.mcpOAuth![key]!.accessToken).toBe("new-login-secret");
    await expect(runtime.saveTokens({ access_token: "old-sdk-refresh-secret", token_type: "Bearer" })).rejects.toThrow();
    await runtime.invalidateCredentials!("all");
    await runtime.invalidateCredentials!("tokens");
    expect(records.get(root)!.mcpOAuth![key]!.accessToken).toBe("new-login-secret");
  });
});
