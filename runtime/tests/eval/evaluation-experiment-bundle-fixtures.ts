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
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type PreregistrationReceiptDocument,
  type RecordedRunArtifact,
  type RunRecordDocument,
  type Sha256Digest,
  type SuiteManifestDocument,
  type SystemConfigurationPin,
  type TrustAssessment,
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

type AssessedTrustAssessment = Extract<
  TrustAssessment,
  { readonly status: "assessed" }
>;

type AppendTypedEvidence = (
  type: EvidenceEventType,
  label: string,
  payloadBytes: Buffer,
  mediaType?: string,
  binaryDigest?: Sha256Digest,
) => Sha256Digest;

interface ScorecardRunClassification {
  readonly primary: boolean;
  readonly infrastructureInvalid: boolean;
  readonly successfulFix: boolean;
  readonly outcome: RunRecordDocument["outcome"];
  readonly criterionStatus: "passed" | "failed";
  readonly failureCount: 0 | 1;
}

interface ScorecardFailureEvidence {
  readonly unknownEffectEvidence?: Sha256Digest;
  readonly eventGapEvidence?: Sha256Digest;
}

interface ScorecardCellFixture {
  readonly run: RunRecordDocument;
  readonly verifiedEvidence: VerifiedEvidenceLedger;
  readonly ledgerInput: ScorecardLedgerInput;
}

interface ScorecardMatrixFixture {
  readonly runs: RunRecordDocument[];
  readonly verifiedEvidence: VerifiedEvidenceLedger[];
  readonly ledgerInputsByRun: Map<string, ScorecardLedgerInput>;
}

function scorecardCellKey(
  systemId: string,
  taskId: string,
  seedSlot: number,
): string {
  return `${systemId}\u0000${taskId}\u0000${seedSlot}`;
}

function scorecardTimestampAt(
  executionIndex: number,
  offsetNanoseconds: number,
): string {
  return `2026-07-15T12:00:02.${String(
    executionIndex * 1_000 + offsetNanoseconds,
  ).padStart(9, "0")}Z`;
}

function classifyScorecardRun(input: {
  readonly systemId: string;
  readonly primarySystemId: string;
  readonly taskId: string;
  readonly firstTaskId: string;
  readonly seedSlot: number;
  readonly firstSeedSlot: number;
  readonly crossedSeedSlot: number;
}): ScorecardRunClassification {
  const primary = input.systemId === input.primarySystemId;
  const infrastructureSystem =
    primary || input.systemId === "comparator-one";
  const infrastructureInvalid =
    input.taskId === input.firstTaskId &&
    input.seedSlot === input.firstSeedSlot &&
    infrastructureSystem;
  const crossedSeedSuccess =
    input.systemId === "comparator-one" &&
    input.taskId === input.firstTaskId &&
    input.seedSlot === input.crossedSeedSlot;
  const successfulFix =
    !infrastructureInvalid && (primary || crossedSeedSuccess);

  let outcome: RunRecordDocument["outcome"] = "fail";
  if (infrastructureInvalid) {
    outcome = "infrastructure_invalid";
  } else if (successfulFix) {
    outcome = "pass";
  }

  if (successfulFix) {
    return {
      primary,
      infrastructureInvalid,
      successfulFix,
      outcome,
      criterionStatus: "passed",
      failureCount: 0,
    };
  }
  return {
    primary,
    infrastructureInvalid,
    successfulFix,
    outcome,
    criterionStatus: "failed",
    failureCount: 1,
  };
}

function requireExpectedArtifact(task: OperatorTaskDocument): ExpectedArtifact {
  const expectedArtifact = task.expectedArtifacts[0];
  if (!expectedArtifact) {
    throw new Error("test task is missing its required artifact");
  }
  return expectedArtifact;
}

function requireExecutionIndex(
  executionIndexByCell: ReadonlyMap<string, number>,
  systemId: string,
  taskId: string,
  seedSlot: number,
): number {
  const executionIndex = executionIndexByCell.get(
    scorecardCellKey(systemId, taskId, seedSlot),
  );
  if (executionIndex === undefined) {
    throw new Error("missing planned execution cell");
  }
  return executionIndex;
}

function artifactEventType(
  role: RecordedRunArtifact["role"],
): EvidenceEventType {
  switch (role) {
    case "independent_review":
      return "review.completed";
    case "risk_register":
      return "risk.recorded";
    default:
      return "artifact.recorded";
  }
}

function createTypedEvidenceAppender(input: {
  readonly pending: PendingEvidenceFixture;
  readonly runId: string;
  readonly occurredAt: string;
  readonly redactionPolicyDigest: Sha256Digest;
  readonly defaultBinaryDigest: Sha256Digest;
}): AppendTypedEvidence {
  return (
    type,
    label,
    payloadBytes,
    mediaType = "application/json",
    binaryDigest = input.defaultBinaryDigest,
  ) =>
    appendFixtureEvent(input.pending, {
      eventId: `${input.runId}-${label}`,
      occurredAt: input.occurredAt,
      producer: {
        identity: "test-evaluator",
        version: "1.0.0",
        binaryDigest,
      },
      type,
      mediaType,
      redactionPolicyDigest: input.redactionPolicyDigest,
      payloadBytes,
    });
}

function appendOptionalFailureEvidence(
  appendTypedEvidence: AppendTypedEvidence,
  successfulFix: boolean,
  type: EvidenceEventType,
  label: string,
  payloadBytes: Buffer,
): Sha256Digest | undefined {
  if (successfulFix) return undefined;
  return appendTypedEvidence(type, label, payloadBytes);
}

function includeOptionalDigest(
  digests: readonly Sha256Digest[],
  optionalDigest: Sha256Digest | undefined,
): Sha256Digest[] {
  if (optionalDigest === undefined) return [...digests];
  return [...digests, optionalDigest];
}

function counterpartRunId(input: {
  readonly classification: ScorecardRunClassification;
  readonly preregistration: PreregistrationDocument;
  readonly taskId: string;
  readonly seedSlot: number;
}): string {
  if (input.classification.primary) {
    return `comparator-one-${input.taskId}-${input.seedSlot}`;
  }
  return `${input.preregistration.primarySystemId}-${input.taskId}-${input.seedSlot}`;
}

function appendInfrastructureInvalidPairs(input: {
  readonly appendTypedEvidence: AppendTypedEvidence;
  readonly classification: ScorecardRunClassification;
  readonly preregistration: PreregistrationDocument;
  readonly task: OperatorTaskDocument;
  readonly seedSlot: number;
}): RunRecordDocument["infrastructureInvalidPairs"] {
  if (!input.classification.infrastructureInvalid) return [];
  const classifierStatement = createInfrastructureClassificationStatement({
    comparisonId: "agenc-vs-one",
    taskId: input.task.taskId,
    seedSlot: input.seedSlot,
    incidentId: "evaluator-incident-one",
    reason: "evaluator_host_failure",
    classifierVersion: input.preregistration.exclusions.classifierVersion,
    classifierImplementationDigest:
      input.preregistration.exclusions.classifierImplementation.digest,
  });
  const classifierEvidence = input.appendTypedEvidence(
    "infrastructure.classified",
    "infrastructure-classified",
    Buffer.from(canonicalizeJson(classifierStatement)),
    "application/vnd.agenc.eval-infrastructure-classification+json",
    input.preregistration.exclusions.classifierImplementation.digest,
  );
  return [
    {
      comparisonId: "agenc-vs-one",
      counterpartRunId: counterpartRunId({
        classification: input.classification,
        preregistration: input.preregistration,
        taskId: input.task.taskId,
        seedSlot: input.seedSlot,
      }),
      reason: "evaluator_host_failure",
      incidentId: "evaluator-incident-one",
      evidenceDigest: classifierEvidence,
      classifierVersion: input.preregistration.exclusions.classifierVersion,
      classifierImplementationDigest:
        input.preregistration.exclusions.classifierImplementation.digest,
    },
  ];
}

function makeScorecardUsage(): RunRecordDocument["usage"] {
  return {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 130,
    providerCost: {
      status: "reported",
      amount: "0.01",
      currency: "USD",
      source: "provider_reported",
    },
    toolCalls: 2,
    turns: 1,
    retries: 0,
  };
}

function makeScorecardVerifier(
  task: OperatorTaskDocument,
  classification: ScorecardRunClassification,
  verifierEvidence: Sha256Digest,
): RunRecordDocument["verifier"] {
  return {
    verifierId: task.hiddenVerifier.id,
    verifierVersion: task.hiddenVerifier.version,
    bundleDigest: task.hiddenVerifier.bundle.digest,
    result: classification.criterionStatus,
    assertionCount: 1,
    passedAssertions: classification.successfulFix ? 1 : 0,
    evidenceDigest: verifierEvidence,
  };
}

function makeScorecardTrustAssessment(input: {
  readonly preregistration: PreregistrationDocument;
  readonly classification: ScorecardRunClassification;
  readonly artifactEvidence: readonly Sha256Digest[];
  readonly policyEvidence: readonly Sha256Digest[];
  readonly effectEvidence: Sha256Digest;
  readonly recoveryEvidence: Sha256Digest;
  readonly interventionEvidence: Sha256Digest;
  readonly verifierEvidence: Sha256Digest;
  readonly failureEvidence: ScorecardFailureEvidence;
}): AssessedTrustAssessment {
  return {
    status: "assessed",
    trustedFix: input.classification.successfulFix,
    assessmentImplementationDigest:
      input.preregistration.evaluator.trustAssessmentImplementation.digest,
    criteria: {
      hiddenVerifier: {
        status: input.classification.criterionStatus,
        evidenceDigests: [input.verifierEvidence],
        inaccessibleDuringRun: true,
        deterministicAssertionsPassed: input.classification.successfulFix,
      },
      policyAndBudget: {
        status: "passed",
        evidenceDigests: input.policyEvidence,
        permissionEscapes: 0,
        sandboxEscapes: 0,
        concurrencyEscapes: 0,
        budgetOverruns: 0,
        unresolvedUsageFullyReserved: true,
      },
      effectSafety: {
        status: input.classification.criterionStatus,
        evidenceDigests: includeOptionalDigest(
          [input.effectEvidence],
          input.failureEvidence.unknownEffectEvidence,
        ),
        duplicatedUncertainMutations: 0,
        unsafeAutomaticRetries: 0,
        unresolvedUnknownOutcomes: input.classification.failureCount,
      },
      recoveryIntegrity: {
        status: input.classification.criterionStatus,
        evidenceDigests: includeOptionalDigest(
          [input.recoveryEvidence],
          input.failureEvidence.eventGapEvidence,
        ),
        scheduledFaults: 0,
        successfulRecoveries: 0,
        eventGaps: input.classification.failureCount,
        hiddenEventLoss: 0,
      },
      evidenceBundle: {
        status: "passed",
        evidenceDigests: input.artifactEvidence,
        schemaValid: true,
        hashesValid: true,
        unresolvedReviewBlockers: 0,
        missingRequiredArtifacts: 0,
      },
      interventionFree: {
        status: "passed",
        evidenceDigests: [input.interventionEvidence],
        undeclaredInterventions: 0,
      },
    },
  };
}

function makeScorecardRunRecord(input: {
  readonly preregistration: PreregistrationDocument;
  readonly preregistrationReceipt: PreregistrationReceiptDocument;
  readonly suite: SuiteManifestDocument;
  readonly task: OperatorTaskDocument;
  readonly system: SystemConfigurationPin;
  readonly seedSlot: number;
  readonly executionIndex: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly usage: RunRecordDocument["usage"];
  readonly artifacts: readonly RecordedRunArtifact[];
  readonly verifier: RunRecordDocument["verifier"];
  readonly verified: VerifiedEvidenceLedger;
  readonly classification: ScorecardRunClassification;
  readonly trustAssessment: AssessedTrustAssessment;
  readonly infrastructureInvalidPairs: RunRecordDocument["infrastructureInvalidPairs"];
}): RunRecordDocument {
  const runId = input.verified.inspection.runId;
  const agentTask = projectTaskForAgent(input.task);
  return withDocumentDigest<RunRecordDocument>({
    kind: "agenc.eval.run-record",
    contractVersion: EVAL_CONTRACT_VERSION,
    runId,
    experimentId: input.preregistration.experimentId,
    preregistrationDigest: input.preregistration.documentDigest,
    preregistrationReceiptDigest: input.preregistrationReceipt.documentDigest,
    suiteManifestDigest: input.suite.documentDigest,
    taskId: input.task.taskId,
    operatorTaskDigest: input.task.documentDigest,
    agentTaskDigest: agentTask.documentDigest,
    repositoryCluster: input.task.repository.cluster,
    systemId: input.system.systemId,
    trialIndex: input.preregistration.trialDesign.seedSlots.indexOf(
      input.seedSlot,
    ),
    seedSlot: input.seedSlot,
    executionIndex: input.executionIndex,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    wallTimeMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt),
    evaluator: {
      commit: input.preregistration.evaluator.commit,
      image: input.preregistration.evaluator.image,
      harnessConfigDigest:
        input.preregistration.evaluator.harnessConfigDigest,
      analysisImplementationDigest:
        input.preregistration.evaluator.analysisImplementation.digest,
      trustAssessmentImplementationDigest:
        input.preregistration.evaluator.trustAssessmentImplementation.digest,
    },
    system: {
      systemId: input.system.systemId,
      release: input.system.release,
      commit: input.system.commit,
      packageDigest: input.system.package.digest,
      image: input.system.image,
      agentConfigDigest: input.system.agentConfigDigest,
      publicConfigDigest: input.system.publicConfigDigest,
      redactedConfigFields: input.system.redactedConfigFields,
      systemPromptDigest: input.system.systemPromptDigest,
      toolManifestDigest: input.system.toolManifestDigest,
      installCommandDigest: input.system.installCommandDigest,
      environmentClassDigest: input.system.environmentClassDigest,
      provider: input.system.provider,
      requestedModelId: input.system.requestedModelId,
      immutableModelId: input.system.immutableModelId,
      providerReportedModelId: input.system.immutableModelId,
      generationParameters: input.system.generationParameters,
      retryPolicy: input.system.retryPolicy,
      approvalPolicy: input.system.approvalPolicy,
    },
    environment: {
      operatingSystem: "linux",
      architecture: "x64",
      kernel: "test-kernel",
      platform: input.task.environment.platform,
      hardwareClass: input.task.environment.hardwareClass,
      image: input.task.environment.image,
      toolchain: input.task.environment.toolchain,
      networkPolicy: input.task.networkPolicy,
      permissionPolicyDigest: input.task.permissionPolicy.policyDigest,
    },
    resetReceipt: {
      recipeDigest: input.preregistration.resetPolicy.digest,
      repositoryCommit: input.task.repository.commit,
      workspaceFingerprint: digest(`${runId}:workspace`),
      cacheEmpty: true,
      memoryEmpty: true,
      sessionFresh: true,
    },
    usage: input.usage,
    approvals: [],
    interventions: [],
    artifacts: input.artifacts,
    verifier: input.verifier,
    evidence: evidenceReference(input.verified),
    outcome: input.classification.outcome,
    verifiedFix: input.classification.successfulFix,
    trustAssessment: input.trustAssessment,
    infrastructureInvalidPairs: input.infrastructureInvalidPairs,
  });
}

async function makeScorecardCellFixture(input: {
  readonly preregistration: PreregistrationDocument;
  readonly preregistrationReceipt: PreregistrationReceiptDocument;
  readonly suite: SuiteManifestDocument;
  readonly task: OperatorTaskDocument;
  readonly system: SystemConfigurationPin;
  readonly seedSlot: number;
  readonly seedSlots: readonly [number, number];
  readonly firstTaskId: string;
  readonly executionIndex: number;
  readonly provider: EvidenceAnchorProvider;
}): Promise<ScorecardCellFixture> {
  const runId = `${input.system.systemId}-${input.task.taskId}-${input.seedSlot}`;
  const startedAt = scorecardTimestampAt(input.executionIndex, 0);
  const evidenceAt = scorecardTimestampAt(input.executionIndex, 2);
  const finishedAt = scorecardTimestampAt(input.executionIndex, 10);
  const sealedAt = scorecardTimestampAt(input.executionIndex, 12);
  const context: EvidenceLedgerContext = {
    runId,
    contractDigest: input.preregistration.documentDigest,
    taskId: input.task.taskId,
    systemId: input.system.systemId,
  };
  const pending: PendingEvidenceFixture = { context, events: [], inputs: [] };
  const classification = classifyScorecardRun({
    systemId: input.system.systemId,
    primarySystemId: input.preregistration.primarySystemId,
    taskId: input.task.taskId,
    firstTaskId: input.firstTaskId,
    seedSlot: input.seedSlot,
    firstSeedSlot: input.seedSlots[0],
    crossedSeedSlot: input.seedSlots[1],
  });
  const analysisProducer = {
    identity: "test-evaluator",
    version: "1.0.0",
    binaryDigest:
      input.preregistration.evaluator.analysisImplementation.digest,
  } as const;
  const redactionPolicyDigest =
    input.preregistration.evidencePolicy.redactionPolicyDigest;
  appendFixtureEvent(pending, {
    eventId: `${runId}-start`,
    occurredAt: startedAt,
    producer: analysisProducer,
    type: "run.started",
    mediaType: "application/json",
    redactionPolicyDigest,
    payloadBytes: Buffer.from(`{\"runId\":${JSON.stringify(runId)}}`),
  });

  const artifactEntries = requiredArtifacts(
    runId,
    requireExpectedArtifact(input.task),
  );
  const appendTypedEvidence = createTypedEvidenceAppender({
    pending,
    runId,
    occurredAt: evidenceAt,
    redactionPolicyDigest,
    defaultBinaryDigest:
      input.preregistration.evaluator.analysisImplementation.digest,
  });
  const artifactEvidence = artifactEntries.map((entry) =>
    appendTypedEvidence(
      artifactEventType(entry.record.role),
      `artifact-${entry.record.role}`,
      entry.bytes,
      entry.record.mediaType,
    ),
  );
  const policyEvidence = (
    [
      "budget.reconciled",
      "policy.evaluated",
      "sandbox.evaluated",
      "usage.reported",
    ] as const
  ).map((type) =>
    appendTypedEvidence(type, type.replace(".", "-"), Buffer.from(type)),
  );
  const effectEvidence = appendTypedEvidence(
    "effect.result",
    "effect-result",
    Buffer.from("{\"duplicated\":0,\"unknown\":0}"),
  );
  const unknownEffectEvidence = appendOptionalFailureEvidence(
    appendTypedEvidence,
    classification.successfulFix,
    "effect.unknown_outcome",
    "effect-unknown-outcome",
    Buffer.from("{\"unresolved\":1}"),
  );
  const recoveryEvidence = appendTypedEvidence(
    "recovery.assessed",
    "recovery-assessed",
    Buffer.from("{\"faults\":0,\"gaps\":0}"),
  );
  const eventGapEvidence = appendOptionalFailureEvidence(
    appendTypedEvidence,
    classification.successfulFix,
    "event.gap",
    "event-gap",
    Buffer.from("{\"gaps\":1}"),
  );
  const failureEvidence: ScorecardFailureEvidence = {
    unknownEffectEvidence,
    eventGapEvidence,
  };
  const interventionEvidence = appendTypedEvidence(
    "intervention.recorded",
    "intervention-recorded",
    Buffer.from("{\"undeclared\":0}"),
  );
  const verifierEvidence = appendTypedEvidence(
    "verifier.completed",
    "verifier-completed",
    Buffer.from(
      classification.successfulFix
        ? "{\"passed\":true}"
        : "{\"passed\":false}",
    ),
  );
  const infrastructureInvalidPairs = appendInfrastructureInvalidPairs({
    appendTypedEvidence,
    classification,
    preregistration: input.preregistration,
    task: input.task,
    seedSlot: input.seedSlot,
  });
  const usage = makeScorecardUsage();
  const artifacts = artifactEntries.map((entry) => entry.record);
  const verifier = makeScorecardVerifier(
    input.task,
    classification,
    verifierEvidence,
  );
  const trustAssessment = makeScorecardTrustAssessment({
    preregistration: input.preregistration,
    classification,
    artifactEvidence,
    policyEvidence,
    effectEvidence,
    recoveryEvidence,
    interventionEvidence,
    verifierEvidence,
    failureEvidence,
  });
  appendTypedEvidence(
    "trust.assessed",
    "trust-assessed",
    Buffer.from(
      canonicalizeJson(
        createTrustAssessmentStatement({
          runId,
          experimentId: input.preregistration.experimentId,
          taskId: input.task.taskId,
          systemId: input.system.systemId,
          startedAt,
          finishedAt,
          outcome: classification.outcome,
          verifiedFix: classification.successfulFix,
          usage,
          approvals: [],
          interventions: [],
          artifacts,
          verifier,
          trustAssessment,
          infrastructureInvalidPairs,
        }),
      ),
      "utf8",
    ),
    "application/vnd.agenc.eval-trust-assessment+json",
    input.preregistration.evaluator.trustAssessmentImplementation.digest,
  );
  appendFixtureEvent(pending, {
    eventId: `${runId}-finish`,
    occurredAt: finishedAt,
    producer: analysisProducer,
    type: "run.finished",
    mediaType: "application/json",
    redactionPolicyDigest,
    payloadBytes: Buffer.from(
      canonicalizeJson({ outcome: classification.outcome }),
    ),
  });
  const verified = await finishEvidenceFixture(
    pending,
    sealedAt,
    input.provider,
    input.preregistration.evidencePolicy.platformProtectionVerifierDigest,
  );
  const ledgerInput: ScorecardLedgerInput = {
    context,
    sealedAt,
    events: pending.inputs,
  };
  const run = makeScorecardRunRecord({
    preregistration: input.preregistration,
    preregistrationReceipt: input.preregistrationReceipt,
    suite: input.suite,
    task: input.task,
    system: input.system,
    seedSlot: input.seedSlot,
    executionIndex: input.executionIndex,
    startedAt,
    finishedAt,
    usage,
    artifacts,
    verifier,
    verified,
    classification,
    trustAssessment,
    infrastructureInvalidPairs,
  });
  return { run, verifiedEvidence: verified, ledgerInput };
}

async function makeScorecardMatrixFixture(input: {
  readonly preregistration: PreregistrationDocument;
  readonly preregistrationReceipt: PreregistrationReceiptDocument;
  readonly suite: SuiteManifestDocument;
  readonly seedSlots: readonly [number, number];
  readonly executionIndexByCell: ReadonlyMap<string, number>;
  readonly provider: EvidenceAnchorProvider;
}): Promise<ScorecardMatrixFixture> {
  const firstTask = input.suite.tasks[0];
  if (!firstTask) throw new Error("scorecard suite has no tasks");

  const runs: RunRecordDocument[] = [];
  const verifiedEvidence: VerifiedEvidenceLedger[] = [];
  const ledgerInputsByRun = new Map<string, ScorecardLedgerInput>();
  for (const system of input.preregistration.systems) {
    for (const task of input.suite.tasks) {
      for (const seedSlot of input.preregistration.trialDesign.seedSlots) {
        const executionIndex = requireExecutionIndex(
          input.executionIndexByCell,
          system.systemId,
          task.taskId,
          seedSlot,
        );
        const fixture = await makeScorecardCellFixture({
          preregistration: input.preregistration,
          preregistrationReceipt: input.preregistrationReceipt,
          suite: input.suite,
          task,
          system,
          seedSlot,
          seedSlots: input.seedSlots,
          firstTaskId: firstTask.taskId,
          executionIndex,
          provider: input.provider,
        });
        runs.push(fixture.run);
        verifiedEvidence.push(fixture.verifiedEvidence);
        ledgerInputsByRun.set(fixture.run.runId, fixture.ledgerInput);
      }
    }
  }
  return { runs, verifiedEvidence, ledgerInputsByRun };
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
  const executionIndexByCell = new Map(
    plannedOrder.map((cell, index) => [
      scorecardCellKey(cell.systemId, cell.taskId, cell.seedSlot),
      index,
    ]),
  );
  const { runs, verifiedEvidence, ledgerInputsByRun } =
    await makeScorecardMatrixFixture({
      preregistration,
      preregistrationReceipt,
      suite,
      seedSlots,
      executionIndexByCell,
      provider,
    });

  const completeRunMatrixDigest = digestCanonicalJson(
    "agenc.eval.complete-run-matrix.v1",
    [...runs]
      .map((run) => ({
        runId: run.runId,
        runDigest: run.documentDigest,
        sealDigest: run.evidence.sealDigest,
      }))
      .sort((left, right) => left.runId.localeCompare(right.runId, "en")),
  );
  const evidenceSealSetDigest = digestCanonicalJson(
    "agenc.eval.evidence-seal-set.v1",
    [...runs]
      .map((run) => run.evidence.sealDigest)
      .sort((left, right) => left.localeCompare(right, "en")),
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
      [...runs]
        .map((run) => run.runId)
        .sort((left, right) => left.localeCompare(right, "en")),
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
