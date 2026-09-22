#!/usr/bin/env node
/** Actual-daemon contract smoke. Private state, no credentials, no Telegram calls. */
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTuiGateState, startTuiGateDaemon, teardownTuiGateState, installTuiGateSignalHandlers } from "./tui-gate-state.mjs";
import { resolveDaemonSocketPath } from "../../packages/agenc-sdk/dist/socket.js";

const executable = fileURLToPath(new URL("../dist/bin/agenc.js", import.meta.url));
const state = await createTuiGateState({ prefix: "telegram-agents-smoke-" });
const removeHandlers = installTuiGateSignalHandlers(() => teardownTuiGateState(state, executable));
let socket;
try {
  const corruptState = process.argv.includes("--corrupt-state");
  const metadataPath = join(state.agencHome, "gateway", "telegram-agents.json");
  if (corruptState) {
    await mkdir(join(state.agencHome, "gateway"), { recursive: true, mode: 0o700 });
    await writeFile(metadataPath, "{ invalid fixture", { mode: 0o600 });
  }
  await startTuiGateDaemon(state, executable);
  const cookie = (await readFile(join(state.agencHome, "daemon.cookie"), "utf8")).trim();
  socket = connect(resolveDaemonSocketPath(state.env, state.agencHome, process.platform));
  const pending = new Map(); let sequence = 0; let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line); const handler = pending.get(response.id);
      if (handler) { pending.delete(response.id); clearTimeout(handler.timer); handler.resolve(response); }
    }
  });
  socket.on("error", (error) => { for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(error); } pending.clear(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const initialized = await rpc("initialize", { protocol: { version: "1.10.0" }, authCookie: cookie });
  assert.equal(initialized.error, undefined);
  if (corruptState) {
    assert.equal(initialized.result.capabilities["daemon.methods"]["telegram.agents.list"], false);
    assert.equal((await rpc("telegram.agents.list")).error?.code, -32601);
    assert.equal((await rpc("health.ping")).error, undefined);
    assert.equal(await readFile(metadataPath, "utf8"), "{ invalid fixture");
    console.log("[Telegram agents smoke] PASS: malformed metadata disables only Telegram management; Core stays healthy and preserves the file.");
  } else {
  assert.equal(initialized.result.capabilities["daemon.methods"]["telegram.agents.pair.confirm"], true);
  const capabilities = await rpc("telegram.capabilities");
  assert.equal(capabilities.result.contractVersion, 2);
  assert.equal(capabilities.result.multiAgent, true);
  assert.equal(capabilities.result.accountLinking, "local-confirmation");
  assert.equal(capabilities.result.approvals, "host-only");
  assert.deepEqual((await rpc("telegram.agents.list")).result, { agents: [] });
  for (const action of ["start", "stop", "remove", "update", "pair.begin", "pair.confirm", "pair.cancel"]) {
    const result = await rpc(`telegram.agents.${action}`, { agentId: "unknown-fixture-agent", challengeId: "unknown-challenge" });
    assert.equal(result.error?.data?.code, "TELEGRAM_AGENT_NOT_FOUND", action);
  }
  assert.equal((await rpc("telegram.agents.create", { name: "", token: "invalid", workspacePath: state.root })).error?.data?.code, "TELEGRAM_CONFIG_INVALID");
  assert.deepEqual((await rpc("telegram.agents.list")).result, { agents: [] });
  console.log("[Telegram agents smoke] PASS: authenticated v2 capabilities, empty catalog, seven unknown-agent checks, invalid creation; no credentials or Telegram traffic.");
  }
} finally {
  socket?.destroy();
  await teardownTuiGateState(state, executable);
  removeHandlers();
  console.log("[Telegram agents smoke] Owned daemon stopped and temporary state removed.");
}
