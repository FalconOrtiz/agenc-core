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
 *
 * Invariant: a diagnostic raised during a flush must not land in the batch
 * that flush is writing.
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

  function wireLiveSequencedDiagnostic(store: SessionStore, nextSeq: {
    value: number;
  }): void {
    store.setDiagnosticListener((d) => {
      nextSeq.value += 1;
      store.append({
        id: `live-diag-${nextSeq.value}`,
        seq: nextSeq.value,
        msg: {
          type: d.level,
          payload: {
            cause: d.cause,
            message: `live-${d.cause}`,
          },
        },
      });
    });
  }

  function rolloutLines(store: SessionStore): Array<Record<string, unknown>> {
    return readFileSync(store.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function sequencedDiagnosticIds(
    lines: Array<Record<string, unknown>>,
  ): string[] {
    return lines
      .filter((line) => line.type === "event_msg")
      .map((line) => line.payload as { id?: string; seq?: number })
      .filter(
        (payload) =>
          typeof payload.seq === "number" &&
          typeof payload.id === "string" &&
          payload.id.startsWith("live-diag-"),
      )
      .map((payload) => payload.id as string);
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

    const afterFlush = rolloutLines(store);
    expect(sequencedDiagnosticIds(afterFlush)).toEqual([]);
    expect(JSON.stringify(afterFlush)).toContain("event_log_batch_delayed");
    expect(JSON.stringify(afterFlush)).toContain("before-suspend");

    store.flushBatch(false);
    const afterDrain = rolloutLines(store);
    expect(sequencedDiagnosticIds(afterDrain)).toEqual(["live-diag-2"]);
    store.close();
  });

  test("rollout_degraded flush diagnostic does not join the failed batch", () => {
    const store = openStore("sess-2032-degraded");
    const nextSeq = { value: 1 };
    const committedPrefix = readFileSync(store.rolloutPath, "utf8");
    const delivered: string[] = [];

    store.setDiagnosticListener((d) => {
      delivered.push(d.cause);
      nextSeq.value += 1;
      // Non-durable warning mirrors a sequenced live append without nested
      // durable flush against the still-failing write seam.
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
    expect(sequencedDiagnosticIds(rolloutLines(store))).toEqual([]);
    expect(store.isDegraded).toBe(true);
    expect(delivered).toContain("rollout_degraded");

    store.setWriteImplForTest((fd, buffer, offset, length) =>
      writeSync(fd, buffer, offset, length),
    );
    store.flushBatch(false);
    const afterDrain = rolloutLines(store);
    expect(sequencedDiagnosticIds(afterDrain)).toEqual(["live-diag-2"]);
    store.close();
  });
});