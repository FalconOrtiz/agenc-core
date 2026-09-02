import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";

/**
 * Regression for #2032: mountRolloutStore wires diagnostics to session.emit,
 * which appends a live-sequenced event. Emitting that channel mid-flush
 * (before pending is drained) joins the diagnostic to the in-flight batch and
 * can corrupt the canonical journal sequence.
 */
describe("session-store flush diagnostic reentry (#2032)", () => {
  let home = "";
  let origHome = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-flush-diag-"));
    origHome = process.env.AGENC_HOME ?? "";
    process.env.AGENC_HOME = home;
  });
  afterEach(() => {
    if (origHome) process.env.AGENC_HOME = origHome;
    else delete process.env.AGENC_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function openStore(sessionId: string): SessionStore {
    const store = new SessionStore({
      cwd: `/home/${sessionId}`,
      sessionId,
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: `/home/${sessionId}`,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    return store;
  }

  function wireLiveSequencedDiagnostic(
    store: SessionStore,
    nextSeq: { value: number },
    onCause?: (cause: string) => void,
  ): void {
    store.setDiagnosticListener((d) => {
      onCause?.(d.cause);
      nextSeq.value += 1;
      store.append({
        id: `live-diag-${nextSeq.value}`,
        seq: nextSeq.value,
        msg: {
          type: "warning",
          payload: {
            cause: d.cause,
            message: `live-${d.cause}`,
          },
        },
      });
    });
  }

  function liveDiagIds(store: SessionStore): string[] {
    return readFileSync(store.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string; payload?: { id?: string; seq?: number } })
      .filter(
        (line) =>
          line.type === "event_msg" &&
          typeof line.payload?.seq === "number" &&
          typeof line.payload?.id === "string" &&
          line.payload.id.startsWith("live-diag-"),
      )
      .map((line) => line.payload!.id as string);
  }

  test("I-83 flush diagnostic does not join the in-flight batch", () => {
    const store = openStore("sess-2032-i83");
    const nextSeq = { value: 0 };

    store.append({
      id: "queued-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: { cause: "queued", message: "before-suspend" },
      },
    });
    nextSeq.value = 1;
    wireLiveSequencedDiagnostic(store, nextSeq);

    (
      store as unknown as { batchOpenedAtMs: number | null }
    ).batchOpenedAtMs = -1_000_000;

    store.flushBatch(false);

    const afterFlush = readFileSync(store.rolloutPath, "utf8");
    expect(liveDiagIds(store)).toEqual([]);
    expect(afterFlush).toContain("event_log_batch_delayed");
    expect(afterFlush).toContain("before-suspend");

    store.flushBatch(false);
    expect(liveDiagIds(store)).toEqual(["live-diag-2"]);
    store.close();
  });

  test("rollout_degraded flush diagnostic does not join the failed batch", () => {
    const store = openStore("sess-2032-degraded");
    const nextSeq = { value: 1 };
    const committedPrefix = readFileSync(store.rolloutPath, "utf8");
    const delivered: string[] = [];

    wireLiveSequencedDiagnostic(store, nextSeq, (cause) => {
      delivered.push(cause);
    });
    store.setWriteImplForTest(() => {
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    });

    expect(
      store.append(
        {
          id: "durable-1",
          seq: 1,
          msg: {
            type: "turn_complete",
            payload: { turnId: "t-2032" },
          },
        },
        { durable: true },
      ),
    ).toBe(false);

    expect(readFileSync(store.rolloutPath, "utf8")).toBe(committedPrefix);
    expect(liveDiagIds(store)).toEqual([]);
    expect(store.isDegraded).toBe(true);
    expect(delivered).toContain("rollout_degraded");

    store.setWriteImplForTest((fd, buffer, offset, length) =>
      writeSync(fd, buffer, offset, length),
    );
    store.flushBatch(false);
    expect(liveDiagIds(store)).toEqual(["live-diag-2"]);
    store.close();
  });
});
