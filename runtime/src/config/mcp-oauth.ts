/** Public OAuth metadata only. Client secrets and tokens belong in native storage. */
export interface McpOAuthConfig {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly authServerMetadataUrl?: string;
  readonly callbackPort?: number;
  readonly xaa?: boolean;
}

export function validateMcpOAuthConfig(value: unknown): McpOAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP OAuth configuration must be an object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["clientId", "scopes", "authServerMetadataUrl", "callbackPort", "xaa"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("MCP OAuth configuration contains an unsupported field");
  if (raw.clientId !== undefined && (typeof raw.clientId !== "string" || raw.clientId.length === 0 || raw.clientId.length > 2048 || /[\r\n\0]/u.test(raw.clientId))) throw new Error("MCP OAuth client ID is invalid");
  if (raw.scopes !== undefined && (!Array.isArray(raw.scopes) || raw.scopes.length > 64 || raw.scopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(scope)))) throw new Error("MCP OAuth scopes must be a list of valid scope names");
  if (raw.authServerMetadataUrl !== undefined) {
    if (typeof raw.authServerMetadataUrl !== "string") throw new Error("MCP OAuth metadata URL must use HTTPS");
    assertMcpOAuthHttpsUrl(raw.authServerMetadataUrl);
  }
  if (raw.callbackPort !== undefined && (typeof raw.callbackPort !== "number" || !Number.isInteger(raw.callbackPort) || raw.callbackPort < 1024 || raw.callbackPort > 65535)) throw new Error("MCP OAuth callback port must be between 1024 and 65535");
  if (raw.xaa !== undefined && typeof raw.xaa !== "boolean") throw new Error("MCP OAuth XAA must be boolean");
  return Object.freeze({ ...raw, ...(raw.scopes === undefined ? {} : { scopes: Object.freeze([...raw.scopes as string[]]) }) }) as McpOAuthConfig;
}

export function assertMcpOAuthHttpsUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MCP OAuth URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("MCP OAuth URLs must use HTTPS without embedded credentials or fragments");
  return url;
}
