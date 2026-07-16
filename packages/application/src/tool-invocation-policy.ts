import {
  ExecutionsListInputSchema,
  KnowledgeSearchInputSchema,
  MissionsCancelInputSchema,
  OperationsGetInputSchema,
  PalaceIdSchema,
  PlansActivateInputSchema,
  PlansProposeInputSchema,
  PlansRequestApprovalInputSchema,
  PlansSimulateInputSchema,
  PlansValidateInputSchema,
  RoutinesGetInputSchema,
  TOOL_REGISTRY,
  VerificationGetEvidenceInputSchema,
  type Mission,
  type MissionId,
  type OrganizationId,
  type ToolInput,
  type ToolName,
} from '@trash-palace/core'

import { NotFoundError } from './errors.js'
import type { UnitOfWorkPort } from './ports.js'

export class ToolMissionPhaseDeniedError extends Error {
  override readonly name = 'ToolMissionPhaseDeniedError'
}

export interface ToolInvocationPolicyPort {
  authorize<Name extends ToolName>(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly toolName: Name
    readonly toolInput: ToolInput<Name>
  }): Promise<Mission>
}

export class RepositoryToolInvocationPolicy implements ToolInvocationPolicyPort {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public authorize<Name extends ToolName>(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly toolName: Name
    readonly toolInput: ToolInput<Name>
  }): Promise<Mission> {
    return this.unitOfWork.run(input.organizationId, async (repositories) => {
      const mission = await repositories.missions.get(input.missionId)
      if (mission === null || mission.organizationId !== input.organizationId) unavailable()
      if (!TOOL_REGISTRY[input.toolName].allowedPhases.includes(mission.state.phase)) {
        throw new ToolMissionPhaseDeniedError('Tool is unavailable at the current mission phase')
      }

      switch (input.toolName) {
        case 'palaces.get':
        case 'crews.list':
        case 'capabilities.list':
        case 'routines.list': {
          const palaceId = PalaceIdSchema.parse(
            (input.toolInput as Readonly<Record<string, unknown>>).palaceId,
          )
          if (palaceId !== mission.palaceId) unavailable()
          break
        }
        case 'routines.get': {
          const query = RoutinesGetInputSchema.parse(input.toolInput)
          const routine = await repositories.routines.get(query.routineId, query.versionId)
          if (
            routine === null ||
            routine.routine.organizationId !== input.organizationId ||
            routine.routine.palaceId !== mission.palaceId
          ) {
            unavailable()
          }
          break
        }
        case 'executions.list': {
          const query = ExecutionsListInputSchema.parse(input.toolInput)
          if (query.missionId !== undefined && query.missionId !== mission.id) unavailable()
          if (query.routineId !== undefined) {
            const routine = await repositories.routines.get(query.routineId)
            if (
              routine === null ||
              routine.routine.organizationId !== input.organizationId ||
              routine.routine.palaceId !== mission.palaceId
            ) {
              unavailable()
            }
          }
          break
        }
        case 'knowledge.search': {
          const query = KnowledgeSearchInputSchema.parse(input.toolInput)
          if (query.phase !== mission.state.phase) {
            throw new ToolMissionPhaseDeniedError(
              'Knowledge phase must match the current mission phase',
            )
          }
          break
        }
        case 'plans.propose': {
          const query = PlansProposeInputSchema.parse(input.toolInput)
          if (query.missionId !== mission.id) unavailable()
          break
        }
        case 'verification.get_evidence': {
          const query = VerificationGetEvidenceInputSchema.parse(input.toolInput)
          if (query.missionId !== mission.id) unavailable()
          break
        }
        case 'missions.cancel': {
          const query = MissionsCancelInputSchema.parse(input.toolInput)
          if (query.missionId !== mission.id) unavailable()
          break
        }
        case 'plans.validate': {
          const query = PlansValidateInputSchema.parse(input.toolInput)
          const plan = await repositories.plans.get(query.planId)
          if (
            plan === null ||
            plan.organizationId !== input.organizationId ||
            plan.missionId !== mission.id
          ) {
            unavailable()
          }
          break
        }
        case 'plans.simulate': {
          const query = PlansSimulateInputSchema.parse(input.toolInput)
          const plan = await repositories.plans.get(query.planId)
          if (
            plan === null ||
            plan.organizationId !== input.organizationId ||
            plan.missionId !== mission.id
          ) {
            unavailable()
          }
          break
        }
        case 'plans.request_approval': {
          const query = PlansRequestApprovalInputSchema.parse(input.toolInput)
          const plan = await repositories.plans.get(query.planId)
          if (
            plan === null ||
            plan.organizationId !== input.organizationId ||
            plan.missionId !== mission.id
          ) {
            unavailable()
          }
          break
        }
        case 'plans.activate': {
          const query = PlansActivateInputSchema.parse(input.toolInput)
          const plan = await repositories.plans.get(query.planId)
          if (
            plan === null ||
            plan.organizationId !== input.organizationId ||
            plan.missionId !== mission.id
          ) {
            unavailable()
          }
          break
        }
        case 'operations.get': {
          const query = OperationsGetInputSchema.parse(input.toolInput)
          const operation = await repositories.operations.get(query.operationId)
          if (
            operation === null ||
            operation.organizationId !== input.organizationId ||
            operation.missionId !== mission.id
          ) {
            unavailable()
          }
          break
        }
      }

      return mission
    })
  }
}

function unavailable(): never {
  throw new NotFoundError('Resource')
}
