import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  measureSerializedUtf8Bytes,
  serializedUtf8BytesOrZero,
} from "./serialization-size.js";
import { SessionStore } from "./session-store.js";

describe("serialized UTF-8 size", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["ASCII string", "plain text"],
    ["multibyte string", "雪だるま"],
    ["object", { ok: true, count: 2 }],
    ["null", null],
  ])("measures the compact JSON bytes for %s", (_label, value) => {
    const serialized = JSON.stringify(value);
    expect(serialized).toBeDefined();
    expect(measureSerializedUtf8Bytes(value)).toEqual({
      status: "measured",
      bytes: Buffer.byteLength(serialized!, "utf8"),
    });
  });

  test("classifies undefined without confusing it with a zero-byte value", () => {
    expect(measureSerializedUtf8Bytes(undefined)).toEqual({
      status: "unserializable",
      bytes: 0,
      reason: "json_stringify_returned_undefined",
    });
    expect(serializedUtf8BytesOrZero(undefined)).toBe(0);
    expect(measureSerializedUtf8Bytes("")).toEqual({
      status: "measured",
      bytes: 2,
    });
  });

  test("classifies circular data without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(measureSerializedUtf8Bytes(circular)).toEqual({
      status: "unserializable",
      bytes: 0,
      reason: "json_stringify_threw",
    });
    expect(serializedUtf8BytesOrZero(circular)).toBe(0);
  });

  test.each([
    ["string", "line one\n雪 \"quoted\""],
    ["object", { text: "雪", nested: { ok: true } }],
  ])("matches the persisted tool-result bytes for a %s", (_label, result) => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-size-persistence-"));
    temporaryDirectories.push(cwd);
    const sessionId = `session-${temporaryDirectories.length}`;
    const turnId = `turn-${temporaryDirectories.length}`;
    const store = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      agencHome: cwd,
    });
    store.open({
      sessionId,
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append(
      {
        id: `event-${temporaryDirectories.length}`,
        seq: 2,
        msg: {
          type: "tool_call_completed",
          payload: {
            callId: `call-${temporaryDirectories.length}`,
            result: result as string,
            isError: false,
          },
        },
      },
      { turnId },
    );

    const serializedResult = JSON.stringify(result);
    const measured = measureSerializedUtf8Bytes(result);
    expect(measured).toEqual({
      status: "measured",
      bytes: Buffer.byteLength(serializedResult, "utf8"),
    });
    expect(store.getToolResultBytes(turnId)).toBe(measured.bytes);
    store.close();

    const eventLine = readFileSync(store.rolloutPath, "utf8")
      .split("\n")
      .find((line) => line.includes('"type":"tool_call_completed"'));
    expect(eventLine).toContain(`"result":${serializedResult}`);
  });
});
