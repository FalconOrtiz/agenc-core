import {
  EVAL_CONTRACT_VERSION,
  canonicalizeJson,
  computeEvidenceEventDigest,
  computeEvidenceSealStatementDigest,
  computePlannedExecutionOrderDigest,
  createHoldoutAccessStatement,
  createInfrastructureClassificationStatement,
  createTrustAssessmentStatement,
  derivePlannedExecutionOrder,
  digestCanonicalJson,
  projectTaskForAgent,
  sha256Digest,
  validateEvalContractDocument,
  withDocumentDigest,
  type AppendEvidenceEventOptions,
  type BlindedResultsSealDocument,
  type EvaluationExperimentBundle,
  type EvidenceAnchorProvider,
  type EvidenceEventDocument,
  type EvidenceEventType,
  type EvidenceLedgerContext,
  type EvidenceLedgerSealDocument,
  type EvidenceLedgerSealStatement,
  type ExpectedArtifact,
  type HoldoutAccessReceiptDocument,
  type IntegrityOnlyEvidenceInspection,
  type PreregistrationDocument,
  type PreregistrationReceiptDocument,
  type RecordedRunArtifact,
  type RunRecordDocument,
  type UnblindingRecordDocument,
  type VerifiedEvidenceLedger,
} from "../../src/eval-contract/index.js";
import {
  digest,
  makeAnchorProvider,
  makeHoldoutDescriptor,
  makePreregistration,
  makeSuite,
  makeSystem,
} from "./evaluation-contract-fixtures.js";

export interface ScorecardLedgerEventInput {
  readonly event: AppendEvidenceEventOptions["event"];
  readonly payloadBytes: Buffer;
}

export interface ScorecardLedgerInput {
  readonly context: EvidenceLedgerContext;
  readonly sealedAt: string;
  readonly events: readonly ScorecardLedgerEventInput[];
}

export interface ScorecardBundleFixture {
  readonly bundle: EvaluationExperimentBundle;
  readonly provider: EvidenceAnchorProvider;
  readonly ledgerInputsByRun: ReadonlyMap<string, ScorecardLedgerInput>;
}

interface RecordedArtifactFixture {
  readonly record: RecordedRunArtifact;
  readonly bytes: Buffer;
}

interface PendingEvidenceFixture {
  readonly context: EvidenceLedgerContext;
  readonly events: EvidenceEventDocument[];
  readonly inputs: ScorecardLedgerEventInput[];
}

function requiredArtifacts(
  runId: string,
  expected: ExpectedArtifact,
): RecordedArtifactFixture[] {
  const roles = [
    "patch",
    "changed_files",
    "test_result",
    "independent_review",
    "cost_usage",
    "approval_log",
    "effect_log",
    "risk_register",
  ] as const;
  return roles.map((role) => {
    const bytes = Buffer.from(`${runId}:${role}`, "utf8");
    const artifactDigest = sha256Digest(bytes);
    return {
      bytes,
      record: {
        artifactId: `${runId}-${role}`,
        expectedArtifactId: role === "patch" ? expected.id : null,
        path: role === "patch" ? expected.path : null,
        role,
        digest: artifactDigest,
        sizeBytes: bytes.byteLength,
        mediaType: role === "patch" ? expected.mediaType : "application/json",
        uri: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
      },
    };
  });
}

export function evidenceReference(
  verified: VerifiedEvidenceLedger,
): RunRecordDocument["evidence"] {
  const { inspection, seal } = verified;
  if (!inspection.genesisEventDigest || !inspection.headEventDigest) {
    throw new Error("empty test ledger");
  }
  return {
    contractDigest: inspection.contractDigest,
    taskId: inspection.taskId,
    systemId: inspection.systemId,
    ledgerDigest: inspection.ledgerDigest,
    ledgerByteLength: inspection.ledgerByteLength,
    genesisEventDigest: inspection.genesisEventDigest,
    headEventDigest: inspection.headEventDigest,
    eventCount: inspection.eventCount,
    platformProtectionVerifierDigest: inspection.platformProtectionVerifierDigest,
    sealDigest: seal.sealDigest,
    statementDigest: seal.receipt.statementDigest,
    anchorPolicyDigest: seal.receipt.anchorPolicyDigest,
    signatureAlgorithm: seal.receipt.signatureAlgorithm,
    signatureDigest: seal.receipt.signatureDigest,
    verificationMaterialDigest: seal.receipt.verificationMaterialDigest,
    anchorUri: seal.receipt.anchorUri,
    signerIdentity: seal.receipt.signerIdentity,
    sealedAt: seal.statement.sealedAt,
  };
}

function appendFixtureEvent(
  pending: PendingEvidenceFixture,
  input: {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly producer: EvidenceEventDocument["producer"];
    readonly type: EvidenceEventType;
    readonly mediaType: string;
    readonly redactionPolicyDigest: `sha256:${string}`;
    readonly payloadBytes: Buffer;
  },
): `sha256:${string}` {
  const payloadBytes = Buffer.from(input.payloadBytes);
  const payloadDigest = sha256Digest(payloadBytes);
  const unsigned: Omit<EvidenceEventDocument, "eventDigest"> = {
    kind: "agenc.eval.evidence-event",
    contractVersion: EVAL_CONTRACT_VERSION,
    ...pending.context,
    eventId: input.eventId,
    sequence: pending.events.length,
    occurredAt: input.occurredAt,
    producer: input.producer,
    type: input.type,
    payload: {
      digest: payloadDigest,
      sizeBytes: payloadBytes.byteLength,
      mediaType: input.mediaType,
      uri: `cas://sha256/${payloadDigest.slice("sha256:".length)}`,
      sensitivity: "restricted",
      redactionPolicyDigest: input.redactionPolicyDigest,
    },
    previousEventDigest: pending.events.at(-1)?.eventDigest ?? null,
  };
  const event: EvidenceEventDocument = {
    ...unsigned,
    eventDigest: computeEvidenceEventDigest(unsigned as EvidenceEventDocument),
  };
  validateEvalContractDocument(event);
  pending.events.push(event);
  pending.inputs.push({
    event: {
      ...pending.context,
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      producer: input.producer,
      type: input.type,
      mediaType: input.mediaType,
      redactionPolicyDigest: input.redactionPolicyDigest,
    },
    payloadBytes,
  });
  return payloadDigest;
}

async function finishEvidenceFixture(
  pending: PendingEvidenceFixture,
  sealedAt: string,
  provider: EvidenceAnchorProvider,
  platformProtectionVerifierDigest: `sha256:${string}`,
): Promise<VerifiedEvidenceLedger> {
  const ledgerBytes = Buffer.from(
    pending.events.map((event) => canonicalizeJson(event)).join("\n") + "\n",
    "utf8",
  );
  const genesis = pending.events[0];
  const terminal = pending.events.at(-1);
  if (!genesis || !terminal) throw new Error("scorecard evidence fixture is empty");
  const inspection: IntegrityOnlyEvidenceInspection = {
    trust: "integrity_only_unanchored",
    ...pending.context,
    platformProtectionVerifierDigest,
    ledgerDigest: sha256Digest(ledgerBytes),
    ledgerByteLength: ledgerBytes.byteLength,
    genesisEventDigest: genesis.eventDigest,
    headEventDigest: terminal.eventDigest,
    eventCount: pending.events.length,
    terminal: terminal.type === "run.finished",
    events: pending.events,
  };
  const statement: EvidenceLedgerSealStatement = {
    ...pending.context,
    ledgerDigest: inspection.ledgerDigest,
    ledgerByteLength: inspection.ledgerByteLength,
    genesisEventDigest: genesis.eventDigest,
    headEventDigest: terminal.eventDigest,
    eventCount: inspection.eventCount,
    platformProtectionVerifierDigest,
    sealedAt,
  };
  const statementBytes = Buffer.from(canonicalizeJson(statement), "utf8");
  const receipt = await provider.anchor(
    statementBytes,
    computeEvidenceSealStatementDigest(statement),
  );
  const sealDocument: EvidenceLedgerSealDocument = {
    kind: "agenc.eval.evidence-seal",
    contractVersion: EVAL_CONTRACT_VERSION,
    statement,
    receipt,
  };
  validateEvalContractDocument(sealDocument);
  const sealBytes = Buffer.from(`${canonicalizeJson(sealDocument)}\n`, "utf8");
  return {
    trust: "externally_anchored",
    inspection,
    seal: { ...sealDocument, sealDigest: sha256Digest(sealBytes) },
    anchorVerifierDigest: provider.verifierDigest,
    platformProtectionVerifierDigest,
  };
}

export async function makeScorecardBundleFixture(): Promise<ScorecardBundleFixture> {
  const suite = makeSuite("private_holdout");
  const holdoutDescriptor = makeHoldoutDescriptor(suite);
  const basePreregistration = makePreregistration(suite, holdoutDescriptor);
  const secondComparator = makeSystem("comparator-two");
  const seedSlots = [101, 202] as const;
  const preregistration = withDocumentDigest<PreregistrationDocument>({
    ...basePreregistration,
    systems: [...basePreregistration.systems, secondComparator],
    comparisons: [
      ...basePreregistration.comparisons,
      {
        comparisonId: "agenc-vs-two",
        primarySystemId: basePreregistration.primarySystemId,
        comparatorSystemId: secondComparator.systemId,
      },
    ],
    trialDesign: {
      ...basePreregistration.trialDesign,
      repetitionsPerSystemTask: seedSlots.length,
      seedSlots,
      plannedExecutionOrderDigest: computePlannedExecutionOrderDigest({
        systemIds: [...basePreregistration.systems, secondComparator]
          .map((system) => system.systemId),
        taskIds: suite.tasks.map((task) => task.taskId),
        seedSlots,
        orderSeed: basePreregistration.trialDesign.orderSeed,
      }),
    },
  });
  const provider = makeAnchorProvider();
  const preregistrationBytes = Buffer.from(canonicalizeJson(preregistration), "utf8");
  const preregistrationAnchor = await provider.anchor(
    preregistrationBytes,
    digestCanonicalJson("agenc.eval.preregistration-statement.v1", preregistration),
  );
  const preregistrationReceipt = withDocumentDigest<PreregistrationReceiptDocument>({
    kind: "agenc.eval.preregistration-receipt",
    contractVersion: EVAL_CONTRACT_VERSION,
    preregistrationDigest: preregistration.documentDigest,
    ...preregistrationAnchor,
    anchoredAt: "2026-07-15T12:00:01Z",
  });

  const plannedOrder = derivePlannedExecutionOrder({
    systemIds: preregistration.systems.map((system) => system.systemId),
    taskIds: suite.tasks.map((task) => task.taskId),
    seedSlots: preregistration.trialDesign.seedSlots,
    orderSeed: preregistration.trialDesign.orderSeed,
  });
  const executionIndexByCell = new Map(plannedOrder.map((cell, index) => [
    `${cell.systemId}\u0000${cell.taskId}\u0000${cell.seedSlot}`,
    index,
  ]));
  const timestampAt = (executionIndex: number, offsetNanoseconds: number) =>
    `2026-07-15T12:00:02.${String(
      executionIndex * 1_000 + offsetNanoseconds,
    ).padStart(9, "0")}Z`;

  const runs: RunRecordDocument[] = [];
  const verifiedEvidence: VerifiedEvidenceLedger[] = [];
  const ledgerInputsByRun = new Map<string, ScorecardLedgerInput>();
  for (const system of preregistration.systems) {
    const primary = system.systemId === preregistration.primarySystemId;
    for (const task of suite.tasks) {
      for (const seedSlot of preregistration.trialDesign.seedSlots) {
        const runId = `${system.systemId}-${task.taskId}-${seedSlot}`;
        const executionIndex = executionIndexByCell.get(
          `${system.systemId}\u0000${task.taskId}\u0000${seedSlot}`,
        );
        if (executionIndex === undefined) throw new Error("missing planned execution cell");
        const startedAt = timestampAt(executionIndex, 0);
        const evidenceAt = timestampAt(executionIndex, 2);
        const finishedAt = timestampAt(executionIndex, 10);
        const sealedAt = timestampAt(executionIndex, 12);
        const context = {
          runId,
          contractDigest: preregistration.documentDigest,
          taskId: task.taskId,
          systemId: system.systemId,
        } as const;
        const pending: PendingEvidenceFixture = { context, events: [], inputs: [] };
        const infrastructureInvalid =
          task.taskId === suite.tasks[0].taskId &&
          seedSlot === seedSlots[0] &&
          (system.systemId === preregistration.primarySystemId ||
            system.systemId === "comparator-one");
        const crossedSeedSuccess =
          system.systemId === "comparator-one" &&
          task.taskId === suite.tasks[0].taskId &&
          seedSlot === seedSlots[1];
        const successfulFix = !infrastructureInvalid && (primary || crossedSeedSuccess);
        const analysisProducer = {
          identity: "test-evaluator",
          version: "1.0.0",
          binaryDigest: preregistration.evaluator.analysisImplementation.digest,
        } as const;
        const redactionPolicyDigest = preregistration.evidencePolicy.redactionPolicyDigest;
        appendFixtureEvent(pending, {
          eventId: `${runId}-start`,
          occurredAt: startedAt,
          producer: analysisProducer,
          type: "run.started",
          mediaType: "application/json",
          redactionPolicyDigest,
          payloadBytes: Buffer.from(`{"runId":${JSON.stringify(runId)}}`),
        });
        const expectedArtifact = task.expectedArtifacts[0];
        if (!expectedArtifact) throw new Error("test task is missing its required artifact");
        const artifactEntries = requiredArtifacts(runId, expectedArtifact);
        const appendTypedEvidence = (
          type: EvidenceEventType,
          label: string,
          payloadBytes: Buffer,
          mediaType = "application/json",
          binaryDigest = preregistration.evaluator.analysisImplementation.digest,
        ) => appendFixtureEvent(pending, {
          eventId: `${runId}-${label}`,
          occurredAt: evidenceAt,
          producer: { identity: "test-evaluator", version: "1.0.0", binaryDigest },
          type,
          mediaType,
          redactionPolicyDigest,
          payloadBytes,
        });
        const artifactEvidence: Array<`sha256:${string}`> = [];
        for (const entry of artifactEntries) {
          const eventType = entry.record.role === "independent_review"
            ? "review.completed"
            : entry.record.role === "risk_register"
              ? "risk.recorded"
              : "artifact.recorded";
          artifactEvidence.push(appendTypedEvidence(
            eventType,
            `artifact-${entry.record.role}`,
            entry.bytes,
            entry.record.mediaType,
          ));
        }
        const policyEvidence = ([
          "budget.reconciled",
          "policy.evaluated",
          "sandbox.evaluated",
          "usage.reported",
        ] as const).map((type) => appendTypedEvidence(
          type,
          type.replace(".", "-"),
          Buffer.from(type),
        ));
        const effectEvidence = appendTypedEvidence(
          "effect.result",
          "effect-result",
          Buffer.from("{\"duplicated\":0,\"unknown\":0}"),
        );
        const unknownEffectEvidence = successfulFix
          ? null
          : appendTypedEvidence(
            "effect.unknown_outcome",
            "effect-unknown-outcome",
            Buffer.from("{\"unresolved\":1}"),
          );
        const recoveryEvidence = appendTypedEvidence(
          "recovery.assessed",
          "recovery-assessed",
          Buffer.from("{\"faults\":0,\"gaps\":0}"),
        );
        const eventGapEvidence = successfulFix
          ? null
          : appendTypedEvidence("event.gap", "event-gap", Buffer.from("{\"gaps\":1}"));
        const interventionEvidence = appendTypedEvidence(
          "intervention.recorded",
          "intervention-recorded",
          Buffer.from("{\"undeclared\":0}"),
        );
        const verifierEvidence = appendTypedEvidence(
          "verifier.completed",
          "verifier-completed",
          Buffer.from(successfulFix ? "{\"passed\":true}" : "{\"passed\":false}"),
        );
        const counterpartRunId = primary
          ? `comparator-one-${task.taskId}-${seedSlot}`
          : `${preregistration.primarySystemId}-${task.taskId}-${seedSlot}`;
        const classifierStatement = infrastructureInvalid
          ? createInfrastructureClassificationStatement({
            comparisonId: "agenc-vs-one",
            taskId: task.taskId,
            seedSlot,
            incidentId: "evaluator-incident-one",
            reason: "evaluator_host_failure",
            classifierVersion: preregistration.exclusions.classifierVersion,
            classifierImplementationDigest:
              preregistration.exclusions.classifierImplementation.digest,
          })
          : null;
        const classifierEvidence = classifierStatement
          ? appendTypedEvidence(
            "infrastructure.classified",
            "infrastructure-classified",
            Buffer.from(canonicalizeJson(classifierStatement)),
            "application/vnd.agenc.eval-infrastructure-classification+json",
            preregistration.exclusions.classifierImplementation.digest,
          )
          : null;
        const infrastructureInvalidPairs = classifierEvidence
          ? [{
            comparisonId: "agenc-vs-one",
            counterpartRunId,
            reason: "evaluator_host_failure" as const,
            incidentId: "evaluator-incident-one",
            evidenceDigest: classifierEvidence,
            classifierVersion: preregistration.exclusions.classifierVersion,
            classifierImplementationDigest:
              preregistration.exclusions.classifierImplementation.digest,
          }]
          : [];
        const criteria = {
          hiddenVerifier: {
            status: successfulFix ? "passed" as const : "failed" as const,
            evidenceDigests: [verifierEvidence],
            inaccessibleDuringRun: true,
            deterministicAssertionsPassed: successfulFix,
          },
          policyAndBudget: {
            status: "passed" as const,
            evidenceDigests: policyEvidence,
            permissionEscapes: 0,
            sandboxEscapes: 0,
            concurrencyEscapes: 0,
            budgetOverruns: 0,
            unresolvedUsageFullyReserved: true,
          },
          effectSafety: {
            status: successfulFix ? "passed" as const : "failed" as const,
            evidenceDigests: [
              effectEvidence,
              ...(unknownEffectEvidence ? [unknownEffectEvidence] : []),
            ],
            duplicatedUncertainMutations: 0,
            unsafeAutomaticRetries: 0,
            unresolvedUnknownOutcomes: successfulFix ? 0 : 1,
          },
          recoveryIntegrity: {
            status: successfulFix ? "passed" as const : "failed" as const,
            evidenceDigests: [recoveryEvidence, ...(eventGapEvidence ? [eventGapEvidence] : [])],
            scheduledFaults: 0,
            successfulRecoveries: 0,
            eventGaps: successfulFix ? 0 : 1,
            hiddenEventLoss: 0,
          },
          evidenceBundle: {
            status: "passed" as const,
            evidenceDigests: artifactEvidence,
            schemaValid: true,
            hashesValid: true,
            unresolvedReviewBlockers: 0,
            missingRequiredArtifacts: 0,
          },
          interventionFree: {
            status: "passed" as const,
            evidenceDigests: [interventionEvidence],
            undeclaredInterventions: 0,
          },
        };
        const usage = {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 130,
          providerCost: {
            status: "reported" as const,
            amount: "0.01" as const,
            currency: "USD" as const,
            source: "provider_reported" as const,
          },
          toolCalls: 2,
          turns: 1,
          retries: 0,
        };
        const artifacts = artifactEntries.map((entry) => entry.record);
        const verifier = {
          verifierId: task.hiddenVerifier.id,
          verifierVersion: task.hiddenVerifier.version,
          bundleDigest: task.hiddenVerifier.bundle.digest,
          result: successfulFix ? "passed" as const : "failed" as const,
          assertionCount: 1,
          passedAssertions: successfulFix ? 1 : 0,
          evidenceDigest: verifierEvidence,
        };
        const trustAssessment = {
          status: "assessed" as const,
          trustedFix: successfulFix,
          assessmentImplementationDigest:
            preregistration.evaluator.trustAssessmentImplementation.digest,
          criteria,
        };
        const outcome = infrastructureInvalid
          ? "infrastructure_invalid" as const
          : successfulFix ? "pass" as const : "fail" as const;
        appendTypedEvidence(
          "trust.assessed",
          "trust-assessed",
          Buffer.from(canonicalizeJson(createTrustAssessmentStatement({
            runId,
            experimentId: preregistration.experimentId,
            taskId: task.taskId,
            systemId: system.systemId,
            startedAt,
            finishedAt,
            outcome,
            verifiedFix: successfulFix,
            usage,
            approvals: [],
            interventions: [],
            artifacts,
            verifier,
            trustAssessment,
            infrastructureInvalidPairs,
          })), "utf8"),
          "application/vnd.agenc.eval-trust-assessment+json",
          preregistration.evaluator.trustAssessmentImplementation.digest,
        );
        appendFixtureEvent(pending, {
          eventId: `${runId}-finish`,
          occurredAt: finishedAt,
          producer: analysisProducer,
          type: "run.finished",
          mediaType: "application/json",
          redactionPolicyDigest,
          payloadBytes: Buffer.from(canonicalizeJson({ outcome })),
        });
        const verified = await finishEvidenceFixture(
          pending,
          sealedAt,
          provider,
          preregistration.evidencePolicy.platformProtectionVerifierDigest,
        );
        verifiedEvidence.push(verified);
        ledgerInputsByRun.set(runId, {
          context,
          sealedAt,
          events: pending.inputs,
        });
        const agentTask = projectTaskForAgent(task);
        runs.push(withDocumentDigest<RunRecordDocument>({
          kind: "agenc.eval.run-record",
          contractVersion: EVAL_CONTRACT_VERSION,
          runId,
          experimentId: preregistration.experimentId,
          preregistrationDigest: preregistration.documentDigest,
          preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
          suiteManifestDigest: suite.documentDigest,
          taskId: task.taskId,
          operatorTaskDigest: task.documentDigest,
          agentTaskDigest: agentTask.documentDigest,
          repositoryCluster: task.repository.cluster,
          systemId: system.systemId,
          trialIndex: preregistration.trialDesign.seedSlots.indexOf(seedSlot),
          seedSlot,
          executionIndex,
          startedAt,
          finishedAt,
          wallTimeMs: Date.parse(finishedAt) - Date.parse(startedAt),
          evaluator: {
            commit: preregistration.evaluator.commit,
            image: preregistration.evaluator.image,
            harnessConfigDigest: preregistration.evaluator.harnessConfigDigest,
            analysisImplementationDigest: preregistration.evaluator.analysisImplementation.digest,
            trustAssessmentImplementationDigest:
              preregistration.evaluator.trustAssessmentImplementation.digest,
          },
          system: {
            systemId: system.systemId,
            release: system.release,
            commit: system.commit,
            packageDigest: system.package.digest,
            image: system.image,
            agentConfigDigest: system.agentConfigDigest,
            publicConfigDigest: system.publicConfigDigest,
            redactedConfigFields: system.redactedConfigFields,
            systemPromptDigest: system.systemPromptDigest,
            toolManifestDigest: system.toolManifestDigest,
            installCommandDigest: system.installCommandDigest,
            environmentClassDigest: system.environmentClassDigest,
            provider: system.provider,
            requestedModelId: system.requestedModelId,
            immutableModelId: system.immutableModelId,
            providerReportedModelId: system.immutableModelId,
            generationParameters: system.generationParameters,
            retryPolicy: system.retryPolicy,
            approvalPolicy: system.approvalPolicy,
          },
          environment: {
            operatingSystem: "linux",
            architecture: "x64",
            kernel: "test-kernel",
            platform: task.environment.platform,
            hardwareClass: task.environment.hardwareClass,
            image: task.environment.image,
            toolchain: task.environment.toolchain,
            networkPolicy: task.networkPolicy,
            permissionPolicyDigest: task.permissionPolicy.policyDigest,
          },
          resetReceipt: {
            recipeDigest: preregistration.resetPolicy.digest,
            repositoryCommit: task.repository.commit,
            workspaceFingerprint: digest(`${runId}:workspace`),
            cacheEmpty: true,
            memoryEmpty: true,
            sessionFresh: true,
          },
          usage,
          approvals: [],
          interventions: [],
          artifacts,
          verifier,
          evidence: evidenceReference(verified),
          outcome,
          verifiedFix: successfulFix,
          trustAssessment,
          infrastructureInvalidPairs,
        }));
      }
    }
  }

  const completeRunMatrixDigest = digestCanonicalJson(
    "agenc.eval.complete-run-matrix.v1",
    [...runs]
      .map((run) => ({
        runId: run.runId,
        runDigest: run.documentDigest,
        sealDigest: run.evidence.sealDigest,
      }))
      .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0),
  );
  const evidenceSealSetDigest = digestCanonicalJson(
    "agenc.eval.evidence-seal-set.v1",
    [...runs].map((run) => run.evidence.sealDigest).sort(),
  );
  const blindedResultsSeal = withDocumentDigest<BlindedResultsSealDocument>({
    kind: "agenc.eval.blinded-results-seal",
    contractVersion: EVAL_CONTRACT_VERSION,
    experimentId: preregistration.experimentId,
    preregistrationDigest: preregistration.documentDigest,
    preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
    completeRunMatrixCommitment: {
      algorithm: "hmac-sha256",
      keyId: "results-key-v1",
      digest: digest("complete-run-matrix-commitment"),
    },
    completeRunMatrixDigest,
    evidenceSealSetDigest,
    sealedAt: "2026-07-15T12:00:04Z",
  });
  const authorizationEvidenceDigest = digest("unblinding-authorization");
  const holdoutReceiptBody = {
    kind: "agenc.eval.holdout-access-receipt" as const,
    contractVersion: EVAL_CONTRACT_VERSION,
    experimentId: preregistration.experimentId,
    holdoutDescriptorDigest: holdoutDescriptor.documentDigest,
    suiteManifestDigest: suite.documentDigest,
    preregistrationDigest: preregistration.documentDigest,
    blindedResultsSealDigest: blindedResultsSeal.documentDigest,
    completeRunMatrixDigest,
    accessPolicyDigest: holdoutDescriptor.accessPolicyDigest,
    unsealPolicyDigest: holdoutDescriptor.unsealPolicyDigest,
    projectionPolicyDigest: holdoutDescriptor.custody.projectionPolicyDigest,
    implementerPrincipalSetDigest: holdoutDescriptor.custody.implementerPrincipalSetDigest,
    custodianIdentity: holdoutDescriptor.custody.custodianIdentity,
    accessLogHeadDigest: digest("access-log-head"),
    projectedRunIdsDigest: digestCanonicalJson(
      "agenc.eval.projected-run-ids.v1",
      [...runs].map((run) => run.runId).sort(),
    ),
    authorizationEvidenceDigest,
    authorizedRole: preregistration.unblinding.authorizedRole,
    authorizedPrincipal: "test-custodian",
    firstAccessAt: "2026-07-15T12:00:01.500Z",
    lastAccessAt: "2026-07-15T12:00:03.900Z",
    issuedAt: "2026-07-15T12:00:04.500Z",
    receiptVerifierDigest: holdoutDescriptor.custody.custodyVerifierDigest,
    signatureAlgorithm: "ed25519" as const,
    verificationMaterialDigest: digest("holdout-receipt-public-key"),
    receiptUri: "https://example.invalid/holdout-access/experiment-one",
  };
  const placeholderHoldoutReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
    ...holdoutReceiptBody,
    signatureDigest: digest("placeholder-holdout-signature"),
  });
  const signHoldoutReceipt = (receipt: HoldoutAccessReceiptDocument) => sha256Digest(
    Buffer.concat([
      Buffer.from("test-holdout-receipt\0"),
      Buffer.from(canonicalizeJson(createHoldoutAccessStatement(receipt))),
    ]),
  );
  const holdoutAccessReceipt = withDocumentDigest<HoldoutAccessReceiptDocument>({
    ...holdoutReceiptBody,
    signatureDigest: signHoldoutReceipt(placeholderHoldoutReceipt),
  });
  const unblindingRecord = withDocumentDigest<UnblindingRecordDocument>({
    kind: "agenc.eval.unblinding-record",
    contractVersion: EVAL_CONTRACT_VERSION,
    experimentId: preregistration.experimentId,
    preregistrationDigest: preregistration.documentDigest,
    preregistrationReceiptDigest: preregistrationReceipt.documentDigest,
    blindedResultsSealDigest: blindedResultsSeal.documentDigest,
    holdoutDescriptorDigest: holdoutDescriptor.documentDigest,
    holdoutAccessReceiptDigest: holdoutAccessReceipt.documentDigest,
    policyDigest: preregistration.unblinding.policyDigest,
    authorizedRole: preregistration.unblinding.authorizedRole,
    authorizationEvidenceDigest,
    unblindedBy: "test-custodian",
    unblindedAt: "2026-07-15T12:00:05Z",
  });
  const bundle: EvaluationExperimentBundle = {
    suite,
    holdoutDescriptor,
    holdoutAccessReceipt,
    preregistration,
    preregistrationReceipt,
    blindedResultsSeal,
    unblindingRecord,
    runs,
    verifiedEvidence,
    lifecycleAnchors: {
      expectedPreregistrationReceiptDigest: preregistrationReceipt.documentDigest,
      expectedBlindedResultsSealDigest: blindedResultsSeal.documentDigest,
      expectedUnblindingRecordDigest: unblindingRecord.documentDigest,
      preregistrationReceiptVerifierDigest: preregistration.evidencePolicy.anchorVerifierDigest,
      expectedHoldoutAccessReceiptDigest: holdoutAccessReceipt.documentDigest,
      holdoutAccessReceiptVerifierDigest: holdoutDescriptor.custody.custodyVerifierDigest,
      verifyPreregistrationReceipt: (bytes, receipt) => provider.verify(bytes, receipt),
      verifyHoldoutAccessReceipt: (bytes, receipt) =>
        receipt.signatureDigest === sha256Digest(Buffer.concat([
          Buffer.from("test-holdout-receipt\0"),
          Buffer.from(bytes),
        ])),
    },
  };
  return { bundle, provider, ledgerInputsByRun };
}
