import type { JsonObject, JsonValue } from "../app-server/protocol/index.js";

function object(value: JsonValue | undefined): JsonObject | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function redact(value: JsonValue | undefined, depth = 0): JsonValue {
  if (depth > 8) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [key, /password|secret|token|credential|authorization|authcookie|api.?key|env(?:ironment)?/iu.test(key) ? "[redacted]" : redact(entry, depth + 1)]));
  return typeof value === "string" ? value.slice(0, 16_384) : value ?? null;
}

/** Bounded projection of canonical daemon permission events, shared across local and browser clients. */
export class RemoteApprovalProjection {
  readonly #pending = new Map<string, JsonObject>();
  observe(sessionId: string, event: JsonObject): void {
    const params = object(event.params);
    if (!params) return;
    if (event.method === "event.permission_request" && typeof params.requestId === "string") {
      const key = `${sessionId}\0${params.requestId}`;
      if (this.#pending.size >= 256 && !this.#pending.has(key)) return;
      this.#pending.set(key, { sessionId, requestId: params.requestId, toolName: typeof params.toolName === "string" ? params.toolName : "Tool", ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}), permissions: Array.isArray(params.permissions) ? params.permissions.filter((value) => typeof value === "string").slice(0, 32) : [], input: redact(params.input), ...(typeof params.reason === "string" ? { reason: params.reason.slice(0, 4096) } : {}) });
    } else if (event.method === "event.agent_status" && ["idle", "stopped", "error"].includes(String(params.status))) {
      for (const [key, item] of this.#pending) if (item.sessionId === sessionId) this.#pending.delete(key);
    } else if (event.method === "event.session_event") {
      const inner = object(params.event); const payload = object(inner?.payload);
      if (["permission_decision", "tool_call_completed"].includes(String(inner?.type)) && typeof payload?.callId === "string") this.resolve(sessionId, payload.callId);
    }
  }
  list(sessionId: string): readonly JsonObject[] { return [...this.#pending.values()].filter((item) => item.sessionId === sessionId).map((item) => structuredClone(item)); }
  resolve(sessionId: string, requestId: string): void { this.#pending.delete(`${sessionId}\0${requestId}`); }
  has(sessionId: string, requestId: string): boolean { return this.#pending.has(`${sessionId}\0${requestId}`); }
}
