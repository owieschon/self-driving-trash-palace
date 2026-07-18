import {
  ApprovalSchema,
  AttemptIdSchema,
  AttemptSchema,
  CapabilitiesListOutputSchema,
  CapabilitySchema,
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  CrewMemberSchema,
  CrewPreferenceSchema,
  CrewScheduleSchema,
  CrewsListOutputSchema,
  DelegatedPermissionSchema,
  DeviceSchema,
  EvidenceIdSchema,
  ExecutionIdSchema,
  ExecutionsListInputSchema,
  ExecutionsListOutputSchema,
  ExecutionSchema,
  PersistedEvidenceRecordSchema,
  GatewayCallbackSchema,
  GatewayCommandIdSchema,
  GatewayCommandSchema,
  GatewayDispatchResultSchema,
  IdentityTagSchema,
  IdentityTelemetryEventSchema,
  KnowledgeSearchInputSchema,
  KnowledgeSearchOutputSchema,
  MembershipSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionPhaseSchema,
  MissionEventSchema,
  MissionSchema,
  OperationIdSchema,
  OperationTransportEvidenceSchema,
  OperationSchema,
  OrganizationIdSchema,
  OrganizationSchema,
  PalaceIdSchema,
  PalaceSchema,
  PlanSchema,
  ProtectedResourceVersionSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineSchema,
  RoutinesGetOutputSchema,
  RoutinesListOutputSchema,
  RoutineStatusSchema,
  RoutineVersionIdSchema,
  RoutineVersionSchema,
  RunIdSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  ToolCallChannelSchema,
  ToolCallIdSchema,
  ToolCallReceiptSchema,
  ToolInvocationReconciliationEvidenceSchema,
  ToolNameSchema,
  ToolTenantScopeHashSchema,
  UserSchema,
  UserIdSchema,
  VerificationSchema,
  assertApprovalAuthorizesPlan,
  classifyExecutionReadiness,
  classifyGatewayCallbackStatusTransition,
  computeGatewayCallbackPayloadHash,
  computeIdentityTelemetryPayloadHash,
  deriveIdentityTelemetryEvidenceId,
  deriveIdentityTelemetryReceiptId,
  hashToolResultSchema,
  hashToolValue,
  isRoutineReplacementAction,
  missionProgramKindOf,
  parseToolResult,
  projectToolSchema,
  validateGatewayCommandCallbackBinding,
  type Approval,
  type Attempt,
  type Capability,
  type ContextReceipt,
  type ContextReceiptId,
  type CrewMember,
  type CrewPreference,
  type CrewSchedule,
  type DelegatedPermission,
  type Device,
  type EvidenceId,
  type Execution,
  type ExecutionId,
  type ExecutionMilestoneFailure,
  type ExecutionMilestoneName,
  type GatewayCommand,
  type GatewayCommandId,
  type IdentityTag,
  type MissionPhase,
  type Membership,
  type MembershipId,
  type Mission,
  type MissionEvent,
  type MissionId,
  type Operation,
  type OperationId,
  type OperationOutcome,
  type Organization,
  type OrganizationId,
  type Palace,
  type PalaceId,
  type PersistedEvidenceRecord,
  type Plan,
  type PlanAction,
  type PlanActionId,
  type PlanId,
  type ProtectedResourceVersion,
  type Routine,
  type RoutineId,
  type RoutineStatus,
  type RoutineVersion,
  type RoutineVersionId,
  type RunId,
  type ReceiptId,
  type Sha256,
  type ToolCallId,
  type ToolCallReceipt,
  type ToolName,
  type User,
  type UserId,
  type Verification,
} from '@trash-palace/core'
import {
  ContextBundleSchema,
  ContextRequestSchema,
  InternalContextReceiptSchema,
  KnowledgeManifestSchema,
  KnowledgeSourceRecordSchema,
  PublicContextReceiptSchema,
  sha256Text,
  type ContextBundle,
  type ContextRequest,
  type InternalContextReceipt,
  type KnowledgeManifest,
  type KnowledgeSourceRecord,
  type PublicContextReceipt,
} from '@trash-palace/agent'
import {
  ExecutionDeadlineReferenceSchema,
  GatewayDispatchReferenceSchema,
  GatewayEffectAuthorizationSchema,
  GatewayEffectRecordSchema,
  GatewayEffectReconciliationReferenceSchema,
  IDENTITY_ARRIVAL_EXECUTION_TOPIC,
  IdentityArrivalExecutionEnqueueResultSchema,
  IdentityArrivalExecutionReferenceSchema,
  MissionReferenceSchema,
  OpaqueMissionFenceToken,
  OperationReconciliationReferenceSchema,
  IdentityTelemetryIngressProvenanceSchema,
  type GatewayCallbackApplicationResult,
  type GatewayDispatchClaimResult,
  type GatewayDispatchFinalizationResult,
  type GatewayEffectMaterialization,
  type GatewayEffectMaterializationResult,
  type GatewayEffectReconciliationResult,
  type GatewayEffectRecord,
  type GatewayPendingCancellationResult,
  type CaretakerRunRepository,
  type ClarificationRepository,
  type ExecutionMilestoneUpdateResult,
  type ExecutionReadinessResult,
  type MissionExecutionUnitOfWorkPort,
  type IdentityTelemetryEvidenceAppendResult,
  type IdentityTelemetryIngressRepositories,
  type IdentityTelemetryIngressUnitOfWorkPort,
  type IdentityArrivalExecutionEnqueueResult,
  type MissionFence,
  OpaqueToolInvocationClaimToken,
  type StoredExecution,
  type StoredGatewayCallback,
  type TenantRepositories,
  ToolInvocationExecutionClassSchema,
  identityArrivalExecutionOutboxIdentity,
  type ToolInvocationBinding,
  type ToolInvocationClaimInput,
  type ToolInvocationClaimResult,
  type ToolInvocationClaimedRecord,
  type ToolInvocationCompletedRecord,
  type ToolInvocationCompletionInput,
  type ToolInvocationCompletionResult,
  type ToolInvocationExecutionClass,
  type ToolInvocationLedgerPort,
} from '@trash-palace/application'
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from './client.js'
import { createPgCaretakerRunRepository } from './caretaker-run-repository.js'
import { createPgClarificationRepository } from './clarification-repository.js'
import { PgProductEvidenceRepository } from './product-evidence-delivery-repository.js'
import { createDatabaseId, hashCanonical, hashSecret } from './crypto.js'
import {
  ApprovalBindingError,
  DatabaseConflictError,
  DatabaseNotFoundError,
  MissionFenceRejectedError,
  OptimisticConcurrencyError,
  TenantBoundaryError,
  isRetryableTransactionError,
  translateDatabaseError,
} from './errors.js'
import type {
  CancellationRecord,
  CompensatingPlanLink,
  MissionLeaseRecord,
  OutboxMessage,
  PlanSimulationRecord,
  PlanValidationRecord,
  ReconciliationPoll,
} from './models.js'
import {
  accessTokens,
  approvalActions,
  approvalProtectedResources,
  approvals,
  attempts,
  auditEvents,
  cancellations,
  capabilities,
  compensatingPlanLinks,
  contextArtifacts,
  contextReceipts,
  contextRuns,
  crewMembers,
  crewPreferences,
  crewSchedules,
  devices,
  evidence,
  executionEvidence,
  executionMilestones,
  executions,
  gatewayCallbackEvidence,
  gatewayCallbacks,
  gatewayCommands,
  gatewayDispatches,
  gatewayEffectReconciliationPolls,
  gatewayEffects,
  identityTelemetryIngresses,
  identityTags,
  knowledgeSources,
  memberships,
  missionEvents,
  missionLeases,
  missions,
  operations,
  organizations,
  outboxMessages,
  palaces,
  planActions,
  planSimulations,
  planValidations,
  plans,
  reconciliationPolls,
  routineVersions,
  routines,
  sessions,
  toolCallReceiptEvidence,
  toolCallReceipts,
  toolInvocationEvidence,
  toolInvocations,
  users,
  verifications,
} from './schema.js'

function date(value: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`Invalid date-time: ${value}`)
  return parsed
}

function iso(value: Date): string {
  return value.toISOString()
}

function requiredDate(value: Date | null, field: string): Date {
  if (value === null) throw new DatabaseConflictError(`${field} must be present`)
  return value
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return leftSorted.every((value, index) => value === rightSorted[index])
}

export type PgMissionFence = MissionFence

interface MissionLeaseAcquisition {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly ownerId: string
  readonly token: OpaqueMissionFenceToken
  readonly ttlMilliseconds: number
}

interface ValidatedMissionFence {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly ownerId: string
  readonly epoch: number
  readonly token: OpaqueMissionFenceToken
  readonly tokenFingerprint: Sha256
}

function validateLeaseTtl(ttlMilliseconds: number): number {
  if (!Number.isInteger(ttlMilliseconds) || ttlMilliseconds < 1_000 || ttlMilliseconds > 300_000) {
    throw new RangeError('Mission lease TTL must be between one second and five minutes')
  }
  return ttlMilliseconds
}

function validateOwnerId(ownerId: string): string {
  if (ownerId.length < 1 || ownerId.length > 200) {
    throw new TypeError('Mission lease owner ID must contain 1 to 200 characters')
  }
  return ownerId
}

function storageFingerprint(token: OpaqueMissionFenceToken): Sha256 {
  if (!OpaqueMissionFenceToken.isAuthentic(token)) {
    throw new MissionFenceRejectedError()
  }
  try {
    return Sha256Schema.parse(token.storageFingerprint())
  } catch (error) {
    throw new MissionFenceRejectedError({ cause: error })
  }
}

function validateFence(fence: MissionFence): ValidatedMissionFence {
  if (!Number.isSafeInteger(fence.epoch) || fence.epoch < 1) {
    throw new MissionFenceRejectedError()
  }
  return {
    organizationId: OrganizationIdSchema.parse(fence.organizationId),
    missionId: MissionIdSchema.parse(fence.missionId),
    ownerId: validateOwnerId(fence.ownerId),
    epoch: fence.epoch,
    token: fence.token,
    tokenFingerprint: storageFingerprint(fence.token),
  }
}

async function databaseWallTime(executor: DatabaseTransaction): Promise<Date> {
  const result = await executor.execute(sql`SELECT clock_timestamp() AS database_now`)
  const value = (result.rows[0] as { database_now?: unknown } | undefined)?.database_now
  const databaseNow =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (databaseNow === null || Number.isNaN(databaseNow.valueOf())) {
    throw new DatabaseConflictError('Database returned an invalid wall clock timestamp')
  }
  return databaseNow
}

async function assertOperationTransportSourceBinding(
  executor: DatabaseTransaction,
  record: PersistedEvidenceRecord,
): Promise<void> {
  if (record.evidence.type !== 'operation_transport') return
  const transportEvidence = OperationTransportEvidenceSchema.parse(record.evidence)
  const [binding] = await executor
    .select({
      attemptOperationId: attempts.operationId,
      attemptTransport: attempts.transport,
      attemptStatus: attempts.status,
      attemptErrorCode: attempts.errorCode,
      attemptCompletedAt: attempts.completedAt,
      operationMissionId: operations.missionId,
      operationStatus: operations.status,
      operationCommittedAt: operations.committedAt,
      missionPalaceId: missions.palaceId,
    })
    .from(attempts)
    .innerJoin(
      operations,
      and(
        eq(operations.organizationId, attempts.organizationId),
        eq(operations.id, attempts.operationId),
      ),
    )
    .innerJoin(
      missions,
      and(
        eq(missions.organizationId, operations.organizationId),
        eq(missions.id, operations.missionId),
      ),
    )
    .where(
      and(
        eq(attempts.organizationId, transportEvidence.organizationId),
        eq(attempts.id, transportEvidence.attemptId),
        eq(attempts.operationId, transportEvidence.operationId),
      ),
    )
    .limit(1)
  if (
    !binding ||
    binding.attemptOperationId !== transportEvidence.operationId ||
    binding.attemptTransport !== 'worker' ||
    binding.attemptStatus !== 'unknown' ||
    binding.attemptErrorCode !== 'APPLICATION_RESPONSE_LOST' ||
    binding.attemptCompletedAt === null ||
    binding.operationMissionId !== transportEvidence.missionId ||
    binding.missionPalaceId !== transportEvidence.palaceId ||
    binding.operationStatus !== 'committed' ||
    binding.operationCommittedAt === null ||
    binding.operationCommittedAt.valueOf() > Date.parse(transportEvidence.observedAt) ||
    binding.attemptCompletedAt.valueOf() > Date.parse(transportEvidence.observedAt)
  ) {
    throw new DatabaseConflictError(
      'Application response-loss evidence is not bound to its committed operation attempt',
    )
  }
}

type PlanRow = typeof plans.$inferSelect
type ApprovalRow = typeof approvals.$inferSelect
type OperationRow = typeof operations.$inferSelect
type AttemptRow = typeof attempts.$inferSelect

function mapMission(row: typeof missions.$inferSelect): Mission {
  return MissionSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    palaceId: row.palaceId,
    initiatedBy: row.initiatedBy,
    programKind: row.programKind,
    objective: row.objective,
    constraints: row.constraints,
    successCriteriaIds: row.successCriteriaIds,
    state: { status: row.status, phase: row.phase },
    version: row.version,
    runId: row.runId,
    contextReceiptId: row.contextReceiptId,
    taskLedger: row.taskLedger,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function mapPlan(row: PlanRow, actions: readonly PlanAction[]): Plan {
  return PlanSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    palaceId: row.palaceId,
    revision: row.revision,
    hash: row.hash,
    status: row.status,
    objective: row.objective,
    constraints: row.constraints,
    actions,
    successCriteriaIds: row.successCriteriaIds,
    createdAt: iso(row.createdAt),
  })
}

function mapApproval(
  row: ApprovalRow,
  actionIds: readonly string[],
  protectedResources: readonly ProtectedResourceVersion[],
): Approval {
  return ApprovalSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    planId: row.planId,
    planHash: row.planHash,
    status: row.status,
    actionIds,
    protectedResources,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approverRole: row.approverRole,
    nonce: row.nonce,
    createdAt: iso(row.createdAt),
    approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
    expiresAt: iso(row.expiresAt),
  })
}

function mapOperation(row: OperationRow): Operation {
  return OperationSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    planId: row.planId,
    planActionId: row.planActionId,
    approvalId: row.approvalId,
    payloadHash: row.payloadHash,
    serverCreated: row.serverCreated,
    status: row.status,
    outcome: row.outcome,
    createdAt: iso(row.createdAt),
    committedAt: row.committedAt ? iso(row.committedAt) : null,
  })
}

function mapAttempt(row: AttemptRow): Attempt {
  return AttemptSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    operationId: row.operationId,
    sequence: row.sequence,
    transport: row.transport,
    ...(row.transport === 'gateway'
      ? { commandId: row.gatewayCommandId, generation: row.dispatchGeneration }
      : {}),
    status: row.status,
    retryable: row.retryable,
    error:
      row.errorCode === null || row.errorMessage === null
        ? null
        : { code: row.errorCode, message: row.errorMessage },
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  })
}

function mapPalace(row: typeof palaces.$inferSelect): Palace {
  return PalaceSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    timezone: row.timezone,
    batteryAvailablePercentage: row.batteryAvailablePercentage,
    createdAt: iso(row.createdAt),
  })
}

function mapRoutine(row: typeof routines.$inferSelect): Routine {
  return RoutineSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    palaceId: row.palaceId,
    name: row.name,
    activeVersionId: row.activeVersionId,
    createdAt: iso(row.createdAt),
  })
}

function mapRoutineVersion(row: typeof routineVersions.$inferSelect): RoutineVersion {
  return RoutineVersionSchema.parse({
    id: row.id,
    routineId: row.routineId,
    organizationId: row.organizationId,
    version: row.version,
    status: row.status,
    definition: row.definition,
    sourcePlanId: row.sourcePlanId,
    sourcePlanHash: row.sourcePlanHash,
    createdAt: iso(row.createdAt),
  })
}

function mapContextReceipt(row: typeof contextReceipts.$inferSelect): ContextReceipt {
  return ContextReceiptSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    runId: row.runId,
    policyHash: row.policyHash,
    toolRegistryHash: row.toolRegistryHash,
    sources: row.sources,
    createdAt: iso(row.createdAt),
  })
}

function mapOutbox(row: typeof outboxMessages.$inferSelect): OutboxMessage {
  return {
    id: row.id,
    organizationId: OrganizationIdSchema.parse(row.organizationId),
    topic: row.topic,
    deduplicationKey: row.deduplicationKey,
    payload: row.payload as OutboxMessage['payload'],
    status: row.status,
    availableAt: iso(row.availableAt),
    createdAt: iso(row.createdAt),
    claimedBy: row.claimedBy,
    claimExpiresAt: row.claimExpiresAt ? iso(row.claimExpiresAt) : null,
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    deliveryAttempts: row.deliveryAttempts,
    lastErrorCode: row.lastErrorCode,
  }
}

function mapAuthorization(
  kind: 'manual_activation' | 'mission_lease',
  epoch: number | null,
): Readonly<{ kind: 'manual' } | { kind: 'mission_lease'; epoch: number }> {
  return GatewayEffectAuthorizationSchema.parse(
    kind === 'manual_activation' ? { kind: 'manual' } : { kind: 'mission_lease', epoch },
  )
}

function sameAuthorization(
  left: Readonly<{ kind: 'manual' } | { kind: 'mission_lease'; epoch: number }>,
  right: Readonly<{ kind: 'manual' } | { kind: 'mission_lease'; epoch: number }>,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'manual') return true
  return right.kind === 'mission_lease' && left.epoch === right.epoch
}

export class PgTenantRepositories {
  public readonly organizationId: OrganizationId
  public readonly caretakerRuns: CaretakerRunRepository
  public readonly clarifications: ClarificationRepository
  public readonly productEvidence: PgProductEvidenceRepository
  private readonly fencedMissionId: MissionId | null
  private readonly fencedLeaseEpoch: number | null

  public constructor(
    private readonly executor: DatabaseTransaction,
    organizationId: OrganizationId,
    fencedMissionId: MissionId | null = null,
    fencedLeaseEpoch: number | null = null,
  ) {
    this.organizationId = OrganizationIdSchema.parse(organizationId)
    this.fencedMissionId = fencedMissionId === null ? null : MissionIdSchema.parse(fencedMissionId)
    if ((this.fencedMissionId === null) !== (fencedLeaseEpoch === null)) {
      throw new TypeError('Mission fence identity and epoch must be supplied together')
    }
    if (
      fencedLeaseEpoch !== null &&
      (!Number.isSafeInteger(fencedLeaseEpoch) || fencedLeaseEpoch < 1)
    ) {
      throw new TypeError('Mission fence epoch must be a positive safe integer')
    }
    this.fencedLeaseEpoch = fencedLeaseEpoch
    this.caretakerRuns = createPgCaretakerRunRepository({
      executor: this.executor,
      organizationId: this.organizationId,
      fence: { missionId: this.fencedMissionId, leaseEpoch: this.fencedLeaseEpoch },
    })
    this.clarifications = createPgClarificationRepository({
      executor: this.executor,
      organizationId: this.organizationId,
      fencedMissionId: this.fencedMissionId,
    })
    this.productEvidence = new PgProductEvidenceRepository(
      this.executor,
      this.organizationId,
      this.fencedMissionId,
    )
  }

  private assertInitialAuthorization(
    authorization: Readonly<{ kind: 'manual' } | { kind: 'mission_lease'; epoch: number }>,
  ): void {
    const parsed = GatewayEffectAuthorizationSchema.parse(authorization)
    if (this.fencedMissionId === null) {
      if (parsed.kind !== 'manual') {
        throw new MissionFenceRejectedError()
      }
      return
    }
    if (parsed.kind !== 'mission_lease' || parsed.epoch !== this.fencedLeaseEpoch) {
      throw new MissionFenceRejectedError()
    }
  }

  private assertTenant(recordOrganizationId: string): void {
    if (recordOrganizationId !== this.organizationId) {
      throw new TenantBoundaryError('Record does not belong to the authenticated organization')
    }
  }

  private assertMissionMutation(missionId: MissionId | string): void {
    if (this.fencedMissionId !== null && missionId !== this.fencedMissionId) {
      throw new TenantBoundaryError(
        'Fenced transaction cannot mutate records owned by another mission',
      )
    }
  }

  private assertUnfencedMutation(): void {
    if (this.fencedMissionId !== null) {
      throw new TenantBoundaryError(
        'Fenced transaction cannot perform a mutation without a mission binding',
      )
    }
  }

  private async assertPlanMutation(planId: PlanId | string): Promise<void> {
    if (this.fencedMissionId === null) return
    const [row] = await this.executor
      .select({ missionId: plans.missionId })
      .from(plans)
      .where(and(eq(plans.organizationId, this.organizationId), eq(plans.id, planId)))
      .limit(1)
    if (!row) throw new DatabaseNotFoundError('Plan')
    this.assertMissionMutation(row.missionId)
  }

  private async assertApprovalMutation(approvalId: string): Promise<void> {
    if (this.fencedMissionId === null) return
    const [row] = await this.executor
      .select({ missionId: approvals.missionId })
      .from(approvals)
      .where(and(eq(approvals.organizationId, this.organizationId), eq(approvals.id, approvalId)))
      .limit(1)
    if (!row) throw new DatabaseNotFoundError('Approval')
    this.assertMissionMutation(row.missionId)
  }

  private async assertOperationMutation(operationId: OperationId | string): Promise<void> {
    if (this.fencedMissionId === null) return
    const [row] = await this.executor
      .select({ missionId: operations.missionId })
      .from(operations)
      .where(
        and(eq(operations.organizationId, this.organizationId), eq(operations.id, operationId)),
      )
      .limit(1)
    if (!row) throw new DatabaseNotFoundError('Operation')
    this.assertMissionMutation(row.missionId)
  }

  private async validateOutboxReferences(message: OutboxMessage): Promise<{
    missionId: string | null
    operationId: string | null
    executionId: string | null
    commandId: string | null
    dispatchGeneration: number | null
  }> {
    const parsed =
      message.topic === 'gateway.dispatch'
        ? GatewayDispatchReferenceSchema.parse(message.payload)
        : message.topic === 'gateway.effect.reconcile'
          ? GatewayEffectReconciliationReferenceSchema.parse(message.payload)
          : message.topic === IDENTITY_ARRIVAL_EXECUTION_TOPIC
            ? IdentityArrivalExecutionReferenceSchema.parse(message.payload)
            : message.topic === 'execution.deadline'
              ? ExecutionDeadlineReferenceSchema.parse(message.payload)
              : message.topic === 'mission.resume' || message.topic === 'mission.verify'
                ? MissionReferenceSchema.parse(message.payload)
                : OperationReconciliationReferenceSchema.parse(message.payload)
    this.assertTenant(parsed.organizationId)

    if ('missionId' in parsed) this.assertMissionMutation(parsed.missionId)
    if ('operationId' in parsed) await this.assertOperationMutation(parsed.operationId)

    if (message.topic === 'gateway.dispatch' || message.topic === 'gateway.effect.reconcile') {
      const reference = GatewayDispatchReferenceSchema.parse(parsed)
      const [binding] = await this.executor
        .select({ generation: gatewayDispatches.generation })
        .from(gatewayCommands)
        .innerJoin(
          gatewayDispatches,
          and(
            eq(gatewayDispatches.organizationId, gatewayCommands.organizationId),
            eq(gatewayDispatches.commandId, gatewayCommands.id),
            eq(gatewayDispatches.generation, reference.generation),
          ),
        )
        .where(
          and(
            eq(gatewayCommands.organizationId, this.organizationId),
            eq(gatewayCommands.id, reference.commandId),
            eq(gatewayCommands.operationId, reference.operationId),
          ),
        )
        .limit(1)
      if (!binding) throw new DatabaseConflictError('Outbox gateway reference is not materialized')
      return {
        missionId: null,
        operationId: reference.operationId,
        executionId: null,
        commandId: reference.commandId,
        dispatchGeneration: reference.generation,
      }
    }
    if (message.topic === IDENTITY_ARRIVAL_EXECUTION_TOPIC) {
      const reference = IdentityArrivalExecutionReferenceSchema.parse(parsed)
      const [binding] = await this.executor
        .select({
          evidencePayload: evidence.payload,
          authorityReceipt: evidence.authorityReceipt,
          persistedAt: evidence.persistedAt,
        })
        .from(executions)
        .innerJoin(
          operations,
          and(
            eq(operations.organizationId, executions.organizationId),
            eq(operations.id, executions.operationId),
            eq(operations.missionId, executions.missionId),
          ),
        )
        .innerJoin(
          missions,
          and(
            eq(missions.organizationId, executions.organizationId),
            eq(missions.id, executions.missionId),
          ),
        )
        .innerJoin(
          evidence,
          and(
            eq(evidence.organizationId, executions.organizationId),
            eq(evidence.id, reference.evidenceId),
            eq(evidence.missionId, executions.missionId),
            eq(evidence.palaceId, missions.palaceId),
          ),
        )
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, reference.executionId),
            eq(executions.operationId, reference.operationId),
            eq(executions.missionId, reference.missionId),
            eq(executions.status, 'running'),
            eq(operations.status, 'committed'),
            eq(missions.status, 'running'),
            eq(evidence.type, 'identity_arrival'),
            eq(evidence.authority, 'identity_telemetry'),
          ),
        )
        .limit(1)
      if (!binding) {
        throw new DatabaseConflictError('Identity-arrival execution reference is not bound')
      }
      const record = PersistedEvidenceRecordSchema.parse({
        evidence: binding.evidencePayload,
        authorityReceipt: binding.authorityReceipt,
        persistedAt: iso(binding.persistedAt),
      })
      if (record.evidence.type !== 'identity_arrival' || !record.evidence.verified) {
        throw new DatabaseConflictError('Identity-arrival execution evidence is not verified')
      }
      return {
        missionId: reference.missionId,
        operationId: reference.operationId,
        executionId: reference.executionId,
        commandId: null,
        dispatchGeneration: null,
      }
    }
    if (message.topic === 'execution.deadline') {
      const reference = ExecutionDeadlineReferenceSchema.parse(parsed)
      const [binding] = await this.executor
        .select({ id: executions.id })
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, reference.executionId),
            eq(executions.missionId, reference.missionId),
            eq(executions.operationId, reference.operationId),
          ),
        )
        .limit(1)
      if (!binding) throw new DatabaseConflictError('Execution deadline reference is not bound')
      return {
        missionId: reference.missionId,
        operationId: reference.operationId,
        executionId: reference.executionId,
        commandId: null,
        dispatchGeneration: null,
      }
    }
    if (message.topic === 'mission.resume' || message.topic === 'mission.verify') {
      const reference = MissionReferenceSchema.parse(parsed)
      const [binding] = await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.id, reference.missionId),
          ),
        )
        .limit(1)
      if (!binding) throw new DatabaseConflictError('Outbox mission reference is absent')
      return {
        missionId: reference.missionId,
        operationId: null,
        executionId: null,
        commandId: null,
        dispatchGeneration: null,
      }
    }
    const reference = OperationReconciliationReferenceSchema.parse(parsed)
    const [binding] = await this.executor
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.organizationId, this.organizationId),
          eq(attempts.id, reference.attemptId),
          eq(attempts.operationId, reference.operationId),
          eq(attempts.status, 'unknown'),
          eq(attempts.retryable, true),
        ),
      )
      .limit(1)
    if (!binding) {
      throw new DatabaseConflictError('Operation reconciliation attempt is not bound')
    }
    return {
      missionId: null,
      operationId: reference.operationId,
      executionId: null,
      commandId: null,
      dispatchGeneration: null,
    }
  }

  private async assertStoredOutboxMutation(messageId: string): Promise<void> {
    if (this.fencedMissionId === null) return
    const [row] = await this.executor
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.organizationId, this.organizationId),
          eq(outboxMessages.id, messageId),
        ),
      )
      .limit(1)
    if (!row) throw new DatabaseNotFoundError('Outbox message')
    await this.validateOutboxReferences(mapOutbox(row))
  }

  private async getPlan(planId: PlanId | string): Promise<Plan | null> {
    const [row] = await this.executor
      .select()
      .from(plans)
      .where(and(eq(plans.organizationId, this.organizationId), eq(plans.id, planId)))
      .limit(1)
    if (!row) return null
    const actionRows = await this.executor
      .select()
      .from(planActions)
      .where(
        and(eq(planActions.organizationId, this.organizationId), eq(planActions.planId, row.id)),
      )
      .orderBy(asc(planActions.position))
    return mapPlan(
      row,
      actionRows.map((actionRow) => actionRow.payload),
    )
  }

  private async getApproval(approvalId: string): Promise<Approval | null> {
    const [row] = await this.executor
      .select()
      .from(approvals)
      .where(and(eq(approvals.organizationId, this.organizationId), eq(approvals.id, approvalId)))
      .limit(1)
    if (!row) return null
    const actionRows = await this.executor
      .select()
      .from(approvalActions)
      .where(
        and(
          eq(approvalActions.organizationId, this.organizationId),
          eq(approvalActions.approvalId, row.id),
        ),
      )
    const protectedRows = await this.executor
      .select()
      .from(approvalProtectedResources)
      .where(
        and(
          eq(approvalProtectedResources.organizationId, this.organizationId),
          eq(approvalProtectedResources.approvalId, row.id),
        ),
      )
    return mapApproval(
      row,
      actionRows.map((actionRow) => actionRow.actionId),
      protectedRows.map((protectedRow) =>
        ProtectedResourceVersionSchema.parse({
          routineId: protectedRow.routineId,
          routineVersionId: protectedRow.routineVersionId,
          version: protectedRow.version,
        }),
      ),
    )
  }

  private async assertProtectedResourcesCurrent(approval: Approval): Promise<void> {
    for (const protectedResource of approval.protectedResources) {
      const current = await this.routines.getCurrentVersion(protectedResource.routineId)
      if (
        !current ||
        current.routineVersionId !== protectedResource.routineVersionId ||
        current.version !== protectedResource.version
      ) {
        throw new OptimisticConcurrencyError('Approval protected resource version is stale')
      }
    }
  }

  private assertApprovalResourceBindings(approval: Approval, plan: Plan): void {
    for (const action of plan.actions) {
      const routineId = isRoutineReplacementAction(action)
        ? action.protectedRoutineId
        : action.routineId
      const protectedResource = approval.protectedResources.find(
        (candidate) => candidate.routineId === routineId,
      )
      if (!protectedResource) {
        throw new ApprovalBindingError('Approval omits a protected routine')
      }
      if (
        isRoutineReplacementAction(action)
          ? protectedResource.routineVersionId !== action.protectedRoutineVersionId ||
            protectedResource.version !== action.expectedProtectedVersion
          : protectedResource.version !== action.expectedCurrentVersion
      ) {
        throw new ApprovalBindingError('Approval protected version does not match its plan action')
      }
    }
  }

  public readonly palaces = {
    get: async (inputPalaceId: PalaceId): Promise<Palace | null> => {
      const palaceId = PalaceIdSchema.parse(inputPalaceId)
      const [row] = await this.executor
        .select()
        .from(palaces)
        .where(and(eq(palaces.organizationId, this.organizationId), eq(palaces.id, palaceId)))
        .limit(1)
      return row ? mapPalace(row) : null
    },
  }

  public readonly crews = {
    list: async (inputPalaceId: PalaceId, activeOnly = true) => {
      const palaceId = PalaceIdSchema.parse(inputPalaceId)
      if (typeof activeOnly !== 'boolean') throw new TypeError('activeOnly must be a boolean')
      if (!(await this.palaces.get(palaceId))) {
        return CrewsListOutputSchema.parse({
          crew: [],
          identityTags: [],
          schedules: [],
          preferences: [],
        })
      }

      const crewRows = await this.executor
        .select()
        .from(crewMembers)
        .where(
          activeOnly
            ? and(
                eq(crewMembers.organizationId, this.organizationId),
                eq(crewMembers.palaceId, palaceId),
                eq(crewMembers.active, true),
              )
            : and(
                eq(crewMembers.organizationId, this.organizationId),
                eq(crewMembers.palaceId, palaceId),
              ),
        )
        .orderBy(asc(crewMembers.displayName), asc(crewMembers.id))
      const crew = crewRows.map((row) =>
        CrewMemberSchema.parse({
          id: row.id,
          organizationId: row.organizationId,
          palaceId: row.palaceId,
          userId: row.userId,
          displayName: row.displayName,
          active: row.active,
        }),
      )
      if (crew.length === 0) {
        return CrewsListOutputSchema.parse({
          crew,
          identityTags: [],
          schedules: [],
          preferences: [],
        })
      }

      const crewIds = crew.map((member) => member.id)
      const tagRows = await this.executor
        .select()
        .from(identityTags)
        .where(
          activeOnly
            ? and(
                eq(identityTags.organizationId, this.organizationId),
                inArray(identityTags.crewMemberId, crewIds),
                eq(identityTags.active, true),
              )
            : and(
                eq(identityTags.organizationId, this.organizationId),
                inArray(identityTags.crewMemberId, crewIds),
              ),
        )
        .orderBy(asc(identityTags.id))
      const scheduleRows = await this.executor
        .select()
        .from(crewSchedules)
        .where(
          activeOnly
            ? and(
                eq(crewSchedules.organizationId, this.organizationId),
                eq(crewSchedules.palaceId, palaceId),
                inArray(crewSchedules.crewMemberId, crewIds),
                eq(crewSchedules.active, true),
              )
            : and(
                eq(crewSchedules.organizationId, this.organizationId),
                eq(crewSchedules.palaceId, palaceId),
                inArray(crewSchedules.crewMemberId, crewIds),
              ),
        )
        .orderBy(asc(crewSchedules.crewMemberId), asc(crewSchedules.id))
      const preferenceRows = await this.executor
        .select()
        .from(crewPreferences)
        .where(
          activeOnly
            ? and(
                eq(crewPreferences.organizationId, this.organizationId),
                eq(crewPreferences.palaceId, palaceId),
                inArray(crewPreferences.crewMemberId, crewIds),
                eq(crewPreferences.active, true),
              )
            : and(
                eq(crewPreferences.organizationId, this.organizationId),
                eq(crewPreferences.palaceId, palaceId),
                inArray(crewPreferences.crewMemberId, crewIds),
              ),
        )
        .orderBy(asc(crewPreferences.crewMemberId), asc(crewPreferences.id))

      return CrewsListOutputSchema.parse({
        crew,
        identityTags: tagRows.map((row) =>
          IdentityTagSchema.parse({
            id: row.id,
            organizationId: row.organizationId,
            crewMemberId: row.crewMemberId,
            label: row.label,
            verified: row.verified,
            active: row.active,
            version: row.version,
          }),
        ),
        schedules: scheduleRows.map((row) =>
          CrewScheduleSchema.parse({
            id: row.id,
            organizationId: row.organizationId,
            palaceId: row.palaceId,
            crewMemberId: row.crewMemberId,
            active: row.active,
            version: row.version,
            timezone: row.timezone,
            windowStart: row.windowStart,
            windowEnd: row.windowEnd,
          }),
        ),
        preferences: preferenceRows.map((row) =>
          CrewPreferenceSchema.parse({
            id: row.id,
            organizationId: row.organizationId,
            palaceId: row.palaceId,
            crewMemberId: row.crewMemberId,
            kind: row.kind,
            active: row.active,
            version: row.version,
            targetCelsius: row.targetCelsius,
            pathwayLightingIntensityPercent: row.pathwayLightingIntensityPercent,
            pathwayLightingDurationSeconds: row.pathwayLightingDurationSeconds,
          }),
        ),
      })
    },
  }

  public readonly capabilities = {
    list: async (inputPalaceId: PalaceId) => {
      const palaceId = PalaceIdSchema.parse(inputPalaceId)
      if (!(await this.palaces.get(palaceId))) {
        return CapabilitiesListOutputSchema.parse({ devices: [], capabilities: [] })
      }
      const deviceRows = await this.executor
        .select()
        .from(devices)
        .where(and(eq(devices.organizationId, this.organizationId), eq(devices.palaceId, palaceId)))
        .orderBy(asc(devices.id))
      const projectedDevices = deviceRows.map((row) =>
        DeviceSchema.parse({
          id: row.id,
          organizationId: row.organizationId,
          palaceId: row.palaceId,
          kind: row.kind,
          name: row.name,
          health: row.health,
          version: row.version,
        }),
      )
      if (projectedDevices.length === 0) {
        return CapabilitiesListOutputSchema.parse({
          devices: projectedDevices,
          capabilities: [],
        })
      }
      const capabilityRows = await this.executor
        .select()
        .from(capabilities)
        .where(
          and(
            eq(capabilities.organizationId, this.organizationId),
            inArray(
              capabilities.deviceId,
              projectedDevices.map((device) => device.id),
            ),
          ),
        )
        .orderBy(asc(capabilities.deviceId), asc(capabilities.id))
      return CapabilitiesListOutputSchema.parse({
        devices: projectedDevices,
        capabilities: capabilityRows.map((row) =>
          CapabilitySchema.parse({
            id: row.id,
            organizationId: row.organizationId,
            deviceId: row.deviceId,
            kind: row.kind,
            enabled: row.enabled,
            constraints: row.constraints,
          }),
        ),
      })
    },
  }

  public readonly knowledge = {
    search: async (input: {
      readonly query: string
      readonly phase: MissionPhase
      readonly limit: number
    }) => {
      const query = KnowledgeSearchInputSchema.parse(input)
      const result = await this.executor.execute(sql`
        SELECT
          ${knowledgeSources.id} AS source_id,
          ${knowledgeSources.version} AS version,
          ${knowledgeSources.title} AS title,
          left(
            ts_headline(
              'english',
              ${knowledgeSources.content},
              websearch_to_tsquery('english', ${query.query}),
              'MaxWords=40, MinWords=12, ShortWord=3, MaxFragments=2, FragmentDelimiter=…'
            ),
            2000
          ) AS excerpt
        FROM ${knowledgeSources}
        WHERE (${knowledgeSources.organizationId} IS NULL OR ${knowledgeSources.organizationId} = ${this.organizationId})
          AND ${knowledgeSources.audiences} @> ARRAY['caretaker']::text[]
          AND ${query.phase}::mission_phase = ANY(${knowledgeSources.phases})
          AND ${knowledgeSources.sensitivity} <> 'confidential'
          AND ${knowledgeSources.searchDocument} @@ websearch_to_tsquery('english', ${query.query})
        ORDER BY
          ts_rank_cd(
            ${knowledgeSources.searchDocument},
            websearch_to_tsquery('english', ${query.query})
          ) DESC,
          ${knowledgeSources.id} ASC
        LIMIT ${query.limit}
      `)
      return KnowledgeSearchOutputSchema.parse({
        results: result.rows.map((row) => ({
          sourceId: row.source_id,
          version: row.version,
          title: row.title,
          excerpt: row.excerpt,
        })),
      }).results
    },
  }

  public readonly missions = {
    get: async (missionId: MissionId): Promise<Mission | null> => {
      const [row] = await this.executor
        .select()
        .from(missions)
        .where(and(eq(missions.organizationId, this.organizationId), eq(missions.id, missionId)))
        .limit(1)
      return row ? mapMission(row) : null
    },
    listForPalace: async (palaceId: PalaceId, limit: number): Promise<readonly Mission[]> => {
      const parsedPalaceId = PalaceIdSchema.parse(palaceId)
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError('Mission list limit must be a positive safe integer')
      }
      const rows = await this.executor
        .select()
        .from(missions)
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.palaceId, parsedPalaceId),
          ),
        )
        .orderBy(desc(missions.updatedAt), desc(missions.id))
        .limit(limit)
      return rows.map(mapMission)
    },
    insert: async (input: Mission): Promise<void> => {
      const mission = MissionSchema.parse(input)
      this.assertTenant(mission.organizationId)
      this.assertMissionMutation(mission.id)
      await this.executor.insert(missions).values({
        id: mission.id,
        organizationId: this.organizationId,
        palaceId: mission.palaceId,
        initiatedBy: mission.initiatedBy,
        programKind: missionProgramKindOf(mission),
        objective: mission.objective,
        constraints: mission.constraints,
        successCriteriaIds: mission.successCriteriaIds,
        status: mission.state.status,
        phase: mission.state.phase,
        version: mission.version,
        runId: mission.runId,
        contextReceiptId: mission.contextReceiptId,
        taskLedger: mission.taskLedger,
        createdAt: date(mission.createdAt),
        updatedAt: date(mission.updatedAt),
      })
    },
    save: async (input: Mission, expectedVersion: number): Promise<boolean> => {
      const mission = MissionSchema.parse(input)
      this.assertTenant(mission.organizationId)
      this.assertMissionMutation(mission.id)
      if (mission.version !== expectedVersion + 1) {
        throw new OptimisticConcurrencyError('Mission version must increment exactly once')
      }
      const [current] = await this.executor
        .select()
        .from(missions)
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.id, mission.id),
            eq(missions.version, expectedVersion),
          ),
        )
        .for('update')
        .limit(1)
      if (!current) return false
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        throw new DatabaseConflictError('Terminal mission state is immutable')
      }
      if (
        current.palaceId !== mission.palaceId ||
        current.initiatedBy !== mission.initiatedBy ||
        current.programKind !== missionProgramKindOf(mission) ||
        current.objective !== mission.objective ||
        hashCanonical(current.constraints) !== hashCanonical(mission.constraints) ||
        !sameStrings(current.successCriteriaIds, mission.successCriteriaIds) ||
        iso(current.createdAt) !== mission.createdAt
      ) {
        throw new DatabaseConflictError('Mission objective and constraints are immutable')
      }
      if (hashCanonical(current.taskLedger) !== hashCanonical(mission.taskLedger)) {
        throw new DatabaseConflictError(
          'Caretaker task-ledger changes require a versioned run checkpoint',
        )
      }
      if (current.runId !== mission.runId) {
        throw new DatabaseConflictError(
          'Mission Caretaker run identity changes require a fenced activation',
        )
      }
      if (mission.state.status === 'succeeded') {
        const [verification] = await this.executor
          .select({ status: verifications.status })
          .from(verifications)
          .where(
            and(
              eq(verifications.organizationId, this.organizationId),
              eq(verifications.missionId, mission.id),
              eq(verifications.status, 'passed'),
            ),
          )
          .limit(1)
        if (!verification) {
          throw new DatabaseConflictError(
            'Only a passed application verification may succeed a mission',
          )
        }
      }
      const updated = await this.executor
        .update(missions)
        .set({
          status: mission.state.status,
          phase: mission.state.phase,
          version: mission.version,
          runId: mission.runId,
          contextReceiptId: mission.contextReceiptId,
          updatedAt: date(mission.updatedAt),
        })
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.id, mission.id),
            eq(missions.version, current.version),
          ),
        )
        .returning({ id: missions.id })
      return updated.length === 1
    },
    appendEvent: async (input: MissionEvent): Promise<void> => {
      const event = MissionEventSchema.parse(input)
      this.assertTenant(event.organizationId)
      this.assertMissionMutation(event.missionId)
      await this.executor.insert(missionEvents).values({
        id: event.id,
        organizationId: this.organizationId,
        missionId: event.missionId,
        sequence: event.sequence,
        event: event.event,
        fromStatus: event.from.status,
        fromPhase: event.from.phase,
        toStatus: event.to.status,
        toPhase: event.to.phase,
        occurredAt: date(event.occurredAt),
      })
    },
  }

  public readonly plans = {
    get: (planId: PlanId): Promise<Plan | null> => this.getPlan(planId),
    getLatestForMission: async (missionId: MissionId): Promise<Plan | null> => {
      const [row] = await this.executor
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.organizationId, this.organizationId), eq(plans.missionId, missionId)))
        .orderBy(desc(plans.revision))
        .limit(1)
      return row ? this.getPlan(row.id) : null
    },
    insert: async (input: Plan): Promise<void> => {
      const plan = PlanSchema.parse(input)
      this.assertTenant(plan.organizationId)
      this.assertMissionMutation(plan.missionId)
      await this.executor.insert(plans).values({
        id: plan.id,
        organizationId: this.organizationId,
        missionId: plan.missionId,
        palaceId: plan.palaceId,
        revision: plan.revision,
        hash: plan.hash,
        status: plan.status,
        objective: plan.objective,
        constraints: plan.constraints,
        successCriteriaIds: plan.successCriteriaIds,
        createdAt: date(plan.createdAt),
      })
      await this.executor.insert(planActions).values(
        plan.actions.map((action, position) => ({
          id: action.id,
          organizationId: this.organizationId,
          planId: plan.id,
          position,
          type: action.type,
          payload: action,
          createdAt: date(plan.createdAt),
        })),
      )
    },
    save: async (input: Plan): Promise<void> => {
      const plan = PlanSchema.parse(input)
      this.assertTenant(plan.organizationId)
      this.assertMissionMutation(plan.missionId)
      const [current] = await this.executor
        .select()
        .from(plans)
        .where(and(eq(plans.organizationId, this.organizationId), eq(plans.id, plan.id)))
        .for('update')
        .limit(1)
      if (!current) throw new DatabaseNotFoundError('Plan')
      const stored = await this.getPlan(plan.id)
      if (
        !stored ||
        stored.hash !== plan.hash ||
        stored.missionId !== plan.missionId ||
        stored.palaceId !== plan.palaceId ||
        stored.revision !== plan.revision ||
        stored.objective !== plan.objective ||
        hashCanonical(stored.constraints) !== hashCanonical(plan.constraints) ||
        hashCanonical(stored.actions) !== hashCanonical(plan.actions) ||
        !sameStrings(stored.successCriteriaIds, plan.successCriteriaIds) ||
        stored.createdAt !== plan.createdAt
      ) {
        throw new DatabaseConflictError('Plan status update does not match immutable plan content')
      }
      const updated = await this.executor
        .update(plans)
        .set({ status: plan.status, recordVersion: current.recordVersion + 1 })
        .where(
          and(
            eq(plans.organizationId, this.organizationId),
            eq(plans.id, plan.id),
            eq(plans.recordVersion, current.recordVersion),
          ),
        )
        .returning({ id: plans.id })
      if (updated.length !== 1) throw new OptimisticConcurrencyError('Plan changed concurrently')
    },
  }

  public readonly approvals = {
    get: (approvalId: string): Promise<Approval | null> => this.getApproval(approvalId),
    findForPlan: async (planId: PlanId): Promise<Approval | null> => {
      const [row] = await this.executor
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.organizationId, this.organizationId), eq(approvals.planId, planId)))
        .orderBy(desc(approvals.createdAt))
        .limit(1)
      return row ? this.getApproval(row.id) : null
    },
    insert: async (input: Approval): Promise<void> => {
      const approval = ApprovalSchema.parse(input)
      this.assertTenant(approval.organizationId)
      this.assertMissionMutation(approval.missionId)
      const plan = await this.getPlan(approval.planId)
      if (!plan) throw new DatabaseNotFoundError('Plan')
      if (
        approval.planHash !== plan.hash ||
        approval.missionId !== plan.missionId ||
        !sameStrings(
          approval.actionIds,
          plan.actions.map((action) => action.id),
        )
      ) {
        throw new ApprovalBindingError('Approval does not bind the exact plan and action set')
      }
      this.assertApprovalResourceBindings(approval, plan)
      if (approval.status === 'approved') {
        assertApprovalAuthorizesPlan(approval, plan, approval.approvedAt ?? approval.createdAt)
        await this.assertProtectedResourcesCurrent(approval)
      }
      await this.executor.insert(approvals).values({
        id: approval.id,
        organizationId: this.organizationId,
        missionId: approval.missionId,
        planId: approval.planId,
        planHash: approval.planHash,
        status: approval.status,
        requestedBy: approval.requestedBy,
        approvedBy: approval.approvedBy,
        approverRole: approval.approverRole,
        nonce: approval.nonce,
        approvedAt: approval.approvedAt ? date(approval.approvedAt) : null,
        expiresAt: date(approval.expiresAt),
        createdAt: date(approval.createdAt),
      })
      await this.executor.insert(approvalActions).values(
        approval.actionIds.map((actionId) => ({
          organizationId: this.organizationId,
          approvalId: approval.id,
          planId: approval.planId,
          actionId,
        })),
      )
      await this.executor.insert(approvalProtectedResources).values(
        approval.protectedResources.map((resource) => ({
          organizationId: this.organizationId,
          approvalId: approval.id,
          routineId: resource.routineId,
          routineVersionId: resource.routineVersionId,
          version: resource.version,
        })),
      )
    },
    save: async (input: Approval): Promise<void> => {
      const approval = ApprovalSchema.parse(input)
      this.assertTenant(approval.organizationId)
      this.assertMissionMutation(approval.missionId)
      const [current] = await this.executor
        .select()
        .from(approvals)
        .where(
          and(eq(approvals.organizationId, this.organizationId), eq(approvals.id, approval.id)),
        )
        .for('update')
        .limit(1)
      if (!current) throw new DatabaseNotFoundError('Approval')
      const stored = await this.getApproval(approval.id)
      if (
        !stored ||
        stored.missionId !== approval.missionId ||
        stored.planId !== approval.planId ||
        stored.planHash !== approval.planHash ||
        stored.requestedBy !== approval.requestedBy ||
        stored.nonce !== approval.nonce ||
        stored.createdAt !== approval.createdAt ||
        stored.expiresAt !== approval.expiresAt ||
        !sameStrings(stored.actionIds, approval.actionIds) ||
        hashCanonical(stored.protectedResources) !== hashCanonical(approval.protectedResources)
      ) {
        throw new DatabaseConflictError('Approval update does not match immutable request content')
      }
      if (approval.status === 'approved') {
        if (approval.approvedBy === null) {
          throw new ApprovalBindingError('Approved record has no approver')
        }
        const approvalPlan = await this.getPlan(approval.planId)
        if (!approvalPlan) throw new DatabaseNotFoundError('Approval plan')
        assertApprovalAuthorizesPlan(
          approval,
          approvalPlan,
          approval.approvedAt ?? approval.createdAt,
        )
        const [actorMembership] = await this.executor
          .select({ role: memberships.role, grants: memberships.grants })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, this.organizationId),
              eq(memberships.userId, approval.approvedBy),
              sql`${memberships.revokedAt} IS NULL`,
            ),
          )
          .limit(1)
        if (
          !actorMembership ||
          actorMembership.role !== approval.approverRole ||
          (actorMembership.role === 'operator' &&
            !actorMembership.grants.includes('routine:approve'))
        ) {
          throw new ApprovalBindingError('Approver membership does not authorize this approval')
        }
        await this.assertProtectedResourcesCurrent(approval)
      }
      const updated = await this.executor
        .update(approvals)
        .set({
          status: approval.status,
          approvedBy: approval.approvedBy,
          approverRole: approval.approverRole,
          approvedAt: approval.approvedAt ? date(approval.approvedAt) : null,
          recordVersion: current.recordVersion + 1,
        })
        .where(
          and(
            eq(approvals.organizationId, this.organizationId),
            eq(approvals.id, approval.id),
            eq(approvals.recordVersion, current.recordVersion),
          ),
        )
        .returning({ id: approvals.id })
      if (updated.length !== 1)
        throw new OptimisticConcurrencyError('Approval changed concurrently')
    },
  }

  public readonly operations = {
    get: async (operationId: OperationId): Promise<Operation | null> => {
      const [row] = await this.executor
        .select()
        .from(operations)
        .where(
          and(eq(operations.organizationId, this.organizationId), eq(operations.id, operationId)),
        )
        .limit(1)
      return row ? mapOperation(row) : null
    },
    findByPlanAction: async (planId: PlanId, actionId: PlanActionId): Promise<Operation | null> => {
      const [row] = await this.executor
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.planId, planId),
            eq(operations.planActionId, actionId),
          ),
        )
        .limit(1)
      return row ? mapOperation(row) : null
    },
    listForMission: async (missionId: MissionId): Promise<readonly Operation[]> => {
      const rows = await this.executor
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.missionId, missionId),
          ),
        )
        .orderBy(asc(operations.createdAt))
      return rows.map(mapOperation)
    },
    insert: async (input: Operation): Promise<void> => {
      const operation = OperationSchema.parse(input)
      this.assertTenant(operation.organizationId)
      this.assertMissionMutation(operation.missionId)
      const plan = await this.getPlan(operation.planId)
      const approval = await this.getApproval(operation.approvalId)
      if (!plan || !approval) throw new ApprovalBindingError('Operation plan or approval is absent')
      assertApprovalAuthorizesPlan(approval, plan, operation.createdAt)
      await this.assertProtectedResourcesCurrent(approval)
      const action = plan.actions.find((candidate) => candidate.id === operation.planActionId)
      if (!action || operation.payloadHash !== hashCanonical({ planHash: plan.hash, action })) {
        throw new ApprovalBindingError('Operation payload does not match its approved plan action')
      }
      await this.executor.insert(operations).values({
        id: operation.id,
        organizationId: this.organizationId,
        missionId: operation.missionId,
        planId: operation.planId,
        planActionId: operation.planActionId,
        approvalId: operation.approvalId,
        payloadHash: operation.payloadHash,
        serverCreated: true,
        status: operation.status,
        outcome: operation.outcome,
        committedAt: operation.committedAt ? date(operation.committedAt) : null,
        createdAt: date(operation.createdAt),
      })
    },
    save: async (input: Operation): Promise<void> => {
      const operation = OperationSchema.parse(input)
      this.assertTenant(operation.organizationId)
      this.assertMissionMutation(operation.missionId)
      const [current] = await this.executor
        .select()
        .from(operations)
        .where(
          and(eq(operations.organizationId, this.organizationId), eq(operations.id, operation.id)),
        )
        .for('update')
        .limit(1)
      if (!current) throw new DatabaseNotFoundError('Operation')
      if (
        current.missionId !== operation.missionId ||
        current.planId !== operation.planId ||
        current.planActionId !== operation.planActionId ||
        current.approvalId !== operation.approvalId ||
        current.payloadHash !== operation.payloadHash ||
        iso(current.createdAt) !== operation.createdAt
      ) {
        throw new DatabaseConflictError('Operation update does not match immutable identity')
      }
      const updated = await this.executor
        .update(operations)
        .set({
          status: operation.status,
          outcome: operation.outcome,
          committedAt: operation.committedAt ? date(operation.committedAt) : null,
          recordVersion: current.recordVersion + 1,
        })
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.id, operation.id),
            eq(operations.recordVersion, current.recordVersion),
          ),
        )
        .returning({ id: operations.id })
      if (updated.length !== 1)
        throw new OptimisticConcurrencyError('Operation changed concurrently')
    },
    createForApprovedPlan: async (approvalId: string, createdAt: string): Promise<Operation[]> => {
      await this.assertApprovalMutation(approvalId)
      const approval = await this.getApproval(approvalId)
      if (!approval) throw new DatabaseNotFoundError('Approval')
      const plan = await this.getPlan(approval.planId)
      if (!plan) throw new DatabaseNotFoundError('Plan')
      assertApprovalAuthorizesPlan(approval, plan, createdAt)
      await this.assertProtectedResourcesCurrent(approval)
      const created: Operation[] = []
      for (const action of plan.actions) {
        const existing = await this.operations.findByPlanAction(plan.id, action.id)
        if (existing) {
          if (existing.payloadHash !== hashCanonical({ planHash: plan.hash, action })) {
            throw new ApprovalBindingError('Existing operation has a conflicting payload')
          }
          created.push(existing)
          continue
        }
        const operation = OperationSchema.parse({
          id: createDatabaseId('op'),
          organizationId: this.organizationId,
          missionId: plan.missionId,
          planId: plan.id,
          planActionId: action.id,
          approvalId: approval.id,
          payloadHash: hashCanonical({ planHash: plan.hash, action }),
          serverCreated: true,
          status: 'pending',
          outcome: null,
          createdAt,
          committedAt: null,
        })
        await this.operations.insert(operation)
        created.push(operation)
      }
      return created
    },
  }

  public readonly attempts = {
    listForOperation: async (operationId: OperationId): Promise<readonly Attempt[]> => {
      const rows = await this.executor
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.organizationId, this.organizationId),
            eq(attempts.operationId, operationId),
          ),
        )
        .orderBy(asc(attempts.sequence))
      return rows.map(mapAttempt)
    },
    insert: async (input: Attempt): Promise<void> => {
      const attempt = AttemptSchema.parse(input)
      this.assertTenant(attempt.organizationId)
      await this.assertOperationMutation(attempt.operationId)
      await this.executor.insert(attempts).values({
        id: attempt.id,
        organizationId: this.organizationId,
        operationId: attempt.operationId,
        gatewayCommandId: attempt.transport === 'gateway' ? attempt.commandId : null,
        dispatchGeneration: attempt.transport === 'gateway' ? attempt.generation : null,
        sequence: attempt.sequence,
        transport: attempt.transport,
        status: attempt.status,
        retryable: attempt.retryable,
        errorCode: attempt.error?.code ?? null,
        errorMessage: attempt.error?.message ?? null,
        startedAt: date(attempt.startedAt),
        completedAt: attempt.completedAt ? date(attempt.completedAt) : null,
      })
    },
    save: async (input: Attempt): Promise<void> => {
      const attempt = AttemptSchema.parse(input)
      this.assertTenant(attempt.organizationId)
      await this.assertOperationMutation(attempt.operationId)
      const [current] = await this.executor
        .select({ recordVersion: attempts.recordVersion })
        .from(attempts)
        .where(and(eq(attempts.organizationId, this.organizationId), eq(attempts.id, attempt.id)))
        .for('update')
        .limit(1)
      if (!current) throw new DatabaseNotFoundError('Attempt')
      const [storedAttempt] = await this.executor
        .select()
        .from(attempts)
        .where(and(eq(attempts.organizationId, this.organizationId), eq(attempts.id, attempt.id)))
        .limit(1)
      if (
        !storedAttempt ||
        storedAttempt.operationId !== attempt.operationId ||
        storedAttempt.sequence !== attempt.sequence ||
        storedAttempt.transport !== attempt.transport ||
        storedAttempt.gatewayCommandId !==
          (attempt.transport === 'gateway' ? attempt.commandId : null) ||
        storedAttempt.dispatchGeneration !==
          (attempt.transport === 'gateway' ? attempt.generation : null) ||
        iso(storedAttempt.startedAt) !== attempt.startedAt
      ) {
        throw new DatabaseConflictError('Attempt update does not match immutable identity')
      }
      const updated = await this.executor
        .update(attempts)
        .set({
          status: attempt.status,
          retryable: attempt.retryable,
          errorCode: attempt.error?.code ?? null,
          errorMessage: attempt.error?.message ?? null,
          completedAt: attempt.completedAt ? date(attempt.completedAt) : null,
          recordVersion: current.recordVersion + 1,
        })
        .where(
          and(
            eq(attempts.organizationId, this.organizationId),
            eq(attempts.id, attempt.id),
            eq(attempts.recordVersion, current.recordVersion),
          ),
        )
        .returning({ id: attempts.id })
      if (updated.length !== 1) throw new OptimisticConcurrencyError('Attempt changed concurrently')
    },
  }

  private async appendAudit(input: {
    aggregateType: string
    aggregateId: string
    eventType: string
    actorType: string
    actorId?: string
    payload: Record<string, unknown>
    occurredAt: string
  }): Promise<void> {
    await this.executor.insert(auditEvents).values({
      id: createDatabaseId('evt'),
      organizationId: this.organizationId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      sequence: sql<number>`coalesce((select max(${auditEvents.sequence}) from ${auditEvents} where ${auditEvents.organizationId} = ${this.organizationId} and ${auditEvents.aggregateType} = ${input.aggregateType} and ${auditEvents.aggregateId} = ${input.aggregateId}), -1) + 1`,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: input.payload,
      occurredAt: date(input.occurredAt),
    })
  }

  public readonly routines = {
    list: async (inputPalaceId: PalaceId, inputStatuses?: readonly RoutineStatus[]) => {
      const palaceId = PalaceIdSchema.parse(inputPalaceId)
      const statuses = inputStatuses?.map((status) => RoutineStatusSchema.parse(status))
      if (statuses?.length === 0) throw new TypeError('Routine status filter cannot be empty')
      if (!(await this.palaces.get(palaceId))) {
        return RoutinesListOutputSchema.parse({ routines: [], versions: [] })
      }
      const routineRows = await this.executor
        .select()
        .from(routines)
        .where(
          and(eq(routines.organizationId, this.organizationId), eq(routines.palaceId, palaceId)),
        )
        .orderBy(asc(routines.name), asc(routines.id))
      if (routineRows.length === 0) {
        return RoutinesListOutputSchema.parse({ routines: [], versions: [] })
      }
      const versionRows = await this.executor
        .select()
        .from(routineVersions)
        .where(
          statuses
            ? and(
                eq(routineVersions.organizationId, this.organizationId),
                inArray(
                  routineVersions.routineId,
                  routineRows.map((routine) => routine.id),
                ),
                inArray(routineVersions.status, statuses),
              )
            : and(
                eq(routineVersions.organizationId, this.organizationId),
                inArray(
                  routineVersions.routineId,
                  routineRows.map((routine) => routine.id),
                ),
              ),
        )
        .orderBy(asc(routineVersions.routineId), desc(routineVersions.version))
      const includedRoutineIds = new Set(versionRows.map((version) => version.routineId))
      return RoutinesListOutputSchema.parse({
        routines: routineRows
          .filter((routine) => statuses === undefined || includedRoutineIds.has(routine.id))
          .map(mapRoutine),
        versions: versionRows.map(mapRoutineVersion),
      })
    },
    get: async (inputRoutineId: RoutineId, inputVersionId?: RoutineVersionId) => {
      const routineId = RoutineIdSchema.parse(inputRoutineId)
      const versionId = inputVersionId ? RoutineVersionIdSchema.parse(inputVersionId) : undefined
      const [routineRow] = await this.executor
        .select()
        .from(routines)
        .where(and(eq(routines.organizationId, this.organizationId), eq(routines.id, routineId)))
        .limit(1)
      if (!routineRow) return null
      const selectedVersionId = versionId ?? routineRow.activeVersionId
      if (!selectedVersionId) return null
      const [versionRow] = await this.executor
        .select()
        .from(routineVersions)
        .where(
          and(
            eq(routineVersions.organizationId, this.organizationId),
            eq(routineVersions.routineId, routineId),
            eq(routineVersions.id, selectedVersionId),
          ),
        )
        .limit(1)
      return versionRow
        ? RoutinesGetOutputSchema.parse({
            routine: mapRoutine(routineRow),
            version: mapRoutineVersion(versionRow),
          })
        : null
    },
    getCurrentVersion: async (routineId: string): Promise<ProtectedResourceVersion | null> => {
      const [row] = await this.executor
        .select({
          routineId: routines.id,
          routineVersionId: routineVersions.id,
          version: routineVersions.version,
        })
        .from(routines)
        .innerJoin(
          routineVersions,
          and(
            eq(routineVersions.organizationId, routines.organizationId),
            eq(routineVersions.routineId, routines.id),
            eq(routineVersions.id, routines.activeVersionId),
            eq(routineVersions.status, 'active'),
          ),
        )
        .where(and(eq(routines.organizationId, this.organizationId), eq(routines.id, routineId)))
        .limit(1)
      return row ? ProtectedResourceVersionSchema.parse(row) : null
    },
    applyApprovedAction: async (
      inputPlan: Plan,
      inputAction: PlanAction,
    ): Promise<OperationOutcome> => {
      const plan = PlanSchema.parse(inputPlan)
      this.assertTenant(plan.organizationId)
      this.assertMissionMutation(plan.missionId)
      const storedPlan = await this.getPlan(plan.id)
      if (!storedPlan || storedPlan.hash !== plan.hash || storedPlan.status !== 'approved') {
        throw new ApprovalBindingError('Approved plan content is absent or changed')
      }
      const action = storedPlan.actions.find((candidate) => candidate.id === inputAction.id)
      if (!action || hashCanonical(action) !== hashCanonical(inputAction)) {
        throw new ApprovalBindingError('Action is not the immutable approved plan action')
      }
      const approval = await this.approvals.findForPlan(plan.id)
      if (!approval) throw new ApprovalBindingError('Approved action has no approval')
      assertApprovalAuthorizesPlan(
        approval,
        storedPlan,
        approval.approvedAt ?? storedPlan.createdAt,
      )

      if (isRoutineReplacementAction(action)) {
        const [protectedRoutine] = await this.executor
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.organizationId, this.organizationId),
              eq(routines.id, action.protectedRoutineId),
            ),
          )
          .for('update')
          .limit(1)
        if (
          !protectedRoutine ||
          protectedRoutine.activeVersionId !== action.protectedRoutineVersionId
        ) {
          throw new OptimisticConcurrencyError('Protected routine version is stale')
        }
        const [protectedVersion] = await this.executor
          .select()
          .from(routineVersions)
          .where(
            and(
              eq(routineVersions.organizationId, this.organizationId),
              eq(routineVersions.routineId, action.protectedRoutineId),
              eq(routineVersions.id, action.protectedRoutineVersionId),
            ),
          )
          .for('update')
          .limit(1)
        if (
          !protectedVersion ||
          protectedVersion.version !== action.expectedProtectedVersion ||
          protectedVersion.status !== 'active'
        ) {
          throw new OptimisticConcurrencyError('Protected routine version is stale')
        }
        await this.executor.insert(routines).values({
          id: action.replacementRoutineId,
          organizationId: this.organizationId,
          palaceId: action.palaceId,
          name: action.replacement.name,
          activeVersionId: null,
          createdAt: new Date(),
        })
        await this.executor.insert(routineVersions).values({
          id: action.replacementRoutineVersionId,
          routineId: action.replacementRoutineId,
          organizationId: this.organizationId,
          version: 1,
          status: 'active',
          definition: action.replacement,
          sourcePlanId: storedPlan.id,
          sourcePlanHash: storedPlan.hash,
          createdAt: new Date(),
        })
        await this.executor
          .update(routineVersions)
          .set({ status: 'inactive' })
          .where(
            and(
              eq(routineVersions.organizationId, this.organizationId),
              eq(routineVersions.id, protectedVersion.id),
              eq(routineVersions.status, 'active'),
            ),
          )
        await this.executor
          .update(routines)
          .set({ activeVersionId: action.replacementRoutineVersionId, recordVersion: 2 })
          .where(
            and(
              eq(routines.organizationId, this.organizationId),
              eq(routines.id, action.replacementRoutineId),
            ),
          )
        await this.executor
          .update(routines)
          .set({
            activeVersionId: null,
            recordVersion: protectedRoutine.recordVersion + 1,
          })
          .where(
            and(
              eq(routines.organizationId, this.organizationId),
              eq(routines.id, protectedRoutine.id),
              eq(routines.recordVersion, protectedRoutine.recordVersion),
            ),
          )
        await this.appendAudit({
          aggregateType: 'routine',
          aggregateId: action.replacementRoutineId,
          eventType: 'routine.replaced',
          actorType: 'system',
          payload: {
            planId: storedPlan.id,
            planHash: storedPlan.hash,
            deactivatedRoutineId: protectedRoutine.id,
            routineVersionId: action.replacementRoutineVersionId,
          },
          occurredAt: new Date().toISOString(),
        })
        return {
          routineId: action.replacementRoutineId,
          routineVersionId: action.replacementRoutineVersionId,
          deactivatedRoutineId: protectedRoutine.id as OperationOutcome['deactivatedRoutineId'],
        }
      }

      const [routine] = await this.executor
        .select()
        .from(routines)
        .where(
          and(eq(routines.organizationId, this.organizationId), eq(routines.id, action.routineId)),
        )
        .for('update')
        .limit(1)
      if (!routine?.activeVersionId) throw new DatabaseNotFoundError('Current routine version')
      const versionRows = await this.executor
        .select()
        .from(routineVersions)
        .where(
          and(
            eq(routineVersions.organizationId, this.organizationId),
            eq(routineVersions.routineId, action.routineId),
            inArray(routineVersions.id, [routine.activeVersionId, action.restoreVersionId]),
          ),
        )
        .for('update')
      const currentVersion = versionRows.find(
        (candidate) => candidate.id === routine.activeVersionId,
      )
      const restoreVersion = versionRows.find(
        (candidate) => candidate.id === action.restoreVersionId,
      )
      if (
        !currentVersion ||
        currentVersion.version !== action.expectedCurrentVersion ||
        !restoreVersion
      ) {
        throw new OptimisticConcurrencyError('Current or restore routine version is stale')
      }
      await this.executor
        .update(routineVersions)
        .set({ status: 'inactive' })
        .where(
          and(
            eq(routineVersions.organizationId, this.organizationId),
            eq(routineVersions.id, currentVersion.id),
          ),
        )
      await this.executor
        .update(routineVersions)
        .set({ status: 'active' })
        .where(
          and(
            eq(routineVersions.organizationId, this.organizationId),
            eq(routineVersions.id, restoreVersion.id),
          ),
        )
      await this.executor
        .update(routines)
        .set({ activeVersionId: restoreVersion.id, recordVersion: routine.recordVersion + 1 })
        .where(
          and(
            eq(routines.organizationId, this.organizationId),
            eq(routines.id, routine.id),
            eq(routines.recordVersion, routine.recordVersion),
          ),
        )
      await this.appendAudit({
        aggregateType: 'routine',
        aggregateId: routine.id,
        eventType: 'routine.version_restored',
        actorType: 'system',
        payload: { planId: storedPlan.id, routineVersionId: restoreVersion.id },
        occurredAt: new Date().toISOString(),
      })
      return {
        routineId: action.routineId,
        routineVersionId: action.restoreVersionId,
        deactivatedRoutineId: null,
      }
    },
  }

  public readonly outbox = {
    findByDeduplicationKey: async (deduplicationKey: string): Promise<OutboxMessage | null> => {
      const [row] = await this.executor
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.organizationId, this.organizationId),
            eq(outboxMessages.deduplicationKey, deduplicationKey),
          ),
        )
        .limit(1)
      return row ? mapOutbox(row) : null
    },
    insert: async (message: OutboxMessage): Promise<void> => {
      this.assertTenant(message.organizationId)
      const references = await this.validateOutboxReferences(message)
      await this.executor.insert(outboxMessages).values({
        id: message.id,
        organizationId: this.organizationId,
        topic: message.topic,
        ...references,
        deduplicationKey: message.deduplicationKey,
        payload: { ...message.payload },
        status: message.status,
        availableAt: date(message.availableAt),
        createdAt: date(message.createdAt),
        claimedBy: message.claimedBy,
        claimExpiresAt: message.claimExpiresAt ? date(message.claimExpiresAt) : null,
        dispatchedAt: message.dispatchedAt ? date(message.dispatchedAt) : null,
        deliveryAttempts: message.deliveryAttempts,
        lastErrorCode: message.lastErrorCode,
      })
    },
    markDispatched: async (
      messageId: string,
      ownerId: string,
      dispatchedAt: string,
    ): Promise<boolean> => {
      await this.assertStoredOutboxMutation(messageId)
      const updated = await this.executor
        .update(outboxMessages)
        .set({
          status: 'dispatched',
          dispatchedAt: date(dispatchedAt),
          claimedBy: null,
          claimExpiresAt: null,
          recordVersion: sql`${outboxMessages.recordVersion} + 1`,
        })
        .where(
          and(
            eq(outboxMessages.organizationId, this.organizationId),
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.status, 'claimed'),
            eq(outboxMessages.claimedBy, ownerId),
          ),
        )
        .returning({ id: outboxMessages.id })
      return updated.length === 1
    },
    release: async (
      messageId: string,
      ownerId: string,
      availableAt: string,
      errorCode: string,
    ): Promise<boolean> => {
      await this.assertStoredOutboxMutation(messageId)
      const updated = await this.executor
        .update(outboxMessages)
        .set({
          status: 'pending',
          availableAt: date(availableAt),
          claimedBy: null,
          claimExpiresAt: null,
          lastErrorCode: errorCode,
          recordVersion: sql`${outboxMessages.recordVersion} + 1`,
        })
        .where(
          and(
            eq(outboxMessages.organizationId, this.organizationId),
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.status, 'claimed'),
            eq(outboxMessages.claimedBy, ownerId),
          ),
        )
        .returning({ id: outboxMessages.id })
      return updated.length === 1
    },
  }

  private mapGatewayCommandV2(row: typeof gatewayCommands.$inferSelect): GatewayCommand {
    return GatewayCommandSchema.parse({
      schemaVersion: row.schemaVersion,
      id: row.id,
      organizationId: row.organizationId,
      missionId: row.missionId,
      palaceId: row.palaceId,
      operationId: row.operationId,
      logicalKey: row.logicalKey,
      kind: row.kind,
      payload: row.payload,
      payloadHash: row.payloadHash,
      createdAt: iso(row.createdAt),
    })
  }

  private async hydrateGatewayCallback(
    row: typeof gatewayCallbacks.$inferSelect,
  ): Promise<StoredGatewayCallback> {
    const [commandRow] = await this.executor
      .select()
      .from(gatewayCommands)
      .where(
        and(
          eq(gatewayCommands.organizationId, this.organizationId),
          eq(gatewayCommands.id, row.commandId),
        ),
      )
      .limit(1)
    if (!commandRow) throw new DatabaseConflictError('Stored callback has no command')
    const command = this.mapGatewayCommandV2(commandRow)
    const linkedEvidence = await this.executor
      .select({ payload: evidence.payload })
      .from(gatewayCallbackEvidence)
      .innerJoin(
        evidence,
        and(
          eq(evidence.organizationId, gatewayCallbackEvidence.organizationId),
          eq(evidence.id, gatewayCallbackEvidence.evidenceId),
        ),
      )
      .where(
        and(
          eq(gatewayCallbackEvidence.organizationId, this.organizationId),
          eq(gatewayCallbackEvidence.callbackId, row.id),
        ),
      )
      .orderBy(asc(gatewayCallbackEvidence.position))
    const callback = GatewayCallbackSchema.parse({
      schemaVersion: 'gateway-callback@1',
      id: row.id,
      organizationId: row.organizationId,
      missionId: command.missionId,
      palaceId: command.palaceId,
      commandId: row.commandId,
      operationId: row.operationId,
      nonce: row.nonce,
      status: row.status,
      occurredAt: iso(row.occurredAt),
      evidence: linkedEvidence.map((item) => item.payload),
    })
    return {
      ...callback,
      verifierKeyId: row.verifierKeyId,
      verifierVersion: 1,
      verifiedPayloadDigest:
        row.verifiedPayloadDigest as StoredGatewayCallback['verifiedPayloadDigest'],
      receivedAt: iso(row.receivedAt),
    }
  }

  private async hydrateGatewayEffect(
    commandId: GatewayCommandId,
  ): Promise<GatewayEffectRecord | null> {
    const [aggregate] = await this.executor
      .select({
        command: gatewayCommands,
        effect: gatewayEffects,
        dispatch: gatewayDispatches,
      })
      .from(gatewayCommands)
      .innerJoin(
        gatewayEffects,
        and(
          eq(gatewayEffects.organizationId, gatewayCommands.organizationId),
          eq(gatewayEffects.commandId, gatewayCommands.id),
        ),
      )
      .innerJoin(
        gatewayDispatches,
        and(
          eq(gatewayDispatches.organizationId, gatewayCommands.organizationId),
          eq(gatewayDispatches.commandId, gatewayCommands.id),
        ),
      )
      .where(
        and(
          eq(gatewayCommands.organizationId, this.organizationId),
          eq(gatewayCommands.id, commandId),
        ),
      )
      .orderBy(desc(gatewayDispatches.generation))
      .limit(1)
    if (!aggregate) return null

    const { command: commandRow, dispatch, effect } = aggregate
    const command = this.mapGatewayCommandV2(commandRow)
    const dispatchState =
      dispatch.status === 'pending'
        ? {
            commandId: command.id,
            generation: dispatch.generation,
            status: 'pending' as const,
            attemptId: null,
            updatedAt: iso(dispatch.updatedAt),
          }
        : dispatch.status === 'dispatching'
          ? {
              commandId: command.id,
              generation: dispatch.generation,
              status: 'dispatching' as const,
              attemptId: AttemptIdSchema.parse(dispatch.attemptId),
              updatedAt: iso(dispatch.updatedAt),
            }
          : dispatch.status === 'accepted'
            ? {
                commandId: command.id,
                generation: dispatch.generation,
                status: 'accepted' as const,
                attemptId: AttemptIdSchema.parse(dispatch.attemptId),
                acknowledgementId: dispatch.acknowledgementId,
                updatedAt: iso(dispatch.updatedAt),
              }
            : dispatch.status === 'unknown'
              ? {
                  commandId: command.id,
                  generation: dispatch.generation,
                  status: 'unknown' as const,
                  attemptId: AttemptIdSchema.parse(dispatch.attemptId),
                  retryable: true as const,
                  reason: dispatch.unknownReason,
                  updatedAt: iso(dispatch.updatedAt),
                }
              : dispatch.status === 'failed'
                ? {
                    commandId: command.id,
                    generation: dispatch.generation,
                    status: 'failed' as const,
                    attemptId: AttemptIdSchema.parse(dispatch.attemptId),
                    retryable: dispatch.retryable,
                    error: { code: dispatch.errorCode, message: dispatch.errorMessage },
                    updatedAt: iso(dispatch.updatedAt),
                  }
                : {
                    commandId: command.id,
                    generation: dispatch.generation,
                    status: 'cancelled' as const,
                    attemptId: null,
                    reason: 'mission_cancelled_before_dispatch' as const,
                    cancelledAt: iso(
                      requiredDate(dispatch.cancelledAt, 'Dispatch cancellation time'),
                    ),
                    updatedAt: iso(dispatch.updatedAt),
                  }

    let evidenceIds: string[] = []
    if (effect.callbackId !== null) {
      const links = await this.executor
        .select({ evidenceId: gatewayCallbackEvidence.evidenceId })
        .from(gatewayCallbackEvidence)
        .where(
          and(
            eq(gatewayCallbackEvidence.organizationId, this.organizationId),
            eq(gatewayCallbackEvidence.callbackId, effect.callbackId),
          ),
        )
        .orderBy(asc(gatewayCallbackEvidence.position))
      evidenceIds = links.map((link) => link.evidenceId)
    }
    const effectUpdatedAt = iso(effect.updatedAt)
    const effectState =
      effect.status === 'completed' || effect.status === 'failed'
        ? {
            commandId: command.id,
            status: effect.status,
            callbackId: effect.callbackId,
            evidenceIds,
            updatedAt: effectUpdatedAt,
          }
        : effect.cancellationRequestedAt !== null
          ? {
              commandId: command.id,
              status: 'cancellation_requested' as const,
              callbackId: effect.callbackId,
              evidenceIds: [],
              requestedAt: iso(effect.cancellationRequestedAt),
              updatedAt: effectUpdatedAt,
            }
          : effect.status === 'pending'
            ? {
                commandId: command.id,
                status: 'pending' as const,
                callbackId: null,
                evidenceIds: [],
                updatedAt: effectUpdatedAt,
              }
            : {
                commandId: command.id,
                status: effect.status,
                callbackId: effect.callbackId,
                evidenceIds: [],
                updatedAt: effectUpdatedAt,
              }

    return GatewayEffectRecordSchema.parse({
      command,
      dispatchAt: iso(effect.dispatchAt),
      milestone: effect.milestone,
      cancellationPolicy: effect.cancellationPolicy,
      authorization: mapAuthorization(effect.authorizationKind, effect.authorizingLeaseEpoch),
      dispatchState,
      effectState,
      reconciliationAttempts: effect.reconciliationAttempts,
      lastReconciledAt: effect.lastReconciledAt ? iso(effect.lastReconciledAt) : null,
      createdAt: iso(effect.createdAt),
      updatedAt: effectUpdatedAt,
    })
  }

  private async lockGatewayAggregate(commandId: GatewayCommandId): Promise<{
    command: typeof gatewayCommands.$inferSelect
    effect: typeof gatewayEffects.$inferSelect
    dispatch: typeof gatewayDispatches.$inferSelect
  } | null> {
    const [identity] = await this.executor
      .select({ missionId: gatewayCommands.missionId, operationId: gatewayCommands.operationId })
      .from(gatewayCommands)
      .where(
        and(
          eq(gatewayCommands.organizationId, this.organizationId),
          eq(gatewayCommands.id, commandId),
        ),
      )
      .limit(1)
    if (!identity) return null
    await this.executor
      .select({ id: missions.id })
      .from(missions)
      .where(
        and(eq(missions.organizationId, this.organizationId), eq(missions.id, identity.missionId)),
      )
      .for('update')
      .limit(1)
    await this.executor
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, this.organizationId),
          eq(operations.id, identity.operationId),
        ),
      )
      .for('update')
      .limit(1)
    const [command] = await this.executor
      .select()
      .from(gatewayCommands)
      .where(
        and(
          eq(gatewayCommands.organizationId, this.organizationId),
          eq(gatewayCommands.id, commandId),
        ),
      )
      .for('update')
      .limit(1)
    const [effect] = await this.executor
      .select()
      .from(gatewayEffects)
      .where(
        and(
          eq(gatewayEffects.organizationId, this.organizationId),
          eq(gatewayEffects.commandId, commandId),
        ),
      )
      .for('update')
      .limit(1)
    const [dispatch] = await this.executor
      .select()
      .from(gatewayDispatches)
      .where(
        and(
          eq(gatewayDispatches.organizationId, this.organizationId),
          eq(gatewayDispatches.commandId, commandId),
        ),
      )
      .orderBy(desc(gatewayDispatches.generation))
      .for('update')
      .limit(1)
    return command && effect && dispatch ? { command, effect, dispatch } : null
  }

  private async gatewayCommandSafetyReason(
    command: GatewayCommand,
    effect: typeof gatewayEffects.$inferSelect,
  ): Promise<'authorization_invalid' | 'capability_unavailable' | null> {
    const [binding] = await this.executor
      .select({
        operationStatus: operations.status,
        operationMissionId: operations.missionId,
        planPalaceId: plans.palaceId,
        executionAuthorizationKind: executions.authorizationKind,
        executionLeaseEpoch: executions.authorizingLeaseEpoch,
      })
      .from(operations)
      .innerJoin(
        plans,
        and(eq(plans.organizationId, operations.organizationId), eq(plans.id, operations.planId)),
      )
      .innerJoin(
        executions,
        and(
          eq(executions.organizationId, operations.organizationId),
          eq(executions.operationId, operations.id),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, this.organizationId),
          eq(operations.id, command.operationId),
        ),
      )
      .limit(1)
    const effectAuthorization = mapAuthorization(
      effect.authorizationKind,
      effect.authorizingLeaseEpoch,
    )
    if (
      !binding ||
      binding.operationStatus !== 'committed' ||
      binding.operationMissionId !== command.missionId ||
      binding.planPalaceId !== command.palaceId ||
      !sameAuthorization(
        effectAuthorization,
        mapAuthorization(binding.executionAuthorizationKind, binding.executionLeaseEpoch),
      )
    ) {
      return 'authorization_invalid'
    }

    const requiredCapability =
      command.kind === 'set_temperature'
        ? 'temperature_target'
        : command.kind === 'set_lighting'
          ? 'pathway_lighting'
          : 'lock_desired_state'
    const [target] = await this.executor
      .select({ health: devices.health, enabled: capabilities.enabled })
      .from(devices)
      .innerJoin(
        capabilities,
        and(
          eq(capabilities.organizationId, devices.organizationId),
          eq(capabilities.deviceId, devices.id),
          eq(capabilities.kind, requiredCapability),
        ),
      )
      .where(
        and(
          eq(devices.organizationId, this.organizationId),
          eq(devices.palaceId, command.palaceId),
          eq(devices.id, command.payload.deviceId),
        ),
      )
      .limit(1)
    if (!target || target.health === 'offline' || !target.enabled) {
      return 'capability_unavailable'
    }

    if (command.kind === 'unlock') {
      const cause = await this.evidence.get(command.payload.causedByEvidenceId)
      const [tag] = await this.executor
        .select({ active: identityTags.active, verified: identityTags.verified })
        .from(identityTags)
        .where(
          and(
            eq(identityTags.organizationId, this.organizationId),
            eq(identityTags.id, command.payload.identityTagId),
          ),
        )
        .limit(1)
      if (
        !cause ||
        cause.authorityReceipt.authority !== 'identity_telemetry' ||
        cause.evidence.type !== 'identity_arrival' ||
        cause.evidence.missionId !== command.missionId ||
        cause.evidence.palaceId !== command.palaceId ||
        cause.evidence.identityTagId !== command.payload.identityTagId ||
        !cause.evidence.verified ||
        !tag?.active ||
        !tag.verified
      ) {
        return 'authorization_invalid'
      }
    }
    return null
  }

  public readonly gatewayEffects = {
    get: (commandId: GatewayCommandId): Promise<GatewayEffectRecord | null> =>
      this.hydrateGatewayEffect(GatewayCommandIdSchema.parse(commandId)),

    listForOperation: async (operationId: OperationId): Promise<readonly GatewayEffectRecord[]> => {
      const rows = await this.executor
        .select({ commandId: gatewayCommands.id })
        .from(gatewayCommands)
        .where(
          and(
            eq(gatewayCommands.organizationId, this.organizationId),
            eq(gatewayCommands.operationId, operationId),
          ),
        )
        .orderBy(asc(gatewayCommands.logicalKey))
      const records: GatewayEffectRecord[] = []
      for (const row of rows) {
        const record = await this.hydrateGatewayEffect(GatewayCommandIdSchema.parse(row.commandId))
        if (record) records.push(record)
      }
      return records
    },

    materialize: async (
      input: GatewayEffectMaterialization,
    ): Promise<GatewayEffectMaterializationResult> => {
      const command = GatewayCommandSchema.parse(input.intent.command)
      const authorization = GatewayEffectAuthorizationSchema.parse(input.intent.authorization)
      const dispatchAt = date(input.intent.dispatchAt)
      const createdAt = date(input.intent.createdAt)
      this.assertTenant(command.organizationId)
      this.assertMissionMutation(command.missionId)
      if (command.createdAt !== input.intent.createdAt) {
        throw new DatabaseConflictError('Gateway intent and command creation times differ')
      }
      const isMandatoryRelock =
        input.intent.milestone === 'relock' && command.kind === 'locked_desired_state'
      if ((input.intent.cancellationPolicy === 'mandatory_relock') !== isMandatoryRelock) {
        throw new DatabaseConflictError(
          'Only a locked desired-state relock may survive cancellation',
        )
      }

      await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(
          and(eq(missions.organizationId, this.organizationId), eq(missions.id, command.missionId)),
        )
        .for('update')
        .limit(1)
      const [operation] = await this.executor
        .select({
          id: operations.id,
          status: operations.status,
          missionId: operations.missionId,
          palaceId: plans.palaceId,
        })
        .from(operations)
        .innerJoin(
          plans,
          and(eq(plans.organizationId, operations.organizationId), eq(plans.id, operations.planId)),
        )
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.id, command.operationId),
          ),
        )
        .for('update', { of: operations })
        .limit(1)
      if (
        !operation ||
        operation.status !== 'committed' ||
        operation.missionId !== command.missionId ||
        operation.palaceId !== command.palaceId
      ) {
        throw new DatabaseConflictError('Gateway command does not bind a committed operation')
      }

      const [execution] = await this.executor
        .select({
          id: executions.id,
          authorizationKind: executions.authorizationKind,
          authorizingLeaseEpoch: executions.authorizingLeaseEpoch,
        })
        .from(executions)
        .innerJoin(
          executionMilestones,
          and(
            eq(executionMilestones.organizationId, executions.organizationId),
            eq(executionMilestones.executionId, executions.id),
            eq(executionMilestones.name, input.intent.milestone),
            eq(executionMilestones.commandId, command.id),
          ),
        )
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.operationId, command.operationId),
          ),
        )
        .limit(1)
      if (
        !execution ||
        !sameAuthorization(
          authorization,
          mapAuthorization(execution.authorizationKind, execution.authorizingLeaseEpoch),
        )
      ) {
        throw new MissionFenceRejectedError()
      }
      if (this.fencedMissionId !== null) this.assertInitialAuthorization(authorization)

      const [cancelled] = await this.executor
        .select({ id: cancellations.id })
        .from(cancellations)
        .where(
          and(
            eq(cancellations.organizationId, this.organizationId),
            eq(cancellations.missionId, command.missionId),
          ),
        )
        .limit(1)
      if (cancelled && input.intent.cancellationPolicy !== 'mandatory_relock') {
        throw new DatabaseConflictError(
          'Cancelled missions cannot materialize new optional effects',
        )
      }

      const [existingCommand] = await this.executor
        .select()
        .from(gatewayCommands)
        .where(
          and(
            eq(gatewayCommands.organizationId, this.organizationId),
            or(
              eq(gatewayCommands.id, command.id),
              and(
                eq(gatewayCommands.operationId, command.operationId),
                eq(gatewayCommands.logicalKey, command.logicalKey),
              ),
            ),
          ),
        )
        .for('update')
        .limit(1)
      if (existingCommand) {
        const existing = await this.hydrateGatewayEffect(
          GatewayCommandIdSchema.parse(existingCommand.id),
        )
        if (!existing)
          throw new DatabaseConflictError('Gateway aggregate is partially materialized')
        const existingIntent = {
          command: existing.command,
          dispatchAt: existing.dispatchAt,
          milestone: existing.milestone,
          cancellationPolicy: existing.cancellationPolicy,
          authorization: existing.authorization,
          createdAt: existing.createdAt,
        }
        if (hashCanonical(existingIntent) !== hashCanonical(input.intent)) {
          throw new DatabaseConflictError(
            'Gateway command identity was reused with different immutable intent',
          )
        }
        return { status: 'existing', effect: existing }
      }

      await this.executor.insert(gatewayCommands).values({
        id: command.id,
        schemaVersion: command.schemaVersion,
        organizationId: this.organizationId,
        operationId: command.operationId,
        missionId: command.missionId,
        palaceId: command.palaceId,
        logicalKey: command.logicalKey,
        kind: command.kind,
        payloadHash: command.payloadHash,
        payload: command.payload,
        createdAt,
      })
      await this.executor.insert(gatewayEffects).values({
        organizationId: this.organizationId,
        commandId: command.id,
        operationId: command.operationId,
        missionId: command.missionId,
        dispatchAt,
        milestone: input.intent.milestone,
        cancellationPolicy: input.intent.cancellationPolicy,
        authorizationKind: authorization.kind === 'manual' ? 'manual_activation' : 'mission_lease',
        authorizingLeaseEpoch: authorization.kind === 'mission_lease' ? authorization.epoch : null,
        status: 'pending',
        callbackId: null,
        cancellationRequestedAt: null,
        reconciliationAttempts: 0,
        lastReconciledAt: null,
        createdAt,
        updatedAt: createdAt,
      })
      await this.executor.insert(gatewayDispatches).values({
        organizationId: this.organizationId,
        commandId: command.id,
        operationId: command.operationId,
        generation: 1,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      })
      await this.outbox.insert({
        id: input.dispatchOutboxId,
        organizationId: command.organizationId,
        topic: 'gateway.dispatch',
        deduplicationKey: `gateway.dispatch:${command.id}:1`,
        payload: {
          organizationId: command.organizationId,
          operationId: command.operationId,
          commandId: command.id,
          generation: 1,
        },
        status: 'pending',
        availableAt: input.intent.dispatchAt,
        createdAt: input.intent.createdAt,
        claimedBy: null,
        claimExpiresAt: null,
        dispatchedAt: null,
        deliveryAttempts: 0,
        lastErrorCode: null,
      })
      const materialized = await this.hydrateGatewayEffect(command.id)
      if (!materialized) throw new DatabaseConflictError('Gateway effect materialization vanished')
      return { status: 'created', effect: materialized }
    },

    claimDispatch: async (input: {
      operationId: OperationId
      commandId: GatewayCommandId
      generation: number
      attemptId: ReturnType<typeof AttemptIdSchema.parse>
      claimedAt: string
    }): Promise<GatewayDispatchClaimResult | null> => {
      const commandId = GatewayCommandIdSchema.parse(input.commandId)
      const operationId = OperationIdSchema.parse(input.operationId)
      const attemptId = AttemptIdSchema.parse(input.attemptId)
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
        throw new TypeError('Dispatch generation must be a positive safe integer')
      }
      const claimedAt = date(input.claimedAt)
      const aggregate = await this.lockGatewayAggregate(commandId)
      if (!aggregate || aggregate.command.operationId !== operationId) return null
      const current = await this.hydrateGatewayEffect(commandId)
      if (!current) return null
      if (aggregate.dispatch.generation !== input.generation) {
        return { status: 'not_claimed', reason: 'dispatch_terminal', effect: current }
      }
      if (aggregate.dispatch.status === 'cancelled') {
        return { status: 'not_claimed', reason: 'cancelled', effect: current }
      }
      if (aggregate.effect.status === 'completed' || aggregate.effect.status === 'failed') {
        return { status: 'not_claimed', reason: 'effect_terminal', effect: current }
      }
      if (aggregate.dispatch.status === 'dispatching') {
        return { status: 'not_claimed', reason: 'already_dispatching', effect: current }
      }
      if (aggregate.dispatch.status !== 'pending') {
        return { status: 'not_claimed', reason: 'dispatch_terminal', effect: current }
      }
      if (aggregate.effect.dispatchAt.valueOf() > claimedAt.valueOf()) {
        return { status: 'not_claimed', reason: 'not_due', effect: current }
      }
      const [cancelled] = await this.executor
        .select({ id: cancellations.id })
        .from(cancellations)
        .where(
          and(
            eq(cancellations.organizationId, this.organizationId),
            eq(cancellations.missionId, aggregate.command.missionId),
          ),
        )
        .limit(1)
      if (cancelled && aggregate.effect.cancellationPolicy !== 'mandatory_relock') {
        await this.executor
          .update(gatewayDispatches)
          .set({
            status: 'cancelled',
            cancelledAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
            recordVersion: aggregate.dispatch.recordVersion + 1,
          })
          .where(
            and(
              eq(gatewayDispatches.organizationId, this.organizationId),
              eq(gatewayDispatches.commandId, commandId),
              eq(gatewayDispatches.generation, input.generation),
              eq(gatewayDispatches.status, 'pending'),
            ),
          )
        const effect = await this.hydrateGatewayEffect(commandId)
        if (!effect) return null
        return { status: 'not_claimed', reason: 'cancelled', effect }
      }
      const command = this.mapGatewayCommandV2(aggregate.command)
      const unsafe = await this.gatewayCommandSafetyReason(command, aggregate.effect)
      if (unsafe) return { status: 'not_claimed', reason: unsafe, effect: current }

      const [sequence] = await this.executor
        .select({ next: sql<number>`coalesce(max(${attempts.sequence}), 0) + 1` })
        .from(attempts)
        .where(
          and(
            eq(attempts.organizationId, this.organizationId),
            eq(attempts.operationId, operationId),
          ),
        )
      const attempt = AttemptSchema.parse({
        id: attemptId,
        organizationId: this.organizationId,
        operationId,
        sequence: sequence?.next ?? 1,
        transport: 'gateway',
        commandId,
        generation: input.generation,
        status: 'pending',
        retryable: true,
        error: null,
        startedAt: iso(claimedAt),
        completedAt: null,
      })
      await this.executor.insert(attempts).values({
        id: attempt.id,
        organizationId: this.organizationId,
        operationId,
        gatewayCommandId: commandId,
        dispatchGeneration: input.generation,
        sequence: attempt.sequence,
        transport: 'gateway',
        status: 'pending',
        retryable: true,
        startedAt: claimedAt,
        completedAt: null,
      })
      const updated = await this.executor
        .update(gatewayDispatches)
        .set({
          status: 'dispatching',
          attemptId,
          updatedAt: claimedAt,
          recordVersion: aggregate.dispatch.recordVersion + 1,
        })
        .where(
          and(
            eq(gatewayDispatches.organizationId, this.organizationId),
            eq(gatewayDispatches.commandId, commandId),
            eq(gatewayDispatches.generation, input.generation),
            eq(gatewayDispatches.status, 'pending'),
            eq(gatewayDispatches.recordVersion, aggregate.dispatch.recordVersion),
          ),
        )
        .returning({ commandId: gatewayDispatches.commandId })
      if (updated.length !== 1) throw new OptimisticConcurrencyError('Dispatch claim lost')
      const effect = await this.hydrateGatewayEffect(commandId)
      if (!effect) return null
      return { status: 'claimed', effect, attempt }
    },

    finalizeDispatch: async (input: {
      operationId: OperationId
      commandId: GatewayCommandId
      generation: number
      attemptId: ReturnType<typeof AttemptIdSchema.parse>
      result: Parameters<typeof GatewayDispatchResultSchema.parse>[0]
      completedAt: string
      reconciliationOutboxId: string
    }): Promise<GatewayDispatchFinalizationResult | null> => {
      const operationId = OperationIdSchema.parse(input.operationId)
      const commandId = GatewayCommandIdSchema.parse(input.commandId)
      const attemptId = AttemptIdSchema.parse(input.attemptId)
      const result = GatewayDispatchResultSchema.parse(input.result)
      const completedAt = date(input.completedAt)
      const aggregate = await this.lockGatewayAggregate(commandId)
      if (!aggregate || aggregate.command.operationId !== operationId) return null
      const [attemptRow] = await this.executor
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.organizationId, this.organizationId),
            eq(attempts.id, attemptId),
            eq(attempts.gatewayCommandId, commandId),
            eq(attempts.dispatchGeneration, input.generation),
          ),
        )
        .for('update')
        .limit(1)
      if (!attemptRow) throw new DatabaseConflictError('Dispatch attempt binding is absent')
      if (aggregate.dispatch.generation !== input.generation) {
        const effect = await this.hydrateGatewayEffect(commandId)
        if (!effect) return null
        return { status: 'stale_generation', effect, attempt: mapAttempt(attemptRow) }
      }
      if (
        aggregate.dispatch.status !== 'dispatching' ||
        aggregate.dispatch.attemptId !== attemptId ||
        attemptRow.status !== 'pending'
      ) {
        const effect = await this.hydrateGatewayEffect(commandId)
        if (!effect) return null
        return { status: 'already_finalized', effect, attempt: mapAttempt(attemptRow) }
      }
      const attemptStatus =
        result.status === 'accepted'
          ? 'succeeded'
          : result.status === 'unknown'
            ? 'unknown'
            : 'failed'
      const error =
        result.status === 'accepted'
          ? null
          : result.status === 'unknown'
            ? {
                code: result.reason === 'timeout' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_LOST_ACK',
                message:
                  result.reason === 'timeout'
                    ? 'Gateway response timed out'
                    : 'Gateway acknowledgement was lost',
              }
            : { code: result.code, message: result.message }
      await this.executor
        .update(attempts)
        .set({
          status: attemptStatus,
          retryable: result.status === 'accepted' ? false : result.retryable,
          errorCode: error?.code ?? null,
          errorMessage: error?.message ?? null,
          completedAt,
          recordVersion: attemptRow.recordVersion + 1,
        })
        .where(
          and(
            eq(attempts.organizationId, this.organizationId),
            eq(attempts.id, attemptId),
            eq(attempts.recordVersion, attemptRow.recordVersion),
          ),
        )
      await this.executor
        .update(gatewayDispatches)
        .set({
          status: result.status,
          acknowledgementId: result.status === 'accepted' ? result.acknowledgementId : null,
          retryable: result.status === 'accepted' ? null : result.retryable,
          unknownReason: result.status === 'unknown' ? result.reason : null,
          errorCode: result.status === 'failed' ? result.code : null,
          errorMessage: result.status === 'failed' ? result.message : null,
          updatedAt: completedAt,
          recordVersion: aggregate.dispatch.recordVersion + 1,
        })
        .where(
          and(
            eq(gatewayDispatches.organizationId, this.organizationId),
            eq(gatewayDispatches.commandId, commandId),
            eq(gatewayDispatches.generation, input.generation),
            eq(gatewayDispatches.status, 'dispatching'),
            eq(gatewayDispatches.attemptId, attemptId),
          ),
        )
      if (result.status === 'unknown' || (result.status === 'failed' && result.retryable)) {
        await this.outbox.insert({
          id: input.reconciliationOutboxId,
          organizationId: this.organizationId,
          topic: 'gateway.effect.reconcile',
          deduplicationKey: `gateway.effect.reconcile:${commandId}:${input.generation}:0`,
          payload: {
            organizationId: this.organizationId,
            operationId: aggregate.command.operationId,
            commandId,
            generation: input.generation,
          },
          status: 'pending',
          availableAt: input.completedAt,
          createdAt: input.completedAt,
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          lastErrorCode: null,
        })
      }
      const [completedAttempt] = await this.executor
        .select()
        .from(attempts)
        .where(and(eq(attempts.organizationId, this.organizationId), eq(attempts.id, attemptId)))
        .limit(1)
      const effect = await this.hydrateGatewayEffect(commandId)
      if (!effect || !completedAttempt) return null
      return { status: 'applied', effect, attempt: mapAttempt(completedAttempt) }
    },

    applyCallback: async (input: {
      callback: StoredGatewayCallback
      evidence: readonly PersistedEvidenceRecord[]
    }): Promise<GatewayCallbackApplicationResult | null> => {
      const {
        verifierKeyId: _verifierKeyId,
        verifierVersion: _verifierVersion,
        verifiedPayloadDigest: _verifiedPayloadDigest,
        receivedAt: _receivedAt,
        ...callbackPayload
      } = input.callback
      const callback = GatewayCallbackSchema.parse(callbackPayload)
      this.assertTenant(callback.organizationId)
      this.assertMissionMutation(callback.missionId)
      const computedDigest = computeGatewayCallbackPayloadHash(callback)
      if (computedDigest !== input.callback.verifiedPayloadDigest) {
        throw new DatabaseConflictError('Callback verification digest does not match its payload')
      }
      const aggregate = await this.lockGatewayAggregate(callback.commandId)
      if (!aggregate) return null
      const command = this.mapGatewayCommandV2(aggregate.command)
      validateGatewayCommandCallbackBinding(command, callback)

      const existingRows = await this.executor
        .select()
        .from(gatewayCallbacks)
        .where(
          and(
            eq(gatewayCallbacks.organizationId, this.organizationId),
            or(
              eq(gatewayCallbacks.id, callback.id),
              eq(gatewayCallbacks.nonce, callback.nonce),
              and(
                eq(gatewayCallbacks.commandId, callback.commandId),
                eq(gatewayCallbacks.status, callback.status),
              ),
            ),
          ),
        )
        .for('update')
      if (existingRows.length > 0) {
        const exact = existingRows.find(
          (row) => row.id === callback.id && row.nonce === callback.nonce,
        )
        if (!exact || exact.verifiedPayloadDigest !== computedDigest) {
          throw new DatabaseConflictError('Callback identity, nonce, or status was reused')
        }
        const effect = await this.hydrateGatewayEffect(callback.commandId)
        if (!effect) return null
        return {
          status: 'duplicate',
          effect,
          callback: await this.hydrateGatewayCallback(exact),
        }
      }

      const transition = classifyGatewayCallbackStatusTransition(
        aggregate.effect.status === 'pending' ? null : aggregate.effect.status,
        callback.status,
      )
      if (transition === 'reject_regression' || transition === 'reject_terminal_contradiction') {
        throw new DatabaseConflictError('Gateway callback would regress or contradict effect state')
      }

      const records = input.evidence.map((record) => PersistedEvidenceRecordSchema.parse(record))
      if (
        records.length !== callback.evidence.length ||
        records.some(
          (record, index) =>
            hashCanonical(record.evidence) !== hashCanonical(callback.evidence[index]),
        )
      ) {
        throw new DatabaseConflictError('Callback evidence records do not match callback payload')
      }
      for (const record of records) {
        const receipt = record.authorityReceipt
        if (
          receipt.authority !== 'gateway_callback' ||
          receipt.callbackId !== callback.id ||
          receipt.commandId !== callback.commandId ||
          receipt.verifiedPayloadHash !== computedDigest
        ) {
          throw new DatabaseConflictError('Callback evidence has no matching authority receipt')
        }
      }

      await this.executor.insert(gatewayCallbacks).values({
        id: callback.id,
        organizationId: this.organizationId,
        commandId: callback.commandId,
        operationId: callback.operationId,
        nonce: callback.nonce,
        status: callback.status,
        verifierKeyId: input.callback.verifierKeyId,
        verifierVersion: input.callback.verifierVersion,
        verifiedPayloadDigest: input.callback.verifiedPayloadDigest,
        occurredAt: date(callback.occurredAt),
        receivedAt: date(input.callback.receivedAt),
      })
      await this.evidence.appendMany(records)
      if (records.length > 0) {
        await this.executor.insert(gatewayCallbackEvidence).values(
          records.map((record, position) => ({
            organizationId: this.organizationId,
            callbackId: callback.id,
            evidenceId: record.evidence.id,
            position,
          })),
        )
      }
      await this.executor
        .update(gatewayEffects)
        .set({
          status: callback.status,
          callbackId: callback.id,
          updatedAt: sql`greatest(${gatewayEffects.updatedAt}, ${date(input.callback.receivedAt)})`,
          recordVersion: aggregate.effect.recordVersion + 1,
        })
        .where(
          and(
            eq(gatewayEffects.organizationId, this.organizationId),
            eq(gatewayEffects.commandId, callback.commandId),
            eq(gatewayEffects.recordVersion, aggregate.effect.recordVersion),
          ),
        )
      const effect = await this.hydrateGatewayEffect(callback.commandId)
      if (!effect) return null
      return {
        status: transition === 'replay' ? 'replayed' : 'advanced',
        effect,
        callback: input.callback,
      }
    },

    cancelPendingForMission: async (input: {
      missionId: MissionId
      requestedAt: string
    }): Promise<GatewayPendingCancellationResult> => {
      const missionId = MissionIdSchema.parse(input.missionId)
      const requestedAt = date(input.requestedAt)
      this.assertMissionMutation(missionId)
      await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(and(eq(missions.organizationId, this.organizationId), eq(missions.id, missionId)))
        .for('update')
        .limit(1)
      await this.executor
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.missionId, missionId),
          ),
        )
        .orderBy(asc(operations.id))
        .for('update')
      const commandRows = await this.executor
        .select({ id: gatewayCommands.id })
        .from(gatewayCommands)
        .where(
          and(
            eq(gatewayCommands.organizationId, this.organizationId),
            eq(gatewayCommands.missionId, missionId),
          ),
        )
        .orderBy(asc(gatewayCommands.id))
        .for('update')
      if (commandRows.length === 0) {
        return { cancelledCommandIds: [], preservedCommandIds: [], reconciliationCommandIds: [] }
      }
      const commandIds = commandRows.map((row) => row.id)
      const effectRows = await this.executor
        .select()
        .from(gatewayEffects)
        .where(
          and(
            eq(gatewayEffects.organizationId, this.organizationId),
            inArray(gatewayEffects.commandId, commandIds),
          ),
        )
        .orderBy(asc(gatewayEffects.commandId))
        .for('update')
      const dispatchRows = await this.executor
        .select()
        .from(gatewayDispatches)
        .where(
          and(
            eq(gatewayDispatches.organizationId, this.organizationId),
            inArray(gatewayDispatches.commandId, commandIds),
          ),
        )
        .orderBy(asc(gatewayDispatches.commandId), desc(gatewayDispatches.generation))
        .for('update')
      const currentDispatch = new Map<string, (typeof dispatchRows)[number]>()
      for (const row of dispatchRows) {
        if (!currentDispatch.has(row.commandId)) currentDispatch.set(row.commandId, row)
      }
      const cancelledCommandIds: GatewayCommandId[] = []
      const preservedCommandIds: GatewayCommandId[] = []
      const reconciliationCommandIds: GatewayCommandId[] = []
      for (const effect of effectRows) {
        const commandId = GatewayCommandIdSchema.parse(effect.commandId)
        const dispatch = currentDispatch.get(effect.commandId)
        if (!dispatch) throw new DatabaseConflictError('Gateway effect has no dispatch state')
        if (
          effect.cancellationPolicy === 'mandatory_relock' ||
          effect.status === 'completed' ||
          effect.status === 'failed'
        ) {
          preservedCommandIds.push(commandId)
          continue
        }
        if (dispatch.status === 'pending') {
          await this.executor
            .update(gatewayDispatches)
            .set({
              status: 'cancelled',
              cancelledAt: requestedAt,
              updatedAt: requestedAt,
              recordVersion: dispatch.recordVersion + 1,
            })
            .where(
              and(
                eq(gatewayDispatches.organizationId, this.organizationId),
                eq(gatewayDispatches.commandId, commandId),
                eq(gatewayDispatches.generation, dispatch.generation),
                eq(gatewayDispatches.status, 'pending'),
              ),
            )
          await this.executor
            .update(outboxMessages)
            .set({
              status: 'cancelled',
              claimedBy: null,
              claimExpiresAt: null,
              recordVersion: sql`${outboxMessages.recordVersion} + 1`,
            })
            .where(
              and(
                eq(outboxMessages.organizationId, this.organizationId),
                eq(outboxMessages.topic, 'gateway.dispatch'),
                eq(outboxMessages.commandId, commandId),
                eq(outboxMessages.dispatchGeneration, dispatch.generation),
                inArray(outboxMessages.status, ['pending', 'claimed']),
              ),
            )
          cancelledCommandIds.push(commandId)
          continue
        }
        if (effect.cancellationRequestedAt === null) {
          await this.executor
            .update(gatewayEffects)
            .set({
              cancellationRequestedAt: requestedAt,
              updatedAt: requestedAt,
              recordVersion: effect.recordVersion + 1,
            })
            .where(
              and(
                eq(gatewayEffects.organizationId, this.organizationId),
                eq(gatewayEffects.commandId, commandId),
                eq(gatewayEffects.recordVersion, effect.recordVersion),
              ),
            )
        }
        reconciliationCommandIds.push(commandId)
      }
      return { cancelledCommandIds, preservedCommandIds, reconciliationCommandIds }
    },

    reconcile: async (input: {
      operationId: OperationId
      commandId: GatewayCommandId
      generation: number
      reconciledAt: string
      nextPollAt: string
      maximumAttempts: number
      dispatchOutboxId: string
      reconciliationOutboxId: string
    }): Promise<GatewayEffectReconciliationResult | null> => {
      const operationId = OperationIdSchema.parse(input.operationId)
      const commandId = GatewayCommandIdSchema.parse(input.commandId)
      if (!Number.isSafeInteger(input.maximumAttempts) || input.maximumAttempts < 1) {
        throw new TypeError('Maximum reconciliation attempts must be positive')
      }
      const reconciledAt = date(input.reconciledAt)
      date(input.nextPollAt)
      const aggregate = await this.lockGatewayAggregate(commandId)
      if (
        !aggregate ||
        aggregate.command.operationId !== operationId ||
        aggregate.dispatch.generation !== input.generation
      ) {
        return null
      }
      const [pollSequence] = await this.executor
        .select({
          next: sql<number>`coalesce(max(${gatewayEffectReconciliationPolls.sequence}), 0) + 1`,
        })
        .from(gatewayEffectReconciliationPolls)
        .where(
          and(
            eq(gatewayEffectReconciliationPolls.organizationId, this.organizationId),
            eq(gatewayEffectReconciliationPolls.commandId, commandId),
          ),
        )
      const sequence = pollSequence?.next ?? 1
      let resolution:
        'waiting' | 'retry_authorized' | 'terminal_found' | 'budget_exhausted' | 'escalated' =
        'waiting'
      let status: GatewayEffectReconciliationResult['status'] = 'waiting_for_callback'
      const terminal =
        aggregate.effect.status === 'completed' || aggregate.effect.status === 'failed'
      const retryableDispatch =
        aggregate.dispatch.status === 'unknown' ||
        (aggregate.dispatch.status === 'failed' && aggregate.dispatch.retryable === true)
      if (terminal) {
        resolution = 'terminal_found'
        status = 'resolved'
      } else if (aggregate.dispatch.status === 'cancelled') {
        resolution = 'terminal_found'
        status = 'cancelled'
      } else if (
        retryableDispatch &&
        aggregate.effect.cancellationRequestedAt === null &&
        sequence < input.maximumAttempts
      ) {
        resolution = 'retry_authorized'
        status = 'retry_authorized'
      } else if (sequence >= input.maximumAttempts) {
        resolution = 'budget_exhausted'
        status = 'intervention_required'
      }
      await this.executor.insert(gatewayEffectReconciliationPolls).values({
        organizationId: this.organizationId,
        commandId,
        operationId,
        sequence,
        dispatchGeneration: input.generation,
        observedDispatchStatus: aggregate.dispatch.status,
        observedEffectStatus: aggregate.effect.status,
        cancellationRequested: aggregate.effect.cancellationRequestedAt !== null,
        resolution,
        occurredAt: reconciledAt,
      })
      if (!terminal) {
        await this.executor
          .update(gatewayEffects)
          .set({
            reconciliationAttempts: sequence,
            lastReconciledAt: reconciledAt,
            updatedAt: reconciledAt,
            recordVersion: aggregate.effect.recordVersion + 1,
          })
          .where(
            and(
              eq(gatewayEffects.organizationId, this.organizationId),
              eq(gatewayEffects.commandId, commandId),
              eq(gatewayEffects.recordVersion, aggregate.effect.recordVersion),
            ),
          )
      }
      if (status === 'retry_authorized') {
        const nextGeneration = input.generation + 1
        await this.executor.insert(gatewayDispatches).values({
          organizationId: this.organizationId,
          commandId,
          operationId,
          generation: nextGeneration,
          status: 'pending',
          createdAt: reconciledAt,
          updatedAt: reconciledAt,
        })
        await this.outbox.insert({
          id: input.dispatchOutboxId,
          organizationId: this.organizationId,
          topic: 'gateway.dispatch',
          deduplicationKey: `gateway.dispatch:${commandId}:${nextGeneration}`,
          payload: {
            organizationId: this.organizationId,
            operationId,
            commandId,
            generation: nextGeneration,
          },
          status: 'pending',
          availableAt: input.reconciledAt,
          createdAt: input.reconciledAt,
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          lastErrorCode: null,
        })
      } else if (status === 'waiting_for_callback') {
        await this.outbox.insert({
          id: input.reconciliationOutboxId,
          organizationId: this.organizationId,
          topic: 'gateway.effect.reconcile',
          deduplicationKey: `gateway.effect.reconcile:${commandId}:${input.generation}:${sequence}`,
          payload: {
            organizationId: this.organizationId,
            operationId,
            commandId,
            generation: input.generation,
          },
          status: 'pending',
          availableAt: input.nextPollAt,
          createdAt: input.reconciledAt,
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          lastErrorCode: null,
        })
      }
      const effect = await this.hydrateGatewayEffect(commandId)
      if (!effect) return null
      return status === 'waiting_for_callback'
        ? { status, effect, nextPollAt: input.nextPollAt }
        : { status, effect }
    },
  }

  public readonly evidence = {
    get: async (evidenceId: EvidenceId): Promise<PersistedEvidenceRecord | null> => {
      const [row] = await this.executor
        .select()
        .from(evidence)
        .where(and(eq(evidence.organizationId, this.organizationId), eq(evidence.id, evidenceId)))
        .limit(1)
      return row
        ? PersistedEvidenceRecordSchema.parse({
            evidence: row.payload,
            authorityReceipt: row.authorityReceipt,
            persistedAt: iso(row.persistedAt),
          })
        : null
    },
    appendMany: async (items: readonly PersistedEvidenceRecord[]): Promise<void> => {
      for (const input of items) {
        const item = PersistedEvidenceRecordSchema.parse(input)
        this.assertTenant(item.evidence.organizationId)
        this.assertMissionMutation(item.evidence.missionId)
        await assertOperationTransportSourceBinding(this.executor, item)
        if (item.authorityReceipt.authority === 'identity_telemetry') {
          throw new DatabaseConflictError(
            'Identity telemetry evidence requires the signed ingress repository',
          )
        }
        const [existing] = await this.executor
          .select()
          .from(evidence)
          .where(
            and(
              eq(evidence.organizationId, this.organizationId),
              eq(evidence.id, item.evidence.id),
            ),
          )
          .limit(1)
        if (existing) {
          const stored = PersistedEvidenceRecordSchema.parse({
            evidence: existing.payload,
            authorityReceipt: existing.authorityReceipt,
            persistedAt: iso(existing.persistedAt),
          })
          if (hashCanonical(stored) !== hashCanonical(item)) {
            throw new DatabaseConflictError('Evidence ID was reused with different content')
          }
          continue
        }

        const receipt = item.authorityReceipt
        if (receipt.authority === 'gateway_callback') {
          const [callback] = await this.executor
            .select({
              commandId: gatewayCallbacks.commandId,
              digest: gatewayCallbacks.verifiedPayloadDigest,
            })
            .from(gatewayCallbacks)
            .where(
              and(
                eq(gatewayCallbacks.organizationId, this.organizationId),
                eq(gatewayCallbacks.id, receipt.callbackId),
              ),
            )
            .limit(1)
          if (
            !callback ||
            callback.commandId !== receipt.commandId ||
            callback.digest !== receipt.verifiedPayloadHash
          ) {
            throw new DatabaseConflictError('Gateway evidence authority receipt is not verified')
          }
        } else if (receipt.inputEvidenceIds.length > 0) {
          const inputs = await this.executor
            .select({ id: evidence.id, missionId: evidence.missionId, palaceId: evidence.palaceId })
            .from(evidence)
            .where(
              and(
                eq(evidence.organizationId, this.organizationId),
                inArray(evidence.id, receipt.inputEvidenceIds),
              ),
            )
          if (
            inputs.length !== receipt.inputEvidenceIds.length ||
            inputs.some(
              (source) =>
                source.missionId !== item.evidence.missionId ||
                source.palaceId !== item.evidence.palaceId,
            )
          ) {
            throw new DatabaseConflictError('Application evidence inputs are absent or unbound')
          }
        }
        await this.executor.insert(evidence).values({
          id: item.evidence.id,
          organizationId: this.organizationId,
          missionId: item.evidence.missionId,
          palaceId: item.evidence.palaceId,
          type: item.evidence.type,
          payload: item.evidence,
          authorityReceiptId: receipt.id,
          authority: receipt.authority,
          authorityReceipt: receipt,
          authorityProviderEventId: null,
          authorityCallbackId: receipt.authority === 'gateway_callback' ? receipt.callbackId : null,
          authorityCommandId: receipt.authority === 'gateway_callback' ? receipt.commandId : null,
          applicationRuleId: receipt.authority === 'application' ? receipt.ruleId : null,
          applicationRuleVersion: receipt.authority === 'application' ? receipt.ruleVersion : null,
          verifiedAt: date(receipt.verifiedAt),
          observedAt: date(item.evidence.observedAt),
          persistedAt: date(item.persistedAt),
        })
      }
    },
    listForMission: async (missionId: MissionId): Promise<readonly PersistedEvidenceRecord[]> => {
      const rows = await this.executor
        .select()
        .from(evidence)
        .where(
          and(eq(evidence.organizationId, this.organizationId), eq(evidence.missionId, missionId)),
        )
        .orderBy(asc(evidence.observedAt), asc(evidence.id))
      return rows.map((row) =>
        PersistedEvidenceRecordSchema.parse({
          evidence: row.payload,
          authorityReceipt: row.authorityReceipt,
          persistedAt: iso(row.persistedAt),
        }),
      )
    },
  }

  private async hydrateExecution(row: typeof executions.$inferSelect): Promise<StoredExecution> {
    const links = await this.executor
      .select({ evidenceId: executionEvidence.evidenceId })
      .from(executionEvidence)
      .where(
        and(
          eq(executionEvidence.organizationId, this.organizationId),
          eq(executionEvidence.executionId, row.id),
        ),
      )
      .orderBy(asc(executionEvidence.position))
    const milestoneRows = await this.executor
      .select()
      .from(executionMilestones)
      .where(
        and(
          eq(executionMilestones.organizationId, this.organizationId),
          eq(executionMilestones.executionId, row.id),
        ),
      )
    const order: readonly ExecutionMilestoneName[] = [
      'preheat',
      'verified_arrival',
      'pathway_lighting',
      'unlock',
      'relock',
    ]
    milestoneRows.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name))
    return {
      operationId: row.operationId as OperationId,
      authorization: mapAuthorization(row.authorizationKind, row.authorizingLeaseEpoch),
      execution: ExecutionSchema.parse({
        schemaVersion: row.schemaVersion,
        id: row.id,
        organizationId: row.organizationId,
        missionId: row.missionId,
        operationId: row.operationId,
        routineId: row.routineId,
        routineVersionId: row.routineVersionId,
        status: row.status,
        triggeredByEvidenceId: row.triggeredByEvidenceId,
        evidenceIds: links.map((link) => link.evidenceId),
        startedAt: iso(row.startedAt),
        deadline: iso(row.deadline),
        milestones: milestoneRows.map((milestone) => ({
          name: milestone.name,
          commandId: milestone.commandId,
          status: milestone.status,
          evidenceId: milestone.evidenceId,
          resolvedAt: milestone.resolvedAt ? iso(milestone.resolvedAt) : null,
          failure:
            milestone.failureCode === null || milestone.failureMessage === null
              ? null
              : { code: milestone.failureCode, message: milestone.failureMessage },
        })),
        updatedAt: iso(row.updatedAt),
        completedAt: row.completedAt ? iso(row.completedAt) : null,
      }),
    }
  }

  public readonly executions = {
    get: async (executionId: ExecutionId): Promise<StoredExecution | null> => {
      const [row] = await this.executor
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, ExecutionIdSchema.parse(executionId)),
          ),
        )
        .limit(1)
      return row ? this.hydrateExecution(row) : null
    },
    list: async (input: {
      routineId?: RoutineId
      missionId?: MissionId
      limit: number
    }): Promise<readonly Execution[]> => {
      const parsed = ExecutionsListInputSchema.parse(input)
      const predicates = [eq(executions.organizationId, this.organizationId)]
      if (parsed.routineId) predicates.push(eq(executions.routineId, parsed.routineId))
      if (parsed.missionId) predicates.push(eq(executions.missionId, parsed.missionId))
      const rows = await this.executor
        .select()
        .from(executions)
        .where(and(...predicates))
        .orderBy(desc(executions.startedAt), desc(executions.id))
        .limit(parsed.limit)
      const projected: Execution[] = []
      for (const row of rows) projected.push((await this.hydrateExecution(row)).execution)
      return ExecutionsListOutputSchema.parse({ executions: projected }).executions
    },
    findForOperation: async (operationId: OperationId): Promise<StoredExecution | null> => {
      const [row] = await this.executor
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.operationId, operationId),
          ),
        )
        .limit(1)
      return row ? this.hydrateExecution(row) : null
    },
    listForMission: async (missionId: MissionId): Promise<readonly StoredExecution[]> => {
      const rows = await this.executor
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.missionId, missionId),
          ),
        )
        .orderBy(asc(executions.startedAt))
      const hydrated: StoredExecution[] = []
      for (const row of rows) hydrated.push(await this.hydrateExecution(row))
      return hydrated
    },
    insert: async (stored: StoredExecution): Promise<void> => {
      const execution = ExecutionSchema.parse(stored.execution)
      const authorization = GatewayEffectAuthorizationSchema.parse(stored.authorization)
      this.assertTenant(execution.organizationId)
      this.assertMissionMutation(execution.missionId)
      this.assertInitialAuthorization(authorization)
      if (stored.operationId !== execution.operationId) {
        throw new DatabaseConflictError('Stored execution operation wrapper does not match payload')
      }
      await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.id, execution.missionId),
          ),
        )
        .for('update')
        .limit(1)
      const [operation] = await this.executor
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.id, execution.operationId),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !operation ||
        operation.status !== 'committed' ||
        operation.missionId !== execution.missionId ||
        operation.outcome?.routineId !== execution.routineId ||
        operation.outcome.routineVersionId !== execution.routineVersionId
      ) {
        throw new DatabaseConflictError('Execution does not match its operation')
      }
      const trigger = await this.evidence.get(execution.triggeredByEvidenceId)
      if (
        !trigger ||
        trigger.evidence.missionId !== execution.missionId ||
        trigger.evidence.organizationId !== this.organizationId
      ) {
        throw new DatabaseConflictError('Execution trigger is not persisted and tenant-bound')
      }
      const [existing] = await this.executor
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            or(eq(executions.id, execution.id), eq(executions.operationId, execution.operationId)),
          ),
        )
        .limit(1)
      if (existing) {
        const hydrated = await this.hydrateExecution(existing)
        if (hashCanonical(hydrated) !== hashCanonical(stored)) {
          throw new DatabaseConflictError('Execution identity was reused with different content')
        }
        return
      }
      await this.executor.insert(executions).values({
        id: execution.id,
        schemaVersion: execution.schemaVersion,
        organizationId: this.organizationId,
        operationId: execution.operationId,
        missionId: execution.missionId,
        routineId: execution.routineId,
        routineVersionId: execution.routineVersionId,
        status: execution.status,
        authorizationKind: authorization.kind === 'manual' ? 'manual_activation' : 'mission_lease',
        authorizingLeaseEpoch: authorization.kind === 'mission_lease' ? authorization.epoch : null,
        triggeredByEvidenceId: execution.triggeredByEvidenceId,
        startedAt: date(execution.startedAt),
        deadline: date(execution.deadline),
        updatedAt: date(execution.updatedAt),
        completedAt: execution.completedAt ? date(execution.completedAt) : null,
      })
      await this.executor.insert(executionMilestones).values(
        execution.milestones.map((milestone) => ({
          organizationId: this.organizationId,
          executionId: execution.id,
          name: milestone.name,
          commandId: milestone.commandId,
          status: milestone.status,
          evidenceId: milestone.evidenceId,
          resolvedAt: milestone.resolvedAt ? date(milestone.resolvedAt) : null,
          failureCode: milestone.failure?.code ?? null,
          failureMessage: milestone.failure?.message ?? null,
        })),
      )
      if (execution.evidenceIds.length > 0) {
        await this.executor.insert(executionEvidence).values(
          execution.evidenceIds.map((evidenceId, position) => ({
            organizationId: this.organizationId,
            executionId: execution.id,
            evidenceId,
            position,
          })),
        )
      }
    },
    advanceMilestone: async (input: {
      operationId: OperationId
      milestone: ExecutionMilestoneName
      commandId: GatewayCommandId | null
      evidenceId: EvidenceId
      resolvedAt: string
      failure: ExecutionMilestoneFailure | null
    }): Promise<ExecutionMilestoneUpdateResult | null> => {
      const operationId = OperationIdSchema.parse(input.operationId)
      const resolvedAt = date(input.resolvedAt)
      const [identity] = await this.executor
        .select({ id: executions.id, missionId: executions.missionId })
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.operationId, operationId),
          ),
        )
        .limit(1)
      if (!identity) return null
      await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(
          and(
            eq(missions.organizationId, this.organizationId),
            eq(missions.id, identity.missionId),
          ),
        )
        .for('update')
        .limit(1)
      await this.executor
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(eq(operations.organizationId, this.organizationId), eq(operations.id, operationId)),
        )
        .for('update')
        .limit(1)
      const [execution] = await this.executor
        .select()
        .from(executions)
        .where(
          and(eq(executions.organizationId, this.organizationId), eq(executions.id, identity.id)),
        )
        .for('update')
        .limit(1)
      const [milestone] = await this.executor
        .select()
        .from(executionMilestones)
        .where(
          and(
            eq(executionMilestones.organizationId, this.organizationId),
            eq(executionMilestones.executionId, identity.id),
            eq(executionMilestones.name, input.milestone),
          ),
        )
        .for('update')
        .limit(1)
      if (!execution || !milestone) return null
      if (milestone.commandId !== input.commandId) {
        throw new DatabaseConflictError('Milestone command does not match its planned identity')
      }
      const evidenceRecord = await this.evidence.get(input.evidenceId)
      if (!evidenceRecord || evidenceRecord.evidence.missionId !== execution.missionId) {
        throw new DatabaseConflictError(
          'Milestone evidence is absent or belongs to another mission',
        )
      }
      const targetStatus = input.failure === null ? 'completed' : 'failed'
      if (milestone.status !== 'pending') {
        const replayed =
          milestone.status === targetStatus &&
          milestone.evidenceId === input.evidenceId &&
          iso(requiredDate(milestone.resolvedAt, 'Milestone resolution time')) ===
            input.resolvedAt &&
          hashCanonical(
            milestone.failureCode === null
              ? null
              : { code: milestone.failureCode, message: milestone.failureMessage },
          ) === hashCanonical(input.failure)
        if (!replayed) throw new DatabaseConflictError('Milestone was resolved with other content')
        return { status: 'replayed', execution: (await this.hydrateExecution(execution)).execution }
      }
      const [position] = await this.executor
        .select({ next: sql<number>`coalesce(max(${executionEvidence.position}), -1) + 1` })
        .from(executionEvidence)
        .where(
          and(
            eq(executionEvidence.organizationId, this.organizationId),
            eq(executionEvidence.executionId, execution.id),
          ),
        )
      await this.executor
        .insert(executionEvidence)
        .values({
          organizationId: this.organizationId,
          executionId: execution.id,
          evidenceId: input.evidenceId,
          position: position?.next ?? 0,
        })
        .onConflictDoNothing()
      await this.executor
        .update(executionMilestones)
        .set({
          status: targetStatus,
          evidenceId: input.evidenceId,
          resolvedAt,
          failureCode: input.failure?.code ?? null,
          failureMessage: input.failure?.message ?? null,
        })
        .where(
          and(
            eq(executionMilestones.organizationId, this.organizationId),
            eq(executionMilestones.executionId, execution.id),
            eq(executionMilestones.name, input.milestone),
            eq(executionMilestones.status, 'pending'),
          ),
        )
      const updatedAt = new Date(Math.max(execution.updatedAt.valueOf(), resolvedAt.valueOf()))
      await this.executor
        .update(executions)
        .set({
          status: 'running',
          updatedAt,
          recordVersion: execution.recordVersion + 1,
        })
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, execution.id),
            eq(executions.recordVersion, execution.recordVersion),
          ),
        )
      const updated = await this.hydrateExecution({
        ...execution,
        status: 'running',
        updatedAt,
        recordVersion: execution.recordVersion + 1,
      })
      return { status: 'advanced', execution: updated.execution }
    },
    evaluateReadiness: async (input: {
      missionId: MissionId
      operationId: OperationId
      executionId: ExecutionId
      evaluatedAt: string
    }): Promise<ExecutionReadinessResult | null> => {
      const missionId = MissionIdSchema.parse(input.missionId)
      const operationId = OperationIdSchema.parse(input.operationId)
      const executionId = ExecutionIdSchema.parse(input.executionId)
      const evaluatedAt = date(input.evaluatedAt)
      this.assertMissionMutation(missionId)
      await this.executor
        .select({ id: missions.id })
        .from(missions)
        .where(and(eq(missions.organizationId, this.organizationId), eq(missions.id, missionId)))
        .for('update')
        .limit(1)
      await this.executor
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, this.organizationId),
            eq(operations.id, operationId),
            eq(operations.missionId, missionId),
          ),
        )
        .for('update')
        .limit(1)
      const [row] = await this.executor
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, executionId),
            eq(executions.operationId, operationId),
            eq(executions.missionId, missionId),
          ),
        )
        .for('update')
        .limit(1)
      if (!row) return null
      await this.executor
        .select({ name: executionMilestones.name })
        .from(executionMilestones)
        .where(
          and(
            eq(executionMilestones.organizationId, this.organizationId),
            eq(executionMilestones.executionId, executionId),
          ),
        )
        .orderBy(asc(executionMilestones.name))
        .for('update')
      const stored = await this.hydrateExecution(row)
      const decision = classifyExecutionReadiness(stored.execution, input.evaluatedAt)
      if (!decision.ready) return { status: 'not_ready', execution: stored.execution }
      if (stored.execution.status === 'observed' || stored.execution.status === 'failed') {
        return { status: 'replayed', reason: decision.reason, execution: stored.execution }
      }
      const terminalStatus = decision.reason === 'all_completed' ? 'observed' : 'failed'
      await this.executor
        .update(executions)
        .set({
          status: terminalStatus,
          updatedAt: evaluatedAt,
          completedAt: evaluatedAt,
          recordVersion: row.recordVersion + 1,
        })
        .where(
          and(
            eq(executions.organizationId, this.organizationId),
            eq(executions.id, executionId),
            eq(executions.recordVersion, row.recordVersion),
          ),
        )
      const finalized = await this.hydrateExecution({
        ...row,
        status: terminalStatus,
        updatedAt: evaluatedAt,
        completedAt: evaluatedAt,
        recordVersion: row.recordVersion + 1,
      })
      return { status: 'finalized', reason: decision.reason, execution: finalized.execution }
    },
  }

  public readonly verifications = {
    findForMission: async (missionId: MissionId): Promise<Verification | null> => {
      const [row] = await this.executor
        .select()
        .from(verifications)
        .where(
          and(
            eq(verifications.organizationId, this.organizationId),
            eq(verifications.missionId, missionId),
          ),
        )
        .limit(1)
      return row
        ? VerificationSchema.parse({
            id: row.id,
            organizationId: row.organizationId,
            missionId: row.missionId,
            source: row.source,
            status: row.status,
            planHash: row.planHash,
            assertions: row.assertions,
            completedAt: iso(row.completedAt),
          })
        : null
    },
    insert: async (input: Verification): Promise<void> => {
      const verification = VerificationSchema.parse(input)
      this.assertTenant(verification.organizationId)
      this.assertMissionMutation(verification.missionId)
      await this.executor.insert(verifications).values({
        id: verification.id,
        organizationId: this.organizationId,
        missionId: verification.missionId,
        source: verification.source,
        status: verification.status,
        planHash: verification.planHash,
        assertions: verification.assertions,
        completedAt: date(verification.completedAt),
      })
    },
  }

  public readonly missionLeases = {
    get: async (missionId: MissionId): Promise<MissionLeaseRecord | null> => {
      const [row] = await this.executor
        .select()
        .from(missionLeases)
        .where(
          and(
            eq(missionLeases.organizationId, this.organizationId),
            eq(missionLeases.missionId, missionId),
          ),
        )
        .limit(1)
      return row
        ? {
            missionId: row.missionId as MissionId,
            organizationId: this.organizationId,
            ownerId: row.ownerId,
            epoch: row.epoch,
            tokenFingerprint: Sha256Schema.parse(row.tokenFingerprint),
            acquiredAt: iso(row.acquiredAt),
            expiresAt: iso(row.expiresAt),
            renewedAt: iso(row.renewedAt),
            releasedAt: row.releasedAt ? iso(row.releasedAt) : null,
          }
        : null
    },
    acquire: async (input: MissionLeaseAcquisition): Promise<MissionFence | null> => {
      const organizationId = OrganizationIdSchema.parse(input.organizationId)
      const missionId = MissionIdSchema.parse(input.missionId)
      const ownerId = validateOwnerId(input.ownerId)
      const ttlMilliseconds = validateLeaseTtl(input.ttlMilliseconds)
      const tokenFingerprint = storageFingerprint(input.token)
      this.assertTenant(organizationId)
      this.assertUnfencedMutation()
      const [inserted] = await this.executor
        .insert(missionLeases)
        .values({
          organizationId,
          missionId,
          ownerId,
          epoch: 1,
          tokenFingerprint,
          acquiredAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + ${ttlMilliseconds} * interval '1 millisecond'`,
          renewedAt: sql`clock_timestamp()`,
          releasedAt: null,
          recordVersion: 1,
        })
        .onConflictDoNothing({ target: [missionLeases.organizationId, missionLeases.missionId] })
        .returning({ epoch: missionLeases.epoch })
      if (inserted) {
        return { organizationId, missionId, ownerId, epoch: inserted.epoch, token: input.token }
      }
      const [existing] = await this.executor
        .select()
        .from(missionLeases)
        .where(
          and(
            eq(missionLeases.organizationId, organizationId),
            eq(missionLeases.missionId, missionId),
          ),
        )
        .for('update')
        .limit(1)
      if (!existing) return null
      const databaseNow = await databaseWallTime(this.executor)
      if (existing.releasedAt === null && existing.expiresAt.valueOf() > databaseNow.valueOf()) {
        return null
      }
      const availability =
        existing.releasedAt === null
          ? and(
              sql`${missionLeases.releasedAt} IS NULL`,
              lte(missionLeases.expiresAt, sql`clock_timestamp()`),
            )
          : sql`${missionLeases.releasedAt} IS NOT NULL`
      const [updated] = await this.executor
        .update(missionLeases)
        .set({
          ownerId,
          epoch: existing.epoch + 1,
          tokenFingerprint,
          acquiredAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + ${ttlMilliseconds} * interval '1 millisecond'`,
          renewedAt: sql`clock_timestamp()`,
          releasedAt: null,
          recordVersion: existing.recordVersion + 1,
        })
        .where(
          and(
            eq(missionLeases.organizationId, organizationId),
            eq(missionLeases.missionId, missionId),
            eq(missionLeases.ownerId, existing.ownerId),
            eq(missionLeases.epoch, existing.epoch),
            eq(missionLeases.tokenFingerprint, existing.tokenFingerprint),
            eq(missionLeases.recordVersion, existing.recordVersion),
            availability,
          ),
        )
        .returning({ epoch: missionLeases.epoch })
      if (!updated) return null
      const epoch = updated.epoch
      if (!Number.isSafeInteger(epoch) || epoch < 1) {
        throw new DatabaseConflictError('Database returned an invalid mission lease epoch')
      }
      return { organizationId, missionId, ownerId, epoch, token: input.token }
    },
    renew: async (
      inputFence: MissionFence,
      inputTtlMilliseconds: number,
    ): Promise<MissionFence | null> => {
      const fence = validateFence(inputFence)
      const ttlMilliseconds = validateLeaseTtl(inputTtlMilliseconds)
      this.assertTenant(fence.organizationId)
      this.assertUnfencedMutation()
      const [current] = await this.executor
        .select({
          ownerId: missionLeases.ownerId,
          epoch: missionLeases.epoch,
          tokenFingerprint: missionLeases.tokenFingerprint,
          expiresAt: missionLeases.expiresAt,
          releasedAt: missionLeases.releasedAt,
        })
        .from(missionLeases)
        .where(
          and(
            eq(missionLeases.organizationId, fence.organizationId),
            eq(missionLeases.missionId, fence.missionId),
          ),
        )
        .for('update')
        .limit(1)
      const databaseNow = await databaseWallTime(this.executor)
      if (
        !current ||
        current.ownerId !== fence.ownerId ||
        current.epoch !== fence.epoch ||
        current.tokenFingerprint !== fence.tokenFingerprint ||
        current.releasedAt !== null ||
        current.expiresAt.valueOf() <= databaseNow.valueOf()
      ) {
        return null
      }
      const result = await this.executor.execute(sql`
        UPDATE ${missionLeases}
        SET renewed_at = clock_timestamp(),
            expires_at = clock_timestamp() + ${ttlMilliseconds} * interval '1 millisecond',
            record_version = ${missionLeases.recordVersion} + 1
        WHERE organization_id = ${fence.organizationId}
          AND mission_id = ${fence.missionId}
          AND owner_id = ${fence.ownerId}
          AND epoch = ${fence.epoch}
          AND token_fingerprint = ${fence.tokenFingerprint}
          AND released_at IS NULL
          AND expires_at > clock_timestamp()
        RETURNING epoch
      `)
      return result.rowCount === 1
        ? {
            organizationId: fence.organizationId,
            missionId: fence.missionId,
            ownerId: fence.ownerId,
            epoch: fence.epoch,
            token: fence.token,
          }
        : null
    },
    release: async (inputFence: MissionFence): Promise<boolean> => {
      const fence = validateFence(inputFence)
      this.assertTenant(fence.organizationId)
      this.assertUnfencedMutation()
      const [current] = await this.executor
        .select({
          ownerId: missionLeases.ownerId,
          epoch: missionLeases.epoch,
          tokenFingerprint: missionLeases.tokenFingerprint,
          expiresAt: missionLeases.expiresAt,
          releasedAt: missionLeases.releasedAt,
        })
        .from(missionLeases)
        .where(
          and(
            eq(missionLeases.organizationId, fence.organizationId),
            eq(missionLeases.missionId, fence.missionId),
          ),
        )
        .for('update')
        .limit(1)
      const databaseNow = await databaseWallTime(this.executor)
      if (
        !current ||
        current.ownerId !== fence.ownerId ||
        current.epoch !== fence.epoch ||
        current.tokenFingerprint !== fence.tokenFingerprint ||
        current.releasedAt !== null ||
        current.expiresAt.valueOf() <= databaseNow.valueOf()
      ) {
        return false
      }
      const result = await this.executor.execute(sql`
        UPDATE ${missionLeases}
        SET released_at = clock_timestamp(),
            record_version = ${missionLeases.recordVersion} + 1
        WHERE organization_id = ${fence.organizationId}
          AND mission_id = ${fence.missionId}
          AND owner_id = ${fence.ownerId}
          AND epoch = ${fence.epoch}
          AND token_fingerprint = ${fence.tokenFingerprint}
          AND released_at IS NULL
          AND expires_at > clock_timestamp()
        RETURNING epoch
      `)
      return result.rowCount === 1
    },
  }

  public readonly cancellations = {
    findForMission: async (missionId: MissionId): Promise<CancellationRecord | null> => {
      const [row] = await this.executor
        .select()
        .from(cancellations)
        .where(
          and(
            eq(cancellations.organizationId, this.organizationId),
            eq(cancellations.missionId, missionId),
          ),
        )
        .limit(1)
      return row
        ? {
            id: row.id,
            organizationId: this.organizationId,
            missionId: row.missionId as MissionId,
            requestedBy: row.requestedBy,
            reason: row.reason,
            checkpoint: row.checkpoint,
            outcome: row.outcome,
            compensatingPlanRequired: row.compensatingPlanRequired,
            requestedAt: iso(row.requestedAt),
          }
        : null
    },
    insert: async (record: CancellationRecord): Promise<void> => {
      this.assertTenant(record.organizationId)
      this.assertMissionMutation(record.missionId)
      await this.executor.insert(cancellations).values({
        id: record.id,
        organizationId: this.organizationId,
        missionId: record.missionId,
        requestedBy: record.requestedBy,
        reason: record.reason,
        checkpoint: record.checkpoint,
        outcome: record.outcome,
        compensatingPlanRequired: record.compensatingPlanRequired,
        requestedAt: date(record.requestedAt),
      })
    },
  }

  public readonly compensatingPlans = {
    findByPlan: async (planId: PlanId): Promise<CompensatingPlanLink | null> => {
      const [row] = await this.executor
        .select()
        .from(compensatingPlanLinks)
        .where(
          and(
            eq(compensatingPlanLinks.organizationId, this.organizationId),
            eq(compensatingPlanLinks.planId, planId),
          ),
        )
        .limit(1)
      return row
        ? {
            organizationId: this.organizationId,
            planId: row.planId as PlanId,
            actionId: row.actionId as PlanActionId,
            compensatesOperationId: row.compensatesOperationId as OperationId,
            createdAt: iso(row.createdAt),
          }
        : null
    },
    insert: async (link: CompensatingPlanLink): Promise<void> => {
      this.assertTenant(link.organizationId)
      await this.assertPlanMutation(link.planId)
      await this.assertOperationMutation(link.compensatesOperationId)
      await this.executor.insert(compensatingPlanLinks).values({
        organizationId: this.organizationId,
        planId: link.planId,
        actionId: link.actionId,
        compensatesOperationId: link.compensatesOperationId,
        createdAt: date(link.createdAt),
      })
    },
  }

  public readonly planAssessments = {
    saveValidation: async (record: PlanValidationRecord): Promise<void> => {
      await this.assertPlanMutation(record.planId)
      await this.executor.insert(planValidations).values({
        id: createDatabaseId('pval'),
        organizationId: this.organizationId,
        planId: record.planId,
        valid: record.valid,
        checks: record.checks.map((check) => ({ ...check })),
        createdAt: date(record.createdAt),
      })
    },
    getValidation: async (planId: PlanId): Promise<PlanValidationRecord | null> => {
      const [row] = await this.executor
        .select()
        .from(planValidations)
        .where(
          and(
            eq(planValidations.organizationId, this.organizationId),
            eq(planValidations.planId, planId),
          ),
        )
        .orderBy(desc(planValidations.createdAt))
        .limit(1)
      return row
        ? {
            planId: row.planId as PlanId,
            valid: row.valid,
            checks: row.checks,
            createdAt: iso(row.createdAt),
          }
        : null
    },
    saveSimulation: async (record: PlanSimulationRecord): Promise<void> => {
      await this.assertPlanMutation(record.planId)
      await this.executor.insert(planSimulations).values({
        id: createDatabaseId('psim'),
        organizationId: this.organizationId,
        planId: record.planId,
        feasible: record.feasible,
        projectedBatteryUsePercentagePoints: record.projectedBatteryUsePercentagePoints,
        results: record.results.map((result) => ({ ...result })),
        createdAt: date(record.createdAt),
      })
    },
    listSimulations: async (planId: PlanId): Promise<readonly PlanSimulationRecord[]> => {
      const rows = await this.executor
        .select()
        .from(planSimulations)
        .where(
          and(
            eq(planSimulations.organizationId, this.organizationId),
            eq(planSimulations.planId, planId),
          ),
        )
        .orderBy(asc(planSimulations.createdAt))
      return rows.map((row) => ({
        planId: row.planId as PlanId,
        feasible: row.feasible,
        projectedBatteryUsePercentagePoints: row.projectedBatteryUsePercentagePoints,
        results: row.results,
        createdAt: iso(row.createdAt),
      }))
    },
  }

  public readonly reconciliations = {
    listForOperation: async (operationId: OperationId): Promise<readonly ReconciliationPoll[]> => {
      const rows = await this.executor
        .select()
        .from(reconciliationPolls)
        .where(
          and(
            eq(reconciliationPolls.organizationId, this.organizationId),
            eq(reconciliationPolls.operationId, operationId),
          ),
        )
        .orderBy(asc(reconciliationPolls.sequence))
      return rows.map((row) => ({
        organizationId: this.organizationId,
        operationId: row.operationId as OperationId,
        sequence: row.sequence,
        resolution: row.resolution,
        occurredAt: iso(row.occurredAt),
      }))
    },
    insert: async (poll: ReconciliationPoll): Promise<void> => {
      this.assertTenant(poll.organizationId)
      await this.assertOperationMutation(poll.operationId)
      await this.executor.insert(reconciliationPolls).values({
        organizationId: this.organizationId,
        operationId: poll.operationId,
        sequence: poll.sequence,
        resolution: poll.resolution,
        occurredAt: date(poll.occurredAt),
      })
    },
  }

  public readonly contextReceipts = {
    get: async (inputReceiptId: ContextReceiptId): Promise<ContextReceipt | null> => {
      const receiptId = ContextReceiptIdSchema.parse(inputReceiptId)
      const [row] = await this.executor
        .select()
        .from(contextReceipts)
        .where(
          and(
            eq(contextReceipts.organizationId, this.organizationId),
            eq(contextReceipts.id, receiptId),
          ),
        )
        .limit(1)
      return row ? mapContextReceipt(row) : null
    },
    findLatestForMissionAtOrBefore: async (
      inputMissionId: MissionId,
      inputCreatedAt: string,
    ): Promise<ContextReceipt | null> => {
      const missionId = MissionIdSchema.parse(inputMissionId)
      const [row] = await this.executor
        .select()
        .from(contextReceipts)
        .where(
          and(
            eq(contextReceipts.organizationId, this.organizationId),
            eq(contextReceipts.missionId, missionId),
            lte(contextReceipts.createdAt, date(inputCreatedAt)),
          ),
        )
        .orderBy(desc(contextReceipts.createdAt), desc(contextReceipts.id))
        .limit(1)
      return row ? mapContextReceipt(row) : null
    },
    insert: async (input: ContextReceipt): Promise<void> => {
      const receipt = ContextReceiptSchema.parse(input)
      this.assertTenant(receipt.organizationId)
      this.assertMissionMutation(receipt.missionId)
      await this.executor.insert(contextReceipts).values({
        id: receipt.id,
        organizationId: this.organizationId,
        missionId: receipt.missionId,
        runId: receipt.runId,
        policyHash: receipt.policyHash,
        toolRegistryHash: receipt.toolRegistryHash,
        sources: receipt.sources,
        createdAt: date(receipt.createdAt),
      })
    },
  }

  public async activateApprovedOperation(input: {
    operationId: OperationId
    expectedVersion: number
    at: string
  }): Promise<Operation> {
    await this.assertOperationMutation(input.operationId)
    const operation = await this.operations.get(input.operationId)
    if (!operation) throw new DatabaseNotFoundError('Operation')
    const plan = await this.getPlan(operation.planId)
    const approval = await this.getApproval(operation.approvalId)
    if (!plan || !approval) throw new ApprovalBindingError('Operation approval chain is absent')
    const action = plan.actions.find((candidate) => candidate.id === operation.planActionId)
    if (!action) throw new ApprovalBindingError('Operation action is absent from its plan')
    const requestedAction = isRoutineReplacementAction(action)
      ? { ...action, expectedProtectedVersion: input.expectedVersion }
      : { ...action, expectedCurrentVersion: input.expectedVersion }
    if (operation.payloadHash !== hashCanonical({ planHash: plan.hash, action: requestedAction })) {
      throw new ApprovalBindingError('Expected version changes the approved operation payload')
    }
    if (operation.status === 'committed') return operation
    if (operation.status !== 'pending') {
      throw new DatabaseConflictError(`Operation cannot activate from ${operation.status}`)
    }
    assertApprovalAuthorizesPlan(approval, plan, input.at)
    await this.assertProtectedResourcesCurrent(approval)
    const outcome = await this.routines.applyApprovedAction(plan, action)
    const committed = OperationSchema.parse({
      ...operation,
      status: 'committed',
      outcome,
      committedAt: input.at,
    })
    await this.operations.save(committed)
    return committed
  }

  public readonly records = {
    insertMembership: async (input: Membership): Promise<void> => {
      this.assertUnfencedMutation()
      const membership = MembershipSchema.parse(input)
      this.assertTenant(membership.organizationId)
      await this.executor.insert(memberships).values({
        id: membership.id,
        organizationId: this.organizationId,
        userId: membership.userId,
        role: membership.role,
        grants: membership.grants,
        createdAt: date(membership.createdAt),
        revokedAt: membership.revokedAt ? date(membership.revokedAt) : null,
      })
    },
    insertPalace: async (input: Palace): Promise<void> => {
      this.assertUnfencedMutation()
      const palace = PalaceSchema.parse(input)
      this.assertTenant(palace.organizationId)
      await this.executor.insert(palaces).values({
        id: palace.id,
        organizationId: this.organizationId,
        name: palace.name,
        timezone: palace.timezone,
        batteryAvailablePercentage: palace.batteryAvailablePercentage,
        createdAt: date(palace.createdAt),
      })
    },
    insertCrewMember: async (input: CrewMember): Promise<void> => {
      this.assertUnfencedMutation()
      const crewMember = CrewMemberSchema.parse(input)
      this.assertTenant(crewMember.organizationId)
      await this.executor
        .insert(crewMembers)
        .values({ ...crewMember, organizationId: this.organizationId })
    },
    insertCrewSchedule: async (input: CrewSchedule): Promise<void> => {
      this.assertUnfencedMutation()
      const schedule = CrewScheduleSchema.parse(input)
      this.assertTenant(schedule.organizationId)
      await this.executor.insert(crewSchedules).values({
        id: schedule.id,
        organizationId: this.organizationId,
        palaceId: schedule.palaceId,
        crewMemberId: schedule.crewMemberId,
        active: schedule.active,
        version: schedule.version,
        timezone: schedule.timezone,
        windowStart: schedule.windowStart,
        windowEnd: schedule.windowEnd,
      })
    },
    insertCrewPreference: async (input: CrewPreference): Promise<void> => {
      this.assertUnfencedMutation()
      const preference = CrewPreferenceSchema.parse(input)
      this.assertTenant(preference.organizationId)
      await this.executor.insert(crewPreferences).values({
        id: preference.id,
        organizationId: this.organizationId,
        palaceId: preference.palaceId,
        crewMemberId: preference.crewMemberId,
        kind: preference.kind,
        active: preference.active,
        version: preference.version,
        targetCelsius: preference.targetCelsius,
        pathwayLightingIntensityPercent: preference.pathwayLightingIntensityPercent,
        pathwayLightingDurationSeconds: preference.pathwayLightingDurationSeconds,
      })
    },
    insertIdentityTag: async (input: IdentityTag): Promise<void> => {
      this.assertUnfencedMutation()
      const tag = IdentityTagSchema.parse(input)
      this.assertTenant(tag.organizationId)
      await this.executor
        .insert(identityTags)
        .values({ ...tag, organizationId: this.organizationId })
    },
    insertDevice: async (input: Device): Promise<void> => {
      this.assertUnfencedMutation()
      const device = DeviceSchema.parse(input)
      this.assertTenant(device.organizationId)
      await this.executor.insert(devices).values({ ...device, organizationId: this.organizationId })
    },
    insertCapability: async (input: Capability): Promise<void> => {
      this.assertUnfencedMutation()
      const capability = CapabilitySchema.parse(input)
      this.assertTenant(capability.organizationId)
      await this.executor
        .insert(capabilities)
        .values({ ...capability, organizationId: this.organizationId })
    },
    insertRoutine: async (inputRoutine: Routine, inputVersion: RoutineVersion): Promise<void> => {
      this.assertUnfencedMutation()
      const routine = RoutineSchema.parse(inputRoutine)
      const version = RoutineVersionSchema.parse(inputVersion)
      this.assertTenant(routine.organizationId)
      this.assertTenant(version.organizationId)
      if (version.routineId !== routine.id || routine.activeVersionId !== version.id) {
        throw new DatabaseConflictError('Routine and initial version do not form an active pair')
      }
      await this.executor.insert(routines).values({
        id: routine.id,
        organizationId: this.organizationId,
        palaceId: routine.palaceId,
        name: routine.name,
        activeVersionId: null,
        createdAt: date(routine.createdAt),
      })
      await this.executor.insert(routineVersions).values({
        id: version.id,
        routineId: version.routineId,
        organizationId: this.organizationId,
        version: version.version,
        status: version.status,
        definition: version.definition,
        sourcePlanId: version.sourcePlanId,
        sourcePlanHash: version.sourcePlanHash,
        createdAt: date(version.createdAt),
      })
      await this.executor
        .update(routines)
        .set({ activeVersionId: version.id, recordVersion: 2 })
        .where(and(eq(routines.organizationId, this.organizationId), eq(routines.id, routine.id)))
    },
  }
}

class PgIdentityTelemetryIngressRepositories implements IdentityTelemetryIngressRepositories {
  public readonly missions: IdentityTelemetryIngressRepositories['missions']
  public readonly identitySubjects: IdentityTelemetryIngressRepositories['identitySubjects']
  public readonly evidence: IdentityTelemetryIngressRepositories['evidence']
  public readonly executionTriggers: IdentityTelemetryIngressRepositories['executionTriggers']

  public constructor(
    private readonly executor: DatabaseTransaction,
    private readonly organizationId: OrganizationId,
  ) {
    const tenant = new PgTenantRepositories(executor, organizationId)
    this.missions = { get: tenant.missions.get }
    this.identitySubjects = {
      get: async ({ identityTagId, palaceId }) => {
        const [tagRow] = await this.executor
          .select()
          .from(identityTags)
          .where(
            and(
              eq(identityTags.organizationId, this.organizationId),
              eq(identityTags.id, identityTagId),
            ),
          )
          .limit(1)
        if (!tagRow) return null
        const tag = IdentityTagSchema.parse({
          id: tagRow.id,
          organizationId: tagRow.organizationId,
          crewMemberId: tagRow.crewMemberId,
          label: tagRow.label,
          verified: tagRow.verified,
          active: tagRow.active,
          version: tagRow.version,
        })
        if (tag.crewMemberId === null) return { tag, crew: null }
        const [crewRow] = await this.executor
          .select()
          .from(crewMembers)
          .where(
            and(
              eq(crewMembers.organizationId, this.organizationId),
              eq(crewMembers.id, tag.crewMemberId),
            ),
          )
          .limit(1)
        const crew = crewRow
          ? CrewMemberSchema.parse({
              id: crewRow.id,
              organizationId: crewRow.organizationId,
              palaceId: crewRow.palaceId,
              userId: crewRow.userId,
              displayName: crewRow.displayName,
              active: crewRow.active,
            })
          : null
        if (crew !== null && crew.palaceId !== palaceId) return { tag, crew }
        return { tag, crew }
      },
    }
    this.evidence = {
      appendVerified: (input) => this.appendVerified(input),
    }
    this.executionTriggers = {
      enqueueVerifiedArrival: (input) => this.enqueueVerifiedArrival(input),
    }
  }

  private async appendVerified(input: {
    readonly record: PersistedEvidenceRecord
    readonly provenance: Parameters<
      IdentityTelemetryIngressRepositories['evidence']['appendVerified']
    >[0]['provenance']
  }): Promise<IdentityTelemetryEvidenceAppendResult> {
    const record = PersistedEvidenceRecordSchema.parse(input.record)
    const provenance = IdentityTelemetryIngressProvenanceSchema.parse(input.provenance)
    this.assertAuthorityBindings(record, provenance)

    const [existingIngress] = await this.executor
      .select()
      .from(identityTelemetryIngresses)
      .where(
        and(
          eq(identityTelemetryIngresses.organizationId, this.organizationId),
          eq(identityTelemetryIngresses.providerEventId, provenance.providerEventId),
        ),
      )
      .limit(1)
    if (existingIngress) {
      const existing = await this.hydrate(existingIngress)
      if (
        hashCanonical(replayBinding(existing)) !==
        hashCanonical(replayBinding({ record, provenance }))
      ) {
        throw new DatabaseConflictError(
          'Identity telemetry provider event was reused with changed content',
        )
      }
      return { status: 'duplicate', ...existing }
    }

    const [nonceOwner] = await this.executor
      .select({ providerEventId: identityTelemetryIngresses.providerEventId })
      .from(identityTelemetryIngresses)
      .where(
        and(
          eq(identityTelemetryIngresses.organizationId, this.organizationId),
          eq(identityTelemetryIngresses.nonce, provenance.nonce),
        ),
      )
      .limit(1)
    if (nonceOwner) {
      throw new DatabaseConflictError('Identity telemetry nonce was reused by another event')
    }

    const derivedVerified = await this.deriveIdentityVerdict(
      provenance.identityTagId,
      provenance.palaceId,
    )
    if (
      provenance.identityVerified !== derivedVerified ||
      record.evidence.type !== 'identity_arrival' ||
      record.evidence.verified !== derivedVerified
    ) {
      throw new DatabaseConflictError(
        'Identity telemetry verdict does not match active tag and crew state',
      )
    }

    await this.executor.insert(identityTelemetryIngresses).values({
      schemaVersion: provenance.schemaVersion,
      providerEventId: provenance.providerEventId,
      organizationId: this.organizationId,
      missionId: provenance.missionId,
      palaceId: provenance.palaceId,
      identityTagId: provenance.identityTagId,
      nonce: provenance.nonce,
      principalId: provenance.principalId,
      keyId: provenance.keyId,
      keyVersion: provenance.keyVersion,
      verifiedPayloadHash: provenance.verifiedPayloadHash,
      signatureTimestamp: date(provenance.signatureTimestamp),
      verifiedAt: date(provenance.verifiedAt),
      evidenceId: provenance.evidenceId,
      authorityReceiptId: provenance.authorityReceiptId,
      identityVerified: provenance.identityVerified,
    })
    const receipt = record.authorityReceipt
    await this.executor.insert(evidence).values({
      id: record.evidence.id,
      organizationId: this.organizationId,
      missionId: record.evidence.missionId,
      palaceId: record.evidence.palaceId,
      type: record.evidence.type,
      payload: record.evidence,
      authorityReceiptId: receipt.id,
      authority: receipt.authority,
      authorityReceipt: receipt,
      authorityProviderEventId: provenance.providerEventId,
      authorityCallbackId: null,
      authorityCommandId: null,
      applicationRuleId: null,
      applicationRuleVersion: null,
      verifiedAt: date(receipt.verifiedAt),
      observedAt: date(record.evidence.observedAt),
      persistedAt: date(record.persistedAt),
    })
    return { status: 'stored', record, provenance }
  }

  private async enqueueVerifiedArrival(input: {
    readonly record: PersistedEvidenceRecord
    readonly availableAt: string
  }): Promise<readonly IdentityArrivalExecutionEnqueueResult[]> {
    const record = PersistedEvidenceRecordSchema.parse(input.record)
    if (
      record.evidence.type !== 'identity_arrival' ||
      !record.evidence.verified ||
      record.authorityReceipt.authority !== 'identity_telemetry' ||
      record.evidence.organizationId !== this.organizationId
    ) {
      throw new DatabaseConflictError(
        'Only retained, verified identity-arrival evidence can schedule execution work',
      )
    }
    const [storedEvidence] = await this.executor
      .select({
        payload: evidence.payload,
        authorityReceipt: evidence.authorityReceipt,
      })
      .from(evidence)
      .where(
        and(
          eq(evidence.organizationId, this.organizationId),
          eq(evidence.id, record.evidence.id),
          eq(evidence.missionId, record.evidence.missionId),
          eq(evidence.palaceId, record.evidence.palaceId),
          eq(evidence.type, 'identity_arrival'),
          eq(evidence.authority, 'identity_telemetry'),
        ),
      )
      .limit(1)
    if (
      !storedEvidence ||
      hashCanonical(storedEvidence.payload) !== hashCanonical(record.evidence) ||
      hashCanonical(storedEvidence.authorityReceipt) !== hashCanonical(record.authorityReceipt)
    ) {
      throw new DatabaseConflictError('Identity-arrival execution evidence is not retained exactly')
    }

    const bindings = await this.executor
      .select({ operationId: operations.id, executionId: executions.id })
      .from(operations)
      .innerJoin(
        executions,
        and(
          eq(executions.organizationId, operations.organizationId),
          eq(executions.operationId, operations.id),
          eq(executions.missionId, operations.missionId),
        ),
      )
      .innerJoin(
        missions,
        and(
          eq(missions.organizationId, operations.organizationId),
          eq(missions.id, operations.missionId),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, this.organizationId),
          eq(operations.missionId, record.evidence.missionId),
          eq(operations.status, 'committed'),
          eq(executions.status, 'running'),
          eq(missions.status, 'waiting_for_system'),
          eq(missions.phase, 'observe'),
          eq(missions.palaceId, record.evidence.palaceId),
        ),
      )
      .orderBy(asc(operations.id))

    const results: IdentityArrivalExecutionEnqueueResult[] = []
    for (const binding of bindings) {
      const reference = IdentityArrivalExecutionReferenceSchema.parse({
        organizationId: this.organizationId,
        missionId: record.evidence.missionId,
        operationId: binding.operationId,
        executionId: binding.executionId,
        evidenceId: record.evidence.id,
      })
      results.push(await this.ensureIdentityArrivalExecutionJob(reference, input.availableAt))
    }
    return results
  }

  private async ensureIdentityArrivalExecutionJob(
    reference: ReturnType<typeof IdentityArrivalExecutionReferenceSchema.parse>,
    availableAt: string,
  ): Promise<IdentityArrivalExecutionEnqueueResult> {
    const identity = identityArrivalExecutionOutboxIdentity(reference)
    const [existing] = await this.executor
      .select()
      .from(outboxMessages)
      .where(
        or(
          eq(outboxMessages.id, identity.outboxId),
          and(
            eq(outboxMessages.organizationId, this.organizationId),
            eq(outboxMessages.deduplicationKey, identity.deduplicationKey),
          ),
        ),
      )
      .limit(1)
    if (existing) return this.identityArrivalExecutionResult(existing, reference, 'duplicate')

    const [inserted] = await this.executor
      .insert(outboxMessages)
      .values({
        id: identity.outboxId,
        organizationId: this.organizationId,
        topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC,
        missionId: reference.missionId,
        operationId: reference.operationId,
        executionId: reference.executionId,
        commandId: null,
        dispatchGeneration: null,
        deduplicationKey: identity.deduplicationKey,
        payload: reference,
        status: 'pending',
        availableAt: date(availableAt),
        createdAt: date(availableAt),
        claimedBy: null,
        claimExpiresAt: null,
        dispatchedAt: null,
        deliveryAttempts: 0,
        lastErrorCode: null,
      })
      .onConflictDoNothing()
      .returning()
    if (inserted) return this.identityArrivalExecutionResult(inserted, reference, 'stored')

    const [raced] = await this.executor
      .select()
      .from(outboxMessages)
      .where(
        or(
          eq(outboxMessages.id, identity.outboxId),
          and(
            eq(outboxMessages.organizationId, this.organizationId),
            eq(outboxMessages.deduplicationKey, identity.deduplicationKey),
          ),
        ),
      )
      .limit(1)
    if (!raced) throw new DatabaseConflictError('Identity-arrival execution job was not retained')
    return this.identityArrivalExecutionResult(raced, reference, 'duplicate')
  }

  private identityArrivalExecutionResult(
    row: typeof outboxMessages.$inferSelect,
    reference: ReturnType<typeof IdentityArrivalExecutionReferenceSchema.parse>,
    status: 'duplicate' | 'stored',
  ): IdentityArrivalExecutionEnqueueResult {
    const identity = identityArrivalExecutionOutboxIdentity(reference)
    if (
      row.id !== identity.outboxId ||
      row.organizationId !== reference.organizationId ||
      row.topic !== IDENTITY_ARRIVAL_EXECUTION_TOPIC ||
      row.missionId !== reference.missionId ||
      row.operationId !== reference.operationId ||
      row.executionId !== reference.executionId ||
      row.commandId !== null ||
      row.dispatchGeneration !== null ||
      row.deduplicationKey !== identity.deduplicationKey ||
      hashCanonical(row.payload) !== hashCanonical(reference)
    ) {
      throw new DatabaseConflictError(
        'Identity-arrival execution job identity was rebound to different content',
      )
    }
    return IdentityArrivalExecutionEnqueueResultSchema.parse({
      topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC,
      outboxId: row.id,
      deduplicationKey: row.deduplicationKey,
      reference,
      status,
    })
  }

  private assertAuthorityBindings(
    record: PersistedEvidenceRecord,
    provenance: Parameters<
      IdentityTelemetryIngressRepositories['evidence']['appendVerified']
    >[0]['provenance'],
  ): void {
    if (record.evidence.type !== 'identity_arrival') {
      throw new DatabaseConflictError('Identity ingress only accepts identity arrival evidence')
    }
    const receipt = record.authorityReceipt
    if (
      receipt.authority !== 'identity_telemetry' ||
      receipt.schemaVersion !== 'evidence-authority-receipt@2'
    ) {
      throw new DatabaseConflictError('Identity ingress requires a V2 authority receipt')
    }
    if (
      provenance.organizationId !== this.organizationId ||
      record.evidence.organizationId !== this.organizationId ||
      provenance.missionId !== record.evidence.missionId ||
      provenance.palaceId !== record.evidence.palaceId ||
      provenance.identityTagId !== record.evidence.identityTagId ||
      provenance.evidenceId !== record.evidence.id ||
      provenance.authorityReceiptId !== receipt.id ||
      provenance.providerEventId !== receipt.providerEventId ||
      provenance.identityTagId !== receipt.identityTagId ||
      provenance.principalId !== receipt.principalId ||
      provenance.keyId !== receipt.keyId ||
      provenance.keyVersion !== receipt.keyVersion ||
      provenance.verifiedPayloadHash !== receipt.verifiedPayloadHash ||
      provenance.verifiedAt !== receipt.verifiedAt ||
      provenance.verifiedAt !== record.persistedAt
    ) {
      throw new DatabaseConflictError('Identity ingress provenance is not bound to its evidence')
    }
    const event = IdentityTelemetryEventSchema.parse({
      schemaVersion: 'identity-telemetry-event@1',
      providerEventId: provenance.providerEventId,
      organizationId: provenance.organizationId,
      missionId: provenance.missionId,
      palaceId: provenance.palaceId,
      identityTagId: provenance.identityTagId,
      observedAt: record.evidence.observedAt,
      nonce: provenance.nonce,
    })
    if (
      provenance.verifiedPayloadHash !== computeIdentityTelemetryPayloadHash(event) ||
      provenance.evidenceId !== deriveIdentityTelemetryEvidenceId(event) ||
      provenance.authorityReceiptId !== deriveIdentityTelemetryReceiptId(event)
    ) {
      throw new DatabaseConflictError('Identity ingress stable identity or payload hash is invalid')
    }
  }

  private async deriveIdentityVerdict(identityTagId: string, palaceId: string): Promise<boolean> {
    const [tag] = await this.executor
      .select({
        active: identityTags.active,
        verified: identityTags.verified,
        crewMemberId: identityTags.crewMemberId,
      })
      .from(identityTags)
      .where(
        and(
          eq(identityTags.organizationId, this.organizationId),
          eq(identityTags.id, identityTagId),
        ),
      )
      .limit(1)
    if (!tag) throw new DatabaseConflictError('Identity telemetry tag does not exist')
    if (!tag.active || !tag.verified || tag.crewMemberId === null) return false
    const [crew] = await this.executor
      .select({ active: crewMembers.active, palaceId: crewMembers.palaceId })
      .from(crewMembers)
      .where(
        and(
          eq(crewMembers.organizationId, this.organizationId),
          eq(crewMembers.id, tag.crewMemberId),
        ),
      )
      .limit(1)
    return crew?.active === true && crew.palaceId === palaceId
  }

  private async hydrate(ingress: typeof identityTelemetryIngresses.$inferSelect): Promise<
    Readonly<{
      record: PersistedEvidenceRecord
      provenance: Parameters<
        IdentityTelemetryIngressRepositories['evidence']['appendVerified']
      >[0]['provenance']
    }>
  > {
    const [stored] = await this.executor
      .select()
      .from(evidence)
      .where(
        and(eq(evidence.organizationId, this.organizationId), eq(evidence.id, ingress.evidenceId)),
      )
      .limit(1)
    if (!stored) {
      throw new DatabaseConflictError('Identity telemetry provenance has no bound evidence')
    }
    return {
      record: PersistedEvidenceRecordSchema.parse({
        evidence: stored.payload,
        authorityReceipt: stored.authorityReceipt,
        persistedAt: iso(stored.persistedAt),
      }),
      provenance: IdentityTelemetryIngressProvenanceSchema.parse({
        schemaVersion: ingress.schemaVersion,
        providerEventId: ingress.providerEventId,
        organizationId: ingress.organizationId,
        missionId: ingress.missionId,
        palaceId: ingress.palaceId,
        identityTagId: ingress.identityTagId,
        nonce: ingress.nonce,
        principalId: ingress.principalId,
        keyId: ingress.keyId,
        keyVersion: ingress.keyVersion,
        verifiedPayloadHash: ingress.verifiedPayloadHash,
        signatureTimestamp: iso(ingress.signatureTimestamp),
        verifiedAt: iso(ingress.verifiedAt),
        evidenceId: ingress.evidenceId,
        authorityReceiptId: ingress.authorityReceiptId,
        identityVerified: ingress.identityVerified,
      }),
    }
  }
}

function replayBinding(
  input: Readonly<{
    record: PersistedEvidenceRecord
    provenance: Parameters<
      IdentityTelemetryIngressRepositories['evidence']['appendVerified']
    >[0]['provenance']
  }>,
): unknown {
  const { persistedAt: _persistedAt, ...record } = input.record
  // Every replay reaches this adapter only after fresh envelope verification. The transport
  // signature timestamp can change when a gateway re-signs the same provider event after restart.
  const {
    signatureTimestamp: _signatureTimestamp,
    verifiedAt: _provenanceVerifiedAt,
    ...provenance
  } = input.provenance
  const { verifiedAt: _receiptVerifiedAt, ...authorityReceipt } = record.authorityReceipt
  return { record: { ...record, authorityReceipt }, provenance }
}

export class PgIdentityTelemetryIngressUnitOfWork implements IdentityTelemetryIngressUnitOfWorkPort {
  public constructor(private readonly database: Database) {}

  public async runIdentityTelemetry<Result>(
    organizationId: OrganizationId,
    work: (repositories: IdentityTelemetryIngressRepositories) => Promise<Result>,
  ): Promise<Result> {
    const tenantId = OrganizationIdSchema.parse(organizationId)
    try {
      return await runSerializableTransaction(this.database, (transaction) =>
        work(new PgIdentityTelemetryIngressRepositories(transaction, tenantId)),
      )
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export class PgUnitOfWork {
  public constructor(private readonly database: Database) {}

  public async run<Result>(
    organizationId: OrganizationId,
    work: (repositories: PgTenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    const tenantId = OrganizationIdSchema.parse(organizationId)
    try {
      return await runSerializableTransaction(this.database, async (transaction) =>
        work(new PgTenantRepositories(transaction, tenantId)),
      )
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export class PgMissionExecutionUnitOfWork implements MissionExecutionUnitOfWorkPort {
  public constructor(private readonly database: Database) {}

  public async runFenced<Result>(
    inputFence: MissionFence,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    const fence = validateFence(inputFence)
    try {
      return await runSerializableTransaction(this.database, async (transaction) => {
        const [lease] = await transaction
          .select({
            ownerId: missionLeases.ownerId,
            epoch: missionLeases.epoch,
            tokenFingerprint: missionLeases.tokenFingerprint,
            expiresAt: missionLeases.expiresAt,
            releasedAt: missionLeases.releasedAt,
          })
          .from(missionLeases)
          .where(
            and(
              eq(missionLeases.organizationId, fence.organizationId),
              eq(missionLeases.missionId, fence.missionId),
            ),
          )
          .for('update')
          .limit(1)
        const databaseNow = await databaseWallTime(transaction)
        if (
          !lease ||
          lease.ownerId !== fence.ownerId ||
          lease.epoch !== fence.epoch ||
          lease.tokenFingerprint !== fence.tokenFingerprint ||
          lease.releasedAt !== null ||
          lease.expiresAt.valueOf() <= databaseNow.valueOf()
        ) {
          throw new MissionFenceRejectedError()
        }
        return work(
          new PgTenantRepositories(transaction, fence.organizationId, fence.missionId, fence.epoch),
        )
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

const SERIALIZABLE_RETRY_DELAYS_MILLISECONDS = Object.freeze([10, 25, 50, 100, 250, 500] as const)

async function runSerializableTransaction<Result>(
  database: Database,
  work: (transaction: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.transaction(work, { isolationLevel: 'serializable' })
    } catch (error) {
      const delay = SERIALIZABLE_RETRY_DELAYS_MILLISECONDS[attempt]
      if (delay === undefined || !isRetryableTransactionError(error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}

export class PgSystemOutboxRepository {
  public constructor(private readonly database: Database) {}

  public async claimDue(input: {
    ownerId: string
    now: string
    claimExpiresAt: string
    limit: number
  }): Promise<readonly OutboxMessage[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new TypeError('Outbox claim limit must be between 1 and 500')
    }
    try {
      return await this.database.transaction(async (transaction) => {
        const due = await transaction
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(
            and(
              lte(outboxMessages.availableAt, date(input.now)),
              or(
                eq(outboxMessages.status, 'pending'),
                and(
                  eq(outboxMessages.status, 'claimed'),
                  lte(outboxMessages.claimExpiresAt, date(input.now)),
                ),
              ),
            ),
          )
          .orderBy(asc(outboxMessages.availableAt), asc(outboxMessages.createdAt))
          .limit(input.limit)
          .for('update', { skipLocked: true })
        if (due.length === 0) return []
        const rows = await transaction
          .update(outboxMessages)
          .set({
            status: 'claimed',
            claimedBy: input.ownerId,
            claimExpiresAt: date(input.claimExpiresAt),
            deliveryAttempts: sql`${outboxMessages.deliveryAttempts} + 1`,
            recordVersion: sql`${outboxMessages.recordVersion} + 1`,
          })
          .where(
            inArray(
              outboxMessages.id,
              due.map((row) => row.id),
            ),
          )
          .returning()
        return rows.map(mapOutbox)
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export class PgBootstrapRepository {
  public constructor(private readonly database: Database) {}

  public async insertOrganization(input: Organization): Promise<void> {
    const organization = OrganizationSchema.parse(input)
    await this.database.insert(organizations).values({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      labTenant: organization.labTenant,
      createdAt: date(organization.createdAt),
    })
  }

  public async insertUser(input: User): Promise<void> {
    const user = UserSchema.parse(input)
    await this.database.insert(users).values({
      id: user.id,
      displayName: user.displayName,
      createdAt: date(user.createdAt),
    })
  }
}

type ToolInvocationRow = typeof toolInvocations.$inferSelect

function expectedToolInvocationExecutionClass(toolName: ToolName): ToolInvocationExecutionClass {
  const contract = projectToolSchema(toolName)
  if (contract.risk === 'consequential') return 'consequential'
  if (contract.readOnly) return 'read'
  return contract.mcp.annotations.idempotentHint ? 'write_idempotent' : 'non_idempotent'
}

function parseToolInvocationBinding(input: ToolInvocationBinding): ToolInvocationBinding {
  const toolName = ToolNameSchema.parse(input.toolName)
  const binding = {
    organizationId: OrganizationIdSchema.parse(input.organizationId),
    missionId: MissionIdSchema.parse(input.missionId),
    callId: ToolCallIdSchema.parse(input.callId),
    toolName,
    channel: ToolCallChannelSchema.parse(input.channel),
    inputHash: Sha256Schema.parse(input.inputHash),
    principalScopeHash: Sha256Schema.parse(input.principalScopeHash),
    toolContractHash: Sha256Schema.parse(input.toolContractHash),
    toolRegistryHash: Sha256Schema.parse(input.toolRegistryHash),
    resultSchemaHash: Sha256Schema.parse(input.resultSchemaHash),
    executionClass: ToolInvocationExecutionClassSchema.parse(input.executionClass),
  }
  if (binding.toolRegistryHash !== TOOL_REGISTRY_HASH) {
    throw new DatabaseConflictError('Tool invocation registry hash is not current')
  }
  if (binding.toolContractHash !== projectToolSchema(toolName).contractHash) {
    throw new DatabaseConflictError('Tool invocation contract hash is not current')
  }
  if (binding.resultSchemaHash !== hashToolResultSchema(toolName)) {
    throw new DatabaseConflictError('Tool invocation result schema hash is not current')
  }
  if (binding.executionClass !== expectedToolInvocationExecutionClass(toolName)) {
    throw new DatabaseConflictError('Tool invocation execution class does not match its contract')
  }
  return binding
}

function toolInvocationBindingFromRow(row: ToolInvocationRow): ToolInvocationBinding {
  const binding = parseToolInvocationBinding({
    organizationId: OrganizationIdSchema.parse(row.organizationId),
    missionId: MissionIdSchema.parse(row.missionId),
    callId: ToolCallIdSchema.parse(row.callId),
    toolName: row.toolName,
    channel: row.channel,
    inputHash: Sha256Schema.parse(row.inputHash),
    principalScopeHash: Sha256Schema.parse(row.principalScopeHash),
    toolContractHash: Sha256Schema.parse(row.toolContractHash),
    toolRegistryHash: Sha256Schema.parse(row.toolRegistryHash),
    resultSchemaHash: Sha256Schema.parse(row.resultSchemaHash),
    executionClass: row.executionClass,
  })
  if (row.bindingHash !== hashToolValue(binding)) {
    throw new DatabaseConflictError('Stored tool invocation binding hash is invalid')
  }
  return binding
}

function sameToolInvocationBinding(
  left: ToolInvocationBinding,
  right: ToolInvocationBinding,
): boolean {
  return hashCanonical(left) === hashCanonical(right)
}

function claimedToolInvocationFromRow(row: ToolInvocationRow): ToolInvocationClaimedRecord {
  if (row.status !== 'claimed') {
    throw new DatabaseConflictError('Completed invocation cannot be mapped as an active claim')
  }
  return {
    ...toolInvocationBindingFromRow(row),
    receiptId: ReceiptIdSchema.parse(row.receiptId),
    generation: row.generation,
    startedAt: iso(row.startedAt),
    claimExpiresAt: iso(row.claimExpiresAt),
  }
}

function completedToolInvocationFromRow(
  row: ToolInvocationRow,
  evidenceIdsInput: readonly string[],
): ToolInvocationCompletedRecord {
  if (row.status !== 'completed' || row.result === null || row.resultHash === null) {
    throw new DatabaseConflictError('Tool invocation completion is incomplete')
  }
  const binding = toolInvocationBindingFromRow(row)
  const result = parseToolResult(binding.toolName, row.result)
  const resultHash = Sha256Schema.parse(row.resultHash)
  if (hashToolValue(result) !== resultHash) {
    throw new DatabaseConflictError('Stored tool invocation result hash does not match its payload')
  }
  if (
    result.callId !== binding.callId ||
    result.toolName !== binding.toolName ||
    result.receiptId !== row.receiptId
  ) {
    throw new DatabaseConflictError('Stored tool invocation result does not match its binding')
  }
  if (row.disposition === 'resolve_unknown' && result.status !== 'unknown') {
    throw new DatabaseConflictError('Reconciled tool invocation must resolve to unknown')
  }
  const evidenceIds = evidenceIdsInput.map((evidenceId) => EvidenceIdSchema.parse(evidenceId))
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new DatabaseConflictError('Stored tool invocation evidence references are duplicated')
  }
  return {
    ...binding,
    receiptId: ReceiptIdSchema.parse(row.receiptId),
    generation: row.generation,
    startedAt: iso(row.startedAt),
    completedAt: iso(requiredDate(row.completedAt, 'Tool invocation completion time')),
    resultHash,
    result,
    attemptId: row.attemptId === null ? null : AttemptIdSchema.parse(row.attemptId),
    evidenceIds,
  }
}

async function loadToolInvocationEvidenceIds(
  transaction: DatabaseTransaction,
  callId: ToolCallId,
  organizationId: OrganizationId,
): Promise<readonly EvidenceId[]> {
  const rows = await transaction
    .select({ evidenceId: toolInvocationEvidence.evidenceId })
    .from(toolInvocationEvidence)
    .where(
      and(
        eq(toolInvocationEvidence.organizationId, organizationId),
        eq(toolInvocationEvidence.callId, callId),
      ),
    )
    .orderBy(asc(toolInvocationEvidence.position))
  return rows.map((row) => EvidenceIdSchema.parse(row.evidenceId))
}

interface StoredEvidenceBindingRow {
  readonly id: string
  readonly payload: unknown
  readonly authorityReceipt: unknown
  readonly persistedAt: Date
}

function isOperationTransportPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'operation_transport'
  )
}

async function assertApplicationResponseLostInvocationEvidence(input: {
  readonly executor: DatabaseTransaction
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly callId: ToolCallId
  readonly attemptId: Attempt['id'] | null
  readonly evidenceIds: readonly EvidenceId[]
  readonly rows: readonly StoredEvidenceBindingRow[]
}): Promise<void> {
  if (input.attemptId === null || input.evidenceIds.length !== 1 || input.rows.length !== 1) {
    throw new DatabaseConflictError(
      'Application response loss requires one attempt and one transport evidence record',
    )
  }
  const [row] = input.rows
  if (row === undefined || row.id !== input.evidenceIds[0]) {
    throw new DatabaseConflictError('Application response-loss evidence order is not exact')
  }
  const record = PersistedEvidenceRecordSchema.parse({
    evidence: row.payload,
    authorityReceipt: row.authorityReceipt,
    persistedAt: iso(row.persistedAt),
  })
  if (
    record.evidence.type !== 'operation_transport' ||
    record.evidence.organizationId !== input.organizationId ||
    record.evidence.missionId !== input.missionId ||
    record.evidence.toolCallId !== input.callId ||
    record.evidence.attemptId !== input.attemptId
  ) {
    throw new DatabaseConflictError(
      'Application response-loss evidence does not bind the tool invocation',
    )
  }
  await assertOperationTransportSourceBinding(input.executor, record)
}

function toolInvocationOwnerFingerprint(token: OpaqueToolInvocationClaimToken): Sha256 {
  if (!(token instanceof OpaqueToolInvocationClaimToken)) {
    throw new TypeError('Tool invocation owner token is not authentic')
  }
  return Sha256Schema.parse(token.storageFingerprint())
}

function parseToolInvocationClaimWindow(startedAtInput: string, claimExpiresAtInput: string) {
  const startedAt = date(startedAtInput)
  const claimExpiresAt = date(claimExpiresAtInput)
  const ttlMilliseconds = claimExpiresAt.valueOf() - startedAt.valueOf()
  if (ttlMilliseconds < 1_000 || ttlMilliseconds > 300_000) {
    throw new RangeError('Tool invocation claim TTL must be between one second and five minutes')
  }
  return { startedAt, claimExpiresAt }
}

export class PgToolInvocationLedger implements ToolInvocationLedgerPort {
  private readonly organizationId: OrganizationId

  public constructor(
    private readonly database: Database,
    organizationId: OrganizationId,
  ) {
    this.organizationId = OrganizationIdSchema.parse(organizationId)
  }

  public async claim(input: ToolInvocationClaimInput): Promise<ToolInvocationClaimResult> {
    const binding = parseToolInvocationBinding(input)
    if (binding.organizationId !== this.organizationId) {
      throw new TenantBoundaryError('Tool invocation tenant does not match its repository')
    }
    const receiptId = ReceiptIdSchema.parse(input.proposedReceiptId)
    const ownerTokenHash = toolInvocationOwnerFingerprint(input.ownerToken)
    const { startedAt, claimExpiresAt } = parseToolInvocationClaimWindow(
      input.startedAt,
      input.claimExpiresAt,
    )

    try {
      return await this.database.transaction(async (transaction) => {
        const [inserted] = await transaction
          .insert(toolInvocations)
          .values({
            ...binding,
            bindingHash: hashToolValue(binding),
            receiptId,
            status: 'claimed',
            disposition: 'execute',
            generation: 1,
            ownerTokenHash,
            claimExpiresAt,
            result: null,
            resultHash: null,
            attemptId: null,
            startedAt,
            completedAt: null,
            updatedAt: startedAt,
          })
          .onConflictDoNothing()
          .returning()
        if (inserted) {
          return {
            kind: 'claimed',
            disposition: 'execute',
            invocation: claimedToolInvocationFromRow(inserted),
          }
        }

        const [existing] = await transaction
          .select()
          .from(toolInvocations)
          .where(
            and(
              eq(toolInvocations.organizationId, this.organizationId),
              eq(toolInvocations.callId, binding.callId),
            ),
          )
          .for('update')
          .limit(1)
        if (!existing) {
          throw new DatabaseConflictError('Tool invocation claim collided with another identity')
        }
        if (!sameToolInvocationBinding(toolInvocationBindingFromRow(existing), binding)) {
          throw new DatabaseConflictError('Tool invocation call identity is already bound')
        }
        if (existing.status === 'completed') {
          const evidenceIds = await loadToolInvocationEvidenceIds(
            transaction,
            binding.callId,
            this.organizationId,
          )
          return {
            kind: 'completed',
            invocation: completedToolInvocationFromRow(existing, evidenceIds),
          }
        }
        if (existing.claimExpiresAt.valueOf() > startedAt.valueOf()) {
          return { kind: 'in_progress', invocation: claimedToolInvocationFromRow(existing) }
        }

        const disposition = binding.executionClass === 'read' ? 'execute' : 'resolve_unknown'
        const [reclaimed] = await transaction
          .update(toolInvocations)
          .set({
            disposition,
            generation: existing.generation + 1,
            ownerTokenHash,
            claimExpiresAt,
            updatedAt: startedAt,
          })
          .where(
            and(
              eq(toolInvocations.organizationId, this.organizationId),
              eq(toolInvocations.callId, binding.callId),
              eq(toolInvocations.status, 'claimed'),
              eq(toolInvocations.generation, existing.generation),
              lte(toolInvocations.claimExpiresAt, startedAt),
            ),
          )
          .returning()
        if (!reclaimed) {
          throw new DatabaseConflictError('Tool invocation claim changed while it was locked')
        }
        return disposition === 'resolve_unknown'
          ? {
              kind: 'claimed',
              disposition,
              invocation: claimedToolInvocationFromRow(reclaimed),
              abandonedClaim: {
                generation: existing.generation,
                claimExpiresAt: iso(existing.claimExpiresAt),
              },
            }
          : {
              kind: 'claimed',
              disposition,
              invocation: claimedToolInvocationFromRow(reclaimed),
            }
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async complete(
    input: ToolInvocationCompletionInput,
  ): Promise<ToolInvocationCompletionResult> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId)
    if (organizationId !== this.organizationId) {
      throw new TenantBoundaryError('Tool invocation tenant does not match its repository')
    }
    const callId = ToolCallIdSchema.parse(input.callId)
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new TypeError('Tool invocation generation must be a positive safe integer')
    }
    const ownerTokenHash = toolInvocationOwnerFingerprint(input.ownerToken)
    const resultHash = Sha256Schema.parse(input.resultHash)
    const attemptId = input.attemptId === null ? null : AttemptIdSchema.parse(input.attemptId)
    const evidenceIds = input.evidenceIds.map((evidenceId) => EvidenceIdSchema.parse(evidenceId))
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new TypeError('Tool invocation evidence references must be unique')
    }
    const completedAt = date(input.completedAt)

    try {
      return await this.database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(toolInvocations)
          .where(
            and(
              eq(toolInvocations.organizationId, this.organizationId),
              eq(toolInvocations.callId, callId),
            ),
          )
          .for('update')
          .limit(1)
        if (!existing) throw new DatabaseNotFoundError('Tool invocation claim was not found')
        if (existing.status === 'completed') {
          const storedEvidenceIds = await loadToolInvocationEvidenceIds(
            transaction,
            callId,
            this.organizationId,
          )
          const completed = completedToolInvocationFromRow(existing, storedEvidenceIds)
          if (
            existing.generation === input.generation &&
            completed.resultHash === resultHash &&
            hashToolValue(completed.result) === hashToolValue(input.result) &&
            completed.attemptId === attemptId &&
            completed.evidenceIds.length === evidenceIds.length &&
            completed.evidenceIds.every((evidenceId, index) => evidenceId === evidenceIds[index])
          ) {
            return { kind: 'completed', invocation: completed }
          }
          return { kind: 'lost_claim', current: 'completed' }
        }
        if (
          existing.generation !== input.generation ||
          existing.ownerTokenHash !== ownerTokenHash
        ) {
          return { kind: 'lost_claim', current: 'in_progress' }
        }

        const binding = toolInvocationBindingFromRow(existing)
        const result = parseToolResult(binding.toolName, input.result)
        if (
          result.callId !== callId ||
          result.toolName !== binding.toolName ||
          result.receiptId !== existing.receiptId
        ) {
          throw new DatabaseConflictError('Tool invocation result does not match its claim')
        }
        if (existing.disposition === 'resolve_unknown' && result.status !== 'unknown') {
          throw new DatabaseConflictError('Expired write claims may only resolve as unknown')
        }
        if (existing.disposition === 'resolve_unknown' && evidenceIds.length === 0) {
          throw new DatabaseConflictError(
            'Expired write resolution requires reconciliation evidence',
          )
        }
        let matchingEvidence: readonly {
          readonly id: string
          readonly payload: unknown
          readonly authorityReceipt: unknown
          readonly persistedAt: Date
        }[] = []
        if (evidenceIds.length > 0) {
          matchingEvidence = await transaction
            .select({
              id: evidence.id,
              payload: evidence.payload,
              authorityReceipt: evidence.authorityReceipt,
              persistedAt: evidence.persistedAt,
            })
            .from(evidence)
            .where(
              and(
                eq(evidence.organizationId, this.organizationId),
                eq(evidence.missionId, existing.missionId),
                inArray(evidence.id, evidenceIds),
              ),
            )
          if (matchingEvidence.length !== evidenceIds.length) {
            throw new DatabaseConflictError(
              'Tool invocation evidence is not bound to the invocation mission',
            )
          }
        }
        const operationTransportRows = matchingEvidence.filter((row) =>
          isOperationTransportPayload(row.payload),
        )
        const isApplicationResponseLoss =
          binding.toolName === 'plans.activate' &&
          result.status === 'unknown' &&
          (attemptId !== null ||
            result.error?.code === 'APPLICATION_RESPONSE_LOST' ||
            operationTransportRows.length > 0)
        if (isApplicationResponseLoss) {
          if (result.error?.code !== 'APPLICATION_RESPONSE_LOST') {
            throw new DatabaseConflictError(
              'Application response-loss invocation requires its exact public error code',
            )
          }
          await assertApplicationResponseLostInvocationEvidence({
            executor: transaction,
            organizationId: this.organizationId,
            missionId: MissionIdSchema.parse(existing.missionId),
            callId,
            attemptId,
            evidenceIds,
            rows: matchingEvidence,
          })
        } else if (operationTransportRows.length > 0) {
          throw new DatabaseConflictError(
            'Operation transport evidence may only resolve its plans.activate invocation',
          )
        }
        if (existing.disposition === 'resolve_unknown') {
          if (matchingEvidence.length !== 1) {
            throw new DatabaseConflictError(
              'Expired write resolution requires one reconciliation observation',
            )
          }
          const [reconciliationRow] = matchingEvidence
          if (reconciliationRow === undefined) {
            throw new DatabaseConflictError('Reconciliation evidence disappeared while locked')
          }
          const storedEvidence = PersistedEvidenceRecordSchema.parse({
            evidence: reconciliationRow.payload,
            authorityReceipt: reconciliationRow.authorityReceipt,
            persistedAt: iso(reconciliationRow.persistedAt),
          })
          const reconciliation = ToolInvocationReconciliationEvidenceSchema.parse(
            storedEvidence.evidence,
          )
          if (
            storedEvidence.authorityReceipt.authority !== 'application' ||
            storedEvidence.authorityReceipt.ruleId !== 'tool_invocation.abandoned_write' ||
            reconciliation.organizationId !== this.organizationId ||
            reconciliation.missionId !== existing.missionId ||
            reconciliation.toolCallId !== callId ||
            reconciliation.toolName !== binding.toolName ||
            reconciliation.abandonedClaimGeneration !== existing.generation - 1 ||
            reconciliation.invocationBindingHash !== hashToolValue(binding) ||
            reconciliation.reconciledOutcome !== 'still_unknown'
          ) {
            throw new DatabaseConflictError(
              'Reconciliation evidence does not bind the abandoned tool invocation',
            )
          }
        }
        if (hashToolValue(result) !== resultHash) {
          throw new DatabaseConflictError('Tool invocation result hash does not match its payload')
        }
        if (completedAt.valueOf() < existing.updatedAt.valueOf()) {
          throw new DatabaseConflictError('Tool invocation completed before its active claim')
        }

        const [completed] = await transaction
          .update(toolInvocations)
          .set({
            status: 'completed',
            result,
            resultHash,
            attemptId,
            completedAt,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(toolInvocations.organizationId, this.organizationId),
              eq(toolInvocations.callId, callId),
              eq(toolInvocations.status, 'claimed'),
              eq(toolInvocations.generation, input.generation),
              eq(toolInvocations.ownerTokenHash, ownerTokenHash),
            ),
          )
          .returning()
        if (!completed) return { kind: 'lost_claim', current: 'in_progress' }
        if (evidenceIds.length > 0) {
          await transaction.insert(toolInvocationEvidence).values(
            evidenceIds.map((evidenceId, position) => ({
              organizationId: this.organizationId,
              callId,
              evidenceId,
              position,
            })),
          )
        }
        return {
          kind: 'completed',
          invocation: completedToolInvocationFromRow(completed, evidenceIds),
        }
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

function mapToolCallReceipt(
  row: typeof toolCallReceipts.$inferSelect,
  evidenceIds: readonly string[],
): ToolCallReceipt {
  return ToolCallReceiptSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    callId: row.callId,
    toolName: row.toolName,
    status: row.status,
    channel: row.channel,
    tenantScopeHash: row.tenantScopeHash,
    inputHash: row.inputHash,
    resultHash: row.resultHash,
    toolContractHash: row.toolContractHash,
    toolRegistryHash: row.toolRegistryHash,
    attemptId: row.attemptId,
    evidenceIds,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  })
}

async function assertApplicationResponseLostReceiptBinding(
  transaction: DatabaseTransaction,
  organizationId: OrganizationId,
  receipt: ToolCallReceipt,
): Promise<void> {
  const evidenceRows =
    receipt.evidenceIds.length === 0
      ? []
      : await transaction
          .select({
            id: evidence.id,
            payload: evidence.payload,
            authorityReceipt: evidence.authorityReceipt,
            persistedAt: evidence.persistedAt,
          })
          .from(evidence)
          .where(
            and(
              eq(evidence.organizationId, organizationId),
              inArray(evidence.id, receipt.evidenceIds),
            ),
          )
  const operationTransportRows = evidenceRows.filter((row) =>
    isOperationTransportPayload(row.payload),
  )
  const requiresApplicationResponseLossBinding =
    (receipt.toolName === 'plans.activate' &&
      receipt.status === 'unknown' &&
      receipt.attemptId !== null) ||
    operationTransportRows.length > 0
  if (!requiresApplicationResponseLossBinding) return
  if (
    receipt.toolName !== 'plans.activate' ||
    receipt.status !== 'unknown' ||
    receipt.attemptId === null
  ) {
    throw new DatabaseConflictError(
      'Operation transport evidence may only bind an unknown plans.activate receipt',
    )
  }

  const [invocation] = await transaction
    .select()
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.organizationId, organizationId),
        eq(toolInvocations.callId, receipt.callId),
      ),
    )
    .limit(1)
  if (!invocation || invocation.status !== 'completed' || invocation.result === null) {
    throw new DatabaseConflictError(
      'Application response-loss receipt requires its completed invocation',
    )
  }
  const result = parseToolResult('plans.activate', invocation.result)
  const invocationEvidenceIds = await loadToolInvocationEvidenceIds(
    transaction,
    receipt.callId,
    organizationId,
  )
  if (
    invocation.receiptId !== receipt.id ||
    invocation.toolName !== receipt.toolName ||
    invocation.channel !== receipt.channel ||
    invocation.inputHash !== receipt.inputHash ||
    invocation.resultHash !== receipt.resultHash ||
    invocation.toolContractHash !== receipt.toolContractHash ||
    invocation.toolRegistryHash !== receipt.toolRegistryHash ||
    invocation.attemptId !== receipt.attemptId ||
    result.status !== receipt.status ||
    result.error?.code !== 'APPLICATION_RESPONSE_LOST' ||
    iso(invocation.startedAt) !== receipt.startedAt ||
    iso(requiredDate(invocation.completedAt, 'Tool invocation completion time')) !==
      receipt.completedAt ||
    invocationEvidenceIds.length !== receipt.evidenceIds.length ||
    invocationEvidenceIds.some(
      (evidenceId, position) => evidenceId !== receipt.evidenceIds[position],
    )
  ) {
    throw new DatabaseConflictError(
      'Application response-loss receipt does not match its durable invocation',
    )
  }
  await assertApplicationResponseLostInvocationEvidence({
    executor: transaction,
    organizationId,
    missionId: MissionIdSchema.parse(invocation.missionId),
    callId: receipt.callId,
    attemptId: receipt.attemptId,
    evidenceIds: receipt.evidenceIds,
    rows: evidenceRows,
  })
}

export class PgToolCallReceiptRepository {
  private readonly organizationId: OrganizationId
  private readonly tenantScopeHash: Sha256

  public constructor(
    private readonly database: Database,
    organizationId: OrganizationId,
    tenantScopeHash: Sha256,
  ) {
    this.organizationId = OrganizationIdSchema.parse(organizationId)
    this.tenantScopeHash = ToolTenantScopeHashSchema.parse(tenantScopeHash)
  }

  public async append(input: ToolCallReceipt): Promise<void> {
    const receipt = ToolCallReceiptSchema.parse(input)
    if (receipt.tenantScopeHash !== this.tenantScopeHash) {
      throw new TenantBoundaryError('Tool receipt tenant scope does not match its repository')
    }
    if (receipt.toolRegistryHash !== TOOL_REGISTRY_HASH) {
      throw new DatabaseConflictError('Tool receipt registry hash is not current')
    }
    if (receipt.toolContractHash !== projectToolSchema(receipt.toolName).contractHash) {
      throw new DatabaseConflictError('Tool receipt contract hash is not current')
    }

    try {
      await this.database.transaction(async (transaction) => {
        await assertApplicationResponseLostReceiptBinding(transaction, this.organizationId, receipt)
        const inserted = await transaction
          .insert(toolCallReceipts)
          .values({
            id: receipt.id,
            organizationId: this.organizationId,
            schemaVersion: receipt.schemaVersion,
            callId: receipt.callId,
            toolName: receipt.toolName,
            status: receipt.status,
            channel: receipt.channel,
            tenantScopeHash: receipt.tenantScopeHash,
            inputHash: receipt.inputHash,
            resultHash: receipt.resultHash,
            toolContractHash: receipt.toolContractHash,
            toolRegistryHash: receipt.toolRegistryHash,
            attemptId: receipt.attemptId,
            startedAt: date(receipt.startedAt),
            completedAt: date(receipt.completedAt),
          })
          .onConflictDoNothing()
          .returning({ id: toolCallReceipts.id })
        if (inserted.length === 0) {
          const rows = await transaction
            .select()
            .from(toolCallReceipts)
            .where(
              and(
                eq(toolCallReceipts.organizationId, this.organizationId),
                or(
                  eq(toolCallReceipts.id, receipt.id),
                  eq(toolCallReceipts.callId, receipt.callId),
                ),
              ),
            )
            .limit(2)
          if (rows.length !== 1) {
            throw new DatabaseConflictError('Tool receipt identity is already bound')
          }
          const existingRow = rows[0]
          if (!existingRow) {
            throw new DatabaseConflictError('Tool receipt identity is already bound')
          }
          const evidenceRows = await transaction
            .select({ evidenceId: toolCallReceiptEvidence.evidenceId })
            .from(toolCallReceiptEvidence)
            .where(
              and(
                eq(toolCallReceiptEvidence.organizationId, this.organizationId),
                eq(toolCallReceiptEvidence.receiptId, existingRow.id),
              ),
            )
            .orderBy(asc(toolCallReceiptEvidence.position))
          const existing = mapToolCallReceipt(
            existingRow,
            evidenceRows.map((row) => row.evidenceId),
          )
          if (hashCanonical(existing) !== hashCanonical(receipt)) {
            throw new DatabaseConflictError('Tool receipt identity is already bound')
          }
          return
        }
        if (receipt.evidenceIds.length > 0) {
          await transaction.insert(toolCallReceiptEvidence).values(
            receipt.evidenceIds.map((evidenceId, position) => ({
              organizationId: this.organizationId,
              receiptId: receipt.id,
              evidenceId,
              position,
            })),
          )
        }
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public get(receiptId: ReceiptId): Promise<ToolCallReceipt | null> {
    return this.find(eq(toolCallReceipts.id, ReceiptIdSchema.parse(receiptId)))
  }

  public findByCallId(callId: ToolCallId): Promise<ToolCallReceipt | null> {
    return this.find(eq(toolCallReceipts.callId, ToolCallIdSchema.parse(callId)))
  }

  private async find(selector: SQL): Promise<ToolCallReceipt | null> {
    const [row] = await this.database
      .select()
      .from(toolCallReceipts)
      .where(and(eq(toolCallReceipts.organizationId, this.organizationId), selector))
      .limit(1)
    if (!row) return null
    const evidenceRows = await this.database
      .select({ evidenceId: toolCallReceiptEvidence.evidenceId })
      .from(toolCallReceiptEvidence)
      .where(
        and(
          eq(toolCallReceiptEvidence.organizationId, this.organizationId),
          eq(toolCallReceiptEvidence.receiptId, row.id),
        ),
      )
      .orderBy(asc(toolCallReceiptEvidence.position))
    return mapToolCallReceipt(
      row,
      evidenceRows.map((evidenceRow) => evidenceRow.evidenceId),
    )
  }
}

export interface KnowledgeIndexInput {
  readonly source: KnowledgeSourceRecord
  readonly title: string
  readonly content: string
  readonly phases: readonly MissionPhase[]
  readonly indexedAt: string
}

export class PgKnowledgeIndexRepository {
  private readonly organizationId: OrganizationId | null

  public constructor(
    private readonly database: Database,
    organizationId: OrganizationId | null,
  ) {
    this.organizationId =
      organizationId === null ? null : OrganizationIdSchema.parse(organizationId)
  }

  public async replace(input: KnowledgeIndexInput): Promise<void> {
    const source = KnowledgeSourceRecordSchema.parse(input.source)
    const phases = input.phases.map((phase) => MissionPhaseSchema.parse(phase))
    if (new Set(phases).size !== phases.length || phases.length === 0) {
      throw new TypeError('Knowledge search phases must be present and unique')
    }
    if (input.title.length < 1 || input.title.length > 200) {
      throw new TypeError('Knowledge search title must contain 1 to 200 characters')
    }
    if (input.content.length < 1 || input.content.length > 200_000) {
      throw new TypeError('Knowledge search content must contain 1 to 200,000 characters')
    }
    if (sha256Text(input.content) !== source.sha256) {
      throw new DatabaseConflictError('Knowledge search content does not match its source hash')
    }
    const tenantScoped = this.organizationId !== null
    if (
      source.tenantScoped !== tenantScoped ||
      (tenantScoped ? source.visibility !== 'tenant' : source.visibility === 'tenant')
    ) {
      throw new TenantBoundaryError('Knowledge source metadata does not match its index scope')
    }
    const indexedAt = date(input.indexedAt)

    try {
      await this.database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select({ organizationId: knowledgeSources.organizationId })
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, source.id))
          .for('update')
          .limit(1)
        if (existing && existing.organizationId !== this.organizationId) {
          throw new TenantBoundaryError('Knowledge source ID belongs to another index scope')
        }
        const persisted = await transaction
          .insert(knowledgeSources)
          .values({
            id: source.id,
            organizationId: this.organizationId,
            version: source.version,
            title: input.title,
            content: input.content,
            canonicalUri: source.canonicalUri,
            audiences: source.audiences,
            phases,
            risk: source.risk,
            visibility: source.visibility,
            sensitivity: source.sensitivity,
            tenantScoped: source.tenantScoped,
            publishable: source.publishable,
            instructionRole: source.instructionRole,
            retention: source.retention,
            sourceHash: source.sha256,
            indexedAt,
          })
          .onConflictDoUpdate({
            target: knowledgeSources.id,
            setWhere:
              this.organizationId === null
                ? sql`${knowledgeSources.organizationId} IS NULL`
                : eq(knowledgeSources.organizationId, this.organizationId),
            set: {
              version: source.version,
              title: input.title,
              content: input.content,
              canonicalUri: source.canonicalUri,
              audiences: source.audiences,
              phases,
              risk: source.risk,
              visibility: source.visibility,
              sensitivity: source.sensitivity,
              tenantScoped: source.tenantScoped,
              publishable: source.publishable,
              instructionRole: source.instructionRole,
              retention: source.retention,
              sourceHash: source.sha256,
              indexedAt,
            },
          })
          .returning({ id: knowledgeSources.id })
        if (persisted.length !== 1) {
          throw new TenantBoundaryError('Knowledge source ID belongs to another index scope')
        }
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }
}

export type RichContextArtifact =
  | Readonly<{ kind: 'request'; artifact: ContextRequest }>
  | Readonly<{ kind: 'bundle'; artifact: ContextBundle }>
  | Readonly<{ kind: 'manifest'; artifact: KnowledgeManifest }>
  | Readonly<{ kind: 'internal_receipt'; artifact: InternalContextReceipt }>
  | Readonly<{ kind: 'public_receipt'; artifact: PublicContextReceipt }>

export interface StoredRichContextArtifact {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly runId: RunId
  readonly artifactHash: Sha256
  readonly createdAt: string
  readonly value: RichContextArtifact
}

function parseRichContextArtifact(input: RichContextArtifact): RichContextArtifact {
  switch (input.kind) {
    case 'request':
      return { kind: input.kind, artifact: ContextRequestSchema.parse(input.artifact) }
    case 'bundle':
      return { kind: input.kind, artifact: ContextBundleSchema.parse(input.artifact) }
    case 'manifest':
      return { kind: input.kind, artifact: KnowledgeManifestSchema.parse(input.artifact) }
    case 'internal_receipt':
      return { kind: input.kind, artifact: InternalContextReceiptSchema.parse(input.artifact) }
    case 'public_receipt':
      return { kind: input.kind, artifact: PublicContextReceiptSchema.parse(input.artifact) }
  }
}

function richContextArtifactId(value: RichContextArtifact): string {
  switch (value.kind) {
    case 'request':
      return value.artifact.requestId
    case 'bundle':
      return value.artifact.bundleId
    case 'manifest':
      return value.artifact.manifestId
    case 'internal_receipt':
    case 'public_receipt':
      return value.artifact.receiptId
  }
}

function mapRichContextArtifact(
  row: typeof contextArtifacts.$inferSelect,
): StoredRichContextArtifact {
  const value = parseRichContextArtifact({
    kind: row.kind,
    artifact: row.payload,
  } as RichContextArtifact)
  const artifactHash = hashCanonical(value.artifact)
  if (artifactHash !== row.artifactHash) {
    throw new DatabaseConflictError('Stored context artifact hash does not match its payload')
  }
  return {
    organizationId: OrganizationIdSchema.parse(row.organizationId),
    missionId: MissionIdSchema.parse(row.missionId),
    runId: RunIdSchema.parse(row.runId),
    artifactHash,
    createdAt: iso(row.createdAt),
    value,
  }
}

export class PgContextArtifactRepository {
  private readonly organizationId: OrganizationId

  public constructor(
    private readonly database: Database,
    organizationId: OrganizationId,
  ) {
    this.organizationId = OrganizationIdSchema.parse(organizationId)
  }

  public async insert(input: {
    readonly missionId: MissionId
    readonly runId: RunId
    readonly value: RichContextArtifact
  }): Promise<StoredRichContextArtifact> {
    const missionId = MissionIdSchema.parse(input.missionId)
    const runId = RunIdSchema.parse(input.runId)
    const value = parseRichContextArtifact(input.value)
    const id = richContextArtifactId(value)
    const artifactHash = hashCanonical(value.artifact)
    const createdAt = date(value.artifact.createdAt)

    try {
      return await this.database.transaction(async (transaction) => {
        if (value.kind === 'request') {
          await transaction
            .insert(contextRuns)
            .values({
              organizationId: this.organizationId,
              missionId,
              missionRef: value.artifact.missionRef,
              runId,
              createdAt,
            })
            .onConflictDoNothing()
        }
        const [boundRun] = await transaction
          .select({ missionId: contextRuns.missionId, missionRef: contextRuns.missionRef })
          .from(contextRuns)
          .where(
            and(eq(contextRuns.organizationId, this.organizationId), eq(contextRuns.runId, runId)),
          )
          .for('update')
          .limit(1)
        if (!boundRun) {
          throw new DatabaseConflictError('Context run must begin with its bound request')
        }
        if (boundRun.missionId !== missionId) {
          throw new TenantBoundaryError('Context run is already bound to another mission')
        }
        if (value.kind === 'request' && boundRun.missionRef !== value.artifact.missionRef) {
          throw new TenantBoundaryError('Context request reference is already bound')
        }
        await this.assertArtifactLinks(transaction, missionId, runId, value)
        const inserted = await transaction
          .insert(contextArtifacts)
          .values({
            id,
            organizationId: this.organizationId,
            missionId,
            runId,
            kind: value.kind,
            artifactHash,
            payload: value.artifact,
            createdAt,
          })
          .onConflictDoNothing()
          .returning()
        if (inserted[0]) return mapRichContextArtifact(inserted[0])
        const rows = await transaction
          .select()
          .from(contextArtifacts)
          .where(
            and(
              eq(contextArtifacts.organizationId, this.organizationId),
              eq(contextArtifacts.kind, value.kind),
              eq(contextArtifacts.id, id),
            ),
          )
          .limit(1)
        const existing = rows[0] ? mapRichContextArtifact(rows[0]) : null
        if (
          existing === null ||
          existing.missionId !== missionId ||
          existing.runId !== runId ||
          existing.artifactHash !== artifactHash
        ) {
          throw new DatabaseConflictError('Context artifact identity is already bound')
        }
        return existing
      })
    } catch (error) {
      throw translateDatabaseError(error)
    }
  }

  public async get(
    kind: RichContextArtifact['kind'],
    id: string,
  ): Promise<StoredRichContextArtifact | null> {
    const [row] = await this.database
      .select()
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.organizationId, this.organizationId),
          eq(contextArtifacts.kind, kind),
          eq(contextArtifacts.id, id),
        ),
      )
      .limit(1)
    return row ? mapRichContextArtifact(row) : null
  }

  public async listForRun(
    missionId: MissionId,
    runId: RunId,
  ): Promise<readonly StoredRichContextArtifact[]> {
    const rows = await this.database
      .select()
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.organizationId, this.organizationId),
          eq(contextArtifacts.missionId, MissionIdSchema.parse(missionId)),
          eq(contextArtifacts.runId, RunIdSchema.parse(runId)),
        ),
      )
      .orderBy(
        asc(contextArtifacts.createdAt),
        asc(contextArtifacts.kind),
        asc(contextArtifacts.id),
      )
    return rows.map(mapRichContextArtifact)
  }

  private async assertArtifactLinks(
    transaction: DatabaseTransaction,
    missionId: MissionId,
    runId: RunId,
    value: RichContextArtifact,
  ): Promise<void> {
    if (value.kind === 'request') {
      if (value.artifact.runRef !== runId) {
        throw new DatabaseConflictError('Context request run reference does not match its binding')
      }
      return
    }
    if (value.kind === 'manifest') return

    if (value.kind === 'public_receipt') {
      const [internal] = await transaction
        .select({ createdAt: contextArtifacts.createdAt })
        .from(contextArtifacts)
        .where(
          and(
            eq(contextArtifacts.organizationId, this.organizationId),
            eq(contextArtifacts.missionId, missionId),
            eq(contextArtifacts.runId, runId),
            eq(contextArtifacts.kind, 'internal_receipt'),
          ),
        )
        .orderBy(desc(contextArtifacts.createdAt))
        .limit(1)
      if (!internal || internal.createdAt > date(value.artifact.createdAt)) {
        throw new DatabaseConflictError(
          'Public context receipt requires an earlier internal receipt',
        )
      }
      return
    }

    const requestId = value.artifact.requestId
    const [requestRow] = await transaction
      .select()
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.organizationId, this.organizationId),
          eq(contextArtifacts.missionId, missionId),
          eq(contextArtifacts.runId, runId),
          eq(contextArtifacts.kind, 'request'),
          eq(contextArtifacts.id, requestId),
        ),
      )
      .limit(1)
    if (!requestRow) throw new DatabaseConflictError('Context artifact requires its bound request')
    const request = ContextRequestSchema.parse(requestRow.payload)

    if (value.kind === 'bundle') {
      if (
        value.artifact.phase !== request.phase ||
        value.artifact.risk !== request.risk ||
        hashCanonical(value.artifact.contractPins) !== hashCanonical(request.contractPins) ||
        date(value.artifact.createdAt) < date(request.createdAt) ||
        date(value.artifact.frozenAt) < date(value.artifact.createdAt)
      ) {
        throw new DatabaseConflictError('Context bundle does not match its request')
      }
      return
    }

    const [bundleRow] = await transaction
      .select()
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.organizationId, this.organizationId),
          eq(contextArtifacts.missionId, missionId),
          eq(contextArtifacts.runId, runId),
          eq(contextArtifacts.kind, 'bundle'),
          eq(contextArtifacts.id, value.artifact.bundleId),
        ),
      )
      .limit(1)
    if (!bundleRow) throw new DatabaseConflictError('Internal receipt requires its bound bundle')
    const bundle = ContextBundleSchema.parse(bundleRow.payload)
    const [manifestRow] = await transaction
      .select({ artifactHash: contextArtifacts.artifactHash })
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.organizationId, this.organizationId),
          eq(contextArtifacts.missionId, missionId),
          eq(contextArtifacts.runId, runId),
          eq(contextArtifacts.kind, 'manifest'),
          eq(contextArtifacts.artifactHash, value.artifact.manifestHash),
        ),
      )
      .limit(1)
    if (
      !manifestRow ||
      bundle.bundleHash !== value.artifact.bundleHash ||
      date(value.artifact.createdAt) < date(bundle.frozenAt)
    ) {
      throw new DatabaseConflictError('Internal receipt does not match its bundle and manifest')
    }
  }
}

export interface AuthenticatedSessionRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly membershipId: MembershipId
  readonly role: Membership['role']
  readonly grants: Membership['grants']
  readonly organizationSlug: string
  readonly organizationName: string
  readonly userDisplayName: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string | null
}

export interface AuthenticatedAccessTokenRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly issuedBy: UserId
  readonly scopes: readonly DelegatedPermission[]
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastUsedAt: string
}

export interface RotateSessionInput {
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly membershipId: MembershipId
  readonly currentSessionId: string
  readonly currentSignedToken: string
  readonly successor: {
    readonly id: string
    readonly signedToken: string
    readonly csrfSecret: string
    readonly createdAt: string
    readonly expiresAt: string
  }
  readonly rotatedAt: string
}

function parseDelegatedScopes(input: readonly string[]): DelegatedPermission[] {
  if (input.length === 0) throw new TypeError('Delegated access token scopes cannot be empty')
  const scopes = input.map((scope) => DelegatedPermissionSchema.parse(scope))
  if (new Set(scopes).size !== scopes.length) {
    throw new TypeError('Delegated access token scopes must be unique')
  }
  return scopes
}

function hashPresentedSecret(input: string): ReturnType<typeof hashSecret> | null {
  try {
    return hashSecret(input)
  } catch {
    return null
  }
}

export class PgCredentialRepository {
  public constructor(private readonly database: Database) {}

  public async issueSession(input: {
    id: string
    organizationId: OrganizationId
    userId: UserId
    membershipId: MembershipId
    signedToken: string
    csrfSecret: string
    createdAt: string
    expiresAt: string
  }): Promise<void> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId)
    const userId = UserIdSchema.parse(input.userId)
    const membershipId = MembershipIdSchema.parse(input.membershipId)
    await this.database.transaction(async (transaction) => {
      const [membership] = await transaction
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.id, membershipId),
            eq(memberships.userId, userId),
            sql`${memberships.revokedAt} IS NULL`,
          ),
        )
        .for('share')
        .limit(1)
      if (!membership) {
        throw new DatabaseConflictError('Session membership is not current in the tenant')
      }
      await transaction.insert(sessions).values({
        id: input.id,
        organizationId,
        userId,
        membershipId,
        tokenHash: hashSecret(input.signedToken),
        csrfSecretHash: hashSecret(input.csrfSecret),
        createdAt: date(input.createdAt),
        expiresAt: date(input.expiresAt),
      })
    })
  }

  public async authenticateSession(
    signedToken: string,
    at: string,
  ): Promise<AuthenticatedSessionRecord | null> {
    const tokenHash = hashPresentedSecret(signedToken)
    if (!tokenHash) return null
    return this.findCurrentSession(and(eq(sessions.tokenHash, tokenHash)), at, true)
  }

  public async findSessionById(
    organizationId: OrganizationId,
    sessionId: string,
    at: string,
  ): Promise<AuthenticatedSessionRecord | null> {
    return this.findCurrentSession(
      and(
        eq(sessions.organizationId, OrganizationIdSchema.parse(organizationId)),
        eq(sessions.id, sessionId),
      ),
      at,
      false,
    )
  }

  private async findCurrentSession(
    selector: ReturnType<typeof and>,
    at: string,
    touch: boolean,
  ): Promise<AuthenticatedSessionRecord | null> {
    const authenticatedAt = date(at)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          id: sessions.id,
          organizationId: sessions.organizationId,
          userId: sessions.userId,
          membershipId: sessions.membershipId,
          role: memberships.role,
          grants: memberships.grants,
          membershipCreatedAt: memberships.createdAt,
          organizationSlug: organizations.slug,
          organizationName: organizations.name,
          userDisplayName: users.displayName,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
          lastSeenAt: sessions.lastSeenAt,
        })
        .from(sessions)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, sessions.organizationId),
            eq(memberships.id, sessions.membershipId),
            eq(memberships.userId, sessions.userId),
          ),
        )
        .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            selector,
            sql`${sessions.revokedAt} IS NULL`,
            sql`${memberships.revokedAt} IS NULL`,
            sql`${sessions.createdAt} <= ${authenticatedAt}`,
            sql`${sessions.expiresAt} > ${authenticatedAt}`,
          ),
        )
        .for('update')
        .limit(1)
      if (!row) return null
      const membership = MembershipSchema.parse({
        id: row.membershipId,
        organizationId: row.organizationId,
        userId: row.userId,
        role: row.role,
        grants: row.grants,
        createdAt: iso(row.membershipCreatedAt),
        revokedAt: null,
      })
      let lastSeenAt = row.lastSeenAt
      if (touch) {
        const [updated] = await transaction
          .update(sessions)
          .set({
            lastSeenAt: sql`greatest(coalesce(${sessions.lastSeenAt}, ${authenticatedAt}), ${authenticatedAt})`,
          })
          .where(
            and(
              eq(sessions.organizationId, row.organizationId),
              eq(sessions.id, row.id),
              sql`${sessions.revokedAt} IS NULL`,
            ),
          )
          .returning({ lastSeenAt: sessions.lastSeenAt })
        if (!updated) return null
        lastSeenAt = updated.lastSeenAt
      }
      return {
        id: row.id,
        organizationId: OrganizationIdSchema.parse(row.organizationId),
        userId: UserIdSchema.parse(row.userId),
        membershipId: MembershipIdSchema.parse(row.membershipId),
        role: membership.role,
        grants: membership.grants,
        organizationSlug: row.organizationSlug,
        organizationName: row.organizationName,
        userDisplayName: row.userDisplayName,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        lastSeenAt: lastSeenAt ? iso(lastSeenAt) : null,
      }
    })
  }

  public async rotateSession(input: RotateSessionInput): Promise<boolean> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId)
    const userId = UserIdSchema.parse(input.userId)
    const membershipId = MembershipIdSchema.parse(input.membershipId)
    const rotatedAt = date(input.rotatedAt)
    const successorCreatedAt = date(input.successor.createdAt)
    const successorExpiresAt = date(input.successor.expiresAt)
    const currentTokenHash = hashPresentedSecret(input.currentSignedToken)
    if (!currentTokenHash) return false
    if (successorCreatedAt.valueOf() !== rotatedAt.valueOf()) {
      throw new TypeError('Successor session creation time must equal the rotation time')
    }
    if (successorExpiresAt <= successorCreatedAt) {
      throw new TypeError('Successor session must expire after it is created')
    }
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, sessions.organizationId),
            eq(memberships.id, sessions.membershipId),
            eq(memberships.userId, sessions.userId),
          ),
        )
        .where(
          and(
            eq(sessions.organizationId, organizationId),
            eq(sessions.id, input.currentSessionId),
            eq(sessions.userId, userId),
            eq(sessions.membershipId, membershipId),
            eq(sessions.tokenHash, currentTokenHash),
            sql`${sessions.revokedAt} IS NULL`,
            sql`${memberships.revokedAt} IS NULL`,
            sql`${sessions.createdAt} <= ${rotatedAt}`,
            sql`${sessions.expiresAt} > ${rotatedAt}`,
          ),
        )
        .for('update')
        .limit(1)
      if (!current) return false
      const revoked = await transaction
        .update(sessions)
        .set({ revokedAt: rotatedAt })
        .where(
          and(
            eq(sessions.organizationId, organizationId),
            eq(sessions.id, current.id),
            sql`${sessions.revokedAt} IS NULL`,
          ),
        )
        .returning({ id: sessions.id })
      if (revoked.length !== 1) return false
      await transaction.insert(sessions).values({
        id: input.successor.id,
        organizationId,
        userId,
        membershipId,
        tokenHash: hashSecret(input.successor.signedToken),
        csrfSecretHash: hashSecret(input.successor.csrfSecret),
        createdAt: successorCreatedAt,
        expiresAt: successorExpiresAt,
      })
      return true
    })
  }

  public async revokeSession(
    organizationId: OrganizationId,
    sessionId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const updated = await this.database
      .update(sessions)
      .set({ revokedAt: date(revokedAt) })
      .where(
        and(
          eq(sessions.organizationId, OrganizationIdSchema.parse(organizationId)),
          eq(sessions.id, sessionId),
          sql`${sessions.revokedAt} IS NULL`,
        ),
      )
      .returning({ id: sessions.id })
    return updated.length === 1
  }

  public async issueAccessToken(input: {
    id: string
    organizationId: OrganizationId
    issuedBy: UserId
    bearerToken: string
    scopes: readonly DelegatedPermission[]
    createdAt: string
    expiresAt: string
  }): Promise<void> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId)
    const issuedBy = UserIdSchema.parse(input.issuedBy)
    const scopes = parseDelegatedScopes(input.scopes)
    await this.database.transaction(async (transaction) => {
      const [membership] = await transaction
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, issuedBy),
            sql`${memberships.revokedAt} IS NULL`,
          ),
        )
        .for('share')
        .limit(1)
      if (!membership) {
        throw new DatabaseConflictError('Delegated token issuer is not a current tenant member')
      }
      await transaction.insert(accessTokens).values({
        id: input.id,
        organizationId,
        issuedBy,
        tokenHash: hashSecret(input.bearerToken),
        scopes,
        createdAt: date(input.createdAt),
        expiresAt: date(input.expiresAt),
      })
    })
  }

  public async authenticateAccessToken(
    bearerToken: string,
    at: string,
  ): Promise<AuthenticatedAccessTokenRecord | null> {
    const tokenHash = hashPresentedSecret(bearerToken)
    if (!tokenHash) return null
    const authenticatedAt = date(at)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          id: accessTokens.id,
          organizationId: accessTokens.organizationId,
          issuedBy: accessTokens.issuedBy,
          scopes: accessTokens.scopes,
          createdAt: accessTokens.createdAt,
          expiresAt: accessTokens.expiresAt,
          lastUsedAt: accessTokens.lastUsedAt,
        })
        .from(accessTokens)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, accessTokens.organizationId),
            eq(memberships.userId, accessTokens.issuedBy),
          ),
        )
        .where(
          and(
            eq(accessTokens.tokenHash, tokenHash),
            sql`${accessTokens.revokedAt} IS NULL`,
            sql`${memberships.revokedAt} IS NULL`,
            sql`${accessTokens.createdAt} <= ${authenticatedAt}`,
            sql`${accessTokens.expiresAt} > ${authenticatedAt}`,
          ),
        )
        .for('update')
        .limit(1)
      if (!row) return null
      let scopes: DelegatedPermission[]
      try {
        scopes = parseDelegatedScopes(row.scopes)
      } catch {
        return null
      }
      const [updated] = await transaction
        .update(accessTokens)
        .set({
          lastUsedAt: sql`greatest(coalesce(${accessTokens.lastUsedAt}, ${authenticatedAt}), ${authenticatedAt})`,
        })
        .where(
          and(eq(accessTokens.organizationId, row.organizationId), eq(accessTokens.id, row.id)),
        )
        .returning({ lastUsedAt: accessTokens.lastUsedAt })
      if (!updated?.lastUsedAt) return null
      return {
        id: row.id,
        organizationId: OrganizationIdSchema.parse(row.organizationId),
        issuedBy: UserIdSchema.parse(row.issuedBy),
        scopes,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        lastUsedAt: iso(updated.lastUsedAt),
      }
    })
  }

  public async revokeAccessToken(
    organizationId: OrganizationId,
    tokenId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const updated = await this.database
      .update(accessTokens)
      .set({ revokedAt: date(revokedAt) })
      .where(
        and(
          eq(accessTokens.organizationId, OrganizationIdSchema.parse(organizationId)),
          eq(accessTokens.id, tokenId),
          sql`${accessTokens.revokedAt} IS NULL`,
        ),
      )
      .returning({ id: accessTokens.id })
    return updated.length === 1
  }
}

export function createUnitOfWork(database: Database): PgUnitOfWork {
  return new PgUnitOfWork(database)
}

export function createIdentityTelemetryIngressUnitOfWork(
  database: Database,
): PgIdentityTelemetryIngressUnitOfWork {
  return new PgIdentityTelemetryIngressUnitOfWork(database)
}

export function createMissionExecutionUnitOfWork(database: Database): PgMissionExecutionUnitOfWork {
  return new PgMissionExecutionUnitOfWork(database)
}

export function createSystemOutboxRepository(database: Database): PgSystemOutboxRepository {
  return new PgSystemOutboxRepository(database)
}
