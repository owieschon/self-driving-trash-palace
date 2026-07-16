import {
  CARETAKER_BUDGETS,
  PlanSchema,
  assertPermission,
  assertSameTenant,
  computePlanHash,
  type Mission,
  type OperationId,
  type Plan,
  type PlanAction,
  type PlanId,
  type RestoreRoutineVersionAction,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import type {
  AuthContext,
  CompensatingPlanLink,
  PlanSimulationRecord,
  PlanValidationRecord,
  SimulationScenario,
} from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso, parseGeneratedId } from './primitives.js'
import { enqueueApplicationProductEvidence } from './product-evidence.js'
import type {
  ClockPort,
  IdGeneratorPort,
  MissionExecutionUnitOfWorkPort,
  PlanSimulatorPort,
  PlanValidatorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export type PlanMutationContext = AuthContext | MissionExecutionContext

export interface ProposePlanInput {
  readonly context: PlanMutationContext
  readonly missionId: Mission['id']
  readonly revision: number
  readonly actions: readonly PlanAction[]
  readonly successCriteriaIds: readonly string[]
}

export class PlanService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly validator: PlanValidatorPort,
    private readonly simulator: PlanSimulatorPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort | null = null,
  ) {}

  public propose(input: ProposePlanInput): Promise<Plan> {
    if (input.actions.some((action) => action.type === 'restore_routine_version')) {
      throw new ConflictError('A restoration must be proposed as a compensating plan')
    }
    return this.#propose(input)
  }

  public proposeCompensating(input: {
    readonly context: PlanMutationContext
    readonly missionId: Mission['id']
    readonly revision: number
    readonly action: RestoreRoutineVersionAction
    readonly successCriteriaIds: readonly string[]
    readonly compensatesOperationId: OperationId
  }): Promise<Plan> {
    assertPermission(input.context.principal, 'recovery:propose')
    return this.#propose(
      {
        context: input.context,
        missionId: input.missionId,
        revision: input.revision,
        actions: [input.action],
        successCriteriaIds: input.successCriteriaIds,
      },
      input.compensatesOperationId,
    )
  }

  async #propose(input: ProposePlanInput, compensation?: OperationId): Promise<Plan> {
    assertPermission(input.context.principal, 'routine:draft')
    if (input.revision > CARETAKER_BUDGETS.maxPlanRevisions) {
      throw new ConflictError('Plan revision budget is exhausted')
    }
    const organizationId = input.context.principal.organizationId
    const plan = await this.observability.trace(
      {
        name: 'domain.plan.propose',
        kind: 'domain',
        correlation: { organizationId, missionId: input.missionId },
        attributes: { revision: input.revision, compensating: compensation !== undefined },
      },
      () =>
        this.#runMutation(input.context, input.missionId, async (repositories) => {
          const mission = await repositories.missions.get(input.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          assertSameTenant(organizationId, [mission.organizationId])
          if (mission.state.status !== 'running' || mission.state.phase !== 'plan') {
            throw new ConflictError('Plans may be proposed only from the running plan checkpoint')
          }
          const latest = await repositories.plans.getLatestForMission(mission.id)
          const expectedRevision = (latest?.revision ?? 0) + 1
          if (input.revision !== expectedRevision) {
            throw new ConflictError(`Expected plan revision ${expectedRevision}`)
          }
          if (compensation !== undefined) {
            const operation = await repositories.operations.get(compensation)
            if (operation === null || operation.status !== 'committed') {
              throw new ConflictError('Compensating plans require a committed operation')
            }
          }

          const planId = parseGeneratedId('plan', this.ids.next('plan'))
          const hashPayload = {
            schemaVersion: 'plan-hash@1' as const,
            id: planId,
            organizationId,
            missionId: mission.id,
            palaceId: mission.palaceId,
            revision: input.revision,
            objective: mission.objective,
            constraints: mission.constraints,
            actions: [...input.actions],
            successCriteriaIds: [...input.successCriteriaIds],
          }
          const { schemaVersion: _schemaVersion, ...planFields } = hashPayload
          const plan = PlanSchema.parse({
            ...planFields,
            hash: computePlanHash(hashPayload),
            status: 'candidate',
            createdAt: iso(this.clock.now()),
          })
          await repositories.plans.insert(plan)
          if (compensation !== undefined) {
            const action = plan.actions[0]
            if (action === undefined)
              throw new ConflictError('Compensating plan requires one action')
            const link: CompensatingPlanLink = {
              organizationId,
              planId: plan.id,
              actionId: action.id,
              compensatesOperationId: compensation,
              createdAt: plan.createdAt,
            }
            await repositories.compensatingPlans.insert(link)
          }
          await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: 'candidate_persisted',
            clock: this.clock,
            ids: this.ids,
          })
          const contextSourceCount = await this.#contextSourceCount(repositories, mission)
          await enqueueApplicationProductEvidence(repositories, this.observability, {
            event: 'plan proposed',
            durableIdentity: { planId: plan.id },
            occurredAt: plan.createdAt,
            correlation: {
              distinctId: mission.initiatedBy,
              actorId: input.context.principal.actorId,
              organizationId: plan.organizationId,
              palaceId: plan.palaceId,
              missionId: plan.missionId,
              ...(mission.runId === null ? {} : { runId: mission.runId }),
              planId: plan.id,
            },
            properties: {
              plan_revision: plan.revision,
              action_count: plan.actions.length,
              context_source_count: contextSourceCount,
            },
          })
          return plan
        }),
    )
    return plan
  }

  public async validate(input: {
    readonly context: PlanMutationContext
    readonly planId: PlanId
  }): Promise<PlanValidationRecord> {
    assertPermission(input.context.principal, 'routine:validate')
    const organizationId = input.context.principal.organizationId
    const plan = await this.#readPlanForMutation(input.context, input.planId)
    const checks = await this.observability.trace(
      {
        name: 'domain.plan.validate',
        kind: 'domain',
        correlation: { organizationId, missionId: plan.missionId, planId: plan.id },
      },
      () => this.validator.validate(plan),
    )
    const record: PlanValidationRecord = {
      planId: plan.id,
      valid: checks.length > 0 && checks.every((check) => check.passed),
      checks,
      createdAt: iso(this.clock.now()),
    }
    await this.#runMutation(input.context, plan.missionId, async (repositories) => {
      const current = await this.#requirePlan(repositories, plan.id)
      if (current.hash !== plan.hash || current.status !== 'candidate') {
        throw new ConflictError('Plan changed before validation committed')
      }
      await repositories.planAssessments.saveValidation(record)
      await repositories.plans.save(
        PlanSchema.parse({ ...current, status: record.valid ? 'validated' : 'superseded' }),
      )
      if (!record.valid) {
        const mission = await this.#requireMission(repositories, plan.missionId)
        await persistMissionTransition({
          repositories,
          mission,
          expectedVersion: mission.version,
          event: 'validation_failed',
          clock: this.clock,
          ids: this.ids,
        })
      }
    })
    return record
  }

  async #contextSourceCount(repositories: TenantRepositories, mission: Mission): Promise<number> {
    if (mission.contextReceiptId === null) return 0
    const receipt = await repositories.contextReceipts.get(mission.contextReceiptId)
    if (receipt === null) throw new ConflictError('Mission context receipt is missing')
    return receipt.sources.length
  }

  public async simulate(input: {
    readonly context: PlanMutationContext
    readonly planId: PlanId
    readonly scenarios: readonly SimulationScenario[]
  }): Promise<PlanSimulationRecord> {
    assertPermission(input.context.principal, 'routine:simulate')
    if (new Set(input.scenarios).size !== input.scenarios.length || input.scenarios.length === 0) {
      throw new ConflictError('Simulation scenarios must be non-empty and unique')
    }
    const organizationId = input.context.principal.organizationId
    const plan = await this.#readPlanForMutation(input.context, input.planId)
    if (!['candidate', 'validated'].includes(plan.status)) {
      throw new ConflictError('Only a current candidate may be simulated')
    }
    const result = await this.observability.trace(
      {
        name: 'domain.plan.simulate',
        kind: 'domain',
        correlation: { organizationId, missionId: plan.missionId, planId: plan.id },
        attributes: { scenario_count: input.scenarios.length },
      },
      () => this.simulator.simulate(plan, input.scenarios),
    )
    const record: PlanSimulationRecord = {
      planId: plan.id,
      ...result,
      createdAt: iso(this.clock.now()),
    }
    await this.#runMutation(input.context, plan.missionId, async (repositories) => {
      await repositories.planAssessments.saveSimulation(record)
      if (!record.feasible) {
        const current = await this.#requirePlan(repositories, plan.id)
        await repositories.plans.save(PlanSchema.parse({ ...current, status: 'superseded' }))
        const mission = await this.#requireMission(repositories, plan.missionId)
        if (mission.state.status === 'running' && mission.state.phase === 'validate') {
          await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: 'validation_failed',
            clock: this.clock,
            ids: this.ids,
          })
        }
      }
      const mission = await this.#requireMission(repositories, plan.missionId)
      await enqueueApplicationProductEvidence(repositories, this.observability, {
        event: 'plan simulated',
        durableIdentity: {
          planId: plan.id,
          createdAt: record.createdAt,
          scenarios: record.results.map((scenario) => ({
            scenario: scenario.scenario,
            passed: scenario.passed,
          })),
        },
        occurredAt: record.createdAt,
        correlation: {
          distinctId: mission.initiatedBy,
          actorId: input.context.principal.actorId,
          organizationId: plan.organizationId,
          palaceId: plan.palaceId,
          missionId: plan.missionId,
          ...(mission.runId === null ? {} : { runId: mission.runId }),
          planId: plan.id,
        },
        properties: {
          plan_revision: plan.revision,
          scenario_count: record.results.length,
          failed_scenario_count: record.results.filter((scenario) => !scenario.passed).length,
          passed: record.feasible && record.results.every((scenario) => scenario.passed),
        },
      })
    })
    return record
  }

  async #requirePlan(repositories: TenantRepositories, planId: PlanId): Promise<Plan> {
    const plan = await repositories.plans.get(planId)
    if (plan === null) throw new NotFoundError('Plan')
    return plan
  }

  async #requireMission(
    repositories: TenantRepositories,
    missionId: Mission['id'],
  ): Promise<Mission> {
    const mission = await repositories.missions.get(missionId)
    if (mission === null) throw new NotFoundError('Mission')
    return mission
  }

  async #readPlanForMutation(context: PlanMutationContext, planId: PlanId): Promise<Plan> {
    const organizationId = context.principal.organizationId
    const plan = await this.unitOfWork.run(organizationId, (repositories) =>
      this.#requirePlan(repositories, planId),
    )
    return this.#runMutation(context, plan.missionId, (repositories) =>
      this.#requirePlan(repositories, planId),
    )
  }

  #runMutation<Result>(
    context: PlanMutationContext,
    missionId: Mission['id'],
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    const organizationId = context.principal.organizationId
    if ('sessionId' in context) {
      return this.unitOfWork.run(organizationId, work)
    }
    assertMissionExecutionContext(context, { organizationId, missionId })
    if (this.missionUnitOfWork === null) {
      throw new ConflictError('Caretaker plan mutation requires a fenced unit of work')
    }
    return this.missionUnitOfWork.runFenced(context.fence, work)
  }
}
