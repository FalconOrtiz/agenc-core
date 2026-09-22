import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { bridgeDaemonProxy, daemonProxyEnvironment, decodeDaemonProxyHome, parseAgenCDaemonProxyCliArgs } from "../../src/bin/daemon-proxy-cli.js";

function fixture() {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const forwarded: Record<string, unknown>[] = [];
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
    forwarded.push(JSON.parse(chunk.toString())); callback();
  } });
  let stdout = "", stderr = "";
  output.on("data", (chunk) => { stdout += String(chunk); });
  error.on("data", (chunk) => { stderr += String(chunk); });
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  const respond = (value: unknown) => socket.push(JSON.stringify(value) + "\n");
  return { input, output, error, socket, forwarded, send, respond, stdout: () => stdout, stderr: () => stderr };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const cookie = "a".repeat(64);

describe("daemon SSH proxy", () => {
  it("matches only the explicit daemon proxy command", () => {
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "status"])).toBeNull();
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio"])).toEqual({ mode: "stdio" });
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--unsafe"])).toBe("help");
  });
  it("decodes canonical shell-safe absolute homes for each remote platform", () => {
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    for (const [platform, path] of [["darwin", "/Users/test/Core home"], ["linux", "/home/test/core"], ["win32", "C:\\Users\\test\\Core home"], ["win32", "\\\\server\\share\\core"]] as const) {
      expect(decodeDaemonProxyHome(encode(path), platform)).toBe(path);
      expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--home-b64", encode(path)], platform)).toEqual({ mode: "stdio", coreHome: path });
    }
    for (const path of ["relative", "C:relative", "\\root-relative", "\\\\?\\C:\\core", "\\\\.\\pipe\\daemon", "//?/C:/core", "//./pipe/daemon", "\\/?\\C:\\core", "/\\.\\pipe\\daemon"]) expect(decodeDaemonProxyHome(encode(path), "win32")).toBeNull();
    for (const path of ["relative", "~/core", "/core\u0000", "/core\nother", "/" + "x".repeat(4097)]) expect(decodeDaemonProxyHome(encode(path), "linux")).toBeNull();
    for (const encoded of ["", "L2E=", "L2F", "L2E;echo", Buffer.from([0x2f, 0xff]).toString("base64url")]) expect(decodeDaemonProxyHome(encoded, "linux")).toBeNull();
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--home-b64", "invalid"], "linux")).toBe("help");
  });
  it("scopes the saved home to a fresh environment without mutating process state", () => {
    const original = { AGENC_HOME: "/original", PATH: "/bin" };
    expect(daemonProxyEnvironment(original, { mode: "stdio", coreHome: "/selected" })).toEqual({ AGENC_HOME: "/selected", PATH: "/bin" });
    expect(original.AGENC_HOME).toBe("/original");
    expect(daemonProxyEnvironment(original, { mode: "stdio" })).toEqual(original);
    expect(daemonProxyEnvironment(original, { mode: "stdio" })).not.toBe(original);
  });
  it("injects the remote local cookie without returning it and preserves responses/notifications", async () => {
    const f = fixture();
    const result = bridgeDaemonProxy(f.socket, cookie, f);
    f.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { authCookie: "client-forgery", clientName: "Desktop" } });
    expect(f.forwarded[0]).toMatchObject({ params: { authCookie: cookie } });
    f.respond({ jsonrpc: "2.0", id: 1, result: { protocol: { version: "1.2" } } });
    await flush();
    f.send({ jsonrpc: "2.0", id: 2, method: "session.list", params: {} });
    expect(f.forwarded[1]).toMatchObject({ method: "session.list" });
    f.respond({ jsonrpc: "2.0", id: 2, result: { sessions: [] } });
    f.respond({ jsonrpc: "2.0", method: "event.permission_request", params: { sessionId: "task-1", requestId: "request-1" } });
    await flush();
    f.input.end(); expect(await result).toBe(0);
    expect(f.stdout()).toContain("event.permission_request");
    expect(f.stdout()).not.toContain(cookie);
    expect(f.stderr()).toBe("");
  });
  it("requires initialization, rejects credential/settings methods, and bounds unterminated input", async () => {
    const before = fixture(); const beforeResult = bridgeDaemonProxy(before.socket, cookie, before);
    before.send({ jsonrpc: "2.0", id: 1, method: "session.list" });
    expect(before.forwarded).toHaveLength(0); expect(before.stdout()).toContain("Initialize");
    before.send({ jsonrpc: "2.0", id: 2, method: "auth.status" });
    expect(await beforeResult).toBe(1); expect(before.stderr()).toContain("REQUEST_DENIED");
    const large = fixture(); const largeResult = bridgeDaemonProxy(large.socket, cookie, large);
    large.input.write("x".repeat(1024 * 1024 + 1));
    expect(await largeResult).toBe(1); expect(large.stderr()).toContain("FRAME_LIMIT");
  });
  it("fails closed if the daemon echoes the cookie", async () => {
    const f = fixture(); const result = bridgeDaemonProxy(f.socket, cookie, f);
    f.respond({ jsonrpc: "2.0", id: 1, error: { message: cookie } });
    expect(await result).toBe(1); expect(f.stdout()).not.toContain(cookie); expect(f.stderr()).not.toContain(cookie);
  });
});
