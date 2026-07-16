import {
  ApprovalSchema,
  OperationSchema,
  PlanSchema,
  assertPermission,
  assertSameTenant,
  isRoutineReplacementAction,
  type Approval,
  type Mission,
  type Operation,
  type Plan,
  type PlanId,
  type ProtectedResourceVersion,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import { enqueueMissionResume } from './mission-resume.js'
import type { AuthContext } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import {
  CryptoEntropy,
  CryptoIdGenerator,
  SYSTEM_CLOCK,
  addMilliseconds,
  hashCanonical,
  iso,
  parseGeneratedId,
} from './primitives.js'
import { enqueueApplicationProductEvidence } from './product-evidence.js'
import type {
  ClockPort,
  EntropyPort,
  IdGeneratorPort,
  MissionExecutionUnitOfWorkPort,
  SensitiveMutationGuardPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export type ApprovalDecisionResult =
  | Readonly<{
      status: 'approved'
      approval: Approval
      operations: readonly Operation[]
      mission: Mission
    }>
  | Readonly<{ status: 'rejected'; approval: Approval; operations: readonly []; mission: Mission }>
  | Readonly<{
      status: 'expired' | 'stale'
      approval: Approval
      operations: readonly []
      mission: Mission
    }>

export class ApprovalService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly mutationGuard: SensitiveMutationGuardPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly entropy: EntropyPort = new CryptoEntropy(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort | null = null,
  ) {}

  public async request(input: {
    readonly context: AuthContext | MissionExecutionContext
    readonly planId: PlanId
  }): Promise<Approval> {
    assertPermission(input.context.principal, 'routine:draft')
    const organizationId = input.context.principal.organizationId
    const work = async (repositories: TenantRepositories): Promise<Approval> => {
      const plan = await requirePlan(repositories, input.planId)
      const mission = await requireMission(repositories, plan.missionId)
      assertSameTenant(organizationId, [plan.organizationId, mission.organizationId])
      if ('fence' in input.context && input.context.fence.missionId !== mission.id) {
        throw new ConflictError('Mission fence does not authorize this approval request')
      }
      if (plan.status !== 'validated') {
        throw new ConflictError('Approval requests require a validated plan')
      }
      const validation = await repositories.planAssessments.getValidation(plan.id)
      const simulations = await repositories.planAssessments.listSimulations(plan.id)
      if (
        validation?.valid !== true ||
        simulations.length === 0 ||
        simulations.some((item) => !item.feasible)
      ) {
        throw new ConflictError(
          'Approval requests require passing validation and simulation evidence',
        )
      }
      if (mission.state.status !== 'running' || mission.state.phase !== 'validate') {
        throw new ConflictError('Mission is not at the approval request checkpoint')
      }
      if ((await repositories.approvals.findForPlan(plan.id)) !== null) {
        throw new ConflictError('Plan already has an approval request')
      }
      const protectedResources = await protectedResourcesFor(repositories, plan)
      const now = this.clock.now()
      const approval = ApprovalSchema.parse({
        id: parseGeneratedId('approval', this.ids.next('approval')),
        organizationId,
        missionId: mission.id,
        planId: plan.id,
        planHash: plan.hash,
        status: 'pending',
        actionIds: plan.actions.map((action) => action.id),
        protectedResources,
        requestedBy: input.context.principal.actorId,
        approvedBy: null,
        approverRole: null,
        nonce: this.entropy.token(24),
        createdAt: iso(now),
        approvedAt: null,
        expiresAt: iso(addMilliseconds(now, 15 * 60 * 1_000)),
      })
      await repositories.approvals.insert(approval)
      await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'awaiting_approval' }))
      await persistMissionTransition({
        repositories,
        mission,
        expectedVersion: mission.version,
        event: 'validation_passed',
        clock: this.clock,
        ids: this.ids,
      })
      return approval
    }
    if ('sessionId' in input.context) {
      return this.unitOfWork.run(organizationId, work)
    }
    if (!('fence' in input.context)) {
      throw new ConflictError('Caretaker approval request requires an execution context')
    }
    assertMissionExecutionContext(input.context, {
      organizationId,
      missionId: input.context.fence.missionId,
    })
    if (this.missionUnitOfWork === null) {
      throw new ConflictError('Caretaker approval request requires a fenced unit of work')
    }
    return this.missionUnitOfWork.runFenced(input.context.fence, work)
  }

  public async decide(input: {
    readonly context: AuthContext
    readonly approvalId: Approval['id']
    readonly nonce: string
    readonly decision: 'approve' | 'reject'
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<ApprovalDecisionResult> {
    this.mutationGuard.assert(input)
    assertPermission(input.context.principal, 'routine:approve')
    if (!['owner', 'operator'].includes(input.context.principal.role)) {
      throw new ConflictError('Only an authenticated human owner or operator may approve')
    }
    const organizationId = input.context.principal.organizationId
    const result: ApprovalDecisionResult = await this.observability.trace(
      {
        name: 'domain.approval.decide',
        kind: 'domain',
        correlation: { organizationId },
        attributes: { decision: input.decision },
      },
      () =>
        this.unitOfWork.run(organizationId, async (repositories) => {
          const approval = await repositories.approvals.get(input.approvalId)
          if (approval === null) throw new NotFoundError('Approval')
          const plan = await requirePlan(repositories, approval.planId)
          const mission = await requireMission(repositories, approval.missionId)
          assertSameTenant(organizationId, [
            approval.organizationId,
            plan.organizationId,
            mission.organizationId,
          ])
          if (approval.status !== 'pending') {
            throw new ConflictError('Approval request is no longer pending')
          }
          if (approval.nonce !== input.nonce)
            throw new ConflictError('Approval nonce does not match')

          const now = iso(this.clock.now())
          if (Date.parse(now) >= Date.parse(approval.expiresAt)) {
            return this.#invalidate(repositories, approval, plan, mission, 'expired')
          }
          if (!(await protectedResourcesAreCurrent(repositories, approval.protectedResources))) {
            return this.#invalidate(repositories, approval, plan, mission, 'stale')
          }
          if (input.decision === 'reject') {
            const rejected = ApprovalSchema.parse({ ...approval, status: 'rejected' })
            await repositories.approvals.save(rejected)
            await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'rejected' }))
            const nextMission = await persistMissionTransition({
              repositories,
              mission,
              expectedVersion: mission.version,
              event: 'approval_rejected',
              clock: this.clock,
              ids: this.ids,
            })
            await enqueueMissionResume(repositories, nextMission, this.ids)
            return { status: 'rejected', approval: rejected, operations: [], mission: nextMission }
          }

          const approved = ApprovalSchema.parse({
            ...approval,
            status: 'approved',
            approvedBy: input.context.principal.actorId,
            approverRole: input.context.principal.role,
            approvedAt: now,
          })
          await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'approved' }))
          await repositories.approvals.save(approved)
          const operations: Operation[] = []
          for (const action of plan.actions) {
            if ((await repositories.operations.findByPlanAction(plan.id, action.id)) !== null) {
              throw new ConflictError('Plan action already has a logical operation')
            }
            const operation = OperationSchema.parse({
              id: parseGeneratedId('operation', this.ids.next('operation')),
              organizationId,
              missionId: mission.id,
              planId: plan.id,
              planActionId: action.id,
              approvalId: approved.id,
              payloadHash: hashCanonical({ planHash: plan.hash, action }),
              serverCreated: true,
              status: 'pending',
              outcome: null,
              createdAt: now,
              committedAt: null,
            })
            await repositories.operations.insert(operation)
            operations.push(operation)
          }
          const nextMission = await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: 'approval_granted',
            clock: this.clock,
            ids: this.ids,
          })
          await enqueueMissionResume(repositories, nextMission, this.ids)
          const correlation = {
            distinctId: nextMission.initiatedBy,
            actorId: input.context.principal.actorId,
            organizationId,
            palaceId: nextMission.palaceId,
            missionId: nextMission.id,
            ...(nextMission.runId === null ? {} : { runId: nextMission.runId }),
            planId: plan.id,
          }
          await enqueueApplicationProductEvidence(repositories, this.observability, {
            event: 'plan approved',
            durableIdentity: { approvalId: approved.id },
            occurredAt: now,
            correlation,
            properties: {
              plan_revision: plan.revision,
              approval_surface: 'api',
            },
          })
          for (const operation of operations) {
            const action = plan.actions.find((candidate) => candidate.id === operation.planActionId)
            if (action === undefined) {
              throw new ConflictError('Approved operation lacks its plan action')
            }
            await enqueueApplicationProductEvidence(repositories, this.observability, {
              event: 'operation requested',
              durableIdentity: { operationId: operation.id },
              occurredAt: operation.createdAt,
              correlation: { ...correlation, operationId: operation.id },
              properties: { operation_kind: action.type },
            })
          }
          return { status: 'approved', approval: approved, operations, mission: nextMission }
        }),
    )
    return result
  }

  async #invalidate(
    repositories: TenantRepositories,
    approval: Approval,
    plan: Plan,
    mission: Mission,
    reason: 'expired' | 'stale',
  ): Promise<ApprovalDecisionResult> {
    const invalid = ApprovalSchema.parse({
      ...approval,
      status: reason === 'expired' ? 'expired' : 'invalidated',
    })
    await repositories.approvals.save(invalid)
    await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'superseded' }))
    const nextMission = await persistMissionTransition({
      repositories,
      mission,
      expectedVersion: mission.version,
      event: 'approval_expired_or_stale',
      clock: this.clock,
      ids: this.ids,
    })
    await enqueueMissionResume(repositories, nextMission, this.ids)
    return { status: reason, approval: invalid, operations: [], mission: nextMission }
  }
}

async function protectedResourcesFor(
  repositories: TenantRepositories,
  plan: Plan,
): Promise<readonly ProtectedResourceVersion[]> {
  const resources: ProtectedResourceVersion[] = []
  for (const action of plan.actions) {
    if (isRoutineReplacementAction(action)) {
      resources.push({
        routineId: action.protectedRoutineId,
        routineVersionId: action.protectedRoutineVersionId,
        version: action.expectedProtectedVersion,
      })
    } else {
      const current = await repositories.routines.getCurrentVersion(action.routineId)
      if (current === null || current.version !== action.expectedCurrentVersion) {
        throw new ConflictError('Restore action does not pin the current routine version')
      }
      resources.push(current)
    }
  }
  return resources
}

async function protectedResourcesAreCurrent(
  repositories: TenantRepositories,
  protectedResources: readonly ProtectedResourceVersion[],
): Promise<boolean> {
  for (const expected of protectedResources) {
    const current = await repositories.routines.getCurrentVersion(expected.routineId)
    if (
      current === null ||
      current.routineVersionId !== expected.routineVersionId ||
      current.version !== expected.version
    ) {
      return false
    }
  }
  return true
}

async function requirePlan(repositories: TenantRepositories, planId: PlanId): Promise<Plan> {
  const plan = await repositories.plans.get(planId)
  if (plan === null) throw new NotFoundError('Plan')
  return plan
}

async function requireMission(
  repositories: TenantRepositories,
  missionId: Mission['id'],
): Promise<Mission> {
  const mission = await repositories.missions.get(missionId)
  if (mission === null) throw new NotFoundError('Mission')
  return mission
}
