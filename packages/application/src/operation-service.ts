import {
  AttemptSchema,
  ApprovalSchema,
  CARETAKER_BUDGETS,
  OperationSchema,
  PersistedEvidenceRecordSchema,
  PlanSchema,
  assertApprovalAuthorizesPlan,
  assertPermission,
  assertSameTenant,
  decideOperationReplay,
  isRoutineReplacementAction,
  type Attempt,
  type AttemptStatus,
  type AttemptTransport,
  type EvidenceId,
  type Mission,
  type Operation,
  type OperationId,
  type Plan,
  type PlanAction,
  type PlanActionId,
  type PlanId,
  type ToolCallId,
} from '@trash-palace/core'

import {
  NO_APPLICATION_TRANSPORT_FAULT_POLICY,
  type ApplicationTransportFaultPolicyPort,
} from './application-transport-fault.js'
import { ConflictError, NotFoundError } from './errors.js'
import { materializeActivationExecution } from './execution-materialization-service.js'
import { HomecomingExecutionPlanner } from './homecoming-execution-planner.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import type {
  ActorContext,
  AuthContext,
  JsonValue,
  OperationReconciliationReference,
  OutboxMessage,
  ReconciliationPoll,
} from './models.js'
import { OperationReconciliationReferenceSchema } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import {
  CryptoIdGenerator,
  SYSTEM_CLOCK,
  addMilliseconds,
  hashCanonical,
  iso,
  parseGeneratedId,
} from './primitives.js'
import {
  enqueueApplicationProductEvidence,
  type ApplicationProductEvidenceInput,
} from './product-evidence.js'
import type {
  ClockPort,
  ExecutionPlannerPort,
  IdGeneratorPort,
  MissionExecutionUnitOfWorkPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export type ActivationResult =
  | Readonly<{
      status: 'committed'
      operation: Operation
      replayed: boolean
      delivery:
        | Readonly<{ status: 'acknowledged' }>
        | Readonly<{
            status: 'unknown'
            attemptId: Attempt['id']
            evidenceIds: readonly EvidenceId[]
          }>
    }>
  | Readonly<{
      status: 'conflict'
      operation: Operation
      reason: 'approval_expired' | 'payload_mismatch' | 'protected_state_stale'
    }>

export interface OperationLedgerResult {
  readonly operation: Operation
  readonly attempts: readonly Attempt[]
}

interface ActivationBaseInput {
  readonly planId: PlanId
  readonly actionId: PlanActionId
  readonly expectedVersion: number
  readonly toolCallId: ToolCallId
}

export interface ManualActivationInput extends ActivationBaseInput {
  readonly authorization: 'manual'
  readonly context: AuthContext
}

export interface MissionLeaseActivationInput extends ActivationBaseInput {
  readonly authorization: 'mission_lease'
  readonly context: MissionExecutionContext
}

export type ActivationInput = ManualActivationInput | MissionLeaseActivationInput

export const DEFAULT_OPERATION_RECONCILIATION_BUDGET_MILLISECONDS = 5_000

type UnknownOperationOutcomeReason =
  ApplicationProductEvidenceInput<'operation outcome unknown'>['properties']['unknown_reason']

export class OperationService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort | null = null,
    private readonly executionPlanner: ExecutionPlannerPort = new HomecomingExecutionPlanner(),
    private readonly transportFaultPolicy: ApplicationTransportFaultPolicyPort = NO_APPLICATION_TRANSPORT_FAULT_POLICY,
    private readonly reconciliationBudgetMilliseconds = DEFAULT_OPERATION_RECONCILIATION_BUDGET_MILLISECONDS,
  ) {}

  public async get(input: {
    readonly context: ActorContext
    readonly operationId: OperationId
  }): Promise<OperationLedgerResult> {
    assertPermission(input.context.principal, 'operation:reconcile')
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const operation = await repositories.operations.get(input.operationId)
      if (operation === null) throw new NotFoundError('Operation')
      return {
        operation,
        attempts: await repositories.attempts.listForOperation(operation.id),
      }
    })
  }

  public async activate(input: ActivationInput): Promise<ActivationResult> {
    assertPermission(input.context.principal, 'routine:activate')
    const organizationId = input.context.principal.organizationId
    if (input.authorization === 'manual' && !('sessionId' in input.context)) {
      throw new ConflictError('Manual activation requires an authenticated session')
    }
    const result = await this.observability.trace(
      {
        name: 'operation.activate',
        kind: 'operation',
        correlation: { organizationId, planId: input.planId },
      },
      () => {
        const work = async (repositories: TenantRepositories): Promise<ActivationResult> => {
          const plan = await repositories.plans.get(input.planId)
          if (plan === null) throw new NotFoundError('Plan')
          if (
            input.authorization === 'mission_lease' &&
            (input.context.fence.organizationId !== organizationId ||
              input.context.fence.missionId !== plan.missionId)
          ) {
            throw new ConflictError('Mission fence does not authorize this activation')
          }
          const action = plan.actions.find((candidate) => candidate.id === input.actionId)
          if (action === undefined) throw new NotFoundError('Plan action')
          const approval = await repositories.approvals.findForPlan(plan.id)
          if (approval === null) throw new ConflictError('Plan has no approval')
          const operation = await repositories.operations.findByPlanAction(plan.id, action.id)
          if (operation === null) {
            throw new ConflictError(
              'Activation requires the server-created operation bound at approval',
            )
          }
          const mission = await repositories.missions.get(plan.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          assertSameTenant(organizationId, [
            plan.organizationId,
            approval.organizationId,
            operation.organizationId,
            mission.organizationId,
          ])

          const requestedHash = payloadHashForExpectedVersion(plan, action, input.expectedVersion)
          if (decideOperationReplay(operation.payloadHash, requestedHash) === 'conflict') {
            return { status: 'conflict', operation, reason: 'payload_mismatch' }
          }
          if (operation.status === 'committed') {
            await this.#enqueueRoutineActivated(repositories, mission, operation)
            return {
              status: 'committed',
              operation,
              replayed: true,
              delivery: { status: 'acknowledged' },
            }
          }
          if (operation.status !== 'pending') {
            throw new ConflictError(`Operation cannot activate from ${operation.status}`)
          }

          const now = iso(this.clock.now())
          if (Date.parse(now) >= Date.parse(approval.expiresAt)) {
            const next = await invalidateBeforeActivation(
              repositories,
              approval,
              plan,
              operation,
              mission,
              'expired',
              this.clock,
              this.ids,
            )
            return { status: 'conflict', operation: next, reason: 'approval_expired' }
          }
          assertApprovalAuthorizesPlan(approval, plan, now)
          if (!(await protectedStateIsCurrent(repositories, action))) {
            const next = await invalidateBeforeActivation(
              repositories,
              approval,
              plan,
              operation,
              mission,
              'stale',
              this.clock,
              this.ids,
            )
            return { status: 'conflict', operation: next, reason: 'protected_state_stale' }
          }

          const outcome = await repositories.routines.applyApprovedAction(plan, action)
          const committed = OperationSchema.parse({
            ...operation,
            status: 'committed',
            outcome,
            committedAt: now,
          })
          await repositories.operations.save(committed)
          await materializeActivationExecution({
            repositories,
            operation: committed,
            plan,
            action,
            at: now,
            ids: this.ids,
            planner: this.executionPlanner,
            authorization:
              input.authorization === 'manual'
                ? { kind: 'manual' }
                : { kind: 'mission_lease', epoch: input.context.fence.epoch },
          })
          await this.#enqueueRoutineActivated(repositories, mission, committed)
          if (
            input.authorization === 'mission_lease' &&
            this.transportFaultPolicy.shouldLoseCommittedResponse({
              organizationId,
              authorization: input.authorization,
            })
          ) {
            const lost = await persistApplicationResponseLoss({
              repositories,
              observability: this.observability,
              mission,
              operation: committed,
              toolCallId: input.toolCallId,
              at: now,
              clock: this.clock,
              ids: this.ids,
              reconciliationBudgetMilliseconds: this.reconciliationBudgetMilliseconds,
            })
            return {
              status: 'committed',
              operation: committed,
              replayed: false,
              delivery: {
                status: 'unknown',
                attemptId: lost.attempt.id,
                evidenceIds: [lost.evidenceId],
              },
            }
          }
          const planOperations = await repositories.operations.listForMission(mission.id)
          const actionIds = new Set(plan.actions.map((candidate) => candidate.id))
          const approvedOperations = planOperations.filter(
            (candidate) => candidate.planId === plan.id && actionIds.has(candidate.planActionId),
          )
          if (
            approvedOperations.length === plan.actions.length &&
            approvedOperations.every((candidate) => candidate.status === 'committed')
          ) {
            await persistMissionTransition({
              repositories,
              mission,
              expectedVersion: mission.version,
              event: 'execution_committed',
              clock: this.clock,
              ids: this.ids,
            })
          }
          return {
            status: 'committed',
            operation: committed,
            replayed: false,
            delivery: { status: 'acknowledged' },
          }
        }
        if (input.authorization === 'manual') {
          return this.unitOfWork.run(organizationId, work)
        }
        if (!('fence' in input.context)) {
          throw new ConflictError('Mission activation requires an execution context')
        }
        assertMissionExecutionContext(input.context, {
          organizationId,
          missionId: input.context.fence.missionId,
        })
        if (this.missionUnitOfWork === null) {
          throw new ConflictError('Mission activation requires a fenced unit of work')
        }
        return this.missionUnitOfWork.runFenced(input.context.fence, work)
      },
    )
    return result
  }

  async #enqueueRoutineActivated(
    repositories: TenantRepositories,
    mission: Mission,
    operation: Operation,
  ): Promise<void> {
    const outcome = operation.outcome
    const committedAt = operation.committedAt
    if (outcome === null || committedAt === null) {
      throw new ConflictError('Committed operation lacks its durable activation outcome')
    }
    const routine = await repositories.routines.get(outcome.routineId, outcome.routineVersionId)
    if (routine === null) throw new NotFoundError('Routine version')
    const execution = await repositories.executions.findForOperation(operation.id)
    if (execution === null) throw new NotFoundError('Execution')
    await enqueueApplicationProductEvidence(repositories, this.observability, {
      event: 'routine activated',
      durableIdentity: {
        operationId: operation.id,
        routineVersionId: outcome.routineVersionId,
      },
      occurredAt: committedAt,
      correlation: {
        distinctId: mission.initiatedBy,
        organizationId: operation.organizationId,
        palaceId: mission.palaceId,
        missionId: mission.id,
        ...(mission.runId === null ? {} : { runId: mission.runId }),
        planId: operation.planId,
        operationId: operation.id,
        resourceId: outcome.routineId,
      },
      properties: {
        routine_version: routine.version.version,
        activation_source: execution.authorization.kind === 'manual' ? 'manual' : 'mission_lease',
      },
    })
  }

  public async reconcile(reference: OperationReconciliationReference): Promise<
    Readonly<{
      resolution: 'committed' | 'retry_same_operation' | 'budget_exhausted'
      operation: Operation
      mission: Mission
    }>
  > {
    const input = OperationReconciliationReferenceSchema.parse(reference)
    const organizationId = input.organizationId
    const committed = await this.observability.trace(
      {
        name: 'operation.reconcile',
        kind: 'operation',
        correlation: { organizationId, operationId: input.operationId },
      },
      () =>
        this.unitOfWork.run(organizationId, async (repositories) => {
          const operation = await repositories.operations.get(input.operationId)
          if (operation === null) throw new NotFoundError('Operation')
          const mission = await repositories.missions.get(operation.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          assertSameTenant(organizationId, [operation.organizationId, mission.organizationId])
          if (mission.state.status !== 'running' || mission.state.phase !== 'reconcile') {
            throw new ConflictError('Mission is not at the reconciliation checkpoint')
          }
          const polls = await repositories.reconciliations.listForOperation(operation.id)
          const attempts = await repositories.attempts.listForOperation(operation.id)
          const unresolvedApplicationAttempts = attempts.filter(
            (attempt) => attempt.transport !== 'gateway' && attempt.status === 'unknown',
          )
          if (
            unresolvedApplicationAttempts.length !== 1 ||
            unresolvedApplicationAttempts[0]?.id !== input.attemptId
          ) {
            throw new ConflictError(
              'Operation reconciliation requires its sole unresolved application attempt',
            )
          }
          const attempt = unresolvedApplicationAttempts[0]
          if (attempt.completedAt === null) {
            throw new ConflictError('Operation reconciliation requires a completed unknown attempt')
          }
          let event:
            'reconcile_absent_retryable' | 'reconcile_budget_exhausted' | 'reconcile_commit_found'
          let resolution: 'budget_exhausted' | 'committed' | 'retry_same_operation'
          if (operation.status === 'committed') {
            event = 'reconcile_commit_found'
            resolution = 'committed'
          } else if (polls.length + 1 < CARETAKER_BUDGETS.maxReconciliationPolls) {
            event = 'reconcile_absent_retryable'
            resolution = 'retry_same_operation'
          } else {
            event = 'reconcile_budget_exhausted'
            resolution = 'budget_exhausted'
          }
          const observedAt = iso(
            new Date(
              Math.max(
                this.clock.now().getTime(),
                addMilliseconds(new Date(attempt.completedAt), 1).getTime(),
              ),
            ),
          )
          const poll: ReconciliationPoll = {
            organizationId,
            operationId: operation.id,
            sequence: polls.length + 1,
            resolution:
              resolution === 'committed'
                ? 'committed'
                : resolution === 'retry_same_operation'
                  ? 'definitely_absent'
                  : 'still_unknown',
            occurredAt: observedAt,
          }
          await repositories.reconciliations.insert(poll)
          const nextMission = await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event,
            clock: this.clock,
            ids: this.ids,
          })
          if (attempts.length > 0) {
            await enqueueApplicationProductEvidence(repositories, this.observability, {
              event: 'operation reconciled',
              durableIdentity: {
                operationId: operation.id,
                pollSequence: poll.sequence,
              },
              occurredAt: poll.occurredAt,
              correlation: {
                distinctId: nextMission.initiatedBy,
                organizationId,
                palaceId: nextMission.palaceId,
                missionId: nextMission.id,
                ...(nextMission.runId === null ? {} : { runId: nextMission.runId }),
                planId: operation.planId,
                operationId: operation.id,
              },
              properties: {
                resolution:
                  resolution === 'committed'
                    ? 'committed'
                    : resolution === 'retry_same_operation'
                      ? 'absent_retrying'
                      : 'still_unknown',
                attempt_count: attempts.length,
                duration_ms: Math.max(
                  0,
                  Date.parse(poll.occurredAt) - Date.parse(attempt.startedAt),
                ),
              },
            })
          }
          return { resolution, operation, mission: nextMission }
        }),
    )
    return committed
  }
}

export class OperationAttemptService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort | null = null,
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly reconciliationBudgetMilliseconds = DEFAULT_OPERATION_RECONCILIATION_BUDGET_MILLISECONDS,
  ) {}

  public record(input: {
    readonly context: MissionExecutionContext
    readonly operationId: OperationId
    readonly transport: AttemptTransport
    readonly status: Exclude<AttemptStatus, 'pending'>
    readonly retryable: boolean
    readonly error?: { readonly code: string; readonly message: string }
    readonly unknownReason?: UnknownOperationOutcomeReason
  }): Promise<Attempt> {
    const organizationId = input.context.principal.organizationId
    if (!('fence' in input.context)) {
      throw new ConflictError('Operation attempt requires an execution context')
    }
    assertMissionExecutionContext(input.context, {
      organizationId,
      missionId: input.context.fence.missionId,
    })
    if (this.missionUnitOfWork === null) {
      throw new ConflictError('Operation attempt requires a fenced unit of work')
    }
    return this.missionUnitOfWork.runFenced(input.context.fence, async (repositories) => {
      const operation = await repositories.operations.get(input.operationId)
      if (operation === null) throw new NotFoundError('Operation')
      if (operation.missionId !== input.context.fence.missionId) {
        throw new ConflictError('Mission fence does not authorize this operation attempt')
      }
      const now = iso(this.clock.now())
      const attempt = await persistOperationAttempt({
        repositories,
        operation,
        id: parseGeneratedId('attempt', this.ids.next('attempt')),
        transport: input.transport,
        status: input.status,
        retryable: input.retryable,
        error: input.error ?? null,
        at: now,
      })
      const mission = await repositories.missions.get(operation.missionId)
      if (mission === null) throw new NotFoundError('Mission')
      if (attempt.status === 'unknown') {
        await enqueueUnknownOperationOutcomeProductEvidence({
          repositories,
          observability: this.observability,
          mission,
          operation,
          attempt,
          unknownReason:
            input.unknownReason ?? classifyUnknownOperationOutcome(attempt.error?.code),
          reconciliationBudgetMilliseconds: this.reconciliationBudgetMilliseconds,
        })
      }
      if (mission.state.status === 'running' && mission.state.phase === 'execute') {
        if (input.status === 'unknown') {
          await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: 'execution_unknown',
            clock: this.clock,
            ids: this.ids,
          })
          await enqueueOperationReconciliation(repositories, operation, attempt, now, this.ids)
        } else if (input.status === 'succeeded') {
          const operations = await repositories.operations.listForMission(mission.id)
          if (operations.every((candidate) => candidate.status === 'committed')) {
            await persistMissionTransition({
              repositories,
              mission,
              expectedVersion: mission.version,
              event: 'execution_committed',
              clock: this.clock,
              ids: this.ids,
            })
          }
        } else if (!input.retryable) {
          await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: 'execution_non_retryable_failure',
            clock: this.clock,
            ids: this.ids,
          })
        }
      }
      return attempt
    })
  }
}

async function persistApplicationResponseLoss(input: {
  readonly repositories: TenantRepositories
  readonly observability: ObservabilityPort
  readonly mission: Mission
  readonly operation: Operation
  readonly toolCallId: ToolCallId
  readonly at: string
  readonly clock: ClockPort
  readonly ids: IdGeneratorPort
  readonly reconciliationBudgetMilliseconds: number
}): Promise<Readonly<{ attempt: Attempt; evidenceId: EvidenceId }>> {
  if (input.operation.status !== 'committed') {
    throw new ConflictError('Application response loss requires a committed operation')
  }
  if (input.mission.state.status !== 'running' || input.mission.state.phase !== 'execute') {
    throw new ConflictError('Application response loss requires the execution checkpoint')
  }

  const attempt = await persistOperationAttempt({
    repositories: input.repositories,
    operation: input.operation,
    id: parseGeneratedId('attempt', input.ids.next('attempt')),
    transport: 'worker',
    status: 'unknown',
    retryable: true,
    error: {
      code: 'APPLICATION_RESPONSE_LOST',
      message: 'The operation committed, but the application response was lost',
    },
    at: input.at,
  })
  const evidenceId = parseGeneratedId('evidence', input.ids.next('evidence'))
  const evidence = PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence: {
      id: evidenceId,
      organizationId: input.operation.organizationId,
      missionId: input.mission.id,
      palaceId: input.mission.palaceId,
      observedAt: input.at,
      type: 'operation_transport',
      operationId: input.operation.id,
      attemptId: attempt.id,
      toolCallId: input.toolCallId,
      transport: 'worker',
      status: 'unknown',
      operationCommitted: true,
      errorCode: 'APPLICATION_RESPONSE_LOST',
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: parseGeneratedId(
        'evidence_authority_receipt',
        input.ids.next('evidence_authority_receipt'),
      ),
      evidenceId,
      organizationId: input.operation.organizationId,
      missionId: input.mission.id,
      palaceId: input.mission.palaceId,
      verifiedAt: input.at,
      authority: 'application',
      producer: 'application_code',
      ruleId: 'operation.application_response_lost',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    },
    persistedAt: input.at,
  })
  await input.repositories.evidence.appendMany([evidence])
  await enqueueUnknownOperationOutcomeProductEvidence({
    repositories: input.repositories,
    observability: input.observability,
    mission: input.mission,
    operation: input.operation,
    attempt,
    unknownReason: 'connection_lost',
    reconciliationBudgetMilliseconds: input.reconciliationBudgetMilliseconds,
  })
  await persistMissionTransition({
    repositories: input.repositories,
    mission: input.mission,
    expectedVersion: input.mission.version,
    event: 'execution_unknown',
    clock: input.clock,
    ids: input.ids,
  })
  await enqueueOperationReconciliation(
    input.repositories,
    input.operation,
    attempt,
    input.at,
    input.ids,
  )
  return { attempt, evidenceId }
}

async function persistOperationAttempt(input: {
  readonly repositories: TenantRepositories
  readonly operation: Operation
  readonly id: Attempt['id']
  readonly transport: AttemptTransport
  readonly status: Exclude<AttemptStatus, 'pending'>
  readonly retryable: boolean
  readonly error: Attempt['error']
  readonly at: string
}): Promise<Attempt> {
  const prior = await input.repositories.attempts.listForOperation(input.operation.id)
  const attempt = AttemptSchema.parse({
    id: input.id,
    organizationId: input.operation.organizationId,
    operationId: input.operation.id,
    sequence: prior.length + 1,
    transport: input.transport,
    status: input.status,
    retryable: input.retryable,
    error: input.error,
    startedAt: input.at,
    completedAt: input.at,
  })
  await input.repositories.attempts.insert(attempt)
  return attempt
}

export async function enqueueUnknownOperationOutcomeProductEvidence(input: {
  readonly repositories: TenantRepositories
  readonly observability: ObservabilityPort
  readonly mission: Mission
  readonly operation: Operation
  readonly attempt: Attempt
  readonly unknownReason: UnknownOperationOutcomeReason
  readonly reconciliationBudgetMilliseconds: number
}): Promise<void> {
  if (input.attempt.status !== 'unknown') {
    throw new TypeError('Unknown operation outcome evidence requires an unknown attempt')
  }
  if (
    !Number.isFinite(input.reconciliationBudgetMilliseconds) ||
    input.reconciliationBudgetMilliseconds < 0
  ) {
    throw new RangeError('Reconciliation evidence requires a non-negative millisecond budget')
  }
  await enqueueApplicationProductEvidence(input.repositories, input.observability, {
    event: 'operation outcome unknown',
    durableIdentity: {
      operationId: input.operation.id,
      attemptId: input.attempt.id,
    },
    occurredAt: input.attempt.completedAt ?? input.attempt.startedAt,
    correlation: {
      distinctId: input.mission.initiatedBy,
      organizationId: input.operation.organizationId,
      palaceId: input.mission.palaceId,
      missionId: input.mission.id,
      ...(input.mission.runId === null ? {} : { runId: input.mission.runId }),
      planId: input.operation.planId,
      operationId: input.operation.id,
      attemptId: input.attempt.id,
    },
    properties: {
      attempt_transport: input.attempt.transport,
      unknown_reason: input.unknownReason,
      attempt_count: input.attempt.sequence,
      reconciliation_budget_ms: input.reconciliationBudgetMilliseconds,
      retryable: true,
    },
  })
}

function classifyUnknownOperationOutcome(
  errorCode: string | undefined,
): UnknownOperationOutcomeReason {
  if (errorCode === undefined) return 'callback_missing'
  const normalized = errorCode.toUpperCase()
  if (normalized.includes('TIMEOUT')) return 'timeout'
  if (normalized.includes('CALLBACK')) return 'callback_missing'
  if (normalized.includes('WORKER') && normalized.includes('RESTART')) return 'worker_restart'
  if (normalized.includes('MALFORMED') || normalized.includes('PARSE')) return 'malformed_result'
  if (
    normalized.includes('CONNECTION') ||
    normalized.includes('RESPONSE_LOST') ||
    normalized === 'APPLICATION_RESPONSE_LOST'
  ) {
    return 'connection_lost'
  }
  return 'malformed_result'
}

async function enqueueOperationReconciliation(
  repositories: TenantRepositories,
  operation: Operation,
  attempt: Attempt,
  createdAt: string,
  ids: IdGeneratorPort,
): Promise<void> {
  const deduplicationKey = `operation.reconcile:${operation.id}:${attempt.id}`
  if ((await repositories.outbox.findByDeduplicationKey(deduplicationKey)) !== null) return
  const payload: Readonly<Record<string, JsonValue>> = {
    organizationId: operation.organizationId,
    operationId: operation.id,
    attemptId: attempt.id,
  }
  const message: OutboxMessage = {
    id: ids.next('outbox'),
    organizationId: operation.organizationId,
    topic: 'operation.reconcile',
    deduplicationKey,
    payload,
    status: 'pending',
    availableAt: createdAt,
    createdAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
  await repositories.outbox.insert(message)
}

function payloadHashForExpectedVersion(plan: Plan, action: PlanAction, expectedVersion: number) {
  const requestedAction = isRoutineReplacementAction(action)
    ? { ...action, expectedProtectedVersion: expectedVersion }
    : { ...action, expectedCurrentVersion: expectedVersion }
  return hashCanonical({ planHash: plan.hash, action: requestedAction })
}

async function protectedStateIsCurrent(
  repositories: TenantRepositories,
  action: PlanAction,
): Promise<boolean> {
  const routineId = isRoutineReplacementAction(action)
    ? action.protectedRoutineId
    : action.routineId
  const current = await repositories.routines.getCurrentVersion(routineId)
  if (current === null) return false
  return isRoutineReplacementAction(action)
    ? current.routineVersionId === action.protectedRoutineVersionId &&
        current.version === action.expectedProtectedVersion
    : current.version === action.expectedCurrentVersion
}

async function invalidateBeforeActivation(
  repositories: TenantRepositories,
  approval: Awaited<ReturnType<TenantRepositories['approvals']['get']>> & {},
  plan: Plan,
  operation: Operation,
  mission: Mission,
  reason: 'expired' | 'stale',
  clock: ClockPort,
  ids: IdGeneratorPort,
): Promise<Operation> {
  await repositories.approvals.save(
    ApprovalSchema.parse({
      ...approval,
      status: reason === 'expired' ? 'expired' : 'invalidated',
      approvedBy: null,
      approverRole: null,
      approvedAt: null,
    }),
  )
  await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'superseded' }))
  const cancelled = OperationSchema.parse({ ...operation, status: 'cancelled' })
  await repositories.operations.save(cancelled)
  await persistMissionTransition({
    repositories,
    mission,
    expectedVersion: mission.version,
    event: 'approval_expired_or_stale',
    clock,
    ids,
  })
  return cancelled
}
