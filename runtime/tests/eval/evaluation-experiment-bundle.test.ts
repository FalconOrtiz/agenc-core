import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendEvidenceEvent,
  computePairedTfrEffect,
  computeRepositoryClusteredPercentileInterval,
  computePlannedExecutionOrderDigest,
  compareUtcTimestamps,
  deriveExperimentSummary,
  digestCanonicalJson,
  derivePlannedExecutionOrder,
  initializeEvidenceLedger,
  sealEvidenceLedger,
  validateEvalContractDocument,
  validateDerivedSummaryAgainstBundle,
  validateEvaluationBundle,
  verifyEvidenceLedger,
  withDocumentDigest,
  type BlindedResultsSealDocument,
  type DerivedSummaryDocument,
  type HoldoutAccessReceiptDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type RunRecordDocument,
  type SuiteManifestDocument,
  type UnblindingRecordDocument,
} from "../../src/eval-contract/index.js";
import {
  GIT_COMMIT,
  digest,
  makePreregistration,
} from "./evaluation-contract-fixtures.js";
import {
  evidenceReference,
  makeScorecardBundleFixture,
} from "./evaluation-experiment-bundle-fixtures.js";

const scorecardEvidenceRegistry = vi.hoisted(() => new WeakSet<object>());
const durableLedgerProbe = vi.hoisted(() => ({
  appendDelayMs: 0,
  initializeCalls: 0,
  appendCalls: 0,
  sealCalls: 0,
  verifyCalls: 0,
}));

vi.mock("../../src/eval-contract/evidence-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/eval-contract/evidence-ledger.js")
  >();
  return {
    ...actual,
    isExternallyVerifiedEvidenceLedger(value: unknown) {
      return actual.isExternallyVerifiedEvidenceLedger(value) ||
        (typeof value === "object" && value !== null && scorecardEvidenceRegistry.has(value));
    },
    async initializeEvidenceLedger(
      ...args: Parameters<typeof actual.initializeEvidenceLedger>
    ) {
      durableLedgerProbe.initializeCalls += 1;
      return actual.initializeEvidenceLedger(...args);
    },
    async appendEvidenceEvent(...args: Parameters<typeof actual.appendEvidenceEvent>) {
      durableLedgerProbe.appendCalls += 1;
      if (durableLedgerProbe.appendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, durableLedgerProbe.appendDelayMs));
      }
      return actual.appendEvidenceEvent(...args);
    },
    async sealEvidenceLedger(...args: Parameters<typeof actual.sealEvidenceLedger>) {
      durableLedgerProbe.sealCalls += 1;
      return actual.sealEvidenceLedger(...args);
    },
    async verifyEvidenceLedger(...args: Parameters<typeof actual.verifyEvidenceLedger>) {
      durableLedgerProbe.verifyCalls += 1;
      return actual.verifyEvidenceLedger(...args);
    },
  };
});

let root: string;

const platformProtection = {
  verifierDigest: digest("test-platform-protection-verifier"),
  async verify() {
    return true;
  },
} as const;

function access() {
  return { root, platformProtection } as const;
}

beforeEach(async () => {
  durableLedgerProbe.appendDelayMs = 0;
  durableLedgerProbe.initializeCalls = 0;
  durableLedgerProbe.appendCalls = 0;
  durableLedgerProbe.sealCalls = 0;
  durableLedgerProbe.verifyCalls = 0;
  root = await mkdtemp(path.join(tmpdir(), "agenc-eval-bundle-"));
  await chmod(root, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface PhaseTiming {
  readonly name: string;
  readonly elapsedMs: number;
}

async function runPhase<T>(
  timings: PhaseTiming[],
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings.push({ name, elapsedMs: performance.now() - startedAt });
  }
}

function testWithPhaseTimings(
  name: string,
  operation: (timings: PhaseTiming[]) => Promise<void>,
): void {
  test(name, async () => {
    const timings: PhaseTiming[] = [];
    try {
      await operation(timings);
    } catch (error) {
      const details = timings
        .map((timing) => `${timing.name}=${timing.elapsedMs.toFixed(1)}ms`)
        .join(", ");
      if (error instanceof Error) {
        error.message = `${error.message}\nphase timings: ${details}`;
        throw error;
      }
      throw new Error(`test failed: ${String(error)}\nphase timings: ${details}`);
    }
  });
}

describe("cross-document evaluation bundle", () => {
  test("fails closed with a typed error for structurally malformed bundles", async () => {
    const malformed = {
      suite: {},
      preregistration: {},
      preregistrationReceipt: {},
      blindedResultsSeal: {},
      unblindingRecord: {},
      runs: [],
      verifiedEvidence: [],
      lifecycleAnchors: {
        verifyPreregistrationReceipt: () => true,
      },
    } as unknown as Parameters<typeof validateEvaluationBundle>[0];

    await expect(validateEvaluationBundle(malformed)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("must have required property")]),
    });
    await expect(validateEvaluationBundle({
      ...malformed,
      suite: false,
    } as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("suite must be a document object")]),
    });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: [null],
    } as never)).rejects.toMatchObject({ name: "EvaluationBundleValidationError" });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: [undefined],
    } as never)).rejects.toMatchObject({ name: "EvaluationBundleValidationError" });
    await expect(validateEvaluationBundle({
      ...malformed,
      runs: new Array(1),
    } as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("runs must be a dense array")]),
    });
  });

  testWithPhaseTimings("binds one real durable ledger through the matrix bundle validation path", async (phaseTimings) => {
    const fixture = await runPhase(
      phaseTimings,
      "deterministic matrix fixture",
      makeScorecardBundleFixture,
    );
    const expectedEvidence = fixture.bundle.verifiedEvidence[0];
    if (!expectedEvidence) throw new Error("scorecard fixture has no verified evidence");
    const ledgerInput = fixture.ledgerInputsByRun.get(expectedEvidence.inspection.runId);
    if (!ledgerInput) throw new Error("scorecard fixture has no durable ledger input");

    await runPhase(phaseTimings, "ledger initialization", () =>
      initializeEvidenceLedger(access(), ledgerInput.context.runId));
    await runPhase(phaseTimings, "ledger append", async () => {
      for (const event of ledgerInput.events) {
        await appendEvidenceEvent({ ...access(), ...event });
      }
    });
    const seal = await runPhase(phaseTimings, "ledger sealing", () =>
      sealEvidenceLedger({
        ...access(),
        context: ledgerInput.context,
        sealedAt: ledgerInput.sealedAt,
        anchorProvider: fixture.provider,
      }));
    const verified = await runPhase(phaseTimings, "ledger verification", () =>
      verifyEvidenceLedger({
        ...access(),
        runId: ledgerInput.context.runId,
        expectedSealDigest: seal.sealDigest,
        anchorVerifier: fixture.provider,
      }));
    expect(verified).toEqual(expectedEvidence);
    expect(durableLedgerProbe).toMatchObject({
      initializeCalls: 1,
      appendCalls: ledgerInput.events.length,
      sealCalls: 1,
      verifyCalls: 1,
    });

    const verifiedEvidence = fixture.bundle.verifiedEvidence.map((entry) => {
      if (entry.inspection.runId === verified.inspection.runId) return verified;
      scorecardEvidenceRegistry.add(entry);
      return entry;
    });
    const targetRun = fixture.bundle.runs.find((run) => run.runId === verified.inspection.runId);
    if (!targetRun) throw new Error("scorecard fixture has no matching run record");
    expect(evidenceReference(verified)).toEqual(targetRun.evidence);
    expect(validateEvalContractDocument(targetRun)).toEqual(targetRun);
    const validated = await runPhase(phaseTimings, "bundle validation", () =>
      validateEvaluationBundle({ ...fixture.bundle, verifiedEvidence }));
    expect(validated.evidenceByRun.get(verified.inspection.runId)).toBe(verified);
  });

  testWithPhaseTimings("derives the complete equal-task scorecard from anchored planned cells", async (phaseTimings) => {
    durableLedgerProbe.appendDelayMs = 5;
    const fixture = await runPhase(
      phaseTimings,
      "deterministic matrix fixture",
      makeScorecardBundleFixture,
    );
    const { bundle } = fixture;
    const {
      suite,
      holdoutDescriptor,
      holdoutAccessReceipt,
      preregistration,
      preregistrationReceipt,
      blindedResultsSeal,
      unblindingRecord,
      runs,
      verifiedEvidence,
    } = bundle;
    if (!holdoutDescriptor || !holdoutAccessReceipt) {
      throw new Error("scorecard fixture is missing holdout lifecycle documents");
    }
    for (const evidence of verifiedEvidence) scorecardEvidenceRegistry.add(evidence);
    expect(durableLedgerProbe).toMatchObject({
      initializeCalls: 0,
      appendCalls: 0,
      sealCalls: 0,
      verifyCalls: 0,
    });

    const verifiedButExposedSource = runs.find((run) => run.verifiedFix);
    if (!verifiedButExposedSource || verifiedButExposedSource.trustAssessment.status !== "assessed") {
      throw new Error("missing assessed verified run fixture");
    }
    const { documentDigest: _sourceDigest, ...verifiedButExposedBody } = verifiedButExposedSource;
    const verifiedButExposed = withDocumentDigest<RunRecordDocument>({
      ...verifiedButExposedBody,
      trustAssessment: {
        ...verifiedButExposedSource.trustAssessment,
        trustedFix: false,
        criteria: {
          ...verifiedButExposedSource.trustAssessment.criteria,
          hiddenVerifier: {
            ...verifiedButExposedSource.trustAssessment.criteria.hiddenVerifier,
            status: "failed",
            inaccessibleDuringRun: false,
          },
        },
      },
    });
    expect(validateEvalContractDocument(verifiedButExposed)).toMatchObject({
      verifiedFix: true,
      trustAssessment: { status: "assessed", trustedFix: false },
    });

    const callerMutableRuns = [...runs];
    const snapshotResult = await runPhase(phaseTimings, "bundle snapshot validation", () =>
      validateEvaluationBundle({
        ...bundle,
        runs: callerMutableRuns,
        lifecycleAnchors: {
          ...bundle.lifecycleAnchors,
          async verifyPreregistrationReceipt(bytes, receipt) {
            const verified = await bundle.lifecycleAnchors
              .verifyPreregistrationReceipt(bytes, receipt);
            callerMutableRuns.pop();
            return verified;
          },
        },
      }));
    expect(callerMutableRuns).toHaveLength(59);
    expect(snapshotResult.bundle.runs).toHaveLength(60);
    expect(Object.isFrozen(snapshotResult.bundle.runs)).toBe(true);
    await expect(deriveExperimentSummary(bundle, null as never)).rejects.toMatchObject({
      name: "EvaluationBundleValidationError",
      issues: expect.arrayContaining([expect.stringContaining("summary options must be an object")]),
    });
    const callerMutableOptions = {
      summaryId: "snapshot-summary",
      generatedAt: "2026-07-15T12:00:06Z",
    };
    const optionSnapshotSummary = await runPhase(phaseTimings, "option snapshot derivation", () =>
      deriveExperimentSummary({
        ...bundle,
        lifecycleAnchors: {
          ...bundle.lifecycleAnchors,
          async verifyPreregistrationReceipt(bytes, receipt) {
            const verified = await bundle.lifecycleAnchors
              .verifyPreregistrationReceipt(bytes, receipt);
            callerMutableOptions.summaryId = "mutated-summary";
            return verified;
          },
        },
      }, callerMutableOptions));
    expect(optionSnapshotSummary.summaryId).toBe("snapshot-summary");
    expect(callerMutableOptions.summaryId).toBe("mutated-summary");

    await expect(runPhase(phaseTimings, "bundle validation", () =>
      validateEvaluationBundle(bundle))).resolves.toMatchObject({
      exclusions: [expect.objectContaining({ comparisonId: "agenc-vs-one" })],
    });
    const summary = await runPhase(phaseTimings, "scorecard derivation", () =>
      deriveExperimentSummary(bundle, {
        summaryId: "summary-one",
        generatedAt: "2026-07-15T12:00:06Z",
      }));
    expect(summary.rawEvidenceEmbedded).toBe(false);
    expect(summary.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        systemId: "agenc-primary",
        verifiedFixRate: 0.95,
        trustedFixRate: 0.95,
        includedTrialCount: 20,
        pairwiseInfrastructureExclusionCount: 1,
      }),
      expect.objectContaining({
        systemId: "comparator-one",
        verifiedFixRate: 0.05,
        trustedFixRate: 0.05,
        includedTrialCount: 20,
        pairwiseInfrastructureExclusionCount: 1,
      }),
    ]));
    expect(summary.pairedEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        comparisonId: "agenc-vs-one",
        pointEstimate: 0.9,
        superiorityCriterionMet: null,
      }),
      expect.objectContaining({ comparisonId: "agenc-vs-two", pointEstimate: 0.95 }),
    ]));
    expect(summary.superiorityEstablished).toBeNull();
    expect(summary.evidenceSeals).toHaveLength(60);
    await expect(runPhase(phaseTimings, "summary validation", () =>
      validateDerivedSummaryAgainstBundle(bundle, summary))).resolves.toEqual(summary);
    const winningEffect = summary.pairedEffects[0];
    if (!winningEffect || winningEffect.confidenceLower <= 0) {
      throw new Error("missing winning paired-effect fixture");
    }
    const fabricatedSuperiority = withDocumentDigest<DerivedSummaryDocument>({
      ...summary,
      claim: "superiority",
      pairedEffects: [{ ...winningEffect, superiorityCriterionMet: true }],
      superiorityEstablished: true,
    });
    expect(() => validateEvalContractDocument(fabricatedSuperiority)).not.toThrow();
    await expect(
      validateDerivedSummaryAgainstBundle(bundle, fabricatedSuperiority),
    ).rejects.toThrow(/does not exactly match fresh derivation/u);
    const contradictorySuperiority = withDocumentDigest<DerivedSummaryDocument>({
      ...summary,
      claim: "superiority",
      pairedEffects: summary.pairedEffects.map((effect, index) => ({
        ...effect,
        superiorityCriterionMet: index === 0,
      })),
      superiorityEstablished: true,
    });
    expect(() => validateEvalContractDocument(contradictorySuperiority)).toThrow(
      /intersection of every comparator/u,
    );

    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.slice(1),
    })).rejects.toThrow(/missing planned run cell|run matrix/u);

    const forgedRun = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      agentTaskDigest: digest("wrong-agent-projection"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [forgedRun, ...runs.slice(1)],
      blindedResultsSeal: withDocumentDigest<BlindedResultsSealDocument>({
        ...blindedResultsSeal,
        completeRunMatrixDigest: digestCanonicalJson(
          "agenc.eval.complete-run-matrix.v1",
          [forgedRun, ...runs.slice(1)]
            .map((run) => ({ runId: run.runId, runDigest: run.documentDigest, sealDigest: run.evidence.sealDigest }))
            .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0),
        ),
      }),
    })).rejects.toThrow(/agent task projection digest mismatch/u);

    const forgedArtifactDigest = digest("forged-artifact-without-bytes");
    const forgedArtifactRun = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      artifacts: [
        {
          ...runs[0].artifacts[0],
          digest: forgedArtifactDigest,
          uri: `cas://sha256/${forgedArtifactDigest.slice("sha256:".length)}`,
        },
        ...runs[0].artifacts.slice(1),
      ],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [forgedArtifactRun, ...runs.slice(1)],
    })).rejects.toThrow(/is not backed by verified payload bytes/u);

    const wrongProviderModel = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      system: { ...runs[0].system, providerReportedModelId: "different-model-build" },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [wrongProviderModel, ...runs.slice(1)],
    })).rejects.toThrow(/provider-reported model ID differs/u);

    const overCacheBudget = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        cacheReadTokens: suite.tasks[0].budget.cacheTokens + 1,
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [overCacheBudget, ...runs.slice(1)],
    })).rejects.toThrow(/cache-token budget exceeded/u);

    const overTurnBudget = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        turns: suite.tasks[0].budget.turns + 1,
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [overTurnBudget, ...runs.slice(1)],
    })).rejects.toThrow(/turn budget exceeded/u);

    const usageEvidence = verifiedEvidence[0]?.inspection.events.find(
      (entry) => entry.type === "usage.reported",
    )?.payload.digest;
    if (!usageEvidence) throw new Error("missing provider-usage fixture");
    const unboundedProviderCost = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      usage: {
        ...runs[0].usage,
        providerCost: {
          status: "unavailable",
          reason: "provider omitted metering",
          evidenceDigest: usageEvidence,
          reservedAmount: "1.01",
          currency: "USD",
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [unboundedProviderCost, ...runs.slice(1)],
    })).rejects.toThrow(/reserved provider-cost bound exceeded/u);

    const wrongArtifactPath = withDocumentDigest<RunRecordDocument>({
      ...runs[0],
      artifacts: [
        { ...runs[0].artifacts[0], path: "result/wrong.patch" },
        ...runs[0].artifacts.slice(1),
      ],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: [wrongArtifactPath, ...runs.slice(1)],
    })).rejects.toThrow(/required artifact patch does not match/u);

    const successfulRun = runs.find((run) => run.trustAssessment.trustedFix);
    if (!successfulRun || successfulRun.trustAssessment.status !== "assessed") {
      throw new Error("missing successful assessed run");
    }
    const reorderedAttestation = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      trustAssessment: {
        ...successfulRun.trustAssessment,
        criteria: {
          ...successfulRun.trustAssessment.criteria,
          policyAndBudget: {
            ...successfulRun.trustAssessment.criteria.policyAndBudget,
            evidenceDigests: [
              ...successfulRun.trustAssessment.criteria.policyAndBudget.evidenceDigests,
            ].reverse(),
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? reorderedAttestation : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("assessed trust lacks an exact attestation"),
      ]),
    });

    const missingTypedEvidence = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      trustAssessment: {
        ...successfulRun.trustAssessment,
        criteria: {
          ...successfulRun.trustAssessment.criteria,
          effectSafety: {
            ...successfulRun.trustAssessment.criteria.effectSafety,
            evidenceDigests: [successfulRun.verifier.evidenceDigest],
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? missingTypedEvidence : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("effectSafety lacks its required typed evidence events"),
      ]),
    });

    const adverseRun = runs.find((run) =>
      run.systemId === "comparator-one" && run.taskId === suite.tasks[1].taskId);
    if (!adverseRun || adverseRun.trustAssessment.status !== "assessed") {
      throw new Error("missing adverse assessed run");
    }
    const contradictoryAdverseAssessment = withDocumentDigest<RunRecordDocument>({
      ...adverseRun,
      trustAssessment: {
        ...adverseRun.trustAssessment,
        criteria: {
          ...adverseRun.trustAssessment.criteria,
          effectSafety: {
            ...adverseRun.trustAssessment.criteria.effectSafety,
            status: "passed",
            unresolvedUnknownOutcomes: 0,
          },
          recoveryIntegrity: {
            ...adverseRun.trustAssessment.criteria.recoveryIntegrity,
            status: "passed",
            eventGaps: 0,
          },
        },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === adverseRun.runId ? contradictoryAdverseAssessment : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("contradicts anchored unknown-outcome events"),
        expect.stringContaining("contradicts anchored event-gap evidence"),
      ]),
    });

    const disallowedApproval = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      approvals: [{
        id: "approval-one",
        kind: "unregistered-approval",
        requestedAt: successfulRun.startedAt,
        resolvedAt: successfulRun.finishedAt,
        decision: "approved",
        declaredByTask: true,
      }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? disallowedApproval : run),
    })).rejects.toThrow(/approval kind is outside a pinned allowlist/u);

    const changedResetTask = withDocumentDigest<OperatorTaskDocument>({
      ...suite.tasks[1],
      resetRecipe: {
        ...suite.tasks[1].resetRecipe,
        id: "different-reset",
        digest: digest("different-reset"),
      },
    });
    const changedResetSuite = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      tasks: suite.tasks.map((task) =>
        task.taskId === changedResetTask.taskId ? changedResetTask : task),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      suite: changedResetSuite,
    })).rejects.toThrow(/task reset recipe or receipt differs/u);

    const wrongExecutionIndex = withDocumentDigest<RunRecordDocument>({
      ...successfulRun,
      executionIndex: successfulRun.executionIndex + runs.length,
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) => run.runId === successfulRun.runId ? wrongExecutionIndex : run),
    })).rejects.toThrow(/execution index differs|start chronology/u);

    const primaryRun = runs.find((run) =>
      run.systemId === preregistration.primarySystemId && run.taskId === suite.tasks[0].taskId);
    const comparatorRun = runs.find((run) =>
      run.systemId === "comparator-one" && run.taskId === suite.tasks[0].taskId);
    const primaryEvidence = verifiedEvidence.find((entry) =>
      entry.inspection.runId === primaryRun?.runId);
    const sharedIncidentEvidence = primaryEvidence?.inspection.events.find(
      (event) => event.type === "budget.reconciled",
    )?.payload.digest;
    if (!primaryRun || !comparatorRun || !sharedIncidentEvidence) {
      throw new Error("missing paired infrastructure fixture");
    }
    const incident = {
      comparisonId: "agenc-vs-one",
      reason: "shared_provider_outage" as const,
      incidentId: "incident-one",
      evidenceDigest: sharedIncidentEvidence,
      classifierVersion: "1.0.0",
      classifierImplementationDigest:
        preregistration.exclusions.classifierImplementation.digest,
    };
    const primaryInfrastructureInvalid = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      infrastructureInvalidPairs: [{ ...incident, counterpartRunId: comparatorRun.runId }],
    });
    const comparatorInfrastructureInvalid = withDocumentDigest<RunRecordDocument>({
      ...comparatorRun,
      infrastructureInvalidPairs: [{ ...incident, counterpartRunId: primaryRun.runId }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId
          ? primaryInfrastructureInvalid
          : run.runId === comparatorRun.runId
            ? comparatorInfrastructureInvalid
            : run),
    })).rejects.toThrow(/infrastructure reason was not preregistered/u);

    const untypedIncident = {
      ...incident,
      reason: "evaluator_host_failure" as const,
    };
    const primaryUntypedIncident = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      infrastructureInvalidPairs: [{ ...untypedIncident, counterpartRunId: comparatorRun.runId }],
    });
    const comparatorUntypedIncident = withDocumentDigest<RunRecordDocument>({
      ...comparatorRun,
      infrastructureInvalidPairs: [{ ...untypedIncident, counterpartRunId: primaryRun.runId }],
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId
          ? primaryUntypedIncident
          : run.runId === comparatorRun.runId
            ? comparatorUntypedIncident
            : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("lacks a shared typed classifier receipt"),
      ]),
    });

    const ordinaryOutcomeWithExclusion = withDocumentDigest<RunRecordDocument>({
      ...primaryRun,
      outcome: "fail",
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      runs: runs.map((run) =>
        run.runId === primaryRun.runId ? ordinaryOutcomeWithExclusion : run),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("infrastructure-invalid outcome and paired incidents must agree"),
      ]),
    });

    const unauthorizedAccessReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutAccessReceipt,
      authorizationEvidenceDigest: digest("different-unblinding-authorization"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutAccessReceipt: unauthorizedAccessReceipt,
    })).rejects.toThrow(/not bound to custody\/authorization policy/u);

    const wrongUnblindingRole = withDocumentDigest<HoldoutAccessReceiptDocument>({
      ...holdoutAccessReceipt,
      authorizedRole: "different-role",
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutAccessReceipt: wrongUnblindingRole,
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("not bound to custody/authorization policy"),
      ]),
    });

    const wrongUnblindingPolicy = withDocumentDigest<UnblindingRecordDocument>({
      ...unblindingRecord,
      policyDigest: digest("different-unblinding-policy"),
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      unblindingRecord: wrongUnblindingPolicy,
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringContaining("unblinding record does not link the exact lifecycle documents"),
      ]),
    });

    await expect(validateEvaluationBundle({
      ...bundle,
      holdoutDescriptor: withDocumentDigest({
        ...holdoutDescriptor,
        status: "retired" as const,
      }),
    })).rejects.toThrow(/is not sealed/u);

    const changedRedactionPolicy = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      evidencePolicy: {
        ...preregistration.evidencePolicy,
        redactionPolicyDigest: digest("different-redaction-policy"),
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      preregistration: changedRedactionPolicy,
    })).rejects.toThrow(/used an unpinned redaction policy/u);

    const overstatedSample = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      samplePlan: {
        ...preregistration.samplePlan,
        minimumTasks: 11,
        maximumTasks: 11,
        stoppingRule: { kind: "fixed", taskCount: 11 },
      },
    });
    await expect(validateEvaluationBundle({
      ...bundle,
      preregistration: overstatedSample,
    })).rejects.toThrow(/selected suite task count is outside/u);
  });
});

describe("paired TFR inference", () => {
  test("averages repetitions within tasks and resamples whole repository clusters", () => {
    const inference = makePreregistration().inference;
    const unequalRepetitions = computePairedTfrEffect([
      {
        taskId: "task-a",
        repositoryCluster: "repo-a",
        trialDifferences: [1, 1, 1],
      },
      {
        taskId: "task-b",
        repositoryCluster: "repo-b",
        trialDifferences: [-1],
      },
    ], "comparison-repetitions", inference);
    expect(unequalRepetitions.pointEstimate).toBe(0);

    const clustered = computePairedTfrEffect([
      { taskId: "task-a", repositoryCluster: "repo-shared", trialDifferences: [1] },
      { taskId: "task-b", repositoryCluster: "repo-shared", trialDifferences: [-1] },
      { taskId: "task-c", repositoryCluster: "repo-other", trialDifferences: [1] },
    ], "comparison-clusters", inference);
    expect(clustered).toEqual({
      pointEstimate: 1 / 3,
      confidenceLower: 0,
      confidenceUpper: 1,
    });

    const interpolationVector = computePairedTfrEffect(
      [-0.931, -0.713, -0.409, -0.107, 0.047, 0.213, 0.359, 0.557, 0.809, 0.997]
        .map((difference, index) => ({
          taskId: `quantile-task-${index}`,
          repositoryCluster: `quantile-repo-${index}`,
          trialDifferences: [difference],
        })),
      "quantile-vector",
      inference,
    );
    expect(interpolationVector).toEqual({
      pointEstimate: 0.08220000000000002,
      confidenceLower: -0.28400499999999995,
      confidenceUpper: 0.4468049999999999,
    });
    expect(interpolationVector.confidenceLower).not.toBe(-0.2842);
    expect(interpolationVector.confidenceLower).not.toBe(-0.284);
    expect(() => computePairedTfrEffect(
      [],
      "comparison-invalid",
      null as never,
    )).toThrow(/non-empty task trials|resamples must be an integer/u);
  });

  test("preserves contract-v1 bootstrap arithmetic and rejects invalid direct calls", () => {
    const arithmeticVector = [
      { cluster: "repo-a", difference: 1 },
      { cluster: "repo-a", difference: 1e-16 },
      { cluster: "repo-a", difference: -1 },
      { cluster: "repo-b", difference: 1 },
      { cluster: "repo-b", difference: -1 },
      { cluster: "repo-b", difference: 2e-16 },
    ];
    expect(computeRepositoryClusteredPercentileInterval(
      arithmeticVector,
      "arithmetic-regression",
      { resamples: 10_000, randomSeed: 123_456 },
    )).toEqual({
      lower: 0,
      upper: 7.034076748750522e-17,
    });
    // Pre-summing each cluster changes this exact contract vector to
    // 6.666666666666667e-17 by regrouping floating-point additions.
    expect(computeRepositoryClusteredPercentileInterval(
      arithmeticVector,
      "arithmetic-regression",
      { resamples: 10_000, randomSeed: 123_456 },
    ).upper).not.toBe(6.666666666666667e-17);

    const startedAt = performance.now();
    expect(() => computeRepositoryClusteredPercentileInterval(
      [],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/non-empty dense task array/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: Number.POSITIVE_INFINITY }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/finite and in \[-1, 1\]/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: Number.NaN }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/finite and in \[-1, 1\]/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "not portable", difference: 0 }],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/valid cluster ID/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: 0 }],
      "not portable",
      { resamples: 10_000, randomSeed: 0 },
    )).toThrow(/valid comparison ID|randomSeed must be an integer/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      [{ cluster: "repo", difference: 0 }],
      "comparison-invalid",
      { resamples: 1_000_001, randomSeed: 1 },
    )).toThrow(/resamples must be an integer/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      new Array(100_001).fill({ cluster: "repo", difference: 0 }),
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/cannot exceed 100000 tasks/u);
    expect(() => computeRepositoryClusteredPercentileInterval(
      Array.from({ length: 501 }, (_, index) => ({
        cluster: "repo",
        difference: index % 2 === 0 ? 0.25 : -0.25,
      })),
      "comparison-invalid",
      { resamples: 1_000_000, randomSeed: 1 },
    )).toThrow(/cannot exceed 500000000 task additions/u);
    let getterCalls = 0;
    const accessorTask = {
      cluster: "repo",
      get difference(): number {
        getterCalls += 1;
        return 0;
      },
    };
    expect(() => computeRepositoryClusteredPercentileInterval(
      [accessorTask],
      "comparison-invalid",
      { resamples: 10_000, randomSeed: 1 },
    )).toThrow(/contain only cluster and difference/u);
    expect(getterCalls).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("portable evaluation methodology vectors", () => {
  test("pins SHA-256 Fisher-Yates order bytes and rejects out-of-contract helper inputs", () => {
    const input = {
      systemIds: ["sys-b", "sys-a"],
      taskIds: ["task-2", "task-1"],
      seedSlots: [11, 7],
      orderSeed: 305_419_896,
    } as const;
    expect(derivePlannedExecutionOrder(input)).toEqual([
      { systemId: "sys-b", taskId: "task-2", seedSlot: 11 },
      { systemId: "sys-a", taskId: "task-1", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-1", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-2", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-1", seedSlot: 7 },
      { systemId: "sys-a", taskId: "task-2", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-1", seedSlot: 11 },
      { systemId: "sys-b", taskId: "task-2", seedSlot: 7 },
    ]);
    expect(computePlannedExecutionOrderDigest(input)).toBe(
      "sha256:7f05950ac07eca59b92670fed606ca109cd6d9632e55ad174aac89e4dd5ffd0e",
    );
    expect(() => derivePlannedExecutionOrder({
      ...input,
      systemIds: ["sys-a", "sys-a"],
    })).toThrow(/systemIds must be unique/u);
    expect(() => derivePlannedExecutionOrder({ ...input, orderSeed: 0 })).toThrow(
      /orderSeed must be an integer/u,
    );
    expect(() => derivePlannedExecutionOrder({
      ...input,
      systemIds: new Array<string>(1),
    })).toThrow(/systemIds must be a non-empty dense array/u);
    expect(() => derivePlannedExecutionOrder({
      systemIds: Array.from({ length: 1_001 }, (_, index) => `sys-${index}`),
      taskIds: Array.from({ length: 1_000 }, (_, index) => `task-${index}`),
      seedSlots: [0],
      orderSeed: 1,
    })).toThrow(/exceeds 1000000 cells/u);
  });

  test("orders distinct nanosecond timestamps that Date.parse collapses", () => {
    const first = "2026-07-15T12:00:02.000000001Z";
    const second = "2026-07-15T12:00:02.000000002Z";
    expect(Date.parse(first)).toBe(Date.parse(second));
    expect(compareUtcTimestamps(first, second)).toBe(-1);
    expect(compareUtcTimestamps(second, first)).toBe(1);
    expect(compareUtcTimestamps(first, first)).toBe(0);
  });
});
