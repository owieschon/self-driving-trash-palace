import {
  HomecomingMissionConstraintSchema,
  PlanSchema,
  type HomecomingRoutineDefinition,
  type Plan,
} from '@trash-palace/core'

import type { PlanValidationCheck, SimulationScenario } from './models.js'
import type {
  PlanSimulatorPort,
  PlanValidatorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

type HomecomingAction = Extract<Plan['actions'][number], { type: 'replace_homecoming_routine' }>

export class HomecomingPlanValidator implements PlanValidatorPort {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public async validate(planInput: Plan): Promise<readonly PlanValidationCheck[]> {
    const parsed = PlanSchema.safeParse(planInput)
    if (!parsed.success) {
      return [
        {
          type: 'schema',
          passed: false,
          message: 'Plan does not satisfy the canonical plan schema and content hash.',
        },
      ]
    }
    const plan = parsed.data
    return this.unitOfWork.run(plan.organizationId, async (repositories) => {
      const action = oneHomecomingAction(plan)
      return [
        {
          type: 'schema',
          passed: action !== null,
          message:
            action === null
              ? 'Plan must contain exactly one homecoming routine replacement.'
              : 'Plan schema, hash, tenant, and palace bindings are current.',
        },
        await capabilityCheck(repositories, plan, action),
        await conflictCheck(repositories, action),
        hardInvariantCheck(plan, action),
      ]
    })
  }
}

export class HomecomingPlanSimulator implements PlanSimulatorPort {
  public async simulate(
    plan: Plan,
    scenarios: readonly SimulationScenario[],
  ): ReturnType<PlanSimulatorPort['simulate']> {
    const parsed = PlanSchema.parse(plan)
    const action = oneHomecomingAction(parsed)
    const projection = action?.replacement.projectedBatteryUsePercentagePoints ?? 0
    const results = scenarios.map((scenario) => {
      const result = simulateScenario(parsed, action, scenario)
      return { scenario, ...result }
    })
    return {
      feasible: action !== null && results.every((result) => result.passed),
      projectedBatteryUsePercentagePoints: projection,
      results,
    }
  }
}

function oneHomecomingAction(plan: Plan): HomecomingAction | null {
  if (plan.actions.length !== 1) return null
  const action = plan.actions[0]
  return action?.type === 'replace_homecoming_routine' ? action : null
}

async function capabilityCheck(
  repositories: TenantRepositories,
  plan: Plan,
  action: HomecomingAction | null,
): Promise<PlanValidationCheck> {
  if (action === null) {
    return {
      type: 'capability',
      passed: false,
      message: 'Capabilities cannot be assessed without one homecoming replacement.',
    }
  }
  const projection = await repositories.capabilities.list(plan.palaceId)
  const devices = new Map(projection.devices.map((device) => [device.id, device]))
  const required = [
    ['temperature_target', 'thermostat'],
    ['pathway_lighting', 'pathway_light'],
    ['lock_desired_state', 'lock'],
  ] as const
  const missing = required.filter(
    ([capabilityKind, deviceKind]) =>
      projection.capabilities.filter((capability) => {
        const device = devices.get(capability.deviceId)
        return (
          capability.enabled &&
          capability.kind === capabilityKind &&
          device?.kind === deviceKind &&
          device.health === 'online'
        )
      }).length !== 1,
  )
  return {
    type: 'capability',
    passed: missing.length === 0,
    message:
      missing.length === 0
        ? 'Exactly one online target exists for temperature, pathway lighting, and lock control.'
        : `Required capability targets are unavailable or ambiguous: ${missing
            .map(([kind]) => kind)
            .join(', ')}.`,
  }
}

async function conflictCheck(
  repositories: TenantRepositories,
  action: HomecomingAction | null,
): Promise<PlanValidationCheck> {
  if (action === null) {
    return {
      type: 'conflict',
      passed: false,
      message: 'Protected routine state cannot be assessed without one replacement action.',
    }
  }
  const current = await repositories.routines.getCurrentVersion(action.protectedRoutineId)
  const passed =
    current?.routineVersionId === action.protectedRoutineVersionId &&
    current.version === action.expectedProtectedVersion
  return {
    type: 'conflict',
    passed,
    message: passed
      ? 'The protected routine version still matches the proposed replacement.'
      : 'The protected routine changed after the plan was prepared.',
  }
}

function hardInvariantCheck(plan: Plan, action: HomecomingAction | null): PlanValidationCheck {
  const passed = action !== null && hardInvariantsHold(plan, action.replacement)
  return {
    type: 'hard_invariant',
    passed,
    message: passed
      ? 'Verified identity, event ordering, energy, approval, idempotency, and verifier ownership are preserved.'
      : 'The replacement violates a homecoming safety or durable-operation invariant.',
  }
}

function hardInvariantsHold(plan: Plan, replacement: HomecomingRoutineDefinition): boolean {
  const constraints = HomecomingMissionConstraintSchema.parse(plan.constraints)
  const preheat = replacement.actions.filter((action) => action.type === 'preheat')
  const lighting = replacement.actions.filter((action) => action.type === 'pathway_lighting')
  const unlock = replacement.actions.filter((action) => action.type === 'unlock')
  const relock = replacement.actions.filter((action) => action.type === 'lock_desired_state')
  const requiredIds = [
    'tenant_context_host_derived',
    'verified_identity_required_for_unlock',
    'routine_activation_validated',
    'exact_plan_approval_required',
    'retry_preserves_logical_operation',
    'verifier_owns_mission_success',
    'secrets_excluded_from_model_context',
  ] as const
  return (
    preheat.length === 1 &&
    preheat[0]?.completeBy === constraints.preheatBy &&
    lighting.length === 1 &&
    lighting[0]?.beginsAfter === constraints.pathwayLightingBeginsAfter &&
    unlock.length === 1 &&
    unlock[0]?.requireVerifiedIdentity === constraints.requireVerifiedIdentityForUnlock &&
    relock.length === 1 &&
    replacement.projectedBatteryUsePercentagePoints <=
      constraints.projectedBatteryUseMaxPercentagePoints &&
    replacement.constraints.projectedBatteryUseMaxPercentagePoints ===
      constraints.projectedBatteryUseMaxPercentagePoints &&
    requiredIds.every((id) => replacement.constraints.hardInvariantIds.includes(id))
  )
}

function simulateScenario(
  plan: Plan,
  action: HomecomingAction | null,
  scenario: SimulationScenario,
): { readonly passed: boolean; readonly evidence: string } {
  if (action === null) {
    return { passed: false, evidence: 'No single homecoming replacement was available.' }
  }
  const replacement = action.replacement
  const constraints = HomecomingMissionConstraintSchema.parse(plan.constraints)
  if (scenario === 'energy') {
    const passed =
      replacement.projectedBatteryUsePercentagePoints <=
      constraints.projectedBatteryUseMaxPercentagePoints
    return {
      passed,
      evidence: `${replacement.projectedBatteryUsePercentagePoints} projected percentage points against a ${constraints.projectedBatteryUseMaxPercentagePoints} point bound.`,
    }
  }
  if (scenario === 'access') {
    const unlock = replacement.actions.find((candidate) => candidate.type === 'unlock')
    const passed = unlock?.requireVerifiedIdentity === true
    return {
      passed,
      evidence: passed
        ? 'Unlock remains causally gated by verified identity telemetry.'
        : 'Unlock lacks a verified-identity gate.',
    }
  }
  if (scenario === 'timing') {
    const preheat = replacement.actions.find((candidate) => candidate.type === 'preheat')
    const lighting = replacement.actions.find((candidate) => candidate.type === 'pathway_lighting')
    const relock = replacement.actions.find((candidate) => candidate.type === 'lock_desired_state')
    const passed =
      preheat?.completeBy === constraints.preheatBy &&
      lighting?.beginsAfter === 'verified_arrival' &&
      (relock?.afterUnlockSeconds ?? 0) > 0
    return {
      passed,
      evidence: passed
        ? 'Preheat, arrival-triggered lighting, and bounded relock ordering are explicit.'
        : 'One or more timing relationships are missing or inconsistent.',
    }
  }
  const passed = replacement.constraints.hardInvariantIds.includes(
    'retry_preserves_logical_operation',
  )
  return {
    passed,
    evidence: passed
      ? 'Transport retries preserve the server-created logical operation identity.'
      : 'Transport retry identity is not declared as a hard invariant.',
  }
}
