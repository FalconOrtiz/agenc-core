import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

import type { CompactionTransactionMetadataV1 } from "../../src/services/compact/transaction-types.js";
import { compactConversationTransactionally } from "../../src/services/compact/transaction.js";
import type { RolloutStore } from "../../src/session/rollout-store.js";
import { bindCompactionTransactionHarness } from "./compaction-transaction-harness.js";

/** A per-test `AGENC_HOME` and the workspace a rollout store opens under it. */
export interface TemporaryAgencHome {
  /** The `AGENC_HOME` this test is running under. */
  readonly home: string;

  /** A workspace directory outside that home. */
  readonly workspace: string;
}

/**
 * Bind a per-test `AGENC_HOME` and workspace for a rollout scan test file.
 *
 * Scanner tests read and write session state under `AGENC_HOME`, so each test
 * needs its own home and the ambient one has to come back afterwards even when
 * the test throws. `mkdtemp` keeps the directories unique across parallel
 * Vitest workers.
 */
export function bindTemporaryAgencHome(prefix: string): TemporaryAgencHome {
  let home = "";
  let workspace = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
    workspace = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
    previousHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  return {
    get home(): string {
      return home;
    },
    get workspace(): string {
      return workspace;
    },
  };
}

/** What one whole-history compaction of a rollout store is asked for. */
export interface WholeHistoryCompactionRequest {
  /** The attempt id the prepared source is pinned to. */
  readonly attemptId: string;

  /** Instructions the summariser is given, so failures name their test. */
  readonly customInstructions: string;

  /** Large enough that the whole prepared history fits in one step. */
  readonly contextWindowTokens?: number;
}

/**
 * Commit one compaction of a store's whole prepared history through the real
 * transaction, and answer with what it committed.
 *
 * Scan tests need a rollout that actually carries a committed compaction, not
 * a hand-written approximation of one, so this drives the same code path a
 * session does and fails loudly when nothing committed.
 */
export async function commitWholeHistoryCompaction(
  store: RolloutStore,
  request: WholeHistoryCompactionRequest,
): Promise<CompactionTransactionMetadataV1> {
  const prepared = store.prepareSource(request.attemptId, []);
  const harness = bindCompactionTransactionHarness(store, {
    contextWindowTokens: request.contextWindowTokens ?? 64_000,
    maxOutputTokens: 512,
  });
  try {
    const result = await compactConversationTransactionally(harness.context, {
      customInstructions: request.customInstructions,
      automatic: false,
      messagesToKeep: [],
      completeSourceMessages: prepared.messages,
      messagesToSummarize: prepared.messages,
      summaryPlacement: "before_keep",
      createBoundaryMarker: () => ({
        role: "user",
        originalRole: "developer",
        content: "compaction boundary",
      }),
      createSummaryMessage: (content) => ({ role: "user", content }),
    });
    const transaction = result.transaction;
    if (transaction === undefined) {
      throw new Error("compaction did not commit a transaction");
    }
    return transaction;
  } finally {
    harness.close();
    store.flushDurable();
  }
}
