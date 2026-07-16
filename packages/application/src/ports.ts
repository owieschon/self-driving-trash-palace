import type {
  Approval,
  Attempt,
  AttemptId,
  Capability,
  ClarificationAnswer,
  ClarificationRequest,
  ClarificationRequestId,
  ContextReceipt,
  ContextReceiptId,
  CrewMember,
  CrewPreference,
  CrewSchedule,
  Device,
  EvidenceId,
  EventId,
  Execution,
  ExecutionId,
  ExecutionMilestoneFailure,
  ExecutionMilestoneName,
  GatewayCommandId,
  GatewayDispatchResult,
  IdentityTag,
  IdentityTelemetryKeyId,
  MissionPhase,
  OrganizationId,
  Mission,
  MissionEvent,
  MissionId,
  Operation,
  OperationId,
  OperationOutcome,
  Palace,
  PalaceId,
  PersistedEvidenceRecord,
  Plan,
  PlanAction,
  PlanActionId,
  PlanId,
  ProtectedResourceVersion,
  Routine,
  RoutineId,
  RoutineStatus,
  RoutineVersion,
  RoutineVersionId,
  ReceiptId,
  RunId,
  Sha256,
  ToolCallId,
  ToolCallReceipt,
  Verification,
  VerificationAssertion,
} from '@trash-palace/core'
import type { FrozenApplicationProductEvidenceEnvelope } from '@trash-palace/observability'

import type {
  MissionExecutionContext,
  MissionFence,
  OpaqueMissionFenceToken,
} from './mission-fence.js'
import type {
  CancellationRecord,
  CompensatingPlanLink,
  ExecutionMilestoneUpdateResult,
  ExecutionReadinessResult,
  GatewayCallbackApplicationResult,
  GatewayDispatchClaimResult,
  GatewayDispatchFinalizationResult,
  GatewayEffectMaterialization,
  GatewayEffectMaterializationResult,
  GatewayEffectReconciliationResult,
  GatewayEffectRecord,
  GatewayPendingCancellationResult,
  JsonValue,
  OutboxMessage,
  PlanSimulationRecord,
  PlanValidationCheck,
  PlanValidationRecord,
  PlannedGatewayEffect,
  ReconciliationPoll,
  SimulationScenario,
  StoredExecution,
  StoredGatewayCallback,
  VerifiedGatewayCallback,
  IdentityArrivalExecutionEnqueueResult,
  IdentityTelemetryEvidenceAppendResult,
  IdentityTelemetryIngressProvenance,
  IdentityTelemetryVerificationKey,
  CaretakerRunCheckpoint,
  CaretakerRunCounters,
  CaretakerEvidenceProfile,
  CaretakerTerminalEvidenceDelivery,
  CaretakerTerminalEvidenceEnvelope,
  CaretakerRunMutationCheckpointKind,
  CaretakerPendingToolCall,
  CaretakerRunSnapshot,
  CaretakerTaskLedger,
} from './models.js'
import type { VerifiedIdentityTelemetry } from '@trash-palace/core'
import type { AuthContext } from './models.js'
import type { ProductEvidenceDelivery, ProductEvidenceEnqueueResult } from './product-evidence.js'

export interface ClockPort {
  now(): Date
}

export type IdKind =
  | 'approval'
  | 'attempt'
  | 'cancellation'
  | 'clarification_answer'
  | 'clarification_request'
  | 'execution'
  | 'evidence'
  | 'evidence_authority_receipt'
  | 'mission_event'
  | 'operation'
  | 'outbox'
  | 'plan'
  | 'run'
  | 'session'
  | 'verification'

export interface IdGeneratorPort {
  next(kind: IdKind): string
}

export interface EntropyPort {
  token(bytes: number): string
}

export interface SensitiveMutationGuardPort {
  assert(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): void
}

export interface CrewReadProjection {
  readonly crew: readonly CrewMember[]
  readonly identityTags: readonly IdentityTag[]
  readonly schedules: readonly CrewSchedule[]
  readonly preferences: readonly CrewPreference[]
}

export interface CapabilityReadProjection {
  readonly devices: readonly Device[]
  readonly capabilities: readonly Capability[]
}

export interface KnowledgeSearchResult {
  readonly sourceId: string
  readonly version: string
  readonly title: string
  readonly excerpt: string
}

export interface KnowledgeRepository {
  search(input: {
    readonly query: string
    readonly phase: MissionPhase
    readonly limit: number
  }): Promise<readonly KnowledgeSearchResult[]>
}

export interface RoutineReadProjection {
  readonly routines: readonly Routine[]
  readonly versions: readonly RoutineVersion[]
}

export interface RoutineDetailProjection {
  readonly routine: Routine
  readonly version: RoutineVersion
}

export interface PalaceRepository {
  get(palaceId: PalaceId): Promise<Palace | null>
}

export interface CrewRepository {
  list(palaceId: PalaceId, activeOnly: boolean): Promise<CrewReadProjection>
}

export interface CapabilityRepository {
  list(palaceId: PalaceId): Promise<CapabilityReadProjection>
}

export interface MissionRepository {
  get(missionId: MissionId): Promise<Mission | null>
  insert(mission: Mission): Promise<void>
  save(mission: Mission, expectedVersion: number): Promise<boolean>
  appendEvent(event: MissionEvent): Promise<void>
}

export interface ClarificationRepository {
  getRequest(requestId: ClarificationRequestId): Promise<ClarificationRequest | null>
  findRequestByIdempotencyKey(idempotencyKey: Sha256): Promise<ClarificationRequest | null>
  findLatestForMission(missionId: MissionId): Promise<ClarificationRequest | null>
  findPendingForMission(missionId: MissionId): Promise<ClarificationRequest | null>
  insertRequest(request: ClarificationRequest): Promise<void>
  getAnswerForRequest(requestId: ClarificationRequestId): Promise<ClarificationAnswer | null>
  findAnswerByIdempotencyKey(idempotencyKey: Sha256): Promise<ClarificationAnswer | null>
  insertAnswer(input: {
    readonly answer: ClarificationAnswer
    readonly resolvedRequest: ClarificationRequest
  }): Promise<void>
}

export interface PlanRepository {
  get(planId: PlanId): Promise<Plan | null>
  getLatestForMission(missionId: MissionId): Promise<Plan | null>
  insert(plan: Plan): Promise<void>
  save(plan: Plan): Promise<void>
}

export interface ApprovalRepository {
  get(approvalId: string): Promise<Approval | null>
  findForPlan(planId: PlanId): Promise<Approval | null>
  insert(approval: Approval): Promise<void>
  save(approval: Approval): Promise<void>
}

export interface OperationRepository {
  get(operationId: OperationId): Promise<Operation | null>
  findByPlanAction(planId: PlanId, actionId: PlanActionId): Promise<Operation | null>
  listForMission(missionId: MissionId): Promise<readonly Operation[]>
  insert(operation: Operation): Promise<void>
  save(operation: Operation): Promise<void>
}

export interface AttemptRepository {
  listForOperation(operationId: OperationId): Promise<readonly Attempt[]>
  insert(attempt: Attempt): Promise<void>
  save(attempt: Attempt): Promise<void>
}

export interface RoutineRepository {
  list(palaceId: PalaceId, statuses?: readonly RoutineStatus[]): Promise<RoutineReadProjection>
  get(routineId: RoutineId, versionId?: RoutineVersionId): Promise<RoutineDetailProjection | null>
  getCurrentVersion(routineId: string): Promise<ProtectedResourceVersion | null>
  applyApprovedAction(plan: Plan, action: PlanAction): Promise<OperationOutcome>
}

export interface OutboxRepository {
  findByDeduplicationKey(deduplicationKey: string): Promise<OutboxMessage | null>
  insert(message: OutboxMessage): Promise<void>
  markDispatched(messageId: string, ownerId: string, dispatchedAt: string): Promise<boolean>
  release(
    messageId: string,
    ownerId: string,
    availableAt: string,
    errorCode: string,
  ): Promise<boolean>
}

export interface GatewayEffectRepository {
  get(commandId: GatewayCommandId): Promise<GatewayEffectRecord | null>
  listForOperation(operationId: OperationId): Promise<readonly GatewayEffectRecord[]>
  materialize(input: GatewayEffectMaterialization): Promise<GatewayEffectMaterializationResult>
  claimDispatch(input: {
    readonly operationId: OperationId
    readonly commandId: GatewayCommandId
    readonly generation: number
    readonly attemptId: AttemptId
    readonly claimedAt: string
  }): Promise<GatewayDispatchClaimResult | null>
  finalizeDispatch(input: {
    readonly operationId: OperationId
    readonly commandId: GatewayCommandId
    readonly generation: number
    readonly attemptId: AttemptId
    readonly result: GatewayDispatchResult
    readonly completedAt: string
    readonly reconciliationOutboxId: string
  }): Promise<GatewayDispatchFinalizationResult | null>
  applyCallback(input: {
    readonly callback: StoredGatewayCallback
    readonly evidence: readonly PersistedEvidenceRecord[]
  }): Promise<GatewayCallbackApplicationResult | null>
  cancelPendingForMission(input: {
    readonly missionId: MissionId
    readonly requestedAt: string
  }): Promise<GatewayPendingCancellationResult>
  reconcile(input: {
    readonly operationId: OperationId
    readonly commandId: GatewayCommandId
    readonly generation: number
    readonly reconciledAt: string
    readonly nextPollAt: string
    readonly maximumAttempts: number
    readonly dispatchOutboxId: string
    readonly reconciliationOutboxId: string
  }): Promise<GatewayEffectReconciliationResult | null>
}

export interface ExecutionRepository {
  get(executionId: ExecutionId): Promise<StoredExecution | null>
  list(input: {
    readonly routineId?: RoutineId
    readonly missionId?: MissionId
    readonly limit: number
  }): Promise<readonly Execution[]>
  findForOperation(operationId: OperationId): Promise<StoredExecution | null>
  listForMission(missionId: MissionId): Promise<readonly StoredExecution[]>
  insert(execution: StoredExecution): Promise<void>
  advanceMilestone(input: {
    readonly operationId: OperationId
    readonly milestone: ExecutionMilestoneName
    readonly commandId: GatewayCommandId | null
    readonly evidenceId: EvidenceId
    readonly resolvedAt: string
    readonly failure: ExecutionMilestoneFailure | null
  }): Promise<ExecutionMilestoneUpdateResult | null>
  evaluateReadiness(input: {
    readonly missionId: MissionId
    readonly operationId: OperationId
    readonly executionId: ExecutionId
    readonly evaluatedAt: string
  }): Promise<ExecutionReadinessResult | null>
}

export interface ContextReceiptRepository {
  get(receiptId: ContextReceiptId): Promise<ContextReceipt | null>
  insert(receipt: ContextReceipt): Promise<void>
}

export interface EvidenceRepository {
  get(evidenceId: EvidenceId): Promise<PersistedEvidenceRecord | null>
  appendMany(evidence: readonly PersistedEvidenceRecord[]): Promise<void>
  listForMission(missionId: MissionId): Promise<readonly PersistedEvidenceRecord[]>
}

export interface IdentityTelemetryEvidenceRepository {
  appendVerified(input: {
    readonly record: PersistedEvidenceRecord
    readonly provenance: IdentityTelemetryIngressProvenance
  }): Promise<IdentityTelemetryEvidenceAppendResult>
}

export interface IdentityTelemetrySubjectRepository {
  get(input: {
    readonly palaceId: PalaceId
    readonly identityTagId: IdentityTag['id']
  }): Promise<Readonly<{ tag: IdentityTag; crew: CrewMember | null }> | null>
}

export interface IdentityTelemetryExecutionTriggerRepository {
  enqueueVerifiedArrival(input: {
    readonly record: PersistedEvidenceRecord
    readonly availableAt: string
  }): Promise<readonly IdentityArrivalExecutionEnqueueResult[]>
}

export interface IdentityTelemetryIngressRepositories {
  readonly missions: Pick<MissionRepository, 'get'>
  readonly identitySubjects: IdentityTelemetrySubjectRepository
  readonly evidence: IdentityTelemetryEvidenceRepository
  readonly executionTriggers: IdentityTelemetryExecutionTriggerRepository
}

export interface IdentityTelemetryIngressUnitOfWorkPort {
  runIdentityTelemetry<Result>(
    organizationId: OrganizationId,
    work: (repositories: IdentityTelemetryIngressRepositories) => Promise<Result>,
  ): Promise<Result>
}

export interface VerificationRepository {
  findForMission(missionId: MissionId): Promise<Verification | null>
  insert(verification: Verification): Promise<void>
}

export interface MissionLeaseRepository {
  acquire(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly ownerId: string
    readonly token: OpaqueMissionFenceToken
    readonly ttlMilliseconds: number
  }): Promise<MissionFence | null>
  renew(fence: MissionFence, ttlMilliseconds: number): Promise<MissionFence | null>
  release(fence: MissionFence): Promise<boolean>
}

export interface CancellationRepository {
  findForMission(missionId: MissionId): Promise<CancellationRecord | null>
  insert(record: CancellationRecord): Promise<void>
}

export interface CompensatingPlanRepository {
  findByPlan(planId: PlanId): Promise<CompensatingPlanLink | null>
  insert(link: CompensatingPlanLink): Promise<void>
}

export interface PlanAssessmentRepository {
  saveValidation(record: PlanValidationRecord): Promise<void>
  getValidation(planId: PlanId): Promise<PlanValidationRecord | null>
  saveSimulation(record: PlanSimulationRecord): Promise<void>
  listSimulations(planId: PlanId): Promise<readonly PlanSimulationRecord[]>
}

export interface ReconciliationRepository {
  listForOperation(operationId: OperationId): Promise<readonly ReconciliationPoll[]>
  insert(poll: ReconciliationPoll): Promise<void>
}

export interface ProductEvidenceRepository {
  enqueue(input: {
    readonly missionId: MissionId
    readonly envelope: FrozenApplicationProductEvidenceEnvelope
  }): Promise<ProductEvidenceEnqueueResult>
}

/** System-scoped worker delivery port. It cannot mutate product-domain state. */
export interface SystemProductEvidenceDeliveryPort {
  listPending(limit: number): Promise<readonly ProductEvidenceDelivery[]>
  acknowledge(input: {
    readonly logicalEventId: EventId
    readonly eventHash: Sha256
    readonly captureStatus: 'duplicate' | 'stored'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'>
}

export type CaretakerRunStartResult = Readonly<{
  kind: 'replayed' | 'resumed' | 'started'
  snapshot: CaretakerRunSnapshot
}>

export type CaretakerRunCheckpointResult =
  | Readonly<{ kind: 'applied' | 'replayed'; snapshot: CaretakerRunSnapshot }>
  | Readonly<{ kind: 'version_conflict'; snapshot: CaretakerRunSnapshot }>

export interface CaretakerRunRepository {
  get(runId: RunId): Promise<CaretakerRunSnapshot | null>
  getLatestForMission(missionId: MissionId): Promise<CaretakerRunSnapshot | null>
  listCheckpoints(runId: RunId): Promise<readonly CaretakerRunCheckpoint[]>
  start(input: {
    readonly runId: RunId
    readonly missionId: MissionId
    readonly mutationKey: Sha256
    readonly evidenceProfile: CaretakerEvidenceProfile
    readonly occurredAt: string
  }): Promise<CaretakerRunStartResult>
  checkpoint(input: {
    readonly runId: RunId
    readonly expectedVersion: number
    readonly expectedTaskLedgerVersion: number
    readonly mutationKey: Sha256
    readonly kind: CaretakerRunMutationCheckpointKind
    readonly counters: CaretakerRunCounters
    readonly pendingToolCall: CaretakerPendingToolCall | null
    readonly taskLedger: CaretakerTaskLedger
    readonly evidenceRefs: readonly EvidenceId[]
    readonly terminalEvidence?: CaretakerTerminalEvidenceEnvelope | null
    readonly occurredAt: string
  }): Promise<CaretakerRunCheckpointResult>
}

/** Delivers already-authorized terminal evidence without acquiring or mutating a mission lease. */
export interface SystemCaretakerEvidenceDeliveryPort {
  get(runId: RunId): Promise<CaretakerTerminalEvidenceDelivery | null>
  listPending(limit: number): Promise<readonly CaretakerTerminalEvidenceDelivery[]>
  acknowledge(input: {
    readonly runId: RunId
    readonly eventHash: Sha256
    readonly captureStatus: 'stored' | 'duplicate'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'>
}

export interface TenantRepositories {
  readonly palaces: PalaceRepository
  readonly crews: CrewRepository
  readonly capabilities: CapabilityRepository
  readonly knowledge: KnowledgeRepository
  readonly missions: MissionRepository
  readonly clarifications: ClarificationRepository
  readonly plans: PlanRepository
  readonly approvals: ApprovalRepository
  readonly operations: OperationRepository
  readonly attempts: AttemptRepository
  readonly routines: RoutineRepository
  readonly outbox: OutboxRepository
  readonly gatewayEffects: GatewayEffectRepository
  readonly executions: ExecutionRepository
  readonly contextReceipts: ContextReceiptRepository
  readonly evidence: EvidenceRepository
  readonly verifications: VerificationRepository
  readonly missionLeases: MissionLeaseRepository
  readonly cancellations: CancellationRepository
  readonly compensatingPlans: CompensatingPlanRepository
  readonly planAssessments: PlanAssessmentRepository
  readonly reconciliations: ReconciliationRepository
  readonly productEvidence: ProductEvidenceRepository
  readonly caretakerRuns: CaretakerRunRepository
}

export interface UnitOfWorkPort {
  run<Result>(
    organizationId: OrganizationId,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result>
}

export interface MissionExecutionUnitOfWorkPort {
  runFenced<Result>(
    fence: MissionFence,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result>
}

export interface SystemOutboxPort {
  claimDue(input: {
    ownerId: string
    now: string
    claimExpiresAt: string
    limit: number
  }): Promise<readonly OutboxMessage[]>
}

export interface QueuePublishOptions {
  readonly deduplicationKey: string
  readonly startAfter?: string
}

export interface QueuePort {
  publish(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueuePublishOptions,
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }>
}

export interface ToolCallReceiptRepositoryPort {
  append(receipt: ToolCallReceipt): Promise<void>
  get(receiptId: ReceiptId): Promise<ToolCallReceipt | null>
  findByCallId(callId: ToolCallId): Promise<ToolCallReceipt | null>
}

export interface GatewayPort {
  dispatch(command: GatewayEffectRecord['command']): Promise<GatewayDispatchResult>
}

export interface ExecutionPlannerPort {
  planActivation(input: {
    readonly operation: Operation
    readonly plan: Plan
    readonly action: PlanAction
    readonly capabilities: CapabilityReadProjection
    readonly trigger: PersistedEvidenceRecord
    readonly at: string
  }): Promise<readonly PlannedGatewayEffect[]>
  planEvidence(input: {
    readonly operation: Operation
    readonly plan: Plan
    readonly action: PlanAction
    readonly capabilities: CapabilityReadProjection
    readonly evidence: PersistedEvidenceRecord
    readonly at: string
  }): Promise<readonly PlannedGatewayEffect[]>
}

export interface CallbackVerifierPort<RawCallback = unknown> {
  verify(raw: RawCallback): Promise<VerifiedGatewayCallback>
}

export interface IdentityTelemetryKeyResolverPort {
  resolve(keyId: IdentityTelemetryKeyId): Promise<IdentityTelemetryVerificationKey | null>
}

export interface IdentityTelemetryVerifierPort<RawTelemetry = unknown> {
  verify(raw: RawTelemetry): Promise<VerifiedIdentityTelemetry>
}

export interface PlanValidatorPort {
  validate(plan: Plan): Promise<readonly PlanValidationCheck[]>
}

export interface PlanSimulatorPort {
  simulate(
    plan: Plan,
    scenarios: readonly SimulationScenario[],
  ): Promise<Omit<PlanSimulationRecord, 'createdAt' | 'planId'>>
}

export interface DeterministicVerifierPort {
  evaluate(input: {
    readonly mission: Mission
    readonly plan: Plan
    readonly approval: Approval
    readonly operations: readonly Operation[]
    readonly contextReceipt: ContextReceipt
    readonly executions: readonly StoredExecution[]
    readonly evidence: readonly PersistedEvidenceRecord[]
  }): Promise<readonly VerificationAssertion[]>
}

export interface MissionRunnerPort {
  resume(input: {
    readonly mission: Mission
    readonly context: MissionExecutionContext
  }): Promise<'completed_checkpoint' | 'paused' | 'retry'>
}
