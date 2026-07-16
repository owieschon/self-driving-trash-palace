import {
  assertPermission,
  assertSameTenant,
  type Approval,
  type ClarificationAnswer,
  type ClarificationRequest,
  type Mission,
  type Plan,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import type { AuthContext } from './models.js'
import type { UnitOfWorkPort } from './ports.js'

export interface HumanApprovalTask {
  readonly approval: Approval
  readonly plan: Plan
  readonly mission: Mission
}

export interface HumanClarificationTask {
  readonly request: ClarificationRequest
  readonly answer: ClarificationAnswer | null
  readonly mission: Mission
}

export interface HumanMissionTaskInbox {
  readonly mission: Mission
  readonly clarification: ClarificationRequest | null
  readonly approval: Approval | null
}

/** Loads only tenant-bound human decision tasks; mutation authority remains in domain services. */
export class HumanTaskService {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public async getMissionTasks(
    context: AuthContext,
    missionId: Mission['id'],
  ): Promise<HumanMissionTaskInbox> {
    assertHuman(context)
    assertPermission(context.principal, 'routine:draft')
    const organizationId = context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const mission = await repositories.missions.get(missionId)
      if (mission === null) throw new NotFoundError('Mission')
      assertSameTenant(organizationId, [mission.organizationId])

      const clarification = await repositories.clarifications.findPendingForMission(mission.id)
      const plan = await repositories.plans.getLatestForMission(mission.id)
      const approval = plan === null ? null : await repositories.approvals.findForPlan(plan.id)
      const pendingApproval = approval?.status === 'pending' ? approval : null

      if (clarification !== null) {
        assertSameTenant(organizationId, [clarification.organizationId])
        if (clarification.missionId !== mission.id) {
          throw new ConflictError('Clarification task has inconsistent mission bindings')
        }
      }
      if (plan !== null) {
        assertSameTenant(organizationId, [plan.organizationId])
        if (plan.missionId !== mission.id) {
          throw new ConflictError('Plan has inconsistent mission bindings')
        }
      }
      if (pendingApproval !== null) {
        assertSameTenant(organizationId, [pendingApproval.organizationId])
        if (
          plan === null ||
          pendingApproval.planId !== plan.id ||
          pendingApproval.missionId !== mission.id
        ) {
          throw new ConflictError('Approval task has inconsistent mission bindings')
        }
      }
      if (clarification !== null && pendingApproval !== null) {
        throw new ConflictError('Mission cannot expose two pending human decisions')
      }

      return { mission, clarification, approval: pendingApproval }
    })
  }

  public async getApproval(
    context: AuthContext,
    approvalId: Approval['id'],
  ): Promise<HumanApprovalTask> {
    assertHuman(context)
    assertPermission(context.principal, 'routine:approve')
    const organizationId = context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const approval = await repositories.approvals.get(approvalId)
      if (approval === null) throw new NotFoundError('Approval')
      const plan = await repositories.plans.get(approval.planId)
      const mission = await repositories.missions.get(approval.missionId)
      if (plan === null || mission === null) throw new NotFoundError('Approval task')
      assertSameTenant(organizationId, [
        approval.organizationId,
        plan.organizationId,
        mission.organizationId,
      ])
      if (plan.missionId !== mission.id || approval.missionId !== mission.id) {
        throw new ConflictError('Approval task has inconsistent mission bindings')
      }
      return { approval, plan, mission }
    })
  }

  public async getClarification(
    context: AuthContext,
    requestId: ClarificationRequest['id'],
  ): Promise<HumanClarificationTask> {
    assertHuman(context)
    assertPermission(context.principal, 'routine:draft')
    const organizationId = context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const request = await repositories.clarifications.getRequest(requestId)
      if (request === null) throw new NotFoundError('Clarification request')
      const mission = await repositories.missions.get(request.missionId)
      if (mission === null) throw new NotFoundError('Clarification mission')
      assertSameTenant(organizationId, [request.organizationId, mission.organizationId])
      const answer = await repositories.clarifications.getAnswerForRequest(request.id)
      if (
        answer !== null &&
        (answer.organizationId !== organizationId ||
          answer.missionId !== mission.id ||
          answer.requestId !== request.id)
      ) {
        throw new ConflictError('Clarification answer has inconsistent task bindings')
      }
      return { request, answer, mission }
    })
  }
}

function assertHuman(context: AuthContext): void {
  if (!['owner', 'operator'].includes(context.principal.role)) {
    throw new ConflictError('Only an authenticated human owner or operator may view this task')
  }
}
