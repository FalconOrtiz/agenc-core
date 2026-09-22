import { describe, expect, it, vi } from "vitest";
import { createRemoteBackend } from "../../src/remote/backend.js";

describe("browser remote host backend", () => {
  it("does not read credentials or fetch until pairing is explicitly started", async () => {
    const token = vi.fn(() => undefined); const network = vi.fn();
    const backend = createRemoteBackend({ backendUrl: "https://identity.example", token, fetch: network });
    expect(token).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    await expect(backend.start({ machineName: "Computer", role: "view", workspaceIds: ["opaque"] }, new AbortController().signal)).rejects.toMatchObject({ code: "REMOTE_LOGIN_REQUIRED" });
    expect(network).not.toHaveBeenCalled();
  });
  it("keeps an invalid optional remote URL from breaking ordinary daemon construction", async () => {
    const token = vi.fn(() => "fixture-bearer"); const network = vi.fn();
    const backend = createRemoteBackend({ backendUrl: "http://localhost:1234", token, fetch: network });
    await expect(backend.start({ machineName: "Computer", role: "view", workspaceIds: ["opaque"] }, new AbortController().signal)).rejects.toMatchObject({ code: "REMOTE_BACKEND_INVALID" });
    expect(network).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });
  it("uses only browser endpoints, an authorization header and abortable no-redirect requests", async () => {
    const result = { pairingId: "pair", hostSecret: "fixture-host-secret", code: "CODE", pairUrl: "https://connect.example/#CODE", expiresAt: new Date(Date.now() + 180_000).toISOString(), relayUrl: "wss://relay.example" };
    const network = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
    const backend = createRemoteBackend({ backendUrl: "https://identity.example", token: () => "fixture-bearer", fetch: network });
    await backend.start({ machineName: "Computer", role: "view", workspaceIds: ["opaque"] }, new AbortController().signal);
    expect(String(network.mock.calls[0]?.[0])).toBe("https://identity.example/v1/browser-pair/start");
    expect(network.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer fixture-bearer" }, signal: expect.any(AbortSignal) });
  });
});
