import {
  ExecutionSchema,
  PersistedEvidenceRecordSchema,
  createGatewayCommand,
  deriveGatewayCommandId,
  type ApplicationAuthorityEvidence,
  type EvidenceId,
  type Execution,
  type ExecutionId,
  type MissionId,
  type Operation,
  type PersistedEvidenceRecord,
  type Plan,
  type PlanAction,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import {
  HOMECOMING_LOGICAL_KEYS,
  HomecomingExecutionPlanner,
  homecomingExecutionDeadline,
} from './homecoming-execution-planner.js'
import type {
  GatewayEffectIntent,
  GatewayEffectAuthorization,
  GatewayEffectMaterializationResult,
  OutboxMessage,
  PlannedGatewayEffect,
} from './models.js'
import { IdentityArrivalExecutionReferenceSchema, PlannedGatewayEffectSchema } from './models.js'
import {
  CryptoIdGenerator,
  SYSTEM_CLOCK,
  hashCanonical,
  iso,
  parseGeneratedId,
} from './primitives.js'
import type {
  ClockPort,
  ExecutionPlannerPort,
  IdGeneratorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export interface ActivationExecutionMaterializationResult {
  readonly execution: Execution
  readonly trigger: PersistedEvidenceRecord
  readonly evidence: readonly PersistedEvidenceRecord[]
  readonly effects: readonly GatewayEffectMaterializationResult[]
}

export const ACTIVATION_APPLICATION_EVIDENCE_RULES = {
  activeRoutine: { id: 'routine.activation.commit', version: 1 },
  protectedRoutineInactive: { id: 'routine.activation.deactivate-protected', version: 1 },
  batteryProjection: { id: 'routine.activation.project-battery', version: 1 },
  tenantBinding: { id: 'routine.activation.tenant-binding', version: 1 },
} as const

export async function materializeActivationExecution(input: {
  readonly repositories: TenantRepositories
  readonly operation: Operation
  readonly plan: Plan
  readonly action: PlanAction
  readonly at: string
  readonly ids: IdGeneratorPort
  readonly planner?: ExecutionPlannerPort
  readonly authorization: GatewayEffectAuthorization
}): Promise<ActivationExecutionMaterializationResult> {
  if (input.operation.status !== 'committed' || input.operation.outcome === null) {
    throw new ConflictError('Execution materialization requires a committed operation')
  }
  assertBindings(input.operation, input.plan, input.action)
  const evidence = activationEvidence({
    operation: input.operation,
    outcome: input.operation.outcome,
    plan: input.plan,
    action: input.action,
    at: input.at,
  })
  const trigger = evidence[0]
  if (trigger === undefined) throw new ConflictError('Activation evidence is incomplete')
  await input.repositories.evidence.appendMany(evidence)
  const capabilities = await input.repositories.capabilities.list(input.plan.palaceId)
  const planned = await (input.planner ?? new HomecomingExecutionPlanner()).planActivation({
    operation: input.operation,
    plan: input.plan,
    action: input.action,
    capabilities,
    trigger,
    at: input.at,
  })
  if (
    planned.length !== 1 ||
    planned[0]?.milestone !== 'preheat' ||
    planned[0].kind !== 'set_temperature'
  ) {
    throw new ConflictError('Activation must materialize exactly one preheat effect')
  }
  const execution = ExecutionSchema.parse({
    id: parseGeneratedId('execution', input.ids.next('execution')),
    organizationId: input.operation.organizationId,
    missionId: input.operation.missionId,
    operationId: input.operation.id,
    routineId: input.operation.outcome.routineId,
    routineVersionId: input.operation.outcome.routineVersionId,
    status: 'running',
    triggeredByEvidenceId: trigger.evidence.id,
    evidenceIds: evidence.map((record) => record.evidence.id),
    startedAt: input.at,
    deadline: homecomingExecutionDeadline(input.at, input.action),
    milestones: [
      pendingMilestone('preheat', input.operation.id, HOMECOMING_LOGICAL_KEYS.preheat),
      {
        name: 'verified_arrival',
        commandId: null,
        status: 'pending',
        evidenceId: null,
        resolvedAt: null,
        failure: null,
      },
      pendingMilestone(
        'pathway_lighting',
        input.operation.id,
        HOMECOMING_LOGICAL_KEYS.pathwayLighting,
      ),
      pendingMilestone('unlock', input.operation.id, HOMECOMING_LOGICAL_KEYS.unlock),
      pendingMilestone('relock', input.operation.id, HOMECOMING_LOGICAL_KEYS.relock),
    ],
    updatedAt: input.at,
    completedAt: null,
  })
  await input.repositories.executions.insert({
    operationId: input.operation.id,
    execution,
    authorization: input.authorization,
  })
  const effects = await Promise.all(
    planned.map((effect) =>
      materializePlannedGatewayEffect({
        repositories: input.repositories,
        operation: input.operation,
        plan: input.plan,
        planned: effect,
        authorization: input.authorization,
        createdAt: input.at,
        ids: input.ids,
      }),
    ),
  )
  await enqueueExecutionDeadline(input.repositories, execution, input.at, input.ids)
  return { execution, trigger, evidence, effects }
}

export interface PersistedEvidenceApplicationResult {
  readonly execution: Execution
  readonly evidence: PersistedEvidenceRecord
  readonly effects: readonly GatewayEffectMaterializationResult[]
}

export class PersistedEvidenceExecutionService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly planner: ExecutionPlannerPort = new HomecomingExecutionPlanner(),
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
  ) {}

  public apply(input: {
    readonly organizationId: Operation['organizationId']
    readonly operationId: Operation['id']
    readonly evidenceId: EvidenceId
    readonly missionId?: MissionId
    readonly executionId?: ExecutionId
  }): Promise<PersistedEvidenceApplicationResult> {
    return this.unitOfWork.run(input.organizationId, async (repositories) => {
      const snapshot = await loadExecutionSnapshot(repositories, input.operationId)
      if (
        (input.missionId !== undefined && snapshot.operation.missionId !== input.missionId) ||
        (input.executionId !== undefined && snapshot.execution.id !== input.executionId)
      ) {
        throw new ConflictError('Persisted-evidence execution reference is not bound')
      }
      const evidence = await repositories.evidence.get(input.evidenceId)
      if (evidence === null) throw new NotFoundError('Evidence')
      assertEvidenceBinding(evidence, snapshot.operation, snapshot.plan)
      if (
        evidence.authorityReceipt.authority !== 'identity_telemetry' ||
        evidence.evidence.type !== 'identity_arrival'
      ) {
        throw new ConflictError('Only persisted identity telemetry may drive arrival effects')
      }
      if (!evidence.evidence.verified) {
        return { execution: snapshot.execution, evidence, effects: [] }
      }
      if (snapshot.execution.status === 'observed' || snapshot.execution.status === 'failed') {
        return { execution: snapshot.execution, evidence, effects: [] }
      }
      if (
        (await repositories.cancellations.findForMission(snapshot.operation.missionId)) !== null
      ) {
        return { execution: snapshot.execution, evidence, effects: [] }
      }
      const milestone = await repositories.executions.advanceMilestone({
        operationId: snapshot.operation.id,
        milestone: 'verified_arrival',
        commandId: null,
        evidenceId: evidence.evidence.id,
        resolvedAt: evidence.evidence.observedAt,
        failure: null,
      })
      if (milestone === null) throw new NotFoundError('Execution')
      const at = iso(this.clock.now())
      const planned = await this.planner.planEvidence({
        operation: snapshot.operation,
        plan: snapshot.plan,
        action: snapshot.action,
        capabilities: snapshot.capabilities,
        evidence,
        at,
      })
      const effects = await Promise.all(
        planned.map((effect) =>
          materializePlannedGatewayEffect({
            repositories,
            operation: snapshot.operation,
            plan: snapshot.plan,
            planned: effect,
            authorization: snapshot.authorization,
            createdAt: at,
            ids: this.ids,
          }),
        ),
      )
      return { execution: milestone.execution, evidence, effects }
    })
  }
}

/** Queue payloads stay reference-only; durable state is rehydrated and validated before effects. */
export class IdentityArrivalExecutionJobHandler {
  public constructor(private readonly service: Pick<PersistedEvidenceExecutionService, 'apply'>) {}

  public handle(raw: unknown): Promise<PersistedEvidenceApplicationResult> {
    const reference = IdentityArrivalExecutionReferenceSchema.parse(raw)
    return this.service.apply(reference)
  }
}

export async function materializePlannedGatewayEffect(input: {
  readonly repositories: TenantRepositories
  readonly operation: Operation
  readonly plan: Plan
  readonly planned: PlannedGatewayEffect
  readonly authorization: GatewayEffectIntent['authorization']
  readonly createdAt: string
  readonly ids: IdGeneratorPort
}): Promise<GatewayEffectMaterializationResult> {
  const planned = PlannedGatewayEffectSchema.parse(input.planned)
  if (
    input.operation.organizationId !== input.plan.organizationId ||
    input.operation.missionId !== input.plan.missionId ||
    input.operation.planId !== input.plan.id
  ) {
    throw new ConflictError('Gateway effect operation and plan bindings do not match')
  }
  const base = {
    organizationId: input.operation.organizationId,
    missionId: input.operation.missionId,
    palaceId: input.plan.palaceId,
    operationId: input.operation.id,
    logicalKey: planned.logicalKey,
    createdAt: input.createdAt,
  }
  const command =
    planned.kind === 'set_temperature'
      ? createGatewayCommand({ ...base, kind: planned.kind, payload: planned.payload })
      : planned.kind === 'set_lighting'
        ? createGatewayCommand({ ...base, kind: planned.kind, payload: planned.payload })
        : planned.kind === 'unlock'
          ? createGatewayCommand({ ...base, kind: planned.kind, payload: planned.payload })
          : createGatewayCommand({ ...base, kind: planned.kind, payload: planned.payload })
  return input.repositories.gatewayEffects.materialize({
    intent: {
      command,
      dispatchAt: planned.dispatchAt,
      milestone: planned.milestone,
      cancellationPolicy: planned.cancellationPolicy,
      authorization: input.authorization,
      createdAt: input.createdAt,
    },
    dispatchOutboxId: input.ids.next('outbox'),
  })
}

async function loadExecutionSnapshot(
  repositories: TenantRepositories,
  operationId: Operation['id'],
) {
  const operation = await repositories.operations.get(operationId)
  if (operation === null || operation.status !== 'committed' || operation.outcome === null) {
    throw new NotFoundError('Committed operation')
  }
  const plan = await repositories.plans.get(operation.planId)
  if (plan === null) throw new NotFoundError('Plan')
  const action = plan.actions.find((candidate) => candidate.id === operation.planActionId)
  if (action === undefined) throw new NotFoundError('Plan action')
  const storedExecution = await repositories.executions.findForOperation(operation.id)
  if (storedExecution === null) throw new NotFoundError('Execution')
  const capabilities = await repositories.capabilities.list(plan.palaceId)
  return {
    operation,
    plan,
    action,
    execution: storedExecution.execution,
    authorization: storedExecution.authorization,
    capabilities,
  }
}

function activationEvidence(input: {
  readonly operation: Operation
  readonly outcome: NonNullable<Operation['outcome']>
  readonly plan: Plan
  readonly action: PlanAction
  readonly at: string
}): readonly PersistedEvidenceRecord[] {
  if (input.action.type !== 'replace_homecoming_routine') {
    throw new ConflictError('Activation evidence requires a homecoming routine replacement')
  }
  const scope = {
    organizationId: input.operation.organizationId,
    missionId: input.operation.missionId,
    palaceId: input.plan.palaceId,
    observedAt: input.at,
  }
  const activeRoutine = applicationEvidenceRecord({
    operation: input.operation,
    plan: input.plan,
    at: input.at,
    rule: ACTIVATION_APPLICATION_EVIDENCE_RULES.activeRoutine,
    inputEvidenceIds: [],
    evidence: {
      ...scope,
      type: 'routine_state',
      routineId: input.outcome.routineId,
      routineVersionId: input.outcome.routineVersionId,
      active: true,
      planId: input.plan.id,
      planHash: input.plan.hash,
    },
  })
  const protectedRoutineInactive = applicationEvidenceRecord({
    operation: input.operation,
    plan: input.plan,
    at: input.at,
    rule: ACTIVATION_APPLICATION_EVIDENCE_RULES.protectedRoutineInactive,
    inputEvidenceIds: [],
    evidence: {
      ...scope,
      type: 'routine_state',
      routineId: input.action.protectedRoutineId,
      routineVersionId: input.action.protectedRoutineVersionId,
      active: false,
      planId: input.plan.id,
      planHash: input.plan.hash,
    },
  })
  const batteryProjection = applicationEvidenceRecord({
    operation: input.operation,
    plan: input.plan,
    at: input.at,
    rule: ACTIVATION_APPLICATION_EVIDENCE_RULES.batteryProjection,
    inputEvidenceIds: [activeRoutine.evidence.id],
    evidence: {
      ...scope,
      type: 'battery_projection',
      projectedUsePercentagePoints: input.action.replacement.projectedBatteryUsePercentagePoints,
    },
  })
  const tenantBinding = applicationEvidenceRecord({
    operation: input.operation,
    plan: input.plan,
    at: input.at,
    rule: ACTIVATION_APPLICATION_EVIDENCE_RULES.tenantBinding,
    inputEvidenceIds: [activeRoutine.evidence.id, protectedRoutineInactive.evidence.id],
    evidence: {
      ...scope,
      type: 'tenant_access_audit',
      attemptedOrganizationId: input.operation.organizationId,
      allowed: true,
      operationId: input.operation.id,
    },
  })
  return [activeRoutine, protectedRoutineInactive, batteryProjection, tenantBinding]
}

function applicationEvidenceRecord(input: {
  readonly operation: Operation
  readonly plan: Plan
  readonly at: string
  readonly rule: { readonly id: string; readonly version: number }
  readonly inputEvidenceIds: readonly EvidenceId[]
  readonly evidence: ApplicationAuthorityEvidenceWithoutId
}): PersistedEvidenceRecord {
  const evidenceId = stableActivationEvidenceId(input.operation.id, input.rule.id)
  return PersistedEvidenceRecordSchema.parse({
    evidence: { ...input.evidence, id: evidenceId },
    authorityReceipt: {
      id: stableActivationReceiptId(evidenceId, input.rule.id),
      evidenceId,
      organizationId: input.operation.organizationId,
      missionId: input.operation.missionId,
      palaceId: input.plan.palaceId,
      verifiedAt: input.at,
      authority: 'application',
      producer: 'application_code',
      ruleId: input.rule.id,
      ruleVersion: input.rule.version,
      inputEvidenceIds: input.inputEvidenceIds,
      derivationVerified: true,
    },
    persistedAt: input.at,
  })
}

type ApplicationAuthorityEvidenceWithoutId = ApplicationAuthorityEvidence extends infer Evidence
  ? Evidence extends ApplicationAuthorityEvidence
    ? Omit<Evidence, 'id'>
    : never
  : never

function stableActivationEvidenceId(operationId: Operation['id'], ruleId: string): EvidenceId {
  return parseGeneratedId(
    'evidence',
    `evd_${hashCanonical({ schemaVersion: 'activation-evidence-id@1', operationId, ruleId })}`,
  )
}

function stableActivationReceiptId(evidenceId: EvidenceId, ruleId: string) {
  return parseGeneratedId(
    'evidence_authority_receipt',
    `rcp_${hashCanonical({ schemaVersion: 'activation-receipt-id@1', evidenceId, ruleId })}`,
  )
}

function pendingMilestone(
  name: 'pathway_lighting' | 'preheat' | 'relock' | 'unlock',
  operationId: Operation['id'],
  logicalKey: (typeof HOMECOMING_LOGICAL_KEYS)[keyof typeof HOMECOMING_LOGICAL_KEYS],
) {
  return {
    name,
    commandId: deriveGatewayCommandId(operationId, logicalKey),
    status: 'pending' as const,
    evidenceId: null,
    resolvedAt: null,
    failure: null,
  }
}

function assertBindings(operation: Operation, plan: Plan, action: PlanAction): void {
  if (
    operation.organizationId !== plan.organizationId ||
    operation.missionId !== plan.missionId ||
    operation.planId !== plan.id ||
    operation.planActionId !== action.id ||
    action.palaceId !== plan.palaceId
  ) {
    throw new ConflictError('Execution operation, plan, and action bindings do not match')
  }
  if (
    action.type !== 'replace_homecoming_routine' ||
    operation.outcome === null ||
    operation.outcome.routineId !== action.replacementRoutineId ||
    operation.outcome.routineVersionId !== action.replacementRoutineVersionId ||
    operation.outcome.deactivatedRoutineId !== action.protectedRoutineId
  ) {
    throw new ConflictError('Activation outcome does not match the approved replacement action')
  }
}

function assertEvidenceBinding(
  record: PersistedEvidenceRecord,
  operation: Operation,
  plan: Plan,
): void {
  if (
    record.evidence.organizationId !== operation.organizationId ||
    record.evidence.missionId !== operation.missionId ||
    record.evidence.palaceId !== plan.palaceId ||
    record.authorityReceipt.organizationId !== operation.organizationId ||
    record.authorityReceipt.missionId !== operation.missionId ||
    record.authorityReceipt.palaceId !== plan.palaceId
  ) {
    throw new ConflictError('Persisted evidence does not belong to the execution')
  }
}

async function enqueueExecutionDeadline(
  repositories: TenantRepositories,
  execution: Execution,
  createdAt: string,
  ids: IdGeneratorPort,
): Promise<void> {
  const deduplicationKey = `execution.deadline:${execution.id}`
  const message: OutboxMessage = {
    id: ids.next('outbox'),
    organizationId: execution.organizationId,
    topic: 'execution.deadline',
    deduplicationKey,
    payload: {
      organizationId: execution.organizationId,
      missionId: execution.missionId,
      operationId: execution.operationId,
      executionId: execution.id,
    },
    status: 'pending',
    availableAt: execution.deadline,
    createdAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
  await repositories.outbox.insert(message)
}
