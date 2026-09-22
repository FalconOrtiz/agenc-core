import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const meter = vi.hoisted(() => ({ bytes: 0, recording: false }));

// The scan's cost is the bytes it reads back off the rollout, so the contract
// is measured there rather than in wall-clock milliseconds.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const bytesRead = actual.readSync(...args);
      if (meter.recording) meter.bytes += bytesRead;
      return bytesRead;
    },
  };
});

import {
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  type CompactionPreparedSourceV1,
} from "../../src/services/compact/transaction-types.js";
import { scanCanonicalRollout } from "../../src/session/canonical-rollout-scanner.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { commitWholeHistoryCompaction } from "../helpers/canonical-rollout-scan.js";

let temporaryHome = "";
let previousHome: string | undefined;
let temporaryWorkspace = "";

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "agenc-scan-reuse-home-"));
  temporaryWorkspace = mkdtempSync(join(tmpdir(), "agenc-scan-reuse-work-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = temporaryHome;
  meter.bytes = 0;
  meter.recording = false;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(temporaryHome, { recursive: true, force: true });
  rmSync(temporaryWorkspace, { recursive: true, force: true });
});

describe("canonical rollout scan reuse", () => {
  it("does not read the prefix it already validated a second time", () => {
    const store = createStore("scan-reuse-prefix", 1_500);
    try {
      const size = statSync(store.rolloutPath).size;
      const cold = measure(() => store.prepareSource("cold-attempt", []));
      const warm = measure(() => store.prepareSource("warm-attempt", []));

      // Nothing was appended between the two, so the warm scan owes the file
      // one whole pass less: the prefix it already validated.
      expect(cold.bytes - warm.bytes).toBeGreaterThan(size * 0.9);
      expect(warm.value.messages).toEqual(cold.value.messages);
      expect(warm.value.source.history_digest).toBe(
        cold.value.source.history_digest,
      );
      expect(pinnedRows(warm.value)).toEqual(pinnedRows(cold.value));
    } finally {
      store.close();
    }
  });

  it("validates only what was appended since the last scan", () => {
    const store = createStore("scan-reuse-tail", 1_500);
    try {
      const cold = measure(() => store.prepareSource("cold-attempt", []));
      store.appendRollout(
        { type: "response_item", payload: { role: "user", content: "tail" } },
        { durable: true },
      );
      const size = statSync(store.rolloutPath).size;
      const grown = measure(() => store.prepareSource("grown-attempt", []));

      expect(cold.bytes - grown.bytes).toBeGreaterThan(size * 0.9);
      expect(grown.value.messages).toHaveLength(cold.value.messages.length + 1);
      expect(grown.value.messages.at(-1)?.content).toBe("tail");
    } finally {
      store.close();
    }
  });

  it("reads a compacted session a whole replay cheaper", async () => {
    const store = createStore("scan-reuse-compacted", 600);
    try {
      await commitWholeHistory(store, "compacted-attempt");
      // One scan to take in the compaction's own tail: the claim below is
      // about what the scans after that owe the file.
      store.prepareSource("settle-attempt", []);
      const size = statSync(store.rolloutPath).size;
      // What this scan costs without a validated prefix, on these exact
      // bytes: the two passes every scan owed before #2229.
      const replay = measure(() =>
        scanCanonicalRollout(
          store.rolloutPath,
          fullReplayOptions("scan-reuse-compacted"),
        ),
      );
      const warm = measure(() => store.prepareSource("warm-attempt", []));

      // The rollout really carries a committed compaction, and the prepared
      // source is the history that compaction left active.
      expect(replay.value.attempts.size).toBe(1);
      expect(warm.value.messages.length).toBe(
        replay.value.activeHistory?.messages.length,
      );
      expect(warm.value.messages.length).toBeLessThan(600);
      expect(replay.bytes - warm.bytes).toBeGreaterThan(size * 0.9);
    } finally {
      store.close();
    }
  }, 180_000);

  it("replays a compacted session past the retention ceiling", async () => {
    const store = createStore("scan-reuse-ceiling", 200);
    try {
      await commitWholeHistory(store, "ceiling-attempt");
      // Active history back over MAX_RETAINED_PREFIX_BYTES: past the ceiling
      // a prefix answers its scan and is released, so the next scan replays.
      appendRows(store, 1_200, 4_096);
      const size = statSync(store.rolloutPath).size;
      const replay = measure(() =>
        scanCanonicalRollout(
          store.rolloutPath,
          fullReplayOptions("scan-reuse-ceiling"),
        ),
      );
      const first = measure(() => store.prepareSource("first-attempt", []));
      const second = measure(() => store.prepareSource("second-attempt", []));

      // The same shape saves a whole replay below the ceiling, one test up.
      // What is different here is only how much history the scan reduces.
      const active = replay.value.activeHistory?.messages.length;
      expect(replay.value.attempts.size).toBe(1);
      expect(active).toBeGreaterThan(1_200);
      expect(replay.bytes - second.bytes).toBeLessThan(size * 0.1);
      // No regression either: what the released prefix costs is a replay, and
      // a replay answers exactly what the full scan of the same bytes does.
      expect(second.value.messages.length).toBe(active);
      expect(second.value.messages).toEqual(first.value.messages);
      expect(second.value.source.history_digest).toBe(
        first.value.source.history_digest,
      );
      expect(pinnedRows(second.value)).toEqual(pinnedRows(first.value));
    } finally {
      store.close();
    }
  }, 180_000);

  it("rejects a rollout whose validated prefix changed underneath it", () => {
    const store = createStore("scan-reuse-corruption", 200);
    try {
      const cold = store.prepareSource("cold-attempt", []);
      expect(cold.messages.length).toBeGreaterThan(0);
      overwriteInPlace(store.rolloutPath, "row-0007-", "row-9999-");

      // The second pass rereads the whole file every time, so its digest still
      // has to match the prefix the scanner carried over.
      expect(() => store.prepareSource("poisoned-attempt", [])).toThrow(
        /does not match its durable binding/i,
      );
    } finally {
      store.close();
    }
  });
});

/** The scan `prepareSource` asks for, without a scanner to reuse a prefix. */
function fullReplayOptions(sessionId: string) {
  return {
    sessionTempRoot: join(temporaryHome, "rollout-temp"),
    expectedRunId: sessionId,
    expectedEpoch: 1,
    maximumScanMilliseconds: 120_000,
    compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    captureActiveHistory: true,
  } as const;
}

/** Commit one whole-history compaction through the real transaction. */
async function commitWholeHistory(
  store: RolloutStore,
  attemptId: string,
): Promise<void> {
  await commitWholeHistoryCompaction(store, {
    attemptId,
    customInstructions: "canonical scan reuse",
    contextWindowTokens: 2_000_000,
  });
}

function appendRows(store: RolloutStore, rows: number, fill: number): void {
  for (let index = 0; index < rows; index += 1) {
    store.appendRollout({
      type: "response_item",
      payload: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `grown-${String(index).padStart(4, "0")}-${"x".repeat(fill)}`,
      },
    });
  }
  store.flushDurable();
}

function createStore(sessionId: string, rows: number): RolloutStore {
  const store = new RolloutStore({
    cwd: temporaryWorkspace,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: join(temporaryHome, "rollout-temp"),
    autoStartScheduler: false,
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: temporaryWorkspace,
    originator: "canonical-scan-reuse-test",
    agencVersion: "0.13.0",
  });
  for (let index = 0; index < rows; index += 1) {
    store.appendRollout({
      type: "response_item",
      payload: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `row-${String(index).padStart(4, "0")}-${"x".repeat(1_024)}`,
      },
    });
  }
  store.flushDurable();
  return store;
}

/** The pinned source rows, minus the per-attempt ref ids. */
function pinnedRows(
  prepared: CompactionPreparedSourceV1,
): readonly (readonly [number, string])[] {
  return prepared.source.active_history_refs.map(
    (ref) => [ref.first_sequence, ref.sha256] as const,
  );
}

function measure<T>(operation: () => T): { value: T; bytes: number } {
  meter.bytes = 0;
  meter.recording = true;
  try {
    return { value: operation(), bytes: meter.bytes };
  } finally {
    meter.recording = false;
  }
}

/** Replace one already-validated record's bytes without changing the length. */
function overwriteInPlace(path: string, find: string, replace: string): void {
  if (find.length !== replace.length) {
    throw new Error("in-place overwrite must preserve the record length");
  }
  const bytes = readFileSync(path);
  const offset = bytes.indexOf(find);
  if (offset === -1) throw new Error(`rollout has no ${find} record`);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from(replace, "utf8"), 0, replace.length, offset);
  } finally {
    closeSync(fd);
  }
}
