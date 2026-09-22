import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HomeContext } from "../../config/home.js";
import { assertMcpOAuthHttpsUrl, type McpOAuthConfig } from "../../config/mcp-oauth.js";
import type { ProviderEnvironment } from "../../llm/provider-options.js";
import { openBrowser } from "../../utils/browser.js";
import { getProxyFetchOptions } from "../../utils/proxy.js";
import { captureSecureStorageIngress } from "../../utils/secureStorage/home.js";
import { readNativeSecureStorage } from "../../utils/secureStorage/native.js";
import { AgenCAuthProvider, getServerKey } from "./auth.js";
import type { McpHTTPServerConfig, McpSSEServerConfig } from "./types.js";
import { McpAuthenticationError } from "./auth-errors.js";
export { McpAuthenticationError } from "./auth-errors.js";

type RemoteConfig = McpHTTPServerConfig | McpSSEServerConfig;

export function mcpOAuthFetch(environment: ProviderEnvironment, signal?: AbortSignal, fetchFn: FetchLike = fetch): FetchLike {
  const proxy = getProxyFetchOptions({ environment });
  return async (input, init) => {
    assertMcpOAuthHttpsUrl(input);
    const signals = [AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])];
    // Redirects must not send a token/client secret to another origin or downgrade TLS.
    return fetchFn(input, { ...proxy, ...init, redirect: "error", signal: AbortSignal.any(signals) });
  };
}

/** MCP responses may be long-lived streams. Their lifetime belongs to the SDK caller. */
export function mcpOAuthTransportFetch(environment: ProviderEnvironment, fetchFn: FetchLike = fetch, resource?: { endpoint: string; headers?: Readonly<Record<string, string>> }): FetchLike {
  const proxy = getProxyFetchOptions({ environment });
  return async (input, init) => {
    const target = assertMcpOAuthHttpsUrl(input);
    const headers = new Headers(init?.headers);
    if (resource && target.origin === new URL(resource.endpoint).origin) {
      for (const [key, value] of Object.entries(resource.headers ?? {})) {
        if (!headers.has(key)) headers.set(key, value);
      }
    }
    return fetchFn(input, { ...proxy, ...init, headers, redirect: "error" });
  };
}

class RuntimeOAuthProvider extends AgenCAuthProvider {
  override async clientInformation() {
    const value = await super.clientInformation();
    if (!value) throw new McpAuthenticationError("MCP server needs authentication. Connect it in Plugins.");
    return value;
  }
  override async redirectToAuthorization(): Promise<void> {
    await this.invalidateCredentials("tokens");
    throw new McpAuthenticationError("MCP server needs authentication. Connect it in Plugins.");
  }
}

export function runtimeMcpOAuthProvider(
  name: string,
  endpoint: string,
  type: "http" | "sse",
  oauth: McpOAuthConfig,
  environment: ProviderEnvironment,
  headers?: Readonly<Record<string, string>>,
): OAuthClientProvider {
  assertMcpOAuthHttpsUrl(endpoint);
  if (Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization")) throw new McpAuthenticationError("OAuth cannot be combined with an Authorization header.");
  const { home } = captureSecureStorageIngress(environment);
  if (home.source !== "agenc-home") throw new McpAuthenticationError("MCP OAuth requires a bound AgenC home.");
  const { scopes, ...publicOptions } = oauth;
  const config: RemoteConfig = { type, url: endpoint, ...(headers ? { headers: { ...headers } } : {}), oauth: { ...publicOptions, ...(scopes ? { scopes: [...scopes] } : {}) } };
  return new RuntimeOAuthProvider(home, name, config, environment, mcpOAuthFetch(environment), true);
}

/** This read does not refresh, connect or manufacture an authenticated state. */
export function mcpOAuthAuthenticated(home: HomeContext, name: string, config: RemoteConfig): boolean {
  const record = readNativeSecureStorage(home).mcpOAuth?.[getServerKey(name, config)];
  return !!record?.accessToken && (record.expiresAt > Date.now() || !!record.refreshToken);
}

export interface AuthenticateMcpOptions {
  readonly home: HomeContext;
  readonly name: string;
  readonly config: RemoteConfig;
  readonly environment: ProviderEnvironment;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Test/embedding seams. Production always uses native secure storage. */
  readonly openAuthorizationUrl?: (url: string) => Promise<boolean>;
  readonly fetchFn?: FetchLike;
}

export async function authenticateMcp(options: AuthenticateMcpOptions): Promise<void> {
  const { config, name, home, environment } = options;
  assertMcpOAuthHttpsUrl(config.url);
  if (config.oauth === undefined || config.oauth.xaa) throw new McpAuthenticationError("This MCP server does not support standard OAuth authentication.");
  const controller = new AbortController();
  const onAbort = () => controller.abort(new McpAuthenticationError("MCP authentication cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new McpAuthenticationError("MCP authentication timed out. Try again.")), options.timeoutMs ?? 120_000);
  const signal = controller.signal;
  const port = config.oauth.callbackPort ?? 3118;
  const redirect = `http://127.0.0.1:${port}/callback`;
  let acceptCode!: (code: string) => void;
  let failCode!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => { acceptCode = resolve; failCode = reject; });
  // Cancellation can arrive while discovery is pending, before callback is awaited.
  void callback.catch(() => {});
  let consumed = false;
  const abortCallback = () => failCode(signal.reason as Error);
  signal.addEventListener("abort", abortCallback, { once: true });
  const fetchFn = mcpOAuthFetch(environment, signal, options.fetchFn);
  class InteractiveProvider extends AgenCAuthProvider {
    override get redirectUrl(): string { return redirect; }
    // Do not claim a hosted CIMD document whose redirect URIs were not verified.
    override get clientMetadataUrl(): undefined { return undefined; }
    override get clientMetadata(): OAuthClientMetadata {
      const { scope: _scope, ...metadata } = super.clientMetadata;
      return { ...metadata, redirect_uris: [redirect], ...(config.oauth?.scopes ? { scope: config.oauth.scopes.join(" ") } : {}) };
    }
    override async saveTokens(tokens: OAuthTokens, expected?: Parameters<AgenCAuthProvider["saveTokens"]>[1]): Promise<void> {
      signal.throwIfAborted();
      await super.saveTokens(tokens, expected);
    }
    override async redirectToAuthorization(url: URL): Promise<void> {
      assertMcpOAuthHttpsUrl(url);
      const expectedChallenge = createHash("sha256").update(await this.codeVerifier()).digest("base64url");
      if (url.searchParams.get("redirect_uri") !== redirect || url.searchParams.get("state") !== await this.state() || url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" || url.searchParams.get("code_challenge") !== expectedChallenge) {
        throw new McpAuthenticationError("The OAuth provider returned an unsafe authorization request.");
      }
      signal.throwIfAborted();
      if (!await (options.openAuthorizationUrl ?? openBrowser)(url.toString())) throw new McpAuthenticationError("Could not open the browser for MCP authentication.");
    }
  }
  const provider = new InteractiveProvider(home, name, config, environment, fetchFn);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}` || (request.url?.length ?? 0) > 8192) { response.writeHead(400).end("Invalid callback."); return; }
    const url = new URL(request.url ?? "/", redirect);
    if (url.pathname !== "/callback" || consumed) { response.writeHead(404).end("Not found."); return; }
    const expected = Buffer.from(await provider.state());
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    if (url.searchParams.getAll("state").length !== 1 || expected.length !== received.length || !timingSafeEqual(expected, received)) { response.writeHead(400).end("Invalid OAuth state."); return; }
    if (url.searchParams.has("error")) {
      consumed = true;
      response.writeHead(400).end("Authorization was not granted. Return to AgenC.");
      failCode(new McpAuthenticationError("MCP authorization was not granted."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096 || url.searchParams.getAll("code").length !== 1) { response.writeHead(400).end("Invalid authorization code."); return; }
    consumed = true;
    response.end("Authorization received. Return to AgenC to finish connecting.");
    acceptCode(code);
  });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
    const args = { serverUrl: config.url, fetchFn, ...(config.oauth.scopes ? { scope: config.oauth.scopes.join(" ") } : {}) };
    const result = await auth(provider, args);
    if (result === "REDIRECT") {
      const authorizationCode = await callback;
      signal.throwIfAborted();
      if (await auth(provider, { ...args, authorizationCode }) !== "AUTHORIZED") throw new McpAuthenticationError();
    }
    signal.throwIfAborted();
    if (!mcpOAuthAuthenticated(home, name, config)) throw new McpAuthenticationError();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof McpAuthenticationError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") throw new McpAuthenticationError("MCP OAuth callback port is busy. Close the other login and try again.");
    throw new McpAuthenticationError();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    signal.removeEventListener("abort", abortCallback);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
