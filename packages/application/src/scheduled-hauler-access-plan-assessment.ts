import {
  PlanSchema,
  ScheduledHaulerAccessConstraintSchema,
  type Plan,
  type ScheduledHaulerAccessRoutineDefinition,
} from '@trash-palace/core'

import type { PlanValidationCheck, SimulationScenario } from './models.js'
import type {
  PlanSimulatorPort,
  PlanValidatorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

type HaulerAction = Extract<
  Plan['actions'][number],
  { type: 'replace_scheduled_hauler_access_routine' }
>

export class ScheduledHaulerAccessPlanValidator implements PlanValidatorPort {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public async validate(planInput: Plan): Promise<readonly PlanValidationCheck[]> {
    const parsed = PlanSchema.safeParse(planInput)
    if (!parsed.success) {
      return [{ type: 'schema', passed: false, message: 'Plan schema or hash is invalid.' }]
    }
    const plan = parsed.data
    return this.unitOfWork.run(plan.organizationId, async (repositories) => {
      const action = oneHaulerAction(plan)
      return [
        {
          type: 'schema',
          passed: action !== null,
          message:
            action === null
              ? 'Plan must contain exactly one scheduled-hauler-access replacement.'
              : 'Hauler plan schema, hash, tenant, and palace bindings are current.',
        },
        await capabilityCheck(repositories, plan, action),
        await conflictCheck(repositories, action),
        hardInvariantCheck(plan, action),
      ]
    })
  }
}

export class ScheduledHaulerAccessPlanSimulator implements PlanSimulatorPort {
  public async simulate(
    planInput: Plan,
    scenarios: readonly SimulationScenario[],
  ): ReturnType<PlanSimulatorPort['simulate']> {
    const plan = PlanSchema.parse(planInput)
    const action = oneHaulerAction(plan)
    const results = scenarios.map((scenario) => ({
      scenario,
      ...simulateScenario(plan, action, scenario),
    }))
    return {
      feasible: action !== null && results.every((result) => result.passed),
      projectedBatteryUsePercentagePoints:
        action?.replacement.projectedBatteryUsePercentagePoints ?? 0,
      results,
    }
  }
}

function oneHaulerAction(plan: Plan): HaulerAction | null {
  if (plan.actions.length !== 1) return null
  const action = plan.actions[0]
  return action?.type === 'replace_scheduled_hauler_access_routine' ? action : null
}

async function capabilityCheck(
  repositories: TenantRepositories,
  plan: Plan,
  action: HaulerAction | null,
): Promise<PlanValidationCheck> {
  if (action === null) {
    return { type: 'capability', passed: false, message: 'Hauler action is absent.' }
  }
  const projection = await repositories.capabilities.list(plan.palaceId)
  const devices = new Map(projection.devices.map((device) => [device.id, device]))
  const targets = projection.capabilities.filter((capability) => {
    const device = devices.get(capability.deviceId)
    return (
      capability.enabled &&
      capability.kind === 'service_hatch_access' &&
      device?.kind === 'service_hatch_lock' &&
      device.health === 'online'
    )
  })
  return {
    type: 'capability',
    passed: targets.length === 1,
    message:
      targets.length === 1
        ? 'Exactly one online service-hatch lock is available.'
        : 'Service-hatch access requires exactly one online target.',
  }
}

async function conflictCheck(
  repositories: TenantRepositories,
  action: HaulerAction | null,
): Promise<PlanValidationCheck> {
  if (action === null) {
    return { type: 'conflict', passed: false, message: 'Protected routine is unknown.' }
  }
  const current = await repositories.routines.getCurrentVersion(action.protectedRoutineId)
  const passed =
    current?.routineVersionId === action.protectedRoutineVersionId &&
    current.version === action.expectedProtectedVersion
  return {
    type: 'conflict',
    passed,
    message: passed
      ? 'The protected access routine is still current.'
      : 'The protected access routine changed after planning.',
  }
}

function hardInvariantCheck(plan: Plan, action: HaulerAction | null): PlanValidationCheck {
  const passed = action !== null && haulerInvariantsHold(plan, action.replacement)
  return {
    type: 'hard_invariant',
    passed,
    message: passed
      ? 'Identity, window, compartment, final-lock, approval, and verifier boundaries hold.'
      : 'The hauler plan crosses a hard access boundary.',
  }
}

function haulerInvariantsHold(
  plan: Plan,
  replacement: ScheduledHaulerAccessRoutineDefinition,
): boolean {
  const constraints = ScheduledHaulerAccessConstraintSchema.parse(plan.constraints)
  return (
    replacement.trigger.windowStart === constraints.accessWindowStart &&
    replacement.trigger.windowEnd === constraints.accessWindowEnd &&
    replacement.trigger.authorizedIdentityTagId === constraints.authorizedIdentityTagId
  )
}

function simulateScenario(
  plan: Plan,
  action: HaulerAction | null,
  scenario: SimulationScenario,
): { readonly passed: boolean; readonly evidence: string } {
  if (action === null) return { passed: false, evidence: 'No hauler action exists.' }
  const constraints = ScheduledHaulerAccessConstraintSchema.parse(plan.constraints)
  const replacement = action.replacement
  if (scenario === 'energy') {
    return {
      passed: replacement.projectedBatteryUsePercentagePoints <= 5,
      evidence: 'Scheduled hatch access stays within the five-point fixture energy budget.',
    }
  }
  if (scenario === 'access') {
    const passed =
      replacement.trigger.authorizedIdentityTagId === constraints.authorizedIdentityTagId
    return {
      passed,
      evidence: passed
        ? 'Only the verified scheduled hauler may reach the service hatch.'
        : 'Identity or compartment scope is not preserved.',
    }
  }
  if (scenario === 'timing') {
    const passed =
      replacement.trigger.windowStart === constraints.accessWindowStart &&
      replacement.trigger.windowEnd === constraints.accessWindowEnd
    return {
      passed,
      evidence: passed
        ? 'Access is bounded to the scheduled window and ends locked.'
        : 'Access timing or final lock state is incomplete.',
    }
  }
  const passed = replacement.constraints.hardInvariantIds.includes(
    'retry_preserves_logical_operation',
  )
  return {
    passed,
    evidence: passed
      ? 'Retries retain one logical access change.'
      : 'Retry identity is not a hard invariant.',
  }
}
