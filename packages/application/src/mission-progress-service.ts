import {
  assertPermission,
  assertSameTenant,
  missionProgramKindOf,
  type Mission,
  type MissionId,
  type MissionProgramKind,
  type Operation,
  type Verification,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import type { AuthContext, StoredExecution } from './models.js'
import type {
  ApprovalRepository,
  AttemptRepository,
  ClarificationRepository,
  ClockPort,
  PlanRepository,
  UnitOfWorkPort,
} from './ports.js'

export type MissionDisplayState =
  | 'working'
  | 'needs_input'
  | 'needs_approval'
  | 'applying'
  | 'checking_result'
  | 'verified'
  | 'failed'
  | 'cancelled'

export type MissionProgressAction =
  'answer_clarification' | 'approve_proposal' | 'reject_proposal' | 'view_activity'

export interface MissionProgressProjection {
  readonly schemaVersion: 'mission-progress@1'
  readonly mission: {
    readonly id: MissionId
    readonly palaceId: string
    readonly organizationId: string
    readonly programKind: MissionProgramKind | null
    readonly objective: string
    readonly state: Mission['state']
    readonly version: number
  }
  readonly displayState: MissionDisplayState
  readonly pendingTask:
    | Readonly<{ readonly kind: 'clarification'; readonly requestId: string }>
    | Readonly<{
        readonly kind: 'approval'
        readonly approvalId: string
        readonly planId: string
        readonly expiresAt: string
      }>
    | null
  readonly operation: Readonly<{
    readonly id: string
    readonly missionId: MissionId
    readonly status: Operation['status']
  }> | null
  readonly verification: Readonly<{
    readonly id: string
    readonly missionId: MissionId
    readonly status: Verification['status']
    readonly completedAt: string
    readonly summary: string
  }> | null
  readonly allowedNextActions: readonly MissionProgressAction[]
  readonly observedAt: string
}

/** Maps durable mission records to browser display state without adding a second lifecycle. */
export class MissionProgressService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly observationClock: ClockPort,
  ) {}

  public async get(input: {
    readonly context: AuthContext
    readonly missionId: MissionId
  }): Promise<MissionProgressProjection> {
    assertPermission(input.context.principal, 'palace:read')
    const organizationId = input.context.principal.organizationId

    return this.unitOfWork.run(organizationId, async (repositories) => {
      const mission = await repositories.missions.get(input.missionId)
      if (mission === null) throw new NotFoundError('Mission')
      assertSameTenant(organizationId, [mission.organizationId])

      const [clarification, plan, operations, storedExecutions, verification] = await Promise.all([
        repositories.clarifications.findPendingForMission(mission.id),
        repositories.plans.getLatestForMission(mission.id),
        repositories.operations.listForMission(mission.id),
        repositories.executions.listForMission(mission.id),
        repositories.verifications.findForMission(mission.id),
      ])
      const approval = plan === null ? null : await repositories.approvals.findForPlan(plan.id)
      const operation = latestOperation(operations)
      const attempts =
        operation === null ? [] : await repositories.attempts.listForOperation(operation.id)

      assertProgressIntegrity({
        organizationId,
        mission,
        clarification,
        plan,
        approval,
        operations,
        storedExecutions,
        verification,
        attempts,
      })

      const pendingTask = pendingTaskFor({ clarification, plan, approval })
      const execution = executionForOperation(storedExecutions, operation)
      const displayState = displayStateFor({
        mission,
        pendingTask,
        operation,
        attempts,
        execution,
        verification,
      })

      return {
        schemaVersion: 'mission-progress@1',
        mission: {
          id: mission.id,
          palaceId: mission.palaceId,
          organizationId: mission.organizationId,
          programKind: missionProgramKindOf(mission),
          objective: mission.objective,
          state: mission.state,
          version: mission.version,
        },
        displayState,
        pendingTask,
        operation:
          operation === null
            ? null
            : { id: operation.id, missionId: operation.missionId, status: operation.status },
        verification:
          verification === null
            ? null
            : {
                id: verification.id,
                missionId: verification.missionId,
                status: verification.status,
                completedAt: verification.completedAt,
                summary: verificationSummary(verification),
              },
        allowedNextActions: actionsFor(displayState),
        observedAt: this.observationClock.now().toISOString(),
      }
    })
  }
}

function assertProgressIntegrity(input: {
  readonly organizationId: string
  readonly mission: Mission
  readonly clarification: Awaited<ReturnType<ClarificationRepository['findPendingForMission']>>
  readonly plan: Awaited<ReturnType<PlanRepository['getLatestForMission']>>
  readonly approval: Awaited<ReturnType<ApprovalRepository['findForPlan']>>
  readonly operations: readonly Operation[]
  readonly storedExecutions: readonly StoredExecution[]
  readonly verification: Verification | null
  readonly attempts: Awaited<ReturnType<AttemptRepository['listForOperation']>>
}): void {
  const { mission } = input
  assertSameTenant(input.organizationId, [
    mission.organizationId,
    ...(input.clarification === null ? [] : [input.clarification.organizationId]),
    ...(input.plan === null ? [] : [input.plan.organizationId]),
    ...(input.approval === null ? [] : [input.approval.organizationId]),
    ...input.operations.map((operation) => operation.organizationId),
    ...input.storedExecutions.map((stored) => stored.execution.organizationId),
    ...(input.verification === null ? [] : [input.verification.organizationId]),
    ...input.attempts.map((attempt) => attempt.organizationId),
  ])
  if (
    (input.clarification !== null && input.clarification.missionId !== mission.id) ||
    (input.plan !== null &&
      (input.plan.missionId !== mission.id || input.plan.palaceId !== mission.palaceId)) ||
    (input.approval !== null &&
      (input.plan === null ||
        input.approval.missionId !== mission.id ||
        input.approval.planId !== input.plan.id)) ||
    input.operations.some((operation) => operation.missionId !== mission.id) ||
    input.storedExecutions.some(
      (stored) =>
        stored.execution.missionId !== mission.id ||
        !input.operations.some((operation) => operation.id === stored.operationId),
    ) ||
    (input.verification !== null && input.verification.missionId !== mission.id)
  ) {
    throw new ConflictError('Mission progress records have inconsistent bindings')
  }
  const operationIds = new Set(input.operations.map((operation) => operation.id))
  if (input.attempts.some((attempt) => !operationIds.has(attempt.operationId))) {
    throw new ConflictError('Mission progress attempts do not belong to the selected operation')
  }
}

function pendingTaskFor(input: {
  readonly clarification: Awaited<ReturnType<ClarificationRepository['findPendingForMission']>>
  readonly plan: Awaited<ReturnType<PlanRepository['getLatestForMission']>>
  readonly approval: Awaited<ReturnType<ApprovalRepository['findForPlan']>>
}): MissionProgressProjection['pendingTask'] {
  const clarification = input.clarification?.status === 'pending' ? input.clarification : null
  const approval = input.approval?.status === 'pending' ? input.approval : null
  if (clarification !== null && approval !== null) {
    throw new ConflictError('Mission progress cannot expose two pending human decisions')
  }
  if (clarification !== null) return { kind: 'clarification', requestId: clarification.id }
  if (approval !== null) {
    if (input.plan === null) throw new ConflictError('Pending approval requires its plan')
    return {
      kind: 'approval',
      approvalId: approval.id,
      planId: input.plan.id,
      expiresAt: approval.expiresAt,
    }
  }
  return null
}

function latestOperation(operations: readonly Operation[]): Operation | null {
  return (
    [...operations].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )[0] ?? null
  )
}

function executionForOperation(
  executions: readonly StoredExecution[],
  operation: Operation | null,
): StoredExecution | null {
  if (operation === null) return null
  const matching = executions.filter((stored) => stored.operationId === operation.id)
  if (matching.length > 1)
    throw new ConflictError('Operation has more than one execution projection')
  return matching[0] ?? null
}

function displayStateFor(input: {
  readonly mission: Mission
  readonly pendingTask: MissionProgressProjection['pendingTask']
  readonly operation: Operation | null
  readonly attempts: readonly { readonly status: 'pending' | 'succeeded' | 'unknown' | 'failed' }[]
  readonly execution: StoredExecution | null
  readonly verification: Verification | null
}): MissionDisplayState {
  if (input.mission.state.status === 'cancelled') return 'cancelled'
  if (input.verification?.status === 'passed') return 'verified'
  if (input.verification?.status === 'failed' || input.mission.state.status === 'failed')
    return 'failed'
  if (input.pendingTask?.kind === 'clarification') return 'needs_input'
  if (input.pendingTask?.kind === 'approval') return 'needs_approval'
  if (input.operation?.status === 'failed' || input.execution?.execution.status === 'failed') {
    return 'failed'
  }
  if (input.operation?.status === 'cancelled') return 'cancelled'
  // A lost or unknown transport outcome remains under reconciliation, never becomes a success claim.
  if (input.attempts.some((attempt) => attempt.status === 'unknown')) return 'checking_result'
  if (input.operation?.status === 'claimed') return 'applying'
  if (
    input.operation !== null ||
    input.execution !== null ||
    input.mission.state.status === 'succeeded' ||
    input.mission.state.status === 'waiting_for_system' ||
    input.mission.state.status === 'waiting_for_user'
  ) {
    return 'checking_result'
  }
  return 'working'
}

function actionsFor(state: MissionDisplayState): readonly MissionProgressAction[] {
  switch (state) {
    case 'needs_input':
      return ['answer_clarification']
    case 'needs_approval':
      return ['approve_proposal', 'reject_proposal']
    case 'applying':
      return []
    default:
      return ['view_activity']
  }
}

function verificationSummary(verification: Verification): string {
  const failed = verification.assertions.filter((assertion) => !assertion.passed).length
  return verification.status === 'passed'
    ? `Verification passed ${verification.assertions.length} retained assertions.`
    : `Verification failed ${failed} of ${verification.assertions.length} retained assertions.`
}
