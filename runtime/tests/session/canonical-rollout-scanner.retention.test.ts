import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RolloutStore } from "../../src/session/rollout-store.js";
import { bindTemporaryAgencHome } from "../helpers/canonical-rollout-scan.js";

// #2229: the scanner keeps the prefix it validated so bookkeeping stops
// replaying the whole rollout. That moves cost into resident memory, so what
// a scanner holds between scans has to stay small next to the session it
// scans rather than growing with it.

const temporary = bindTemporaryAgencHome("agenc-c2-retain");

describe("canonical rollout scanner retention", () => {
  it("does not hold a session-sized copy of the history between scans", () => {
    const rolloutPath = writeLargeRollout("retention-heap");
    const rolloutBytes = statSync(rolloutPath).size;
    expect(rolloutBytes).toBeGreaterThan(4 * 1_024 * 1_024);
    const sessionTempRoot = join(temporary.home, "retention-scan-temp");
    mkdirSync(sessionTempRoot, { recursive: true });

    const evidence = measureRetainedHeap(rolloutPath, sessionTempRoot);

    expect(evidence.gcType).toBe("function");
    // Keeping the reduced history in the prefix costs about 1.2x the rollout;
    // releasing it leaves the registries and the lifecycle, which the
    // compaction budget already bounds.
    expect(evidence.retainedBytes).toBeLessThan(rolloutBytes / 4);
  }, 180_000);
});

function writeLargeRollout(sessionId: string): string {
  const store = new RolloutStore({
    cwd: temporary.workspace,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: join(temporary.home, "rollout-temp"),
    autoStartScheduler: false,
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: temporary.workspace,
    originator: "canonical-scanner-retention-test",
    agencVersion: "0.13.0",
  });
  try {
    for (let index = 0; index < 1_200; index += 1) {
      store.appendRollout({
        type: "response_item",
        payload: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `retained-${index}-${"x".repeat(4_096)}`,
        },
      });
    }
    store.flushDurable();
    return store.rolloutPath;
  } finally {
    store.close();
  }
}

interface RetentionEvidence {
  readonly gcType: string;
  readonly retainedBytes: number;
}

/** Heap held by a scanner after it answered a scan and the answer was dropped. */
function measureRetainedHeap(
  rolloutPath: string,
  sessionTempRoot: string,
): RetentionEvidence {
  const scannerUrl = new URL(
    "../../src/session/canonical-rollout-scanner.ts",
    import.meta.url,
  ).href;
  const childScript = `
    const { CanonicalRolloutScanner } = await import(${JSON.stringify(scannerUrl)});
    const { COMPACTION_SOURCE_DIGEST_DOMAIN } = await import(${JSON.stringify(
      new URL(
        "../../src/services/compact/transaction-types.ts",
        import.meta.url,
      ).href,
    )});
    const options = {
      sessionTempRoot: ${JSON.stringify(sessionTempRoot)},
      expectedRunId: "retention-heap",
      expectedEpoch: 1,
      maximumScanMilliseconds: 120000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    };
    const rolloutPath = ${JSON.stringify(rolloutPath)};
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) {
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return process.memoryUsage().heapUsed;
    };
    // Pay for the lazily loaded modules and their caches before the baseline,
    // so the difference is what this scanner kept and nothing else.
    const warmUp = new CanonicalRolloutScanner();
    warmUp.scan(rolloutPath, options);
    warmUp.close();
    const baseline = await settle();

    const scanner = new CanonicalRolloutScanner();
    let scan = scanner.scan(rolloutPath, options);
    if (scan.activeHistory.messages.length !== 1200) {
      throw new Error("unexpected active history length");
    }
    scan = undefined;
    const held = await settle();
    scanner.close();

    process.stdout.write(JSON.stringify({
      gcType: typeof globalThis.gc,
      retainedBytes: held - baseline,
    }));
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childScript,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      // Preserve the hermetic runner's reviewed NODE_OPTIONS preload so its
      // network tripwire also governs this focused child.
      env: process.env,
      timeout: 150_000,
    },
  );
  const diagnostics = [
    `status=${String(child.status)}`,
    `signal=${String(child.signal)}`,
    `error=${child.error?.stack ?? "none"}`,
    `stdout=${JSON.stringify(child.stdout)}`,
    `stderr=${JSON.stringify(child.stderr)}`,
  ].join("\n");
  expect(child.error, diagnostics).toBeUndefined();
  expect(child.signal, diagnostics).toBeNull();
  expect(child.status, diagnostics).toBe(0);
  try {
    return JSON.parse(child.stdout) as RetentionEvidence;
  } catch (error) {
    throw new Error(
      `retention child did not return valid evidence: ${
        error instanceof Error ? error.message : String(error)
      }\n${diagnostics}`,
    );
  }
}
