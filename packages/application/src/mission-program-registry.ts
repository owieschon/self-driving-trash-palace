import {
  missionProgramKindOf,
  type Mission,
  type MissionProgramKind,
  type Plan,
  type PlanAction,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'
import {
  ApprovedPlanDeterministicVerifier,
  HOMECOMING_VERIFICATION_CRITERIA,
  type HomecomingVerificationTimingPolicy,
} from './deterministic-verifier.js'
import { HomecomingExecutionPlanner } from './homecoming-execution-planner.js'
import { HomecomingPlanSimulator, HomecomingPlanValidator } from './homecoming-plan-assessment.js'
import {
  HAULER_VERIFICATION_CRITERIA,
  ScheduledHaulerAccessDeterministicVerifier,
} from './scheduled-hauler-access-verifier.js'
import { ScheduledHaulerAccessExecutionPlanner } from './scheduled-hauler-access-execution-planner.js'
import {
  ScheduledHaulerAccessPlanSimulator,
  ScheduledHaulerAccessPlanValidator,
} from './scheduled-hauler-access-plan-assessment.js'
import type {
  DeterministicVerifierPort,
  ExecutionPlannerPort,
  PlanSimulatorPort,
  PlanValidatorPort,
  UnitOfWorkPort,
} from './ports.js'

export interface MissionProgram {
  readonly kind: MissionProgramKind
  readonly actionType: PlanAction['type']
  readonly validator: PlanValidatorPort
  readonly simulator: PlanSimulatorPort
  readonly executionPlanner: ExecutionPlannerPort
  readonly verifier: DeterministicVerifierPort
  readonly contextSourceIds: readonly string[]
  readonly verificationCriteria: readonly string[]
}

export function createProductionMissionProgramRegistry(
  unitOfWork: UnitOfWorkPort,
  homecomingTiming?: HomecomingVerificationTimingPolicy,
): MissionProgramRegistry {
  return new MissionProgramRegistry([
    {
      kind: 'night_shift_homecoming',
      actionType: 'replace_homecoming_routine',
      validator: new HomecomingPlanValidator(unitOfWork),
      simulator: new HomecomingPlanSimulator(),
      executionPlanner: new HomecomingExecutionPlanner(),
      verifier: new ApprovedPlanDeterministicVerifier(homecomingTiming),
      contextSourceIds: [
        'skill.homecoming.planning',
        'skill.homecoming.simulation',
        'policy.shared.approval',
        'policy.shared.reconciliation',
        'policy.shared.verification',
      ],
      verificationCriteria: HOMECOMING_VERIFICATION_CRITERIA,
    },
    {
      kind: 'scheduled_hauler_access',
      actionType: 'replace_scheduled_hauler_access_routine',
      validator: new ScheduledHaulerAccessPlanValidator(unitOfWork),
      simulator: new ScheduledHaulerAccessPlanSimulator(),
      executionPlanner: new ScheduledHaulerAccessExecutionPlanner(),
      verifier: new ScheduledHaulerAccessDeterministicVerifier(),
      contextSourceIds: [
        'skill.hauler-access.planning',
        'skill.hauler-access.simulation',
        'policy.shared.approval',
        'policy.shared.reconciliation',
        'policy.shared.verification',
      ],
      verificationCriteria: HAULER_VERIFICATION_CRITERIA,
    },
  ])
}

export class MissionProgramRegistry
  implements PlanValidatorPort, PlanSimulatorPort, ExecutionPlannerPort, DeterministicVerifierPort
{
  readonly #byKind: ReadonlyMap<MissionProgramKind, MissionProgram>
  readonly #byAction: ReadonlyMap<PlanAction['type'], MissionProgram>

  public constructor(programs: readonly MissionProgram[]) {
    if (programs.length === 0) throw new ConflictError('Mission program registry cannot be empty')
    const byKind = new Map<MissionProgramKind, MissionProgram>()
    const byAction = new Map<PlanAction['type'], MissionProgram>()
    for (const program of programs) {
      if (byKind.has(program.kind)) {
        throw new ConflictError(`Duplicate mission program kind ${program.kind}`)
      }
      if (byAction.has(program.actionType)) {
        throw new ConflictError(`Duplicate mission program action ${program.actionType}`)
      }
      if (program.actionType === 'restore_routine_version') {
        throw new ConflictError('Compensating restoration is not a primary mission program')
      }
      byKind.set(program.kind, Object.freeze(program))
      byAction.set(program.actionType, program)
    }
    this.#byKind = byKind
    this.#byAction = byAction
  }

  public get(kind: MissionProgramKind): MissionProgram {
    const program = this.#byKind.get(kind)
    if (program === undefined) throw new ConflictError(`Unknown mission program ${kind}`)
    return program
  }

  public forMission(mission: Mission): MissionProgram {
    return this.get(missionProgramKindOf(mission))
  }

  public forPlan(plan: Plan): MissionProgram {
    if (plan.actions.length !== 1 || plan.actions[0] === undefined) {
      throw new ConflictError('A primary automation plan requires one consequential action')
    }
    const program = this.#byAction.get(plan.actions[0].type)
    if (program === undefined) {
      throw new ConflictError(`No mission program owns action ${plan.actions[0].type}`)
    }
    return program
  }

  public assertMissionPlanBinding(mission: Mission, plan: Plan): MissionProgram {
    const missionProgram = this.forMission(mission)
    const planProgram = this.forPlan(plan)
    if (missionProgram !== planProgram) {
      throw new ConflictError('Mission program and approved plan action do not match')
    }
    return missionProgram
  }

  public validate(plan: Plan): ReturnType<PlanValidatorPort['validate']> {
    return this.forPlan(plan).validator.validate(plan)
  }

  public simulate(
    plan: Plan,
    scenarios: Parameters<PlanSimulatorPort['simulate']>[1],
  ): ReturnType<PlanSimulatorPort['simulate']> {
    return this.forPlan(plan).simulator.simulate(plan, scenarios)
  }

  public planActivation(
    input: Parameters<ExecutionPlannerPort['planActivation']>[0],
  ): ReturnType<ExecutionPlannerPort['planActivation']> {
    return this.programForAction(input.action).executionPlanner.planActivation(input)
  }

  public planEvidence(
    input: Parameters<ExecutionPlannerPort['planEvidence']>[0],
  ): ReturnType<ExecutionPlannerPort['planEvidence']> {
    return this.programForAction(input.action).executionPlanner.planEvidence(input)
  }

  public evaluate(
    input: Parameters<DeterministicVerifierPort['evaluate']>[0],
  ): ReturnType<DeterministicVerifierPort['evaluate']> {
    return this.assertMissionPlanBinding(input.mission, input.plan).verifier.evaluate(input)
  }

  private programForAction(action: PlanAction): MissionProgram {
    const program = this.#byAction.get(action.type)
    if (program === undefined) {
      throw new ConflictError(`No mission program owns action ${action.type}`)
    }
    return program
  }
}
