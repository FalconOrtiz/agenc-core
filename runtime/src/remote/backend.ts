import { RemoteError, type RemoteBackend, type RemoteBackendPair, type RemoteBackendPoll } from "./types.js";

/** Credentials remain in Core. No account session is returned to a browser. */
export function createRemoteBackend(options: { backendUrl: string; token: () => string | undefined; fetch?: typeof fetch }): RemoteBackend {
  const request = async (endpoint: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    let url: URL;
    try { url = new URL(options.backendUrl); } catch { throw new RemoteError("REMOTE_BACKEND_INVALID"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new RemoteError("REMOTE_BACKEND_INVALID");
    const token = options.token();
    if (!token) throw new RemoteError("REMOTE_LOGIN_REQUIRED");
    const response = await (options.fetch ?? fetch)(new URL(`/v1/browser-pair/${endpoint}`, url), {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new RemoteError(response.status === 401 ? "REMOTE_LOGIN_REQUIRED" : response.status === 404 ? "REMOTE_BACKEND_UNAVAILABLE" : "REMOTE_BACKEND_ERROR");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 64 * 1024) { await reader.cancel(); throw new RemoteError("REMOTE_BACKEND_INVALID_RESPONSE"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text); } catch { throw new RemoteError("REMOTE_BACKEND_INVALID_RESPONSE"); }
  };
  const credentials = (pair: RemoteBackendPair) => ({ pairingId: pair.pairingId, hostSecret: pair.hostSecret });
  const poll = (value: unknown): RemoteBackendPoll => {
    const result = value as RemoteBackendPoll;
    if (!result || typeof result.pairingId !== "string" || !["pending", "claimed", "active", "revoked", "expired"].includes(result.status) || (result.device !== null && (!result.device || typeof result.device.deviceId !== "string" || typeof result.device.label !== "string" || !["view", "control"].includes(result.device.role) || !Array.isArray(result.device.workspaceIds)))) throw new RemoteError("REMOTE_BACKEND_INVALID_RESPONSE");
    return result;
  };
  return {
    async start(params, signal) {
      const value = await request("start", params, signal) as RemoteBackendPair;
      if (!value || ["pairingId", "hostSecret", "code", "pairUrl", "expiresAt", "relayUrl"].some((key) => typeof value[key as keyof RemoteBackendPair] !== "string") || !Number.isFinite(Date.parse(value.expiresAt))) throw new RemoteError("REMOTE_BACKEND_INVALID_RESPONSE");
      const relay = new URL(value.relayUrl); const pair = new URL(value.pairUrl);
      if (relay.protocol !== "wss:" || pair.protocol !== "https:" || relay.username || relay.password || pair.username || pair.password) throw new RemoteError("REMOTE_BACKEND_INVALID_RESPONSE");
      return value;
    },
    async poll(pair, signal) { return poll(await request("host-poll", credentials(pair), signal)); },
    async approve(pair, deviceId, signal) { return poll(await request("approve", { ...credentials(pair), deviceId }, signal)); },
    async revoke(pair, signal) { await request("revoke", credentials(pair), signal); },
  };
}
